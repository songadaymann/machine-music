#!/usr/bin/env bun
// Single test bot -- registers and writes a pattern to a slot
// Usage: bun run test/bot.ts [bot-name] [slot-id]

const API = process.env.API_URL || "http://localhost:4000/api";

// --- Sample patterns by slot type ---
const SAMPLE_PATTERNS: Record<string, string[]> = {
  drums: [
    's("bd [sd cp] bd sd").bank("RolandTR808").gain(".8 .6 .9 .7")',
    's("bd bd sd bd").bank("RolandTR808")',
    's("hh*8").gain(".4 .2 .6 .2 .5 .2 .7 .3")',
    's("bd sd:2 bd [sd cp]").bank("RolandTR909")',
    's("bd(3,8) sd(2,8)").bank("RolandTR808")',
  ],
  bass: [
    'note("<a1 e1 d1 [e1 g1]>").s("sawtooth").lpf(400).decay(0.4)',
    'note("a1 ~ e1 ~").s("sawtooth").lpf(300).gain(0.7)',
    'note("<c2 g1 a1 e1>").s("square").lpf(500).decay(0.3)',
    'note("a1 a1 e1 [d1 e1]").s("sawtooth").lpf(350)',
  ],
  chords: [
    'note("<[g3 c4 e4] [c4 f4 a4] [b3 d4 f4] [e4 g4 b4]>").s("piano").gain(0.5).room(0.3)',
    'note("<[a3 c4 e4] [e3 g3 b3] [c4 f4 a4] [e3 g3 b3]>").s("piano").gain(0.5).room(0.3)',
    'note("<[a3 c4 e4] [d3 f3 a3] [e3 g3 b3] [d3 f3 a3]>").s("piano").gain(0.6)',
    'note("<[c4 e4 a4] [d4 g4 a4]>").s("piano").room(0.3)',
  ],
  melody: [
    'note("a4 [c5 e5] ~ a4 g4 ~ [e4 d4] ~").s("triangle").delay(0.2).room(0.3)',
    'note("e5 d5 c5 a4").s("triangle").delay(0.3)',
    'note("a4 c5 d5 e5 ~ d5 c5 ~").s("sawtooth").lpf(800)',
    'note("<a5 e5 d5 c5>").s("triangle").room(0.4).gain(0.5)',
  ],
  wild: [
    's("~ arpy ~ arpy:3").note("e4 ~ a4 ~").room(0.5).gain(0.3)',
    'note("a4 e4").s("arpy").speed("<1 2 0.5 1.5>").room(0.3)',
    's("jazz:3 ~ jazz:1 ~").gain(0.4).room(0.5)',
    'note("c4 ~ e4 g4").s("square").delay(0.4).lpf(600)',
  ],
};

// Slot types in order
const SLOT_TYPES = ["drums", "drums", "bass", "chords", "chords", "melody", "melody", "wild"];

// --- Helpers ---

async function api(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  return { status: res.status, data };
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function log(msg: string) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${time}] ${msg}`);
}

// --- Main ---

async function main() {
  const botName = process.argv[2] || `test-bot-${Math.floor(Math.random() * 1000)}`;
  const targetSlot = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;

  log(`Starting bot: ${botName}`);

  // 1. Register
  log("Registering...");
  const regResult = await api("POST", "/agents", { name: botName });
  if (regResult.status !== 201) {
    console.error("Registration failed:", regResult.data);
    process.exit(1);
  }
  const { token, id } = regResult.data;
  log(`Registered as ${botName} (id: ${id.slice(0, 8)}...)`);

  // 2. Read composition
  log("Reading composition...");
  const compResult = await api("GET", "/composition");
  const comp = compResult.data;
  log(`Epoch #${comp.epoch} | BPM: ${comp.bpm} | Key: ${comp.key}`);

  // 3. Pick a slot
  let slotId: number;
  if (targetSlot) {
    slotId = targetSlot;
  } else {
    // Prefer empty slots, otherwise random
    const emptySlots = comp.slots.filter((s: { code: string | null }) => !s.code);
    if (emptySlots.length > 0) {
      slotId = pick(emptySlots).id;
    } else {
      slotId = Math.floor(Math.random() * 8) + 1;
    }
  }

  const slotType = SLOT_TYPES[slotId - 1];
  log(`Target: slot ${slotId} (${slotType.toUpperCase()})`);

  // 4. Pick a pattern
  const pattern = pick(SAMPLE_PATTERNS[slotType]);
  log(`Pattern: ${pattern}`);

  // 5. Write to slot
  log("Writing to slot...");
  const writeResult = await api("POST", `/slot/${slotId}`, { code: pattern }, token);
  if (writeResult.status === 200) {
    log(`Claimed slot ${slotId}!`);
    if (writeResult.data.warnings?.length > 0) {
      log(`Warnings: ${writeResult.data.warnings.join(", ")}`);
    }
  } else {
    console.error("Write failed:", writeResult.data);
  }

  // 6. Check status
  const statusResult = await api("GET", "/agents/status", undefined, token);
  log(`Status: slots held = [${statusResult.data.slots_held}], placements = ${statusResult.data.total_placements}`);

  log("Done.");
}

main().catch(console.error);
