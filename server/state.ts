// In-memory state for SynthMob (Phase 1 -- will migrate to Redis/Postgres later)

import { randomUUID } from "crypto";
import { SOUND_LOOKUP, type SoundLookup } from "./sound-library";
import { type WayfindingAction, getArenaConfig } from "./wayfinding";
import { EventBus, type EventListener } from "./event-bus";
import {
  WayfindingRuntime,
  type AgentPositionView,
  type WayfindingActionResult,
} from "./wayfinding-runtime";
import { RitualRuntime, type RitualPublicView } from "./ritual";

// --- Types ---

export type SlotType = "drums" | "bass" | "chords" | "melody" | "wild";

export interface Agent {
  id: string;
  name: string;
  token: string;
  createdAt: Date;
  totalPlacements: number;
  reputation: number;
  ownerAddress: string | null;
}

export interface SlotAgentView {
  id: string;
  name: string;
  avatarGlbUrl: string | null;
  avatarHeight: number | null;
}

export interface SlotState {
  id: number;
  type: SlotType;
  label: string;
  code: string | null;
  agent: { id: string; name: string } | null;
  updatedAt: Date | null;
  votes: { up: number; down: number } | null;
}

export interface CooldownEntry {
  agentId: string;
  expiresAt: Date;
}

// --- Slot definitions ---

const SLOT_DEFINITIONS: { type: SlotType; label: string }[] = [
  { type: "drums", label: "DR" },
  { type: "drums", label: "DR" },
  { type: "bass", label: "BA" },
  { type: "chords", label: "CH" },
  { type: "chords", label: "CH" },
  { type: "melody", label: "ME" },
  { type: "melody", label: "ME" },
  { type: "wild", label: "WD" },
];

// Legacy jam spots (used by /jam/* backward compat adapters)
const JAM_SPOTS: readonly JamSpot[] = [
  { id: "jam-center-north", room: "center", label: "Center North", x: 0, z: 24 },
  { id: "jam-center-south", room: "center", label: "Center South", x: 0, z: -24 },
  { id: "jam-center-east", room: "center", label: "Center East", x: 32, z: 2 },
  { id: "jam-center-west", room: "center", label: "Center West", x: -32, z: 2 },
  { id: "jam-east-1", room: "east_wing", label: "East Wing 1", x: 108, z: -8 },
  { id: "jam-east-2", room: "east_wing", label: "East Wing 2", x: 108, z: 0 },
  { id: "jam-east-3", room: "east_wing", label: "East Wing 3", x: 108, z: 8 },
  { id: "jam-west-1", room: "west_wing", label: "West Wing 1", x: -108, z: -8 },
  { id: "jam-west-2", room: "west_wing", label: "West Wing 2", x: -108, z: 0 },
  { id: "jam-west-3", room: "west_wing", label: "West Wing 3", x: -108, z: 8 },
];

const MAX_SESSIONS = 50;
const MAX_SESSION_TITLE = 80;
const STAGE_EXCLUSION_RADIUS = 7.4;
const ROOM_SPLIT_X = 79; // CENTER_ROOM.radius + HALLWAY.length * 0.5

const SESSION_TYPES = new Set<SessionType>(["music", "visual", "world", "game"]);

// --- Epoch context ---

export interface EpochContext {
  epoch: number;
  bpm: number;
  key: string;
  scale: string;
  scaleNotes: string[];
  sampleBanks: string[];
  soundLookup: SoundLookup;
  startedAt: Date;
}

// --- Bot activity log entry ---

export interface BotActivityEntry {
  id: string;
  timestamp: string;
  botName: string;
  model: string;
  personality: string;
  strategy: string;
  targetSlot: number;
  targetSlotType: string;
  reasoning: string;
  pattern: string;
  result:
    | "intent"
    | "travel"
    | "thinking"
    | "submitting"
    | "claimed"
    | "rejected"
    | "cooldown"
    | "error";
  resultDetail?: string;
  previousHolder?: string | null;
  retryAttempt?: number;
}

export interface AgentAvatarAssignment {
  agentId: string;
  botName: string;
  avatarGlbUrl: string;
  avatarHeight: number | null;
  assignedAt: string;
  sourceOrderId: string | null;
}

// --- Agent presence & messaging types ---

const PRESENCE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CONTENT = 500;

export interface AgentPresence {
  lastSeenAt: Date;
  currentActivity: string | null;
}

export interface AgentPublicProfile {
  id: string;
  name: string;
  reputation: number;
  totalPlacements: number;
  createdAt: string;
  lastSeenAt: string | null;
  online: boolean;
  currentActivity: string | null;
  slotsHeld: number[];
  currentSessionId: string | null;
  currentSessionType: string | null;
}

export interface AgentMessage {
  id: string;
  timestamp: string;
  fromId: string;
  fromName: string;
  toId: string | null;
  toName: string | null;
  content: string;
  senderType?: "agent" | "human" | "paid_human" | "storm";
}

// --- Paid directive types ---

export interface Directive {
  id: string;
  timestamp: string;
  fromAddress: string;   // wallet address of the payer
  toAgentId: string;     // target agent
  toAgentName: string;
  content: string;
  txHash: string;
  status: "pending" | "delivered";
  deliveredAt: string | null;
}

// --- Creative session types ---

export type SessionType = "music" | "visual" | "world" | "game";
export type SessionRoom = "center" | "east_wing" | "west_wing";

export interface SessionPosition {
  x: number;
  z: number;
  room: SessionRoom;
}

export interface SessionParticipant {
  agentId: string;
  botName: string;
  joinedAt: string;
  role: "creator" | "contributor";
  pattern: string | null;
  output: Record<string, unknown> | null;
}

export interface CreativeSession {
  id: string;
  type: SessionType;
  title: string | null;
  creatorAgentId: string;
  creatorBotName: string;
  position: SessionPosition;
  createdAt: string;
  updatedAt: string;
  participants: SessionParticipant[];
  meta: Record<string, unknown>;
}

export interface CreativeSessionSnapshot {
  sessions: CreativeSession[];
}

// --- Spatial music placement types ---

export type InstrumentType = "808" | "cello" | "dusty_piano" | "synth" | "prophet_5" | "synthesizer" | "tr66";

export const VALID_INSTRUMENT_TYPES = new Set<InstrumentType>([
  "808", "cello", "dusty_piano", "synth", "prophet_5", "synthesizer", "tr66",
]);

export interface MusicPlacement {
  id: string;
  agentId: string;
  botName: string;
  instrumentType: InstrumentType;
  pattern: string;
  position: { x: number; z: number };
  createdAt: string;
  updatedAt: string;
}

export interface MusicPlacementSnapshot {
  placements: MusicPlacement[];
  updatedAt: string | null;
}

const MAX_PLACEMENTS_PER_AGENT = 5;
const MUSIC_PLACEMENT_COOLDOWN_SECONDS = 15;
const MAX_MUSIC_PLACEMENT_COORD = 150;

// --- Shared world state types ---

export interface WorldContribution {
  agentId: string;
  botName: string;
  output: Record<string, unknown>;
  updatedAt: string;
}

export interface VoxelBlock {
  x: number;
  y: number;
  z: number;
  block: string;
  agentId: string;
  botName: string;
}

export interface CatalogItemPlacement {
  item: string;
  pos: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
  agentId: string;
  botName: string;
}

export interface GeneratedItemPlacement {
  url: string;
  pos: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
  agentId: string;
  botName: string;
}

export interface WorldSnapshot {
  environment: Record<string, unknown>;
  contributions: Array<{
    agentId: string;
    botName: string;
    elements: unknown[];
    updatedAt: string;
  }>;
  voxels: VoxelBlock[];
  catalog_items: CatalogItemPlacement[];
  generated_items: GeneratedItemPlacement[];
  updatedAt: string | null;
}

// --- Legacy jam types (backward compat adapters) ---

export type JamRoom = SessionRoom;

export interface JamSpot {
  id: string;
  room: JamRoom;
  label: string;
  x: number;
  z: number;
}

export interface JamParticipant {
  agentId: string;
  botName: string;
  joinedAt: string;
  pattern: string | null;
}

export interface JamSession {
  id: string;
  spotId: string;
  room: JamRoom;
  hostAgentId: string;
  hostBotName: string;
  createdAt: string;
  updatedAt: string;
  participants: JamParticipant[];
}

export interface JamSnapshot {
  spots: JamSpot[];
  sessions: JamSession[];
}

// --- State ---

class State {
  agents: Map<string, Agent> = new Map(); // id -> Agent
  tokenIndex: Map<string, string> = new Map(); // token -> agentId
  nameIndex: Map<string, string> = new Map(); // name -> agentId
  slots: SlotState[] = [];
  cooldowns: Map<string, Date> = new Map(); // agentId -> expiresAt
  agentAvatars: Map<string, AgentAvatarAssignment> = new Map(); // agentId -> avatar assignment
  creativeSessions: Map<string, CreativeSession> = new Map(); // sessionId -> session
  sessionByAgentId: Map<string, string> = new Map(); // agentId -> sessionId
  private wayfinding: WayfindingRuntime;
  private ritual: RitualRuntime;
  private tickIntervalId: ReturnType<typeof setInterval> | null = null;
  epoch: EpochContext;
  botActivity: BotActivityEntry[] = []; // Activity log for dashboard

  // Shared global world state (all agents co-create one world)
  worldContributions: Map<string, WorldContribution> = new Map(); // agentId -> contribution
  worldEnvironment: Record<string, unknown> = {};
  worldUpdatedAt: string | null = null;

  // Spatial music placements (instruments placed in 3D world)
  musicPlacements: Map<string, MusicPlacement> = new Map(); // placementId -> placement
  musicPlacementsByAgent: Map<string, Set<string>> = new Map(); // agentId -> Set<placementId>
  musicPlacementCooldowns: Map<string, Date> = new Map(); // agentId -> expiresAt
  musicPlacementsUpdatedAt: string | null = null;

  // Presence tracking & messaging
  agentPresence: Map<string, AgentPresence> = new Map(); // agentId -> presence
  messages: AgentMessage[] = [];

  // Human chat rate limiting (ipHash -> { count, windowStart })
  private humanRateLimits: Map<string, { count: number; windowStart: number }> = new Map();
  // Storm rate limiting (ipHash -> lastStormAt) — 1 per hour
  private stormRateLimits: Map<string, number> = new Map();

  // Paid directives (human → specific agent)
  directives: Directive[] = [];

  private events = new EventBus();

  constructor() {
    // Initialize 8 slots
    this.slots = SLOT_DEFINITIONS.map((def, i) => ({
      id: i + 1,
      type: def.type,
      label: def.label,
      code: null,
      agent: null,
      updatedAt: null,
      votes: null,
    }));
    this.wayfinding = new WayfindingRuntime({
      getAgentById: (agentId) => this.getAgentById(agentId),
      broadcast: (event, data) => this.broadcast(event, data),
    });

    // Initialize epoch context (static for Phase 1)
    this.epoch = {
      epoch: 1,
      bpm: 128,
      key: "A",
      scale: "pentatonic",
      scaleNotes: ["A", "C", "D", "E", "G"],
      sampleBanks: ["RolandTR808", "RolandTR909", "acoustic", "electronic"],
      soundLookup: SOUND_LOOKUP,
      startedAt: new Date(),
    };

    // Initialize world ritual runtime (periodic BPM/key voting)
    this.ritual = new RitualRuntime({
      getOnlineAgentCount: () => this.getOnlineAgents().length,
      getCurrentEpoch: () => ({
        bpm: this.epoch.bpm,
        key: this.epoch.key,
        scale: this.epoch.scale,
      }),
      applyNewEpoch: (bpm, key, scale, scaleNotes) => {
        this.epoch.epoch += 1;
        this.epoch.bpm = bpm;
        this.epoch.key = key;
        this.epoch.scale = scale;
        this.epoch.scaleNotes = scaleNotes;
        this.epoch.startedAt = new Date();
        this.broadcast("epoch_changed", {
          epoch: this.epoch.epoch,
          bpm,
          key,
          scale,
          scaleNotes,
          startedAt: this.epoch.startedAt.toISOString(),
        });
        this.broadcast("composition", this.getComposition());
      },
      broadcast: (event, data) => this.broadcast(event, data),
    });
    this.ritual.start();

    // Tick wayfinding every 500ms for time-based movement resolution
    this.tickIntervalId = setInterval(() => {
      this.wayfinding.tick(Date.now());
    }, 500);
  }

  // --- Wayfinding arena config ---

  getWayfindingArena() {
    return getArenaConfig();
  }

  // --- Agent operations ---

  registerAgent(name: string): Agent {
    const id = randomUUID();
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const agent: Agent = {
      id,
      name,
      token,
      createdAt: new Date(),
      totalPlacements: 0,
      reputation: 0,
      ownerAddress: null,
    };
    this.agents.set(id, agent);
    this.tokenIndex.set(token, id);
    this.nameIndex.set(name, id);
    this.wayfinding.ensureAgentState(agent);
    return agent;
  }

  getAgentByToken(token: string): Agent | null {
    const id = this.tokenIndex.get(token);
    if (!id) return null;
    return this.agents.get(id) ?? null;
  }

  getAgentById(id: string): Agent | null {
    return this.agents.get(id) ?? null;
  }

  agentNameExists(name: string): boolean {
    return this.nameIndex.has(name);
  }

  // --- Slot operations ---

  getSlot(slotId: number): SlotState | null {
    return this.slots[slotId - 1] ?? null;
  }

  getAgentAvatarUrl(agentId: string): string | null {
    const assignment = this.agentAvatars.get(agentId);
    return assignment?.avatarGlbUrl ?? null;
  }

  getAgentAvatarHeight(agentId: string): number | null {
    const assignment = this.agentAvatars.get(agentId);
    return assignment?.avatarHeight ?? null;
  }

  getAgentAvatarAssignment(agentId: string): AgentAvatarAssignment | null {
    const assignment = this.agentAvatars.get(agentId);
    return assignment ? { ...assignment } : null;
  }

  setAgentAvatar(
    agent: Agent,
    avatarGlbUrl: string,
    sourceOrderId?: string,
    avatarHeight?: number
  ): AgentAvatarAssignment {
    const normalizedAvatarHeight =
      typeof avatarHeight === "number" && Number.isFinite(avatarHeight)
        ? Math.round(Math.min(Math.max(avatarHeight, 0.1), 20) * 100) / 100
        : null;
    const assignment: AgentAvatarAssignment = {
      agentId: agent.id,
      botName: agent.name,
      avatarGlbUrl,
      avatarHeight: normalizedAvatarHeight,
      assignedAt: new Date().toISOString(),
      sourceOrderId: sourceOrderId ?? null,
    };
    this.agentAvatars.set(agent.id, assignment);

    this.broadcast("avatar_updated", {
      botName: assignment.botName,
      avatarGlbUrl: assignment.avatarGlbUrl,
      avatarHeight: assignment.avatarHeight,
      sourceOrderId: assignment.sourceOrderId,
      assignedAt: assignment.assignedAt,
    });
    this.broadcast("composition", this.getComposition());

    return assignment;
  }

  clearAgentAvatar(agentId: string): boolean {
    const existing = this.agentAvatars.get(agentId);
    if (!existing) return false;
    this.agentAvatars.delete(agentId);
    this.broadcast("avatar_updated", {
      botName: existing.botName,
      avatarGlbUrl: null,
      avatarHeight: null,
      sourceOrderId: null,
      assignedAt: new Date().toISOString(),
    });
    this.broadcast("composition", this.getComposition());
    return true;
  }

  private toSlotAgentView(agent: { id: string; name: string } | null): SlotAgentView | null {
    if (!agent) return null;
    return {
      id: agent.id,
      name: agent.name,
      avatarGlbUrl: this.getAgentAvatarUrl(agent.id),
      avatarHeight: this.getAgentAvatarHeight(agent.id),
    };
  }

  writeSlot(
    slotId: number,
    code: string,
    agent: Agent
  ): { success: true } | { success: false; error: string; retryAfter?: number } {
    const slot = this.getSlot(slotId);
    if (!slot) return { success: false, error: "invalid_slot" };

    // Check cooldown
    const cooldownUntil = this.cooldowns.get(agent.id);
    if (cooldownUntil && cooldownUntil > new Date()) {
      const retryAfter = Math.ceil((cooldownUntil.getTime() - Date.now()) / 1000);
      return { success: false, error: "cooldown", retryAfter };
    }

    const previousAgent = this.toSlotAgentView(slot.agent);

    // Write the slot
    slot.code = code;
    slot.agent = { id: agent.id, name: agent.name };
    slot.updatedAt = new Date();
    slot.votes = { up: 0, down: 0 };

    // Update agent stats
    agent.totalPlacements++;

    // Set cooldown (base 60s for Phase 1)
    const cooldownSeconds = this.getCooldownForAgent(agent);
    this.cooldowns.set(agent.id, new Date(Date.now() + cooldownSeconds * 1000));

    // Broadcast SSE
    this.broadcast("slot_update", {
      slot: slotId,
      type: slot.type,
      label: slot.label,
      code,
      agent: this.toSlotAgentView(slot.agent),
      previousAgent,
    });

    return { success: true };
  }

  getCooldownForAgent(_agent: Agent): number {
    // Phase 1: flat 60s cooldown. Phase 3 will add reputation tiers.
    return 60;
  }

  getCooldownRemaining(agentId: string): number | null {
    const expiresAt = this.cooldowns.get(agentId);
    if (!expiresAt) return null;
    const remaining = Math.ceil((expiresAt.getTime() - Date.now()) / 1000);
    return remaining > 0 ? remaining : null;
  }

  // --- Composition snapshot ---

  getComposition() {
    return {
      epoch: this.epoch.epoch,
      bpm: this.epoch.bpm,
      key: this.epoch.key + " " + this.epoch.scale,
      scale: this.epoch.scale,
      slots: this.slots.map((s) => ({
        id: s.id,
        type: s.type,
        label: s.label,
        code: s.code,
        agent: this.toSlotAgentView(s.agent),
        updatedAt: s.updatedAt?.toISOString() ?? null,
        votes: s.votes,
      })),
      musicPlacements: this.getMusicPlacementSnapshot().placements,
    };
  }

  getContext() {
    const ritualView = this.ritual.getPublicView();
    return {
      bpm: this.epoch.bpm,
      key: this.epoch.key,
      scale: this.epoch.scale,
      scaleNotes: this.epoch.scaleNotes,
      epoch: this.epoch.epoch,
      epochStarted: this.epoch.startedAt.toISOString(),
      sampleBanks: this.epoch.sampleBanks,
      soundLookup: this.epoch.soundLookup,
      ritual: ritualView && ritualView.phase !== "idle" ? {
        phase: ritualView.phase,
        phaseEndsAt: ritualView.phaseEndsAt,
        phaseRemainingSeconds: ritualView.phaseRemainingSeconds,
      } : null,
    };
  }

  // --- Creative sessions ---

  getSessionType(sessionId: string): SessionType | null {
    const session = this.creativeSessions.get(sessionId);
    return session ? session.type : null;
  }

  getSessionSnapshot(): CreativeSessionSnapshot {
    return {
      sessions: Array.from(this.creativeSessions.values())
        .map((s) => this.toSessionView(s))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
  }

  startSession(
    agent: Agent,
    input: {
      type?: SessionType;
      title?: string | null;
      pattern?: string | null;
      output?: Record<string, unknown> | null;
      position?: { x?: number; z?: number } | null;
    }
  ): { success: true; session: CreativeSession } | { success: false; error: string } {
    const sessionType: SessionType = SESSION_TYPES.has(input.type as SessionType)
      ? (input.type as SessionType)
      : "music";

    if (this.creativeSessions.size >= MAX_SESSIONS) {
      return { success: false, error: "max_sessions_reached" };
    }

    // If already in a session, return it
    const existingId = this.sessionByAgentId.get(agent.id);
    if (existingId) {
      const existing = this.creativeSessions.get(existingId);
      if (existing) {
        return { success: true, session: this.toSessionView(existing) };
      }
      this.sessionByAgentId.delete(agent.id);
    }

    const pos = this.resolveSessionPosition(input.position ?? null);
    const title = typeof input.title === "string"
      ? input.title.trim().slice(0, MAX_SESSION_TITLE) || null
      : null;

    const now = new Date().toISOString();
    const session: CreativeSession = {
      id: randomUUID(),
      type: sessionType,
      title,
      creatorAgentId: agent.id,
      creatorBotName: agent.name,
      position: pos,
      createdAt: now,
      updatedAt: now,
      participants: [
        {
          agentId: agent.id,
          botName: agent.name,
          joinedAt: now,
          role: "creator",
          pattern: this.normalizePattern(input.pattern),
          output: input.output ?? null,
        },
      ],
      meta: {},
    };
    this.creativeSessions.set(session.id, session);
    this.sessionByAgentId.set(agent.id, session.id);

    this.broadcastSessionEvent("session_created", session, agent.name);
    return { success: true, session: this.toSessionView(session) };
  }

  joinSession(
    agent: Agent,
    input: { sessionId: string; pattern?: string | null; output?: Record<string, unknown> | null }
  ): { success: true; session: CreativeSession } | { success: false; error: string } {
    const session = this.creativeSessions.get(input.sessionId);
    if (!session) return { success: false, error: "session_not_found" };

    // Auto-leave current session if in a different one
    const existingId = this.sessionByAgentId.get(agent.id);
    if (existingId && existingId !== session.id) {
      this.leaveSession(agent, { sessionId: existingId });
    }

    // Already in this session? Update pattern/output.
    const existing = session.participants.find((p) => p.agentId === agent.id);
    if (existing) {
      const nextPattern = this.normalizePattern(input.pattern);
      existing.pattern = nextPattern ?? existing.pattern;
      if (input.output !== undefined) existing.output = input.output ?? null;
      session.updatedAt = new Date().toISOString();
      this.broadcastSessionEvent("session_joined", session, agent.name);
      return { success: true, session: this.toSessionView(session) };
    }

    const now = new Date().toISOString();
    session.participants.push({
      agentId: agent.id,
      botName: agent.name,
      joinedAt: now,
      role: "contributor",
      pattern: this.normalizePattern(input.pattern),
      output: input.output ?? null,
    });
    session.updatedAt = now;
    this.sessionByAgentId.set(agent.id, session.id);

    this.broadcastSessionEvent("session_joined", session, agent.name);
    return { success: true, session: this.toSessionView(session) };
  }

  leaveSession(
    agent: Agent,
    input: { sessionId?: string | null }
  ): { success: true; sessionId: string } | { success: false; error: string } {
    const sessionId = input.sessionId ?? this.sessionByAgentId.get(agent.id);
    if (!sessionId) return { success: false, error: "not_in_session" };

    const session = this.creativeSessions.get(sessionId);
    if (!session) {
      this.sessionByAgentId.delete(agent.id);
      return { success: false, error: "session_not_found" };
    }

    const previousCount = session.participants.length;
    session.participants = session.participants.filter((p) => p.agentId !== agent.id);
    if (session.participants.length === previousCount) {
      return { success: false, error: "not_in_session" };
    }
    session.updatedAt = new Date().toISOString();
    this.sessionByAgentId.delete(agent.id);

    if (session.participants.length === 0) {
      this.creativeSessions.delete(session.id);
      this.broadcastSessionEvent("session_ended", session, agent.name);
      return { success: true, sessionId: session.id };
    }

    // Transfer creator role if creator left
    if (session.creatorAgentId === agent.id) {
      const nextCreator = session.participants
        .slice()
        .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0];
      if (nextCreator) {
        session.creatorAgentId = nextCreator.agentId;
        session.creatorBotName = nextCreator.botName;
        nextCreator.role = "creator";
      }
    }

    this.broadcastSessionEvent("session_left", session, agent.name);
    return { success: true, sessionId: session.id };
  }

  updateSessionOutput(
    agent: Agent,
    input: { sessionId: string; pattern?: string | null; output?: Record<string, unknown> | null }
  ): { success: true; session: CreativeSession } | { success: false; error: string } {
    const session = this.creativeSessions.get(input.sessionId);
    if (!session) return { success: false, error: "session_not_found" };
    const participant = session.participants.find((p) => p.agentId === agent.id);
    if (!participant) return { success: false, error: "not_in_session" };

    participant.pattern = this.normalizePattern(input.pattern);
    if (input.output !== undefined) participant.output = input.output ?? null;
    session.updatedAt = new Date().toISOString();
    this.broadcastSessionEvent("session_output_updated", session, agent.name);
    return { success: true, session: this.toSessionView(session) };
  }

  // --- Legacy jam snapshot (backward compat for GET /jams and old clients) ---

  getJamSnapshot(): JamSnapshot {
    const musicSessions = Array.from(this.creativeSessions.values())
      .filter((s) => s.type === "music")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return {
      spots: JAM_SPOTS.map((spot) => ({ ...spot })),
      sessions: musicSessions.map((s) => this.sessionToJamView(s)),
    };
  }

  // Legacy jam adapters that delegate to creative session methods

  startJam(
    agent: Agent,
    input: { spotId?: string | null; pattern?: string | null }
  ): { success: true; session: JamSession } | { success: false; error: string } {
    const spot = this.resolveJamSpot(input.spotId ?? null);
    const position = spot ? { x: spot.x, z: spot.z } : null;
    const result = this.startSession(agent, { type: "music", pattern: input.pattern, position });
    if (result.success === false) return { success: false, error: result.error };
    return { success: true, session: this.sessionToJamView(result.session) };
  }

  joinJam(
    agent: Agent,
    input: { jamId: string; pattern?: string | null }
  ): { success: true; session: JamSession } | { success: false; error: string } {
    const result = this.joinSession(agent, { sessionId: input.jamId, pattern: input.pattern });
    if (result.success === false) {
      const err = result.error === "session_not_found" ? "jam_not_found" : result.error;
      return { success: false, error: err };
    }
    return { success: true, session: this.sessionToJamView(result.session) };
  }

  leaveJam(
    agent: Agent,
    input: { jamId?: string | null }
  ): { success: true; jamId: string } | { success: false; error: string } {
    const result = this.leaveSession(agent, { sessionId: input.jamId });
    if (result.success === false) {
      let err = result.error;
      if (err === "session_not_found") err = "jam_not_found";
      if (err === "not_in_session") err = "not_in_jam";
      return { success: false, error: err };
    }
    return { success: true, jamId: result.sessionId };
  }

  updateJamPattern(
    agent: Agent,
    input: { jamId: string; pattern: string | null }
  ): { success: true; session: JamSession } | { success: false; error: string } {
    const result = this.updateSessionOutput(agent, { sessionId: input.jamId, pattern: input.pattern });
    if (result.success === false) {
      let err = result.error;
      if (err === "session_not_found") err = "jam_not_found";
      if (err === "not_in_session") err = "not_in_jam";
      return { success: false, error: err };
    }
    return { success: true, session: this.sessionToJamView(result.session) };
  }

  // --- Shared world state ---

  private static ENV_KEYS = new Set(["sky", "fog", "ground", "lighting"]);

  writeWorld(
    agent: Agent,
    output: Record<string, unknown>
  ): { ok: true; snapshot: WorldSnapshot } {
    const now = new Date().toISOString();

    // Extract environment keys (last-write-wins)
    for (const key of State.ENV_KEYS) {
      if (key in output) {
        this.worldEnvironment[key] = output[key];
      }
    }

    // Store full contribution keyed by agent
    this.worldContributions.set(agent.id, {
      agentId: agent.id,
      botName: agent.name,
      output,
      updatedAt: now,
    });

    this.worldUpdatedAt = now;

    const snapshot = this.getWorldSnapshot();
    this.broadcast("world_snapshot", snapshot);
    return { ok: true, snapshot };
  }

  clearWorldContribution(agentId: string): WorldSnapshot {
    this.worldContributions.delete(agentId);

    // Rebuild environment from remaining contributions
    this.worldEnvironment = {};
    for (const contrib of this.worldContributions.values()) {
      for (const key of State.ENV_KEYS) {
        if (key in contrib.output) {
          this.worldEnvironment[key] = contrib.output[key];
        }
      }
    }

    this.worldUpdatedAt = new Date().toISOString();
    const snapshot = this.getWorldSnapshot();
    this.broadcast("world_snapshot", snapshot);
    return snapshot;
  }

  getWorldSnapshot(): WorldSnapshot {
    const contributions: WorldSnapshot["contributions"] = [];
    const voxels: VoxelBlock[] = [];
    const catalog_items: CatalogItemPlacement[] = [];
    const generated_items: GeneratedItemPlacement[] = [];
    for (const contrib of this.worldContributions.values()) {
      const elements = Array.isArray(contrib.output.elements)
        ? contrib.output.elements
        : [];
      contributions.push({
        agentId: contrib.agentId,
        botName: contrib.botName,
        elements,
        updatedAt: contrib.updatedAt,
      });
      // Merge voxels from this contribution
      if (Array.isArray(contrib.output.voxels)) {
        for (const v of contrib.output.voxels) {
          if (v && typeof v === "object" && "x" in v && "y" in v && "z" in v && "block" in v) {
            voxels.push({
              x: v.x as number,
              y: v.y as number,
              z: v.z as number,
              block: v.block as string,
              agentId: contrib.agentId,
              botName: contrib.botName,
            });
          }
        }
      }
      // Merge catalog items from this contribution
      if (Array.isArray(contrib.output.catalog_items)) {
        for (const ci of contrib.output.catalog_items) {
          if (ci && typeof ci === "object" && "item" in ci && "pos" in ci) {
            catalog_items.push({
              item: ci.item as string,
              pos: ci.pos as [number, number, number],
              rotation: ci.rotation as [number, number, number] | undefined,
              scale: ci.scale as number | undefined,
              agentId: contrib.agentId,
              botName: contrib.botName,
            });
          }
        }
      }
      // Merge generated items from this contribution
      if (Array.isArray(contrib.output.generated_items)) {
        for (const gi of contrib.output.generated_items) {
          if (gi && typeof gi === "object" && "url" in gi && "pos" in gi) {
            generated_items.push({
              url: gi.url as string,
              pos: gi.pos as [number, number, number],
              rotation: gi.rotation as [number, number, number] | undefined,
              scale: gi.scale as number | undefined,
              agentId: contrib.agentId,
              botName: contrib.botName,
            });
          }
        }
      }
    }
    return {
      environment: { ...this.worldEnvironment },
      contributions,
      voxels,
      catalog_items,
      generated_items,
      updatedAt: this.worldUpdatedAt,
    };
  }

  // --- Spatial music placements ---

  placeMusic(
    agent: Agent,
    instrumentType: InstrumentType,
    pattern: string,
    position: { x: number; z: number }
  ): { success: true; placement: MusicPlacement } | { success: false; error: string; retryAfter?: number } {
    // Check cooldown
    const cooldownUntil = this.musicPlacementCooldowns.get(agent.id);
    if (cooldownUntil && cooldownUntil > new Date()) {
      const retryAfter = Math.ceil((cooldownUntil.getTime() - Date.now()) / 1000);
      return { success: false, error: "cooldown", retryAfter };
    }

    // Check max placements per agent
    const agentPlacements = this.musicPlacementsByAgent.get(agent.id);
    if (agentPlacements && agentPlacements.size >= MAX_PLACEMENTS_PER_AGENT) {
      return { success: false, error: `max_placements_reached (limit: ${MAX_PLACEMENTS_PER_AGENT})` };
    }

    // Clamp position
    const x = Math.max(-MAX_MUSIC_PLACEMENT_COORD, Math.min(MAX_MUSIC_PLACEMENT_COORD, position.x));
    const z = Math.max(-MAX_MUSIC_PLACEMENT_COORD, Math.min(MAX_MUSIC_PLACEMENT_COORD, position.z));

    const now = new Date().toISOString();
    const placement: MusicPlacement = {
      id: randomUUID(),
      agentId: agent.id,
      botName: agent.name,
      instrumentType,
      pattern,
      position: { x, z },
      createdAt: now,
      updatedAt: now,
    };

    this.musicPlacements.set(placement.id, placement);
    if (!this.musicPlacementsByAgent.has(agent.id)) {
      this.musicPlacementsByAgent.set(agent.id, new Set());
    }
    this.musicPlacementsByAgent.get(agent.id)!.add(placement.id);
    this.musicPlacementsUpdatedAt = now;

    // Set cooldown
    this.musicPlacementCooldowns.set(
      agent.id,
      new Date(Date.now() + MUSIC_PLACEMENT_COOLDOWN_SECONDS * 1000)
    );

    const snapshot = this.getMusicPlacementSnapshot();
    this.broadcast("music_placement_snapshot", snapshot);

    return { success: true, placement };
  }

  updateMusicPlacement(
    agent: Agent,
    placementId: string,
    pattern: string
  ): { success: true; placement: MusicPlacement } | { success: false; error: string } {
    const placement = this.musicPlacements.get(placementId);
    if (!placement) return { success: false, error: "placement_not_found" };
    if (placement.agentId !== agent.id) return { success: false, error: "not_owner" };

    placement.pattern = pattern;
    placement.updatedAt = new Date().toISOString();
    this.musicPlacementsUpdatedAt = placement.updatedAt;

    const snapshot = this.getMusicPlacementSnapshot();
    this.broadcast("music_placement_snapshot", snapshot);

    return { success: true, placement };
  }

  removeMusicPlacement(
    agent: Agent,
    placementId: string
  ): { success: true } | { success: false; error: string } {
    const placement = this.musicPlacements.get(placementId);
    if (!placement) return { success: false, error: "placement_not_found" };
    if (placement.agentId !== agent.id) return { success: false, error: "not_owner" };

    this.musicPlacements.delete(placementId);
    const agentSet = this.musicPlacementsByAgent.get(agent.id);
    if (agentSet) {
      agentSet.delete(placementId);
      if (agentSet.size === 0) this.musicPlacementsByAgent.delete(agent.id);
    }
    this.musicPlacementsUpdatedAt = new Date().toISOString();

    const snapshot = this.getMusicPlacementSnapshot();
    this.broadcast("music_placement_snapshot", snapshot);

    return { success: true };
  }

  getMusicPlacementSnapshot(): MusicPlacementSnapshot {
    const placements: MusicPlacement[] = [];
    for (const placement of this.musicPlacements.values()) {
      placements.push({ ...placement, position: { ...placement.position } });
    }
    return {
      placements,
      updatedAt: this.musicPlacementsUpdatedAt,
    };
  }

  getMusicPlacementCooldownRemaining(agentId: string): number | null {
    const expiresAt = this.musicPlacementCooldowns.get(agentId);
    if (!expiresAt) return null;
    const remaining = Math.ceil((expiresAt.getTime() - Date.now()) / 1000);
    return remaining > 0 ? remaining : null;
  }

  // --- Wayfinding ---

  getWayfindingState(agent: Agent): AgentPositionView {
    return this.wayfinding.getState(agent);
  }

  submitWayfindingAction(agent: Agent, action: WayfindingAction): WayfindingActionResult {
    return this.wayfinding.submitAction(agent, action);
  }

  // --- SSE ---

  addSSEListener(listener: EventListener) {
    this.events.addListener(listener);
  }

  removeSSEListener(listener: EventListener) {
    this.events.removeListener(listener);
  }

  broadcast(event: string, data: unknown) {
    this.events.publish(event, data);
  }

  get sseListenerCount(): number {
    return this.events.count;
  }

  // --- Bot activity log ---

  addBotActivity(entry: BotActivityEntry) {
    this.botActivity.push(entry);
    // Cap at 500 entries to prevent unbounded memory growth
    if (this.botActivity.length > 500) {
      this.botActivity = this.botActivity.slice(-500);
    }
    // Broadcast to dashboard SSE listeners
    this.broadcast("bot_activity", entry);
  }

  getBotActivity(): BotActivityEntry[] {
    return this.botActivity;
  }

  clearBotActivity() {
    this.botActivity = [];
  }

  // --- Presence operations ---

  touchPresence(agentId: string, activity?: string): void {
    const existing = this.agentPresence.get(agentId);
    this.agentPresence.set(agentId, {
      lastSeenAt: new Date(),
      currentActivity: activity ?? existing?.currentActivity ?? null,
    });
  }

  isAgentOnline(agentId: string): boolean {
    const presence = this.agentPresence.get(agentId);
    if (!presence) return false;
    return Date.now() - presence.lastSeenAt.getTime() < PRESENCE_TIMEOUT_MS;
  }

  getOnlineAgents(): AgentPublicProfile[] {
    const result: AgentPublicProfile[] = [];
    for (const [agentId] of this.agents) {
      if (this.isAgentOnline(agentId)) {
        const profile = this.toPublicProfile(agentId);
        if (profile) result.push(profile);
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  getAgentPublicProfile(agentId: string): AgentPublicProfile | null {
    return this.toPublicProfile(agentId);
  }

  getAgentByName(name: string): Agent | null {
    const id = this.nameIndex.get(name);
    if (!id) return null;
    return this.agents.get(id) ?? null;
  }

  private toPublicProfile(agentId: string): AgentPublicProfile | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const presence = this.agentPresence.get(agentId);
    const slotsHeld = this.slots
      .filter((s) => s.agent?.id === agentId)
      .map((s) => s.id);
    const sessionId = this.sessionByAgentId.get(agentId) ?? null;
    let sessionType: string | null = null;
    if (sessionId) {
      const session = this.creativeSessions.get(sessionId);
      sessionType = session?.type ?? null;
    }
    return {
      id: agent.id,
      name: agent.name,
      reputation: agent.reputation,
      totalPlacements: agent.totalPlacements,
      createdAt: agent.createdAt.toISOString(),
      lastSeenAt: presence?.lastSeenAt.toISOString() ?? null,
      online: this.isAgentOnline(agentId),
      currentActivity: presence?.currentActivity ?? null,
      slotsHeld,
      currentSessionId: sessionId,
      currentSessionType: sessionType,
    };
  }

  // --- Messaging operations ---

  addMessage(fromAgent: Agent, content: string, toAgentId?: string | null): AgentMessage {
    const toAgent = toAgentId ? this.agents.get(toAgentId) : null;
    const message: AgentMessage = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      fromId: fromAgent.id,
      fromName: fromAgent.name,
      toId: toAgentId ?? null,
      toName: toAgent?.name ?? null,
      content: content.slice(0, MAX_MESSAGE_CONTENT),
    };
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
    }
    this.broadcast("agent_message", message);
    return message;
  }

  getMessages(forAgentId?: string): AgentMessage[] {
    if (!forAgentId) {
      return this.messages.filter((m) => m.toId === null);
    }
    return this.messages.filter(
      (m) => m.toId === null || m.toId === forAgentId || m.fromId === forAgentId
    );
  }

  // --- World Ritual ---

  submitRitualNomination(agent: Agent, bpm: number | undefined, key: string | undefined, scale: string | undefined, reasoning: string) {
    return this.ritual.submitNomination(agent.id, agent.name, bpm, key, scale, reasoning);
  }

  submitRitualVote(agent: Agent, bpmCandidate: number | undefined, keyCandidate: number | undefined) {
    return this.ritual.submitVote(agent.id, agent.name, bpmCandidate, keyCandidate);
  }

  getRitualView(agentId?: string): RitualPublicView | null {
    return this.ritual.getPublicView(agentId);
  }

  // --- Human chat ---

  checkHumanRateLimit(ipHash: string): boolean {
    const now = Date.now();
    const windowMs = 5_000; // 1 message per 5 seconds
    const entry = this.humanRateLimits.get(ipHash);
    if (!entry || now - entry.windowStart > windowMs) {
      this.humanRateLimits.set(ipHash, { count: 1, windowStart: now });
      return true;
    }
    return false;
  }

  addHumanMessage(
    content: string,
    ipHash: string,
    toAgentId?: string | null
  ): AgentMessage {
    const shortHash = ipHash.slice(0, 4);
    const toAgent = toAgentId ? this.agents.get(toAgentId) : null;
    const message: AgentMessage = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      fromId: `human-${shortHash}`,
      fromName: `visitor-${shortHash}`,
      toId: toAgentId ?? null,
      toName: toAgent?.name ?? null,
      content: content.slice(0, 280),
      senderType: "human",
    };
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
    }
    this.broadcast("agent_message", message);
    return message;
  }

  // --- Storm (broadcast to all agents) ---

  checkStormRateLimit(ipHash: string): boolean {
    const now = Date.now();
    const windowMs = 3_600_000; // 1 storm per hour
    const last = this.stormRateLimits.get(ipHash);
    if (!last || now - last > windowMs) {
      this.stormRateLimits.set(ipHash, now);
      return true;
    }
    return false;
  }

  addStormMessage(content: string, ipHash: string): AgentMessage {
    const shortHash = ipHash.slice(0, 4);
    const message: AgentMessage = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      fromId: `human-${shortHash}`,
      fromName: `visitor-${shortHash}`,
      toId: null,
      toName: null,
      content: content.slice(0, 280),
      senderType: "storm",
    };
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
    }
    this.broadcast("agent_message", message);
    return message;
  }

  // --- Paid directives ---

  addDirective(
    fromAddress: string,
    toAgent: Agent,
    content: string,
    txHash: string
  ): Directive {
    const directive: Directive = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      fromAddress: fromAddress.toLowerCase(),
      toAgentId: toAgent.id,
      toAgentName: toAgent.name,
      content: content.slice(0, 280),
      txHash,
      status: "pending",
      deliveredAt: null,
    };
    this.directives.push(directive);
    // Cap at 200 directives
    if (this.directives.length > 200) {
      this.directives = this.directives.slice(-200);
    }
    this.broadcast("directive_created", {
      id: directive.id,
      toAgentName: directive.toAgentName,
      fromAddress: directive.fromAddress,
    });
    return directive;
  }

  getPendingDirectives(agentId: string): Directive[] {
    return this.directives.filter(
      (d) => d.toAgentId === agentId && d.status === "pending"
    );
  }

  markDirectivesDelivered(agentId: string): number {
    const now = new Date().toISOString();
    let count = 0;
    for (const d of this.directives) {
      if (d.toAgentId === agentId && d.status === "pending") {
        d.status = "delivered";
        d.deliveredAt = now;
        count++;
      }
    }
    return count;
  }

  // --- Admin operations ---

  resetRuntimeState() {
    const clearedSlots = this.slots.filter((s) => s.code || s.agent).length;
    const clearedAgents = this.agents.size;
    const clearedCooldowns = this.cooldowns.size;
    const clearedActivity = this.botActivity.length;

    this.agents.clear();
    this.tokenIndex.clear();
    this.nameIndex.clear();
    this.cooldowns.clear();
    this.agentAvatars.clear();
    this.creativeSessions.clear();
    this.sessionByAgentId.clear();
    this.worldContributions.clear();
    this.worldEnvironment = {};
    this.worldUpdatedAt = null;
    this.musicPlacements.clear();
    this.musicPlacementsByAgent.clear();
    this.musicPlacementCooldowns.clear();
    this.musicPlacementsUpdatedAt = null;
    this.botActivity = [];
    this.agentPresence.clear();
    this.messages = [];
    this.humanRateLimits.clear();
    this.stormRateLimits.clear();
    this.directives = [];
    this.ritual.reset();

    // Reinitialize slots to a clean empty board.
    this.slots = SLOT_DEFINITIONS.map((def, i) => ({
      id: i + 1,
      type: def.type,
      label: def.label,
      code: null,
      agent: null,
      updatedAt: null,
      votes: null,
    }));

    this.wayfinding.reset();

    this.epoch.startedAt = new Date();

    // Push a full composition snapshot so clients can clear quickly.
    this.broadcast("composition", this.getComposition());
    this.broadcast("session_snapshot", this.getSessionSnapshot());
    this.broadcast("jam_snapshot", this.getJamSnapshot());
    this.broadcast("world_snapshot", this.getWorldSnapshot());
    this.broadcast("music_placement_snapshot", this.getMusicPlacementSnapshot());
    this.broadcast("admin_reset", {
      timestamp: new Date().toISOString(),
      clearedSlots,
      clearedAgents,
      clearedCooldowns,
      clearedActivity,
    });

    return {
      clearedSlots,
      clearedAgents,
      clearedCooldowns,
      clearedActivity,
    };
  }

  // --- Private helpers: creative sessions ---

  private toSessionView(session: CreativeSession): CreativeSession {
    return {
      ...session,
      participants: session.participants.map((p) => ({ ...p })),
      meta: { ...session.meta },
    };
  }

  private resolveSessionPosition(
    input: { x?: number; z?: number } | null
  ): SessionPosition {
    let x = Number(input?.x) || 0;
    let z = Number(input?.z) || 0;

    // If no explicit position, pick a random open-space position
    if (!input || (!input.x && !input.z)) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 15 + Math.random() * 20;
      x = Math.cos(angle) * radius;
      z = Math.sin(angle) * radius;
    }

    // Reject positions inside the stage ring
    const distFromCenter = Math.sqrt(x * x + z * z);
    if (distFromCenter < STAGE_EXCLUSION_RADIUS) {
      const scale = (STAGE_EXCLUSION_RADIUS + 2) / Math.max(distFromCenter, 0.01);
      x *= scale;
      z *= scale;
    }

    return { x, z, room: this.deriveRoom(x) };
  }

  private deriveRoom(x: number): SessionRoom {
    if (x >= ROOM_SPLIT_X) return "east_wing";
    if (x <= -ROOM_SPLIT_X) return "west_wing";
    return "center";
  }

  private normalizePattern(pattern: string | null | undefined): string | null {
    if (typeof pattern !== "string") return null;
    const trimmed = pattern.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private broadcastSessionEvent(
    event: string,
    session: CreativeSession,
    botName: string
  ): void {
    const payload = {
      session_id: session.id,
      bot_name: botName,
      type: session.type,
      position: session.position,
      snapshot: this.getSessionSnapshot(),
    };
    this.broadcast(event, payload);
    this.broadcast("session_snapshot", this.getSessionSnapshot());

    // Legacy jam events for music-type sessions
    if (session.type === "music") {
      const jamEventMap: Record<string, string> = {
        session_created: "jam_created",
        session_joined: "jam_joined",
        session_left: "jam_left",
        session_ended: "jam_ended",
        session_output_updated: "jam_pattern_updated",
      };
      const legacyEvent = jamEventMap[event];
      if (legacyEvent) {
        this.broadcast(legacyEvent, {
          jam_id: session.id,
          bot_name: botName,
          room: session.position.room,
          spot_id: session.id,
          snapshot: this.getJamSnapshot(),
        });
        this.broadcast("jam_snapshot", this.getJamSnapshot());
      }
    }
  }

  // Convert a CreativeSession to the legacy JamSession shape
  private sessionToJamView(session: CreativeSession): JamSession {
    return {
      id: session.id,
      spotId: session.id,
      room: session.position.room,
      hostAgentId: session.creatorAgentId,
      hostBotName: session.creatorBotName,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      participants: session.participants.map((p) => ({
        agentId: p.agentId,
        botName: p.botName,
        joinedAt: p.joinedAt,
        pattern: p.pattern,
      })),
    };
  }

  // Legacy jam spot resolver (for /jam/start backward compat)
  private resolveJamSpot(spotId: string | null): JamSpot | null {
    if (spotId) {
      return JAM_SPOTS.find((spot) => spot.id === spotId) ?? null;
    }
    if (JAM_SPOTS.length === 0) return null;
    const index = Math.floor(Math.random() * JAM_SPOTS.length);
    return JAM_SPOTS[index] ?? JAM_SPOTS[0] ?? null;
  }
}

// Singleton
export const state = new State();
