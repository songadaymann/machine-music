#!/usr/bin/env bun
// Multi-Activity Stress Test — agents with ALL skills, no pre-assigned roles
// Each agent gets the full skill stack and heartbeat template, just like an OpenClaw instance would.
// They decide autonomously what to do: compose music, paint visuals, build worlds, design games, socialize.
//
// Usage: bun run test/multi-activity-stress.ts [actions-per-bot|forever] [num-bots]
//
// Requires ANTHROPIC_API_KEY in .env or environment.

const API = process.env.API_URL || "http://localhost:5555/api";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required. Set it in .env or environment.");
  process.exit(1);
}

import { readFileSync } from "fs";
import { join } from "path";

// --- Load skill docs ---

function loadSkill(relativePath: string): string {
  const fullPath = join(import.meta.dir, "..", relativePath);
  const raw = readFileSync(fullPath, "utf-8");
  return raw.replace(/^---[\s\S]*?---\s*/, "").trim();
}

const CORE_SKILL = loadSkill(".claude/skills/synthmob/SKILL.md");
const COMPOSE_SKILL = loadSkill(".claude/skills/synthmob-compose/SKILL.md");
const VISUAL_SKILL = loadSkill(".claude/skills/synthmob-visual/SKILL.md");
const WORLD_SKILL = loadSkill(".claude/skills/synthmob-world/SKILL.md");
const GAME_SKILL = loadSkill(".claude/skills/synthmob-game/SKILL.md");
const HEARTBEAT = loadSkill(".claude/skills/synthmob/heartbeat-template.md");

let STRUDEL_PATTERNS = "";
try {
  STRUDEL_PATTERNS = loadSkill(
    ".claude/skills/synthmob-compose/references/strudel-patterns.md"
  );
} catch {
  // Optional reference
}

// --- Catalog item names (fetched at startup) ---

let catalogItemNames: string[] = [];

async function fetchCatalogItems(): Promise<string[]> {
  try {
    const res = await fetch(`${API}/world/catalog`);
    if (res.status === 200) {
      const data: any = await res.json();
      if (data?.items && typeof data.items === "object") {
        return Object.keys(data.items);
      }
    }
  } catch {
    // Catalog unavailable — not critical
  }
  return [];
}

// --- Model tiers ---

const MODELS = {
  opus: "claude-opus-4-20250514",
  sonnet: "claude-sonnet-4-20250514",
  haiku: "claude-haiku-4-5-20251001",
} as const;

type ModelTier = keyof typeof MODELS;
type AgentAction =
  | "write_slot"
  | "place_music"
  | "update_placement"
  | "remove_placement"
  | "start_session"
  | "join_session"
  | "update_output"
  | "leave_session"
  | "send_message"
  | "observe"
  | "submit_world"
  | "nominate_ritual"
  | "vote_ritual";

// --- Flow config ---

const FLOW = {
  startupJitterMinMs: 300,
  startupJitterMaxMs: 2000,
  actionPauseMinMs: 1500,
  actionPauseMaxMs: 4000,
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
  console.log(
    `\n[stress] ${signal} received. Finishing in-flight work, then printing report...`
  );
}

process.on("SIGINT", () => requestStop("SIGINT"));
process.on("SIGTERM", () => requestStop("SIGTERM"));

// --- Types ---

interface AgentBot {
  name: string;
  token: string;
  id: string;
  model: ModelTier;
  modelId: string;
  // Stats
  actionsAttempted: number;
  actionsSucceeded: number;
  actionsFailed: number;
  validationErrors: number;
  sessionsCreated: number;
  sessionsJoined: number;
  sessionsLeft: number;
  outputUpdates: number;
  slotsWritten: number;
  musicPlacements: number;
  placementUpdates: number;
  placementRemovals: number;
  worldSubmissions: number;
  messagesSent: number;
  observations: number;
  ritualParticipations: number;
  currentSessionId: string | null;
  // Track action types
  actionLog: Array<{
    action: AgentAction;
    success: boolean;
    error?: string;
    timestamp: number;
  }>;
}

interface AgentResponse {
  reasoning: string;
  action: AgentAction;
  payload: Record<string, unknown>;
}

interface SessionInfo {
  id: string;
  type: string;
  title?: string;
  hostAgentId: string;
  hostBotName: string;
  participants: Array<{
    agentId: string;
    botName: string;
    pattern?: string;
    output?: unknown;
  }>;
}

// --- Default number of bots ---

const DEFAULT_NUM_BOTS = 10;

// --- API helpers ---

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; data: any }> {
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
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data: any = await res.json();
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

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// --- Parse agent response ---

function parseAgentResponse(raw: string): AgentResponse {
  let cleaned = raw.trim();
  cleaned = cleaned
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  // Try JSON parse first
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
    // Fall through to heuristic
  }

  // Try to find JSON object in the text
  const jsonMatch = raw.match(/\{[\s\S]*"action"\s*:\s*"[^"]+[\s\S]*\}/);
  if (jsonMatch) {
    try {
      let depth = 0;
      let start = -1;
      let end = -1;
      for (let i = 0; i < jsonMatch[0].length; i++) {
        if (jsonMatch[0][i] === "{") {
          if (start === -1) start = i;
          depth++;
        } else if (jsonMatch[0][i] === "}") {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      const candidate =
        end > start ? jsonMatch[0].slice(start, end) : jsonMatch[0];
      const parsed = JSON.parse(candidate);
      return {
        reasoning: parsed.reasoning || "(no reasoning)",
        action: parsed.action,
        payload: parsed.payload || {},
      };
    } catch {
      // Fall through
    }
  }

  // Last resort: observe
  return {
    reasoning: `(could not parse response: ${raw.slice(0, 100)})`,
    action: "observe",
    payload: {},
  };
}

// --- Build system prompt ---
// This is the key change: agents get ALL skills, like an OpenClaw instance would.

function buildSystemPrompt(): string {
  return `<skill name="synthmob-core">
${CORE_SKILL}
</skill>

<skill name="synthmob-compose">
${COMPOSE_SKILL}
</skill>

<skill name="synthmob-visual">
${VISUAL_SKILL}
</skill>

<skill name="synthmob-world">
${WORLD_SKILL}
</skill>

<skill name="synthmob-game">
${GAME_SKILL}
</skill>

${STRUDEL_PATTERNS ? `<reference name="strudel-patterns">\n${STRUDEL_PATTERNS}\n</reference>` : ""}

<heartbeat>
${HEARTBEAT}
</heartbeat>`;
}

// --- Summarize world state compactly ---

function summarizeWorld(world: unknown): string {
  if (!world || typeof world !== "object") return "  (unavailable)";
  const w = world as Record<string, unknown>;
  const lines: string[] = [];

  const env = w.environment as Record<string, unknown> | undefined;
  if (env) {
    const parts: string[] = [];
    if (env.sky) parts.push(`sky: ${env.sky}`);
    const fog = env.fog as Record<string, unknown> | undefined;
    if (fog?.color) parts.push(`fog: ${fog.color}`);
    const lighting = env.lighting as Record<string, unknown> | undefined;
    const ambient = lighting?.ambient as Record<string, unknown> | undefined;
    if (ambient?.color) parts.push(`ambient: ${ambient.color}`);
    if (parts.length) lines.push(`  Environment: ${parts.join(", ")}`);
  }

  const contributions = w.contributions as unknown[] | undefined;
  if (Array.isArray(contributions)) {
    for (const c of contributions) {
      const contrib = c as Record<string, unknown>;
      const parts: string[] = [];

      // Elements
      const elements = contrib.elements as unknown[] | undefined;
      const elCount = Array.isArray(elements) ? elements.length : 0;
      if (elCount > 0) {
        const els = elements as Record<string, unknown>[];
        const types = els
          .slice(0, 4)
          .map((e) => e.type || "?")
          .join(", ");
        parts.push(`${elCount} elements [${types}]`);
      }

      // Voxels
      const voxels = contrib.voxels as unknown[] | undefined;
      const voxelCount = Array.isArray(voxels) ? voxels.length : 0;
      if (voxelCount > 0) {
        const blockCounts: Record<string, number> = {};
        for (const v of voxels as Record<string, unknown>[]) {
          const block = (v.block as string) || "?";
          blockCounts[block] = (blockCounts[block] || 0) + 1;
        }
        const topBlocks = Object.entries(blockCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([b, n]) => `${b}:${n}`)
          .join(", ");
        parts.push(`${voxelCount} voxels [${topBlocks}]`);
      }

      // Catalog items
      const catalogItems = contrib.catalog_items as unknown[] | undefined;
      const catCount = Array.isArray(catalogItems) ? catalogItems.length : 0;
      if (catCount > 0) {
        const itemNames = (catalogItems as Record<string, unknown>[])
          .slice(0, 3)
          .map((i) => i.item || "?")
          .join(", ");
        parts.push(`${catCount} catalog [${itemNames}]`);
      }

      if (parts.length === 0) continue;

      // Position hint from first element or voxel
      let posHint = "";
      if (elCount > 0) {
        const els = elements as Record<string, unknown>[];
        posHint = els
          .slice(0, 2)
          .map((e) => {
            const p = (e.pos as number[]) || [0, 0, 0];
            return `(${Math.round(p[0] ?? 0)},${Math.round(p[2] ?? 0)})`;
          })
          .join(" ");
      } else if (voxelCount > 0) {
        const vs = voxels as Record<string, unknown>[];
        posHint = `(${vs[0]?.x ?? 0},${vs[0]?.z ?? 0})`;
      }

      lines.push(
        `  ${contrib.botName}: ${parts.join(", ")}${posHint ? ` near ${posHint}` : ""}`
      );
    }
  }

  return lines.length > 0 ? lines.join("\n") : "  (empty — nothing built yet)";
}

// --- Build user prompt with current state ---

function buildUserPrompt(
  bot: AgentBot,
  composition: unknown,
  sessions: SessionInfo[],
  context: unknown,
  onlineAgents: unknown[],
  recentMessages: unknown[],
  worldSnapshot: unknown,
  ritualState: unknown,
  musicPlacements: unknown[],
  iteration: number,
  totalIterations: number | null,
  catalogItems: string[]
): string {
  const iterLabel = totalIterations
    ? `${iteration}/${totalIterations}`
    : `${iteration} (infinite)`;

  const compSlots = (composition as { slots?: unknown[] })?.slots;
  const compSummary = Array.isArray(compSlots)
    ? compSlots
        .map((s: any) =>
          s.code
            ? `  Slot ${s.id} (${s.type}) by ${s.agent?.name || "unknown"}: ${(s.code as string).slice(0, 60)}${s.code.length > 60 ? "..." : ""}`
            : `  Slot ${s.id} (${s.type}): EMPTY`
        )
        .join("\n")
    : "  (composition unavailable)";

  const sessionSummary =
    sessions.length > 0
      ? sessions
          .map((s) => {
            const participantDetails = s.participants
              .map((p) => {
                let work = "";
                if ((p as any).pattern) {
                  const pat = (p as any).pattern as string;
                  work = ` — "${pat.slice(0, 50)}${pat.length > 50 ? "..." : ""}"`;
                } else if ((p as any).output) {
                  work = ` — ${JSON.stringify((p as any).output).slice(0, 50)}...`;
                }
                return `${p.botName}${work}`;
              })
              .join(", ");
            const amIn = s.participants.some((p) => p.agentId === bot.id);
            const posLabel = (s as any).position
              ? ` at (${Math.round((s as any).position.x)}, ${Math.round((s as any).position.z)})`
              : "";
            return `  [${s.id.slice(0, 8)}] ${s.type}: "${s.title || "(untitled)"}" by ${s.hostBotName}${posLabel} (${participantDetails})${amIn ? " ← YOU ARE HERE" : ""}`;
          })
          .join("\n")
      : "  (no active sessions)";

  const contextSummary =
    context && typeof context === "object"
      ? Object.entries(context as Record<string, unknown>)
          .filter(([k]) => ["bpm", "key", "scale", "scaleNotes"].includes(k))
          .map(([k, v]) => `  ${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
          .join("\n")
      : "  (unavailable)";

  // Check if bot's cached session still exists
  const validSessionIds = new Set(sessions.map((s) => s.id));
  if (bot.currentSessionId && !validSessionIds.has(bot.currentSessionId)) {
    bot.currentSessionId = null;
  }

  const currentSessionNote = bot.currentSessionId
    ? `You are currently in session ${bot.currentSessionId.slice(0, 8)}.`
    : "You are not currently in any session.";

  const onlineSummary =
    onlineAgents.length > 0
      ? onlineAgents
          .map((a: any) => {
            const activity = a.currentActivity
              ? ` [${a.currentActivity}]`
              : "";
            const session = a.currentSessionType
              ? ` in ${a.currentSessionType} session`
              : "";
            const slots = a.slotsHeld?.length
              ? ` (${a.slotsHeld.length} slots)`
              : "";
            const isMe = a.id === bot.id ? " ← YOU" : "";
            return `  ${a.name}${activity}${session}${slots}${isMe}`;
          })
          .join("\n")
      : "  (nobody online)";

  const messageSummary =
    recentMessages.length > 0
      ? recentMessages
          .map((m: any) => {
            const target = m.toName ? ` → ${m.toName}` : "";
            return `  [${m.fromName}${target}]: ${m.content}`;
          })
          .join("\n")
      : "  (no recent messages)";

  const worldSummary = summarizeWorld(worldSnapshot);

  // Hint for world building when world is empty/sparse
  const worldContribs = worldSnapshot && typeof worldSnapshot === "object"
    ? (worldSnapshot as Record<string, unknown>).contributions as unknown[] | undefined
    : undefined;
  const worldContribCount = Array.isArray(worldContribs) ? worldContribs.length : 0;
  const worldHint = worldContribCount < 3
    ? "\n  TIP: The world is sparse! Use submit_world with voxels (stone, brick, wood blocks on integer grid) to build structures, catalog_items (tree_oak, bench, lamppost, etc.) for decoration, and elements for abstract shapes."
    : "";

  // Music placements summary
  const placementsSummary =
    musicPlacements.length > 0
      ? musicPlacements
          .map((p: any) => {
            const pat = (p.pattern as string) || "";
            const isMine = p.agentId === bot.id;
            return `  [${(p.id as string).slice(0, 8)}] ${p.instrumentType} by ${p.botName} at (${Math.round(p.position?.x ?? 0)}, ${Math.round(p.position?.z ?? 0)}): "${pat.slice(0, 50)}${pat.length > 50 ? "..." : ""}"${isMine ? " ← YOURS" : ""}`;
          })
          .join("\n")
      : "  (no instruments placed yet)";

  // Ritual state summary
  let ritualSummary = "  No active ritual.";
  if (ritualState && typeof ritualState === "object") {
    const r = ritualState as Record<string, unknown>;
    if (r.phase && r.phase !== "idle") {
      ritualSummary = `  Active ritual — phase: ${r.phase}`;
      if (r.phase === "nominate") {
        ritualSummary += `\n  You can nominate BPM (60-200), key (C-B), and scale.`;
        if (r.hasNominated) ritualSummary += `\n  (You already nominated this round.)`;
      } else if (r.phase === "vote") {
        const candidates = r.candidates as Record<string, unknown> | undefined;
        if (candidates) {
          ritualSummary += `\n  Candidates: ${JSON.stringify(candidates).slice(0, 200)}`;
        }
        if (r.hasVoted) ritualSummary += `\n  (You already voted this round.)`;
      } else if (r.phase === "result") {
        const winners = r.winners as Record<string, unknown> | undefined;
        if (winners) ritualSummary += `\n  Winners: ${JSON.stringify(winners)}`;
      }
    }
  }

  // Recent action history for self-awareness
  const recentActions = bot.actionLog.slice(-5);
  const actionHistory =
    recentActions.length > 0
      ? recentActions
          .map(
            (a) =>
              `  ${a.action}${a.success ? "" : " (FAILED: " + (a.error || "unknown") + ")"}`
          )
          .join("\n")
      : "  (first turn)";

  return `You are "${bot.name}". Turn ${iterLabel}. ${currentSessionNote}

Follow your skills and heartbeat. Here is the current arena state:

Recent actions:
${actionHistory}

Composition:
${compSummary}

Sessions:
${sessionSummary}

Music Placements:
${placementsSummary}

World:
${worldSummary}${worldHint}

Online (${onlineAgents.length}):
${onlineSummary}

Messages:
${messageSummary}

Context:
${contextSummary}

Ritual:
${ritualSummary}

Respond with raw JSON only:
{ "reasoning": "...", "action": "<action>", "payload": {<see below>} }

Action payloads:
  place_music: { "instrument_type": "808|cello|dusty_piano|synth|prophet_5|synthesizer|tr66", "pattern": "<strudel>", "position": { "x": <num>, "z": <num> } }
  update_placement: { "placement_id": "...", "pattern": "<strudel>" }
  remove_placement: { "placement_id": "..." }
  write_slot: { "slot_id": <1-8>, "code": "<strudel pattern>" }
  start_session: { "type": "music|visual|world|game", "title": "...", "pattern": "..." } or { "type": "...", "title": "...", "output": {...} }
  join_session: { "session_id": "...", "pattern"|"output": ... }
  update_output: { "session_id": "...", "pattern"|"output": ... }
  leave_session: { "session_id": "..." }
  submit_world: { "output": { "elements": [...], "voxels": [{"block":"stone","x":0,"y":0,"z":0}, ...], "catalog_items": [{"item":"tree_oak","pos":[10,0,-15]}, ...], "sky": "#hex", "fog": {...}, "lighting": {...} } }
    voxel blocks: stone, brick, wood, plank, glass, metal, grass, dirt, sand, water, ice, lava, concrete, marble, obsidian, glow (max 500, integer coords ±100, y 0-100)
    catalog items: ${catalogItems.length > 0 ? catalogItems.join(", ") : "(catalog unavailable)"} (max 30, pos [x,y,z] ±100, optional rotation/scale)
  send_message: { "content": "max 280 chars", "to": "optional agent name" }
  nominate_ritual: { "bpm": 120, "key": "C", "scale": "pentatonic", "reasoning": "..." }
  vote_ritual: { "bpm_candidate": <n>, "key_candidate": <n> }
  observe: {}`;
}

// --- Execute an agent's chosen action ---

async function executeAction(
  bot: AgentBot,
  response: AgentResponse
): Promise<{ success: boolean; error?: string }> {
  const { action, payload } = response;

  try {
    switch (action) {
      case "write_slot": {
        const slotId = payload.slot_id as number;
        const code = payload.code as string;
        if (!slotId || !code) {
          return { success: false, error: "missing slot_id or code" };
        }
        const res = await api("POST", `/slot/${slotId}`, { code }, bot.token);
        if (res.status === 200) {
          bot.slotsWritten++;
          return { success: true };
        }
        const errDetail = res.data?.details
          ? Array.isArray(res.data.details)
            ? res.data.details.join("; ")
            : String(res.data.details)
          : res.data?.error || `HTTP ${res.status}`;
        if (res.status === 400 && res.data?.error === "validation_failed") {
          bot.validationErrors++;
        }
        return { success: false, error: errDetail };
      }

      case "place_music": {
        const instrumentType = payload.instrument_type as string;
        const pattern = payload.pattern as string;
        const position = payload.position as { x: number; z: number } | undefined;
        if (!instrumentType || !pattern) {
          return { success: false, error: "missing instrument_type or pattern" };
        }
        const res = await api("POST", "/music/place", {
          instrument_type: instrumentType,
          pattern,
          position: position || { x: randomInt(-80, 80), z: randomInt(-80, 80) },
        }, bot.token);
        if (res.status === 200) {
          bot.musicPlacements++;
          return { success: true };
        }
        if (res.data?.error === "validation_failed") bot.validationErrors++;
        const errDetail = res.data?.details
          ? Array.isArray(res.data.details)
            ? res.data.details.join("; ")
            : String(res.data.details)
          : res.data?.error || `HTTP ${res.status}`;
        return { success: false, error: errDetail };
      }

      case "update_placement": {
        const placementId = payload.placement_id as string;
        const pattern = payload.pattern as string;
        if (!placementId || !pattern) {
          return { success: false, error: "missing placement_id or pattern" };
        }
        const res = await api("PUT", `/music/placement/${placementId}`, { pattern }, bot.token);
        if (res.status === 200) {
          bot.placementUpdates++;
          return { success: true };
        }
        if (res.data?.error === "validation_failed") bot.validationErrors++;
        return { success: false, error: res.data?.error || `HTTP ${res.status}` };
      }

      case "remove_placement": {
        const placementId = payload.placement_id as string;
        if (!placementId) {
          return { success: false, error: "missing placement_id" };
        }
        const res = await api("DELETE", `/music/placement/${placementId}`, undefined, bot.token);
        if (res.status === 200) {
          bot.placementRemovals++;
          return { success: true };
        }
        return { success: false, error: res.data?.error || `HTTP ${res.status}` };
      }

      case "start_session": {
        const sessionType = payload.type as string;
        if (!sessionType) {
          return { success: false, error: "missing session type" };
        }
        const body: Record<string, unknown> = {
          type: sessionType,
          title: payload.title || undefined,
        };
        if (sessionType === "music") {
          body.pattern = payload.pattern;
        } else {
          body.output = payload.output;
        }
        const res = await api("POST", "/session/start", body, bot.token);
        if (res.status === 200 || res.status === 201) {
          bot.sessionsCreated++;
          bot.currentSessionId = res.data?.session?.id || null;
          return { success: true };
        }
        if (res.data?.error === "validation_failed") bot.validationErrors++;
        return {
          success: false,
          error: res.data?.error || `HTTP ${res.status}`,
        };
      }

      case "join_session": {
        const sessionId = payload.session_id as string;
        if (!sessionId) {
          return { success: false, error: "missing session_id" };
        }
        const body: Record<string, unknown> = { session_id: sessionId };
        if (payload.pattern) body.pattern = payload.pattern;
        if (payload.output) body.output = payload.output;
        const res = await api("POST", "/session/join", body, bot.token);
        if (res.status === 200 || res.status === 201) {
          bot.sessionsJoined++;
          bot.currentSessionId = sessionId;
          return { success: true };
        }
        if (res.data?.error === "session_not_found") {
          bot.currentSessionId = null;
        }
        if (res.data?.error === "validation_failed") bot.validationErrors++;
        return {
          success: false,
          error: res.data?.error || `HTTP ${res.status}`,
        };
      }

      case "update_output": {
        const sessionId =
          (payload.session_id as string) || bot.currentSessionId;
        if (!sessionId) {
          return {
            success: false,
            error: "no session_id and not in a session",
          };
        }
        const body: Record<string, unknown> = { session_id: sessionId };
        if (payload.pattern) body.pattern = payload.pattern;
        if (payload.output) body.output = payload.output;
        const res = await api("POST", "/session/output", body, bot.token);
        if (res.status === 200) {
          bot.outputUpdates++;
          return { success: true };
        }
        if (
          res.data?.error === "session_not_found" ||
          res.data?.error === "not_in_session"
        ) {
          bot.currentSessionId = null;
        }
        if (res.data?.error === "validation_failed") bot.validationErrors++;
        return {
          success: false,
          error: res.data?.error || `HTTP ${res.status}`,
        };
      }

      case "leave_session": {
        const sessionId =
          (payload.session_id as string) || bot.currentSessionId;
        if (!sessionId) {
          return { success: false, error: "no session_id to leave" };
        }
        const res = await api(
          "POST",
          "/session/leave",
          { session_id: sessionId },
          bot.token
        );
        if (res.status === 200) {
          bot.sessionsLeft++;
          bot.currentSessionId = null;
          return { success: true };
        }
        if (
          res.data?.error === "session_not_found" ||
          res.data?.error === "not_in_session"
        ) {
          bot.currentSessionId = null;
        }
        return {
          success: false,
          error: res.data?.error || `HTTP ${res.status}`,
        };
      }

      case "submit_world": {
        const output = payload.output;
        if (!output) {
          return { success: false, error: "missing output" };
        }
        const res = await api(
          "POST",
          "/world",
          { output },
          bot.token
        );
        if (res.status === 200 || res.status === 201) {
          bot.worldSubmissions++;
          return { success: true };
        }
        if (res.data?.error === "validation_failed") bot.validationErrors++;
        return {
          success: false,
          error: res.data?.error || `HTTP ${res.status}`,
        };
      }

      case "send_message": {
        const content = payload.content as string;
        if (!content) {
          return { success: false, error: "missing content" };
        }
        const msgBody: Record<string, unknown> = { content };
        if (payload.to) msgBody.to = payload.to;
        const res = await api("POST", "/agents/messages", msgBody, bot.token);
        if (res.status === 201 || res.status === 200) {
          bot.messagesSent++;
          return { success: true };
        }
        return {
          success: false,
          error: res.data?.error || `HTTP ${res.status}`,
        };
      }

      case "nominate_ritual": {
        const body: Record<string, unknown> = {};
        if (payload.bpm) body.bpm = payload.bpm;
        if (payload.key) body.key = payload.key;
        if (payload.scale) body.scale = payload.scale;
        if (payload.reasoning) body.reasoning = payload.reasoning;
        const res = await api(
          "POST",
          "/ritual/nominate",
          body,
          bot.token
        );
        if (res.status === 200 || res.status === 201) {
          bot.ritualParticipations++;
          return { success: true };
        }
        return {
          success: false,
          error: res.data?.error || `HTTP ${res.status}`,
        };
      }

      case "vote_ritual": {
        const body: Record<string, unknown> = {};
        if (payload.bpm_candidate) body.bpm_candidate = payload.bpm_candidate;
        if (payload.key_candidate) body.key_candidate = payload.key_candidate;
        const res = await api("POST", "/ritual/vote", body, bot.token);
        if (res.status === 200 || res.status === 201) {
          bot.ritualParticipations++;
          return { success: true };
        }
        return {
          success: false,
          error: res.data?.error || `HTTP ${res.status}`,
        };
      }

      case "observe": {
        bot.observations++;
        return { success: true };
      }

      default:
        return { success: false, error: `unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// --- Bot loop ---

async function runBotLoop(bot: AgentBot, actionsPerBot: number | null) {
  const didFinishStartupWait = await waitWithStop(
    randomInt(FLOW.startupJitterMinMs, FLOW.startupJitterMaxMs)
  );
  if (!didFinishStartupWait) return;

  const systemPrompt = buildSystemPrompt();
  let iteration = 0;

  while (
    !stopRequested &&
    (actionsPerBot === null || iteration < actionsPerBot)
  ) {
    iteration++;
    const iterLabel = actionsPerBot
      ? `${iteration}/${actionsPerBot}`
      : `${iteration}`;

    try {
      // 1. Read all state (agents decide what to care about)
      const [
        compRes,
        sessionsRes,
        contextRes,
        onlineRes,
        messagesRes,
        worldRes,
        ritualRes,
        placementsRes,
      ] = await Promise.all([
        api("GET", "/composition"),
        api("GET", "/sessions"),
        api("GET", "/context"),
        api("GET", "/agents/online"),
        api("GET", "/agents/messages", undefined, bot.token),
        api("GET", "/world"),
        api("GET", "/ritual").catch(() => ({ status: 404, data: null })),
        api("GET", "/music/placements"),
      ]);

      const composition = compRes.status === 200 ? compRes.data : null;
      const sessionsRaw =
        sessionsRes.status === 200 ? sessionsRes.data : null;
      const sessions: SessionInfo[] = Array.isArray(
        (sessionsRaw as any)?.sessions
      )
        ? (sessionsRaw as any).sessions
        : Array.isArray(sessionsRaw)
          ? (sessionsRaw as SessionInfo[])
          : [];
      const worldSnapshot = worldRes.status === 200 ? worldRes.data : null;
      const context = contextRes.status === 200 ? contextRes.data : null;
      const onlineAgents: unknown[] =
        onlineRes.status === 200 && Array.isArray(onlineRes.data)
          ? onlineRes.data
          : [];
      const recentMessages: unknown[] =
        messagesRes.status === 200 && Array.isArray(messagesRes.data)
          ? (messagesRes.data as unknown[]).slice(-20)
          : [];
      const ritualState =
        ritualRes.status === 200 ? ritualRes.data : null;
      const placementsRaw =
        placementsRes.status === 200 ? placementsRes.data : null;
      const placements: unknown[] = Array.isArray(
        (placementsRaw as any)?.placements
      )
        ? (placementsRaw as any).placements
        : [];

      // 2. Build prompt and ask Claude
      const userPrompt = buildUserPrompt(
        bot,
        composition,
        sessions,
        context,
        onlineAgents,
        recentMessages,
        worldSnapshot,
        ritualState,
        placements,
        iteration,
        actionsPerBot,
        catalogItemNames
      );

      log(bot.name, bot.model, `turn ${iterLabel} — thinking...`);

      const raw = await llmSemaphore.run(() =>
        askClaude(bot.modelId, systemPrompt, userPrompt)
      );

      // 3. Parse response
      const response = parseAgentResponse(raw);
      log(
        bot.name,
        bot.model,
        `→ ${response.action}: ${response.reasoning.slice(0, 80)}`
      );

      // 4. Execute action
      bot.actionsAttempted++;
      const result = await executeAction(bot, response);

      bot.actionLog.push({
        action: response.action,
        success: result.success,
        error: result.error,
        timestamp: Date.now(),
      });

      if (result.success) {
        bot.actionsSucceeded++;
        log(bot.name, bot.model, `  OK (${response.action})`);
      } else {
        bot.actionsFailed++;
        log(
          bot.name,
          bot.model,
          `  FAIL (${response.action}): ${result.error}`
        );
      }

      // Post activity for dashboard
      try {
        // Infer activity category from the action
        const musicActions = new Set(["write_slot", "place_music", "update_placement", "remove_placement"]);
        const activityCategory =
          musicActions.has(response.action)
            ? "music"
            : response.action === "submit_world"
              ? "world"
              : response.action === "start_session"
                ? (payload_type(response.payload) || "mixed")
                : response.action === "send_message"
                  ? "social"
                  : response.action === "observe"
                    ? "observe"
                    : "mixed";

        await api(
          "POST",
          "/activity",
          {
            botName: bot.name,
            model: bot.model,
            personality: bot.name,
            strategy: activityCategory,
            targetSlot: 0,
            targetSlotType: activityCategory,
            reasoning: response.reasoning,
            pattern:
              (response.payload.code as string) ||
              (response.payload.pattern as string) ||
              JSON.stringify(response.payload.output || {}).slice(0, 200),
            result: result.success ? "claimed" : "rejected",
            resultDetail: result.error,
          },
          bot.token
        );
      } catch {
        // Dashboard logging is optional
      }
    } catch (err) {
      bot.actionsAttempted++;
      bot.actionsFailed++;
      log(bot.name, bot.model, `ERROR: ${String(err)}`);
      bot.actionLog.push({
        action: "observe",
        success: false,
        error: String(err),
        timestamp: Date.now(),
      });
    }

    // Pause between actions
    const didFinishPause = await waitWithStop(
      randomInt(FLOW.actionPauseMinMs, FLOW.actionPauseMaxMs)
    );
    if (!didFinishPause) break;
  }

  log(
    bot.name,
    bot.model,
    `done — ${bot.actionsSucceeded}/${bot.actionsAttempted} succeeded`
  );
}

function payload_type(payload: Record<string, unknown>): string | null {
  return (payload.type as string) || null;
}

// --- Final report ---

function printReport(
  bots: AgentBot[],
  elapsedSec: number,
  actionsPerBot: number | null
) {
  console.log(`\n${"═".repeat(70)}`);
  console.log("  SYNTHMOB STRESS TEST — FINAL REPORT");
  console.log(`${"═".repeat(70)}\n`);
  console.log(
    `  Mode: ${actionsPerBot === null ? "infinite (until stopped)" : `${actionsPerBot} actions/bot`}`
  );
  console.log(`  Runtime: ${elapsedSec}s`);
  console.log(`  Agents: ${bots.length} (no pre-assigned roles)\n`);

  // Per-agent stats with activity variety
  console.log("  PER-AGENT RESULTS:");
  console.log(
    "  " +
      "Name".padEnd(22) +
      "Model".padEnd(8) +
      "OK".padEnd(5) +
      "Fail".padEnd(6) +
      "Activities"
  );
  console.log("  " + "─".repeat(70));

  for (const bot of bots) {
    const actionBreakdown = bot.actionLog.reduce(
      (acc, entry) => {
        acc[entry.action] = (acc[entry.action] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
    const actionStr = Object.entries(actionBreakdown)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");

    console.log(
      "  " +
        bot.name.padEnd(22) +
        bot.model.padEnd(8) +
        String(bot.actionsSucceeded).padEnd(5) +
        String(bot.actionsFailed).padEnd(6) +
        actionStr
    );
  }

  // Activity variety — the key metric for this test
  console.log("\n  ACTIVITY VARIETY (did agents explore different mediums?):");
  const actionCategories = {
    music: ["write_slot", "place_music", "update_placement", "remove_placement"],
    sessions: ["start_session", "join_session", "update_output", "leave_session"],
    world: ["submit_world"],
    social: ["send_message"],
    observe: ["observe"],
    ritual: ["nominate_ritual", "vote_ritual"],
  };

  for (const bot of bots) {
    const categories = new Set<string>();

    for (const entry of bot.actionLog) {
      for (const [cat, actions] of Object.entries(actionCategories)) {
        if (actions.includes(entry.action)) categories.add(cat);
      }
    }

    const variety = categories.size;
    const varietyLabel =
      variety >= 4
        ? "EXCELLENT"
        : variety >= 3
          ? "GOOD"
          : variety >= 2
            ? "OK"
            : "LOW";
    console.log(
      `    ${bot.name.padEnd(22)} ${variety} categories: [${[...categories].join(", ")}] — ${varietyLabel}`
    );
  }

  // Per-model stats
  console.log("\n  PER-MODEL STATS:");
  for (const tier of ["opus", "sonnet", "haiku"] as ModelTier[]) {
    const tierBots = bots.filter((b) => b.model === tier);
    if (tierBots.length === 0) continue;
    const totalAttempted = tierBots.reduce(
      (s, b) => s + b.actionsAttempted,
      0
    );
    const totalSucceeded = tierBots.reduce(
      (s, b) => s + b.actionsSucceeded,
      0
    );
    const totalValErrors = tierBots.reduce(
      (s, b) => s + b.validationErrors,
      0
    );
    const rate =
      totalAttempted > 0
        ? Math.round((totalSucceeded / totalAttempted) * 100)
        : 0;

    console.log(
      `    ${tier.toUpperCase().padEnd(8)} agents: ${tierBots.length}  success: ${totalSucceeded}/${totalAttempted} (${rate}%)  val-errors: ${totalValErrors}`
    );
  }

  // Collaboration metrics
  console.log("\n  COLLABORATION:");
  const totalJoins = bots.reduce((s, b) => s + b.sessionsJoined, 0);
  const totalCreated = bots.reduce((s, b) => s + b.sessionsCreated, 0);
  const totalUpdates = bots.reduce((s, b) => s + b.outputUpdates, 0);
  const totalMessages = bots.reduce((s, b) => s + b.messagesSent, 0);
  const totalWorldSubs = bots.reduce((s, b) => s + b.worldSubmissions, 0);
  const totalSlots = bots.reduce((s, b) => s + b.slotsWritten, 0);
  const totalMusicPlacements = bots.reduce((s, b) => s + b.musicPlacements, 0);
  const totalPlacementUpdates = bots.reduce((s, b) => s + b.placementUpdates, 0);
  const totalPlacementRemovals = bots.reduce((s, b) => s + b.placementRemovals, 0);
  const totalRituals = bots.reduce((s, b) => s + b.ritualParticipations, 0);
  console.log(
    `    Slots written: ${totalSlots}  Music placed: ${totalMusicPlacements} (updated: ${totalPlacementUpdates}, removed: ${totalPlacementRemovals})`
  );
  console.log(
    `    World submissions: ${totalWorldSubs}  Sessions: +${totalCreated}/join ${totalJoins}  Updates: ${totalUpdates}  Messages: ${totalMessages}  Rituals: ${totalRituals}`
  );
  const joinRatio =
    totalCreated > 0 ? (totalJoins / totalCreated).toFixed(1) : "n/a";
  console.log(
    `    Join/Create ratio: ${joinRatio} (higher = more collaboration)`
  );

  // Skill effectiveness
  console.log("\n  SKILL EFFECTIVENESS:");
  const totalActions = bots.reduce((s, b) => s + b.actionsAttempted, 0);
  const totalObserves = bots.reduce((s, b) => s + b.observations, 0);
  const parseFailures = bots.reduce(
    (s, b) =>
      s +
      b.actionLog.filter(
        (e) =>
          e.action === "observe" && e.error?.includes("could not parse")
      ).length,
    0
  );
  const totalValErrorsAll = bots.reduce(
    (s, b) => s + b.validationErrors,
    0
  );

  console.log(`    Total actions: ${totalActions}`);
  console.log(
    `    Parse failures (LLM didn't produce valid JSON): ${parseFailures}`
  );
  console.log(
    `    Validation errors (valid JSON, bad payload): ${totalValErrorsAll}`
  );
  console.log(`    Observe-only turns: ${totalObserves}`);

  // Unique action types used across all bots
  const allActionTypes = new Set<string>();
  for (const bot of bots) {
    for (const entry of bot.actionLog) {
      allActionTypes.add(entry.action);
    }
  }
  console.log(
    `    Unique action types used: ${allActionTypes.size} — [${[...allActionTypes].join(", ")}]`
  );

  if (parseFailures > totalActions * 0.2) {
    console.log(
      "    !! High parse failure rate — skill docs may need clearer response format"
    );
  }
  if (totalValErrorsAll > totalActions * 0.3) {
    console.log(
      "    !! High validation error rate — skill docs may need more explicit schema examples"
    );
  }
  if (totalObserves > totalActions * 0.5) {
    console.log(
      "    !! High observe rate — heartbeat template may need stronger action prompts"
    );
  }
  if (allActionTypes.size <= 2) {
    console.log(
      "    !! Low action variety — agents may need encouragement to explore different activities"
    );
  }

  console.log("");
}

// --- Main ---

function parseActionsPerBotArg(rawArg: string | undefined): number | null {
  if (!rawArg) return 5;
  const normalized = rawArg.trim().toLowerCase();
  if (FOREVER_TOKENS.has(normalized)) return null;
  const parsed = Number.parseInt(rawArg, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.error(
      `Invalid actions-per-bot "${rawArg}". Use a positive integer or "forever".`
    );
    process.exit(1);
  }
  return parsed;
}

async function main() {
  const actionsPerBot = parseActionsPerBotArg(process.argv[2]);
  const actionsLabel =
    actionsPerBot === null ? "forever" : String(actionsPerBot);

  const numBots = process.argv[3]
    ? parseInt(process.argv[3], 10)
    : DEFAULT_NUM_BOTS;

  // Model distribution: ~20% sonnet, ~80% haiku
  const modelDistribution: ModelTier[] = ["sonnet", "haiku", "haiku", "haiku", "haiku"];

  const models = Array.from({ length: numBots }, (_, i) => modelDistribution[i % modelDistribution.length]!);
  const sonnetCount = models.filter((m) => m === "sonnet").length;
  const haikuCount = models.filter((m) => m === "haiku").length;
  const opusCount = models.filter((m) => m === "opus").length;

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  SYNTHMOB — Autonomous Agent Stress Test                       ║
║  Agents: ${String(numBots).padEnd(2)} (${opusCount} Opus + ${sonnetCount} Sonnet + ${haikuCount} Haiku)                        ║
║  ALL agents get ALL skills — no pre-assigned roles             ║
║  Actions/Bot: ${actionsLabel.padEnd(8).slice(0, 8)} | LLM concurrency: ${String(FLOW.llmConcurrency).padEnd(2)}             ║
║  API: ${API.padEnd(57)} ║
╚══════════════════════════════════════════════════════════════════╝
`);

  // Fetch world catalog items
  catalogItemNames = await fetchCatalogItems();
  if (catalogItemNames.length > 0) {
    console.log(`  Catalog: ${catalogItemNames.length} items (${catalogItemNames.slice(0, 5).join(", ")}${catalogItemNames.length > 5 ? "..." : ""})`);
  } else {
    console.log("  Catalog: unavailable (agents will use voxels + elements only)");
  }

  // Register all bots
  console.log("  Registering agents...");
  const bots: AgentBot[] = [];

  for (let i = 0; i < numBots; i++) {
    const suffix = Math.floor(Math.random() * 1000);
    const name = `agent_${i + 1}_${suffix}`;
    const model = models[i]!;
    const res = await api("POST", "/agents", { name });
    if (res.status !== 201) {
      console.error(`    FAIL: ${name}:`, res.data);
      continue;
    }

    const bot: AgentBot = {
      name,
      token: res.data.token,
      id: res.data.id,
      model,
      modelId: MODELS[model],
      actionsAttempted: 0,
      actionsSucceeded: 0,
      actionsFailed: 0,
      validationErrors: 0,
      sessionsCreated: 0,
      sessionsJoined: 0,
      sessionsLeft: 0,
      outputUpdates: 0,
      slotsWritten: 0,
      musicPlacements: 0,
      placementUpdates: 0,
      placementRemovals: 0,
      worldSubmissions: 0,
      messagesSent: 0,
      observations: 0,
      ritualParticipations: 0,
      currentSessionId: null,
      actionLog: [],
    };
    bots.push(bot);
    log(bot.name, bot.model, "registered");
  }

  if (bots.length === 0) {
    console.error("No bots registered! Is the server running?");
    process.exit(1);
  }

  // Clear previous activity log
  try {
    await api("DELETE", "/activity", undefined, bots[0]!.token);
  } catch {
    // Not critical
  }

  console.log(`\n  ${bots.length} agents registered. Starting loops...\n`);

  // 3. Run all bot loops concurrently
  const startMs = Date.now();
  await Promise.all(bots.map((bot) => runBotLoop(bot, actionsPerBot)));
  const elapsedSec = Math.round((Date.now() - startMs) / 1000);

  // 4. Print final report
  printReport(bots, elapsedSec, actionsPerBot);

  // 5. Print final sessions snapshot
  const sessionsRes = await api("GET", "/sessions");
  const finalSessionsRaw =
    sessionsRes.status === 200 ? sessionsRes.data : null;
  const finalSessions: SessionInfo[] = Array.isArray(
    (finalSessionsRaw as any)?.sessions
  )
    ? (finalSessionsRaw as any).sessions
    : Array.isArray(finalSessionsRaw)
      ? (finalSessionsRaw as SessionInfo[])
      : [];
  if (finalSessions.length > 0) {
    console.log("  FINAL SESSIONS:");
    for (const s of finalSessions) {
      const participants = s.participants.map((p) => p.botName).join(", ");
      console.log(
        `    [${s.id.slice(0, 8)}] ${s.type.padEnd(7)} "${s.title || "(untitled)"}" by ${s.hostBotName} — ${s.participants.length} participants: ${participants}`
      );
    }
  } else {
    console.log("  FINAL SESSIONS: (none active)");
  }

  // 6. Print final composition
  const compRes = await api("GET", "/composition");
  if (compRes.status === 200 && compRes.data?.slots) {
    const comp = compRes.data as {
      slots: Array<{
        id: number;
        type: string;
        code: string | null;
        agent?: { name: string };
      }>;
    };
    console.log("\n  FINAL COMPOSITION:");
    for (const slot of comp.slots) {
      const status = slot.code
        ? `${(slot.agent?.name || "").padEnd(18)} ${slot.code.slice(0, 45)}${slot.code.length > 45 ? "..." : ""}`
        : "(empty)";
      console.log(
        `    [${slot.id}] ${slot.type.toUpperCase().padEnd(7)} ${status}`
      );
    }
  }

  // 7. Print final music placements
  const placementsRes = await api("GET", "/music/placements");
  const finalPlacements: unknown[] = Array.isArray(
    (placementsRes.data as any)?.placements
  )
    ? (placementsRes.data as any).placements
    : [];
  if (finalPlacements.length > 0) {
    console.log("\n  FINAL MUSIC PLACEMENTS:");
    for (const p of finalPlacements) {
      const pl = p as any;
      const pat = (pl.pattern as string) || "";
      console.log(
        `    [${(pl.id as string).slice(0, 8)}] ${(pl.instrumentType as string).padEnd(12)} by ${(pl.botName as string).padEnd(18)} at (${Math.round(pl.position?.x ?? 0)}, ${Math.round(pl.position?.z ?? 0)}): "${pat.slice(0, 45)}${pat.length > 45 ? "..." : ""}"`
      );
    }
  } else {
    console.log("\n  FINAL MUSIC PLACEMENTS: (none)");
  }

  // 8. Print final world snapshot summary
  const worldRes = await api("GET", "/world");
  if (worldRes.status === 200) {
    console.log("\n  FINAL WORLD:");
    console.log(summarizeWorld(worldRes.data));

    // Aggregate voxel/catalog stats
    const worldData = worldRes.data as Record<string, unknown>;
    const worldContributions = worldData.contributions as unknown[] | undefined;
    if (Array.isArray(worldContributions) && worldContributions.length > 0) {
      let totalVoxels = 0;
      let totalCatalogItems = 0;
      let totalElements = 0;
      const allBlocks: Record<string, number> = {};
      const allCatalogNames: Record<string, number> = {};

      for (const c of worldContributions) {
        const contrib = c as Record<string, unknown>;
        const els = contrib.elements as unknown[] | undefined;
        if (Array.isArray(els)) totalElements += els.length;

        const voxels = contrib.voxels as unknown[] | undefined;
        if (Array.isArray(voxels)) {
          totalVoxels += voxels.length;
          for (const v of voxels as Record<string, unknown>[]) {
            const block = (v.block as string) || "?";
            allBlocks[block] = (allBlocks[block] || 0) + 1;
          }
        }

        const catItems = contrib.catalog_items as unknown[] | undefined;
        if (Array.isArray(catItems)) {
          totalCatalogItems += catItems.length;
          for (const i of catItems as Record<string, unknown>[]) {
            const name = (i.item as string) || "?";
            allCatalogNames[name] = (allCatalogNames[name] || 0) + 1;
          }
        }
      }

      console.log(`\n  WORLD TOTALS: ${totalElements} elements, ${totalVoxels} voxels, ${totalCatalogItems} catalog items`);
      if (totalVoxels > 0) {
        const blockSummary = Object.entries(allBlocks)
          .sort((a, b) => b[1] - a[1])
          .map(([b, n]) => `${b}:${n}`)
          .join(", ");
        console.log(`    Block types: ${blockSummary}`);
      }
      if (totalCatalogItems > 0) {
        const catSummary = Object.entries(allCatalogNames)
          .sort((a, b) => b[1] - a[1])
          .map(([n, c]) => `${n}:${c}`)
          .join(", ");
        console.log(`    Catalog items: ${catSummary}`);
      }
    }
  }

  console.log(
    `\n  Dashboard: ${API.replace("/api", "/dashboard.html")}`
  );
  console.log(`  Listen:    ${API.replace("/api", "/")}\n`);
}

main().catch(console.error);
