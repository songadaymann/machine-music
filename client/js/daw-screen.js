// daw-screen.js -- In-world timeline screen that visualizes slots like a DAW.

import * as THREE from 'three';
import * as music from './music.js';
import { getCamera, onUpdate } from './scene.js';
import { deriveStepGrid, humanizePattern } from './pattern-humanize.js';

const SCREEN_WIDTH = 1408;
const SCREEN_HEIGHT = 768;
const GRID_STEPS = 16;
const MAX_TRACKS = 8;
const REDRAW_INTERVAL = 1 / 14;

const SLOT_COLORS = {
    drums: '#ff9258',
    bass: '#72b2ff',
    chords: '#a88cff',
    melody: '#8ddf95',
    wild: '#ffd36d',
};

const TRACK_LAYOUT = Object.freeze({
    leftPad: 22,
    gridTop: 126,
    rowHeight: 74,
    gridLeft: 430,
    gridRightPad: 40,
    meterX: 304,
    meterW: 104,
    meterH: 12,
    buttonMuteX: 340,
    buttonSoloX: 374,
    buttonY: 42,
    buttonW: 28,
    buttonH: 22,
});

let sceneRef = null;
let canvasEl = null;
let screenRoot = null;
let panelMesh = null;
let screenCanvas = null;
let screenCtx = null;
let screenTexture = null;
let composition = null;
let dirty = true;
let redrawCooldown = 0;
let lastPlayhead = -1;
let lastMixerSignature = '';
const meterLevels = new Map();
let buttonHitboxes = [];
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

export function init(scene, canvas) {
    if (!scene || screenRoot) return;
    sceneRef = scene;
    canvasEl = canvas || null;

    screenCanvas = document.createElement('canvas');
    screenCanvas.width = SCREEN_WIDTH;
    screenCanvas.height = SCREEN_HEIGHT;
    screenCtx = screenCanvas.getContext('2d');

    screenTexture = new THREE.CanvasTexture(screenCanvas);
    screenTexture.colorSpace = THREE.SRGBColorSpace;
    screenTexture.minFilter = THREE.NearestFilter;
    screenTexture.magFilter = THREE.NearestFilter;
    screenTexture.generateMipmaps = false;

    screenRoot = buildScreenMesh();
    sceneRef.add(screenRoot);

    installInteractionHandlers();
    drawScreen(0, -1);
    onUpdate((delta, elapsed) => tick(delta, elapsed));
}

export function setComposition(next) {
    composition = next || null;
    dirty = true;
}

export function getTimelineState() {
    return {
        visible: Boolean(screenRoot),
        playheadStep: lastPlayhead,
        tracks: (composition?.slots || []).slice(0, MAX_TRACKS).map((slot) => ({
            id: slot.id,
            type: slot.type,
            holder: slot.agent?.name || null,
            summary: humanizePattern(slot.code, slot.type),
        })),
    };
}

function buildScreenMesh() {
    const group = new THREE.Group();
    group.name = 'daw-timeline-screen';
    group.position.set(0, 15.8, -18.5);
    group.rotation.x = -0.035;

    const body = new THREE.Mesh(
        new THREE.BoxGeometry(33.6, 19.0, 0.65),
        new THREE.MeshStandardMaterial({
            color: 0x0c111a,
            roughness: 0.66,
            metalness: 0.42,
        })
    );
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const bezel = new THREE.Mesh(
        new THREE.PlaneGeometry(31.8, 17.4),
        new THREE.MeshStandardMaterial({
            color: 0x1f2838,
            roughness: 0.72,
            metalness: 0.16,
            emissive: 0x101520,
            emissiveIntensity: 0.35,
        })
    );
    bezel.position.z = 0.34;
    group.add(bezel);

    const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(30.4, 16.2),
        new THREE.MeshBasicMaterial({
            map: screenTexture,
            transparent: false,
            toneMapped: false,
        })
    );
    panel.name = 'daw-screen-panel';
    panel.position.z = 0.35;
    group.add(panel);
    panelMesh = panel;

    const supportBar = new THREE.Mesh(
        new THREE.BoxGeometry(1.35, 5.5, 0.92),
        new THREE.MeshStandardMaterial({
            color: 0x131b28,
            roughness: 0.8,
            metalness: 0.22,
        })
    );
    supportBar.position.set(0, -12.8, -0.1);
    supportBar.castShadow = true;
    supportBar.receiveShadow = true;
    group.add(supportBar);

    const base = new THREE.Mesh(
        new THREE.BoxGeometry(10.4, 0.56, 3.15),
        new THREE.MeshStandardMaterial({
            color: 0x182130,
            roughness: 0.82,
            metalness: 0.2,
        })
    );
    base.position.set(0, -16.4, 0.22);
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    return group;
}

function tick(delta, elapsed) {
    if (!screenCtx || !screenTexture) return;
    redrawCooldown -= delta;

    const mixerSignature = getMixerSignature();
    if (mixerSignature !== lastMixerSignature) {
        lastMixerSignature = mixerSignature;
        dirty = true;
    }

    const bpm = composition?.bpm || 120;
    const playhead = computePlayheadStep(elapsed, bpm, music.getIsPlaying());
    const playheadChanged = playhead !== lastPlayhead;
    if (playheadChanged) lastPlayhead = playhead;

    if (!dirty && !playheadChanged && redrawCooldown > 0) return;

    drawScreen(elapsed, playhead);
    dirty = false;
    redrawCooldown = REDRAW_INTERVAL;
}

function computePlayheadStep(elapsedSeconds, bpm, isPlaying) {
    if (!isPlaying) return -1;
    const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
    const stepRate = (safeBpm / 60) * 4; // 16th-note resolution
    const step = Math.floor(elapsedSeconds * stepRate) % GRID_STEPS;
    return step < 0 ? step + GRID_STEPS : step;
}

function drawScreen(elapsed, playheadStep) {
    const ctx = screenCtx;
    const width = SCREEN_WIDTH;
    const height = SCREEN_HEIGHT;

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#273f5f');
    gradient.addColorStop(0.45, '#1a2f4a');
    gradient.addColorStop(1, '#101e33');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    drawHeader(ctx, width, elapsed);
    drawTimelineGrid(ctx, width, height, playheadStep);
    drawTracks(ctx, width, playheadStep);

    screenTexture.needsUpdate = true;
}

function drawHeader(ctx, width, elapsed) {
    const topGlow = 20 + Math.sin(elapsed * 0.7) * 6;
    ctx.fillStyle = 'rgba(213, 238, 255, 0.16)';
    ctx.fillRect(0, 0, width, 96);
    ctx.fillStyle = '#eef7ff';
    ctx.font = '700 32px "IBM Plex Mono", monospace';
    ctx.fillText('SYNTHMOB ARRANGER', 34, 52);

    ctx.fillStyle = '#d4e7ff';
    ctx.font = '500 19px "IBM Plex Mono", monospace';
    ctx.fillText('Live Timeline  |  16-step view', 36, 82);

    ctx.fillStyle = 'rgba(178, 232, 255, 0.32)';
    ctx.fillRect(width - 366, 24, 320, 64);
    ctx.strokeStyle = 'rgba(209, 241, 255, 0.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(width - 366, 24, 320, 64);
    ctx.fillStyle = '#f0fdff';
    ctx.font = '700 21px "IBM Plex Mono", monospace';
    ctx.fillText(music.getIsPlaying() ? 'TRANSPORT: PLAY' : 'TRANSPORT: STOP', width - 342, 51);
    const db = music.getOutputRmsDb();
    const dbLabel = Number.isFinite(db) ? `${db.toFixed(1)} dB` : '--';
    ctx.fillStyle = '#d9f0ff';
    ctx.font = '600 15px "IBM Plex Mono", monospace';
    ctx.fillText(`MASTER RMS ${dbLabel}`, width - 342, 78);

    ctx.fillStyle = `rgba(190, 236, 255, 0.45)`;
    ctx.fillRect(26, 98, width - 52, 2);
    ctx.fillStyle = `rgba(238, 251, 255, ${Math.max(0.2, topGlow / 160)})`;
    ctx.fillRect(26, 100, width - 52, 2);
}

function drawTimelineGrid(ctx, width, height, playheadStep) {
    const gridLeft = TRACK_LAYOUT.gridLeft;
    const gridTop = TRACK_LAYOUT.gridTop;
    const gridWidth = width - gridLeft - TRACK_LAYOUT.gridRightPad;
    const rowHeight = TRACK_LAYOUT.rowHeight;
    const totalRows = MAX_TRACKS;
    const cellWidth = gridWidth / GRID_STEPS;

    for (let i = 0; i <= GRID_STEPS; i++) {
        const x = gridLeft + i * cellWidth;
        const isBeat = i % 4 === 0;
        ctx.strokeStyle = isBeat ? 'rgba(220, 241, 255, 0.42)' : 'rgba(180, 214, 245, 0.2)';
        ctx.beginPath();
        ctx.moveTo(x, gridTop);
        ctx.lineTo(x, gridTop + rowHeight * totalRows);
        ctx.stroke();
    }

    for (let beat = 0; beat < 4; beat++) {
        const x = gridLeft + beat * cellWidth * 4 + 2;
        ctx.fillStyle = '#e0efff';
        ctx.font = '600 15px "IBM Plex Mono", monospace';
        ctx.fillText(`BAR ${beat + 1}`, x, gridTop - 15);
    }

    if (playheadStep >= 0) {
        const x = gridLeft + playheadStep * cellWidth;
        ctx.fillStyle = 'rgba(255, 249, 208, 0.28)';
        ctx.fillRect(x, gridTop, cellWidth, rowHeight * totalRows);
        ctx.strokeStyle = 'rgba(255, 246, 181, 0.9)';
        ctx.strokeRect(x + 0.5, gridTop + 0.5, cellWidth - 1, rowHeight * totalRows - 1);
    }

    const footerY = height - 18;
    ctx.fillStyle = '#cadef7';
    ctx.font = '500 14px "IBM Plex Mono", monospace';
    ctx.fillText('Each lane translates pattern code into clip-style timing blocks for quick reading.', 24, footerY);
}

function drawTracks(ctx, width, playheadStep) {
    const slots = composition?.slots?.slice(0, MAX_TRACKS) || [];
    const gridLeft = TRACK_LAYOUT.gridLeft;
    const gridTop = TRACK_LAYOUT.gridTop;
    const gridWidth = width - gridLeft - TRACK_LAYOUT.gridRightPad;
    const rowHeight = TRACK_LAYOUT.rowHeight;
    const cellWidth = gridWidth / GRID_STEPS;
    const mutedSlots = music.getMutedSlots();
    const soloSlot = music.getSoloSlot();
    const outputRms = music.getOutputRms();
    const masterGain = music.getMasterGain();
    buttonHitboxes = [];

    for (let i = 0; i < MAX_TRACKS; i++) {
        const slot = slots[i] || null;
        const y = gridTop + i * rowHeight;
        const rowTop = y + 5;

        ctx.fillStyle = i % 2 === 0 ? 'rgba(18, 35, 56, 0.82)' : 'rgba(14, 29, 47, 0.82)';
        ctx.fillRect(22, rowTop, width - 44, rowHeight - 10);

        if (!slot) continue;

        const slotColor = SLOT_COLORS[slot.type] || '#9cb4d2';
        const slotLabel = `${String(slot.id).padStart(2, '0')} ${String(slot.type || '').toUpperCase()}`;
        const holderLabel = slot.agent?.name || '---';
        const humanSummary = humanizePattern(slot.code, slot.type);
        const timeline = deriveStepGrid(slot.code, slot.type, GRID_STEPS);
        const isMuted = mutedSlots.has(slot.id);
        const isSolo = soloSlot === slot.id;

        const audible = Boolean(slot.code) && !isMuted && (soloSlot === null || isSolo);
        const slotGain = music.getSlotLevel(slot.id);
        const targetMeter = audible ? Math.min(1, outputRms * 9 * masterGain * slotGain) : 0;
        const prevMeter = meterLevels.get(slot.id) ?? 0;
        const meterLevel = prevMeter * 0.74 + targetMeter * 0.26;
        meterLevels.set(slot.id, meterLevel);

        ctx.fillStyle = slotColor;
        ctx.font = '700 18px "IBM Plex Mono", monospace';
        ctx.fillText(slotLabel, 30, y + 32);

        ctx.fillStyle = '#e3f2ff';
        ctx.font = '600 16px "IBM Plex Mono", monospace';
        ctx.fillText(holderLabel, 150, y + 32);

        ctx.fillStyle = '#d2e7ff';
        ctx.font = '500 15px "IBM Plex Mono", monospace';
        ctx.fillText(humanSummary, 30, y + 58);

        drawMeter(ctx, {
            x: TRACK_LAYOUT.meterX,
            y: y + 20,
            width: TRACK_LAYOUT.meterW,
            height: TRACK_LAYOUT.meterH,
            level: meterLevel,
            color: slotColor,
        });

        drawToggleButton(ctx, {
            x: TRACK_LAYOUT.buttonMuteX,
            y: y + TRACK_LAYOUT.buttonY,
            width: TRACK_LAYOUT.buttonW,
            height: TRACK_LAYOUT.buttonH,
            label: 'M',
            active: isMuted,
            activeColor: '#ff6f63',
            inactiveColor: '#4f6480',
        });
        drawToggleButton(ctx, {
            x: TRACK_LAYOUT.buttonSoloX,
            y: y + TRACK_LAYOUT.buttonY,
            width: TRACK_LAYOUT.buttonW,
            height: TRACK_LAYOUT.buttonH,
            label: 'S',
            active: isSolo,
            activeColor: '#6be8d2',
            inactiveColor: '#4f6480',
        });

        buttonHitboxes.push({
            slotId: slot.id,
            action: 'mute',
            x: TRACK_LAYOUT.buttonMuteX,
            y: y + TRACK_LAYOUT.buttonY,
            width: TRACK_LAYOUT.buttonW,
            height: TRACK_LAYOUT.buttonH,
        });
        buttonHitboxes.push({
            slotId: slot.id,
            action: 'solo',
            x: TRACK_LAYOUT.buttonSoloX,
            y: y + TRACK_LAYOUT.buttonY,
            width: TRACK_LAYOUT.buttonW,
            height: TRACK_LAYOUT.buttonH,
        });

        for (let step = 0; step < GRID_STEPS; step++) {
            const x = gridLeft + step * cellWidth + 1;
            const cellY = y + 18;
            const cellH = 40;
            const blockW = Math.max(4, cellWidth - 2);
            const isActive = timeline.steps[step]?.active;

            ctx.fillStyle = isActive
                ? slotColorToFill(slotColor, playheadStep === step)
                : 'rgba(73, 99, 132, 0.36)';
            ctx.fillRect(x, cellY, blockW, cellH);

            if (isActive) {
                ctx.strokeStyle = 'rgba(241, 250, 255, 0.48)';
                ctx.strokeRect(x + 0.5, cellY + 0.5, blockW - 1, cellH - 1);
            }
        }
    }
}

function slotColorToFill(hexColor, emphasize) {
    const color = new THREE.Color(hexColor);
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    return emphasize
        ? `rgba(${r}, ${g}, ${b}, 0.98)`
        : `rgba(${r}, ${g}, ${b}, 0.86)`;
}

function drawMeter(ctx, { x, y, width, height, level, color }) {
    ctx.fillStyle = 'rgba(35, 51, 73, 0.9)';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = 'rgba(196, 223, 250, 0.4)';
    ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);

    const fill = Math.max(0, Math.min(width, width * level));
    if (fill > 0.5) {
        const rgba = slotColorToFill(color, false).replace(', 0.86)', ', 0.96)');
        ctx.fillStyle = rgba;
        ctx.fillRect(x + 1, y + 1, Math.max(1, fill - 2), height - 2);
    }
}

function drawToggleButton(ctx, { x, y, width, height, label, active, activeColor, inactiveColor }) {
    ctx.fillStyle = active ? activeColor : 'rgba(27, 40, 59, 0.9)';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = active ? 'rgba(245, 250, 255, 0.75)' : 'rgba(147, 182, 218, 0.5)';
    ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);

    ctx.fillStyle = active ? '#041018' : inactiveColor;
    ctx.font = '700 14px "IBM Plex Mono", monospace';
    ctx.fillText(label, x + 8, y + 15);
}

function installInteractionHandlers() {
    if (!canvasEl || !panelMesh) return;
    canvasEl.addEventListener('click', onCanvasClickCapture, true);
}

function onCanvasClickCapture(event) {
    if (!canvasEl || !panelMesh) return;
    if (document.pointerLockElement === canvasEl) return;

    const camera = getCamera();
    if (!camera) return;

    const rect = canvasEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointerNdc, camera);
    const hits = raycaster.intersectObject(panelMesh, false);
    if (!hits.length) return;

    const uv = hits[0].uv;
    if (!uv) return;

    const screenX = uv.x * SCREEN_WIDTH;
    const screenY = (1 - uv.y) * SCREEN_HEIGHT;
    const hitbox = buttonHitboxes.find((box) =>
        screenX >= box.x &&
        screenX <= box.x + box.width &&
        screenY >= box.y &&
        screenY <= box.y + box.height
    );

    if (hitbox) {
        if (hitbox.action === 'mute') {
            music.toggleMute(hitbox.slotId);
        } else if (hitbox.action === 'solo') {
            music.toggleSolo(hitbox.slotId);
        }
        dirty = true;
    }

    // Interacting with the DAW screen should not capture pointer lock.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

function getMixerSignature() {
    const muted = Array.from(music.getMutedSlots()).sort((a, b) => a - b).join(',');
    const solo = music.getSoloSlot() ?? 'none';
    const levels = (composition?.slots || [])
        .map((slot) => `${slot.id}:${music.getSlotLevel(slot.id).toFixed(2)}`)
        .join('|');
    return `${solo}|${muted}|${levels}`;
}
