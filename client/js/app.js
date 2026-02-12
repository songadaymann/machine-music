// app.js -- Entry point: wires together scene, avatars, music, API, and UI

import * as api from './api.js';
import * as music from './music.js';
import * as scene from './scene.js';
import * as instruments from './instruments.js';
import * as avatars from './avatars.js';
import * as ui from './ui.js';
import * as debug from './debug.js';

// Track which bot holds which slot
const slotHolders = new Map(); // slotId -> botName
let compositionSignature = '';

async function main() {
    console.log('[app] The Music Place -- The Void');

    // 1. Init Three.js scene
    const canvas = document.getElementById('void-canvas');
    scene.init(canvas);

    // 2. Load avatar model + animations (async, falls back to procedural)
    //    Start this early so it can load in parallel with instruments
    const avatarLoadPromise = avatars.loadModel();

    // 3. Place instruments in semicircle (now async: loads GLB models)
    await instruments.init(scene.getScene());

    // 4. Wait for avatar model to finish loading
    await avatarLoadPromise;
    avatars.init();

    // 5. Connect to API
    await api.init();

    // 6. Init UI + debug panel
    ui.initPlayButton();
    debug.init();

    // 7. Process initial composition state
    const comp = api.getComposition();
    if (comp) {
        processComposition(comp);
        syncMusicWithComposition(comp);
    }

    // 7b. Hydrate recent bot activity so thoughts/code context isn't empty on load
    const recentActivity = await api.fetchActivity();
    hydrateRecentActivity(recentActivity);

    // 8. Listen for events
    api.onEvent((event, data) => {
        switch (event) {
            case 'composition':
                processComposition(data);
                syncMusicWithComposition(data);
                ui.renderSlotControls();
                ui.renderStatus();
                break;

            case 'slot_update':
                handleSlotUpdate(data);
                break;

            case 'bot_activity':
                handleBotActivity(data);
                break;

            case 'connection':
                ui.addLogEntry(`Connection: ${data.status}`);
                break;
        }
    });

    // 9. Initial UI render
    ui.renderSlotControls();
    ui.renderStatus();

    console.log('[app] Ready');
}

// --- Process full composition ---

function processComposition(comp) {
    if (!comp || !comp.slots) return;

    for (const slot of comp.slots) {
        if (slot.code && slot.agent) {
            const prevHolder = slotHolders.get(slot.id);

            if (prevHolder !== slot.agent.name) {
                // New holder for this slot
                if (prevHolder) {
                    avatars.removeFromSlot(prevHolder);
                }

                slotHolders.set(slot.id, slot.agent.name);
                avatars.assignToSlot(slot.agent.name, slot.id);
            }
        } else {
            // Slot is empty
            const prevHolder = slotHolders.get(slot.id);
            if (prevHolder) {
                avatars.removeFromSlot(prevHolder);
                slotHolders.delete(slot.id);
            }
        }
    }
}

// --- Handle individual slot update ---

function handleSlotUpdate(data) {
    const prevHolder = slotHolders.get(data.slot);
    const newHolder = data.agent?.name;

    if (prevHolder && prevHolder !== newHolder) {
        // Someone got overwritten -- play the drama!
        avatars.playOverwriteDrama(newHolder, prevHolder);
        ui.addLogEntry(`${newHolder} overwrote ${prevHolder} on slot ${data.slot}`);
    } else if (!prevHolder && newHolder) {
        ui.addLogEntry(`${newHolder} claimed slot ${data.slot}`);
    }

    if (newHolder) {
        slotHolders.set(data.slot, newHolder);
        avatars.assignToSlot(newHolder, data.slot);
    }

    syncMusicWithComposition(api.getComposition());

    ui.renderSlotControls();
    ui.renderStatus();
}

// --- Handle bot activity (reasoning) ---

function handleBotActivity(data) {
    if (data.reasoning) {
        avatars.setThinking(data.botName, data.reasoning);
        ui.setLatestThought(data.botName, data.reasoning);
        ui.showReasoning(data.botName, data.reasoning);
        ui.renderSlotControls();

        // Clear thinking state after a few seconds
        setTimeout(() => avatars.clearThinking(data.botName), 5000);
    }

    if (data.result === 'claimed') {
        ui.addLogEntry(
            `${data.botName} wrote slot ${data.targetSlot} (${data.targetSlotType})`
        );
    } else if (data.result === 'rejected') {
        ui.addLogEntry(
            `${data.botName} rejected on slot ${data.targetSlot}`
        );
    } else if (data.result === 'cooldown') {
        ui.addLogEntry(
            `${data.botName} cooldown ${data.resultDetail || ''}`
        );
    } else if (data.result === 'error') {
        ui.addLogEntry(
            `${data.botName} error ${data.resultDetail || ''}`
        );
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

function syncMusicWithComposition(comp) {
    const nextSig = buildCompositionSignature(comp);
    if (!nextSig || nextSig === compositionSignature) return;
    compositionSignature = nextSig;

    if (music.getIsPlaying()) {
        music.updatePatterns();
    }
}

// --- Go ---
main().catch(err => console.error('[app] Fatal error:', err));
