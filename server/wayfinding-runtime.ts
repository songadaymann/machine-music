import { randomUUID } from "crypto";
import {
  ALL_PRESENCE_STATES,
  MOVEMENT_SPEED_MPS,
  REMOVED_ACTION_TYPES,
  type WayfindingAction,
  type WayfindingLocomotionState,
  type WayfindingPresenceState,
  type WayfindingSystemState,
} from "./wayfinding";
import { buildPositionView } from "./wayfinding-view-builder";
import type {
  AgentPositionState,
  AgentPositionView,
  WayfindingActionResult,
  WayfindingAgent,
  WayfindingEvent,
  WayfindingRuntimeDeps,
} from "./wayfinding-runtime-types";

export type {
  AgentPositionState,
  AgentPositionView,
  WayfindingActionResult,
  WayfindingAgent,
  WayfindingEvent,
  WayfindingRuntimeDeps,
} from "./wayfinding-runtime-types";

const WAYFINDING_EVENT_CAP = 500;
const WAYFINDING_REASON_MAX = 280;
const WAYFINDING_PRESENCE_MAX_DURATION_SEC = 300;

const SELF_SETTABLE_SYSTEM_STATES = new Set<WayfindingSystemState>([
  "normal",
  "rate_limited",
  "validation_retry",
  "cooldown_locked",
  "model_error",
  "stream_degraded",
  "desynced",
  "asset_loading",
  "asset_fallback",
]);

export class WayfindingReducer {
  private readonly deps: WayfindingRuntimeDeps;
  private positionByAgentId: Map<string, AgentPositionState> = new Map();
  private wayfindingEvents: WayfindingEvent[] = [];

  constructor(deps: WayfindingRuntimeDeps) {
    this.deps = deps;
  }

  reset(): void {
    this.positionByAgentId.clear();
    this.wayfindingEvents = [];
  }

  ensureAgentState(agent: WayfindingAgent): AgentPositionState {
    return this.ensurePositionState(agent);
  }

  /** Override the default random spawn with a specific position (e.g. parcel center). */
  setSpawnPosition(agentId: string, x: number, z: number): void {
    const runtime = this.positionByAgentId.get(agentId);
    if (runtime && !runtime.hasSpawnedExplicitly) {
      runtime.x = Number(x.toFixed(2));
      runtime.z = Number(z.toFixed(2));
    }
  }

  tick(nowMs: number): void {
    for (const [agentId, runtime] of this.positionByAgentId) {
      if (!runtime.movementCompletesAt) continue;
      if (nowMs >= Date.parse(runtime.movementCompletesAt)) {
        this.completeMovement(runtime, agentId);
      }
    }
  }

  getState(
    agent: WayfindingAgent,
    parcelInfo?: { parcelId: string | null; parcelBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null }
  ): AgentPositionView {
    const runtime = this.ensurePositionState(agent);
    this.enforcePresenceGuardrails(runtime);
    return buildPositionView({
      runtime,
      allRuntimeStates: this.positionByAgentId.values(),
      events: this.wayfindingEvents,
      allowedPresenceStates: this.resolveAllowedPresenceStates(runtime),
      parcelId: parcelInfo?.parcelId ?? null,
      parcelBounds: parcelInfo?.parcelBounds ?? null,
    });
  }

  submitAction(agent: WayfindingAgent, action: WayfindingAction): WayfindingActionResult {
    const runtime = this.ensurePositionState(agent);
    this.enforcePresenceGuardrails(runtime);
    const reason = action.reason.trim();
    if (reason.length === 0 || reason.length > WAYFINDING_REASON_MAX) {
      runtime.updatedAt = new Date().toISOString();
      return {
        accepted: false,
        reasonCode: "invalid_reason",
        state: this.getState(agent),
      };
    }

    const reject = (reasonCode: string): WayfindingActionResult => {
      runtime.updatedAt = new Date().toISOString();
      return {
        accepted: false,
        reasonCode,
        state: this.getState(agent),
      };
    };

    const accept = (): WayfindingActionResult => ({
      accepted: true,
      state: this.getState(agent),
    });

    const now = Date.now();

    switch (action.type) {
      case "SPAWN_AT": {
        if (runtime.hasSpawnedExplicitly) {
          return reject("already_spawned");
        }

        runtime.x = Number(action.x.toFixed(2));
        runtime.z = Number(action.z.toFixed(2));
        runtime.locomotionState = "idle";
        runtime.hasSpawnedExplicitly = true;
        runtime.updatedAt = new Date().toISOString();

        this.emitEvent("bot_spawned", agent, {
          toX: runtime.x,
          toZ: runtime.z,
        });
        return accept();
      }

      case "MOVE_TO": {
        // Reject if already in motion
        if (runtime.movementCompletesAt && now < Date.parse(runtime.movementCompletesAt)) {
          return reject("movement_in_progress");
        }

        const tx = Number(action.x.toFixed(2));
        const tz = Number(action.z.toFixed(2));

        // Already at destination?
        const dx = tx - runtime.x;
        const dz = tz - runtime.z;
        const travelDist = Math.sqrt(dx * dx + dz * dz);
        if (travelDist < 0.1) {
          return reject("already_at_destination");
        }

        const travelSeconds = Number((travelDist / MOVEMENT_SPEED_MPS).toFixed(2));
        const completesAt = new Date(now + travelSeconds * 1000).toISOString();

        runtime.locomotionState = "moving";
        runtime.movementFromX = runtime.x;
        runtime.movementFromZ = runtime.z;
        runtime.movementToX = tx;
        runtime.movementToZ = tz;
        runtime.movementStartedAt = new Date(now).toISOString();
        runtime.movementCompletesAt = completesAt;
        runtime.movementTravelSeconds = travelSeconds;
        runtime.updatedAt = new Date(now).toISOString();

        this.emitEvent("bot_nav_path_started", agent, {
          fromX: runtime.movementFromX,
          fromZ: runtime.movementFromZ,
          toX: tx,
          toZ: tz,
          travelSeconds,
          completesAt,
        });
        return accept();
      }

      case "GO_HOME": {
        const parcelCenter = this.deps.getParcelCenter(agent.id);
        if (!parcelCenter) {
          return reject("no_parcel_assigned");
        }

        // Cancel any in-progress movement
        runtime.movementFromX = null;
        runtime.movementFromZ = null;
        runtime.movementToX = null;
        runtime.movementToZ = null;
        runtime.movementStartedAt = null;
        runtime.movementCompletesAt = null;
        runtime.movementTravelSeconds = 0;

        const fromX = runtime.x;
        const fromZ = runtime.z;
        runtime.x = Number(parcelCenter.x.toFixed(2));
        runtime.z = Number(parcelCenter.z.toFixed(2));
        runtime.locomotionState = "idle";
        runtime.updatedAt = new Date().toISOString();

        this.emitEvent("bot_teleported_home", agent, {
          fromX,
          fromZ,
          toX: runtime.x,
          toZ: runtime.z,
        });
        return accept();
      }

      case "HOLD_POSITION": {
        if (runtime.movementCompletesAt && now < Date.parse(runtime.movementCompletesAt)) {
          return reject("movement_in_progress");
        }
        if (!Number.isInteger(action.holdSeconds) || action.holdSeconds < 1 || action.holdSeconds > 30) {
          return reject("invalid_hold_seconds");
        }
        runtime.locomotionState = "idle";
        runtime.holdUntil = new Date(now + action.holdSeconds * 1000).toISOString();
        runtime.updatedAt = new Date().toISOString();
        return accept();
      }

      case "SET_PRESENCE_STATE": {
        if (action.durationSec !== undefined && action.durationSec > WAYFINDING_PRESENCE_MAX_DURATION_SEC) {
          return reject("presence_duration_too_long");
        }
        const allowed = this.resolveAllowedPresenceStates(runtime);
        if (!allowed.includes(action.presenceState)) {
          return reject("presence_state_disallowed");
        }
        runtime.presenceState = action.presenceState;
        runtime.presenceUntil =
          action.durationSec !== undefined
            ? new Date(now + action.durationSec * 1000).toISOString()
            : null;
        runtime.updatedAt = new Date().toISOString();

        this.emitEvent("bot_presence_changed", agent, {
          fromX: runtime.x,
          fromZ: runtime.z,
        });
        return accept();
      }

      case "CLEAR_PRESENCE_STATE": {
        runtime.presenceState = "idle_pose";
        runtime.presenceUntil = null;
        runtime.updatedAt = new Date().toISOString();

        this.emitEvent("bot_presence_changed", agent, {
          fromX: runtime.x,
          fromZ: runtime.z,
        });
        return accept();
      }

      case "SET_SYSTEM_STATE": {
        if (!SELF_SETTABLE_SYSTEM_STATES.has(action.systemState)) {
          return reject("system_state_disallowed");
        }
        this.applySystemState(runtime, action.systemState);
        return accept();
      }

      case "CLEAR_SYSTEM_STATE": {
        this.applySystemState(runtime, "normal");
        return accept();
      }
    }
  }

  /** Check if an action type string is a removed (legacy) action */
  static isRemovedActionType(type: string): boolean {
    return REMOVED_ACTION_TYPES.has(type);
  }

  // --- Private methods ---

  private completeMovement(runtime: AgentPositionState, agentId: string): void {
    if (runtime.movementToX === null || runtime.movementToZ === null) return;
    const agent = this.deps.getAgentById(agentId);
    if (!agent) return;

    const fromX = runtime.x;
    const fromZ = runtime.z;
    runtime.x = runtime.movementToX;
    runtime.z = runtime.movementToZ;
    runtime.locomotionState = "idle";
    runtime.movementFromX = null;
    runtime.movementFromZ = null;
    runtime.movementToX = null;
    runtime.movementToZ = null;
    runtime.movementStartedAt = null;
    runtime.movementCompletesAt = null;
    runtime.movementTravelSeconds = 0;
    runtime.updatedAt = new Date().toISOString();

    this.emitEvent("bot_nav_arrived", agent, {
      fromX,
      fromZ,
      toX: runtime.x,
      toZ: runtime.z,
    });
  }

  private ensurePositionState(agent: WayfindingAgent): AgentPositionState {
    const existing = this.positionByAgentId.get(agent.id);
    if (existing) {
      if (existing.botName !== agent.name) {
        existing.botName = agent.name;
      }
      if (!existing.presenceState) existing.presenceState = "idle_pose";
      if (!existing.systemState) existing.systemState = "normal";
      if (existing.presenceUntil === undefined) existing.presenceUntil = null;
      return existing;
    }

    // Default spawn at origin (overridden by setSpawnPosition with parcel center)
    const spawnX = 0;
    const spawnZ = 0;

    const next: AgentPositionState = {
      agentId: agent.id,
      botName: agent.name,
      x: spawnX,
      z: spawnZ,
      locomotionState: "idle",
      presenceState: "idle_pose",
      systemState: "normal",
      presenceUntil: null,
      holdUntil: null,
      updatedAt: new Date().toISOString(),
      hasSpawnedExplicitly: false,
      movementFromX: null,
      movementFromZ: null,
      movementToX: null,
      movementToZ: null,
      movementStartedAt: null,
      movementCompletesAt: null,
      movementTravelSeconds: 0,
    };
    this.positionByAgentId.set(agent.id, next);
    return next;
  }

  private emitEvent(
    eventType: string,
    agent: WayfindingAgent,
    extra?: {
      fromX?: number;
      fromZ?: number;
      toX?: number;
      toZ?: number;
      reasonCode?: string;
      travelSeconds?: number;
      completesAt?: string;
    }
  ): void {
    const event: WayfindingEvent = {
      eventId: randomUUID(),
      at: new Date().toISOString(),
      botName: agent.name,
      type: eventType,
      fromX: extra?.fromX,
      fromZ: extra?.fromZ,
      toX: extra?.toX,
      toZ: extra?.toZ,
      reasonCode: extra?.reasonCode,
      travelSeconds: extra?.travelSeconds,
      completesAt: extra?.completesAt,
    };
    this.wayfindingEvents.push(event);
    if (this.wayfindingEvents.length > WAYFINDING_EVENT_CAP) {
      this.wayfindingEvents = this.wayfindingEvents.slice(-WAYFINDING_EVENT_CAP);
    }
    this.deps.broadcast(eventType, event);
  }

  private resolveAllowedPresenceStates(runtime: AgentPositionState): WayfindingPresenceState[] {
    if (runtime.systemState !== "normal") {
      return ["idle_pose", "rest"];
    }
    return [...ALL_PRESENCE_STATES];
  }

  private enforcePresenceGuardrails(runtime: AgentPositionState): void {
    const now = Date.now();
    if (runtime.presenceUntil) {
      const untilMs = Date.parse(runtime.presenceUntil);
      if (!Number.isFinite(untilMs) || untilMs <= now) {
        runtime.presenceState = "idle_pose";
        runtime.presenceUntil = null;
      }
    }

    const allowed = this.resolveAllowedPresenceStates(runtime);
    if (!allowed.includes(runtime.presenceState)) {
      runtime.presenceState = allowed.includes("idle_pose") ? "idle_pose" : allowed[0] ?? "idle_pose";
      runtime.presenceUntil = null;
    }
  }

  private applySystemState(runtime: AgentPositionState, systemState: WayfindingSystemState): void {
    runtime.systemState = systemState;
    if (systemState !== "normal") {
      runtime.presenceState = "rest";
      runtime.presenceUntil = null;
    }
    runtime.updatedAt = new Date().toISOString();
  }
}

export { WayfindingReducer as WayfindingRuntime };
