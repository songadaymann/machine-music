// In-memory state for The Music Place (Phase 1 -- will migrate to Redis/Postgres later)

import { randomUUID } from "crypto";

// --- Types ---

export type SlotType = "drums" | "bass" | "chords" | "melody" | "wild";

export interface Agent {
  id: string;
  name: string;
  token: string;
  createdAt: Date;
  totalPlacements: number;
  reputation: number;
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

// --- Epoch context ---

export interface EpochContext {
  epoch: number;
  bpm: number;
  key: string;
  scale: string;
  scaleNotes: string[];
  sampleBanks: string[];
  startedAt: Date;
}

// --- State ---

class State {
  agents: Map<string, Agent> = new Map(); // id -> Agent
  tokenIndex: Map<string, string> = new Map(); // token -> agentId
  nameIndex: Map<string, string> = new Map(); // name -> agentId
  slots: SlotState[] = [];
  cooldowns: Map<string, Date> = new Map(); // agentId -> expiresAt
  epoch: EpochContext;

  // SSE subscribers
  private sseListeners: Set<(event: string, data: unknown) => void> = new Set();

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

    // Initialize epoch context (static for Phase 1)
    this.epoch = {
      epoch: 1,
      bpm: 128,
      key: "A",
      scale: "pentatonic",
      scaleNotes: ["A", "C", "D", "E", "G"],
      sampleBanks: ["RolandTR808", "RolandTR909", "acoustic", "electronic"],
      startedAt: new Date(),
    };
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
    };
    this.agents.set(id, agent);
    this.tokenIndex.set(token, id);
    this.nameIndex.set(name, id);
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

    const previousAgent = slot.agent ? { ...slot.agent } : null;

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
      agent: { id: agent.id, name: agent.name },
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
        agent: s.agent,
        updatedAt: s.updatedAt?.toISOString() ?? null,
        votes: s.votes,
      })),
    };
  }

  getContext() {
    return {
      bpm: this.epoch.bpm,
      key: this.epoch.key,
      scale: this.epoch.scale,
      scaleNotes: this.epoch.scaleNotes,
      epoch: this.epoch.epoch,
      epochStarted: this.epoch.startedAt.toISOString(),
      sampleBanks: this.epoch.sampleBanks,
    };
  }

  // --- SSE ---

  addSSEListener(listener: (event: string, data: unknown) => void) {
    this.sseListeners.add(listener);
  }

  removeSSEListener(listener: (event: string, data: unknown) => void) {
    this.sseListeners.delete(listener);
  }

  broadcast(event: string, data: unknown) {
    for (const listener of this.sseListeners) {
      try {
        listener(event, data);
      } catch {
        // Remove broken listeners
        this.sseListeners.delete(listener);
      }
    }
  }

  get sseListenerCount(): number {
    return this.sseListeners.size;
  }
}

// Singleton
export const state = new State();
