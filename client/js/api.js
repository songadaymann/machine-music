// api.js -- SSE + polling for composition state and activity feed

const API_BASE = window.location.origin + '/api';

// --- State ---
let composition = null;
let jamSnapshot = { spots: [], sessions: [] };
let sessionSnapshot = { sessions: [] };
let worldSnapshot = { environment: {}, contributions: [], updatedAt: null };
let musicPlacementSnapshot = { placements: [], updatedAt: null };
let ritualState = null; // latest ritual state from SSE or poll
let eventSource = null;
let sseReconnectTimer = null;
const listeners = new Set(); // callbacks: (event, data) => void

// --- Public API ---

export function getComposition() { return composition; }
export function getJamSnapshot() { return jamSnapshot; }
export function getSessionSnapshot() { return sessionSnapshot; }
export function getWorldSnapshot() { return worldSnapshot; }
export function getMusicPlacements() { return musicPlacementSnapshot; }
export function getRitualState() { return ritualState; }
export function getApiBase() { return API_BASE; }

export function onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emit(event, data) {
    for (const fn of listeners) {
        try { fn(event, data); } catch (e) { console.error('[api] listener error:', e); }
    }
}

// --- Fetch composition ---

export async function fetchComposition() {
    try {
        const res = await fetch(API_BASE + '/composition');
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        composition = await res.json();
        if (!composition?.slots) {
            throw new Error('invalid composition payload');
        }
        emit('composition', composition);
        return composition;
    } catch (err) {
        console.error('[api] Failed to fetch composition:', err);
        return null;
    }
}

export async function fetchJams() {
    try {
        const res = await fetch(API_BASE + '/jams');
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        jamSnapshot = normalizeJamSnapshot(data);
        emit('jam_snapshot', jamSnapshot);
        return jamSnapshot;
    } catch (err) {
        console.error('[api] Failed to fetch jam snapshot:', err);
        return jamSnapshot;
    }
}

// --- Fetch sessions ---

export async function fetchSessions() {
    try {
        const res = await fetch(API_BASE + '/sessions');
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        sessionSnapshot = normalizeSessionSnapshot(data);
        emit('session_snapshot', sessionSnapshot);
        return sessionSnapshot;
    } catch (err) {
        console.error('[api] Failed to fetch sessions:', err);
        return sessionSnapshot;
    }
}

// --- Fetch world state ---

export async function fetchWorld() {
    try {
        const res = await fetch(API_BASE + '/world');
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        worldSnapshot = await res.json();
        emit('world_snapshot', worldSnapshot);
        return worldSnapshot;
    } catch (err) {
        console.error('[api] Failed to fetch world:', err);
        return worldSnapshot;
    }
}

// --- Fetch music placements ---

export async function fetchMusicPlacements() {
    try {
        const res = await fetch(API_BASE + '/music/placements');
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        musicPlacementSnapshot = await res.json();
        emit('music_placement_snapshot', musicPlacementSnapshot);
        return musicPlacementSnapshot;
    } catch (err) {
        console.error('[api] Failed to fetch music placements:', err);
        return musicPlacementSnapshot;
    }
}

// --- Fetch ritual state ---

export async function fetchRitual() {
    try {
        const res = await fetch(API_BASE + '/ritual');
        if (!res.ok) {
            ritualState = null;
            return null;
        }
        ritualState = await res.json();
        emit('ritual_state', ritualState);
        return ritualState;
    } catch (err) {
        console.error('[api] Failed to fetch ritual:', err);
        return null;
    }
}

// --- Fetch activity log ---

export async function fetchActivity() {
    try {
        const res = await fetch(API_BASE + '/activity');
        const data = await res.json();
        return data;
    } catch (err) {
        console.error('[api] Failed to fetch activity:', err);
        return [];
    }
}

// --- SSE connection ---

export function connectSSE() {
    if (eventSource) eventSource.close();
    if (sseReconnectTimer) clearTimeout(sseReconnectTimer);

    eventSource = new EventSource(API_BASE + '/stream');

    const applyJamPayload = (payload) => {
        if (!payload) return;
        if (payload.spots && payload.sessions) {
            jamSnapshot = normalizeJamSnapshot(payload);
        } else if (payload.snapshot) {
            jamSnapshot = normalizeJamSnapshot(payload.snapshot);
        }
        emit('jam_snapshot', jamSnapshot);
    };

    eventSource.addEventListener('connected', () => {
        emit('connection', { status: 'connected' });
    });

    eventSource.addEventListener('slot_update', (e) => {
        const data = JSON.parse(e.data);
        // Update local composition state
        if (composition) {
            const slot = composition.slots.find(s => s.id === data.slot);
            if (slot) {
                slot.code = data.code;
                slot.agent = data.agent;
                slot.votes = { up: 0, down: 0 };
            }
        }
        emit('slot_update', data);
    });

    eventSource.addEventListener('avatar_updated', (e) => {
        const data = JSON.parse(e.data);
        if (composition && data?.botName) {
            for (const slot of composition.slots) {
                if (slot.agent?.name === data.botName) {
                    slot.agent.avatarGlbUrl = data.avatarGlbUrl || null;
                    slot.agent.avatarHeight =
                        typeof data.avatarHeight === 'number' ? data.avatarHeight : null;
                }
            }
        }
        emit('avatar_updated', data);
    });

    eventSource.addEventListener('avatar_generating', (e) => {
        const data = JSON.parse(e.data);
        emit('avatar_generating', data);
    });

    eventSource.addEventListener('bot_activity', (e) => {
        const data = JSON.parse(e.data);
        emit('bot_activity', data);
    });

    eventSource.addEventListener('agent_message', (e) => {
        const data = JSON.parse(e.data);
        emit('agent_message', data);
    });

    eventSource.addEventListener('composition', (e) => {
        const data = JSON.parse(e.data);
        if (data?.slots) {
            composition = data;
            emit('composition', composition);
        }
    });

    eventSource.addEventListener('jam_snapshot', (e) => {
        const data = JSON.parse(e.data);
        applyJamPayload(data);
    });

    eventSource.addEventListener('jam_created', (e) => {
        const data = JSON.parse(e.data);
        applyJamPayload(data);
        emit('jam_event', { type: 'jam_created', ...data });
    });

    eventSource.addEventListener('jam_joined', (e) => {
        const data = JSON.parse(e.data);
        applyJamPayload(data);
        emit('jam_event', { type: 'jam_joined', ...data });
    });

    eventSource.addEventListener('jam_left', (e) => {
        const data = JSON.parse(e.data);
        applyJamPayload(data);
        emit('jam_event', { type: 'jam_left', ...data });
    });

    eventSource.addEventListener('jam_pattern_updated', (e) => {
        const data = JSON.parse(e.data);
        applyJamPayload(data);
        emit('jam_event', { type: 'jam_pattern_updated', ...data });
    });

    eventSource.addEventListener('jam_ended', (e) => {
        const data = JSON.parse(e.data);
        applyJamPayload(data);
        emit('jam_event', { type: 'jam_ended', ...data });
    });

    // --- Creative session events ---

    const applySessionPayload = (payload) => {
        if (!payload) return;
        if (payload.sessions) {
            sessionSnapshot = normalizeSessionSnapshot(payload);
        } else if (payload.snapshot) {
            sessionSnapshot = normalizeSessionSnapshot(payload.snapshot);
        }
        emit('session_snapshot', sessionSnapshot);
    };

    eventSource.addEventListener('session_snapshot', (e) => {
        const data = JSON.parse(e.data);
        applySessionPayload(data);
    });

    eventSource.addEventListener('session_created', (e) => {
        const data = JSON.parse(e.data);
        applySessionPayload(data);
        emit('session_event', { type: 'session_created', ...data });
    });

    eventSource.addEventListener('session_joined', (e) => {
        const data = JSON.parse(e.data);
        applySessionPayload(data);
        emit('session_event', { type: 'session_joined', ...data });
    });

    eventSource.addEventListener('session_left', (e) => {
        const data = JSON.parse(e.data);
        applySessionPayload(data);
        emit('session_event', { type: 'session_left', ...data });
    });

    eventSource.addEventListener('session_output_updated', (e) => {
        const data = JSON.parse(e.data);
        applySessionPayload(data);
        emit('session_event', { type: 'session_output_updated', ...data });
    });

    eventSource.addEventListener('session_ended', (e) => {
        const data = JSON.parse(e.data);
        applySessionPayload(data);
        emit('session_event', { type: 'session_ended', ...data });
    });

    // --- World state events ---

    eventSource.addEventListener('world_snapshot', (e) => {
        const data = JSON.parse(e.data);
        worldSnapshot = data;
        emit('world_snapshot', worldSnapshot);
    });

    // --- Spatial music placement events ---

    eventSource.addEventListener('music_placement_snapshot', (e) => {
        const data = JSON.parse(e.data);
        musicPlacementSnapshot = data;
        emit('music_placement_snapshot', musicPlacementSnapshot);
    });

    // --- Ritual events ---

    eventSource.addEventListener('ritual_phase', (e) => {
        const data = JSON.parse(e.data);
        // Merge SSE data into ritualState (SSE gives partial updates)
        if (data.phase === 'idle') {
            ritualState = null;
        } else if (ritualState) {
            ritualState = { ...ritualState, ...data };
        } else {
            ritualState = data;
        }
        emit('ritual_phase', data);
    });

    eventSource.addEventListener('ritual_nomination', (e) => {
        const data = JSON.parse(e.data);
        if (ritualState) {
            ritualState.bpmNominationCount = data.bpmNominationCount;
            ritualState.keyNominationCount = data.keyNominationCount;
        }
        emit('ritual_nomination', data);
    });

    eventSource.addEventListener('ritual_vote', (e) => {
        const data = JSON.parse(e.data);
        // Update vote counts on candidates
        if (ritualState && data.bpmVoteCounts) {
            const candidates = ritualState.bpmCandidates || [];
            data.bpmVoteCounts.forEach((count, i) => {
                if (candidates[i]) candidates[i].votes = count;
            });
        }
        if (ritualState && data.keyVoteCounts) {
            const candidates = ritualState.keyCandidates || [];
            data.keyVoteCounts.forEach((count, i) => {
                if (candidates[i]) candidates[i].votes = count;
            });
        }
        emit('ritual_vote', data);
    });

    eventSource.addEventListener('epoch_changed', (e) => {
        const data = JSON.parse(e.data);
        emit('epoch_changed', data);
    });

    // --- Wayfinding position events ---

    eventSource.addEventListener('bot_nav_path_started', (e) => {
        const data = JSON.parse(e.data);
        emit('wayfinding_move', data);
    });

    eventSource.addEventListener('bot_nav_arrived', (e) => {
        const data = JSON.parse(e.data);
        emit('wayfinding_arrived', data);
    });

    eventSource.addEventListener('bot_presence_changed', (e) => {
        const data = JSON.parse(e.data);
        emit('wayfinding_presence', data);
    });

    eventSource.onerror = () => {
        emit('connection', { status: 'polling' });
        eventSource.close();
        sseReconnectTimer = setTimeout(connectSSE, 10000);
    };
}

// --- Polling fallback ---

let pollTimer = null;

export function startPolling(intervalMs = 5000) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
        fetchComposition();
        fetchJams();
        fetchSessions();
        fetchWorld();
        fetchMusicPlacements();
    }, intervalMs);
}

export function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

// --- Init (call once) ---

export async function init() {
    await fetchComposition();
    await fetchJams();
    await fetchSessions();
    await fetchWorld();
    await fetchMusicPlacements();
    connectSSE();
    startPolling(5000);
}

export async function fetchMessages() {
    try {
        const res = await fetch(API_BASE + '/agents/messages');
        return await res.json();
    } catch (err) {
        console.error('[api] Failed to fetch messages:', err);
        return [];
    }
}

function normalizeJamSnapshot(input) {
    const spots = Array.isArray(input?.spots) ? input.spots : [];
    const sessions = Array.isArray(input?.sessions) ? input.sessions : [];
    return { spots, sessions };
}

function normalizeSessionSnapshot(input) {
    const sessions = Array.isArray(input?.sessions) ? input.sessions : [];
    return { sessions };
}
