// World Ritual runtime — periodic server-driven BPM & key voting
import { randomUUID } from "crypto";
import { computeScaleNotes, isValidKey, isValidScale, MIN_BPM, MAX_BPM, VALID_KEYS_LIST, VALID_SCALES } from "./music-theory";

// --- Timing constants (override via env vars for testing) ---
export const RITUAL_INTERVAL_MS = parseInt(process.env.RITUAL_INTERVAL_MS ?? "600000", 10);  // default 10 min
export const NOMINATE_DURATION_MS = parseInt(process.env.NOMINATE_DURATION_MS ?? "90000", 10); // default 90s
export const VOTE_DURATION_MS = parseInt(process.env.VOTE_DURATION_MS ?? "60000", 10);         // default 60s
export const RESULT_DISPLAY_MS = parseInt(process.env.RESULT_DISPLAY_MS ?? "30000", 10);       // default 30s

const MIN_UNIQUE_NOMINATIONS = 2; // minimum unique nominations for a valid vote
const MAX_CANDIDATES = 3;         // top N nominations that proceed to vote

// --- Types ---

export type RitualPhase = "idle" | "nominate" | "vote" | "result";

export interface BpmNomination {
  agentId: string;
  agentName: string;
  bpm: number;
  reasoning: string;
  submittedAt: string;
}

export interface KeyNomination {
  agentId: string;
  agentName: string;
  key: string;
  scale: string;
  reasoning: string;
  submittedAt: string;
}

export interface BpmCandidate {
  index: number;
  bpm: number;
  nominatedBy: string; // agent name
  nominatedByAgentId: string;
  votes: number;
}

export interface KeyCandidate {
  index: number;
  key: string;
  scale: string;
  nominatedBy: string;
  nominatedByAgentId: string;
  votes: number;
}

interface RitualVote {
  agentId: string;
  candidateIndex: number;
}

export interface RitualState {
  id: string;
  phase: RitualPhase;
  phaseStartedAt: string;
  phaseEndsAt: string;
  ritualNumber: number;
  bpmNominations: BpmNomination[];
  keyNominations: KeyNomination[];
  bpmCandidates: BpmCandidate[];
  keyCandidates: KeyCandidate[];
  bpmVotes: RitualVote[];
  keyVotes: RitualVote[];
  bpmWinner: BpmCandidate | null;
  keyWinner: KeyCandidate | null;
  previousEpoch: { bpm: number; key: string; scale: string } | null;
}

export interface RitualPublicView {
  id: string;
  phase: RitualPhase;
  phaseStartedAt: string;
  phaseEndsAt: string;
  phaseRemainingSeconds: number;
  ritualNumber: number;
  bpmNominationCount: number;
  keyNominationCount: number;
  bpmCandidates: BpmCandidate[];
  keyCandidates: KeyCandidate[];
  bpmWinner: BpmCandidate | null;
  keyWinner: KeyCandidate | null;
  hasNominatedBpm: boolean;
  hasNominatedKey: boolean;
  hasVotedBpm: boolean;
  hasVotedKey: boolean;
  previousEpoch: { bpm: number; key: string; scale: string } | null;
}

type NominationResult =
  | { success: true; bpmNominationCount: number; keyNominationCount: number }
  | { success: false; error: string };

type VoteResult =
  | { success: true; bpmVoteCounts: number[]; keyVoteCounts: number[] }
  | { success: false; error: string };

export interface RitualDeps {
  getOnlineAgentCount: () => number;
  getCurrentEpoch: () => { bpm: number; key: string; scale: string };
  applyNewEpoch: (bpm: number, key: string, scale: string, scaleNotes: string[]) => void;
  broadcast: (event: string, data: unknown) => void;
}

// --- Runtime ---

export class RitualRuntime {
  private state: RitualState | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private ritualCounter = 0;

  constructor(private deps: RitualDeps) {}

  start() {
    this.stop();
    this.intervalTimer = setInterval(() => this.beginRitual(), RITUAL_INTERVAL_MS);
  }

  stop() {
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.intervalTimer = null;
    this.phaseTimer = null;
  }

  reset() {
    this.stop();
    this.state = null;
    this.ritualCounter = 0;
    this.start();
  }

  // --- Phase transitions ---

  private beginRitual() {
    this.ritualCounter++;

    // No agents online — skip nomination/vote, just randomize immediately
    if (this.deps.getOnlineAgentCount() === 0) {
      this.fizzle();
      return;
    }
    const now = new Date();
    const endsAt = new Date(now.getTime() + NOMINATE_DURATION_MS);

    this.state = {
      id: randomUUID(),
      phase: "nominate",
      phaseStartedAt: now.toISOString(),
      phaseEndsAt: endsAt.toISOString(),
      ritualNumber: this.ritualCounter,
      bpmNominations: [],
      keyNominations: [],
      bpmCandidates: [],
      keyCandidates: [],
      bpmVotes: [],
      keyVotes: [],
      bpmWinner: null,
      keyWinner: null,
      previousEpoch: { ...this.deps.getCurrentEpoch() },
    };

    this.broadcastPhase();
    this.schedulePhaseTimer(NOMINATE_DURATION_MS);
  }

  private advanceToVote() {
    if (!this.state || this.state.phase !== "nominate") return;

    // Tally BPM nominations → top 3
    this.state.bpmCandidates = this.tallyBpmNominations();
    this.state.keyCandidates = this.tallyKeyNominations();

    const bpmHasEnough = this.state.bpmCandidates.length >= MIN_UNIQUE_NOMINATIONS;
    const keyHasEnough = this.state.keyCandidates.length >= MIN_UNIQUE_NOMINATIONS;

    if (!bpmHasEnough && !keyHasEnough) {
      // Both fizzled — skip vote entirely
      this.fizzle();
      return;
    }

    const now = new Date();
    const endsAt = new Date(now.getTime() + VOTE_DURATION_MS);
    this.state.phase = "vote";
    this.state.phaseStartedAt = now.toISOString();
    this.state.phaseEndsAt = endsAt.toISOString();

    this.broadcastPhase();
    this.schedulePhaseTimer(VOTE_DURATION_MS);
  }

  private advanceToResult() {
    if (!this.state || this.state.phase !== "vote") return;

    const rand = this.randomEpoch();
    let newBpm = rand.bpm;       // default: random
    let newKey = rand.key;        // default: random
    let newScale = rand.scale;    // default: random

    // Resolve BPM winner (overrides random if votes exist)
    if (this.state.bpmCandidates.length > 0) {
      const bpmWinner = this.resolveWinner(this.state.bpmCandidates, this.state.bpmVotes);
      if (bpmWinner) {
        this.state.bpmWinner = bpmWinner;
        newBpm = bpmWinner.bpm;
      }
    }

    // Resolve key winner (overrides random if votes exist)
    if (this.state.keyCandidates.length > 0) {
      const keyWinner = this.resolveWinner(this.state.keyCandidates, this.state.keyVotes);
      if (keyWinner) {
        this.state.keyWinner = keyWinner as KeyCandidate;
        newKey = (keyWinner as KeyCandidate).key;
        newScale = (keyWinner as KeyCandidate).scale;
      }
    }

    // Always apply — either voted values or random fallback
    const scaleNotes = computeScaleNotes(newKey, newScale);
    this.deps.applyNewEpoch(newBpm, newKey, newScale, scaleNotes);

    const now = new Date();
    const endsAt = new Date(now.getTime() + RESULT_DISPLAY_MS);
    this.state.phase = "result";
    this.state.phaseStartedAt = now.toISOString();
    this.state.phaseEndsAt = endsAt.toISOString();

    this.broadcastPhase();
    this.schedulePhaseTimer(RESULT_DISPLAY_MS);
  }

  private advanceToIdle() {
    this.state = null;
    this.deps.broadcast("ritual_phase", { phase: "idle", ritualNumber: this.ritualCounter });
  }

  private fizzle() {
    // No successful vote — randomize BPM and key so the world always evolves
    const { bpm, key, scale } = this.randomEpoch();
    const scaleNotes = computeScaleNotes(key, scale);
    this.deps.applyNewEpoch(bpm, key, scale, scaleNotes);

    this.state = null;
    this.deps.broadcast("ritual_phase", {
      phase: "idle",
      ritualNumber: this.ritualCounter,
      fizzled: true,
      randomized: { bpm, key, scale },
    });
  }

  private randomEpoch(): { bpm: number; key: string; scale: string } {
    const bpm = MIN_BPM + Math.floor(Math.random() * (MAX_BPM - MIN_BPM + 1));
    const key = VALID_KEYS_LIST[Math.floor(Math.random() * VALID_KEYS_LIST.length)] ?? "C";
    const scale = VALID_SCALES[Math.floor(Math.random() * VALID_SCALES.length)] ?? "pentatonic";
    return { bpm, key, scale };
  }

  private schedulePhaseTimer(ms: number) {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = setTimeout(() => {
      if (!this.state) return;
      switch (this.state.phase) {
        case "nominate": this.advanceToVote(); break;
        case "vote": this.advanceToResult(); break;
        case "result": this.advanceToIdle(); break;
      }
    }, ms);
  }

  private broadcastPhase() {
    if (!this.state) return;
    this.deps.broadcast("ritual_phase", {
      phase: this.state.phase,
      phaseEndsAt: this.state.phaseEndsAt,
      ritualNumber: this.state.ritualNumber,
      bpmCandidates: this.state.bpmCandidates,
      keyCandidates: this.state.keyCandidates,
      bpmWinner: this.state.bpmWinner,
      keyWinner: this.state.keyWinner,
    });
  }

  // --- Tallying ---

  private tallyBpmNominations(): BpmCandidate[] {
    const groups = new Map<number, { count: number; first: BpmNomination }>();
    for (const nom of this.state!.bpmNominations) {
      const existing = groups.get(nom.bpm);
      if (existing) {
        existing.count++;
      } else {
        groups.set(nom.bpm, { count: 1, first: nom });
      }
    }
    return [...groups.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[1].first.submittedAt.localeCompare(b[1].first.submittedAt))
      .slice(0, MAX_CANDIDATES)
      .map(([bpm, { first }], i) => ({
        index: i + 1,
        bpm,
        nominatedBy: first.agentName,
        nominatedByAgentId: first.agentId,
        votes: 0,
      }));
  }

  private tallyKeyNominations(): KeyCandidate[] {
    const groups = new Map<string, { count: number; first: KeyNomination }>();
    for (const nom of this.state!.keyNominations) {
      const tuple = `${nom.key}:${nom.scale}`;
      const existing = groups.get(tuple);
      if (existing) {
        existing.count++;
      } else {
        groups.set(tuple, { count: 1, first: nom });
      }
    }
    return [...groups.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[1].first.submittedAt.localeCompare(b[1].first.submittedAt))
      .slice(0, MAX_CANDIDATES)
      .map(([, { first }], i) => ({
        index: i + 1,
        key: first.key,
        scale: first.scale,
        nominatedBy: first.agentName,
        nominatedByAgentId: first.agentId,
        votes: 0,
      }));
  }

  private resolveWinner<T extends { index: number; votes: number }>(
    candidates: T[],
    votes: RitualVote[]
  ): T | null {
    // Count votes
    for (const v of votes) {
      const c = candidates.find((c) => c.index === v.candidateIndex);
      if (c) c.votes++;
    }
    if (votes.length === 0) return null;
    // Sort by votes desc, then by index asc (earlier = tie-breaker)
    const sorted = [...candidates].sort((a, b) => b.votes - a.votes || a.index - b.index);
    return sorted[0] ?? null;
  }

  // --- Submission handlers ---

  submitNomination(
    agentId: string,
    agentName: string,
    bpm: number | undefined,
    key: string | undefined,
    scale: string | undefined,
    reasoning: string
  ): NominationResult {
    if (!this.state || this.state.phase !== "nominate") {
      return { success: false, error: "not_in_nominate_phase" };
    }
    if (bpm === undefined && key === undefined) {
      return { success: false, error: "bpm_or_key_required" };
    }

    const now = new Date().toISOString();

    if (bpm !== undefined) {
      if (this.state.bpmNominations.some((n) => n.agentId === agentId)) {
        return { success: false, error: "already_nominated_bpm" };
      }
      this.state.bpmNominations.push({ agentId, agentName, bpm, reasoning, submittedAt: now });
    }

    if (key !== undefined) {
      if (this.state.keyNominations.some((n) => n.agentId === agentId)) {
        return { success: false, error: "already_nominated_key" };
      }
      this.state.keyNominations.push({
        agentId,
        agentName,
        key,
        scale: scale ?? "pentatonic",
        reasoning,
        submittedAt: now,
      });
    }

    this.deps.broadcast("ritual_nomination", {
      ritualNumber: this.state.ritualNumber,
      agentName,
      bpmNominationCount: this.state.bpmNominations.length,
      keyNominationCount: this.state.keyNominations.length,
    });

    return {
      success: true,
      bpmNominationCount: this.state.bpmNominations.length,
      keyNominationCount: this.state.keyNominations.length,
    };
  }

  submitVote(
    agentId: string,
    agentName: string,
    bpmCandidate: number | undefined,
    keyCandidate: number | undefined
  ): VoteResult {
    if (!this.state || this.state.phase !== "vote") {
      return { success: false, error: "not_in_vote_phase" };
    }
    if (bpmCandidate === undefined && keyCandidate === undefined) {
      return { success: false, error: "bpm_or_key_candidate_required" };
    }

    if (bpmCandidate !== undefined) {
      if (this.state.bpmVotes.some((v) => v.agentId === agentId)) {
        return { success: false, error: "already_voted_bpm" };
      }
      const candidate = this.state.bpmCandidates.find((c) => c.index === bpmCandidate);
      if (!candidate) {
        return { success: false, error: "invalid_bpm_candidate" };
      }
      if (candidate.nominatedByAgentId === agentId) {
        return { success: false, error: "cannot_vote_own_bpm" };
      }
      this.state.bpmVotes.push({ agentId, candidateIndex: bpmCandidate });
    }

    if (keyCandidate !== undefined) {
      if (this.state.keyVotes.some((v) => v.agentId === agentId)) {
        return { success: false, error: "already_voted_key" };
      }
      const candidate = this.state.keyCandidates.find((c) => c.index === keyCandidate);
      if (!candidate) {
        return { success: false, error: "invalid_key_candidate" };
      }
      if (candidate.nominatedByAgentId === agentId) {
        return { success: false, error: "cannot_vote_own_key" };
      }
      this.state.keyVotes.push({ agentId, candidateIndex: keyCandidate });
    }

    const bpmVoteCounts = this.state.bpmCandidates.map(
      (c) => this.state!.bpmVotes.filter((v) => v.candidateIndex === c.index).length
    );
    const keyVoteCounts = this.state.keyCandidates.map(
      (c) => this.state!.keyVotes.filter((v) => v.candidateIndex === c.index).length
    );

    this.deps.broadcast("ritual_vote", {
      ritualNumber: this.state.ritualNumber,
      agentName,
      bpmVoteCounts,
      keyVoteCounts,
    });

    return { success: true, bpmVoteCounts, keyVoteCounts };
  }

  // --- Public view ---

  getPublicView(agentId?: string): RitualPublicView | null {
    if (!this.state) return null;

    const now = Date.now();
    const endsAt = new Date(this.state.phaseEndsAt).getTime();
    const remaining = Math.max(0, Math.ceil((endsAt - now) / 1000));

    // Strip nominatedByAgentId from public view of candidates
    const cleanBpmCandidates = this.state.bpmCandidates.map((c) => ({
      index: c.index,
      bpm: c.bpm,
      nominatedBy: c.nominatedBy,
      nominatedByAgentId: c.nominatedByAgentId,
      votes: this.state!.bpmVotes.filter((v) => v.candidateIndex === c.index).length,
    }));
    const cleanKeyCandidates = this.state.keyCandidates.map((c) => ({
      index: c.index,
      key: c.key,
      scale: c.scale,
      nominatedBy: c.nominatedBy,
      nominatedByAgentId: c.nominatedByAgentId,
      votes: this.state!.keyVotes.filter((v) => v.candidateIndex === c.index).length,
    }));

    return {
      id: this.state.id,
      phase: this.state.phase,
      phaseStartedAt: this.state.phaseStartedAt,
      phaseEndsAt: this.state.phaseEndsAt,
      phaseRemainingSeconds: remaining,
      ritualNumber: this.state.ritualNumber,
      bpmNominationCount: this.state.bpmNominations.length,
      keyNominationCount: this.state.keyNominations.length,
      bpmCandidates: cleanBpmCandidates,
      keyCandidates: cleanKeyCandidates,
      bpmWinner: this.state.bpmWinner,
      keyWinner: this.state.keyWinner,
      hasNominatedBpm: agentId ? this.state.bpmNominations.some((n) => n.agentId === agentId) : false,
      hasNominatedKey: agentId ? this.state.keyNominations.some((n) => n.agentId === agentId) : false,
      hasVotedBpm: agentId ? this.state.bpmVotes.some((v) => v.agentId === agentId) : false,
      hasVotedKey: agentId ? this.state.keyVotes.some((v) => v.agentId === agentId) : false,
      previousEpoch: this.state.previousEpoch,
    };
  }
}
