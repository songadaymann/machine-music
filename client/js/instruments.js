// instruments.js -- Dynamic spatial instrument placement
//
// GLB models served from /models/insrtuments/*.glb
// Instruments placed at arbitrary world positions by agents.
// Falls back to placeholder geometry if loading fails.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Map instrument type keys (from server InstrumentType) to model configs
const INSTRUMENT_MODELS = {
    '808':          { path: '/models/insrtuments/808.glb',                  scale: 0.001, yOffset: 0.65, rot: 1.558, color: 0xe74c3c },
    'cello':        { path: '/models/insrtuments/cello.glb',                scale: 1.26,  yOffset: 0.95, rot: 0,     color: 0x3498db },
    'dusty_piano':  { path: '/models/insrtuments/dusty_piano.glb',          scale: 1.46,  yOffset: 0,    rot: 0,     color: 0x9b59b6 },
    'synth':        { path: '/models/insrtuments/synth.glb',                scale: 0.01,  yOffset: 0.5,  rot: 0,     color: 0x2ecc71 },
    'prophet_5':    { path: '/models/insrtuments/prophet_5_synthesiser.glb', scale: 0.01,  yOffset: 0.3,  rot: 0,     color: 0xf39c12 },
    'synthesizer':  { path: '/models/insrtuments/synthesizer.glb',          scale: 0.01,  yOffset: 0.5,  rot: 0,     color: 0x1abc9c },
    'tr66':         { path: '/models/insrtuments/tr-66_rhythm_arranger.glb', scale: 0.01,  yOffset: 0.5,  rot: 0,     color: 0xe67e22 },
};

// Actively placed instruments: placementId -> { group, placement }
const livePlacements = new Map();

let sceneRef = null;

// --- Loader ---

const loader = new GLTFLoader();
const modelCache = new Map(); // instrumentType -> THREE.Group (cloneable template)

function loadGLB(path) {
    return new Promise((resolve, reject) => {
        loader.load(path, resolve, undefined, reject);
    });
}

// --- Preload all instrument models ---

async function preloadModels() {
    const types = Object.keys(INSTRUMENT_MODELS);
    await Promise.allSettled(
        types.map(async (type) => {
            const config = INSTRUMENT_MODELS[type];
            if (!config) return;
            try {
                const gltf = await loadGLB(config.path);
                const model = gltf.scene;
                model.scale.setScalar(config.scale);
                model.position.y = config.yOffset;
                model.rotation.y = config.rot || 0;
                model.traverse((child) => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });
                modelCache.set(type, model);
                console.log(`[instruments] Loaded ${type} model`);
            } catch (err) {
                console.warn(`[instruments] Failed to load ${type} model:`, err.message);
            }
        })
    );
}

// --- Create placeholder instrument (fallback when GLB unavailable) ---

function createPlaceholderInstrument(instrumentType) {
    const config = INSTRUMENT_MODELS[instrumentType] || {};
    const color = config.color || 0x888888;

    const group = new THREE.Group();

    // Base platform
    const platformGeo = new THREE.CylinderGeometry(0.6, 0.6, 0.05, 16);
    const platformMat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.7,
        metalness: 0.3,
        emissive: color,
        emissiveIntensity: 0.1,
    });
    const platform = new THREE.Mesh(platformGeo, platformMat);
    platform.position.y = 0.025;
    platform.receiveShadow = true;
    group.add(platform);

    // Generic shape
    const mat = new THREE.MeshStandardMaterial({
        color: 0x333340, roughness: 0.5, metalness: 0.5,
    });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 0.4, 12), mat);
    body.position.y = 0.5;
    group.add(body);

    return group;
}

// --- Create instrument from cached GLB or fallback ---

function createInstrumentModel(instrumentType) {
    const template = modelCache.get(instrumentType);
    if (!template) return createPlaceholderInstrument(instrumentType);

    const group = new THREE.Group();
    const clone = template.clone();
    group.add(clone);
    return group;
}

// --- Create label sprite showing agent name + instrument type ---

function createPlacementLabel(botName, instrumentType) {
    const config = INSTRUMENT_MODELS[instrumentType] || {};
    const color = config.color || 0x888888;

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = 'rgba(5, 14, 22, 0.72)';
    ctx.beginPath();
    ctx.roundRect(0, 0, 256, 64, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(198, 240, 248, 0.24)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(1, 1, 254, 62, 10);
    ctx.stroke();

    // Instrument type indicator
    const rgb = new THREE.Color(color);
    ctx.fillStyle = `rgb(${Math.round(rgb.r * 255)}, ${Math.round(rgb.g * 255)}, ${Math.round(rgb.b * 255)})`;
    ctx.beginPath();
    ctx.arc(20, 32, 6, 0, Math.PI * 2);
    ctx.fill();

    // Text
    ctx.fillStyle = '#c6f0f8';
    ctx.font = '500 18px "IBM Plex Mono", monospace';
    ctx.textAlign = 'left';
    const displayName = botName.length > 14 ? botName.slice(0, 12) + '..' : botName;
    ctx.fillText(displayName, 34, 38);

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.9 });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(0, 2.2, 0);
    sprite.scale.set(1.6, 0.42, 1);
    return sprite;
}

// --- Create base pad under instrument ---

function createBasePad(instrumentType) {
    const config = INSTRUMENT_MODELS[instrumentType] || {};
    const color = config.color || 0x888888;

    const group = new THREE.Group();

    const pad = new THREE.Mesh(
        new THREE.CylinderGeometry(0.9, 0.96, 0.08, 28),
        new THREE.MeshStandardMaterial({
            color: 0x1a3f53,
            roughness: 0.38,
            metalness: 0.56,
            emissive: 0x17313f,
            emissiveIntensity: 0.2,
        })
    );
    pad.position.y = 0.04;
    pad.receiveShadow = true;
    group.add(pad);

    const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.72, 0.05, 8, 30),
        new THREE.MeshStandardMaterial({
            color,
            roughness: 0.26,
            metalness: 0.52,
            emissive: color,
            emissiveIntensity: 0.28,
        })
    );
    ring.position.y = 0.1;
    ring.rotation.x = Math.PI / 2;
    group.add(ring);

    return group;
}

// --- Placement management ---

function addPlacement(placement) {
    if (livePlacements.has(placement.id)) return;
    if (!sceneRef) return;

    const group = new THREE.Group();
    group.name = `music-placement-${placement.id}`;

    // Base pad
    const pad = createBasePad(placement.instrumentType);
    group.add(pad);

    // Instrument model
    const instrument = createInstrumentModel(placement.instrumentType);
    group.add(instrument);

    // Label
    const label = createPlacementLabel(placement.botName, placement.instrumentType);
    group.add(label);

    // Position in world
    group.position.set(placement.position.x, 0, placement.position.z);

    sceneRef.add(group);
    livePlacements.set(placement.id, { group, placement });
}

function removePlacement(placementId) {
    const entry = livePlacements.get(placementId);
    if (!entry) return;

    if (sceneRef) sceneRef.remove(entry.group);

    // Dispose geometry/materials
    entry.group.traverse((child) => {
        if (child.isMesh) {
            child.geometry?.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => m.dispose());
                } else {
                    child.material.dispose();
                }
            }
        }
        if (child.isSprite && child.material) {
            child.material.map?.dispose();
            child.material.dispose();
        }
    });

    livePlacements.delete(placementId);
}

// Sync live placements with server snapshot
export function updatePlacements(snapshot) {
    const serverIds = new Set();
    const placements = snapshot?.placements || [];

    for (const placement of placements) {
        serverIds.add(placement.id);
        if (!livePlacements.has(placement.id)) {
            addPlacement(placement);
        }
    }

    // Remove placements that no longer exist on server
    for (const [id] of livePlacements) {
        if (!serverIds.has(id)) {
            removePlacement(id);
        }
    }
}

export function getModelConfig() {
    return INSTRUMENT_MODELS;
}

// Stub: slot ring was removed in spatial placement rewrite.
// Avatars still call this — return null so assignToSlot() gracefully no-ops.
export function getSlotPosition() {
    return null;
}

// Debug tuning stubs — update cached model transforms for live tweaking
export function setTypeScale(type, value) {
    const config = INSTRUMENT_MODELS[type];
    if (config) config.scale = value;
    const template = modelCache.get(type);
    if (template) template.scale.setScalar(value);
}

export function setTypeYOffset(type, value) {
    const config = INSTRUMENT_MODELS[type];
    if (config) config.yOffset = value;
    const template = modelCache.get(type);
    if (template) template.position.y = value;
}

export function setTypeRotation(type, value) {
    const config = INSTRUMENT_MODELS[type];
    if (config) config.rot = value;
    const template = modelCache.get(type);
    if (template) template.rotation.y = value;
}

// --- Init ---

export async function init(scene) {
    sceneRef = scene;

    // Preload all instrument models
    await preloadModels();

    console.log(`[instruments] Spatial mode: ${modelCache.size} instrument models loaded`);
}
