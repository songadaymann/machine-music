// app.js -- Entry point: wires together scene, avatars, music, API, and UI

import * as api from './api.js';
import * as music from './music.js';
import * as scene from './scene.js';
import * as instruments from './instruments.js';
import * as avatars from './avatars.js';
import * as ui from './ui.js';
import * as debug from './debug.js';
import * as wallet from './wallet.js';
import * as visualRenderer from './visual-renderer.js';
import * as worldRenderer from './world-renderer.js';
import * as catalogRenderer from './catalog-renderer.js';
import * as gameRenderer from './game-renderer.js';

// Track which bot holds which slot
const slotHolders = new Map(); // slotId -> botName
const botAvatarSpecs = new Map(); // botName -> { glbUrl, avatarHeight }

let compositionSignature = '';
let jamSignature = '';
let sessionSignature = '';
let latestJamSnapshot = { spots: [], sessions: [] };
let latestSessionSnapshot = { sessions: [] };
const jamAssignments = new Map(); // botName -> { jamId, style, center }
const sessionAssignments = new Map(); // botName -> { sessionId, style, center }
let listenerRoom = 'center';

function toAvatarHeight(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (value <= 0) return null;
    return Math.round(value * 100) / 100;
}

function setBotAvatarSpec(botName, glbUrl, avatarHeight) {
    if (!botName) return;
    const height = toAvatarHeight(avatarHeight);
    if (typeof glbUrl !== 'string' || glbUrl.length === 0) {
        botAvatarSpecs.delete(botName);
        return;
    }
    botAvatarSpecs.set(botName, {
        glbUrl,
        avatarHeight: height,
    });
}

function handleWayfindingMove(data) {
    const { botName, toX, toZ } = data;
    const avatar = avatars.getAvatar(botName);
    if (!avatar) return;
    if (typeof toX === 'number' && typeof toZ === 'number') {
        avatar.targetPosition = { x: toX, y: 0, z: toZ };
        avatars.switchAction(avatar, 'walk');
    }
}

function handleWayfindingArrived(data) {
    const { botName, toX, toZ } = data;
    const avatar = avatars.getAvatar(botName);
    if (!avatar) return;
    if (typeof toX === 'number' && typeof toZ === 'number' && avatar.group) {
        avatar.group.position.set(toX, avatars.getAvatarYOffset?.() ?? 0, toZ);
        avatar.targetPosition = null;
    }
    avatars.switchAction(avatar, 'idle');
}

function handleWayfindingPresence(data) {
    const { botName, presenceState } = data;
    const avatar = avatars.getAvatar(botName);
    if (!avatar) return;

    const animMap = {
        dance: 'dance',
        headbob: 'headbob',
        idle_pose: 'idle',
        rest: 'idle',
        celebrate: 'dance',
        disappointed: 'idle',
        cheer: 'dance',
    };
    const anim = animMap[presenceState];
    if (anim) avatars.switchAction(avatar, anim);
}

async function main() {
    console.log('[app] SynthMob -- The Void');

    // 1. Init Three.js scene
    const canvas = document.getElementById('void-canvas');
    scene.init(canvas);

    visualRenderer.init(scene.getScene(), canvas);
    worldRenderer.init(scene.getScene());
    gameRenderer.init(scene.getScene(), scene.getCamera(), canvas);

    // 2. Load avatar model + animations (async, falls back to procedural)
    //    Start this early so it can load in parallel with instruments
    const avatarLoadPromise = avatars.loadModel();

    // 2b. Preload catalog GLB models (async, non-blocking)
    const catalogPreloadPromise = catalogRenderer.preload().catch(err =>
        console.warn('[app] Catalog preload failed (non-fatal):', err)
    );

    // 3. Place instruments in broadcast stage ring (async: loads GLB models)
    await instruments.init(scene.getScene());

    // 4. Wait for avatar model to finish loading
    await avatarLoadPromise;
    avatars.init();

    // 5. Connect to API
    await api.init();

    // 5b. Fetch wayfinding nav graph for node positions
    // 6. Init UI + debug panel
    ui.initPlayButton();
    ui.initAgentHover();
    initCameraModeButton();
    debug.init();

    // 6b. Init wallet connect
    initWalletConnect();

    // 7. Process initial composition state
    const comp = api.getComposition();
    latestJamSnapshot = api.getJamSnapshot() || { spots: [], sessions: [] };
    latestSessionSnapshot = api.getSessionSnapshot() || { sessions: [] };
    if (comp) {
        processComposition(comp);
        syncMusicWithState(comp, latestJamSnapshot, latestSessionSnapshot);

    }
    processJamSnapshot(latestJamSnapshot);
    processSessionSnapshot(latestSessionSnapshot);
    worldRenderer.updateGlobal(api.getWorldSnapshot());

    // 7a. Hydrate spatial music placements
    const placementSnap = api.getMusicPlacements();
    instruments.updatePlacements(placementSnap);
    music.setMusicPlacements(placementSnap?.placements || []);

    // 7b. Hydrate recent bot activity so thoughts/code context isn't empty on load
    const recentActivity = await api.fetchActivity();
    hydrateRecentActivity(recentActivity);

    // 7c. Hydrate chat messages and init social panel
    const messages = await api.fetchMessages();
    ui.hydrateChat(messages);
    ui.initSocialPanel();
    ui.initChatInput();

    // 7d. Poll ritual state on load (catch mid-ritual joins)
    const ritualSnap = await api.fetchRitual();
    if (ritualSnap && ritualSnap.phase && ritualSnap.phase !== 'idle') {
        ui.renderRitualPanel(ritualSnap);
    }

    // 7e. Route listen mix by current camera room (center/east/west).
    installListenerRoomTracking();

    // 8. Listen for events
    api.onEvent((event, data) => {
        switch (event) {
            case 'composition':
                processComposition(data);
                syncMusicWithState(data, latestJamSnapshot, latestSessionSnapshot);
                ui.renderStatus();
                break;

            case 'slot_update':
                handleSlotUpdate(data);
                break;

            case 'bot_activity':
                handleBotActivity(data);
                break;

            case 'agent_message':
                ui.addChatMessage(data);
                break;

            case 'jam_snapshot':
                processJamSnapshot(data);
                syncMusicWithState(api.getComposition(), latestJamSnapshot, latestSessionSnapshot);
                ui.renderStatus();
                break;

            case 'jam_event':
                handleJamEvent(data);
                break;

            case 'session_snapshot':
                processSessionSnapshot(data);
                syncMusicWithState(api.getComposition(), latestJamSnapshot, latestSessionSnapshot);
                ui.renderStatus();
                break;

            case 'session_event':
                handleSessionEvent(data);
                break;

            case 'music_placement_snapshot':
                instruments.updatePlacements(data);
                music.setMusicPlacements(data?.placements || []);
                break;

            case 'world_snapshot':
                worldRenderer.updateGlobal(data);
                break;

            case 'avatar_updated':
                handleAvatarUpdated(data);
                break;

            case 'avatar_generating':
                handleAvatarGenerating(data);
                break;

            case 'ritual_phase':
                handleRitualPhase(data);
                break;

            case 'ritual_nomination':
                handleRitualNomination(data);
                break;

            case 'ritual_vote':
                handleRitualVote(data);
                break;

            case 'epoch_changed':
                handleEpochChanged(data);
                break;

            // --- Wayfinding events ---

            case 'wayfinding_move':
                handleWayfindingMove(data);
                break;

            case 'wayfinding_arrived':
                handleWayfindingArrived(data);
                break;

            case 'wayfinding_presence':
                handleWayfindingPresence(data);
                break;

            case 'connection':
                // Keep HUD quieter; connection churn is mostly transport noise.
                break;
        }
    });

    // 9. Initial UI render
    ui.renderStatus();
    installTestingHooks();
    installSessionActionHandler();

    // 10. Autoplay support for headless streaming (?autoplay=1)
    if (new URLSearchParams(window.location.search).has('autoplay')) {
        console.log('[app] Autoplay mode — starting music automatically');
        // Hide HUD for clean stream output
        const hud = document.getElementById('hud');
        if (hud) hud.style.display = 'none';
        // Short delay to let Strudel editor + composition hydrate
        setTimeout(() => music.start(), 2000);
    }

    console.log('[app] Ready');
}

function initCameraModeButton() {
    const btn = document.getElementById('camera-mode-btn');
    if (!btn) return;

    if (!scene.canUseFlyMode()) {
        btn.textContent = 'Camera: Orbit';
        btn.disabled = true;
        btn.title = 'Fly camera is desktop-only for now.';
        return;
    }

    const updateLabel = () => {
        const mode = scene.getCameraMode();
        const fly = mode === 'fly';
        btn.textContent = fly ? 'Camera: Fly' : 'Camera: Orbit';
        btn.classList.toggle('active', fly);
    };

    btn.addEventListener('click', () => {
        const mode = scene.toggleCameraMode();
        if (mode === 'fly') {
            ui.addLogEntry('Camera switched to fly (click scene to capture mouse, WASD/E/Q move, Ctrl boost)');
        } else {
            ui.addLogEntry('Camera switched to orbit');
        }
        btn.blur();
        updateLabel();
    });

    scene.onCameraModeChange(() => updateLabel());
    updateLabel();
}

async function initWalletConnect() {
    const btn = document.getElementById('wallet-btn');
    if (!btn) return;

    // Fetch project ID from server config endpoint (injected at build or via env)
    let projectId = null;
    try {
        const res = await fetch('/api/config/wallet');
        if (res.ok) {
            const data = await res.json();
            projectId = data.projectId;
        }
    } catch { /* wallet connect unavailable */ }

    if (!projectId) {
        // Wallet connect not configured — keep button hidden
        return;
    }

    const ok = await wallet.initWallet(projectId);
    if (!ok) return;

    // Show the button
    btn.style.display = '';

    function truncateAddress(addr) {
        if (!addr || addr.length < 10) return addr || '';
        return addr.slice(0, 6) + '...' + addr.slice(-4);
    }

    btn.addEventListener('click', async () => {
        if (wallet.isConnected()) {
            await wallet.disconnectWallet();
        } else {
            await wallet.connectWallet();
        }
    });

    wallet.onConnect(async (addr) => {
        btn.textContent = truncateAddress(addr);
        btn.classList.add('connected');
        btn.title = addr;

        // Auto-authenticate with server
        try {
            await wallet.authenticate();
            ui.addLogEntry(`Wallet connected: ${truncateAddress(addr)}`);
        } catch (err) {
            console.error('[wallet] Auth failed:', err);
            ui.addLogEntry('Wallet connected but auth failed');
        }
    });

    wallet.onDisconnect(() => {
        btn.textContent = 'Connect Wallet';
        btn.classList.remove('connected');
        btn.title = '';
        ui.addLogEntry('Wallet disconnected');
    });
}

function installListenerRoomTracking() {
    const nextRoom = scene.getCameraRoom ? scene.getCameraRoom() : 'center';
    listenerRoom = nextRoom || 'center';
    music.setListenerRoom(listenerRoom);

    // Feed initial camera position for spatial audio
    const cam = scene.getCamera();
    if (cam) {
        music.setCameraPosition(cam.position.x, cam.position.z);
    }

    scene.onUpdate(() => {
        // Room-based listener tracking (legacy)
        const room = scene.getCameraRoom ? scene.getCameraRoom() : 'center';
        const normalized = room || 'center';
        if (normalized !== listenerRoom) {
            listenerRoom = normalized;
            music.setListenerRoom(listenerRoom);
            if (music.getIsPlaying()) {
                music.updatePatterns();
            }
        }

        // Spatial audio: feed camera position every frame
        const camera = scene.getCamera();
        if (camera) {
            music.setCameraPosition(camera.position.x, camera.position.z);
        }
    });
}

function hashNameToIndex(name, modulo) {
    if (!name || modulo <= 0) return 0;
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }
    return hash % modulo;
}

function deriveJamStyle(botName, pattern, sessionType) {
    // Non-music session types get dedicated animation styles
    if (sessionType === 'visual') return 'paint';
    if (sessionType === 'world') return 'build';
    if (sessionType === 'game') return 'play';

    const source = String(pattern || '').toLowerCase();
    if (!source) {
        const defaults = ['dance', 'headbob', 'chatGesture'];
        return defaults[hashNameToIndex(botName, defaults.length)] || 'dance';
    }
    if (/(bd|sd|hh|cp|kick|snare|rim)\b/.test(source)) return 'drums';
    if (/\b(note|n)\s*\(/.test(source) && /[a-g][#b]?[12]\b/.test(source)) return 'bass';
    if (/piano|keys|chord|maj|min|\[[^\]]+\]/.test(source)) return 'piano';
    if (/guitar|lead|melody|pluck|arp/.test(source)) return 'guitar';
    if (/chat|talk|gesture/.test(source)) return 'chatGesture';
    if (/cheer|clap/.test(source)) return 'cheer';
    return 'dance';
}

function processJamSnapshot(snapshot) {
    latestJamSnapshot = normalizeJamSnapshot(snapshot);
    const spotsById = new Map(
        latestJamSnapshot.spots.map((spot) => [spot.id, spot])
    );
    const slotHolderNames = new Set(Array.from(slotHolders.values()));
    const nextAssignments = new Map();

    for (const session of latestJamSnapshot.sessions) {
        const spot = spotsById.get(session.spotId);
        if (!spot) continue;
        const participants = Array.isArray(session.participants)
            ? [...session.participants].sort((a, b) => String(a.joinedAt || '').localeCompare(String(b.joinedAt || '')))
            : [];
        const count = Math.max(1, participants.length);
        participants.forEach((participant, index) => {
            if (!participant?.botName) return;
            const assignment = {
                jamId: session.id,
                center: { x: spot.x, z: spot.z },
                style: deriveJamStyle(participant.botName, participant.pattern || ''),
                participantIndex: index,
                participantCount: count,
                room: spot.room,
            };
            nextAssignments.set(participant.botName, assignment);
            if (slotHolderNames.has(participant.botName)) return;

            const remembered = botAvatarSpecs.get(participant.botName);
            avatars.assignToJam(participant.botName, {
                ...assignment,
                customGlbUrl: remembered?.glbUrl || null,
                customAvatarHeight: remembered?.avatarHeight ?? null,
            });
        });
    }

    for (const [botName] of jamAssignments.entries()) {
        if (nextAssignments.has(botName)) continue;
        if (slotHolderNames.has(botName)) continue;
        avatars.removeFromJam(botName);
    }

    jamAssignments.clear();
    for (const [botName, assignment] of nextAssignments.entries()) {
        jamAssignments.set(botName, assignment);
    }
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

// Renderer dispatch for non-music session types
const sessionRenderers = {
    visual: visualRenderer,
    world: worldRenderer,
    game: gameRenderer,
};

function processSessionSnapshot(snapshot) {
    latestSessionSnapshot = normalizeSessionSnapshot(snapshot);
    const slotHolderNames = new Set(Array.from(slotHolders.values()));
    const nextAssignments = new Map();

    // Track which sessions are active per type for cleanup
    const activeSessionsByType = { visual: new Set(), world: new Set(), game: new Set() };

    for (const session of latestSessionSnapshot.sessions) {
        const sessionType = session.type || 'music';
        const position = session.position || { x: 0, z: 0, room: 'center' };
        const participants = Array.isArray(session.participants)
            ? [...session.participants].sort((a, b) => String(a.joinedAt || '').localeCompare(String(b.joinedAt || '')))
            : [];
        const count = Math.max(1, participants.length);

        // Dispatch to type-specific renderer
        const renderer = sessionRenderers[sessionType];
        if (renderer) {
            activeSessionsByType[sessionType]?.add(session.id);
            renderer.update(session);
        }

        participants.forEach((participant, index) => {
            if (!participant?.botName) return;
            const assignment = {
                sessionId: session.id,
                center: { x: position.x, z: position.z },
                style: deriveJamStyle(participant.botName, participant.pattern || '', sessionType),
                participantIndex: index,
                participantCount: count,
                room: position.room || 'center',
            };
            nextAssignments.set(participant.botName, assignment);
            if (slotHolderNames.has(participant.botName)) return;
            if (jamAssignments.has(participant.botName)) return;

            const remembered = botAvatarSpecs.get(participant.botName);
            avatars.assignToSession(participant.botName, {
                ...assignment,
                customGlbUrl: remembered?.glbUrl || null,
                customAvatarHeight: remembered?.avatarHeight ?? null,
            });
        });
    }

    // Clean up renderers for sessions that disappeared
    for (const [type, renderer] of Object.entries(sessionRenderers)) {
        const activeIds = activeSessionsByType[type] || new Set();
        renderer.removeStale(activeIds);
    }

    for (const [botName] of sessionAssignments.entries()) {
        if (nextAssignments.has(botName)) continue;
        if (slotHolderNames.has(botName)) continue;
        if (jamAssignments.has(botName)) continue;
        avatars.removeFromSession(botName);
    }

    sessionAssignments.clear();
    for (const [botName, assignment] of nextAssignments.entries()) {
        sessionAssignments.set(botName, assignment);
    }
}

function handleSessionEvent(data) {
    const eventType = String(data?.event || data?.type || '');
    const botName = data?.bot_name || data?.botName || data?.creatorBotName || 'bot';
    const sessionId = data?.session_id || data?.sessionId || '';
    const shortId = sessionId ? String(sessionId).slice(0, 8) : '';

    if (eventType === 'session_created') {
        ui.addLogEntry(`${botName} started session ${shortId}`);
    } else if (eventType === 'session_joined') {
        ui.addLogEntry(`${botName} joined session ${shortId}`);
    } else if (eventType === 'session_left') {
        ui.addLogEntry(`${botName} left session ${shortId}`);
    } else if (eventType === 'session_ended') {
        ui.addLogEntry(`Session ${shortId} ended`);
    }
}

// --- Process full composition ---

function processComposition(comp) {
    if (!comp || !comp.slots) return;
    let activeSlots = 0;
    let changedAssignments = 0;

    for (const slot of comp.slots) {
        if (slot.code && slot.agent) {
            activeSlots++;
            if (slot.agent.avatarGlbUrl) {
                setBotAvatarSpec(
                    slot.agent.name,
                    slot.agent.avatarGlbUrl,
                    slot.agent.avatarHeight ?? null
                );
            }
            const prevHolder = slotHolders.get(slot.id);
            const remembered = botAvatarSpecs.get(slot.agent.name);
            const avatarGlbUrl = slot.agent.avatarGlbUrl || remembered?.glbUrl || null;
            const avatarHeight =
                toAvatarHeight(slot.agent.avatarHeight) ?? remembered?.avatarHeight ?? null;
            if (avatarGlbUrl) {
                setBotAvatarSpec(slot.agent.name, avatarGlbUrl, avatarHeight);
            }

            if (prevHolder !== slot.agent.name) {
                // New holder for this slot
                if (prevHolder) {
                    avatars.removeFromSlot(prevHolder);
                }

                slotHolders.set(slot.id, slot.agent.name);
                avatars.assignToSlot(slot.agent.name, slot.id, avatarGlbUrl, avatarHeight);
                changedAssignments++;
            }
        } else {
            // Slot is empty
            const prevHolder = slotHolders.get(slot.id);
            if (prevHolder) {
                avatars.removeFromSlot(prevHolder);
                slotHolders.delete(slot.id);
                changedAssignments++;
            }
        }
    }

    if (activeSlots > 0 && changedAssignments > 0) {
        console.log(
            `[app] Synced ${activeSlots} active slots, holders tracked: ${slotHolders.size}`
        );
    }

    processJamSnapshot(latestJamSnapshot);
}

// --- Handle individual slot update ---

function handleSlotUpdate(data) {
    const prevHolder = slotHolders.get(data.slot);
    const newHolder = data.agent?.name;
    if (newHolder && data.agent?.avatarGlbUrl) {
        setBotAvatarSpec(newHolder, data.agent.avatarGlbUrl, data.agent.avatarHeight ?? null);
    }

    if (prevHolder && prevHolder !== newHolder) {
        // Someone got overwritten -- play the drama!
        avatars.playOverwriteDrama(newHolder, prevHolder);
        ui.addLogEntry(`${newHolder} overwrote ${prevHolder}`);
    } else if (!prevHolder && newHolder) {
        ui.addLogEntry(`${newHolder} started composing`);
    }

    if (newHolder) {
        slotHolders.set(data.slot, newHolder);
        const remembered = botAvatarSpecs.get(newHolder);
        const avatarGlbUrl = data.agent?.avatarGlbUrl || remembered?.glbUrl || null;
        const avatarHeight =
            toAvatarHeight(data.agent?.avatarHeight) ?? remembered?.avatarHeight ?? null;
        if (avatarGlbUrl) {
            setBotAvatarSpec(newHolder, avatarGlbUrl, avatarHeight);
        }
        avatars.assignToSlot(newHolder, data.slot, avatarGlbUrl, avatarHeight);
    }

    syncMusicWithState(api.getComposition(), latestJamSnapshot, latestSessionSnapshot);

    processJamSnapshot(latestJamSnapshot);

    ui.renderStatus();
}

// --- Handle bot activity (reasoning) ---

function handleBotActivity(data) {
    const shouldShowReasoning =
        data.reasoning &&
        (data.result === 'thinking' || data.result === 'claimed');

    if (shouldShowReasoning) {
        avatars.setThinking(data.botName, data.reasoning);
        ui.setLatestThought(data.botName, data.reasoning);
        ui.showReasoning(data.botName, data.reasoning);
    }

    if (data.result === 'claimed') {
        ui.addLogEntry(
            `${data.botName} submitted ${data.targetSlotType || 'pattern'}`
        );
    } else if (data.result === 'rejected') {
        ui.addLogEntry(
            `${data.botName} pattern rejected`
        );
    } else if (data.result === 'error') {
        ui.addLogEntry(
            `${data.botName} error ${data.resultDetail || ''}`
        );
    }
}

function handleAvatarUpdated(data) {
    const botName = data?.botName;
    if (!botName) return;

    if (typeof data.avatarGlbUrl === 'string' && data.avatarGlbUrl.length > 0) {
        setBotAvatarSpec(botName, data.avatarGlbUrl, data.avatarHeight ?? null);
    } else {
        botAvatarSpecs.delete(botName);
    }

    for (const [slotId, holderName] of slotHolders.entries()) {
        if (holderName !== botName) continue;
        const spec = botAvatarSpecs.get(botName);
        const avatarGlbUrl = spec?.glbUrl || null;
        const avatarHeight = spec?.avatarHeight ?? null;
        avatars.assignToSlot(botName, slotId, avatarGlbUrl, avatarHeight);
    }

    processJamSnapshot(latestJamSnapshot);
}

function handleAvatarGenerating(data) {
    if (!data?.bot_name) return;
    if (data.status === 'failed') {
        ui.addLogEntry(`${data.bot_name} avatar generation failed`);
    } else if (data.status === 'complete') {
        ui.addLogEntry(`${data.bot_name} avatar ready`);
    }
}

// --- Ritual event handlers ---

async function handleRitualPhase(data) {
    if (data.phase === 'idle') {
        if (data.fizzled && data.randomized) {
            ui.renderRitualFizzle(data);
        } else {
            ui.hideRitualPanel();
        }
        return;
    }

    // Fetch full state from server for accurate view
    const state = await api.fetchRitual();
    if (state) {
        ui.renderRitualPanel(state);
    } else {
        // Fall back to SSE data
        ui.renderRitualPanel(data);
    }
}

function handleRitualNomination(data) {
    // During nominate phase, update nomination counts in the panel
    const state = api.getRitualState();
    if (state && state.phase === 'nominate') {
        ui.renderRitualPanel(state);
    }
}

async function handleRitualVote(data) {
    // During vote phase, update vote counts on candidates
    const state = api.getRitualState();
    if (state && state.phase === 'vote') {
        ui.renderRitualPanel(state);
    }
}

function handleEpochChanged(data) {
    // Epoch changed — composition will also arrive, just log it
    if (data?.bpm && data?.key) {
        ui.addLogEntry(`World shifted: ${data.bpm} BPM, ${data.key} ${data.scale || ''}`);
    }
}

function handleJamEvent(data) {
    const eventType = String(data?.event || data?.type || '');
    const botName = data?.bot_name || data?.botName || 'bot';
    const jamId = data?.jam_id || data?.jamId || '';
    const shortId = jamId ? String(jamId).slice(0, 8) : '';

    if (eventType === 'jam_created') {
        ui.addLogEntry(`${botName} started jam ${shortId}`);
    } else if (eventType === 'jam_joined') {
        ui.addLogEntry(`${botName} joined jam ${shortId}`);
    } else if (eventType === 'jam_left') {
        ui.addLogEntry(`${botName} left jam ${shortId}`);
    } else if (eventType === 'jam_ended') {
        ui.addLogEntry(`${botName} ended jam ${shortId}`);
    }
}

function hydrateRecentActivity(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;

    const recent = entries.slice(-12);
    for (const entry of recent) {
        if (entry?.botName && entry?.reasoning) {
            ui.setLatestThought(entry.botName, entry.reasoning);
        }
    }

    // Show only a few recent thoughts in the visible feed on load.
    for (const entry of recent.slice(-4)) {
        if (entry?.botName && entry?.reasoning) {
            ui.showReasoning(entry.botName, entry.reasoning);
        }
    }
}

function buildCompositionSignature(comp) {
    if (!comp || !comp.slots) return '';
    return comp.slots
        .map((slot) => `${slot.id}:${slot.code || ''}:${slot.agent?.name || ''}`)
        .join('|');
}

function buildJamSignature(snapshot) {
    const jam = normalizeJamSnapshot(snapshot);
    return jam.sessions
        .map((session) => {
            const participants = Array.isArray(session.participants) ? session.participants : [];
            const memberSig = participants
                .map((participant) => `${participant.botName || ''}:${participant.pattern || ''}`)
                .sort()
                .join(',');
            return `${session.id}:${session.spotId}:${memberSig}`;
        })
        .sort()
        .join('|');
}

function buildSessionSignature(snapshot) {
    const sess = normalizeSessionSnapshot(snapshot);
    return sess.sessions
        .map((session) => {
            const participants = Array.isArray(session.participants) ? session.participants : [];
            const memberSig = participants
                .map((p) => `${p.botName || ''}:${p.pattern || ''}`)
                .sort()
                .join(',');
            return `${session.id}:${session.type}:${memberSig}`;
        })
        .sort()
        .join('|');
}

function syncMusicWithState(comp, jamSnap, sessionSnap) {
    const nextCompSig = buildCompositionSignature(comp);
    const nextJamSig = buildJamSignature(jamSnap);
    const nextSessionSig = buildSessionSignature(sessionSnap);
    const changed =
        nextCompSig !== compositionSignature ||
        nextJamSig !== jamSignature ||
        nextSessionSig !== sessionSignature;
    if (!changed) return;

    compositionSignature = nextCompSig;
    jamSignature = nextJamSig;
    sessionSignature = nextSessionSig;
    music.setJamSnapshot(normalizeJamSnapshot(jamSnap));
    music.setSessionSnapshot(normalizeSessionSnapshot(sessionSnap));

    if (music.getIsPlaying()) {
        music.updatePatterns();
    }
}

function installTestingHooks() {
    window.render_game_to_text = () => {
        const comp = api.getComposition();
        const cam = scene.getCamera();
        return JSON.stringify({
            camera: cam ? {
                mode: scene.getCameraMode(),
                environment: scene.getEnvironmentMode(),
                room: scene.getCameraRoom ? scene.getCameraRoom() : null,
                position: {
                    x: Number(cam.position.x.toFixed(3)),
                    y: Number(cam.position.y.toFixed(3)),
                    z: Number(cam.position.z.toFixed(3)),
                },
            } : null,
            audio: {
                playing: music.getIsPlaying(),
                masterGain: Number(music.getMasterGain().toFixed(3)),
                soloSlot: music.getSoloSlot(),
                mutedSlots: Array.from(music.getMutedSlots()).sort((a, b) => a - b),
                outputRms: Number(music.getOutputRms().toFixed(5)),
                outputRmsDb: Number(music.getOutputRmsDb().toFixed(1)),
                listenerRoom: listenerRoom,
            },
            slots: comp?.slots?.map((slot) => ({
                id: slot.id,
                type: slot.type,
                active: Boolean(slot.code),
                holder: slot.agent?.name || null,
                avatarGlbUrl: slot.agent?.avatarGlbUrl || null,
                level: Number(music.getSlotLevel(slot.id).toFixed(3)),
            })) || [],
            jams: {
                sessions: latestJamSnapshot.sessions.length,
                participants: latestJamSnapshot.sessions.reduce((sum, session) => {
                    const count = Array.isArray(session.participants) ? session.participants.length : 0;
                    return sum + count;
                }, 0),
                rooms: latestJamSnapshot.sessions.reduce((acc, session) => {
                    const room = String(session.room || 'center');
                    acc[room] = (acc[room] || 0) + 1;
                    return acc;
                }, {}),
            },
            sessions: {
                total: latestSessionSnapshot.sessions.length,
                participants: latestSessionSnapshot.sessions.reduce((sum, session) => {
                    const count = Array.isArray(session.participants) ? session.participants.length : 0;
                    return sum + count;
                }, 0),
                subscribed: Array.from(music.getSubscribedSessions()),
            },
            renderers: {
                visual: visualRenderer.getState(),
                world: worldRenderer.getState(),
                game: gameRenderer.getState(),
            },
        });
    };
}

function installSessionActionHandler() {
    window._sessionActionHandler = (sessionId, sessionType) => {
        const renderer = sessionRenderers[sessionType];
        if (!renderer) return;
        renderer.toggle(sessionId);
    };
}

// --- Go ---
main().catch(err => console.error('[app] Fatal error:', err));
