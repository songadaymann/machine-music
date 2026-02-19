#!/usr/bin/env bun
// Multi-model LLM runtime test -- Haiku, Sonnet, and Opus bots compete
// Usage: bun run test/llm-stress-test.ts [actions-per-bot|forever]
//
// Requires ANTHROPIC_API_KEY in .env or environment

const API = process.env.API_URL || "http://localhost:5555/api";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required. Set it in .env or environment.");
  process.exit(1);
}

// --- Load SKILL doc (the way an OpenClaw agent would receive it) ---

import { readFileSync } from "fs";
import { join } from "path";

const SKILL_MD = readFileSync(
  join(import.meta.dir, "..", "docs", "integration", "SKILL.md"),
  "utf-8"
);

// Strip YAML frontmatter for the prompt (agent gets the body)
const SKILL_BODY = SKILL_MD.replace(/^---[\s\S]*?---\s*/, "").trim();

// --- Model tiers ---

const MODELS = {
  opus: "claude-opus-4-20250514",
  sonnet: "claude-sonnet-4-20250514",
  haiku: "claude-haiku-4-5-20251001",
} as const;

type ModelTier = keyof typeof MODELS;
type ActivityResult =
  | "intent"
  | "travel"
  | "thinking"
  | "submitting"
  | "claimed"
  | "rejected"
  | "cooldown"
  | "error";

const FLOW = {
  startupJitterMinMs: 300,
  startupJitterMaxMs: 1800,
  actionPauseMinMs: 800,
  actionPauseMaxMs: 2200,
  cooldownBufferMinMs: 200,
  cooldownBufferMaxMs: 700,
  cooldownPollMinMs: 1800,
  cooldownPollMaxMs: 4200,
  walkSpeedUnitsPerSec: 3, // keep in sync with client/js/avatars.js
  offstageX: 0,
  offstageZ: 13.5,
  jamDecisionChance: 0.7,
  jamStartChance: 0.22,
  jamJoinChance: 0.55,
  jamLeaveChance: 0.16,
  jamPatternUpdateChance: 0.4,
  llmConcurrency: Math.max(1, parseInt(process.env.LLM_CONCURRENCY || "4", 10)),
} as const;

const FOREVER_TOKENS = new Set(["forever", "infinite", "infinity", "0", "-1"]);
let stopRequested = false;

function requestStop(signal: string) {
  if (stopRequested) {
    console.log(`\n[stress] ${signal} received again, exiting immediately.`);
    process.exit(130);
  }
  stopRequested = true;
  console.log(`\n[stress] ${signal} received. Finishing in-flight work, then printing report...`);
}

process.on("SIGINT", () => requestStop("SIGINT"));
process.on("SIGTERM", () => requestStop("SIGTERM"));

// --- Types ---

interface Bot {
  name: string;
  token: string;
  id: string;
  personality: string;
  strategy: BotStrategy;
  model: ModelTier;
  modelId: string;
  successes: number;
  failures: number;
  overwrites: number;
  gotOverwritten: number;
  cooldownHits: number;
  actionsCompleted: number;
  positionSlotId: number | null;
  jamId: string | null;
  jamsStarted: number;
  jamsJoined: number;
  jamsLeft: number;
  jamPatternUpdates: number;
}

type BotStrategy = "aggressive" | "collaborative" | "defensive";

interface Slot {
  id: number;
  type: string;
  label: string;
  code: string | null;
  agent: { id: string; name: string } | null;
  updatedAt: string | null;
}

interface Composition {
  epoch: number;
  bpm: number;
  key: string;
  scale: string;
  slots: Slot[];
}

interface SoundLookupPayload {
  version?: string;
  note?: string;
  families?: Record<string, string[]>;
}

interface MusicContext {
  bpm: number;
  key: string;
  scale: string;
  scaleNotes?: string[];
  sampleBanks?: string[];
  soundLookup?: SoundLookupPayload;
}

type JamRoom = "center" | "east_wing" | "west_wing";

interface JamSpot {
  id: string;
  room: JamRoom;
  label: string;
  x: number;
  z: number;
}

interface JamParticipant {
  agentId: string;
  botName: string;
  joinedAt: string;
  pattern: string | null;
}

interface JamSession {
  id: string;
  spotId: string;
  room: JamRoom;
  hostAgentId: string;
  hostBotName: string;
  createdAt: string;
  updatedAt: string;
  participants: JamParticipant[];
}

interface JamSnapshot {
  spots: JamSpot[];
  sessions: JamSession[];
}

interface LLMResponse {
  reasoning: string;
  pattern: string;
}

interface TargetChoice {
  slot: Slot;
  isOverwrite: boolean;
  decisionReason: string;
}

// --- Slot geometry approximation ---
// Mirrors client/js/instruments.js semicircle layout for travel timing.

const SLOT_LAYOUT = (() => {
  const slotCount = 8;
  const radius = 7;
  const arcStart = Math.PI * 0.15;
  const arcEnd = Math.PI * 0.85;

  const coords = new Map<number, { x: number; z: number }>();
  for (let i = 0; i < slotCount; i++) {
    const t = i / (slotCount - 1);
    const angle = arcStart + t * (arcEnd - arcStart);
    const x = Math.cos(angle) * radius;
    const z = -Math.sin(angle) * radius + 2;
    coords.set(i + 1, { x, z });
  }
  return coords;
})();

// --- Bot profiles: 12 bots across 3 tiers ---

const BOT_PROFILES: {
  name: string;
  personality: string;
  strategy: BotStrategy;
  model: ModelTier;
}[] = [
  // OPUS (2) -- strategic, deep thinkers
  {
    name: "maestro",
    personality:
      "You are a master conductor. You think about the overall composition holistically — balance, dynamics, tension and release. You write patterns that elevate the entire piece.",
    strategy: "aggressive",
    model: "opus",
  },
  {
    name: "architect",
    personality:
      "You are a sonic architect. You analyze the harmonic and rhythmic structure deeply and write patterns that create the strongest possible foundation. If a slot is weak, you replace it.",
    strategy: "aggressive",
    model: "opus",
  },

  // SONNET (4) -- balanced, versatile
  {
    name: "groovesmith",
    personality:
      "You create tight, funky grooves. Syncopation and pocket are everything. Your patterns lock in with whatever else is playing.",
    strategy: "collaborative",
    model: "sonnet",
  },
  {
    name: "dreamweaver",
    personality:
      "You make ethereal, atmospheric textures. Reverb, delay, and space are your tools. You fill gaps in the composition with ambience.",
    strategy: "collaborative",
    model: "sonnet",
  },
  {
    name: "challenger",
    personality:
      "You are competitive and bold. You write patterns that are objectively better than what's already there. You target occupied slots.",
    strategy: "aggressive",
    model: "sonnet",
  },
  {
    name: "harmonist",
    personality:
      "You specialize in rich chord voicings and harmonic movement. Jazz-influenced, you make the harmony sing.",
    strategy: "defensive",
    model: "sonnet",
  },

  // HAIKU (6) -- fast, prolific, experimental
  {
    name: "rushbot",
    personality:
      "You are fast and decisive. Simple but effective patterns. You grab empty slots quickly before others do.",
    strategy: "collaborative",
    model: "haiku",
  },
  {
    name: "glitchfx",
    personality:
      "You love glitchy, stuttering patterns. Rapid-fire subdivisions, speed changes, and unpredictable rhythms.",
    strategy: "aggressive",
    model: "haiku",
  },
  {
    name: "minimalist",
    personality:
      "Less is more. You write the simplest possible pattern that adds something meaningful. One note can be enough.",
    strategy: "defensive",
    model: "haiku",
  },
  {
    name: "basshead",
    personality:
      "You live for heavy, driving bass. Deep sub frequencies, simple but powerful patterns that anchor the whole track.",
    strategy: "collaborative",
    model: "haiku",
  },
  {
    name: "percussive",
    personality:
      "You are all about rhythm. Complex polyrhythmic drum patterns, layered hits, syncopation that makes people nod their heads.",
    strategy: "collaborative",
    model: "haiku",
  },
  {
    name: "wildchild",
    personality:
      "You are chaotic and experimental. You try unusual combinations, unexpected sounds, and push the boundaries of what Strudel can do.",
    strategy: "aggressive",
    model: "haiku",
  },
];

// --- Strategy descriptions for the prompt ---

const STRATEGY_PROMPTS: Record<BotStrategy, string> = {
  aggressive:
    "You PREFER to overwrite other bots' patterns. If a slot has weak or boring code, replace it with something better. You want to dominate the composition.",
  collaborative:
    "You PREFER to fill empty slots first. Only overwrite if the current pattern clashes badly. You want the whole composition to sound good together.",
  defensive:
    "You fill empty slots and protect them. Write patterns that are so good nobody would want to replace them. Focus on quality over quantity.",
};

const JAM_PATTERN_LIBRARY = {
  aggressive: [
    's("bd*2 [sd cp] hh*4").bank("RolandTR909").gain(0.72)',
    'note("<a2 e2 d2 g2>").s("sawtooth").lpf(420).gain(0.6)',
    's("jazz*4").room(0.25).gain(0.45)',
  ],
  collaborative: [
    'note("<[a3 c4 e4] [g3 b3 d4]>").s("piano").room(0.35).gain(0.5)',
    'note("a4 c5 e5 g5").s("triangle").delay(0.2).room(0.3).gain(0.4)',
    's("hh*8").gain("0.24 0.12 0.18 0.12 0.22 0.12 0.2 0.12")',
  ],
  defensive: [
    'note("<a3 e4 d4 e4>").s("square").decay(0.35).gain(0.44)',
    's("bd ~ sd ~").bank("RolandTR808").gain(0.58)',
    'note("a2 ~ e2 ~").s("sawtooth").lpf(280).gain(0.55)',
  ],
} as const;

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
      max_tokens: 500,
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

// --- Parse structured LLM response ---

function parseLLMResponse(raw: string): LLMResponse {
  // Try JSON parse first
  try {
    // Strip markdown code fences if present
    const cleaned = raw
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.reasoning && parsed.pattern) {
      return {
        reasoning: parsed.reasoning,
        pattern: cleanPattern(parsed.pattern),
      };
    }
  } catch {
    // Fall through to heuristic parsing
  }

  // Heuristic: look for "reasoning:" and "pattern:" sections
  const reasoningMatch = raw.match(
    /reasoning["\s:]*[:\s]+(.*?)(?=pattern["\s:]*[:\s]+)/is
  );
  const patternMatch = raw.match(/pattern["\s:]*[:\s]+(.*?)$/is);

  if (reasoningMatch && patternMatch) {
    return {
      reasoning: reasoningMatch[1].replace(/["\s,]+$/, "").trim(),
      pattern: cleanPattern(patternMatch[1]),
    };
  }

  // Last resort: treat the whole thing as a pattern
  return {
    reasoning: "(no reasoning extracted)",
    pattern: cleanPattern(raw),
  };
}

function cleanPattern(raw: string): string {
  let pattern = raw
    .replace(/```[a-z]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();

  if (pattern.startsWith("{")) {
    try {
      const parsed = JSON.parse(pattern) as { pattern?: unknown };
      if (typeof parsed.pattern === "string") {
        pattern = parsed.pattern.trim();
      }
    } catch {
      // Keep fallback handling below.
    }
  }

  pattern = pattern
    .replace(/^["']?pattern["']?\s*:\s*/i, "")
    .trim();

  // If multi-line, pick the line that looks like Strudel code
  const lines = pattern
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length > 1) {
    const labeledLine = lines.find((l) => /^["']?pattern["']?\s*:/i.test(l));
    if (labeledLine) {
      pattern = labeledLine.replace(/^["']?pattern["']?\s*:\s*/i, "").trim();
    } else {
      const codeLine = lines.find((l) => /^\(?\s*[a-zA-Z_]\w*\s*\(/.test(l));
      pattern = codeLine ?? lines[0];
    }
  }

  if (pattern.endsWith(",")) {
    pattern = pattern.slice(0, -1).trim();
  }

  return pattern;
}

function summarizeContext(context: MusicContext | null): string {
  if (!context) return "  - context unavailable";

  const lines: string[] = [
    `tempo/key: ${context.bpm} BPM, ${context.key} ${context.scale}`,
  ];

  if (Array.isArray(context.scaleNotes) && context.scaleNotes.length > 0) {
    lines.push(`scaleNotes: ${context.scaleNotes.join(", ")}`);
  }
  if (Array.isArray(context.sampleBanks) && context.sampleBanks.length > 0) {
    lines.push(`sampleBanks: ${context.sampleBanks.join(", ")}`);
  }

  const families = context.soundLookup?.families;
  if (families && typeof families === "object") {
    for (const [family, sounds] of Object.entries(families)) {
      if (!Array.isArray(sounds) || sounds.length === 0) continue;
      const valid = sounds.filter((s): s is string => typeof s === "string" && s.length > 0);
      if (valid.length === 0) continue;
      const preview = valid.slice(0, 6).join(", ");
      const suffix = valid.length > 6 ? ", ..." : "";
      lines.push(`${family}: ${preview}${suffix}`);
    }
  }

  return lines.map((line) => `  - ${line}`).join("\n");
}

// --- Generate a pattern via LLM ---
//
// The system prompt is built from docs/integration/SKILL.md (loaded at startup),
// exactly as an OpenClaw agent would receive it. The only additions are:
// - Bot identity (name, personality, strategy)
// - Response format instruction (JSON with reasoning + pattern)

async function generatePattern(
  bot: Bot,
  slot: Slot,
  composition: Composition,
  context: MusicContext | null,
  retryError?: string
): Promise<LLMResponse> {
  const otherSlots = composition.slots
    .filter((s) => s.code && s.id !== slot.id)
    .map(
      (s) =>
        `  Slot ${s.id} (${s.type.toUpperCase()}) by ${s.agent?.name}: ${s.code}`
    )
    .join("\n") || "  (no other slots filled yet)";

  const currentHolder = slot.agent
    ? `Currently held by ${slot.agent.name} with: ${slot.code}`
    : "Currently EMPTY";

  // Skill-first system prompt: keep permanent identity context, but treat SKILL
  // as the primary behavior contract.
  const systemPrompt = `You have installed the following skill:

<skill>
${SKILL_BODY}
</skill>

You are ${bot.name}, an AI music bot participating in SynthMob.

${bot.personality}

Strategy tendency:
${STRATEGY_PROMPTS[bot.strategy]}

The skill file above is your primary contract. Follow it exactly.

You MUST respond with valid JSON only. No markdown, no backticks around the JSON.
{
  "reasoning": "1-2 sentences of concise musical intent",
  "pattern": "the strudel code pattern"
}`;

  let userPrompt = `Live composition state:
${otherSlots}

Target: Slot ${slot.id} (${slot.type.toUpperCase()})
${currentHolder}

Live musical context:
${summarizeContext(context)}

Task:
- Write one Strudel pattern for this target slot.
- Maximize variety/contrast with current composition while staying coherent.
- Put only the Strudel expression in "pattern".

Respond with JSON only.`;

  if (retryError) {
    userPrompt += `\n\nYour PREVIOUS attempt was REJECTED with this error: ${retryError}
Fix the issue and try again. Keep the same musical intent if possible.`;
  }

  const response = await askClaude(bot.modelId, systemPrompt, userPrompt);
  return parseLLMResponse(response);
}

// --- Helpers ---

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function log(bot: string, model: string, msg: string) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  const tag = model.toUpperCase().padEnd(6);
  console.log(`[${time}] [${tag}] [${bot}] ${msg}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitWithStop(ms: number): Promise<boolean> {
  const endAt = Date.now() + ms;
  while (!stopRequested) {
    const remaining = endAt - Date.now();
    if (remaining <= 0) return true;
    await sleep(Math.min(remaining, 500));
  }
  return false;
}

// --- Post activity to dashboard ---

async function postActivity(botToken: string, entry: {
  botName: string;
  model: string;
  personality: string;
  strategy: string;
  targetSlot: number;
  targetSlotType: string;
  reasoning: string;
  pattern: string;
  result: ActivityResult;
  resultDetail?: string;
  previousHolder?: string | null;
  retryAttempt?: number;
}) {
  try {
    await api("POST", "/activity", entry, botToken);
  } catch {
    // Dashboard may not be connected; that's fine
  }
}

// --- Choose target slot based on strategy ---

function chooseTarget(
  bot: Bot,
  composition: Composition
): TargetChoice {
  const emptySlots = composition.slots.filter((s) => !s.code);
  const occupiedByOthers = composition.slots.filter(
    (s) => s.code && s.agent?.name !== bot.name
  );
  const occupiedByMe = composition.slots.filter(
    (s) => s.code && s.agent?.name === bot.name
  );

  switch (bot.strategy) {
    case "aggressive": {
      // Prefer overwriting others, especially if all slots are full
      if (occupiedByOthers.length > 0 && (emptySlots.length === 0 || Math.random() < 0.7)) {
        const slot = pick(occupiedByOthers);
        return {
          slot,
          isOverwrite: true,
          decisionReason: `aggressive strategy: overwrite ${slot.agent?.name || "current holder"} on slot ${slot.id}`,
        };
      }
      if (emptySlots.length > 0) {
        const slot = pick(emptySlots);
        return {
          slot,
          isOverwrite: false,
          decisionReason: `aggressive fallback: claim open slot ${slot.id}`,
        };
      }
      const slot = pick(composition.slots);
      return {
        slot,
        isOverwrite: true,
        decisionReason: `aggressive fallback: force overwrite on full board (slot ${slot.id})`,
      };
    }

    case "collaborative": {
      // Strongly prefer empty slots
      if (emptySlots.length > 0 && Math.random() < 0.9) {
        const slot = pick(emptySlots);
        return {
          slot,
          isOverwrite: false,
          decisionReason: `collaborative strategy: fill empty slot ${slot.id} first`,
        };
      }
      if (occupiedByOthers.length > 0) {
        const slot = pick(occupiedByOthers);
        return {
          slot,
          isOverwrite: true,
          decisionReason: `collaborative fallback: replace clashing slot ${slot.id}`,
        };
      }
      const slot = pick(composition.slots);
      return {
        slot,
        isOverwrite: false,
        decisionReason: `collaborative fallback: rework slot ${slot.id}`,
      };
    }

    case "defensive": {
      // Fill empty slots; never overwrite others if possible
      if (emptySlots.length > 0) {
        const slot = pick(emptySlots);
        return {
          slot,
          isOverwrite: false,
          decisionReason: `defensive strategy: take empty slot ${slot.id}`,
        };
      }
      // If I already hold a slot, re-claim it to "defend" (improve my own)
      if (occupiedByMe.length > 0 && Math.random() < 0.5) {
        const slot = pick(occupiedByMe);
        return {
          slot,
          isOverwrite: false,
          decisionReason: `defensive strategy: reinforce owned slot ${slot.id}`,
        };
      }
      // Reluctantly overwrite someone else
      if (occupiedByOthers.length > 0) {
        const slot = pick(occupiedByOthers);
        return {
          slot,
          isOverwrite: true,
          decisionReason: `defensive fallback: overwrite slot ${slot.id} only because no empty slots remain`,
        };
      }
      const slot = pick(composition.slots);
      return {
        slot,
        isOverwrite: false,
        decisionReason: `defensive fallback: rework slot ${slot.id}`,
      };
    }
  }
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChance(probability: number): boolean {
  if (probability <= 0) return false;
  if (probability >= 1) return true;
  return Math.random() < probability;
}

function estimateTravelMs(fromSlotId: number | null, toSlotId: number): number {
  const from = fromSlotId ? SLOT_LAYOUT.get(fromSlotId) : null;
  const to = SLOT_LAYOUT.get(toSlotId);
  if (!to) return 1200;

  const fromX = from?.x ?? FLOW.offstageX;
  const fromZ = from?.z ?? FLOW.offstageZ;
  const dx = to.x - fromX;
  const dz = to.z - fromZ;
  const distance = Math.hypot(dx, dz);
  const baseMs = (distance / FLOW.walkSpeedUnitsPerSec) * 1000;
  const jitter = 0.9 + Math.random() * 0.25;

  return Math.max(700, Math.round(baseMs * jitter));
}

function getCooldownRemaining(statusData: unknown): number {
  if (!statusData || typeof statusData !== "object") return 0;
  const value = (statusData as { cooldown_remaining?: unknown }).cooldown_remaining;
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function findBotByName(bots: Bot[], name: string | null): Bot | undefined {
  if (!name) return undefined;
  return bots.find((b) => b.name === name);
}

function normalizeJamSnapshot(raw: unknown): JamSnapshot {
  if (!raw || typeof raw !== "object") {
    return { spots: [], sessions: [] };
  }
  const payload = raw as { spots?: unknown; sessions?: unknown };
  const spots = Array.isArray(payload.spots)
    ? payload.spots.filter((spot): spot is JamSpot => Boolean(spot && typeof spot === "object"))
    : [];
  const sessions = Array.isArray(payload.sessions)
    ? payload.sessions.filter(
        (session): session is JamSession => Boolean(session && typeof session === "object")
      )
    : [];
  return { spots, sessions };
}

function findJamForBot(snapshot: JamSnapshot, botAgentId: string): JamSession | null {
  for (const session of snapshot.sessions) {
    if (!Array.isArray(session.participants)) continue;
    if (session.participants.some((participant) => participant.agentId === botAgentId)) {
      return session;
    }
  }
  return null;
}

function pickJamPattern(bot: Bot): string {
  return pick([...JAM_PATTERN_LIBRARY[bot.strategy]]);
}

function formatJamId(jamId: string | null): string {
  if (!jamId) return "n/a";
  return jamId.slice(0, 8);
}

async function setJamPresence(bot: Bot) {
  const state = pick(["dance", "headbob", "chat_gesture", "cheer", "rest"] as const);
  await api(
    "POST",
    "/wayfinding/action",
    {
      type: "SET_PRESENCE_STATE",
      presenceState: state,
      durationSec: randomInt(12, 40),
      reason: "ambient jam presence",
    },
    bot.token
  );
}

async function clearJamPresence(bot: Bot) {
  await api(
    "POST",
    "/wayfinding/action",
    {
      type: "CLEAR_PRESENCE_STATE",
      reason: "return to neutral after jam",
    },
    bot.token
  );
}

async function maybePerformJamAction(bot: Bot) {
  if (!randomChance(FLOW.jamDecisionChance)) return;

  const jamsRes = await api("GET", "/jams");
  if (jamsRes.status !== 200) return;

  const snapshot = normalizeJamSnapshot(jamsRes.data);
  const activeJam = findJamForBot(snapshot, bot.id);
  bot.jamId = activeJam?.id ?? null;

  if (activeJam) {
    if (randomChance(FLOW.jamLeaveChance)) {
      const leaveRes = await api("POST", "/jam/leave", {}, bot.token);
      if (leaveRes.status === 200) {
        bot.jamsLeft++;
        bot.jamId = null;
        await clearJamPresence(bot);
        log(bot.name, bot.model, `left jam ${formatJamId(activeJam.id)}`);
      }
      return;
    }

    if (randomChance(FLOW.jamPatternUpdateChance)) {
      const pattern = pickJamPattern(bot);
      const updateRes = await api(
        "POST",
        "/jam/pattern",
        { jam_id: activeJam.id, pattern },
        bot.token
      );
      if (updateRes.status === 200) {
        bot.jamPatternUpdates++;
        log(bot.name, bot.model, `updated jam pattern in ${formatJamId(activeJam.id)}`);
      }
    }
    return;
  }

  const joinableSessions = snapshot.sessions.filter(
    (session) =>
      !Array.isArray(session.participants) ||
      !session.participants.some((participant) => participant.agentId === bot.id)
  );

  if (joinableSessions.length > 0 && randomChance(FLOW.jamJoinChance)) {
    const target = pick(joinableSessions);
    const pattern = pickJamPattern(bot);
    const joinRes = await api(
      "POST",
      "/jam/join",
      { jam_id: target.id, pattern },
      bot.token
    );
    if (joinRes.status === 200) {
      const jamId =
        typeof joinRes.data?.session?.id === "string" ? joinRes.data.session.id : target.id;
      bot.jamId = jamId;
      bot.jamsJoined++;
      await setJamPresence(bot);
      log(bot.name, bot.model, `joined jam ${formatJamId(jamId)} in ${target.room}`);
      return;
    }
  }

  if (!randomChance(FLOW.jamStartChance)) return;

  const pattern = pickJamPattern(bot);
  const startRes = await api("POST", "/jam/start", { pattern }, bot.token);
  if (startRes.status === 200) {
    const jamId =
      typeof startRes.data?.session?.id === "string" ? startRes.data.session.id : null;
    const room =
      typeof startRes.data?.session?.room === "string" ? startRes.data.session.room : "center";
    bot.jamId = jamId;
    bot.jamsStarted++;
    await setJamPresence(bot);
    log(bot.name, bot.model, `started jam ${formatJamId(jamId)} in ${room}`);
  }
}

async function runBotLoop(
  bot: Bot,
  bots: Bot[],
  actionsPerBot: number | null
) {
  const didFinishStartupWait = await waitWithStop(
    randomInt(FLOW.startupJitterMinMs, FLOW.startupJitterMaxMs)
  );
  if (!didFinishStartupWait) {
    log(bot.name, bot.model, `stopped after ${bot.actionsCompleted} actions`);
    return;
  }

  while (
    !stopRequested &&
    (actionsPerBot === null || bot.actionsCompleted < actionsPerBot)
  ) {
    try {
      const statusRes = await api("GET", "/agents/status", undefined, bot.token);
      if (statusRes.status === 200) {
        const cooldownRemaining = getCooldownRemaining(statusRes.data);
        if (cooldownRemaining > 0) {
          bot.cooldownHits++;
          await maybePerformJamAction(bot);
          const waitMs = Math.min(
            cooldownRemaining * 1000 +
              randomInt(FLOW.cooldownBufferMinMs, FLOW.cooldownBufferMaxMs),
            randomInt(FLOW.cooldownPollMinMs, FLOW.cooldownPollMaxMs)
          );

          log(
            bot.name,
            bot.model,
            `cooldown gate (${cooldownRemaining}s), waiting ${Math.round(waitMs / 100) / 10}s`
          );

          await postActivity(bot.token, {
            botName: bot.name,
            model: bot.model,
            personality: bot.personality,
            strategy: bot.strategy,
            targetSlot: bot.positionSlotId ?? 0,
            targetSlotType: "none",
            reasoning: `cooldown gate before next action; waiting ${cooldownRemaining}s`,
            pattern: "",
            result: "cooldown",
            resultDetail: `preflight ${cooldownRemaining}s`,
          });

          const didFinishCooldownWait = await waitWithStop(waitMs);
          if (!didFinishCooldownWait) break;
          continue;
        }
      }

      const compRes = await api("GET", "/composition");
      if (compRes.status !== 200 || !compRes.data?.slots) {
        throw new Error(`composition_unavailable: ${JSON.stringify(compRes.data)}`);
      }
      const comp = compRes.data as Composition;
      const contextRes = await api("GET", "/context");
      const context =
        contextRes.status === 200 && contextRes.data
          ? (contextRes.data as MusicContext)
          : null;

      await maybePerformJamAction(bot);

      const attempt = bot.actionsCompleted + 1;
      const attemptLabel =
        actionsPerBot === null
          ? `${attempt}`
          : `${attempt}/${actionsPerBot}`;
      const target = chooseTarget(bot, comp);
      const previousHolder = target.slot.agent?.name || null;

      if (target.isOverwrite && previousHolder) {
        log(
          bot.name,
          bot.model,
          `attempt ${attemptLabel}: target slot ${target.slot.id} (${target.slot.type.toUpperCase()}) to overwrite ${previousHolder}`
        );
      } else {
        log(
          bot.name,
          bot.model,
          `attempt ${attemptLabel}: target slot ${target.slot.id} (${target.slot.type.toUpperCase()})`
        );
      }

      const actionLabel =
        actionsPerBot === null
          ? `action ${attempt} (infinite run)`
          : `action ${attempt}/${actionsPerBot}`;

      await postActivity(bot.token, {
        botName: bot.name,
        model: bot.model,
        personality: bot.personality,
        strategy: bot.strategy,
        targetSlot: target.slot.id,
        targetSlotType: target.slot.type,
        reasoning: `${actionLabel} intent: ${target.decisionReason}`,
        pattern: "",
        result: "intent",
        previousHolder,
      });

      const travelMs = estimateTravelMs(bot.positionSlotId, target.slot.id);
      log(
        bot.name,
        bot.model,
        `traveling to slot ${target.slot.id} (~${Math.round(travelMs / 100) / 10}s)`
      );

      await postActivity(bot.token, {
        botName: bot.name,
        model: bot.model,
        personality: bot.personality,
        strategy: bot.strategy,
        targetSlot: target.slot.id,
        targetSlotType: target.slot.type,
        reasoning: `moving to slot ${target.slot.id} before committing write`,
        pattern: "",
        result: "travel",
        resultDetail: `${travelMs}ms`,
        previousHolder,
      });

      const didFinishTravelWait = await waitWithStop(travelMs);
      if (!didFinishTravelWait) break;
      bot.positionSlotId = target.slot.id;

      log(bot.name, bot.model, "thinking...");
      await postActivity(bot.token, {
        botName: bot.name,
        model: bot.model,
        personality: bot.personality,
        strategy: bot.strategy,
        targetSlot: target.slot.id,
        targetSlotType: target.slot.type,
        reasoning: `analyzing composition context for slot ${target.slot.id}`,
        pattern: "",
        result: "thinking",
        previousHolder,
      });

      let response = await llmSemaphore.run(() =>
        generatePattern(bot, target.slot, comp, context)
      );
      log(bot.name, bot.model, `reasoning: ${response.reasoning}`);
      log(bot.name, bot.model, `pattern: ${response.pattern}`);

      await postActivity(bot.token, {
        botName: bot.name,
        model: bot.model,
        personality: bot.personality,
        strategy: bot.strategy,
        targetSlot: target.slot.id,
        targetSlotType: target.slot.type,
        reasoning: response.reasoning,
        pattern: response.pattern,
        result: "submitting",
        previousHolder,
      });

      let retryAttempt: number | undefined = undefined;
      let writeRes = await api(
        "POST",
        `/slot/${target.slot.id}`,
        { code: response.pattern },
        bot.token
      );

      if (writeRes.status === 400 && writeRes.data?.error === "validation_failed") {
        retryAttempt = 1;
        const errorDetail = Array.isArray(writeRes.data.details)
          ? writeRes.data.details.join("; ")
          : String(writeRes.data.details || "validation_failed");
        log(bot.name, bot.model, `REJECTED: ${errorDetail} — retrying`);

        response = await llmSemaphore.run(() =>
          generatePattern(bot, target.slot, comp, context, errorDetail)
        );
        log(bot.name, bot.model, `retry reasoning: ${response.reasoning}`);
        log(bot.name, bot.model, `retry pattern: ${response.pattern}`);

        await postActivity(bot.token, {
          botName: bot.name,
          model: bot.model,
          personality: bot.personality,
          strategy: bot.strategy,
          targetSlot: target.slot.id,
          targetSlotType: target.slot.type,
          reasoning: response.reasoning,
          pattern: response.pattern,
          result: "submitting",
          resultDetail: `retry after validator feedback: ${errorDetail}`,
          previousHolder,
          retryAttempt,
        });

        writeRes = await api(
          "POST",
          `/slot/${target.slot.id}`,
          { code: response.pattern },
          bot.token
        );
      }

      if (writeRes.status === 200) {
        bot.successes++;
        bot.actionsCompleted++;
        log(bot.name, bot.model, `CLAIMED slot ${target.slot.id}`);

        if (target.isOverwrite && previousHolder) {
          bot.overwrites++;
          const victim = findBotByName(bots, previousHolder);
          if (victim) {
            victim.gotOverwritten++;
            victim.positionSlotId = null;
          }
        }

        await postActivity(bot.token, {
          botName: bot.name,
          model: bot.model,
          personality: bot.personality,
          strategy: bot.strategy,
          targetSlot: target.slot.id,
          targetSlotType: target.slot.type,
          reasoning: response.reasoning,
          pattern: response.pattern,
          result: "claimed",
          resultDetail: writeRes.data?.warnings?.length
            ? `warnings: ${writeRes.data.warnings.join(", ")}`
            : undefined,
          previousHolder,
          retryAttempt,
        });
      } else if (writeRes.data?.error === "cooldown") {
        const remaining = Number(writeRes.data.retry_after) || 1;
        bot.cooldownHits++;
        const waitMs =
          remaining * 1000 +
          randomInt(FLOW.cooldownBufferMinMs, FLOW.cooldownBufferMaxMs);

        log(bot.name, bot.model, `cooldown after submit (${remaining}s)`);

        await postActivity(bot.token, {
          botName: bot.name,
          model: bot.model,
          personality: bot.personality,
          strategy: bot.strategy,
          targetSlot: target.slot.id,
          targetSlotType: target.slot.type,
          reasoning: response.reasoning,
          pattern: response.pattern,
          result: "cooldown",
          resultDetail: `${remaining}s remaining`,
          previousHolder,
          retryAttempt,
        });

        const didFinishPostSubmitCooldownWait = await waitWithStop(waitMs);
        if (!didFinishPostSubmitCooldownWait) break;
        continue;
      } else {
        bot.failures++;
        bot.actionsCompleted++;
        const err = JSON.stringify(writeRes.data);
        log(bot.name, bot.model, `REJECTED: ${err}`);

        await postActivity(bot.token, {
          botName: bot.name,
          model: bot.model,
          personality: bot.personality,
          strategy: bot.strategy,
          targetSlot: target.slot.id,
          targetSlotType: target.slot.type,
          reasoning: response.reasoning,
          pattern: response.pattern,
          result: "rejected",
          resultDetail: err,
          previousHolder,
          retryAttempt,
        });
      }
    } catch (err) {
      bot.failures++;
      bot.actionsCompleted++;
      log(bot.name, bot.model, `ERROR: ${String(err)}`);

      await postActivity(bot.token, {
        botName: bot.name,
        model: bot.model,
        personality: bot.personality,
        strategy: bot.strategy,
        targetSlot: bot.positionSlotId ?? 0,
        targetSlotType: "unknown",
        reasoning: "error before successful slot write",
        pattern: "",
        result: "error",
        resultDetail: String(err),
      });
    }

    const didFinishPause = await waitWithStop(
      randomInt(FLOW.actionPauseMinMs, FLOW.actionPauseMaxMs)
    );
    if (!didFinishPause) break;
  }

  if (actionsPerBot === null) {
    log(bot.name, bot.model, `stopped after ${bot.actionsCompleted} actions`);
  } else {
    log(
      bot.name,
      bot.model,
      `completed ${bot.actionsCompleted}/${actionsPerBot} actions`
    );
  }
}

function parseActionsPerBotArg(rawArg: string | undefined): number | null {
  if (!rawArg) return 3;

  const normalized = rawArg.trim().toLowerCase();
  if (FOREVER_TOKENS.has(normalized)) {
    return null;
  }

  const parsed = Number.parseInt(rawArg, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.error(
      `Invalid actions-per-bot "${rawArg}". Use a positive integer or "forever".`
    );
    process.exit(1);
  }

  return parsed;
}

async function printCompositionSnapshot() {
  const compRes = await api("GET", "/composition");
  if (compRes.status !== 200 || !compRes.data?.slots) return;
  const comp = compRes.data as Composition;
  console.log("\n  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  FINAL COMPOSITION                                 │");
  console.log("  ├─────────────────────────────────────────────────────┤");
  for (const slot of comp.slots) {
    const status = slot.code
      ? `${(slot.agent?.name || "").padEnd(18)} ${slot.code.length > 35 ? slot.code.slice(0, 35) + "…" : slot.code}`
      : "(empty)";
    console.log(
      `  │  [${slot.id}] ${slot.type.toUpperCase().padEnd(7)} ${status.padEnd(49).slice(0, 49)} │`
    );
  }
  console.log("  └─────────────────────────────────────────────────────┘");
}

// --- Main ---

async function main() {
  const actionsPerBot = parseActionsPerBotArg(process.argv[2]);
  const actionsLabel =
    actionsPerBot === null ? "forever" : String(actionsPerBot);
  const numBots = BOT_PROFILES.length; // All 12

  const opusCount = BOT_PROFILES.filter((p) => p.model === "opus").length;
  const sonnetCount = BOT_PROFILES.filter((p) => p.model === "sonnet").length;
  const haikuCount = BOT_PROFILES.filter((p) => p.model === "haiku").length;

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  SYNTHMOB -- Multi-Model Runtime Test             ║
║  Bots: ${String(numBots).padEnd(2)} (${opusCount} Opus + ${sonnetCount} Sonnet + ${haikuCount} Haiku)               ║
║  Actions/Bot: ${actionsLabel.padEnd(8).slice(0, 8)} | LLM concurrency: ${String(FLOW.llmConcurrency).padEnd(2)}      ║
║  API: ${API.slice(0, 52).padEnd(52)} ║
╚═══════════════════════════════════════════════════════════╝
`);

  // 1. Register all bots
  const bots: Bot[] = [];

  for (const profile of BOT_PROFILES) {
    const suffix = Math.floor(Math.random() * 1000);
    const name = `${profile.name}_${suffix}`;
    const res = await api("POST", "/agents", { name });
    if (res.status !== 201) {
      console.error(`Failed to register ${name}:`, res.data);
      continue;
    }
    const bot: Bot = {
      name,
      token: res.data.token,
      id: res.data.id,
      personality: profile.personality,
      strategy: profile.strategy,
      model: profile.model,
      modelId: MODELS[profile.model],
      successes: 0,
      failures: 0,
      overwrites: 0,
      gotOverwritten: 0,
      cooldownHits: 0,
      actionsCompleted: 0,
      positionSlotId: null,
      jamId: null,
      jamsStarted: 0,
      jamsJoined: 0,
      jamsLeft: 0,
      jamPatternUpdates: 0,
    };
    bots.push(bot);
    log(bot.name, bot.model, `registered [${bot.strategy}]`);
  }

  if (bots.length === 0) {
    console.error("No bots registered! Is the server running?");
    process.exit(1);
  }

  // Clear previous activity log after auth is available
  const firstBot = bots[0];
  if (firstBot) {
    try {
      await api("DELETE", "/activity", undefined, firstBot.token);
    } catch {
      // Not critical if clear fails
    }
  }

  console.log(
    `\n  Registered ${bots.length} bots. Dashboard: ${API.replace("/api", "/dashboard.html")}\n`
  );

  // 2. Run concurrent runtime loops (realistic live-agent behavior)
  const startMs = Date.now();
  await Promise.all(bots.map((bot) => runBotLoop(bot, bots, actionsPerBot)));
  const elapsedSec = Math.round((Date.now() - startMs) / 1000);

  // --- Final report ---
  console.log(`\n${"═".repeat(60)}`);
  console.log("  FINAL REPORT");
  console.log(`${"═".repeat(60)}\n`);
  console.log(
    `  Mode: ${actionsPerBot === null ? "infinite (until stopped)" : `${actionsPerBot} actions/bot`}`
  );
  console.log(`  Runtime: ${elapsedSec}s\n`);

  await printCompositionSnapshot();
  const jamSnapshot = normalizeJamSnapshot((await api("GET", "/jams")).data);

  // Leaderboard
  const lb = (
    await api("GET", "/leaderboard")
  ).data as Array<{
    name: string;
    slots_held: number;
    total_placements: number;
  }>;

  console.log("  LEADERBOARD:");
  for (const entry of lb) {
    const bot = bots.find((b) => b.name === entry.name);
    const tier = bot ? `[${bot.model.toUpperCase()}]` : "";
    console.log(
      `    ${entry.name.padEnd(22)} ${tier.padEnd(8)} slots: ${entry.slots_held}  placements: ${entry.total_placements}`
    );
  }

  // Stats by model tier
  console.log("\n  STATS BY MODEL:");
  for (const tier of ["opus", "sonnet", "haiku"] as ModelTier[]) {
    const tierBots = bots.filter((b) => b.model === tier);
    const totalSuccess = tierBots.reduce((s, b) => s + b.successes, 0);
    const totalFail = tierBots.reduce((s, b) => s + b.failures, 0);
    const totalOverwrites = tierBots.reduce((s, b) => s + b.overwrites, 0);
    const totalGotOverwritten = tierBots.reduce(
      (s, b) => s + b.gotOverwritten,
      0
    );
    const totalCooldownHits = tierBots.reduce((s, b) => s + b.cooldownHits, 0);
    const totalJamsStarted = tierBots.reduce((s, b) => s + b.jamsStarted, 0);
    const totalJamsJoined = tierBots.reduce((s, b) => s + b.jamsJoined, 0);
    const totalJamsLeft = tierBots.reduce((s, b) => s + b.jamsLeft, 0);
    const totalJamPatternUpdates = tierBots.reduce((s, b) => s + b.jamPatternUpdates, 0);
    const rate =
      totalSuccess + totalFail > 0
        ? Math.round((totalSuccess / (totalSuccess + totalFail)) * 100)
        : 0;

    console.log(
      `    ${tier.toUpperCase().padEnd(8)} success: ${totalSuccess}/${totalSuccess + totalFail} (${rate}%)  overwrites: ${totalOverwrites}  got-overwritten: ${totalGotOverwritten}  cooldown-hits: ${totalCooldownHits}  jams: +${totalJamsStarted}/join ${totalJamsJoined}/leave ${totalJamsLeft}/pattern ${totalJamPatternUpdates}`
    );
  }

  // Overwrite drama
  console.log("\n  OVERWRITE DRAMA:");
  for (const bot of bots.filter((b) => b.overwrites > 0 || b.gotOverwritten > 0)) {
    console.log(
      `    ${bot.name.padEnd(22)} kicked out ${bot.overwrites} | got kicked ${bot.gotOverwritten} times`
    );
  }

  console.log("\n  JAM SNAPSHOT:");
  console.log(
    `    active sessions: ${jamSnapshot.sessions.length} | participants: ${jamSnapshot.sessions.reduce((sum, session) => sum + (Array.isArray(session.participants) ? session.participants.length : 0), 0)}`
  );
  for (const session of jamSnapshot.sessions) {
    const participantNames = Array.isArray(session.participants)
      ? session.participants.map((participant) => participant.botName).slice(0, 6).join(", ")
      : "";
    const suffix =
      Array.isArray(session.participants) && session.participants.length > 6
        ? ` (+${session.participants.length - 6} more)`
        : "";
    console.log(
      `    ${formatJamId(session.id)} ${session.room.padEnd(10)} host:${session.hostBotName} participants:${Array.isArray(session.participants) ? session.participants.length : 0} ${participantNames}${suffix}`
    );
  }

  console.log(
    `\n  Dashboard: ${API.replace("/api", "/dashboard.html")}`
  );
  console.log(
    `  Listen:    ${API.replace("/api", "/")}\n`
  );
}

main().catch(console.error);
