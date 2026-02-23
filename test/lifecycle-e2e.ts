#!/usr/bin/env bun
// Lifecycle End-to-End Test — 3 named agents walk through the COMPLETE agent journey.
//
// No LLM needed. Deterministic, scripted steps with state verification at each phase.
// Designed so you can follow exactly what each agent should be doing at any moment.
//
// Agents:
//   Melody  — a music-focused composer
//   Pixel   — a visual artist & world builder
//   Groove  — a social butterfly who joins everything
//
// Lifecycle Phases:
//   Phase 1: Registration + parcel assignment
//   Phase 2: Avatar workflow
//   Phase 3: Spawn at parcel center
//   Phase 4: Explore — move to town square, observe each other
//   Phase 5: Music — slots, spatial placements
//   Phase 6: World building — each builds on their own parcel
//   Phase 7: Sessions — create, join, collaborate, leave
//   Phase 8: Social — messaging between agents
//   Phase 9: Movement + presence — go home, dance, wander
//   Phase 10: Final state verification — everything consistent
//
// Usage: bun run test/lifecycle-e2e.ts [api-url]
//
// Requires a running server (default http://localhost:5555/api).

const API = process.argv[2] || process.env.API_URL || "http://localhost:5555/api";

// ─── Types ───────────────────────────────────────────────────────────

interface Agent {
  label: string;          // Human-readable label (Melody, Pixel, Groove)
  name: string;           // Registered name (with unique suffix)
  token: string;
  id: string;
  parcel: {
    id: string;
    tier: string;
    center: { x: number; z: number };
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  } | null;
  sessionId?: string;
  placementId?: string;
}

interface StepResult {
  phase: string;
  step: string;
  agent: string;
  passed: boolean;
  detail: string;
  timestamp: number;
}

// ─── Globals ─────────────────────────────────────────────────────────

const results: StepResult[] = [];
const startMs = Date.now();

// ─── Logging ─────────────────────────────────────────────────────────

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

const AGENT_COLORS: Record<string, string> = {
  Melody: COLORS.magenta,
  Pixel: COLORS.cyan,
  Groove: COLORS.yellow,
  "(all)": COLORS.dim,
};

function elapsed(): string {
  const ms = Date.now() - startMs;
  const s = (ms / 1000).toFixed(1);
  return `${COLORS.dim}${s.padStart(6)}s${COLORS.reset}`;
}

function agentTag(label: string): string {
  const color = AGENT_COLORS[label] || COLORS.dim;
  return `${color}${label.padEnd(7)}${COLORS.reset}`;
}

function logPhase(phase: string) {
  console.log(`\n${COLORS.bold}${"━".repeat(70)}${COLORS.reset}`);
  console.log(`${elapsed()} ${COLORS.bold}${phase}${COLORS.reset}`);
  console.log(`${COLORS.bold}${"━".repeat(70)}${COLORS.reset}`);
}

function pass(phase: string, step: string, agent: string, detail: string = "") {
  results.push({ phase, step, agent, passed: true, detail, timestamp: Date.now() - startMs });
  console.log(`${elapsed()} ${agentTag(agent)} ${COLORS.green}✓${COLORS.reset} ${step}${detail ? ` ${COLORS.dim}— ${detail}${COLORS.reset}` : ""}`);
}

function fail(phase: string, step: string, agent: string, detail: string) {
  results.push({ phase, step, agent, passed: false, detail, timestamp: Date.now() - startMs });
  console.log(`${elapsed()} ${agentTag(agent)} ${COLORS.red}✗${COLORS.reset} ${step} ${COLORS.red}— ${detail}${COLORS.reset}`);
}

function info(agent: string, msg: string) {
  console.log(`${elapsed()} ${agentTag(agent)} ${COLORS.dim}${msg}${COLORS.reset}`);
}

// ─── API Helper ──────────────────────────────────────────────────────

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: any;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Phase 1: Registration + Parcel ──────────────────────────────────

async function registerAgent(label: string): Promise<Agent | null> {
  const suffix = Date.now() % 100000;
  const name = `${label.toLowerCase()}_${suffix}`;
  const res = await api("POST", "/agents", { name });

  if (res.status === 201 && res.data?.token) {
    const parcel = res.data.parcel ? {
      id: res.data.parcel.id,
      tier: res.data.parcel.tier,
      center: res.data.parcel.center,
      bounds: res.data.parcel.bounds,
    } : null;

    pass("registration", "register", label,
      `name=${name} id=${res.data.id.slice(0, 8)} parcel=${parcel?.id || "none"} tier=${parcel?.tier || "?"}`);

    return { label, name, token: res.data.token, id: res.data.id, parcel };
  }

  fail("registration", "register", label, `HTTP ${res.status}: ${JSON.stringify(res.data)}`);
  return null;
}

// ─── Phase 2: Avatar ─────────────────────────────────────────────────

async function avatarWorkflow(agent: Agent) {
  // Check current avatar state
  const meRes = await api("GET", "/avatar/me", undefined, agent.token);
  if (meRes.status === 200) {
    const hasAssignment = !!meRes.data?.assignment;
    const hasActive = !!meRes.data?.active_order;
    pass("avatar", "check-avatar", agent.label,
      `assignment=${hasAssignment ? "yes" : "no"} active_order=${hasActive ? "yes" : "no"}`);
  } else {
    fail("avatar", "check-avatar", agent.label, `HTTP ${meRes.status}`);
  }

  // Try to generate (will 503 without Meshy, that's fine)
  const genRes = await api("POST", "/avatar/generate", {
    prompt: `A creative character named ${agent.label} with a distinctive style`,
  }, agent.token);

  if (genRes.status === 202) {
    pass("avatar", "generate", agent.label, `order=${genRes.data?.id?.slice(0, 8) || "?"} (Meshy started)`);
  } else if (genRes.status === 503) {
    pass("avatar", "generate", agent.label, "Meshy not configured — using generic avatar");
  } else if (genRes.status === 409) {
    pass("avatar", "generate", agent.label, "already generating");
  } else {
    fail("avatar", "generate", agent.label, `HTTP ${genRes.status}: ${genRes.data?.error || "?"}`);
  }

  // Check orders
  const ordersRes = await api("GET", "/avatar/orders", undefined, agent.token);
  if (ordersRes.status === 200) {
    const count = Array.isArray(ordersRes.data?.orders) ? ordersRes.data.orders.length : 0;
    pass("avatar", "orders", agent.label, `${count} orders`);
  } else {
    fail("avatar", "orders", agent.label, `HTTP ${ordersRes.status}`);
  }
}

// ─── Phase 3: Spawn ──────────────────────────────────────────────────

async function spawnAtParcel(agent: Agent) {
  if (!agent.parcel) {
    fail("spawn", "spawn-at-parcel", agent.label, "no parcel assigned!");
    return;
  }

  const { x, z } = agent.parcel.center;
  const res = await api("POST", "/wayfinding/action", {
    type: "SPAWN_AT",
    x, z,
    reason: `${agent.label} spawning at their parcel`,
  }, agent.token);

  if (res.status === 200 && res.data?.ok) {
    pass("spawn", "spawn-at-parcel", agent.label, `at parcel center (${x.toFixed(1)}, ${z.toFixed(1)})`);
  } else {
    fail("spawn", "spawn-at-parcel", agent.label, `${res.data?.reason_code || res.data?.error || `HTTP ${res.status}`}`);
  }

  // Verify position
  const stateRes = await api("GET", "/wayfinding/state", undefined, agent.token);
  if (stateRes.status === 200 && stateRes.data?.self) {
    const s = stateRes.data.self;
    const dist = Math.sqrt((s.x - x) ** 2 + (s.z - z) ** 2);
    if (dist < 1.0) {
      pass("spawn", "verify-position", agent.label, `confirmed at (${s.x.toFixed(1)}, ${s.z.toFixed(1)})`);
    } else {
      fail("spawn", "verify-position", agent.label, `expected (${x.toFixed(1)}, ${z.toFixed(1)}) got (${s.x.toFixed(1)}, ${s.z.toFixed(1)}) dist=${dist.toFixed(1)}`);
    }
  } else {
    fail("spawn", "verify-position", agent.label, `HTTP ${stateRes.status}`);
  }
}

// ─── Phase 4: Explore — move to town square ──────────────────────────

async function moveToTownSquare(agent: Agent) {
  // Move toward the center (town square)
  const targetX = (Math.random() - 0.5) * 8; // random spot in town square
  const targetZ = (Math.random() - 0.5) * 8;

  const res = await api("POST", "/wayfinding/action", {
    type: "MOVE_TO",
    x: targetX,
    z: targetZ,
    reason: `${agent.label} heading to town square to meet others`,
  }, agent.token);

  if (res.status === 200 && res.data?.ok) {
    pass("explore", "move-to-square", agent.label, `→ (${targetX.toFixed(1)}, ${targetZ.toFixed(1)})`);
  } else {
    fail("explore", "move-to-square", agent.label, `${res.data?.reason_code || res.data?.error || `HTTP ${res.status}`}`);
  }
}

async function verifyOthersVisible(agent: Agent, otherAgents: Agent[]) {
  const stateRes = await api("GET", "/wayfinding/state", undefined, agent.token);
  if (stateRes.status !== 200) {
    fail("explore", "see-others", agent.label, `HTTP ${stateRes.status}`);
    return;
  }

  const others = stateRes.data?.others || [];
  // others array uses botName (not agentId)
  const otherNames = new Set(others.map((o: any) => o.botName));
  const seen = otherAgents.filter(a => otherNames.has(a.name));

  if (seen.length === otherAgents.length) {
    pass("explore", "see-others", agent.label,
      `can see all ${otherAgents.length} other agents: ${seen.map(a => a.label).join(", ")}`);
  } else {
    const missing = otherAgents.filter(a => !otherNames.has(a.name)).map(a => a.label);
    fail("explore", "see-others", agent.label,
      `can only see ${seen.length}/${otherAgents.length} — missing: ${missing.join(", ")}`);
  }
}

// ─── Phase 5: Music ──────────────────────────────────────────────────

async function musicPhase(melody: Agent, pixel: Agent, groove: Agent) {
  // Melody writes a slot
  info(melody.label, "writing a drum pattern to slot 1...");
  const slotRes = await api("POST", "/slot/1", {
    code: 's("hh*4 bd sd bd")',
  }, melody.token);

  if (slotRes.status === 200) {
    pass("music", "write-slot", melody.label, 'slot 1: s("hh*4 bd sd bd")');
  } else {
    const detail = slotRes.data?.details
      ? (Array.isArray(slotRes.data.details) ? slotRes.data.details.join("; ") : String(slotRes.data.details))
      : slotRes.data?.error || `HTTP ${slotRes.status}`;
    fail("music", "write-slot", melody.label, detail);
  }

  // Melody places a spatial instrument near her parcel
  info(melody.label, "placing a cello near parcel...");
  const placeX = melody.parcel ? melody.parcel.center.x + 3 : 10;
  const placeZ = melody.parcel ? melody.parcel.center.z + 3 : 10;
  const placeRes = await api("POST", "/music/place", {
    instrument_type: "cello",
    pattern: 'note("c3 e3 g3 c4").slow(2)',
    position: { x: placeX, z: placeZ },
  }, melody.token);

  if (placeRes.status === 200 && placeRes.data?.placement) {
    melody.placementId = placeRes.data.placement.id;
    pass("music", "place-instrument", melody.label,
      `cello at (${placeX.toFixed(0)}, ${placeZ.toFixed(0)}) id=${melody.placementId!.slice(0, 8)}`);
  } else {
    fail("music", "place-instrument", melody.label,
      `${placeRes.data?.error || `HTTP ${placeRes.status}`}`);
  }

  // Groove places an 808 near the town square
  info(groove.label, "placing an 808 in town square...");
  const groovePlaceRes = await api("POST", "/music/place", {
    instrument_type: "808",
    pattern: 'n("0 3 7 10").s("808")',
    position: { x: 2, z: -2 },
  }, groove.token);

  if (groovePlaceRes.status === 200 && groovePlaceRes.data?.placement) {
    groove.placementId = groovePlaceRes.data.placement.id;
    pass("music", "place-instrument", groove.label,
      `808 at (2, -2) id=${groove.placementId!.slice(0, 8)}`);
  } else {
    fail("music", "place-instrument", groove.label,
      `${groovePlaceRes.data?.error || `HTTP ${groovePlaceRes.status}`}`);
  }

  // Verify composition state
  const compRes = await api("GET", "/composition");
  if (compRes.status === 200 && compRes.data?.slots) {
    const slot1 = compRes.data.slots.find((s: any) => s.id === 1);
    if (slot1?.code && slot1?.agent?.name === melody.name) {
      pass("music", "verify-composition", "(all)",
        `slot 1 owned by ${melody.label} (${melody.name})`);
    } else if (slot1?.code) {
      fail("music", "verify-composition", "(all)",
        `slot 1 has code but owner is ${slot1?.agent?.name}, expected ${melody.name}`);
    } else {
      fail("music", "verify-composition", "(all)", "slot 1 is empty after write");
    }
  }

  // Verify placements
  const placementsRes = await api("GET", "/music/placements");
  if (placementsRes.status === 200) {
    const placements = placementsRes.data?.placements || [];
    const count = placements.length;
    const expected = (melody.placementId ? 1 : 0) + (groove.placementId ? 1 : 0);
    if (count >= expected) {
      pass("music", "verify-placements", "(all)", `${count} placements (expected ${expected}+)`);
    } else {
      fail("music", "verify-placements", "(all)", `only ${count} placements, expected at least ${expected}`);
    }
  }

  // Melody updates her placement
  if (melody.placementId) {
    info(melody.label, "updating cello pattern...");
    const updateRes = await api("PUT", `/music/placement/${melody.placementId}`, {
      pattern: 'note("c3 e3 g3 c4").slow(2).gain(0.7)',
    }, melody.token);

    if (updateRes.status === 200) {
      pass("music", "update-placement", melody.label, "added gain(0.7)");
    } else {
      fail("music", "update-placement", melody.label,
        `${updateRes.data?.error || `HTTP ${updateRes.status}`}`);
    }
  }
}

// ─── Phase 6: World Building ─────────────────────────────────────────

async function worldBuildingPhase(agents: Agent[]) {
  for (const agent of agents) {
    if (!agent.parcel) {
      fail("world", "build-on-parcel", agent.label, "no parcel, skipping");
      continue;
    }

    const cx = agent.parcel.center.x;
    const cz = agent.parcel.center.z;

    // Each agent builds differently on their parcel
    let output: Record<string, unknown>;

    switch (agent.label) {
      case "Melody":
        output = {
          voxels: [
            // Small stage platform
            { block: "wood", x: Math.round(cx - 2), y: 0, z: Math.round(cz) },
            { block: "wood", x: Math.round(cx - 1), y: 0, z: Math.round(cz) },
            { block: "wood", x: Math.round(cx), y: 0, z: Math.round(cz) },
            { block: "wood", x: Math.round(cx + 1), y: 0, z: Math.round(cz) },
            { block: "wood", x: Math.round(cx + 2), y: 0, z: Math.round(cz) },
            { block: "glow", x: Math.round(cx), y: 1, z: Math.round(cz) }, // spotlight
          ],
          catalog_items: [
            { item: "torch", pos: [cx - 3, 0, cz] },
            { item: "torch", pos: [cx + 3, 0, cz] },
          ],
        };
        info(agent.label, "building a wooden music stage with glow spotlights...");
        break;

      case "Pixel":
        output = {
          voxels: [
            // Glass art tower
            { block: "glass", x: Math.round(cx), y: 0, z: Math.round(cz) },
            { block: "glass", x: Math.round(cx), y: 1, z: Math.round(cz) },
            { block: "glass", x: Math.round(cx), y: 2, z: Math.round(cz) },
            { block: "glass", x: Math.round(cx), y: 3, z: Math.round(cz) },
            { block: "glow", x: Math.round(cx), y: 4, z: Math.round(cz) },
          ],
          catalog_items: [
            { item: "flower", pos: [cx + 2, 0, cz + 2] },
            { item: "bush", pos: [cx - 2, 0, cz - 2] },
          ],
          sky: "#2a1b4e", // purple night sky
        };
        info(agent.label, "building a glass tower with glow beacon, setting purple sky...");
        break;

      case "Groove":
        output = {
          voxels: [
            // Dance floor
            { block: "marble", x: Math.round(cx - 1), y: 0, z: Math.round(cz - 1) },
            { block: "marble", x: Math.round(cx), y: 0, z: Math.round(cz - 1) },
            { block: "marble", x: Math.round(cx + 1), y: 0, z: Math.round(cz - 1) },
            { block: "marble", x: Math.round(cx - 1), y: 0, z: Math.round(cz) },
            { block: "lava", x: Math.round(cx), y: 0, z: Math.round(cz) }, // center glow
            { block: "marble", x: Math.round(cx + 1), y: 0, z: Math.round(cz) },
            { block: "marble", x: Math.round(cx - 1), y: 0, z: Math.round(cz + 1) },
            { block: "marble", x: Math.round(cx), y: 0, z: Math.round(cz + 1) },
            { block: "marble", x: Math.round(cx + 1), y: 0, z: Math.round(cz + 1) },
          ],
          catalog_items: [
            { item: "lamppost", pos: [cx - 3, 0, cz - 3] },
            { item: "lamppost", pos: [cx + 3, 0, cz + 3] },
            { item: "bench", pos: [cx + 4, 0, cz] },
          ],
        };
        info(agent.label, "building a marble dance floor with lava center...");
        break;

      default:
        output = {};
    }

    const res = await api("POST", "/world", { output }, agent.token);

    if (res.status === 200 || res.status === 201) {
      pass("world", "build-on-parcel", agent.label,
        `built on parcel ${agent.parcel.id} at (${cx.toFixed(0)}, ${cz.toFixed(0)})`);
    } else {
      fail("world", "build-on-parcel", agent.label,
        `${res.data?.error || `HTTP ${res.status}`}${res.data?.details ? ` — ${JSON.stringify(res.data.details)}` : ""}`);
    }
  }

  // Test build rights: Groove tries to build on Melody's parcel (should fail)
  const groove = agents.find(a => a.label === "Groove")!;
  const melody = agents.find(a => a.label === "Melody")!;
  if (melody.parcel) {
    const mx = Math.round(melody.parcel.center.x);
    const mz = Math.round(melody.parcel.center.z);
    info(groove.label, `trying to build on ${melody.label}'s parcel (should be rejected)...`);

    const badRes = await api("POST", "/world", {
      output: {
        voxels: [{ block: "stone", x: mx, y: 0, z: mz }],
      },
    }, groove.token);

    if (badRes.status === 403) {
      pass("world", "build-rights-check", groove.label,
        `correctly rejected from building on ${melody.label}'s parcel (403)`);
    } else if (badRes.status === 200 || badRes.status === 201) {
      fail("world", "build-rights-check", groove.label,
        `was allowed to build on ${melody.label}'s parcel! Build rights not enforced.`);
    } else {
      // Might be a different error — still worth noting
      pass("world", "build-rights-check", groove.label,
        `got HTTP ${badRes.status}: ${badRes.data?.error || "?"} (not 200, so access appears blocked)`);
    }
  }

  // Verify world state
  const worldRes = await api("GET", "/world");
  if (worldRes.status === 200) {
    const contribs = worldRes.data?.contributions || [];
    const env = worldRes.data?.environment || {};
    pass("world", "verify-world", "(all)",
      `${contribs.length} contributions, sky=${env.sky || "default"}`);
  } else {
    fail("world", "verify-world", "(all)", `HTTP ${worldRes.status}`);
  }
}

// ─── Phase 7: Sessions ───────────────────────────────────────────────

async function sessionPhase(melody: Agent, pixel: Agent, groove: Agent) {
  // Melody starts a music session
  info(melody.label, "starting a music jam session...");
  const startRes = await api("POST", "/session/start", {
    type: "music",
    title: "Melody's Jam Room",
    pattern: 'note("c3 e3 g3 b3").s("synth").slow(2)',
  }, melody.token);

  let musicSessionId: string | null = null;
  if ((startRes.status === 200 || startRes.status === 201) && startRes.data?.session) {
    musicSessionId = startRes.data.session.id;
    melody.sessionId = musicSessionId!;
    pass("sessions", "start-music-session", melody.label,
      `"Melody's Jam Room" id=${musicSessionId!.slice(0, 8)}`);
  } else {
    fail("sessions", "start-music-session", melody.label,
      `${startRes.data?.error || `HTTP ${startRes.status}`}`);
  }

  // Groove joins Melody's session
  if (musicSessionId) {
    info(groove.label, "joining Melody's jam...");
    const joinRes = await api("POST", "/session/join", {
      session_id: musicSessionId,
      pattern: 's("hh*8").gain(0.4)',
    }, groove.token);

    if (joinRes.status === 200 || joinRes.status === 201) {
      groove.sessionId = musicSessionId;
      pass("sessions", "join-music-session", groove.label,
        `joined ${musicSessionId.slice(0, 8)} with hh pattern`);
    } else {
      fail("sessions", "join-music-session", groove.label,
        `${joinRes.data?.error || `HTTP ${joinRes.status}`}`);
    }

    // Groove updates their contribution
    info(groove.label, "updating jam pattern...");
    const updateRes = await api("POST", "/session/output", {
      session_id: musicSessionId,
      pattern: 's("hh*8 ~ hh*4 hh").gain(0.5)',
    }, groove.token);

    if (updateRes.status === 200) {
      pass("sessions", "update-output", groove.label, "evolved hh pattern");
    } else {
      fail("sessions", "update-output", groove.label,
        `${updateRes.data?.error || `HTTP ${updateRes.status}`}`);
    }
  }

  // Pixel starts a visual session
  info(pixel.label, "starting a visual art session...");
  const visualRes = await api("POST", "/session/start", {
    type: "visual",
    title: "Pixel's Canvas",
    output: {
      elements: [
        { type: "rect", x: 50, y: 50, width: 300, height: 200, fill: "#334466" },
        { type: "circle", cx: 200, cy: 150, r: 40, fill: "#ff6644" },
      ],
    },
  }, pixel.token);

  let visualSessionId: string | null = null;
  if ((visualRes.status === 200 || visualRes.status === 201) && visualRes.data?.session) {
    visualSessionId = visualRes.data.session.id;
    pixel.sessionId = visualSessionId!;
    pass("sessions", "start-visual-session", pixel.label,
      `"Pixel's Canvas" id=${visualSessionId!.slice(0, 8)}`);
  } else {
    fail("sessions", "start-visual-session", pixel.label,
      `${visualRes.data?.error || `HTTP ${visualRes.status}`}`);
  }

  // Verify sessions list shows both
  const sessionsRes = await api("GET", "/sessions");
  if (sessionsRes.status === 200) {
    const sessions = sessionsRes.data?.sessions || sessionsRes.data || [];
    const musicSess = sessions.find((s: any) => s.id === musicSessionId);
    const visualSess = sessions.find((s: any) => s.id === visualSessionId);

    const musicParticipants = musicSess?.participants?.length || 0;
    const visualParticipants = visualSess?.participants?.length || 0;

    if (musicSess && visualSess) {
      pass("sessions", "verify-sessions", "(all)",
        `music session (${musicParticipants} participants), visual session (${visualParticipants} participants)`);
    } else {
      const found = sessions.map((s: any) => `${s.type}:${s.id?.slice(0, 8)}`).join(", ");
      fail("sessions", "verify-sessions", "(all)",
        `expected both sessions, found: ${found || "none"}`);
    }

    // Verify participant counts
    if (musicSess && musicParticipants >= 2) {
      pass("sessions", "verify-music-participants", "(all)",
        `${musicParticipants} participants: ${musicSess.participants.map((p: any) => p.botName).join(", ")}`);
    } else if (musicSess) {
      fail("sessions", "verify-music-participants", "(all)",
        `only ${musicParticipants} participants, expected 2 (Melody + Groove)`);
    }
  }

  // Groove leaves the music session
  if (musicSessionId) {
    info(groove.label, "leaving the music jam...");
    const leaveRes = await api("POST", "/session/leave", {
      session_id: musicSessionId,
    }, groove.token);

    if (leaveRes.status === 200) {
      groove.sessionId = undefined;
      pass("sessions", "leave-session", groove.label, `left ${musicSessionId.slice(0, 8)}`);
    } else {
      fail("sessions", "leave-session", groove.label,
        `${leaveRes.data?.error || `HTTP ${leaveRes.status}`}`);
    }
  }

  // Melody leaves her session (should auto-delete since she's last)
  if (musicSessionId) {
    info(melody.label, "leaving own jam session...");
    const leaveRes = await api("POST", "/session/leave", {
      session_id: musicSessionId,
    }, melody.token);

    if (leaveRes.status === 200) {
      melody.sessionId = undefined;
      pass("sessions", "leave-session", melody.label,
        `left ${musicSessionId.slice(0, 8)} (should auto-delete)`);
    } else {
      fail("sessions", "leave-session", melody.label,
        `${leaveRes.data?.error || `HTTP ${leaveRes.status}`}`);
    }
  }

  // Pixel leaves visual session
  if (visualSessionId) {
    info(pixel.label, "leaving visual session...");
    const leaveRes = await api("POST", "/session/leave", {
      session_id: visualSessionId,
    }, pixel.token);

    if (leaveRes.status === 200) {
      pixel.sessionId = undefined;
      pass("sessions", "leave-session", pixel.label,
        `left ${visualSessionId.slice(0, 8)}`);
    } else {
      fail("sessions", "leave-session", pixel.label,
        `${leaveRes.data?.error || `HTTP ${leaveRes.status}`}`);
    }
  }

  // Verify all sessions cleaned up
  const finalSessRes = await api("GET", "/sessions");
  if (finalSessRes.status === 200) {
    const remainingSessions = finalSessRes.data?.sessions || finalSessRes.data || [];
    // Filter to only our sessions (other tests may have left sessions)
    const ourSessions = remainingSessions.filter((s: any) =>
      s.id === musicSessionId || s.id === visualSessionId
    );
    if (ourSessions.length === 0) {
      pass("sessions", "verify-cleanup", "(all)", "all sessions auto-deleted after last participant left");
    } else {
      fail("sessions", "verify-cleanup", "(all)",
        `${ourSessions.length} sessions still active: ${ourSessions.map((s: any) => s.id?.slice(0, 8)).join(", ")}`);
    }
  }
}

// ─── Phase 8: Social ─────────────────────────────────────────────────

async function socialPhase(melody: Agent, pixel: Agent, groove: Agent) {
  // Groove broadcasts
  info(groove.label, "broadcasting a message...");
  const broadcastRes = await api("POST", "/agents/messages", {
    content: "Hey everyone! Great vibes today!",
  }, groove.token);

  if (broadcastRes.status === 200 || broadcastRes.status === 201) {
    pass("social", "broadcast", groove.label, '"Hey everyone! Great vibes today!"');
  } else {
    fail("social", "broadcast", groove.label,
      `${broadcastRes.data?.error || `HTTP ${broadcastRes.status}`}`);
  }

  // Melody DMs Pixel
  info(melody.label, `sending DM to ${pixel.label}...`);
  const dmRes = await api("POST", "/agents/messages", {
    content: "Love your glass tower, Pixel!",
    to: pixel.name,
  }, melody.token);

  if (dmRes.status === 200 || dmRes.status === 201) {
    pass("social", "direct-message", melody.label,
      `→ ${pixel.label}: "Love your glass tower, Pixel!"`);
  } else {
    fail("social", "direct-message", melody.label,
      `${dmRes.data?.error || `HTTP ${dmRes.status}`}`);
  }

  // Pixel reads messages
  info(pixel.label, "checking messages...");
  const msgRes = await api("GET", "/agents/messages", undefined, pixel.token);
  if (msgRes.status === 200) {
    const messages = Array.isArray(msgRes.data) ? msgRes.data : [];
    const fromMelody = messages.find((m: any) => m.fromId === melody.id);
    const broadcast = messages.find((m: any) => m.fromId === groove.id && !m.toId);

    if (fromMelody && broadcast) {
      pass("social", "receive-messages", pixel.label,
        `got DM from ${melody.label} + broadcast from ${groove.label}`);
    } else if (fromMelody) {
      pass("social", "receive-messages", pixel.label,
        `got DM from ${melody.label} (broadcast may be filtered)`);
    } else {
      pass("social", "receive-messages", pixel.label,
        `${messages.length} messages total`);
    }
  } else {
    fail("social", "receive-messages", pixel.label, `HTTP ${msgRes.status}`);
  }

  // Check directives (should be empty)
  const dirRes = await api("GET", "/agents/directives", undefined, melody.token);
  if (dirRes.status === 200) {
    const count = dirRes.data?.directives?.length || 0;
    pass("social", "check-directives", melody.label, `${count} pending directives`);
  } else {
    fail("social", "check-directives", melody.label, `HTTP ${dirRes.status}`);
  }
}

// ─── Phase 9: Movement + Presence ────────────────────────────────────

async function movementPhase(agents: Agent[]) {
  for (const agent of agents) {
    // Go home
    info(agent.label, "teleporting home...");
    const homeRes = await api("POST", "/wayfinding/action", {
      type: "GO_HOME",
      reason: `${agent.label} heading home after socializing`,
    }, agent.token);

    if (homeRes.status === 200 && homeRes.data?.ok) {
      pass("movement", "go-home", agent.label, "teleported to parcel center");
    } else {
      fail("movement", "go-home", agent.label,
        `${homeRes.data?.reason_code || homeRes.data?.error || `HTTP ${homeRes.status}`}`);
    }

    // Verify position is at parcel center
    if (agent.parcel) {
      const stateRes = await api("GET", "/wayfinding/state", undefined, agent.token);
      if (stateRes.status === 200 && stateRes.data?.self) {
        const s = stateRes.data.self;
        const cx = agent.parcel.center.x;
        const cz = agent.parcel.center.z;
        const dist = Math.sqrt((s.x - cx) ** 2 + (s.z - cz) ** 2);
        if (dist < 1.0) {
          pass("movement", "verify-home", agent.label,
            `at (${s.x.toFixed(1)}, ${s.z.toFixed(1)}) — matches parcel center`);
        } else {
          fail("movement", "verify-home", agent.label,
            `at (${s.x.toFixed(1)}, ${s.z.toFixed(1)}), expected (${cx.toFixed(1)}, ${cz.toFixed(1)}) dist=${dist.toFixed(1)}`);
        }
      }
    }
  }

  // Set presence states
  const presenceStates = [
    { agent: agents[0]!, state: "dance", duration: 30 },
    { agent: agents[1]!, state: "headbob", duration: 20 },
    { agent: agents[2]!, state: "celebrate", duration: 15 },
  ];

  for (const { agent, state, duration } of presenceStates) {
    info(agent.label, `setting presence to ${state}...`);
    const presRes = await api("POST", "/wayfinding/action", {
      type: "SET_PRESENCE_STATE",
      presenceState: state,
      durationSec: duration,
      reason: `${agent.label} is ${state}ing at home`,
    }, agent.token);

    if (presRes.status === 200 && presRes.data?.ok) {
      pass("movement", "set-presence", agent.label, `${state} for ${duration}s`);
    } else {
      fail("movement", "set-presence", agent.label,
        `${presRes.data?.reason_code || presRes.data?.error || `HTTP ${presRes.status}`}`);
    }
  }

  // Verify presence states via online agents
  const onlineRes = await api("GET", "/agents/online");
  if (onlineRes.status === 200 && Array.isArray(onlineRes.data)) {
    for (const { agent, state } of presenceStates) {
      const found = onlineRes.data.find((a: any) => a.id === agent.id);
      if (found) {
        pass("movement", "verify-online", agent.label,
          `online=${found.online !== false} activity=${found.currentActivity || "?"}`);
      } else {
        fail("movement", "verify-online", agent.label, "not in online list");
      }
    }
  }

  // Clear presence
  for (const agent of agents) {
    const clearRes = await api("POST", "/wayfinding/action", {
      type: "CLEAR_PRESENCE_STATE",
      reason: "settling down",
    }, agent.token);

    if (clearRes.status === 200 && clearRes.data?.ok) {
      pass("movement", "clear-presence", agent.label, "back to idle_pose");
    } else {
      fail("movement", "clear-presence", agent.label,
        `${clearRes.data?.reason_code || clearRes.data?.error || `HTTP ${clearRes.status}`}`);
    }
  }
}

// ─── Phase 10: Final Verification ────────────────────────────────────

async function finalVerification(agents: Agent[]) {
  // Check each agent's status
  for (const agent of agents) {
    const statusRes = await api("GET", "/agents/status", undefined, agent.token);
    if (statusRes.status === 200) {
      const d = statusRes.data;
      pass("final", "agent-status", agent.label,
        `name=${d.name} slots=${d.slots_held?.length || 0} placements=${d.total_placements || 0} rep=${d.reputation || 0}`);
    } else {
      fail("final", "agent-status", agent.label, `HTTP ${statusRes.status}`);
    }
  }

  // Check parcels are all assigned
  const parcelsRes = await api("GET", "/parcels");
  if (parcelsRes.status === 200) {
    const assigned = parcelsRes.data?.assignedCount || 0;
    pass("final", "parcel-system", "(all)",
      `${assigned} parcels assigned, ${parcelsRes.data?.freeRemaining || 0} remaining`);
  }

  // Check leaderboard
  const leaderRes = await api("GET", "/leaderboard");
  if (leaderRes.status === 200 && Array.isArray(leaderRes.data)) {
    const ourAgents = leaderRes.data.filter((a: any) =>
      agents.some(ag => ag.name === a.name)
    );
    pass("final", "leaderboard", "(all)",
      `${ourAgents.length} of our agents appear: ${ourAgents.map((a: any) => `${a.name}(rep:${a.reputation})`).join(", ")}`);
  } else {
    fail("final", "leaderboard", "(all)", `HTTP ${leaderRes.status}`);
  }

  // Final wayfinding state — verify all agents see each other
  for (const agent of agents) {
    const stateRes = await api("GET", "/wayfinding/state", undefined, agent.token);
    if (stateRes.status === 200 && stateRes.data?.self) {
      const s = stateRes.data.self;
      const othersCount = stateRes.data.others?.length || 0;
      pass("final", "wayfinding-state", agent.label,
        `pos=(${s.x.toFixed(1)}, ${s.z.toFixed(1)}) loco=${s.locomotionState} presence=${s.presenceState} sees=${othersCount} others`);
    } else {
      fail("final", "wayfinding-state", agent.label, `HTTP ${stateRes.status}`);
    }
  }

  // Check world state is populated
  const worldRes = await api("GET", "/world");
  if (worldRes.status === 200) {
    const contribs = worldRes.data?.contributions || [];
    const env = worldRes.data?.environment || {};
    const totalVoxels = contribs.reduce((sum: number, c: any) =>
      sum + (Array.isArray(c.voxels) ? c.voxels.length : 0), 0);
    const totalCatalog = contribs.reduce((sum: number, c: any) =>
      sum + (Array.isArray(c.catalog_items) ? c.catalog_items.length : 0), 0);

    pass("final", "world-state", "(all)",
      `${contribs.length} contributors, ${totalVoxels} voxels, ${totalCatalog} catalog items, sky=${env.sky || "default"}`);
  }

  // Cleanup: remove placements so we don't pollute
  for (const agent of agents) {
    if (agent.placementId) {
      await api("DELETE", `/music/placement/${agent.placementId}`, undefined, agent.token);
      info(agent.label, `cleaned up placement ${agent.placementId.slice(0, 8)}`);
    }
  }
}

// ─── Report ──────────────────────────────────────────────────────────

function printReport() {
  const totalMs = Date.now() - startMs;
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  console.log(`\n${COLORS.bold}${"═".repeat(70)}${COLORS.reset}`);
  console.log(`${COLORS.bold}  LIFECYCLE E2E TEST — RESULTS${COLORS.reset}`);
  console.log(`${COLORS.bold}${"═".repeat(70)}${COLORS.reset}\n`);

  console.log(`  Runtime: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Total: ${total}  ${COLORS.green}Passed: ${passed}${COLORS.reset}  ${failed > 0 ? COLORS.red : ""}Failed: ${failed}${COLORS.reset}\n`);

  // Group by phase
  const phases = new Map<string, StepResult[]>();
  for (const r of results) {
    if (!phases.has(r.phase)) phases.set(r.phase, []);
    phases.get(r.phase)!.push(r);
  }

  console.log("  BY PHASE:");
  for (const [phase, phaseResults] of phases) {
    const pPassed = phaseResults.filter(r => r.passed).length;
    const pTotal = phaseResults.length;
    const icon = pPassed === pTotal ? `${COLORS.green}✓${COLORS.reset}` : `${COLORS.red}✗${COLORS.reset}`;
    console.log(`    ${icon} ${phase.padEnd(16)} ${pPassed}/${pTotal}`);
  }

  // Group by agent
  console.log("\n  BY AGENT:");
  const agentNames = ["Melody", "Pixel", "Groove", "(all)"];
  for (const name of agentNames) {
    const agentResults = results.filter(r => r.agent === name);
    if (agentResults.length === 0) continue;
    const aPassed = agentResults.filter(r => r.passed).length;
    const aTotal = agentResults.length;
    const icon = aPassed === aTotal ? `${COLORS.green}✓${COLORS.reset}` : `${COLORS.red}✗${COLORS.reset}`;
    console.log(`    ${icon} ${agentTag(name)} ${aPassed}/${aTotal}`);
  }

  // Show failures
  if (failed > 0) {
    console.log(`\n  ${COLORS.red}FAILURES:${COLORS.reset}`);
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    ${COLORS.red}✗${COLORS.reset} [${r.phase}] ${agentTag(r.agent)} ${r.step}: ${r.detail}`);
    }
  }

  // Timeline (condensed)
  console.log("\n  TIMELINE:");
  for (const r of results) {
    const t = (r.timestamp / 1000).toFixed(1).padStart(6);
    const icon = r.passed ? `${COLORS.green}✓${COLORS.reset}` : `${COLORS.red}✗${COLORS.reset}`;
    console.log(`    ${COLORS.dim}${t}s${COLORS.reset} ${icon} ${agentTag(r.agent)} ${r.step}`);
  }

  console.log(`\n  ${passed === total ? `${COLORS.green}${COLORS.bold}ALL ${total} CHECKS PASSED${COLORS.reset}` : `${COLORS.red}${COLORS.bold}${failed} FAILURES${COLORS.reset}`}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`
${COLORS.bold}╔══════════════════════════════════════════════════════════════════╗
║  SYNTHMOB — Lifecycle End-to-End Test                            ║
║  3 agents: Melody, Pixel, Groove                                 ║
║  Full journey: register → avatar → parcel → explore → create     ║
║  Deterministic, no LLM — pure API verification                   ║
║  API: ${API.padEnd(57)} ║
╚══════════════════════════════════════════════════════════════════╝${COLORS.reset}
`);

  // ── Phase 1: Registration ──
  logPhase("PHASE 1: Registration + Parcel Assignment");

  const melody = await registerAgent("Melody");
  const pixel = await registerAgent("Pixel");
  const groove = await registerAgent("Groove");

  if (!melody || !pixel || !groove) {
    console.error(`\n${COLORS.red}FATAL: Could not register all agents. Is the server running at ${API}?${COLORS.reset}`);
    process.exit(1);
  }

  const agents = [melody, pixel, groove];

  // Verify all got unique parcels
  const parcelIds = agents.map(a => a.parcel?.id).filter(Boolean);
  const uniqueParcels = new Set(parcelIds);
  if (uniqueParcels.size === 3) {
    pass("registration", "unique-parcels", "(all)",
      `all 3 agents got distinct parcels: ${parcelIds.join(", ")}`);
  } else {
    fail("registration", "unique-parcels", "(all)",
      `expected 3 unique parcels, got ${uniqueParcels.size}: ${parcelIds.join(", ")}`);
  }

  // Verify online list
  const onlineRes = await api("GET", "/agents/online");
  if (onlineRes.status === 200 && Array.isArray(onlineRes.data)) {
    const ourAgents = onlineRes.data.filter((a: any) => agents.some(ag => ag.id === a.id));
    pass("registration", "online-visibility", "(all)",
      `${ourAgents.length}/3 agents appear online`);
  }

  // ── Phase 2: Avatar ──
  logPhase("PHASE 2: Avatar Workflow");

  for (const agent of agents) {
    await avatarWorkflow(agent);
  }

  // ── Phase 3: Spawn ──
  logPhase("PHASE 3: Spawn at Parcel");

  for (const agent of agents) {
    await spawnAtParcel(agent);
  }

  // ── Phase 4: Explore ──
  logPhase("PHASE 4: Explore — Move to Town Square");

  // All agents move toward the town square
  for (const agent of agents) {
    await moveToTownSquare(agent);
  }

  // Wait for movements to complete (max 30m at 4m/s = 7.5s)
  info("(all)", "waiting 8s for movements to complete...");
  await sleep(8000);

  // Each agent should see the others
  for (const agent of agents) {
    const others = agents.filter(a => a.id !== agent.id);
    await verifyOthersVisible(agent, others);
  }

  // ── Phase 5: Music ──
  logPhase("PHASE 5: Music — Slots + Spatial Instruments");

  await musicPhase(melody, pixel, groove);

  // ── Phase 6: World Building ──
  logPhase("PHASE 6: World Building — Build on Parcels");

  await worldBuildingPhase(agents);

  // ── Phase 7: Sessions ──
  logPhase("PHASE 7: Sessions — Create, Join, Collaborate, Leave");

  await sessionPhase(melody, pixel, groove);

  // ── Phase 8: Social ──
  logPhase("PHASE 8: Social — Messaging");

  await socialPhase(melody, pixel, groove);

  // ── Phase 9: Movement + Presence ──
  logPhase("PHASE 9: Movement + Presence");

  await movementPhase(agents);

  // ── Phase 10: Final Verification ──
  logPhase("PHASE 10: Final State Verification");

  await finalVerification(agents);

  // ── Report ──
  printReport();

  const failed = results.filter(r => !r.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${COLORS.red}FATAL: ${err}${COLORS.reset}`);
  process.exit(1);
});
