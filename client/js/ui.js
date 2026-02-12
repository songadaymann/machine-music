// ui.js -- HUD overlay: slot info, mute/solo controls, reasoning feed, status

import { getComposition } from './api.js';
import * as music from './music.js';

// --- State ---
const logMessages = [];
const MAX_LOG = 50;
const latestThoughtByBot = new Map(); // botName -> recent reasoning

// --- Public API ---

export function addLogEntry(text) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false });
    logMessages.unshift({ time, text });
    if (logMessages.length > MAX_LOG) logMessages.pop();
    renderLog();
}

export function setLatestThought(botName, text) {
    if (!botName || !text) return;
    latestThoughtByBot.set(botName, text);
}

// --- Render slot controls ---

export function renderSlotControls() {
    const container = document.getElementById('slot-controls');
    if (!container) return;

    const composition = getComposition();
    if (!composition) return;

    container.innerHTML = '';

    for (const slot of composition.slots) {
        const div = document.createElement('div');
        div.className = 'slot-control';
        if (!slot.code) div.classList.add('empty');

        const isMuted = music.getMutedSlots().has(slot.id);
        const isSolo = music.getSoloSlot() === slot.id;

        const typeLabel = {
            drums: 'DR', bass: 'BA', chords: 'CH', melody: 'ME', wild: 'WD',
        }[slot.type] || slot.type.toUpperCase();

        const typeColors = {
            drums: '#e74c3c', bass: '#3498db', chords: '#9b59b6',
            melody: '#2ecc71', wild: '#f39c12',
        };
        const agentName = slot.agent?.name || '---';
        const codePreview = slot.code
            ? escapeHtml(slot.code)
            : '<span class="slot-control-empty-msg">waiting_for_claim...</span>';
        const thought = slot.agent?.name ? latestThoughtByBot.get(slot.agent.name) : '';
        const thoughtPreview = thought ? escapeHtml(thought).slice(0, 120) : '';

        div.innerHTML = `
            <div class="slot-control-header">
                <span class="slot-control-type" style="color: ${typeColors[slot.type] || '#999'}">${typeLabel} ${slot.id}</span>
                <span class="slot-control-bot">${escapeHtml(agentName)}</span>
            </div>
            <pre class="slot-control-code">${codePreview}</pre>
            ${thoughtPreview ? `<div class="slot-control-thought">${thoughtPreview}</div>` : ''}
            <div class="slot-control-buttons">
                <button class="btn-mute ${isMuted ? 'active' : ''}" data-slot="${slot.id}">M</button>
                <button class="btn-solo ${isSolo ? 'active' : ''}" data-slot="${slot.id}">S</button>
            </div>
        `;

        container.appendChild(div);
    }

    // Attach event listeners
    container.querySelectorAll('.btn-mute').forEach(btn => {
        btn.addEventListener('click', () => {
            music.toggleMute(parseInt(btn.dataset.slot));
            renderSlotControls();
        });
    });
    container.querySelectorAll('.btn-solo').forEach(btn => {
        btn.addEventListener('click', () => {
            music.toggleSolo(parseInt(btn.dataset.slot));
            renderSlotControls();
        });
    });
}

// --- Render activity log ---

function renderLog() {
    const container = document.getElementById('activity-log');
    if (!container) return;

    if (logMessages.length === 0) {
        container.innerHTML = '<div class="log-empty">Waiting for activity...</div>';
        return;
    }

    container.innerHTML = '';
    for (const m of logMessages.slice(0, 20)) {
        const row = document.createElement('div');
        row.className = 'log-entry';

        const time = document.createElement('span');
        time.className = 'log-time';
        time.textContent = m.time;

        row.append(time, ` ${m.text}`);
        container.appendChild(row);
    }
}

// --- Render status bar ---

export function renderStatus() {
    const composition = getComposition();
    if (!composition) return;

    const el = document.getElementById('status-bar');
    if (!el) return;

    const activeCount = composition.slots.filter(s => s.code).length;
    const playing = music.getIsPlaying();

    el.innerHTML = `
        <span class="status-item">Epoch #${composition.epoch}</span>
        <span class="status-item">${composition.bpm} BPM</span>
        <span class="status-item">${composition.key}</span>
        <span class="status-item">${activeCount}/8 slots</span>
        <span class="status-item status-playback ${playing ? 'playing' : ''}">${playing ? 'PLAYING' : 'STOPPED'}</span>
    `;
}

// --- Render reasoning bubble ---

export function showReasoning(botName, text) {
    const container = document.getElementById('reasoning-feed');
    if (!container) return;

    const safeBot = escapeHtml(botName);
    const safeText = escapeHtml(text);
    const div = document.createElement('div');
    div.className = 'reasoning-entry';
    div.innerHTML = `<span class="reasoning-bot">${safeBot}</span> ${safeText}`;
    container.prepend(div);

    // Keep only recent entries
    while (container.children.length > 8) {
        container.removeChild(container.lastChild);
    }

    // Auto-fade after 10s
    setTimeout(() => {
        div.classList.add('fading');
        setTimeout(() => div.remove(), 1000);
    }, 10000);
}

// --- Play button ---

export function initPlayButton() {
    const btn = document.getElementById('play-btn');
    if (!btn) return;

    btn.addEventListener('click', () => {
        music.toggle();
    });

    music.onChange(() => {
        btn.textContent = music.getIsPlaying() ? 'Stop' : 'Listen';
        btn.classList.toggle('playing', music.getIsPlaying());
        renderStatus();
        renderSlotControls();
    });
}

function escapeHtml(str) {
    return String(str)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
