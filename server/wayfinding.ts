// Wayfinding: continuous-space position tracking for SynthMob agents.

export type WayfindingLocomotionState = "idle" | "moving";

export type WayfindingPresenceState =
  | "idle_pose"
  | "wander"
  | "patrol"
  | "dance"
  | "headbob"
  | "spectate_screen"
  | "look_at_slot"
  | "chat_gesture"
  | "taunt"
  | "cheer"
  | "celebrate"
  | "disappointed"
  | "rest"
  | "stretch";

export type WayfindingSystemState =
  | "normal"
  | "rate_limited"
  | "validation_retry"
  | "cooldown_locked"
  | "model_error"
  | "stream_degraded"
  | "desynced"
  | "asset_loading"
  | "asset_fallback"
  | "suspended";

// Arena constants
export const ARENA_RADIUS_M = 50;
export const MOVEMENT_SPEED_MPS = 4;

export type WayfindingAction =
  | { type: "MOVE_TO"; x: number; z: number; reason: string }
  | { type: "HOLD_POSITION"; holdSeconds: number; reason: string }
  | {
      type: "SET_PRESENCE_STATE";
      presenceState: WayfindingPresenceState;
      durationSec?: number;
      reason: string;
    }
  | { type: "CLEAR_PRESENCE_STATE"; reason: string }
  | { type: "SET_SYSTEM_STATE"; systemState: WayfindingSystemState; reason: string }
  | { type: "CLEAR_SYSTEM_STATE"; reason: string };

export interface WayfindingActionDescriptor {
  type: WayfindingAction["type"];
  category: "navigation" | "presence" | "system";
  description: string;
  fields: string[];
}

const WAYFINDING_ACTION_CATALOG: ReadonlyArray<WayfindingActionDescriptor> = [
  {
    type: "MOVE_TO",
    category: "navigation",
    description: "Move to (x, z) coordinates in continuous space. Travel time = distance / 4 m/s.",
    fields: ["x", "z", "reason"],
  },
  {
    type: "HOLD_POSITION",
    category: "navigation",
    description: "Hold current position for a short duration.",
    fields: ["holdSeconds", "reason"],
  },
  {
    type: "SET_PRESENCE_STATE",
    category: "presence",
    description: "Set expressive behavior (dance, headbob, etc).",
    fields: ["presenceState", "durationSec?", "reason"],
  },
  {
    type: "CLEAR_PRESENCE_STATE",
    category: "presence",
    description: "Reset expressive behavior to default idle pose.",
    fields: ["reason"],
  },
  {
    type: "SET_SYSTEM_STATE",
    category: "system",
    description: "Set runtime system posture (degraded/loading/etc).",
    fields: ["systemState", "reason"],
  },
  {
    type: "CLEAR_SYSTEM_STATE",
    category: "system",
    description: "Reset system posture back to normal.",
    fields: ["reason"],
  },
];

// --- Removed action types (backward compat detection) ---

export const REMOVED_ACTION_TYPES: ReadonlySet<string> = new Set([
  "MOVE_TO_NODE",
  "JOIN_SLOT_QUEUE",
  "LEAVE_QUEUE",
  "CLAIM_STAGE_POSITION",
  "YIELD_STAGE",
  "FOCUS_SLOT",
  "REQUEST_REPLAN",
  "OBSERVE_WORLD",
  "EMIT_INTENT",
  "IDLE",
]);

// --- Validators ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIntegerLike(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return isIntegerLike(value) && value >= min && value <= max;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const PRESENCE_STATES: ReadonlySet<WayfindingPresenceState> = new Set([
  "idle_pose",
  "wander",
  "patrol",
  "dance",
  "headbob",
  "spectate_screen",
  "look_at_slot",
  "chat_gesture",
  "taunt",
  "cheer",
  "celebrate",
  "disappointed",
  "rest",
  "stretch",
]);

const SYSTEM_STATES: ReadonlySet<WayfindingSystemState> = new Set([
  "normal",
  "rate_limited",
  "validation_retry",
  "cooldown_locked",
  "model_error",
  "stream_degraded",
  "desynced",
  "asset_loading",
  "asset_fallback",
  "suspended",
]);

export function isPresenceState(value: unknown): value is WayfindingPresenceState {
  return typeof value === "string" && PRESENCE_STATES.has(value as WayfindingPresenceState);
}

export function isSystemState(value: unknown): value is WayfindingSystemState {
  return typeof value === "string" && SYSTEM_STATES.has(value as WayfindingSystemState);
}

export const MAX_REASON_LENGTH = 280;
export const MAX_PRESENCE_DURATION_SEC = 300;
export const ALL_PRESENCE_STATES: ReadonlyArray<WayfindingPresenceState> = [...PRESENCE_STATES];

export function isWayfindingAction(value: unknown): value is WayfindingAction {
  if (!isRecord(value)) return false;
  if (typeof value.type !== "string") return false;
  if (!isBoundedString(value.reason, MAX_REASON_LENGTH)) return false;

  switch (value.type) {
    case "MOVE_TO":
      return isFiniteNumber(value.x) && isFiniteNumber(value.z);
    case "HOLD_POSITION":
      return isIntegerLike(value.holdSeconds);
    case "SET_PRESENCE_STATE":
      return (
        isPresenceState(value.presenceState) &&
        (value.durationSec === undefined ||
          isIntegerInRange(value.durationSec, 1, MAX_PRESENCE_DURATION_SEC))
      );
    case "CLEAR_PRESENCE_STATE":
      return true;
    case "SET_SYSTEM_STATE":
      return isSystemState(value.systemState);
    case "CLEAR_SYSTEM_STATE":
      return true;
    default:
      return false;
  }
}

export function getWayfindingActionCatalog(): ReadonlyArray<WayfindingActionDescriptor> {
  return WAYFINDING_ACTION_CATALOG;
}

export function getArenaConfig() {
  return {
    schemaVersion: "2.0" as const,
    mode: "continuous_space" as const,
    arenaRadiusM: ARENA_RADIUS_M,
    speedMps: MOVEMENT_SPEED_MPS,
    origin: { x: 0, z: 0 },
  };
}
