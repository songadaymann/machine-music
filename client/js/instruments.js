// instruments.js -- Instrument positions in a semicircle, load real GLB models
//
// GLB models served from /models/insrtuments/*.glb
// Falls back to placeholder geometry if loading fails.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// --- Slot layout ---
// 8 positions in a semicircle, facing center
// The semicircle opens toward the camera (positive Z)

const SLOT_COUNT = 8;
const RADIUS = 7;
const ARC_START = Math.PI * 0.15;
const ARC_END = Math.PI * 0.85;

// Map slot types to instrument GLB paths and display settings
const INSTRUMENT_MODELS = {
    drums:  { path: '/models/insrtuments/808.glb',                  scale: 0.001, yOffset: 0.65, rot: 1.558 },
    bass:   { path: '/models/insrtuments/cello.glb',                scale: 1.26,  yOffset: 0.95, rot: 0 },
    chords: { path: '/models/insrtuments/dusty_piano.glb',          scale: 1.46,  yOffset: 0,    rot: 0 },
    melody: { path: '/models/insrtuments/synth.glb',                scale: 0.01,  yOffset: 0.5,  rot: 0 },
    wild:   { path: '/models/insrtuments/prophet_5_synthesiser.glb', scale: 0.01,  yOffset: 0.3,  rot: 0 },
};

// Slot metadata
const SLOT_INFO = [
    { id: 1, type: 'drums',  label: 'DR', color: 0xe74c3c },
    { id: 2, type: 'drums',  label: 'DR', color: 0xe74c3c },
    { id: 3, type: 'bass',   label: 'BA', color: 0x3498db },
    { id: 4, type: 'chords', label: 'CH', color: 0x9b59b6 },
    { id: 5, type: 'chords', label: 'CH', color: 0x9b59b6 },
    { id: 6, type: 'melody', label: 'ME', color: 0x2ecc71 },
    { id: 7, type: 'melody', label: 'ME', color: 0x2ecc71 },
    { id: 8, type: 'wild',   label: 'WD', color: 0xf39c12 },
];

// --- Instrument positions ---
const positions = [];
const placedInstruments = []; // { group, info } -- for runtime scale/offset tweaks

export function getPositions() { return positions; }
export function getSlotPosition(slotId) {
    return positions.find(p => p.info.id === slotId) || null;
}

// --- Runtime scale/offset setters (used by debug panel) ---

export function setTypeScale(type, scale) {
    INSTRUMENT_MODELS[type].scale = scale;
    for (const entry of placedInstruments) {
        if (entry.info.type === type) {
            // The first child of the group is the model clone (or placeholder)
            const model = entry.group.children[0];
            if (model) model.scale.setScalar(scale);
        }
    }
}

export function setTypeYOffset(type, y) {
    INSTRUMENT_MODELS[type].yOffset = y;
    for (const entry of placedInstruments) {
        if (entry.info.type === type) {
            const model = entry.group.children[0];
            if (model) model.position.y = y;
        }
    }
}

export function setTypeRotation(type, radians) {
    INSTRUMENT_MODELS[type].rot = radians;
    for (const entry of placedInstruments) {
        if (entry.info.type === type) {
            const model = entry.group.children[0];
            if (model) model.rotation.y = radians;
        }
    }
}

export function getModelConfig() {
    return INSTRUMENT_MODELS;
}

// --- Loader ---

const loader = new GLTFLoader();
const modelCache = new Map(); // type -> THREE.Group (cloneable template)

function loadGLB(path) {
    return new Promise((resolve, reject) => {
        loader.load(path, resolve, undefined, reject);
    });
}

// --- Preload all unique instrument models ---

async function preloadModels() {
    const uniqueTypes = [...new Set(SLOT_INFO.map(s => s.type))];
    const results = await Promise.allSettled(
        uniqueTypes.map(async (type) => {
            const config = INSTRUMENT_MODELS[type];
            if (!config) return;

            try {
                const gltf = await loadGLB(config.path);
                const model = gltf.scene;
                model.scale.setScalar(config.scale);
                model.position.y = config.yOffset;
                model.rotation.y = config.rot || 0;

                // Enable shadows
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

// --- Create placeholder instrument (fallback) ---

function createPlaceholderInstrument(info) {
    const group = new THREE.Group();
    group.name = `instrument-${info.id}`;

    // Base platform
    const platformGeo = new THREE.CylinderGeometry(0.6, 0.6, 0.05, 16);
    const platformMat = new THREE.MeshStandardMaterial({
        color: info.color,
        roughness: 0.7,
        metalness: 0.3,
        emissive: info.color,
        emissiveIntensity: 0.1,
    });
    const platform = new THREE.Mesh(platformGeo, platformMat);
    platform.position.y = 0.025;
    platform.receiveShadow = true;
    group.add(platform);

    // Shape varies by type
    const mat = new THREE.MeshStandardMaterial({
        color: 0x333340, roughness: 0.5, metalness: 0.5,
    });

    switch (info.type) {
        case 'drums': {
            const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 0.4, 12), mat);
            body.position.y = 0.5;
            group.add(body);
            const hh = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 12), mat);
            hh.position.set(0.4, 0.8, 0);
            group.add(hh);
            break;
        }
        case 'bass': {
            const body = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.2, 0.08), mat);
            body.position.set(0, 0.7, 0);
            body.rotation.z = 0.15;
            group.add(body);
            break;
        }
        case 'chords': {
            const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.08, 0.3), mat);
            body.position.set(0, 0.7, 0);
            group.add(body);
            const leg1 = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.65, 6), mat);
            leg1.position.set(-0.3, 0.35, 0);
            group.add(leg1);
            const leg2 = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.65, 6), mat);
            leg2.position.set(0.3, 0.35, 0);
            group.add(leg2);
            break;
        }
        case 'melody': {
            const body = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.6, 8), mat);
            body.position.set(0, 0.9, 0);
            group.add(body);
            const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6), mat);
            stick.position.set(0, 0.55, 0);
            group.add(stick);
            break;
        }
        case 'wild': {
            const body = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.08, 8, 16), mat);
            body.position.set(0, 0.7, 0);
            body.rotation.x = Math.PI / 2;
            group.add(body);
            break;
        }
    }

    return group;
}

// --- Create a real instrument from cached GLB ---

function createInstrument(info) {
    const template = modelCache.get(info.type);
    if (!template) return createPlaceholderInstrument(info);

    const group = new THREE.Group();
    group.name = `instrument-${info.id}`;

    // Clone the loaded model
    const clone = template.clone();
    group.add(clone);

    return group;
}

// --- Create slot label sprite ---

function createLabel(info) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.roundRect(0, 0, 128, 64, 8);
    ctx.fill();
    ctx.fillStyle = '#' + info.color.toString(16).padStart(6, '0');
    ctx.font = 'bold 28px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${info.label} ${info.id}`, 64, 40);

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.8 });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(0, 2.0, 0);
    sprite.scale.set(1, 0.5, 1);
    return sprite;
}

// --- Init ---

export async function init(scene) {
    // Start loading GLB models
    await preloadModels();

    for (let i = 0; i < SLOT_COUNT; i++) {
        const info = SLOT_INFO[i];

        // Calculate position on semicircle
        const t = i / (SLOT_COUNT - 1);
        const angle = ARC_START + t * (ARC_END - ARC_START);

        // Semicircle in XZ plane, opening toward +Z (camera)
        const x = Math.cos(angle) * RADIUS;
        const z = -Math.sin(angle) * RADIUS + 2;

        const position = new THREE.Vector3(x, 0, z);
        const rotation = angle + Math.PI / 2;

        positions.push({ position, rotation, info });

        // Create instrument (real GLB or placeholder fallback)
        const instrument = createInstrument(info);
        instrument.position.copy(position);
        instrument.rotation.y = rotation;
        scene.add(instrument);

        placedInstruments.push({ group: instrument, info });

        // Floating label
        const label = createLabel(info);
        label.position.add(position);
        scene.add(label);
    }

    console.log(`[instruments] Placed ${SLOT_COUNT} instruments`);
}
