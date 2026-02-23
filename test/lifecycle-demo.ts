#!/usr/bin/env bun
// Lifecycle Demo — 3 agents living in the world, visible in the browser.
//
// No LLM needed. Scripted wandering + activities with realistic timing.
// Open the client in a browser and watch them move, dance, build, and compose.
//
// Agents:
//   Melody  — wanders between parcel and town square, writes music, dances
//   Pixel   — builds things on parcel, sets sky colors, visits town square
//   Groove  — social butterfly, moves around, sets presence states, chats
//
// Usage: bun run test/lifecycle-demo.ts [api-url]
// Press Ctrl+C to stop gracefully.

const API = process.argv[2] || process.env.API_URL || "http://localhost:5555/api";

// ─── Types ───────────────────────────────────────────────────────────

interface Agent {
  label: string;
  name: string;
  token: string;
  id: string;
  parcelCenter: { x: number; z: number };
  parcelBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  placementIds: string[];
  sessionId: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

const COLORS = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
};
const AGENT_COLORS: Record<string, string> = {
  Melody: COLORS.magenta, Pixel: COLORS.cyan, Groove: COLORS.yellow,
};

const startMs = Date.now();
function elapsed(): string {
  return `${COLORS.dim}${((Date.now() - startMs) / 1000).toFixed(0).padStart(5)}s${COLORS.reset}`;
}

function log(label: string, msg: string) {
  const color = AGENT_COLORS[label] || COLORS.dim;
  console.log(`${elapsed()} ${color}${label.padEnd(7)}${COLORS.reset} ${msg}`);
}

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data: any;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function rand(min: number, max: number) { return Math.random() * (max - min) + min; }
function randInt(min: number, max: number) { return Math.floor(rand(min, max + 1)); }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]!; }

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log(`\n${COLORS.yellow}Stopping gracefully... (Ctrl+C again to force)${COLORS.reset}`);
});

// ─── Registration ────────────────────────────────────────────────────

async function register(label: string): Promise<Agent> {
  const name = `${label.toLowerCase()}_${Date.now() % 100000}`;
  const res = await api("POST", "/agents", { name });
  if (res.status !== 201) throw new Error(`Failed to register ${label}: ${JSON.stringify(res.data)}`);

  const parcel = res.data.parcel;
  log(label, `${COLORS.green}registered${COLORS.reset} as ${name} — parcel ${parcel?.id || "none"} at (${parcel?.center?.x?.toFixed(0) || "?"}, ${parcel?.center?.z?.toFixed(0) || "?"})`);

  return {
    label, name, token: res.data.token, id: res.data.id,
    parcelCenter: parcel?.center || { x: 0, z: 0 },
    parcelBounds: parcel?.bounds || null,
    placementIds: [],
    sessionId: null,
  };
}

// ─── Actions ─────────────────────────────────────────────────────────

async function spawn(agent: Agent) {
  const { x, z } = agent.parcelCenter;
  const res = await api("POST", "/wayfinding/action", {
    type: "SPAWN_AT", x, z, reason: `${agent.label} spawning`,
  }, agent.token);
  if (res.status === 200) log(agent.label, `spawned at parcel center (${x.toFixed(0)}, ${z.toFixed(0)})`);
}

async function moveTo(agent: Agent, x: number, z: number, reason: string): Promise<boolean> {
  const res = await api("POST", "/wayfinding/action", {
    type: "MOVE_TO", x, z, reason,
  }, agent.token);
  if (res.status === 200 && res.data?.ok) {
    log(agent.label, `${COLORS.blue}walking${COLORS.reset} → (${x.toFixed(0)}, ${z.toFixed(0)}) — ${reason}`);
    return true;
  }
  if (res.data?.reason_code === "movement_in_progress") {
    log(agent.label, `${COLORS.dim}still walking, waiting...${COLORS.reset}`);
    return false;
  }
  return false;
}

async function goHome(agent: Agent) {
  // Use MOVE_TO instead of GO_HOME so client sees the walk animation
  const { x, z } = agent.parcelCenter;
  return moveTo(agent, x, z, "heading home");
}

async function setPresence(agent: Agent, state: string, duration: number) {
  const res = await api("POST", "/wayfinding/action", {
    type: "SET_PRESENCE_STATE", presenceState: state, durationSec: duration,
    reason: `${agent.label} is ${state}`,
  }, agent.token);
  if (res.status === 200) log(agent.label, `${COLORS.green}${state}${COLORS.reset} for ${duration}s`);
}

async function clearPresence(agent: Agent) {
  await api("POST", "/wayfinding/action", {
    type: "CLEAR_PRESENCE_STATE", reason: "done",
  }, agent.token);
}

async function writeSlot(agent: Agent, slotId: number, code: string) {
  const res = await api("POST", `/slot/${slotId}`, { code }, agent.token);
  if (res.status === 200) {
    log(agent.label, `${COLORS.green}wrote slot ${slotId}${COLORS.reset}: ${code.slice(0, 50)}`);
  } else {
    log(agent.label, `${COLORS.red}slot ${slotId} rejected${COLORS.reset}: ${res.data?.error || res.status}`);
  }
}

async function placeMusic(agent: Agent, type: string, pattern: string, x: number, z: number) {
  const res = await api("POST", "/music/place", {
    instrument_type: type, pattern, position: { x, z },
  }, agent.token);
  if (res.status === 200 && res.data?.placement) {
    agent.placementIds.push(res.data.placement.id);
    log(agent.label, `${COLORS.green}placed ${type}${COLORS.reset} at (${x.toFixed(0)}, ${z.toFixed(0)})`);
  } else {
    log(agent.label, `${COLORS.red}place ${type} failed${COLORS.reset}: ${res.data?.error || res.status}`);
  }
}

async function buildWorld(agent: Agent, output: Record<string, unknown>) {
  const res = await api("POST", "/world", { output }, agent.token);
  if (res.status === 200) {
    const parts: string[] = [];
    const v = output.voxels as unknown[] | undefined;
    if (Array.isArray(v)) parts.push(`${v.length} voxels`);
    const c = output.catalog_items as unknown[] | undefined;
    if (Array.isArray(c)) parts.push(`${c.length} catalog`);
    if (output.sky) parts.push(`sky=${output.sky}`);
    log(agent.label, `${COLORS.green}built${COLORS.reset}: ${parts.join(", ")}`);
  } else {
    log(agent.label, `${COLORS.red}build failed${COLORS.reset}: ${res.data?.error || res.status}`);
  }
}

async function startSession(agent: Agent, type: string, title: string, content: Record<string, unknown>) {
  const body: Record<string, unknown> = { type, title, ...content };
  const res = await api("POST", "/session/start", body, agent.token);
  if ((res.status === 200 || res.status === 201) && res.data?.session) {
    agent.sessionId = res.data.session.id;
    log(agent.label, `${COLORS.green}started ${type} session${COLORS.reset}: "${title}"`);
  }
}

async function joinSession(agent: Agent, sessionId: string, content: Record<string, unknown>) {
  const body: Record<string, unknown> = { session_id: sessionId, ...content };
  const res = await api("POST", "/session/join", body, agent.token);
  if (res.status === 200 || res.status === 201) {
    agent.sessionId = sessionId;
    log(agent.label, `${COLORS.green}joined session${COLORS.reset} ${sessionId.slice(0, 8)}`);
  }
}

async function leaveSession(agent: Agent) {
  if (!agent.sessionId) return;
  await api("POST", "/session/leave", { session_id: agent.sessionId }, agent.token);
  log(agent.label, `left session ${agent.sessionId.slice(0, 8)}`);
  agent.sessionId = null;
}

async function sendMessage(agent: Agent, content: string, to?: string) {
  const body: Record<string, unknown> = { content };
  if (to) body.to = to;
  const res = await api("POST", "/agents/messages", body, agent.token);
  if (res.status === 200 || res.status === 201) {
    log(agent.label, `${COLORS.dim}says:${COLORS.reset} "${content}"${to ? ` → ${to}` : ""}`);
  }
}

// ─── Wait for movement to complete ──────────────────────────────────

async function waitForArrival(agent: Agent, maxWaitMs: number = 20000) {
  const deadline = Date.now() + maxWaitMs;
  while (!stopping && Date.now() < deadline) {
    const res = await api("GET", "/wayfinding/state", undefined, agent.token);
    if (res.status === 200 && res.data?.self?.locomotionState === "idle") return;
    await sleep(1000);
  }
}

// ─── Scripted Agent Behaviors ────────────────────────────────────────

// Each agent has a scripted sequence of "beats" — things they do in order.
// After all beats complete, the sequence loops. Timing between beats
// lets you watch in the browser.

interface Beat {
  delay: number;  // seconds to wait BEFORE this beat
  action: (agents: Agent[]) => Promise<void>;
  description: string;
}

function melodyBeats(melody: Agent, _pixel: Agent, groove: Agent): Beat[] {
  const cx = melody.parcelCenter.x;
  const cz = melody.parcelCenter.z;

  return [
    // --- Walk to town square ---
    { delay: 2, description: "walk to town square",
      action: async () => {
        await moveTo(melody, rand(-4, 4), rand(-4, 4), "heading to town square");
      }},
    { delay: 8, description: "arrive + dance",
      action: async () => {
        await waitForArrival(melody, 10000);
        await setPresence(melody, "dance", 15);
      }},

    // --- Write some music ---
    { delay: 5, description: "write drums slot",
      action: async () => {
        await clearPresence(melody);
        await writeSlot(melody, 1, 's("bd sd:2 [~ bd] sd").bank("RolandTR808")');
      }},
    { delay: 3, description: "write melody slot",
      action: async () => {
        await writeSlot(melody, 4, 'note("c4 e4 g4 b4").s("sawtooth").lpf(1200).decay(0.3)');
      }},

    // --- Place a spatial instrument ---
    { delay: 3, description: "place cello near parcel",
      action: async () => {
        await placeMusic(melody, "cello", 'note("c3 e3 g3 c4").slow(4)', cx + 3, cz + 3);
      }},

    // --- Say hi ---
    { delay: 2, description: "chat",
      action: async () => {
        await sendMessage(melody, "Just laid down a nice groove! Anyone want to jam?");
      }},

    // --- Start a music session ---
    { delay: 4, description: "start jam session",
      action: async () => {
        await startSession(melody, "music", "Melody's Late Night Jam", {
          pattern: 'note("c3 e3 g3 b3").s("synth").slow(2)',
        });
      }},

    // --- Headbob while waiting for others ---
    { delay: 3, description: "headbob",
      action: async () => {
        await setPresence(melody, "headbob", 20);
      }},

    // --- Walk home ---
    { delay: 10, description: "walk home",
      action: async () => {
        await clearPresence(melody);
        await leaveSession(melody);
        await goHome(melody);
      }},
    { delay: 8, description: "rest at home",
      action: async () => {
        await waitForArrival(melody, 10000);
        await setPresence(melody, "rest", 10);
      }},
    { delay: 12, description: "stretch + wander",
      action: async () => {
        await clearPresence(melody);
        await setPresence(melody, "stretch", 5);
      }},
    { delay: 6, description: "wander near parcel",
      action: async () => {
        await clearPresence(melody);
        await moveTo(melody, cx + rand(-8, 8), cz + rand(-8, 8), "wandering near home");
      }},
    { delay: 6, description: "idle before looping",
      action: async () => {
        await waitForArrival(melody, 8000);
      }},
  ];
}

function pixelBeats(pixel: Agent, melody: Agent, _groove: Agent): Beat[] {
  const cx = pixel.parcelCenter.x;
  const cz = pixel.parcelCenter.z;
  let buildCycle = 0;

  const SKY_COLORS = ["#2a1b4e", "#1a3b5c", "#4a1b2e", "#0d2b3e", "#3b1a4e", "#1e3a2e"];
  const BUILDS: Record<string, unknown>[] = [
    { // Glass tower
      voxels: [
        { block: "glass", x: Math.round(cx), y: 0, z: Math.round(cz) },
        { block: "glass", x: Math.round(cx), y: 1, z: Math.round(cz) },
        { block: "glass", x: Math.round(cx), y: 2, z: Math.round(cz) },
        { block: "glow", x: Math.round(cx), y: 3, z: Math.round(cz) },
      ],
      catalog_items: [
        { item: "flower", pos: [cx + 2, 0, cz + 2] },
        { item: "flower", pos: [cx - 2, 0, cz - 2] },
      ],
    },
    { // Stone arch
      voxels: [
        { block: "stone", x: Math.round(cx - 2), y: 0, z: Math.round(cz) },
        { block: "stone", x: Math.round(cx - 2), y: 1, z: Math.round(cz) },
        { block: "stone", x: Math.round(cx - 2), y: 2, z: Math.round(cz) },
        { block: "stone", x: Math.round(cx + 2), y: 0, z: Math.round(cz) },
        { block: "stone", x: Math.round(cx + 2), y: 1, z: Math.round(cz) },
        { block: "stone", x: Math.round(cx + 2), y: 2, z: Math.round(cz) },
        { block: "marble", x: Math.round(cx - 1), y: 3, z: Math.round(cz) },
        { block: "marble", x: Math.round(cx), y: 3, z: Math.round(cz) },
        { block: "marble", x: Math.round(cx + 1), y: 3, z: Math.round(cz) },
      ],
      catalog_items: [
        { item: "torch", pos: [cx - 2, 3, cz] },
        { item: "torch", pos: [cx + 2, 3, cz] },
      ],
    },
    { // Garden
      voxels: [
        { block: "grass", x: Math.round(cx - 1), y: 0, z: Math.round(cz - 1) },
        { block: "grass", x: Math.round(cx), y: 0, z: Math.round(cz - 1) },
        { block: "grass", x: Math.round(cx + 1), y: 0, z: Math.round(cz - 1) },
        { block: "grass", x: Math.round(cx - 1), y: 0, z: Math.round(cz) },
        { block: "grass", x: Math.round(cx), y: 0, z: Math.round(cz) },
        { block: "grass", x: Math.round(cx + 1), y: 0, z: Math.round(cz) },
      ],
      catalog_items: [
        { item: "tree_oak", pos: [cx - 3, 0, cz] },
        { item: "bush", pos: [cx + 3, 0, cz + 1] },
        { item: "flower", pos: [cx + 1, 0, cz + 2] },
        { item: "rock_small", pos: [cx - 1, 0, cz + 2] },
        { item: "mushroom", pos: [cx + 2, 0, cz - 1] },
      ],
    },
  ];

  return [
    // --- Build on parcel ---
    { delay: 3, description: "build on parcel",
      action: async () => {
        const build = BUILDS[buildCycle % BUILDS.length]!;
        const sky = SKY_COLORS[buildCycle % SKY_COLORS.length]!;
        await buildWorld(pixel, { ...build, sky });
        buildCycle++;
      }},

    // --- Admire the work ---
    { delay: 2, description: "admire the work",
      action: async () => {
        await setPresence(pixel, "spectate_screen", 8);
      }},

    // --- Walk to town square ---
    { delay: 10, description: "walk to town square",
      action: async () => {
        await clearPresence(pixel);
        await moveTo(pixel, rand(-5, 5), rand(-5, 5), "visiting town square");
      }},
    { delay: 10, description: "look around",
      action: async () => {
        await waitForArrival(pixel, 15000);
        await setPresence(pixel, "wander", 10);
      }},

    // --- Start a visual session ---
    { delay: 8, description: "start visual session",
      action: async () => {
        await clearPresence(pixel);
        await startSession(pixel, "visual", "Pixel's Gallery", {
          output: {
            elements: [
              { type: "rect", x: 20, y: 20, width: 360, height: 260, fill: "#1a1a2e" },
              { type: "circle", cx: 200, cy: 150, r: 60, fill: pick(SKY_COLORS) },
              { type: "rect", x: 80, y: 200, width: 240, height: 4, fill: "#666" },
            ],
          },
        });
      }},

    // --- Chat ---
    { delay: 4, description: "chat about art",
      action: async () => {
        await sendMessage(pixel, pick([
          "Changed the sky! How do you like the new vibe?",
          "Just built a new structure on my parcel. Come check it out!",
          "The glow blocks look amazing with the new sky color!",
          "Working on my gallery session. Submissions welcome!",
        ]));
      }},

    // --- Walk home ---
    { delay: 5, description: "walk home",
      action: async () => {
        await leaveSession(pixel);
        await goHome(pixel);
      }},
    { delay: 10, description: "chill at home",
      action: async () => {
        await waitForArrival(pixel, 15000);
        await setPresence(pixel, "rest", 8);
      }},
    { delay: 10, description: "ready for next cycle",
      action: async () => {
        await clearPresence(pixel);
      }},
  ];
}

function grooveBeats(groove: Agent, melody: Agent, pixel: Agent): Beat[] {
  const cx = groove.parcelCenter.x;
  const cz = groove.parcelCenter.z;
  const presenceStates = ["dance", "headbob", "cheer", "celebrate", "taunt", "stretch"];
  let msgCycle = 0;

  const greetings = [
    "Hey hey! What's everybody up to?",
    "The vibes are IMMACULATE right now!",
    "Who wants to collab on something?",
    "This beat is fire! Keep it going!",
    "Love what's happening here. Let's gooo!",
    "Just passing through. Looking for the party!",
  ];

  return [
    // --- Build a dance floor ---
    { delay: 2, description: "build dance floor",
      action: async () => {
        await buildWorld(groove, {
          voxels: [
            { block: "marble", x: Math.round(cx - 1), y: 0, z: Math.round(cz - 1) },
            { block: "marble", x: Math.round(cx), y: 0, z: Math.round(cz - 1) },
            { block: "marble", x: Math.round(cx + 1), y: 0, z: Math.round(cz - 1) },
            { block: "marble", x: Math.round(cx - 1), y: 0, z: Math.round(cz) },
            { block: "lava", x: Math.round(cx), y: 0, z: Math.round(cz) },
            { block: "marble", x: Math.round(cx + 1), y: 0, z: Math.round(cz) },
            { block: "marble", x: Math.round(cx - 1), y: 0, z: Math.round(cz + 1) },
            { block: "marble", x: Math.round(cx), y: 0, z: Math.round(cz + 1) },
            { block: "marble", x: Math.round(cx + 1), y: 0, z: Math.round(cz + 1) },
          ],
          catalog_items: [
            { item: "lamppost", pos: [cx - 3, 0, cz - 3] },
            { item: "lamppost", pos: [cx + 3, 0, cz + 3] },
          ],
        });
      }},

    // --- Walk to town square ---
    { delay: 3, description: "head to town square",
      action: async () => {
        await moveTo(groove, rand(-6, 6), rand(-6, 6), "looking for the party");
      }},
    { delay: 8, description: "arrive and greet",
      action: async () => {
        await waitForArrival(groove, 12000);
        await sendMessage(groove, greetings[msgCycle % greetings.length]!);
        msgCycle++;
      }},

    // --- Dance ---
    { delay: 2, description: "dance at square",
      action: async () => {
        const state = pick(presenceStates);
        await setPresence(groove, state, 12);
      }},

    // --- Place a beat ---
    { delay: 6, description: "drop a beat",
      action: async () => {
        await clearPresence(groove);
        await placeMusic(groove, "808",
          pick([
            'n("0 3 7 10").s("808")',
            's("bd*4").bank("RolandTR808")',
            'n("0 ~ 7 ~").s("808").fast(2)',
            's("hh*8").gain(0.4)',
          ]),
          rand(-5, 5), rand(-5, 5)
        );
      }},

    // --- Visit Melody's parcel ---
    { delay: 3, description: "visit Melody",
      action: async () => {
        await moveTo(groove, melody.parcelCenter.x + rand(-3, 3), melody.parcelCenter.z + rand(-3, 3),
          "visiting Melody's parcel");
      }},
    { delay: 8, description: "cheer for Melody",
      action: async () => {
        await waitForArrival(groove, 12000);
        await setPresence(groove, "cheer", 8);
        await sendMessage(groove, "Nice stage, Melody!", melody.name);
      }},

    // --- Visit Pixel's parcel ---
    { delay: 6, description: "visit Pixel",
      action: async () => {
        await clearPresence(groove);
        await moveTo(groove, pixel.parcelCenter.x + rand(-3, 3), pixel.parcelCenter.z + rand(-3, 3),
          "visiting Pixel's parcel");
      }},
    { delay: 8, description: "admire Pixel's work",
      action: async () => {
        await waitForArrival(groove, 12000);
        await setPresence(groove, "celebrate", 8);
        await sendMessage(groove, "Love the builds, Pixel!", pixel.name);
      }},

    // --- Try joining any active sessions ---
    { delay: 5, description: "look for sessions",
      action: async () => {
        await clearPresence(groove);
        const sessRes = await api("GET", "/sessions");
        const sessions = sessRes.data?.sessions || sessRes.data || [];
        const joinable = sessions.filter((s: any) =>
          s.creatorAgentId !== groove.id &&
          !s.participants?.some((p: any) => p.agentId === groove.id)
        );
        if (joinable.length > 0) {
          const sess = pick(joinable);
          const content: Record<string, unknown> = {};
          if (sess.type === "music") content.pattern = 's("hh*4").gain(0.3)';
          else if (sess.type === "visual") content.output = { elements: [{ type: "circle", cx: 100, cy: 100, r: 30, fill: "#ffcc00" }] };
          await joinSession(groove, sess.id, content);
          log(groove.label, `found a ${sess.type} session to join!`);
        } else {
          log(groove.label, `${COLORS.dim}no sessions to join right now${COLORS.reset}`);
        }
      }},

    // --- Head home ---
    { delay: 5, description: "head home",
      action: async () => {
        await leaveSession(groove);
        await goHome(groove);
      }},
    { delay: 8, description: "dance at home",
      action: async () => {
        await waitForArrival(groove, 12000);
        await setPresence(groove, "dance", 15);
      }},
    { delay: 12, description: "rest before next round",
      action: async () => {
        await clearPresence(groove);
        await setPresence(groove, "rest", 8);
      }},
    { delay: 10, description: "ready for next cycle",
      action: async () => {
        await clearPresence(groove);
      }},
  ];
}

// ─── Beat Runner ─────────────────────────────────────────────────────

async function runBeats(agent: Agent, beats: Beat[]) {
  let cycle = 0;
  while (!stopping) {
    cycle++;
    log(agent.label, `${COLORS.bold}─── cycle ${cycle} ───${COLORS.reset}`);

    for (const beat of beats) {
      if (stopping) break;

      // Wait the delay (in 1s chunks so we can respond to Ctrl+C)
      let waited = 0;
      while (!stopping && waited < beat.delay) {
        await sleep(1000);
        waited++;
      }
      if (stopping) break;

      try {
        await beat.action([agent]); // agents array not used here but keeps signature flexible
      } catch (err) {
        log(agent.label, `${COLORS.red}error in "${beat.description}": ${err}${COLORS.reset}`);
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`
${COLORS.bold}╔══════════════════════════════════════════════════════════════════╗
║  SYNTHMOB — Living Demo                                          ║
║  3 agents wandering the world. Watch in your browser!            ║
║  API: ${API.padEnd(57)} ║
║  Press Ctrl+C to stop.                                           ║
╚══════════════════════════════════════════════════════════════════╝${COLORS.reset}
`);

  // Check server
  const healthRes = await api("GET", "/context");
  if (healthRes.status !== 200) {
    console.error(`${COLORS.red}Server not reachable at ${API}${COLORS.reset}`);
    process.exit(1);
  }
  log("(sys)", `server OK — bpm=${healthRes.data?.bpm} key=${healthRes.data?.key} scale=${healthRes.data?.scale}`);

  // Register
  log("(sys)", "registering agents...");
  const melody = await register("Melody");
  const pixel = await register("Pixel");
  const groove = await register("Groove");

  // Spawn all (uses SPAWN_AT — not visible to client yet)
  log("(sys)", "spawning at parcels...");
  await spawn(melody);
  await spawn(pixel);
  await spawn(groove);

  // Initial MOVE_TO to make agents visible in the client
  // (client creates avatar on first wayfinding_move event)
  log("(sys)", "initial movement to make agents visible in client...");
  await moveTo(melody, melody.parcelCenter.x + 2, melody.parcelCenter.z + 2, "waking up");
  await moveTo(pixel, pixel.parcelCenter.x - 2, pixel.parcelCenter.z + 2, "looking around");
  await moveTo(groove, groove.parcelCenter.x + 2, groove.parcelCenter.z - 2, "stretching");

  await sleep(3000); // Let initial movement happen

  // Build scripted beat sequences
  const melodyScript = melodyBeats(melody, pixel, groove);
  const pixelScript = pixelBeats(pixel, melody, groove);
  const grooveScript = grooveBeats(groove, melody, pixel);

  log("(sys)", `${COLORS.green}${COLORS.bold}agents are live!${COLORS.reset} ${COLORS.dim}Open the client to watch.${COLORS.reset}`);
  console.log(`${COLORS.dim}  Melody: ${melodyScript.length} beats/cycle — music, dancing, jamming${COLORS.reset}`);
  console.log(`${COLORS.dim}  Pixel:  ${pixelScript.length} beats/cycle — building, sky changes, art${COLORS.reset}`);
  console.log(`${COLORS.dim}  Groove: ${grooveScript.length} beats/cycle — wandering, chatting, joining${COLORS.reset}\n`);

  // Run all three concurrently
  await Promise.all([
    runBeats(melody, melodyScript),
    runBeats(pixel, pixelScript),
    runBeats(groove, grooveScript),
  ]);

  // Cleanup
  log("(sys)", "cleaning up placements...");
  for (const agent of [melody, pixel, groove]) {
    for (const id of agent.placementIds) {
      await api("DELETE", `/music/placement/${id}`, undefined, agent.token);
    }
    if (agent.sessionId) {
      await api("POST", "/session/leave", { session_id: agent.sessionId }, agent.token);
    }
  }

  log("(sys)", `${COLORS.green}done!${COLORS.reset}`);
}

main().catch((err) => {
  console.error(`${COLORS.red}FATAL: ${err}${COLORS.reset}`);
  process.exit(1);
});
