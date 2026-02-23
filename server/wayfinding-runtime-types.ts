import type {
  WayfindingLocomotionState,
  WayfindingPresenceState,
  WayfindingSystemState,
} from "./wayfinding";

export interface WayfindingAgent {
  id: string;
  name: string;
}

export interface AgentPositionState {
  agentId: string;
  botName: string;
  x: number;
  z: number;
  locomotionState: WayfindingLocomotionState;
  presenceState: WayfindingPresenceState;
  systemState: WayfindingSystemState;
  presenceUntil: string | null;
  holdUntil: string | null;
  updatedAt: string;
  hasSpawnedExplicitly: boolean;

  // Time-based movement
  movementFromX: number | null;
  movementFromZ: number | null;
  movementToX: number | null;
  movementToZ: number | null;
  movementStartedAt: string | null;
  movementCompletesAt: string | null;
  movementTravelSeconds: number;
}

export interface WayfindingEvent {
  eventId: string;
  at: string;
  botName: string;
  type: string;
  fromX?: number;
  fromZ?: number;
  toX?: number;
  toZ?: number;
  reasonCode?: string;
  travelSeconds?: number;
  completesAt?: string;
}

export interface AgentPositionView {
  schemaVersion: "2.0";
  timestamp: string;
  self: {
    agentId: string;
    botName: string;
    x: number;
    z: number;
    locomotionState: WayfindingLocomotionState;
    presenceState: WayfindingPresenceState;
    systemState: WayfindingSystemState;
    presenceUntil: string | null;
    hasSpawnedExplicitly: boolean;
    movementToX: number | null;
    movementToZ: number | null;
    movementCompletesAt: string | null;
    movementProgressPct: number;
    parcelId: string | null;
    parcelBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  };
  others: Array<{
    botName: string;
    x: number;
    z: number;
    locomotionState: WayfindingLocomotionState;
    presenceState: WayfindingPresenceState;
  }>;
  policy: {
    allowedPresenceStates: WayfindingPresenceState[];
    worldBounded: boolean;
    speedMps: number;
  };
  recentEvents: Array<{
    at: string;
    type: string;
    actorBotName?: string;
  }>;
}

export type WayfindingActionResult =
  | {
      accepted: true;
      reasonCode?: never;
      state: AgentPositionView;
    }
  | {
      accepted: false;
      reasonCode: string;
      state: AgentPositionView;
    };

export interface WayfindingRuntimeDeps {
  getAgentById(agentId: string): WayfindingAgent | null;
  getParcelCenter(agentId: string): { x: number; z: number } | null;
  broadcast(event: string, data: unknown): void;
}
