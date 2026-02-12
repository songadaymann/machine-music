#!/usr/bin/env bun
// Multi-model LLM stress test -- Haiku, Sonnet, and Opus bots compete
// Usage: bun run test/llm-stress-test.ts [rounds]
//
// Requires ANTHROPIC_API_KEY in .env or environment

const API = process.env.API_URL || "http://localhost:5555/api";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required. Set it in .env or environment.");
  process.exit(1);
}

// --- Load SKILL.md (the way an OpenClaw agent would receive it) ---

import { readFileSync } from "fs";
import { join } from "path";

const SKILL_MD = readFileSync(
  join(import.meta.dir, "..", "SKILL.md"),
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

interface LLMResponse {
  reasoning: string;
  pattern: string;
}

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

  // If multi-line, pick the line that looks like Strudel code
  const lines = pattern
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length > 1) {
    const codeLine = lines.find((l) => /^(s|note|n)\s*\(/.test(l));
    if (codeLine) pattern = codeLine;
    else pattern = lines[0];
  }

  return pattern;
}

// --- Generate a pattern via LLM ---
//
// The system prompt is built from SKILL.md (loaded from disk at startup),
// exactly as an OpenClaw agent would receive it. The only additions are:
// - Bot identity (name, personality, strategy)
// - Response format instruction (JSON with reasoning + pattern)

async function generatePattern(
  bot: Bot,
  slot: Slot,
  composition: Composition,
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

  // System prompt: SKILL.md + bot identity + response format
  const systemPrompt = `You have installed the following skill:

<skill>
${SKILL_BODY}
</skill>

You are ${bot.name}, an AI music bot participating in The Music Place.

${bot.personality}

STRATEGY: ${STRATEGY_PROMPTS[bot.strategy]}

RESPONSE FORMAT: You MUST respond with valid JSON only. No markdown, no backticks around the JSON.
{
  "reasoning": "1-2 sentences explaining your musical thinking and why you chose this approach",
  "pattern": "the strudel code pattern"
}`;

  let userPrompt = `The current composition state:
${otherSlots}

Target: Slot ${slot.id} (${slot.type.toUpperCase()})
${currentHolder}

Write a Strudel pattern for this slot. Respond with JSON only.`;

  if (retryError) {
    userPrompt += `\n\nYour PREVIOUS attempt was REJECTED with this error: ${retryError}
Fix the issue and try again. Read the skill instructions carefully.`;
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
  result: "claimed" | "rejected" | "cooldown" | "error";
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
): { slot: Slot; isOverwrite: boolean } {
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
        return { slot: pick(occupiedByOthers), isOverwrite: true };
      }
      if (emptySlots.length > 0) return { slot: pick(emptySlots), isOverwrite: false };
      return { slot: pick(composition.slots), isOverwrite: true };
    }

    case "collaborative": {
      // Strongly prefer empty slots
      if (emptySlots.length > 0 && Math.random() < 0.9) {
        return { slot: pick(emptySlots), isOverwrite: false };
      }
      if (occupiedByOthers.length > 0) {
        return { slot: pick(occupiedByOthers), isOverwrite: true };
      }
      return { slot: pick(composition.slots), isOverwrite: false };
    }

    case "defensive": {
      // Fill empty slots; never overwrite others if possible
      if (emptySlots.length > 0) {
        return { slot: pick(emptySlots), isOverwrite: false };
      }
      // If I already hold a slot, re-claim it to "defend" (improve my own)
      if (occupiedByMe.length > 0 && Math.random() < 0.5) {
        return { slot: pick(occupiedByMe), isOverwrite: false };
      }
      // Reluctantly overwrite someone else
      if (occupiedByOthers.length > 0) {
        return { slot: pick(occupiedByOthers), isOverwrite: true };
      }
      return { slot: pick(composition.slots), isOverwrite: false };
    }
  }
}

// --- Main ---

async function main() {
  const rounds = parseInt(process.argv[2] || "3", 10);
  const numBots = BOT_PROFILES.length; // All 12

  const opusCount = BOT_PROFILES.filter((p) => p.model === "opus").length;
  const sonnetCount = BOT_PROFILES.filter((p) => p.model === "sonnet").length;
  const haikuCount = BOT_PROFILES.filter((p) => p.model === "haiku").length;

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  THE MUSIC PLACE -- Multi-Model Stress Test              ║
║  Bots: ${String(numBots).padEnd(2)} (${opusCount} Opus + ${sonnetCount} Sonnet + ${haikuCount} Haiku)               ║
║  Rounds: ${String(rounds).padEnd(2)} | API: ${API.slice(0, 40).padEnd(40)} ║
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

  // 2. Run rounds
  for (let round = 1; round <= rounds; round++) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  ROUND ${round} / ${rounds}`);
    console.log(`${"═".repeat(60)}\n`);

    // Shuffle bot order each round
    const shuffled = [...bots].sort(() => Math.random() - 0.5);

    for (const bot of shuffled) {
      try {
        // Read current composition
        const comp = (await api("GET", "/composition")).data as Composition;

        // Choose target based on strategy
        const { slot: targetSlot, isOverwrite } = chooseTarget(bot, comp);
        const previousHolder = targetSlot.agent?.name || null;

        if (isOverwrite && previousHolder) {
          log(
            bot.name,
            bot.model,
            `targeting slot ${targetSlot.id} (${targetSlot.type.toUpperCase()}) — OVERWRITING ${previousHolder}`
          );
        } else {
          log(
            bot.name,
            bot.model,
            `targeting empty slot ${targetSlot.id} (${targetSlot.type.toUpperCase()})`
          );
        }

        // Ask LLM to generate a pattern (with reasoning)
        log(bot.name, bot.model, "thinking...");
        let response = await generatePattern(bot, targetSlot, comp);
        log(bot.name, bot.model, `reasoning: ${response.reasoning}`);
        log(bot.name, bot.model, `pattern: ${response.pattern}`);

        // Submit
        let writeRes = await api(
          "POST",
          `/slot/${targetSlot.id}`,
          { code: response.pattern },
          bot.token
        );

        // Retry once on validation failure
        if (
          writeRes.status === 400 &&
          writeRes.data.error === "validation_failed"
        ) {
          const errorDetail = (writeRes.data.details || []).join("; ");
          log(bot.name, bot.model, `REJECTED: ${errorDetail} — retrying...`);

          response = await generatePattern(
            bot,
            targetSlot,
            comp,
            errorDetail
          );
          log(bot.name, bot.model, `retry reasoning: ${response.reasoning}`);
          log(bot.name, bot.model, `retry pattern: ${response.pattern}`);

          writeRes = await api(
            "POST",
            `/slot/${targetSlot.id}`,
            { code: response.pattern },
            bot.token
          );

          if (writeRes.status === 200) {
            log(bot.name, bot.model, `CLAIMED slot ${targetSlot.id} on retry!`);
            bot.successes++;
            if (isOverwrite && previousHolder) bot.overwrites++;

            // Track who got overwritten
            const victim = bots.find((b) => b.name === previousHolder);
            if (victim) victim.gotOverwritten++;

            await postActivity(bot.token, {
              botName: bot.name,
              model: bot.model,
              personality: bot.personality,
              strategy: bot.strategy,
              targetSlot: targetSlot.id,
              targetSlotType: targetSlot.type,
              reasoning: response.reasoning,
              pattern: response.pattern,
              result: "claimed",
              previousHolder,
              retryAttempt: 1,
            });
          } else {
            const err =
              writeRes.data.error === "cooldown"
                ? `on cooldown (${writeRes.data.retry_after}s)`
                : JSON.stringify(writeRes.data);
            log(bot.name, bot.model, `FAILED on retry: ${err}`);
            bot.failures++;

            await postActivity(bot.token, {
              botName: bot.name,
              model: bot.model,
              personality: bot.personality,
              strategy: bot.strategy,
              targetSlot: targetSlot.id,
              targetSlotType: targetSlot.type,
              reasoning: response.reasoning,
              pattern: response.pattern,
              result:
                writeRes.data.error === "cooldown" ? "cooldown" : "rejected",
              resultDetail: err,
              previousHolder,
              retryAttempt: 1,
            });
          }
        } else if (writeRes.status === 200) {
          log(bot.name, bot.model, `CLAIMED slot ${targetSlot.id}!`);
          if (writeRes.data.warnings?.length > 0) {
            log(
              bot.name,
              bot.model,
              `warnings: ${writeRes.data.warnings.join(", ")}`
            );
          }
          bot.successes++;
          if (isOverwrite && previousHolder) bot.overwrites++;

          const victim = bots.find((b) => b.name === previousHolder);
          if (victim) victim.gotOverwritten++;

          await postActivity(bot.token, {
            botName: bot.name,
            model: bot.model,
            personality: bot.personality,
            strategy: bot.strategy,
            targetSlot: targetSlot.id,
            targetSlotType: targetSlot.type,
            reasoning: response.reasoning,
            pattern: response.pattern,
            result: "claimed",
            previousHolder,
          });
        } else if (writeRes.data.error === "cooldown") {
          log(
            bot.name,
            bot.model,
            `on cooldown — retry in ${writeRes.data.retry_after}s`
          );

          await postActivity(bot.token, {
            botName: bot.name,
            model: bot.model,
            personality: bot.personality,
            strategy: bot.strategy,
            targetSlot: targetSlot.id,
            targetSlotType: targetSlot.type,
            reasoning: response.reasoning,
            pattern: response.pattern,
            result: "cooldown",
            resultDetail: `${writeRes.data.retry_after}s remaining`,
            previousHolder,
          });
        } else {
          const err = JSON.stringify(writeRes.data);
          log(bot.name, bot.model, `REJECTED: ${err}`);
          bot.failures++;

          await postActivity(bot.token, {
            botName: bot.name,
            model: bot.model,
            personality: bot.personality,
            strategy: bot.strategy,
            targetSlot: targetSlot.id,
            targetSlotType: targetSlot.type,
            reasoning: response.reasoning,
            pattern: response.pattern,
            result: "rejected",
            resultDetail: err,
            previousHolder,
          });
        }
      } catch (err) {
        log(bot.name, bot.model, `ERROR: ${err}`);
        bot.failures++;

        await postActivity(bot.token, {
          botName: bot.name,
          model: bot.model,
          personality: bot.personality,
          strategy: bot.strategy,
          targetSlot: 0,
          targetSlotType: "unknown",
          reasoning: "(error before LLM call)",
          pattern: "",
          result: "error",
          resultDetail: String(err),
        });
      }

      // Small delay between bots (stagger API calls)
      await sleep(300);
    }

    // Show composition state after round
    const comp = (await api("GET", "/composition")).data as Composition;
    console.log("\n  ┌─────────────────────────────────────────────────────┐");
    console.log("  │  COMPOSITION STATE                                  │");
    console.log("  ├─────────────────────────────────────────────────────┤");
    for (const slot of comp.slots) {
      const status = slot.code
        ? `${(slot.agent!.name || "").padEnd(18)} ${slot.code.length > 35 ? slot.code.slice(0, 35) + "…" : slot.code}`
        : "(empty)";
      console.log(
        `  │  [${slot.id}] ${slot.type.toUpperCase().padEnd(7)} ${status.padEnd(49).slice(0, 49)} │`
      );
    }
    console.log("  └─────────────────────────────────────────────────────┘");

    // Wait between rounds for cooldowns
    if (round < rounds) {
      const waitTime = 65;
      console.log(`\n  Waiting ${waitTime}s for cooldowns to expire...`);
      await sleep(waitTime * 1000);
    }
  }

  // --- Final report ---
  console.log(`\n${"═".repeat(60)}`);
  console.log("  FINAL REPORT");
  console.log(`${"═".repeat(60)}\n`);

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
    const rate =
      totalSuccess + totalFail > 0
        ? Math.round((totalSuccess / (totalSuccess + totalFail)) * 100)
        : 0;

    console.log(
      `    ${tier.toUpperCase().padEnd(8)} success: ${totalSuccess}/${totalSuccess + totalFail} (${rate}%)  overwrites: ${totalOverwrites}  got-overwritten: ${totalGotOverwritten}`
    );
  }

  // Overwrite drama
  console.log("\n  OVERWRITE DRAMA:");
  for (const bot of bots.filter((b) => b.overwrites > 0 || b.gotOverwritten > 0)) {
    console.log(
      `    ${bot.name.padEnd(22)} kicked out ${bot.overwrites} | got kicked ${bot.gotOverwritten} times`
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
