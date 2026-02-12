// music.js -- Strudel audio integration
// Manages the offscreen strudel-editor web component, pattern building,
// sanitization, per-slot mute/solo, and playback.

import { getComposition } from './api.js';

// --- State ---
let isPlaying = false;
let editorReady = false;
const mutedSlots = new Set();   // slot IDs that are muted
let soloSlot = null;            // slot ID that is solo'd (null = none)
const onChangeCallbacks = new Set();

// --- Public API ---

export function getIsPlaying() { return isPlaying; }
export function getMutedSlots() { return mutedSlots; }
export function getSoloSlot() { return soloSlot; }

export function onChange(fn) {
    onChangeCallbacks.add(fn);
    return () => onChangeCallbacks.delete(fn);
}

function emitChange() {
    for (const fn of onChangeCallbacks) {
        try { fn(); } catch (e) { console.error('[music] onChange error:', e); }
    }
}

// --- Mute / Solo ---

export function toggleMute(slotId) {
    if (mutedSlots.has(slotId)) {
        mutedSlots.delete(slotId);
    } else {
        mutedSlots.add(slotId);
    }
    if (isPlaying) updatePatterns();
    emitChange();
}

export function toggleSolo(slotId) {
    soloSlot = (soloSlot === slotId) ? null : slotId;
    if (isPlaying) updatePatterns();
    emitChange();
}

// --- Strudel editor access ---

function getEditor() {
    const el = document.getElementById('strudel-repl');
    return el?.editor || null;
}

function waitForEditor(maxWait = 8000) {
    return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
            const ed = getEditor();
            if (ed && ed.repl) return resolve(ed);
            if (Date.now() - start > maxWait) return resolve(null);
            setTimeout(check, 200);
        };
        check();
    });
}

// --- Sanitization ---

function sanitizePattern(code) {
    if (/\.voicings\s*\(/.test(code)) {
        console.warn('[music] EXCLUDING pattern with voicings():', code.slice(0, 60));
        return null;
    }
    // Fix unquoted mini-notation: note(<[a3 c4]>) -> note("<[a3 c4]>")
    code = code.replace(/\b(note|s|n)\s*\(\s*(<[^>]+>)\s*\)/g, '$1("$2")');
    // Fix comma in brackets: [Am7,C] -> [Am7 C]
    code = code.replace(/\[([^\]]*),([^\]]*)\]/g, '[$1 $2]');
    return code;
}

// --- Pattern building ---

function buildPattern() {
    const composition = getComposition();
    if (!composition) return null;

    const activeSlots = composition.slots.filter(s => s.code);
    if (activeSlots.length === 0) return null;

    const patterns = [];
    for (const slot of activeSlots) {
        // Apply mute/solo
        if (soloSlot !== null && slot.id !== soloSlot) continue;
        if (mutedSlots.has(slot.id)) continue;

        const sanitized = sanitizePattern(slot.code);
        if (sanitized !== null) {
            patterns.push(`(${sanitized})`);
        }
    }

    if (patterns.length === 0) return null;
    return `stack(${patterns.join(',\n')})`;
}

// --- Playback ---

export async function start() {
    const pattern = buildPattern();
    if (!pattern) {
        console.warn('[music] No active slots to play');
        return false;
    }

    try {
        const ed = await waitForEditor();
        if (!ed) {
            console.warn('[music] Audio engine not ready');
            return false;
        }

        const el = document.getElementById('strudel-repl');
        el.setAttribute('code', pattern);
        await ed.evaluate();

        isPlaying = true;
        emitChange();
        return true;
    } catch (err) {
        console.error('[music] Strudel error, trying fallback:', err);
        return await startWithFallback();
    }
}

async function startWithFallback() {
    const composition = getComposition();
    if (!composition) return false;

    const activeSlots = composition.slots.filter(s => s.code);
    const working = [];

    for (const slot of activeSlots) {
        if (soloSlot !== null && slot.id !== soloSlot) continue;
        if (mutedSlots.has(slot.id)) continue;

        const sanitized = sanitizePattern(slot.code);
        if (!sanitized) continue;

        try {
            const el = document.getElementById('strudel-repl');
            el.setAttribute('code', `(${sanitized}).gain(0)`);
            const ed = getEditor();
            await ed.evaluate();
            working.push(`(${sanitized})`);
        } catch {
            console.warn(`[music] Slot ${slot.id} failed, skipping`);
        }
    }

    if (working.length === 0) return false;

    const el = document.getElementById('strudel-repl');
    const pattern = `stack(${working.join(',\n')})`;
    el.setAttribute('code', pattern);
    const ed = getEditor();
    await ed.evaluate();

    isPlaying = true;
    emitChange();
    return true;
}

export async function updatePatterns() {
    if (!isPlaying) return;
    const pattern = buildPattern();
    if (!pattern) return;

    try {
        const ed = getEditor();
        if (ed) {
            const el = document.getElementById('strudel-repl');
            el.setAttribute('code', pattern);
            await ed.evaluate();
        }
    } catch (err) {
        console.error('[music] Failed to update patterns:', err);
    }
}

export function stop() {
    try {
        const ed = getEditor();
        if (ed?.repl?.stop) {
            ed.repl.stop();
        }
    } catch (err) {
        console.error('[music] Failed to stop:', err);
    }
    isPlaying = false;
    emitChange();
}

export function toggle() {
    if (isPlaying) stop();
    else start();
}

// --- Audio analyser (for visualization) ---

let analyser = null;
let analyserData = null;

export function getAnalyserData() {
    if (!analyser) {
        // Try to grab the AudioContext from Strudel
        try {
            const ed = getEditor();
            const ctx = ed?.repl?.scheduler?.audioContext
                || ed?.repl?.audioContext
                || null;
            if (ctx) {
                analyser = ctx.createAnalyser();
                analyser.fftSize = 256;
                analyserData = new Uint8Array(analyser.frequencyBinCount);
                // Connect to destination
                ctx.destination.connect && ctx.destination.connect(analyser);
            }
        } catch { /* not ready yet */ }
    }

    if (analyser && analyserData) {
        analyser.getByteFrequencyData(analyserData);
        return analyserData;
    }
    return null;
}
