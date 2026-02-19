import { ARENA_RADIUS_M, MOVEMENT_SPEED_MPS } from "./wayfinding";
import type { WayfindingPresenceState } from "./wayfinding";
import type {
  AgentPositionState,
  AgentPositionView,
  WayfindingEvent,
} from "./wayfinding-runtime-types";

interface BuildPositionViewInput {
  runtime: AgentPositionState;
  allRuntimeStates: Iterable<AgentPositionState>;
  events: ReadonlyArray<WayfindingEvent>;
  allowedPresenceStates: WayfindingPresenceState[];
}

function computeMovementProgress(runtime: AgentPositionState): number {
  if (!runtime.movementStartedAt || !runtime.movementCompletesAt) return 100;
  const startMs = Date.parse(runtime.movementStartedAt);
  const endMs = Date.parse(runtime.movementCompletesAt);
  const nowMs = Date.now();
  if (endMs <= startMs) return 100;
  const pct = ((nowMs - startMs) / (endMs - startMs)) * 100;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

export function buildPositionView(
  input: BuildPositionViewInput
): AgentPositionView {
  const others: AgentPositionView["others"] = [];
  for (const snapshot of input.allRuntimeStates) {
    if (snapshot.agentId === input.runtime.agentId) continue;
    others.push({
      botName: snapshot.botName,
      x: snapshot.x,
      z: snapshot.z,
      locomotionState: snapshot.locomotionState,
      presenceState: snapshot.presenceState,
    });
  }

  return {
    schemaVersion: "2.0",
    timestamp: new Date().toISOString(),
    self: {
      agentId: input.runtime.agentId,
      botName: input.runtime.botName,
      x: input.runtime.x,
      z: input.runtime.z,
      locomotionState: input.runtime.locomotionState,
      presenceState: input.runtime.presenceState,
      systemState: input.runtime.systemState,
      presenceUntil: input.runtime.presenceUntil,
      movementToX: input.runtime.movementToX,
      movementToZ: input.runtime.movementToZ,
      movementCompletesAt: input.runtime.movementCompletesAt,
      movementProgressPct: computeMovementProgress(input.runtime),
    },
    others,
    policy: {
      allowedPresenceStates: [...input.allowedPresenceStates],
      arenaRadiusM: ARENA_RADIUS_M,
      speedMps: MOVEMENT_SPEED_MPS,
    },
    recentEvents: input.events.slice(-12).map((event) => ({
      at: event.at,
      type: event.type,
      actorBotName: event.botName,
    })),
  };
}
