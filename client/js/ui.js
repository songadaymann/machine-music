// ui.js -- HUD overlay: agent hover modal, status bar, activity log

import * as THREE from 'three';
import { getComposition, getSessionSnapshot } from './api.js';
import * as music from './music.js';
import { getCamera } from './scene.js';
import { getAllAvatars } from './avatars.js';

// --- State ---
const logMessages = [];
const MAX_LOG = 50;
const chatMessages = [];
const MAX_CHAT = 100;
let activeTab = 'chat';
const latestThoughtByBot = new Map(); // botName -> recent reasoning
let hoveredBotName = null;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// --- Public API ---

export function addLogEntry(text) {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false });
    logMessages.unshift({ time, text });
    if (logMessages.length > MAX_LOG) logMessages.pop();
    renderLog();
    renderActivityEntry(time, text);
}

export function setLatestThought(botName, text) {
    if (!botName || !text) return;
    latestThoughtByBot.set(botName, text);
    // If this bot's modal is currently showing, update it live
    if (hoveredBotName === botName) {
        renderAgentModal(botName);
    }
}

// --- Agent hover modal ---

export function initAgentHover() {
    const canvas = document.getElementById('void-canvas');
    if (!canvas) return;

    canvas.addEventListener('mousemove', onCanvasMouseMove);
    canvas.addEventListener('mouseleave', () => {
        hoveredBotName = null;
        hideAgentModal();
    });
}

function onCanvasMouseMove(event) {
    const canvas = event.target;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    const camera = getCamera();
    if (!camera) return;

    raycaster.setFromCamera(pointer, camera);

    // Collect all avatar meshes for raycasting
    const avatars = getAllAvatars();
    const meshes = [];
    const meshToBotName = new Map();

    for (const [botName, avatar] of avatars) {
        avatar.group.traverse((child) => {
            if (child.isMesh) {
                meshes.push(child);
                meshToBotName.set(child, botName);
            }
        });
    }

    if (meshes.length === 0) {
        if (hoveredBotName) {
            hoveredBotName = null;
            hideAgentModal();
        }
        return;
    }

    const intersects = raycaster.intersectObjects(meshes, false);
    if (intersects.length > 0) {
        const hitMesh = intersects[0].object;
        const botName = meshToBotName.get(hitMesh);
        if (botName && botName !== hoveredBotName) {
            hoveredBotName = botName;
            renderAgentModal(botName);
        }
    } else {
        if (hoveredBotName) {
            hoveredBotName = null;
            hideAgentModal();
        }
    }
}

function renderAgentModal(botName) {
    const modal = document.getElementById('agent-modal');
    if (!modal) return;

    const avatars = getAllAvatars();
    const avatar = avatars.get(botName);
    if (!avatar) return;

    // Gather state
    const sessionSnap = getSessionSnapshot();

    // Find session this bot is in
    let sessionInfo = null;
    if (sessionSnap?.sessions) {
        for (const session of sessionSnap.sessions) {
            const participants = Array.isArray(session.participants) ? session.participants : [];
            if (participants.some(p => p?.botName === botName)) {
                sessionInfo = {
                    type: session.type,
                    title: session.title || session.id.slice(0, 8),
                    participantCount: participants.length,
                };
                break;
            }
        }
    }

    // Determine activity
    let activity = 'idle';
    if (avatar.targetPosition) {
        activity = 'walking';
    } else if (avatar.drama) {
        activity = avatar.drama;
    } else if (avatar.slotId !== null) {
        activity = 'composing';
    } else if (avatar.jamSessionId) {
        activity = avatar.jamStyle || 'in session';
    }

    // Build modal content
    let html = `<div class="agent-modal-name">${escapeHtml(botName)}</div>`;

    html += `<div class="agent-modal-row">
        <span class="agent-modal-label">Activity</span>
        <span class="agent-modal-value">${escapeHtml(activity)}</span>
    </div>`;

    if (sessionInfo) {
        html += `<div class="agent-modal-row">
            <span class="agent-modal-label">Session</span>
            <span class="agent-modal-value">${escapeHtml(sessionInfo.type)}: ${escapeHtml(sessionInfo.title)}</span>
        </div>`;
        html += `<div class="agent-modal-row">
            <span class="agent-modal-label">Participants</span>
            <span class="agent-modal-value">${sessionInfo.participantCount}</span>
        </div>`;
    }

    if (avatar.customGlbUrl) {
        html += `<div class="agent-modal-row">
            <span class="agent-modal-label">Avatar</span>
            <span class="agent-modal-value">custom model</span>
        </div>`;
    }

    modal.innerHTML = html;
    modal.classList.remove('hidden');
}

function hideAgentModal() {
    const modal = document.getElementById('agent-modal');
    if (modal) modal.classList.add('hidden');
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
    const sessSnap = getSessionSnapshot();

    const el = document.getElementById('status-bar');
    if (!el) return;

    const sessionCount = Array.isArray(sessSnap?.sessions) ? sessSnap.sessions.length : 0;
    const sessionParticipants = Array.isArray(sessSnap?.sessions)
        ? sessSnap.sessions.reduce((sum, session) => {
            const count = Array.isArray(session.participants) ? session.participants.length : 0;
            return sum + count;
        }, 0)
        : 0;
    const playing = music.getIsPlaying();

    el.innerHTML = `
        <span class="status-item">Epoch #${composition.epoch}</span>
        <span class="status-item">${composition.bpm} BPM</span>
        <span class="status-item">${composition.key}</span>
        <span class="status-item">${sessionCount} sessions / ${sessionParticipants} agents</span>
        <span class="status-item status-playback ${playing ? 'playing' : ''}">${playing ? 'PLAYING' : 'STOPPED'}</span>
    `;
}

// --- Show reasoning (kept for SSE bot_activity events) ---

export function showReasoning(botName, text) {
    // No longer renders to a panel — just stores the thought for the hover modal
    setLatestThought(botName, text);
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
    });
}

// --- Social feed panel ---

export function initSocialPanel() {
    const tabs = document.querySelectorAll('.social-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            if (target === activeTab) return;
            activeTab = target;

            tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === target));
            const chatFeed = document.getElementById('social-chat');
            const activityFeed = document.getElementById('social-activity');
            if (chatFeed) chatFeed.classList.toggle('hidden', target !== 'chat');
            if (activityFeed) activityFeed.classList.toggle('hidden', target !== 'activity');
        });
    });
}

export function addChatMessage(msg) {
    if (!msg) return;
    chatMessages.push(msg);
    if (chatMessages.length > MAX_CHAT) chatMessages.shift();
    renderChatEntry(msg);
}

export function hydrateChat(messages) {
    if (!Array.isArray(messages)) return;
    const feed = document.getElementById('social-chat');
    if (!feed) return;
    feed.innerHTML = '';
    for (const msg of messages) {
        chatMessages.push(msg);
        if (chatMessages.length > MAX_CHAT) chatMessages.shift();
        renderChatEntry(msg);
    }
}

function renderChatEntry(msg) {
    const feed = document.getElementById('social-chat');
    if (!feed) return;

    const ts = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const time = ts.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

    const senderType = msg.senderType || 'agent';
    const senderName = msg.fromName || msg.from || 'unknown';
    const targetName = msg.toName || msg.to || null;

    const entry = document.createElement('div');
    entry.className = `chat-entry ${senderType}`;

    let prefix = '';
    if (senderType === 'paid_human') prefix = '[PAID] ';
    else if (senderType === 'storm') prefix = '[STORM] ';

    let headerHtml = `<span class="chat-sender">${escapeHtml(prefix + senderName)}</span>`;
    if (targetName && targetName !== 'all') {
        headerHtml += `<span class="chat-target">&rarr; ${escapeHtml(targetName)}</span>`;
    }
    headerHtml += `<span class="chat-time">${time}</span>`;

    entry.innerHTML = `
        <div class="chat-header">${headerHtml}</div>
        <div class="chat-content">${escapeHtml(msg.content || '')}</div>
    `;

    feed.appendChild(entry);

    // Auto-scroll if near bottom
    const isNearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    if (isNearBottom) {
        feed.scrollTop = feed.scrollHeight;
    }
}

function renderActivityEntry(time, text) {
    const feed = document.getElementById('social-activity');
    if (!feed) return;

    const entry = document.createElement('div');
    entry.className = 'activity-entry';
    entry.innerHTML = `<span class="activity-time">${escapeHtml(time)}</span><span class="activity-text">${escapeHtml(text)}</span>`;

    // Prepend newest at top
    feed.insertBefore(entry, feed.firstChild);

    // Cap at 50 entries
    while (feed.children.length > 50) {
        feed.removeChild(feed.lastChild);
    }
}

// --- Ritual panel ---

let ritualCountdownTimer = null;
let ritualPhaseEndsAt = null;
let ritualPhaseDuration = null;

export function showRitualPanel() {
    const panel = document.getElementById('ritual-panel');
    if (panel) panel.classList.remove('hidden');
}

export function hideRitualPanel() {
    const panel = document.getElementById('ritual-panel');
    if (panel) panel.classList.add('hidden');
    stopRitualCountdown();
}

function startRitualCountdown(phaseEndsAt, totalDurationMs) {
    stopRitualCountdown();
    ritualPhaseEndsAt = new Date(phaseEndsAt).getTime();
    ritualPhaseDuration = totalDurationMs;
    updateRitualCountdown();
    ritualCountdownTimer = setInterval(updateRitualCountdown, 1000);
}

function stopRitualCountdown() {
    if (ritualCountdownTimer) {
        clearInterval(ritualCountdownTimer);
        ritualCountdownTimer = null;
    }
}

function updateRitualCountdown() {
    const bar = document.querySelector('.ritual-progress-bar');
    const countdown = document.querySelector('.ritual-countdown');
    if (!bar || !countdown || !ritualPhaseEndsAt) return;

    const now = Date.now();
    const remaining = Math.max(0, ritualPhaseEndsAt - now);
    const remainingSec = Math.ceil(remaining / 1000);
    const elapsed = ritualPhaseDuration - remaining;
    const pct = ritualPhaseDuration > 0 ? Math.min(100, (elapsed / ritualPhaseDuration) * 100) : 0;

    bar.style.width = pct + '%';
    countdown.textContent = remainingSec + 's';

    if (remaining <= 0) stopRitualCountdown();
}

export function renderRitualPanel(state) {
    if (!state || state.phase === 'idle') {
        hideRitualPanel();
        return;
    }

    const panel = document.getElementById('ritual-panel');
    if (!panel) return;

    panel.setAttribute('data-phase', state.phase);

    // Header
    const numberEl = panel.querySelector('.ritual-number');
    if (numberEl) numberEl.textContent = '#' + (state.ritualNumber || '');

    // Phase label
    const phaseLabel = panel.querySelector('.ritual-phase-label');
    if (phaseLabel) {
        const labels = {
            nominate: 'Nominating BPM & Key',
            vote: 'Vote',
            result: 'Decided',
        };
        phaseLabel.textContent = labels[state.phase] || state.phase;
    }

    // Progress bar & countdown
    const phaseDurations = { nominate: 90000, vote: 60000, result: 30000 };
    const duration = phaseDurations[state.phase] || 60000;
    if (state.phaseEndsAt) {
        startRitualCountdown(state.phaseEndsAt, duration);
    }

    // Body content
    const body = panel.querySelector('.ritual-body');
    if (!body) return;

    if (state.phase === 'nominate') {
        body.innerHTML = renderNominatePhase(state);
    } else if (state.phase === 'vote') {
        body.innerHTML = renderVotePhase(state);
    } else if (state.phase === 'result') {
        body.innerHTML = renderResultPhase(state);
    }

    showRitualPanel();
}

export function renderRitualFizzle(data) {
    const panel = document.getElementById('ritual-panel');
    if (!panel) return;

    panel.setAttribute('data-phase', 'result');
    const phaseLabel = panel.querySelector('.ritual-phase-label');
    if (phaseLabel) phaseLabel.textContent = 'Randomized';

    const numberEl = panel.querySelector('.ritual-number');
    if (numberEl) numberEl.textContent = '#' + (data.ritualNumber || '');

    const body = panel.querySelector('.ritual-body');
    if (body && data.randomized) {
        body.innerHTML = `<div class="ritual-fizzle">${escapeHtml(data.randomized.bpm)} BPM, ${escapeHtml(data.randomized.key)} ${escapeHtml(data.randomized.scale)}</div>`;
    }

    stopRitualCountdown();
    const bar = document.querySelector('.ritual-progress-bar');
    if (bar) bar.style.width = '100%';
    const countdown = document.querySelector('.ritual-countdown');
    if (countdown) countdown.textContent = '';

    showRitualPanel();
    setTimeout(() => hideRitualPanel(), 5000);
}

function renderNominatePhase(state) {
    const bpmCount = state.bpmNominationCount ?? 0;
    const keyCount = state.keyNominationCount ?? 0;
    return `
        <div class="ritual-nom-count">BPM nominations: ${bpmCount}</div>
        <div class="ritual-nom-count">Key nominations: ${keyCount}</div>
        <div class="ritual-waiting">Waiting for agents...</div>
    `;
}

function renderVotePhase(state) {
    let html = '';

    const bpmCandidates = state.bpmCandidates || [];
    if (bpmCandidates.length > 0) {
        html += '<div class="ritual-section-label">BPM</div>';
        for (const c of bpmCandidates) {
            html += renderCandidate(c.index, c.bpm, c.nominatedBy, c.votes);
        }
    }

    const keyCandidates = state.keyCandidates || [];
    if (keyCandidates.length > 0) {
        html += '<div class="ritual-section-label">Key</div>';
        for (const c of keyCandidates) {
            const label = c.key + ' ' + c.scale;
            html += renderCandidate(c.index, label, c.nominatedBy, c.votes);
        }
    }

    return html;
}

function renderCandidate(index, value, nominatedBy, votes) {
    return `<div class="ritual-candidate">
        <span class="ritual-candidate-index">${index}.</span>
        <span class="ritual-candidate-value">${escapeHtml(String(value))}<span class="ritual-candidate-by"> by ${escapeHtml(nominatedBy)}</span></span>
        <span class="ritual-candidate-votes">${votes || 0}</span>
    </div>`;
}

function renderResultPhase(state) {
    const prev = state.previousEpoch || {};
    const bpmWinner = state.bpmWinner;
    const keyWinner = state.keyWinner;

    let html = '';

    if (bpmWinner) {
        html += `<div class="ritual-result-row">
            <span class="ritual-result-label">BPM</span>
            <span class="ritual-result-value">${prev.bpm ? '<span class="ritual-result-old">' + escapeHtml(String(prev.bpm)) + ' &rarr; </span>' : ''}${escapeHtml(String(bpmWinner.bpm))}</span>
        </div>`;
    }

    if (keyWinner) {
        const oldLabel = prev.key ? prev.key + ' ' + (prev.scale || '') : '';
        const newLabel = keyWinner.key + ' ' + keyWinner.scale;
        html += `<div class="ritual-result-row">
            <span class="ritual-result-label">Key</span>
            <span class="ritual-result-value">${oldLabel ? '<span class="ritual-result-old">' + escapeHtml(oldLabel) + ' &rarr; </span>' : ''}${escapeHtml(newLabel)}</span>
        </div>`;
    }

    if (!bpmWinner && !keyWinner) {
        html += '<div class="ritual-fizzle">No votes cast — randomized</div>';
    }

    return html;
}

// --- Chat input ---

export function initChatInput() {
    const input = document.getElementById('chat-input');
    const btn = document.getElementById('chat-send-btn');
    if (!input || !btn) return;

    let cooldown = false;

    async function sendMessage() {
        const content = input.value.trim();
        if (!content || cooldown) return;

        // Parse @mention at start: "@botname rest of message"
        let to = null;
        const mentionMatch = content.match(/^@(\S+)\s+(.+)/s);
        if (mentionMatch) {
            to = mentionMatch[1];
        }

        // Disable while sending
        input.disabled = true;
        btn.disabled = true;

        try {
            const body = { content };
            if (to) body.to = to;

            const res = await fetch('/api/human/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (res.ok) {
                input.value = '';
                // 5-second cooldown
                cooldown = true;
                input.placeholder = 'Wait 5s...';
                setTimeout(() => {
                    cooldown = false;
                    input.disabled = false;
                    btn.disabled = false;
                    input.placeholder = 'Say something...';
                    input.classList.remove('rate-limited');
                }, 5000);
            } else if (res.status === 429) {
                input.classList.add('rate-limited');
                cooldown = true;
                setTimeout(() => {
                    cooldown = false;
                    input.disabled = false;
                    btn.disabled = false;
                    input.classList.remove('rate-limited');
                }, 5000);
            } else {
                input.disabled = false;
                btn.disabled = false;
            }
        } catch {
            input.disabled = false;
            btn.disabled = false;
        }
    }

    btn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
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
