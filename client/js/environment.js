// environment.js -- Procedural gradient sky, IBL environment map, and skybox sphere.
// Provides image-based lighting so all PBR materials reflect their surroundings.

import * as THREE from 'three';

let sceneRef = null;
let pmremGenerator = null;
let skyMesh = null;
let currentEnvMap = null;
let skyCanvas = null;
let skyTexture = null;

// Current sky colors
let zenithColor = new THREE.Color();
let horizonColor = new THREE.Color();
let groundColor = new THREE.Color();

const PRESETS = {
    void: {
        zenith: '#c8c8c8',
        horizon: '#e8e8e8',
        ground: '#d0d0d0',
    },
    day: {
        zenith: '#4a90d9',
        horizon: '#b8d4f0',
        ground: '#8fac7a',
    },
    dusk: {
        zenith: '#2a1a4e',
        horizon: '#e8724a',
        ground: '#5a4030',
    },
    night: {
        zenith: '#0a0a1e',
        horizon: '#1a1a3a',
        ground: '#0e0e18',
    },
};

const SKY_SPHERE_RADIUS = 400;
const CANVAS_WIDTH = 512;
const CANVAS_HEIGHT = 256;

/**
 * Initialize the environment system.
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {string} [preset='void']
 */
export function init(scene, renderer, preset = 'void') {
    if (!scene || !renderer || sceneRef) return;
    sceneRef = scene;

    pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileCubemapShader();

    // Create canvas for equirectangular gradient
    skyCanvas = document.createElement('canvas');
    skyCanvas.width = CANVAS_WIDTH;
    skyCanvas.height = CANVAS_HEIGHT;

    skyTexture = new THREE.CanvasTexture(skyCanvas);
    skyTexture.mapping = THREE.EquirectangularReflectionMapping;

    // Sky sphere (inverted, renders behind everything)
    const skyGeo = new THREE.SphereGeometry(SKY_SPHERE_RADIUS, 32, 16);
    const skyMat = new THREE.MeshBasicMaterial({
        map: skyTexture,
        side: THREE.BackSide,
        depthWrite: false,
        toneMapped: false,
    });
    skyMesh = new THREE.Mesh(skyGeo, skyMat);
    skyMesh.name = 'sky-sphere';
    skyMesh.renderOrder = -1;
    sceneRef.add(skyMesh);

    applyPreset(preset);
}

/**
 * Apply a named sky preset.
 * @param {string} name
 */
export function applyPreset(name) {
    const preset = PRESETS[name] || PRESETS.void;
    setSkyColors(preset.zenith, preset.horizon, preset.ground);
}

/**
 * Set sky colors directly (called by agents via world-renderer).
 * @param {string|THREE.Color} zenith
 * @param {string|THREE.Color} horizon
 * @param {string|THREE.Color} ground
 */
export function setSkyColors(zenith, horizon, ground) {
    if (!sceneRef || !skyCanvas) return;

    zenithColor.set(zenith);
    horizonColor.set(horizon);
    groundColor.set(ground);

    renderGradient();
    updateEnvMap();
}

/**
 * Derive sky from a single color (for world-renderer's simple sky color API).
 * Uses the color as horizon, derives zenith (darker) and ground (dimmer).
 */
export function setSkyFromColor(colorStr) {
    if (!sceneRef) return;
    const base = new THREE.Color(colorStr);
    const zenith = base.clone().multiplyScalar(0.6);
    const ground = base.clone().multiplyScalar(0.4);
    setSkyColors(zenith, base, ground);
}

/**
 * Get available preset names.
 */
export function getPresetNames() {
    return Object.keys(PRESETS);
}

// --- Internals ---

function renderGradient() {
    const ctx = skyCanvas.getContext('2d');
    const w = CANVAS_WIDTH;
    const h = CANVAS_HEIGHT;

    // Equirectangular: top = zenith, middle = horizon, bottom = ground
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, colorToCSS(zenithColor));
    gradient.addColorStop(0.45, colorToCSS(horizonColor));
    gradient.addColorStop(0.55, colorToCSS(horizonColor));
    gradient.addColorStop(1, colorToCSS(groundColor));

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    skyTexture.needsUpdate = true;

    // Clear scene.background so sky sphere is visible
    if (sceneRef) {
        sceneRef.background = null;
    }
}

function updateEnvMap() {
    if (!pmremGenerator || !skyTexture) return;

    if (currentEnvMap) {
        currentEnvMap.dispose();
    }

    const envRT = pmremGenerator.fromEquirectangular(skyTexture);
    currentEnvMap = envRT.texture;

    // Apply IBL reflections to all PBR materials in the scene
    if (sceneRef) {
        sceneRef.environment = currentEnvMap;
    }
}

function colorToCSS(color) {
    return '#' + color.getHexString();
}
