// api.js -- SSE + polling for composition state and activity feed

const API_BASE = window.location.origin + '/api';

// --- State ---
let composition = null;
let eventSource = null;
let sseReconnectTimer = null;
const listeners = new Set(); // callbacks: (event, data) => void

// --- Public API ---

export function getComposition() { return composition; }
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
        composition = await res.json();
        emit('composition', composition);
        return composition;
    } catch (err) {
        console.error('[api] Failed to fetch composition:', err);
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

    eventSource.addEventListener('bot_activity', (e) => {
        const data = JSON.parse(e.data);
        emit('bot_activity', data);
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
    pollTimer = setInterval(fetchComposition, intervalMs);
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
    connectSSE();
    startPolling(5000);
}
