// debug.js -- On-screen debug panel for tweaking scales and offsets
//
// Toggle with ` (backtick) key.
// Values are saved to localStorage so they persist across refreshes.
// "Spawn test avatar" drops one at center so you can see if models load.

import {
    setAvatarScale, getAvatarScale,
    setAvatarYOffset, getAvatarYOffset,
    getLoadStatus, ensureAvatar, assignToSlot,
} from './avatars.js';
import { setTypeScale, setTypeYOffset, setTypeRotation, getModelConfig } from './instruments.js';

const STORAGE_KEY = 'music-place-debug';

// --- Default values ---
function getDefaults() {
    const cfg = getModelConfig();
    return {
        avatarScale:  getAvatarScale(),
        avatarY:      getAvatarYOffset(),
        drums_scale:  cfg.drums.scale,
        drums_y:      cfg.drums.yOffset,
        drums_rot:    cfg.drums.rot,
        bass_scale:   cfg.bass.scale,
        bass_y:       cfg.bass.yOffset,
        bass_rot:     cfg.bass.rot,
        chords_scale: cfg.chords.scale,
        chords_y:     cfg.chords.yOffset,
        chords_rot:   cfg.chords.rot,
        melody_scale: cfg.melody.scale,
        melody_y:     cfg.melody.yOffset,
        melody_rot:   cfg.melody.rot,
        wild_scale:   cfg.wild.scale,
        wild_y:       cfg.wild.yOffset,
        wild_rot:     cfg.wild.rot,
    };
}

let values = {};

function load() {
    const defaults = getDefaults();
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        values = { ...defaults, ...saved };
    } catch {
        values = defaults;
    }
}

function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
}

// --- Apply all values to the scene ---
function applyAll() {
    setAvatarScale(values.avatarScale);
    setAvatarYOffset(values.avatarY);
    for (const type of ['drums', 'bass', 'chords', 'melody', 'wild']) {
        setTypeScale(type, values[`${type}_scale`]);
        setTypeYOffset(type, values[`${type}_y`]);
        setTypeRotation(type, values[`${type}_rot`]);
    }
}

// --- Build DOM ---

let panel = null;
let visible = false;

function createSlider(label, key, min, max, step) {
    const row = document.createElement('div');
    row.className = 'debug-row';

    const lbl = document.createElement('label');
    lbl.className = 'debug-label';
    lbl.textContent = label;

    const valSpan = document.createElement('span');
    valSpan.className = 'debug-value';
    valSpan.textContent = values[key].toFixed(3);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'debug-slider';
    slider.min = min;
    slider.max = max;
    slider.step = step;
    slider.value = values[key];

    slider.addEventListener('input', () => {
        values[key] = parseFloat(slider.value);
        valSpan.textContent = values[key].toFixed(3);
        applyValue(key);
        save();
    });

    row.appendChild(lbl);
    row.appendChild(slider);
    row.appendChild(valSpan);
    return row;
}

function applyValue(key) {
    if (key === 'avatarScale') {
        setAvatarScale(values.avatarScale);
        return;
    }
    if (key === 'avatarY') {
        setAvatarYOffset(values.avatarY);
        return;
    }
    // instrument keys are like "drums_scale", "drums_y", or "drums_rot"
    const [type, prop] = key.split('_');
    if (prop === 'scale') setTypeScale(type, values[key]);
    if (prop === 'y') setTypeYOffset(type, values[key]);
    if (prop === 'rot') setTypeRotation(type, values[key]);
}

function createSection(title) {
    const h = document.createElement('div');
    h.className = 'debug-section';
    h.textContent = title;
    return h;
}

function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'debug-panel';
    panel.style.display = 'none';

    // Header
    const header = document.createElement('div');
    header.className = 'debug-header';
    header.innerHTML = '<span>DEBUG  (` to toggle)</span>';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'debug-close';
    closeBtn.textContent = 'x';
    closeBtn.addEventListener('click', toggle);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'debug-body';

    // --- Avatar section ---
    body.appendChild(createSection('Avatar'));

    // Status line
    const status = getLoadStatus();
    const statusEl = document.createElement('div');
    statusEl.className = 'debug-status';
    statusEl.textContent = status.modelLoaded
        ? `GLB loaded, ${status.animCount} anims`
        : status.loadFailed
            ? 'GLB FAILED -- using procedural'
            : 'loading...';
    body.appendChild(statusEl);

    body.appendChild(createSlider('Scale', 'avatarScale', 0.1, 10, 0.05));
    body.appendChild(createSlider('Y Offset', 'avatarY', -3, 3, 0.05));

    // Spawn test avatar button
    const spawnBtn = document.createElement('button');
    spawnBtn.className = 'debug-reset';
    spawnBtn.textContent = 'Spawn test avatar at slot 1';
    spawnBtn.addEventListener('click', () => {
        const name = 'test-bot-' + Math.floor(Math.random() * 999);
        ensureAvatar(name);
        assignToSlot(name, 1);
        spawnBtn.textContent = `Spawned "${name}"`;
        setTimeout(() => spawnBtn.textContent = 'Spawn test avatar at slot 1', 2000);
    });
    body.appendChild(spawnBtn);

    // --- Instruments ---
    for (const type of ['drums', 'bass', 'chords', 'melody', 'wild']) {
        body.appendChild(createSection(type.charAt(0).toUpperCase() + type.slice(1)));
        body.appendChild(createSlider('Scale', `${type}_scale`, 0.001, 10, 0.001));
        body.appendChild(createSlider('Y Offset', `${type}_y`, -5, 5, 0.05));
        body.appendChild(createSlider('Rotation', `${type}_rot`, -Math.PI, Math.PI, 0.05));
    }

    // --- Action buttons ---
    body.appendChild(createSection('Actions'));

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.className = 'debug-reset';
    resetBtn.textContent = 'Reset to defaults';
    resetBtn.addEventListener('click', () => {
        localStorage.removeItem(STORAGE_KEY);
        values = getDefaults();
        applyAll();
        // Rebuild sliders
        panel.remove();
        buildPanel();
        document.getElementById('hud').appendChild(panel);
        panel.style.display = 'block';
        visible = true;
    });
    body.appendChild(resetBtn);

    // Copy values button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'debug-reset';
    copyBtn.textContent = 'Copy values to clipboard';
    copyBtn.addEventListener('click', () => {
        const out = JSON.stringify(values, null, 2);
        navigator.clipboard.writeText(out).then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => copyBtn.textContent = 'Copy values to clipboard', 1500);
        });
    });
    body.appendChild(copyBtn);

    panel.appendChild(body);
    document.getElementById('hud').appendChild(panel);
}

function toggle() {
    visible = !visible;
    if (panel) panel.style.display = visible ? 'block' : 'none';
}

// --- Init ---

export function init() {
    load();
    applyAll();
    buildPanel();

    // Keyboard shortcut: backtick toggles panel
    window.addEventListener('keydown', (e) => {
        if (e.key === '`') {
            e.preventDefault();
            toggle();
        }
    });
}
