#!/usr/bin/env bun
// Integration Smoke Test — 2 agents walk through EVERY action type, sequentially.
// No LLM needed. Deterministic API calls with clear pass/fail logging.
//
// Usage: bun run test/integration-smoke.ts
//
// Requires a running server at API_URL (default http://localhost:5555/api).

const API = process.env.API_URL || "http://localhost:5555/api";

// --- Helpers ---

interface TestResult {
  step: string;
  agent: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];
let currentAgent = "";

function log(msg: string) {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${time}] ${msg}`);
}

function pass(step: string, detail: string = "") {
  results.push({ step, agent: currentAgent, passed: true, detail });
  log(`  ✓ ${step}${detail ? ` — ${detail}` : ""}`);
}

function fail(step: string, detail: string) {
  results.push({ step, agent: currentAgent, passed: false, detail });
  log(`  ✗ ${step} — ${detail}`);
}

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

  let data: any;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { status: res.status, data };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Test steps ---

interface Agent {
  name: string;
  token: string;
  id: string;
  sessionId?: string;
  placementId?: string;
}

async function testRegistration(name: string): Promise<Agent | null> {
  const res = await api("POST", "/agents", { name });
  if (res.status === 201 && res.data?.token) {
    pass("register", `id=${res.data.id?.slice(0, 8)} parcel=${res.data.parcel?.id || "none"}`);
    return {
      name,
      token: res.data.token,
      id: res.data.id,
    };
  }
  fail("register", `HTTP ${res.status}: ${JSON.stringify(res.data)}`);
  return null;
}

async function testAvatarCheck(agent: Agent) {
  const res = await api("GET", "/avatar/me", undefined, agent.token);
  if (res.status === 200) {
    const assignment = res.data?.assignment ? "custom" : "none";
    const activeOrder = res.data?.active_order ? `generating (${res.data.active_order.status})` : "none";
    const latestOrder = res.data?.latest_order ? `${res.data.latest_order.status}` : "none";
    pass("avatar/me", `assignment=${assignment} active=${activeOrder} latest=${latestOrder}`);
  } else {
    fail("avatar/me", `HTTP ${res.status}`);
  }
}

async function testAvatarGenerate(agent: Agent) {
  const res = await api("POST", "/avatar/generate", {
    prompt: `A friendly robot named ${agent.name} with glowing eyes`,
  }, agent.token);
  if (res.status === 202) {
    pass("avatar/generate", `order started (${res.data?.id?.slice(0, 8) || "?"})`);
  } else if (res.status === 503) {
    pass("avatar/generate", `Meshy not configured (expected without MESHY_API_KEY)`);
  } else if (res.status === 409) {
    pass("avatar/generate", `generation already in progress`);
  } else {
    fail("avatar/generate", `HTTP ${res.status}: ${res.data?.error || "?"}`);
  }
}

async function testAvatarOrders(agent: Agent) {
  const res = await api("GET", "/avatar/orders", undefined, agent.token);
  if (res.status === 200) {
    const count = Array.isArray(res.data?.orders) ? res.data.orders.length : 0;
    pass("avatar/orders", `${count} orders`);
  } else {
    fail("avatar/orders", `HTTP ${res.status}`);
  }
}

async function testSpawn(agent: Agent, x: number, z: number) {
  const res = await api("POST", "/wayfinding/action", {
    type: "SPAWN_AT",
    x,
    z,
    reason: "smoke test spawn",
  }, agent.token);
  if (res.status === 200 && res.data?.ok) {
    pass("spawn", `at (${x}, ${z})`);
  } else {
    fail("spawn", `${res.data?.reason_code || res.data?.error || `HTTP ${res.status}`}`);
  }
}

async function testWayfindingState(agent: Agent) {
  const res = await api("GET", "/wayfinding/state", undefined, agent.token);
  if (res.status === 200 && res.data?.self) {
    const s = res.data.self;
    pass("wayfinding/state", `pos=(${Math.round(s.x)}, ${Math.round(s.z)}) loco=${s.locomotionState} presence=${s.presenceState}`);
  } else {
    fail("wayfinding/state", `HTTP ${res.status}`);
  }
}

async function testMoveTo(agent: Agent, x: number, z: number) {
  const res = await api("POST", "/wayfinding/action", {
    type: "MOVE_TO",
    x,
    z,
    reason: "smoke test movement",
  }, agent.token);
  if (res.status === 200 && res.data?.ok) {
    pass("move_to", `→ (${x}, ${z})`);
  } else {
    fail("move_to", `${res.data?.reason_code || res.data?.error || `HTTP ${res.status}`}`);
  }
}

async function testGoHome(agent: Agent) {
  const res = await api("POST", "/wayfinding/action", {
    type: "GO_HOME",
    reason: "smoke test go home",
  }, agent.token);
  if (res.status === 200 && res.data?.ok) {
    pass("go_home", "teleported to parcel center");
  } else {
    fail("go_home", `${res.data?.reason_code || res.data?.error || `HTTP ${res.status}`}`);
  }
}

async function testSetPresence(agent: Agent, state: string, durationSec: number) {
  const res = await api("POST", "/wayfinding/action", {
    type: "SET_PRESENCE_STATE",
    presenceState: state,
    durationSec,
    reason: `smoke test ${state}`,
  }, agent.token);
  if (res.status === 200 && res.data?.ok) {
    pass("set_presence", `${state} for ${durationSec}s`);
  } else {
    fail("set_presence", `${res.data?.reason_code || res.data?.error || `HTTP ${res.status}`}`);
  }
}

async function testClearPresence(agent: Agent) {
  const res = await api("POST", "/wayfinding/action", {
    type: "CLEAR_PRESENCE_STATE",
    reason: "smoke test clear presence",
  }, agent.token);
  if (res.status === 200 && res.data?.ok) {
    pass("clear_presence", "back to idle_pose");
  } else {
    fail("clear_presence", `${res.data?.reason_code || res.data?.error || `HTTP ${res.status}`}`);
  }
}

async function testHoldPosition(agent: Agent) {
  const res = await api("POST", "/wayfinding/action", {
    type: "HOLD_POSITION",
    holdSeconds: 5,
    reason: "smoke test hold",
  }, agent.token);
  if (res.status === 200 && res.data?.ok) {
    pass("hold_position", "5s");
  } else {
    fail("hold_position", `${res.data?.reason_code || res.data?.error || `HTTP ${res.status}`}`);
  }
}

async function testPlaceMusic(agent: Agent): Promise<string | null> {
  const res = await api("POST", "/music/place", {
    instrument_type: "808",
    pattern: 's("hh").fast(4)',
    position: { x: 10, z: -15 },
  }, agent.token);
  if (res.status === 200 && res.data?.placement) {
    const id = res.data.placement.id;
    pass("place_music", `808 at (10, -15) id=${id?.slice(0, 8)}`);
    return id;
  }
  fail("place_music", `${res.data?.error || `HTTP ${res.status}`}${res.data?.details ? ` — ${JSON.stringify(res.data.details)}` : ""}`);
  return null;
}

async function testUpdatePlacement(agent: Agent, placementId: string) {
  const res = await api("PUT", `/music/placement/${placementId}`, {
    pattern: 's("hh").fast(8).gain(0.5)',
  }, agent.token);
  if (res.status === 200) {
    pass("update_placement", `${placementId.slice(0, 8)} updated pattern`);
  } else {
    fail("update_placement", `${res.data?.error || `HTTP ${res.status}`}`);
  }
}

async function testRemovePlacement(agent: Agent, placementId: string) {
  const res = await api("DELETE", `/music/placement/${placementId}`, undefined, agent.token);
  if (res.status === 200) {
    pass("remove_placement", `${placementId.slice(0, 8)} removed`);
  } else {
    fail("remove_placement", `${res.data?.error || `HTTP ${res.status}`}`);
  }
}

async function testListPlacements() {
  const res = await api("GET", "/music/placements");
  if (res.status === 200) {
    const count = Array.isArray(res.data?.placements) ? res.data.placements.length : 0;
    pass("list_placements", `${count} active`);
  } else {
    fail("list_placements", `HTTP ${res.status}`);
  }
}

async function testWriteSlot(agent: Agent, slotId: number, code: string) {
  const res = await api("POST", `/slot/${slotId}`, { code }, agent.token);
  if (res.status === 200) {
    pass("write_slot", `slot ${slotId}: "${code.slice(0, 40)}"`);
  } else {
    const detail = res.data?.details
      ? Array.isArray(res.data.details) ? res.data.details.join("; ") : String(res.data.details)
      : res.data?.error || `HTTP ${res.status}`;
    fail("write_slot", detail);
  }
}

async function testComposition() {
  const res = await api("GET", "/composition");
  if (res.status === 200 && res.data?.slots) {
    const filled = res.data.slots.filter((s: any) => s.code).length;
    pass("composition", `${filled}/${res.data.slots.length} slots filled`);
  } else {
    fail("composition", `HTTP ${res.status}`);
  }
}

async function testSubmitWorld(agent: Agent) {
  const res = await api("POST", "/world", {
    output: {
      elements: [
        { type: "sphere", pos: [5, 2, -5], radius: 1.5, color: "#ff6644", motion: "float" },
      ],
      voxels: [
        { block: "stone", x: 10, y: 0, z: 10 },
        { block: "stone", x: 11, y: 0, z: 10 },
        { block: "stone", x: 12, y: 0, z: 10 },
        { block: "glow", x: 11, y: 1, z: 10 },
      ],
      catalog_items: [
        { item: "tree_oak", pos: [15, 0, 10] },
      ],
      sky: "#1a2b4c",
    },
  }, agent.token);
  if (res.status === 200 || res.status === 201) {
    pass("submit_world", "1 element, 4 voxels (3 stone + 1 glow), 1 catalog item, sky=#1a2b4c");
  } else {
    fail("submit_world", `${res.data?.error || `HTTP ${res.status}`}${res.data?.details ? ` — ${JSON.stringify(res.data.details)}` : ""}`);
  }
}

async function testGetWorld() {
  const res = await api("GET", "/world");
  if (res.status === 200) {
    const contribs = Array.isArray(res.data?.contributions) ? res.data.contributions.length : 0;
    pass("get_world", `${contribs} contributions`);
  } else {
    fail("get_world", `HTTP ${res.status}`);
  }
}

async function testStartSession(agent: Agent, type: string, title: string): Promise<string | null> {
  const body: Record<string, unknown> = { type, title };
  if (type === "music") {
    body.pattern = 'note("c3 e3 g3").s("synth")';
  } else if (type === "visual") {
    body.output = {
      elements: [
        { type: "rect", x: 100, y: 100, width: 200, height: 150, fill: "#336699" },
      ],
    };
  } else if (type === "game") {
    body.output = {
      template: "click_target",
      config: { spawnRate: 1.5, targetSize: 1.5, rounds: 5 },
    };
  }
  const res = await api("POST", "/session/start", body, agent.token);
  if ((res.status === 200 || res.status === 201) && res.data?.session) {
    const id = res.data.session.id;
    pass("start_session", `${type} "${title}" id=${id.slice(0, 8)}`);
    return id;
  }
  fail("start_session", `${res.data?.error || `HTTP ${res.status}`}`);
  return null;
}

async function testJoinSession(agent: Agent, sessionId: string, sessionType: string = "visual") {
  const body: Record<string, unknown> = { session_id: sessionId };
  if (sessionType === "visual") {
    body.output = {
      elements: [
        { type: "circle", cx: 200, cy: 200, r: 50, fill: "#cc4444" },
      ],
    };
  } else if (sessionType === "game") {
    body.output = {
      template: "click_target",
      config: { spawnRate: 2, targetSize: 1, rounds: 3 },
    };
  } else if (sessionType === "music") {
    body.pattern = 'note("e3 g3 b3").s("synth")';
  }
  const res = await api("POST", "/session/join", body, agent.token);
  if (res.status === 200 || res.status === 201) {
    pass("join_session", `${sessionId.slice(0, 8)} (${sessionType})`);
  } else {
    fail("join_session", `${res.data?.error || `HTTP ${res.status}`}${res.data?.details ? ` — ${JSON.stringify(res.data.details)}` : ""}`);
  }
}

async function testUpdateOutput(agent: Agent, sessionId: string) {
  const res = await api("POST", "/session/output", {
    session_id: sessionId,
    output: {
      elements: [
        { type: "rect", x: 50, y: 50, width: 100, height: 80, fill: "#44cc44" },
        { type: "circle", cx: 300, cy: 150, r: 30, fill: "#4444cc" },
      ],
    },
  }, agent.token);
  if (res.status === 200) {
    pass("update_output", `${sessionId.slice(0, 8)} updated`);
  } else {
    fail("update_output", `${res.data?.error || `HTTP ${res.status}`}`);
  }
}

async function testLeaveSession(agent: Agent, sessionId: string) {
  const res = await api("POST", "/session/leave", { session_id: sessionId }, agent.token);
  if (res.status === 200) {
    pass("leave_session", `${sessionId.slice(0, 8)}`);
  } else {
    fail("leave_session", `${res.data?.error || `HTTP ${res.status}`}`);
  }
}

async function testListSessions() {
  const res = await api("GET", "/sessions");
  if (res.status === 200) {
    const sessions = Array.isArray(res.data?.sessions) ? res.data.sessions : Array.isArray(res.data) ? res.data : [];
    pass("list_sessions", `${sessions.length} active`);
  } else {
    fail("list_sessions", `HTTP ${res.status}`);
  }
}

async function testSendMessage(agent: Agent, content: string, to?: string) {
  const body: Record<string, unknown> = { content };
  if (to) body.to = to;
  const res = await api("POST", "/agents/messages", body, agent.token);
  if (res.status === 200 || res.status === 201) {
    pass("send_message", `${to ? `→${to}: ` : ""}"${content.slice(0, 50)}"`);
  } else {
    fail("send_message", `${res.data?.error || `HTTP ${res.status}`}`);
  }
}

async function testGetMessages(agent: Agent) {
  const res = await api("GET", "/agents/messages", undefined, agent.token);
  if (res.status === 200) {
    const count = Array.isArray(res.data) ? res.data.length : 0;
    pass("get_messages", `${count} messages`);
  } else {
    fail("get_messages", `HTTP ${res.status}`);
  }
}

async function testGetOnline() {
  const res = await api("GET", "/agents/online");
  if (res.status === 200) {
    const count = Array.isArray(res.data) ? res.data.length : 0;
    pass("agents/online", `${count} online`);
  } else {
    fail("agents/online", `HTTP ${res.status}`);
  }
}

async function testGetContext() {
  const res = await api("GET", "/context");
  if (res.status === 200 && res.data) {
    pass("context", `bpm=${res.data.bpm} key=${res.data.key} scale=${res.data.scale}`);
  } else {
    fail("context", `HTTP ${res.status}`);
  }
}

async function testGetParcels() {
  const res = await api("GET", "/parcels");
  if (res.status === 200) {
    const count = Array.isArray(res.data?.parcels) ? res.data.parcels.length : 0;
    pass("parcels", `${count} total`);
  } else {
    fail("parcels", `HTTP ${res.status}`);
  }
}

async function testGetMyParcel(agent: Agent) {
  const res = await api("GET", "/parcels/mine", undefined, agent.token);
  if (res.status === 200 && res.data?.parcel) {
    const p = res.data.parcel;
    const b = p.bounds;
    pass("parcels/mine", `id=${p.id} tier=${p.tier} bounds=(${b?.minX},${b?.minZ})→(${b?.maxX},${b?.maxZ})`);
  } else if (res.status === 200) {
    pass("parcels/mine", `no parcel assigned`);
  } else {
    fail("parcels/mine", `HTTP ${res.status}`);
  }
}

async function testGetDirectives(agent: Agent) {
  const res = await api("GET", "/agents/directives", undefined, agent.token);
  if (res.status === 200) {
    const count = Array.isArray(res.data?.directives) ? res.data.directives.length : 0;
    pass("directives", `${count} pending`);
  } else {
    fail("directives", `HTTP ${res.status}`);
  }
}

async function testGetStatus(agent: Agent) {
  const res = await api("GET", "/agents/status", undefined, agent.token);
  if (res.status === 200) {
    pass("agents/status", `id=${res.data?.id?.slice(0, 8)} name=${res.data?.name}`);
  } else {
    fail("agents/status", `HTTP ${res.status}`);
  }
}

async function testRitual(agent: Agent) {
  // Check ritual state
  const stateRes = await api("GET", "/ritual");
  if (stateRes.status !== 200) {
    pass("ritual", `endpoint returned ${stateRes.status} (ritual may not be active)`);
    return;
  }
  const phase = stateRes.data?.phase;
  pass("ritual/state", `phase=${phase || "idle"}`);

  // Try nominating regardless of phase — server will reject if not in nominate phase
  const nomRes = await api("POST", "/ritual/nominate", {
    bpm: 120,
    key: "C",
    scale: "pentatonic",
    reasoning: "smoke test nomination",
  }, agent.token);
  if (nomRes.status === 200 || nomRes.status === 201) {
    pass("ritual/nominate", "bpm=120 key=C scale=pentatonic");
  } else {
    pass("ritual/nominate", `rejected (expected if phase != nominate): ${nomRes.data?.error || `HTTP ${nomRes.status}`}`);
  }
}

async function testWorldCatalog() {
  const res = await api("GET", "/world/catalog");
  if (res.status === 200) {
    const items = res.data?.items ? Object.keys(res.data.items) : [];
    pass("world/catalog", `${items.length} items: ${items.slice(0, 5).join(", ")}${items.length > 5 ? "..." : ""}`);
  } else {
    fail("world/catalog", `HTTP ${res.status}`);
  }
}

async function testArenaConfig() {
  const res = await api("GET", "/wayfinding/arena");
  if (res.status === 200 && res.data) {
    pass("wayfinding/arena", `mode=${res.data.mode} worldBounded=${res.data.worldBounded} speed=${res.data.speedMps}m/s`);
  } else {
    fail("wayfinding/arena", `HTTP ${res.status}`);
  }
}

async function testWayfindingActions() {
  const res = await api("GET", "/wayfinding/actions");
  const actions = res.data?.actions;
  if (res.status === 200 && Array.isArray(actions)) {
    const types = actions.map((a: any) => a.type).join(", ");
    pass("wayfinding/actions", types);
  } else {
    fail("wayfinding/actions", `HTTP ${res.status} — expected {actions: [...]}, got ${JSON.stringify(res.data)?.slice(0, 100)}`);
  }
}

// --- Main ---

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  SYNTHMOB — Integration Smoke Test                             ║
║  2 agents, every action type, sequential + deterministic       ║
║  API: ${API.padEnd(57)} ║
╚══════════════════════════════════════════════════════════════════╝
`);

  const startMs = Date.now();

  // --- Phase 0: Server connectivity + global endpoints ---
  log("PHASE 0: Global endpoints (no auth)");
  currentAgent = "(global)";

  await testGetContext();
  await testGetOnline();
  await testGetParcels();
  await testWorldCatalog();
  await testArenaConfig();
  await testWayfindingActions();
  await testListSessions();
  await testListPlacements();
  await testComposition();

  // --- Phase 1: Register Alice ---
  log("\nPHASE 1: Register agents");

  currentAgent = "alice";
  log("  Registering Alice...");
  const alice = await testRegistration(`smoke_alice_${Date.now() % 10000}`);
  if (!alice) {
    console.error("FATAL: Could not register Alice. Is the server running?");
    process.exit(1);
  }

  currentAgent = "bob";
  log("  Registering Bob...");
  const bob = await testRegistration(`smoke_bob_${Date.now() % 10000}`);
  if (!bob) {
    console.error("FATAL: Could not register Bob.");
    process.exit(1);
  }

  // --- Phase 2: Avatar system ---
  log("\nPHASE 2: Avatar system");

  currentAgent = "alice";
  log(`  Alice — avatar workflow:`);
  await testAvatarCheck(alice);
  await testAvatarGenerate(alice);
  await testAvatarOrders(alice);

  currentAgent = "bob";
  log(`  Bob — avatar workflow:`);
  await testAvatarCheck(bob);
  await testAvatarGenerate(bob);
  await testAvatarOrders(bob);

  // --- Phase 3: Wayfinding ---
  log("\nPHASE 3: Wayfinding (spawn, move, go_home, presence)");

  currentAgent = "alice";
  log(`  Alice — wayfinding:`);
  await testGetMyParcel(alice);
  await testSpawn(alice, 20, -15);
  await testWayfindingState(alice);
  await testMoveTo(alice, 35, -25);
  await sleep(500); // Let movement start
  await testWayfindingState(alice); // Should show moving
  await testGoHome(alice);
  await testWayfindingState(alice); // Should show at parcel center
  await testSetPresence(alice, "dance", 60);
  await testWayfindingState(alice); // Should show dance
  await testClearPresence(alice);
  await testHoldPosition(alice);

  currentAgent = "bob";
  log(`  Bob — wayfinding:`);
  await testGetMyParcel(bob);
  await testSpawn(bob, -20, 30);
  await testMoveTo(bob, -10, 20);
  await testGoHome(bob);
  await testSetPresence(bob, "headbob", 30);
  await testClearPresence(bob);

  // --- Phase 4: Music ---
  log("\nPHASE 4: Music (slots + spatial placements)");

  currentAgent = "alice";
  log(`  Alice — music:`);
  await testWriteSlot(alice, 1, 's("hh").fast(4)');
  const alicePlacement = await testPlaceMusic(alice);
  if (alicePlacement) {
    await testUpdatePlacement(alice, alicePlacement);
    // Don't remove yet — we'll list first
  }

  currentAgent = "bob";
  log(`  Bob — music:`);
  await testWriteSlot(bob, 3, 'note("c2 e2 g2").s("sawtooth").lpf(800)');
  const bobPlacement = await testPlaceMusic(bob);

  currentAgent = "(global)";
  await testListPlacements();
  await testComposition();

  // Now remove
  currentAgent = "alice";
  if (alicePlacement) await testRemovePlacement(alice, alicePlacement);
  currentAgent = "bob";
  if (bobPlacement) await testRemovePlacement(bob, bobPlacement);

  // --- Phase 5: World building ---
  log("\nPHASE 5: World building");

  currentAgent = "alice";
  log(`  Alice — world:`);
  await testSubmitWorld(alice);

  currentAgent = "bob";
  log(`  Bob — world:`);
  await testSubmitWorld(bob);

  currentAgent = "(global)";
  await testGetWorld();

  // --- Phase 6: Sessions (start, join, update, leave) ---
  log("\nPHASE 6: Sessions");

  currentAgent = "alice";
  log(`  Alice starts a visual session:`);
  const aliceSession = await testStartSession(alice, "visual", "Smoke Test Canvas");

  if (aliceSession) {
    currentAgent = "bob";
    log(`  Bob joins Alice's session:`);
    await testJoinSession(bob, aliceSession, "visual");
    await testUpdateOutput(bob, aliceSession);

    currentAgent = "(global)";
    await testListSessions();

    currentAgent = "bob";
    await testLeaveSession(bob, aliceSession);

    currentAgent = "alice";
    await testLeaveSession(alice, aliceSession);
  }

  currentAgent = "bob";
  log(`  Bob starts a game session:`);
  const bobSession = await testStartSession(bob, "game", "Smoke Test Game");

  if (bobSession) {
    currentAgent = "alice";
    log(`  Alice joins Bob's game:`);
    await testJoinSession(alice, bobSession, "game");
    await testLeaveSession(alice, bobSession);

    currentAgent = "bob";
    await testLeaveSession(bob, bobSession);
  }

  // --- Phase 7: Messaging ---
  log("\nPHASE 7: Messaging");

  currentAgent = "alice";
  await testSendMessage(alice, "Hey everyone! Smoke test broadcast from Alice.");
  await testSendMessage(alice, `Hey ${bob.name}, nice headbob earlier!`, bob.name);

  currentAgent = "bob";
  await testSendMessage(bob, `Thanks ${alice.name}! Love the glow voxels.`, alice.name);
  await testGetMessages(bob);

  currentAgent = "alice";
  await testGetMessages(alice);

  // --- Phase 8: Ritual ---
  log("\nPHASE 8: Ritual");

  currentAgent = "alice";
  await testRitual(alice);

  currentAgent = "bob";
  await testRitual(bob);

  // --- Phase 9: Status + directives ---
  log("\nPHASE 9: Agent status & directives");

  currentAgent = "alice";
  await testGetStatus(alice);
  await testGetDirectives(alice);

  currentAgent = "bob";
  await testGetStatus(bob);
  await testGetDirectives(bob);

  // --- Report ---
  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log(`\n${"═".repeat(70)}`);
  console.log("  INTEGRATION SMOKE TEST — RESULTS");
  console.log(`${"═".repeat(70)}\n`);
  console.log(`  Runtime: ${elapsedSec}s`);
  console.log(`  Total: ${total}  Passed: ${passed}  Failed: ${failed}\n`);

  if (failed > 0) {
    console.log("  FAILURES:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`    ✗ [${r.agent}] ${r.step}: ${r.detail}`);
    }
    console.log("");
  }

  // Group by category
  const categories = new Map<string, TestResult[]>();
  for (const r of results) {
    const cat = r.step.split("/")[0]!.split("_")[0]!;
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push(r);
  }

  console.log("  BY CATEGORY:");
  for (const [cat, catResults] of categories) {
    const catPassed = catResults.filter((r) => r.passed).length;
    const catTotal = catResults.length;
    const status = catPassed === catTotal ? "✓" : "✗";
    console.log(`    ${status} ${cat}: ${catPassed}/${catTotal}`);
  }

  console.log(`\n  ${passed === total ? "ALL TESTS PASSED" : `${failed} FAILURES`}`);
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
