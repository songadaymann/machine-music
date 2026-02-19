// music.js -- Strudel audio integration
// Manages the offscreen strudel-editor web component, pattern building,
// sanitization, per-slot mute/solo, and playback.

import { getComposition } from './api.js';

// --- State ---
let isPlaying = false;
let editorReady = false;
const mutedSlots = new Set();   // slot IDs that are muted
let soloSlot = null;            // slot ID that is solo'd (null = none)
const slotLevels = new Map();   // slot ID -> gain (0..2)
let masterGain = 1;             // master gain (0..2)
const onChangeCallbacks = new Set();
const MIXER_STORAGE_KEY = 'synthmob-mixer-v1';
const OUTPUT_ANALYZER_ID = 1;
const OUTPUT_ANALYZER_FFT_EXP = 8;
const OUTPUT_RMS_SMOOTHING = 0.18;
const OUTPUT_RMS_IDLE_DECAY = 0.9;
const ANALYZER_DB_MIN = -120;
const ANALYZER_DB_MAX = 0;
let outputRmsSmoothed = 0;
let cachedFrequencyData = null;
let jamSnapshot = { spots: [], sessions: [] };
let sessionSnapshot = { sessions: [] };
let listenerRoom = 'center';
const JAM_GAIN_BASE = 0.6;
const SESSION_GAIN_BASE = 0.6;
const subscribedSessions = new Set(); // session IDs the viewer is listening to

// --- Spatial music state ---
let musicPlacements = [];           // Array of { id, pattern, position: { x, z }, ... }
let cameraPosition = { x: 0, z: 0 };
let lastSpatialGainSignature = '';
let spatialUpdateTimer = null;
const SPATIAL_INNER_RADIUS = 5;     // Full volume when closer
const SPATIAL_OUTER_RADIUS = 60;    // Silent at this distance
const SPATIAL_UPDATE_INTERVAL_MS = 500;
const SPATIAL_MAX_GAIN = 0.7;       // Per-instrument cap to prevent clipping

// --- Public API ---

export function getIsPlaying() { return isPlaying; }
export function getMutedSlots() { return mutedSlots; }
export function getSoloSlot() { return soloSlot; }
export function getMasterGain() { return masterGain; }

export function setJamSnapshot(snapshot) {
    jamSnapshot = normalizeJamSnapshot(snapshot);
}

export function setSessionSnapshot(snapshot) {
    sessionSnapshot = normalizeSessionSnapshot(snapshot);
}

export function subscribeSession(sessionId) {
    if (!sessionId) return;
    subscribedSessions.add(sessionId);
    if (isPlaying) updatePatterns();
    emitChange();
}

export function unsubscribeSession(sessionId) {
    if (!sessionId) return;
    subscribedSessions.delete(sessionId);
    if (isPlaying) updatePatterns();
    emitChange();
}

export function toggleSessionSubscription(sessionId) {
    if (!sessionId) return;
    if (subscribedSessions.has(sessionId)) {
        subscribedSessions.delete(sessionId);
    } else {
        subscribedSessions.add(sessionId);
    }
    if (isPlaying) updatePatterns();
    emitChange();
}

export function isSessionSubscribed(sessionId) {
    return subscribedSessions.has(sessionId);
}

export function getSubscribedSessions() {
    return subscribedSessions;
}

export function setListenerRoom(room) {
    listenerRoom = normalizeRoom(room);
}

export function setMusicPlacements(placements) {
    musicPlacements = Array.isArray(placements) ? placements : [];
}

export function setCameraPosition(x, z) {
    if (Number.isFinite(x) && Number.isFinite(z)) {
        cameraPosition = { x, z };
    }
}

export function getSlotLevel(slotId) {
    const id = Number(slotId);
    if (!Number.isInteger(id)) return 1;
    return slotLevels.get(id) ?? 1;
}

export function setMasterGain(next) {
    masterGain = clampGain(next);
    persistMixerState();
    if (isPlaying) updatePatterns();
    emitChange();
}

export function setSlotLevel(slotId, next) {
    const id = Number(slotId);
    if (!Number.isInteger(id)) return;
    const gain = clampGain(next);
    if (Math.abs(gain - 1) < 0.0001) {
        slotLevels.delete(id);
    } else {
        slotLevels.set(id, gain);
    }
    persistMixerState();
    if (isPlaying) updatePatterns();
    emitChange();
}

export function onChange(fn) {
    onChangeCallbacks.add(fn);
    return () => onChangeCallbacks.delete(fn);
}

function emitChange() {
    for (const fn of onChangeCallbacks) {
        try { fn(); } catch (e) { console.error('[music] onChange error:', e); }
    }
}

function normalizeRoom(room) {
    if (room === 'east_wing' || room === 'west_wing' || room === 'center') return room;
    return 'center';
}

function normalizeJamSnapshot(snapshot) {
    const spots = Array.isArray(snapshot?.spots) ? snapshot.spots : [];
    const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
    return { spots, sessions };
}

function normalizeSessionSnapshot(snapshot) {
    const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
    return { sessions };
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

function clampGain(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 1;
    return Math.min(2, Math.max(0, num));
}

function formatGain(value) {
    return clampGain(value).toFixed(3).replace(/\.?0+$/, '');
}

function persistMixerState() {
    try {
        const payload = {
            masterGain,
            slotLevels: Array.from(slotLevels.entries()),
        };
        localStorage.setItem(MIXER_STORAGE_KEY, JSON.stringify(payload));
    } catch {
        // Best-effort persistence only.
    }
}

function restoreMixerState() {
    try {
        const raw = localStorage.getItem(MIXER_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        masterGain = clampGain(parsed?.masterGain ?? 1);
        slotLevels.clear();
        if (Array.isArray(parsed?.slotLevels)) {
            for (const pair of parsed.slotLevels) {
                if (!Array.isArray(pair) || pair.length !== 2) continue;
                const id = Number(pair[0]);
                const gain = clampGain(pair[1]);
                if (!Number.isInteger(id)) continue;
                if (Math.abs(gain - 1) < 0.0001) continue;
                slotLevels.set(id, gain);
            }
        }
    } catch {
        masterGain = 1;
        slotLevels.clear();
    }
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

function extractPatternExpression(raw) {
    if (typeof raw !== 'string') return '';

    let code = raw
        .replace(/```[a-z]*\n?/gi, '')
        .replace(/```/g, '')
        .trim();

    if (!code) return '';

    // Recover from accidental JSON-wrapped payloads.
    if (code.startsWith('{')) {
        try {
            const parsed = JSON.parse(code);
            if (parsed && typeof parsed.pattern === 'string') {
                code = parsed.pattern.trim();
            }
        } catch {
            // Leave as-is; later checks may still recover/skip safely.
        }
    }

    const lines = code
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    // Recover from common "pattern: s(...)" wrappers.
    const labeledLine = lines.find((line) => /^["']?pattern["']?\s*:/i.test(line));
    if (labeledLine) {
        code = labeledLine.replace(/^["']?pattern["']?\s*:/i, '').trim();
    } else if (lines.length > 1) {
        const expressionLine = lines.find((line) => /^\(?\s*[a-zA-Z_]\w*\s*\(/.test(line));
        if (expressionLine) code = expressionLine;
    }

    code = code.replace(/^["']+|["']+$/g, '').trim();

    // Strip a trailing comma from JSON-like lines.
    if (code.endsWith(',')) {
        code = code.slice(0, -1).trim();
    }

    return code;
}

function sanitizePattern(code) {
    code = extractPatternExpression(code);
    if (!code) return null;

    if (/^["']?[a-zA-Z_]\w*["']?\s*:/.test(code)) {
        console.warn('[music] EXCLUDING labeled/non-expression pattern:', code.slice(0, 80));
        return null;
    }
    if (!/\b[a-zA-Z_]\w*\s*\(/.test(code)) {
        console.warn('[music] EXCLUDING pattern without callable expression:', code.slice(0, 80));
        return null;
    }
    if (/\.voicings\s*\(/.test(code)) {
        console.warn('[music] EXCLUDING pattern with voicings():', code.slice(0, 60));
        return null;
    }
    // Fix unquoted mini-notation: note(<[a3 c4]>) -> note("<[a3 c4]>")
    code = code.replace(/\b(note|s|n)\s*\(\s*(<[^>]+>)\s*\)/g, '$1("$2")');
    // Runtime alias fix: some bots emit .space(), but this runtime exposes .room().
    code = code.replace(/\.space\s*\(/g, '.room(');
    // Runtime alias fix: .feedback() is unavailable; .delayfeedback() is supported.
    code = code.replace(/\.feedback\s*\(/g, '.delayfeedback(');
    // Fix abbreviated oscillator names: s("saw") -> s("sawtooth"), s("tri") -> s("triangle")
    code = code.replace(/\bs\s*\(\s*"saw"\s*\)/g, 's("sawtooth")');
    code = code.replace(/\bs\s*\(\s*"tri"\s*\)/g, 's("triangle")');
    // Fix comma-separated note mini-notation: note("<c4,e4,a4>") -> note("<c4 e4 a4>")
    code = code.replace(/\b(note|n)\s*\(\s*"([^"]*)"\s*\)/g, (_, fn, inner) =>
        `${fn}("${inner.replace(/,/g, ' ')}")`
    );
    // Fix comma-separated bracket groups: [a3,c4,e4] -> [a3 c4 e4]
    code = code.replace(/\[([^\]]+)\]/g, (_, inner) => `[${inner.replace(/,/g, ' ')}]`);
    // Reject patterns with broken parens inside mini-notation strings.
    const miniArgRe = /\b(?:s|note|n)\s*\(\s*"([^"]*)"/g;
    let miniMatch;
    while ((miniMatch = miniArgRe.exec(code)) !== null) {
        const inner = miniMatch[1];
        if (/\(\s*\)/.test(inner)) {
            console.warn('[music] EXCLUDING pattern with empty parens in mini-notation:', inner.slice(0, 60));
            return null;
        }
        let depth = 0;
        let bad = false;
        for (const ch of inner) {
            if (ch === '(') depth++;
            if (ch === ')') depth--;
            if (depth < 0) { bad = true; break; }
        }
        if (bad || depth > 0) {
            console.warn('[music] EXCLUDING pattern with unbalanced parens in mini-notation:', inner.slice(0, 60));
            return null;
        }
    }
    return code;
}

function buildSlotPattern(slot) {
    const sanitized = sanitizePattern(slot.code);
    if (sanitized === null) return null;
    const slotGain = getSlotLevel(slot.id) * masterGain;
    return `(${sanitized}).gain(${formatGain(slotGain)})`;
}

function buildJamPatterns() {
    const snapshot = normalizeJamSnapshot(jamSnapshot);
    if (!Array.isArray(snapshot.sessions) || snapshot.sessions.length === 0) return [];
    const spotsById = new Map(
        (Array.isArray(snapshot.spots) ? snapshot.spots : []).map((spot) => [spot.id, spot])
    );

    const sourcePatterns = [];
    for (const session of snapshot.sessions) {
        const sessionRoom = normalizeRoom(session?.room || spotsById.get(session?.spotId)?.room || 'center');
        if (sessionRoom !== listenerRoom) continue;
        const participants = Array.isArray(session?.participants) ? session.participants : [];
        for (const participant of participants) {
            const sanitized = sanitizePattern(participant?.pattern || '');
            if (!sanitized) continue;
            sourcePatterns.push(sanitized);
        }
    }

    if (sourcePatterns.length === 0) return [];
    const perPatternGain = Math.min(0.95, JAM_GAIN_BASE / Math.max(1, Math.sqrt(sourcePatterns.length))) * masterGain;
    return sourcePatterns.map((pattern) => `(${pattern}).gain(${formatGain(perPatternGain)})`);
}

function buildSessionPatterns() {
    const snapshot = normalizeSessionSnapshot(sessionSnapshot);
    if (snapshot.sessions.length === 0) return [];
    if (subscribedSessions.size === 0) return [];

    const sourcePatterns = [];
    for (const session of snapshot.sessions) {
        if (!subscribedSessions.has(session.id)) continue;
        if (session.type !== 'music') continue;
        const participants = Array.isArray(session.participants) ? session.participants : [];
        for (const participant of participants) {
            const sanitized = sanitizePattern(participant?.pattern || '');
            if (!sanitized) continue;
            sourcePatterns.push(sanitized);
        }
    }

    if (sourcePatterns.length === 0) return [];
    const perPatternGain = Math.min(0.95, SESSION_GAIN_BASE / Math.max(1, Math.sqrt(sourcePatterns.length))) * masterGain;
    return sourcePatterns.map((pattern) => `(${pattern}).gain(${formatGain(perPatternGain)})`);
}

// --- Spatial music ---

function computeSpatialGain(placement) {
    const dx = placement.position.x - cameraPosition.x;
    const dz = placement.position.z - cameraPosition.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist <= SPATIAL_INNER_RADIUS) return SPATIAL_MAX_GAIN;
    if (dist >= SPATIAL_OUTER_RADIUS) return 0;

    // Linear falloff
    const t = (dist - SPATIAL_INNER_RADIUS) / (SPATIAL_OUTER_RADIUS - SPATIAL_INNER_RADIUS);
    return SPATIAL_MAX_GAIN * (1 - t);
}

function buildSpatialPatterns() {
    const patterns = [];
    for (const placement of musicPlacements) {
        const gain = computeSpatialGain(placement) * masterGain;
        if (gain < 0.01) continue; // Too far, skip
        const sanitized = sanitizePattern(placement.pattern);
        if (!sanitized) continue;
        patterns.push(`(${sanitized}).gain(${formatGain(gain)})`);
    }
    return patterns;
}

function computeSpatialGainSignature() {
    // Quantize gains to 5% steps for dirty-checking
    return musicPlacements
        .map(p => `${p.id}:${Math.round(computeSpatialGain(p) * 20)}`)
        .join('|');
}

export function startSpatialUpdates() {
    if (spatialUpdateTimer) return;
    spatialUpdateTimer = setInterval(() => {
        if (!isPlaying) return;
        const sig = computeSpatialGainSignature();
        if (sig === lastSpatialGainSignature) return;
        lastSpatialGainSignature = sig;
        updatePatterns();
    }, SPATIAL_UPDATE_INTERVAL_MS);
}

export function stopSpatialUpdates() {
    if (spatialUpdateTimer) {
        clearInterval(spatialUpdateTimer);
        spatialUpdateTimer = null;
    }
    lastSpatialGainSignature = '';
}

// --- Pattern building ---

function buildPattern() {
    const composition = getComposition();
    if (!composition) return null;

    const includeCompetitionMix = listenerRoom === 'center';
    const jamPatterns = buildJamPatterns();
    const sessionPatterns = buildSessionPatterns();

    const activeSlots = includeCompetitionMix
        ? composition.slots.filter(s => s.code)
        : [];

    const patterns = [];
    for (const slot of activeSlots) {
        // Apply mute/solo
        if (soloSlot !== null && slot.id !== soloSlot) continue;
        if (mutedSlots.has(slot.id)) continue;

        const slotPattern = buildSlotPattern(slot);
        if (slotPattern !== null) {
            patterns.push(slotPattern);
        }
    }

    for (const jamPattern of jamPatterns) {
        patterns.push(jamPattern);
    }

    for (const sp of sessionPatterns) {
        patterns.push(sp);
    }

    // Spatial music placements (proximity-based gain)
    for (const sp of buildSpatialPatterns()) {
        patterns.push(sp);
    }

    if (patterns.length === 0) return null;
    // NOTE: masterGain is pre-multiplied into each pattern's .gain() above.
    // Applying .gain() on the outer stack would override the individual gains
    // (Strudel's .gain() replaces, not multiplies), which would destroy
    // proximity-based spatial audio.
    const base = `stack(${patterns.join(',\n')})`;
    return attachOutputAnalysis(base);
}

function attachOutputAnalysis(pattern) {
    if (!pattern) return pattern;
    if (/\.analyze\s*\(/.test(pattern)) return pattern;
    return `${pattern}.analyze(${OUTPUT_ANALYZER_ID}).fft(${OUTPUT_ANALYZER_FFT_EXP})`;
}

// --- Playback ---

export async function start() {
    const pattern = buildPattern();
    if (!pattern) {
        console.warn('[music] No active music sources to play');
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
        startSpatialUpdates();
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
    const working = [];

    const candidatePatterns = [];
    if (listenerRoom === 'center') {
        for (const slot of composition.slots.filter(s => s.code)) {
            if (soloSlot !== null && slot.id !== soloSlot) continue;
            if (mutedSlots.has(slot.id)) continue;
            const slotPattern = buildSlotPattern(slot);
            if (slotPattern) candidatePatterns.push(slotPattern);
        }
    }
    for (const jamPattern of buildJamPatterns()) {
        candidatePatterns.push(jamPattern);
    }
    for (const sp of buildSessionPatterns()) {
        candidatePatterns.push(sp);
    }

    for (const pattern of candidatePatterns) {
        try {
            const el = document.getElementById('strudel-repl');
            el.setAttribute('code', `(${pattern}).gain(0)`);
            const ed = getEditor();
            await ed.evaluate();
            working.push(pattern);
        } catch {
            console.warn('[music] Pattern failed during fallback validation, skipping');
        }
    }

    if (working.length === 0) return false;

    const el = document.getElementById('strudel-repl');
    const pattern = attachOutputAnalysis(
        `stack(${working.join(',\n')})`
    );
    el.setAttribute('code', pattern);
    const ed = getEditor();
    await ed.evaluate();

    isPlaying = true;
    startSpatialUpdates();
    emitChange();
    return true;
}

restoreMixerState();

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
        console.warn('[music] Attempting fallback rebuild after update failure...');
        try {
            const recovered = await startWithFallback();
            if (!recovered) {
                console.error('[music] Fallback rebuild failed; stopping playback');
                stop();
            }
        } catch (fallbackErr) {
            console.error('[music] Fallback rebuild threw:', fallbackErr);
            stop();
        }
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
    stopSpatialUpdates();
    emitChange();
}

export function toggle() {
    if (isPlaying) stop();
    else start();
}

// --- Audio analyser (for visualization) ---

function readAnalyzerData(kind) {
    if (typeof window === 'undefined' || typeof window.getAnalyzerData !== 'function') {
        return null;
    }
    try {
        const data = window.getAnalyzerData(kind, OUTPUT_ANALYZER_ID);
        if (!data || !data.length) return null;
        return data;
    } catch {
        return null;
    }
}

function computeRms(samples) {
    if (!samples || !samples.length) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        const value = Number(samples[i]) || 0;
        sum += value * value;
    }
    return Math.sqrt(sum / samples.length);
}

export function getOutputRms() {
    if (!isPlaying) {
        outputRmsSmoothed *= OUTPUT_RMS_IDLE_DECAY;
        if (outputRmsSmoothed < 0.00001) outputRmsSmoothed = 0;
        return outputRmsSmoothed;
    }

    const timeDomain = readAnalyzerData('time');
    const raw = computeRms(timeDomain);
    outputRmsSmoothed =
        outputRmsSmoothed * (1 - OUTPUT_RMS_SMOOTHING) +
        raw * OUTPUT_RMS_SMOOTHING;
    return outputRmsSmoothed;
}

export function getOutputRmsDb() {
    const rms = getOutputRms();
    if (rms <= 0.000001) return ANALYZER_DB_MIN;
    return Math.max(ANALYZER_DB_MIN, Math.min(ANALYZER_DB_MAX, 20 * Math.log10(rms)));
}

export function getAnalyserData() {
    const frequency = readAnalyzerData('frequency');
    if (!frequency) return null;

    if (!cachedFrequencyData || cachedFrequencyData.length !== frequency.length) {
        cachedFrequencyData = new Uint8Array(frequency.length);
    }

    for (let i = 0; i < frequency.length; i++) {
        const db = Number(frequency[i]);
        const normalized = Number.isFinite(db)
            ? (db - ANALYZER_DB_MIN) / (ANALYZER_DB_MAX - ANALYZER_DB_MIN)
            : 0;
        cachedFrequencyData[i] = Math.max(0, Math.min(255, Math.round(normalized * 255)));
    }
    return cachedFrequencyData;
}
