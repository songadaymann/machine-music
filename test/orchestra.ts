#!/usr/bin/env bun
// Multi-bot orchestra -- simulates several bots competing for slots
// Usage: bun run test/orchestra.ts [num-bots] [rounds]

const API = process.env.API_URL || "http://localhost:4000/api";

// --- Patterns by type ---
const PATTERNS: Record<string, string[]> = {
  drums: [
    's("bd [sd cp] bd sd").bank("RolandTR808").gain(".8 .6 .9 .7")',
    's("bd bd sd bd").bank("RolandTR808")',
    's("hh*8").gain(".4 .2 .6 .2 .5 .2 .7 .3")',
    's("bd sd:2 bd [sd cp]").bank("RolandTR909")',
    's("bd(3,8) sd(2,8)").bank("RolandTR808")',
    's("hh(5,8) bd(3,8,1)").bank("RolandTR808").gain(.7)',
    's("bd ~ sd ~").bank("RolandTR909").speed("1 1.2 1 .8")',
  ],
  bass: [
    'note("<a1 e1 d1 [e1 g1]>").s("sawtooth").lpf(400).decay(.4)',
    'note("a1 ~ e1 ~").s("sawtooth").lpf(300).gain(.7)',
    'note("<c2 g1 a1 e1>").s("square").lpf(500).decay(.3)',
    'note("a1 a1 e1 [d1 e1]").s("sawtooth").lpf(350)',
    'note("a1 [e1 g1] d1 ~").s("sawtooth").lpf(450)',
  ],
  chords: [
    'note("<Am7 Dm7 G7 Cmaj7>").voicings("lefthand").s("piano")',
    'note("<Am Em Dm Em>").voicings("lefthand").s("piano")',
    'note("<a3 [c4,e4] d3 [e3,g3]>").s("piano").gain(.6)',
    'note("<c4,e4,a4 d4,g4,a4>").s("piano").room(.3)',
  ],
  melody: [
    'note("a4 [c5 e5] ~ a4 g4 ~ [e4 d4] ~").s("triangle").delay(.2).room(.3)',
    'note("e5 d5 c5 a4").s("triangle").delay(.3)',
    'note("a4 c5 d5 e5 ~ d5 c5 ~").s("sawtooth").lpf(800)',
    'note("<a5 e5 d5 c5>").s("triangle").room(.4).gain(.5)',
    'note("a4 ~ [c5 e5] ~ g4 ~ e4 ~").s("triangle").room(.2)',
  ],
  wild: [
    's("~ arpy ~ arpy:3").note("e4 ~ a4 ~").room(.5).gain(.3)',
    'note("a4 e4").s("arpy").speed("<1 2 .5 1.5>").room(.3)',
    's("jazz:3 ~ jazz:1 ~").gain(.4).room(.5)',
    'note("c4 ~ e4 g4").s("square").delay(.4).lpf(600)',
  ],
};

const SLOT_TYPES = ["drums", "drums", "bass", "chords", "chords", "melody", "melody", "wild"];

const BOT_NAMES = [
  "alice", "bob", "carol", "dave", "eve", "frank",
  "grace", "henry", "iris", "jack", "kate", "luna",
  "max", "nova", "oscar", "penny", "quinn", "ruby",
];

// --- Helpers ---

async function api(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return { status: res.status, data: await res.json() };
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function log(bot: string, msg: string) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${time}] [${bot}] ${msg}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Bot behavior ---

interface Bot {
  name: string;
  token: string;
  id: string;
}

async function registerBot(name: string): Promise<Bot | null> {
  const res = await api("POST", "/agents", { name });
  if (res.status !== 201) {
    console.error(`Failed to register ${name}:`, res.data);
    return null;
  }
  return { name, token: res.data.token, id: res.data.id };
}

async function botTurn(bot: Bot): Promise<void> {
  // Read composition
  const comp = (await api("GET", "/composition")).data;

  // Strategy: 70% target empty slots, 30% overwrite
  const emptySlots = comp.slots.filter((s: { code: string | null }) => !s.code);
  let slotId: number;

  if (emptySlots.length > 0 && Math.random() < 0.7) {
    slotId = pick(emptySlots).id;
    log(bot.name, `targeting empty slot ${slotId}`);
  } else {
    slotId = Math.floor(Math.random() * 8) + 1;
    log(bot.name, `attempting overwrite on slot ${slotId}`);
  }

  const slotType = SLOT_TYPES[slotId - 1];
  const pattern = pick(PATTERNS[slotType]);

  const res = await api("POST", `/slot/${slotId}`, { code: pattern }, bot.token);
  if (res.status === 200) {
    log(bot.name, `claimed slot ${slotId} (${slotType})`);
  } else if (res.data.error === "cooldown") {
    log(bot.name, `cooldown: retry in ${res.data.retry_after}s`);
  } else {
    log(bot.name, `failed: ${JSON.stringify(res.data)}`);
  }
}

// --- Main ---

async function main() {
  const numBots = parseInt(process.argv[2] || "5", 10);
  const rounds = parseInt(process.argv[3] || "3", 10);

  console.log(`\n=== THE MUSIC PLACE -- Orchestra Test ===`);
  console.log(`Bots: ${numBots} | Rounds: ${rounds}\n`);

  // Register bots
  const bots: Bot[] = [];
  const names = BOT_NAMES.slice(0, numBots).map((n) => `bot_${n}`);
  for (const name of names) {
    const bot = await registerBot(name);
    if (bot) {
      bots.push(bot);
      log(bot.name, "registered");
    }
  }

  if (bots.length === 0) {
    console.error("No bots registered!");
    process.exit(1);
  }

  // Run rounds
  for (let round = 1; round <= rounds; round++) {
    console.log(`\n--- Round ${round} / ${rounds} ---\n`);

    // Shuffle bots for fair ordering
    const shuffled = [...bots].sort(() => Math.random() - 0.5);

    for (const bot of shuffled) {
      await botTurn(bot);
      // Small delay between bots
      await sleep(200);
    }

    // Show composition state
    const comp = (await api("GET", "/composition")).data;
    console.log("\nComposition state:");
    for (const slot of comp.slots) {
      const status = slot.code
        ? `${slot.agent.name} -- ${slot.code.slice(0, 50)}...`
        : "(empty)";
      console.log(`  [${slot.id}] ${slot.type.toUpperCase().padEnd(7)} ${status}`);
    }

    // Wait between rounds (simulated cooldown)
    if (round < rounds) {
      console.log(`\nWaiting 3s before next round...`);
      await sleep(3000);
    }
  }

  // Final leaderboard
  console.log("\n--- Leaderboard ---\n");
  const lb = (await api("GET", "/leaderboard")).data;
  for (const entry of lb) {
    console.log(
      `  ${entry.name.padEnd(15)} slots: ${entry.slots_held}  placements: ${entry.total_placements}`
    );
  }

  console.log("\n=== Orchestra test complete ===\n");
}

main().catch(console.error);
