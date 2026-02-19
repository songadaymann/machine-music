#!/usr/bin/env bun
// Ritual Stress Test — Tests the BPM/key voting cycle with LLM-powered agents
// Usage: bun run test/ritual-stress.ts [cycles]
//
// Start the server with fast ritual timing:
//   RITUAL_INTERVAL_MS=15000 NOMINATE_DURATION_MS=15000 VOTE_DURATION_MS=10000 RESULT_DISPLAY_MS=5000 bun run dev
//
// Requires ANTHROPIC_API_KEY in .env or environment.
// Run test/fetch-souls.ts first to cache soul.md files.

const API = process.env.API_URL || "http://localhost:5555/api";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required. Set it in .env or environment.");
  process.exit(1);
}

import { readFileSync, existsSync } from "fs";
import { join } from "path";

// --- Load skill docs ---

function loadSkill(relativePath: string): string {
  const fullPath = join(import.meta.dir, "..", relativePath);
  const raw = readFileSync(fullPath, "utf-8");
  return raw.replace(/^---[\s\S]*?---\s*/, "").trim();
}

const CORE_SKILL = loadSkill(".claude/skills/synthmob/SKILL.md");
const COMPOSE_SKILL = loadSkill(".claude/skills/synthmob-compose/SKILL.md");

// --- Load souls ---

function loadSoul(name: string): string {
  const soulPath = join(import.meta.dir, "souls", `${name}.md`);
  if (!existsSync(soulPath)) {
    return `You are ${name}. Express yourself creatively.`;
  }
  return readFileSync(soulPath, "utf-8").trim();
}

// --- Model tiers ---

const MODELS = {
  sonnet: "claude-sonnet-4-20250514",
  haiku: "claude-haiku-4-5-20251001",
} as const;

type ModelTier = keyof typeof MODELS;
type RitualAction = "ritual_nominate" | "ritual_vote" | "observe";

// --- Flow config ---

const FLOW = {
  pollIntervalMs: 2000,
  llmConcurrency: Math.max(1, parseInt(process.env.LLM_CONCURRENCY || "4", 10)),
} as const;

let stopRequested = false;

function requestStop(signal: string) {
  if (stopRequested) {
    console.log(`\n[ritual] ${signal} received again, exiting immediately.`);
    process.exit(130);
  }
  stopRequested = true;
  console.log(`\n[ritual] ${signal} received. Finishing current cycle, then printing report...`);
}

process.on("SIGINT", () => requestStop("SIGINT"));
process.on("SIGTERM", () => requestStop("SIGTERM"));

// --- Types ---

interface AgentBot {
  name: string;
  token: string;
  id: string;
  soul: string;
  soulName: string;
  model: ModelTier;
  modelId: string;
  // Stats
  nominationAttempts: number;
  nominationSuccesses: number;
  voteAttempts: number;
  voteSuccesses: number;
  observes: number;
  errors: string[];
}

interface RitualResponse {
  reasoning: string;
  action: RitualAction;
  payload: Record<string, unknown>;
}

// --- Bot profiles: 6 agents for ritual testing ---

const BOT_PROFILES: Array<{
  soulName: string;
  model: ModelTier;
}> = [
  { soulName: "pirate-captain", model: "sonnet" },
  { soulName: "storyteller", model: "sonnet" },
  { soulName: "zen-master", model: "haiku" },
  { soulName: "hype-person", model: "haiku" },
  { soulName: "architect", model: "haiku" },
  { soulName: "poet", model: "haiku" },
];

// --- API helpers ---

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return { status: res.status, data: await res.json() };
}

// --- Claude API ---

async function askClaude(
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { content: Array<{ text: string }> };
  return data.content[0].text;
}

// --- Semaphore ---

class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  private async acquire() {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.permits++;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const llmSemaphore = new Semaphore(FLOW.llmConcurrency);

// --- Helpers ---

function log(bot: string, model: string, msg: string) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${time}] [${model.toUpperCase().padEnd(6)}] [${bot}] ${msg}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Parse response ---

function parseRitualResponse(raw: string): RitualResponse {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.action) {
      return {
        reasoning: parsed.reasoning || "(no reasoning)",
        action: parsed.action,
        payload: parsed.payload || {},
      };
    }
  } catch {
    // Fall through
  }

  const jsonMatch = raw.match(/\{[\s\S]*"action"\s*:\s*"[^"]+[\s\S]*\}/);
  if (jsonMatch) {
    try {
      let depth = 0, start = -1, end = -1;
      for (let i = 0; i < jsonMatch[0].length; i++) {
        if (jsonMatch[0][i] === "{") { if (start === -1) start = i; depth++; }
        else if (jsonMatch[0][i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      const candidate = end > start ? jsonMatch[0].slice(start, end) : jsonMatch[0];
      const parsed = JSON.parse(candidate);
      return {
        reasoning: parsed.reasoning || "(no reasoning)",
        action: parsed.action,
        payload: parsed.payload || {},
      };
    } catch { /* fall through */ }
  }

  return {
    reasoning: `(could not parse: ${raw.slice(0, 80)})`,
    action: "observe",
    payload: {},
  };
}

// --- Prompts ---

function buildSystemPrompt(bot: AgentBot): string {
  return `You have a soul (personality):

<soul>
${bot.soul}
</soul>

<skill name="synthmob-core">
${CORE_SKILL}
</skill>

<skill name="synthmob-compose">
${COMPOSE_SKILL}
</skill>

You are "${bot.name}" participating in SynthMob's World Ritual — a periodic vote to change the world's BPM and musical key.

You MUST respond with ONLY a raw JSON object. No markdown fences, no backticks, no preamble text. Just the JSON:
{
  "reasoning": "1-2 sentences explaining your musical reasoning",
  "action": "one of: ritual_nominate | ritual_vote | observe",
  "payload": { ... action-specific data ... }
}

Action payload schemas:

ritual_nominate (during NOMINATE phase only):
  { "bpm": 120, "key": "C", "scale": "pentatonic", "reasoning": "why this fits the vibe" }
  At least one of bpm or key required. BPM: 60-200 integer. Key: C through B. Scale defaults to pentatonic.
  Valid scales: pentatonic, major, minor, dorian, mixolydian, blues, harmonic_minor, melodic_minor, phrygian, lydian, locrian, chromatic, whole_tone.
  You can only nominate once per ritual.

ritual_vote (during VOTE phase only):
  { "bpm_candidate": 1, "key_candidate": 2 }
  At least one candidate index (1-3) required. Cannot vote for your own nomination.
  You can only vote once per ritual.

observe:
  {} (empty — skip this turn, wait for the right phase)

STAY IN CHARACTER. Your reasoning should reflect your personality.`;
}

function summarizeRitual(ritualData: unknown): string {
  if (!ritualData || typeof ritualData !== "object") return "Phase: unknown";
  const rd = ritualData as Record<string, unknown>;
  const phase = rd.phase as string;
  if (phase === "idle" || !rd.ritual) return "Phase: idle — waiting for next ritual";

  const ritual = rd.ritual as Record<string, unknown>;
  const remaining = ritual.phaseRemainingSeconds as number;

  if (phase === "nominate") {
    const bpmCount = ritual.bpmNominationCount || 0;
    const keyCount = ritual.keyNominationCount || 0;
    const hasBpm = ritual.hasNominatedBpm ? "yes" : "no";
    const hasKey = ritual.hasNominatedKey ? "yes" : "no";
    return `Phase: NOMINATE (${remaining}s remaining)
BPM nominations so far: ${bpmCount} | Key nominations: ${keyCount}
You nominated BPM: ${hasBpm} | You nominated key: ${hasKey}
ACTION REQUIRED: If you haven't nominated, use ritual_nominate now! Suggest a BPM (60-200) and/or key.`;
  }

  if (phase === "vote") {
    const bpmCandidates = (ritual.bpmCandidates as unknown[]) || [];
    const keyCandidates = (ritual.keyCandidates as unknown[]) || [];
    const hasBpmVote = ritual.hasVotedBpm ? "yes" : "no";
    const hasKeyVote = ritual.hasVotedKey ? "yes" : "no";
    const bpmList = bpmCandidates
      .map((c: any) => `  #${c.index}: ${c.bpm} bpm (by ${c.nominatedBy}, ${c.votes} votes)`)
      .join("\n");
    const keyList = keyCandidates
      .map((c: any) => `  #${c.index}: ${c.key} ${c.scale} (by ${c.nominatedBy}, ${c.votes} votes)`)
      .join("\n");
    return `Phase: VOTE (${remaining}s remaining)
BPM candidates:
${bpmList || "  (none — fizzled)"}
Key candidates:
${keyList || "  (none — fizzled)"}
You voted BPM: ${hasBpmVote} | You voted key: ${hasKeyVote}
ACTION REQUIRED: If you haven't voted, use ritual_vote now! Pick candidate indices (1-3). Cannot vote for your own.`;
  }

  if (phase === "result") {
    const bpmWinner = ritual.bpmWinner as Record<string, unknown> | null;
    const keyWinner = ritual.keyWinner as Record<string, unknown> | null;
    const bpmStr = bpmWinner ? `${bpmWinner.bpm} bpm (by ${bpmWinner.nominatedBy})` : "none";
    const keyStr = keyWinner
      ? `${(keyWinner as any).key} ${(keyWinner as any).scale} (by ${keyWinner.nominatedBy})`
      : "none";
    return `Phase: RESULT (${remaining}s remaining)
Winner BPM: ${bpmStr} | Winner key: ${keyStr}
Just observe — results are being applied.`;
  }

  return `Phase: ${phase}`;
}

function buildUserPrompt(bot: AgentBot, ritualData: unknown, context: unknown): string {
  const ritualSummary = summarizeRitual(ritualData);
  const contextSummary =
    context && typeof context === "object"
      ? Object.entries(context as Record<string, unknown>)
          .filter(([k]) => ["bpm", "key", "scale", "scaleNotes"].includes(k))
          .map(([k, v]) => `  ${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
          .join("\n")
      : "  (unavailable)";

  return `Current musical context:
${contextSummary}

World Ritual:
${ritualSummary}

Pick a single action and respond with JSON.`;
}

// --- Execute action ---

async function executeAction(
  bot: AgentBot,
  response: RitualResponse
): Promise<{ success: boolean; error?: string }> {
  const { action, payload } = response;

  try {
    switch (action) {
      case "ritual_nominate": {
        bot.nominationAttempts++;
        const body: Record<string, unknown> = {};
        if (payload.bpm !== undefined) body.bpm = payload.bpm;
        if (payload.key !== undefined) body.key = payload.key;
        if (payload.scale !== undefined) body.scale = payload.scale;
        if (payload.reasoning !== undefined) body.reasoning = payload.reasoning;
        if (body.bpm === undefined && body.key === undefined) {
          return { success: false, error: "missing bpm or key" };
        }
        const res = await api("POST", "/ritual/nominate", body, bot.token);
        if (res.status === 200) {
          bot.nominationSuccesses++;
          return { success: true };
        }
        return { success: false, error: res.data?.error || `HTTP ${res.status}` };
      }

      case "ritual_vote": {
        bot.voteAttempts++;
        const body: Record<string, unknown> = {};
        if (payload.bpm_candidate !== undefined) body.bpm_candidate = payload.bpm_candidate;
        if (payload.key_candidate !== undefined) body.key_candidate = payload.key_candidate;
        if (body.bpm_candidate === undefined && body.key_candidate === undefined) {
          return { success: false, error: "missing bpm_candidate or key_candidate" };
        }
        const res = await api("POST", "/ritual/vote", body, bot.token);
        if (res.status === 200) {
          bot.voteSuccesses++;
          return { success: true };
        }
        return { success: false, error: res.data?.error || `HTTP ${res.status}` };
      }

      case "observe": {
        bot.observes++;
        return { success: true };
      }

      default:
        return { success: false, error: `unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// --- Main loop: poll ritual state and react ---

async function runRitualAgent(bot: AgentBot, maxCycles: number | null) {
  const systemPrompt = buildSystemPrompt(bot);
  let lastPhase = "idle";
  let actedThisPhase = false;
  let cyclesSeen = 0;

  while (!stopRequested && (maxCycles === null || cyclesSeen < maxCycles)) {
    try {
      const [ritualRes, contextRes] = await Promise.all([
        api("GET", "/ritual", undefined, bot.token),
        api("GET", "/context"),
      ]);

      const ritualData = ritualRes.status === 200 ? ritualRes.data : null;
      const context = contextRes.status === 200 ? contextRes.data : null;
      const phase = (ritualData as any)?.phase || "idle";

      // Track phase transitions
      if (phase !== lastPhase) {
        if (lastPhase !== "idle" && phase === "idle") {
          cyclesSeen++;
          log(bot.name, bot.model, `ritual cycle ${cyclesSeen} complete`);
        }
        lastPhase = phase;
        actedThisPhase = false;
      }

      // Only ask LLM during nominate/vote if we haven't acted yet
      if ((phase === "nominate" || phase === "vote") && !actedThisPhase) {
        const userPrompt = buildUserPrompt(bot, ritualData, context);

        log(bot.name, bot.model, `${phase} phase — thinking...`);
        const raw = await llmSemaphore.run(() =>
          askClaude(bot.modelId, systemPrompt, userPrompt)
        );

        const response = parseRitualResponse(raw);
        log(bot.name, bot.model, `-> ${response.action}: ${response.reasoning.slice(0, 80)}`);

        const result = await executeAction(bot, response);
        if (result.success) {
          log(bot.name, bot.model, `  OK (${response.action})`);
          actedThisPhase = true;
        } else {
          log(bot.name, bot.model, `  FAIL (${response.action}): ${result.error}`);
          if (result.error && !result.error.includes("already_")) {
            bot.errors.push(`${response.action}: ${result.error}`);
          }
          // If already nominated/voted, mark as acted so we don't retry
          if (result.error?.includes("already_")) {
            actedThisPhase = true;
          }
        }
      }
    } catch (err) {
      log(bot.name, bot.model, `ERROR: ${String(err)}`);
      bot.errors.push(String(err));
    }

    await sleep(FLOW.pollIntervalMs);
  }
}

// --- Report ---

function printReport(bots: AgentBot[], elapsedSec: number) {
  console.log(`\n${"=".repeat(60)}`);
  console.log("  RITUAL STRESS TEST -- FINAL REPORT");
  console.log(`${"=".repeat(60)}\n`);
  console.log(`  Runtime: ${elapsedSec}s`);
  console.log(`  Agents: ${bots.length}\n`);

  console.log(
    "  " +
      "Name".padEnd(22) +
      "Model".padEnd(8) +
      "NomOK".padEnd(8) +
      "NomFail".padEnd(9) +
      "VoteOK".padEnd(9) +
      "VoteFail".padEnd(10) +
      "Obs"
  );
  console.log("  " + "-".repeat(70));

  for (const bot of bots) {
    const nomFail = bot.nominationAttempts - bot.nominationSuccesses;
    const voteFail = bot.voteAttempts - bot.voteSuccesses;
    console.log(
      "  " +
        bot.name.padEnd(22) +
        bot.model.padEnd(8) +
        String(bot.nominationSuccesses).padEnd(8) +
        String(nomFail).padEnd(9) +
        String(bot.voteSuccesses).padEnd(9) +
        String(voteFail).padEnd(10) +
        String(bot.observes)
    );
  }

  const totalNomAttempts = bots.reduce((s, b) => s + b.nominationAttempts, 0);
  const totalNomSuccess = bots.reduce((s, b) => s + b.nominationSuccesses, 0);
  const totalVoteAttempts = bots.reduce((s, b) => s + b.voteAttempts, 0);
  const totalVoteSuccess = bots.reduce((s, b) => s + b.voteSuccesses, 0);
  const nomRate = totalNomAttempts > 0 ? Math.round((totalNomSuccess / totalNomAttempts) * 100) : 0;
  const voteRate = totalVoteAttempts > 0 ? Math.round((totalVoteSuccess / totalVoteAttempts) * 100) : 0;

  console.log(`\n  TOTALS:`);
  console.log(`    Nominations: ${totalNomSuccess}/${totalNomAttempts} (${nomRate}%)`);
  console.log(`    Votes: ${totalVoteSuccess}/${totalVoteAttempts} (${voteRate}%)`);

  const allErrors = bots.flatMap((b) => b.errors);
  if (allErrors.length > 0) {
    console.log(`\n  ERRORS (${allErrors.length}):`);
    for (const err of allErrors.slice(0, 10)) {
      console.log(`    - ${err}`);
    }
    if (allErrors.length > 10) {
      console.log(`    ... and ${allErrors.length - 10} more`);
    }
  }

  console.log("");
}

// --- Main ---

async function main() {
  const rawArg = process.argv[2];
  const maxCycles = rawArg && ["forever", "infinite", "0", "-1"].includes(rawArg.toLowerCase())
    ? null
    : parseInt(rawArg || "2", 10);
  const cyclesLabel = maxCycles === null ? "forever" : String(maxCycles);

  console.log(`
+----------------------------------------------------------+
|  SYNTHMOB -- Ritual Stress Test                          |
|  Agents: ${String(BOT_PROFILES.length).padEnd(2)} | Cycles: ${cyclesLabel.padEnd(8)} | LLM concurrency: ${String(FLOW.llmConcurrency).padEnd(2)} |
|  API: ${API.padEnd(50)} |
+----------------------------------------------------------+
`);

  console.log("  TIP: Start server with fast timing:");
  console.log("  RITUAL_INTERVAL_MS=15000 NOMINATE_DURATION_MS=15000 VOTE_DURATION_MS=10000 RESULT_DISPLAY_MS=5000 bun run dev\n");

  // 1. Load souls and register bots
  console.log("  Registering agents...");
  const bots: AgentBot[] = [];

  for (const profile of BOT_PROFILES) {
    const suffix = Math.floor(Math.random() * 1000);
    const name = `${profile.soulName.replace(/-/g, "").slice(0, 14)}_${suffix}`;
    const soul = loadSoul(profile.soulName);
    const res = await api("POST", "/agents", { name });
    if (res.status !== 201) {
      console.error(`    FAIL: ${name}:`, res.data);
      continue;
    }

    bots.push({
      name,
      token: res.data.token,
      id: res.data.id,
      soul,
      soulName: profile.soulName,
      model: profile.model,
      modelId: MODELS[profile.model],
      nominationAttempts: 0,
      nominationSuccesses: 0,
      voteAttempts: 0,
      voteSuccesses: 0,
      observes: 0,
      errors: [],
    });
    log(name, profile.model, `registered (${profile.soulName})`);
  }

  if (bots.length === 0) {
    console.error("No bots registered! Is the server running?");
    process.exit(1);
  }

  console.log(`\n  ${bots.length} agents registered. Waiting for ritual phases...\n`);

  // 2. Run all agents concurrently, polling for ritual state
  const startMs = Date.now();
  await Promise.all(bots.map((bot) => runRitualAgent(bot, maxCycles)));
  const elapsedSec = Math.round((Date.now() - startMs) / 1000);

  // 3. Print report
  printReport(bots, elapsedSec);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
