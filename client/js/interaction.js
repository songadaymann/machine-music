// interaction.js -- Unified raycasting + click/hover interaction system.
// Single raycaster, layer-based priority, hover highlights, cursor management.

import * as THREE from 'three';

let cameraRef = null;
let canvasEl = null;
let initialized = false;

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
let pointerValid = false;

// Layers sorted by priority (first match wins)
const layers = [];

// Currently hovered object tracking
let hoveredLayer = null;
let hoveredObject = null;
let hoveredOriginalEmissive = null;
let hoveredOriginalEmissiveIntensity = null;

/**
 * Initialize the interaction system.
 * @param {THREE.Camera} camera
 * @param {HTMLCanvasElement} canvas
 */
export function init(camera, canvas) {
    if (initialized) return;
    cameraRef = camera;
    canvasEl = canvas;
    initialized = true;

    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('click', onClick);
}

/**
 * Register an interaction layer.
 * Layers are checked in priority order (lower number = higher priority).
 *
 * @param {string} name - Layer identifier
 * @param {object} opts
 * @param {number} opts.priority - Lower = checked first (default 100)
 * @param {() => THREE.Object3D[]} opts.getMeshes - Returns meshes to test
 * @param {(hit: {object, point, uv, botName?}) => void} [opts.onHover]
 * @param {() => void} [opts.onLeave]
 * @param {(hit: {object, point, uv}) => void} [opts.onClick]
 * @param {boolean} [opts.recursive=false] - Use recursive intersection
 * @param {(mesh: THREE.Object3D) => object} [opts.mapHit] - Enrich hit data
 */
export function registerLayer(name, opts) {
    // Remove existing layer with same name
    const idx = layers.findIndex(l => l.name === name);
    if (idx >= 0) layers.splice(idx, 1);

    layers.push({
        name,
        priority: opts.priority ?? 100,
        getMeshes: opts.getMeshes,
        onHover: opts.onHover || null,
        onLeave: opts.onLeave || null,
        onClick: opts.onClick || null,
        recursive: opts.recursive ?? false,
        mapHit: opts.mapHit || null,
    });

    // Re-sort by priority
    layers.sort((a, b) => a.priority - b.priority);
}

/**
 * Remove a registered layer.
 */
export function removeLayer(name) {
    const idx = layers.findIndex(l => l.name === name);
    if (idx >= 0) layers.splice(idx, 1);
}

/**
 * Call once per frame from the render loop (optional — hover updates
 * are driven by pointermove events, but this can be used for
 * continuous highlight animation if needed).
 */
export function update(_delta, elapsed) {
    // Pulse emissive on hovered object
    if (hoveredObject && hoveredObject.material) {
        const pulse = 0.5 + Math.sin(elapsed * 4) * 0.15;
        hoveredObject.material.emissiveIntensity =
            (hoveredOriginalEmissiveIntensity || 0) + pulse * 0.3;
    }
}

// --- Event handlers ---

function onPointerMove(event) {
    if (!cameraRef || !canvasEl) return;

    const rect = canvasEl.getBoundingClientRect();
    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    pointerValid = true;

    raycaster.setFromCamera(pointerNdc, cameraRef);

    let foundLayer = null;
    let foundHit = null;

    for (const layer of layers) {
        if (!layer.onHover) continue;

        const meshes = layer.getMeshes();
        if (!meshes || meshes.length === 0) continue;

        const intersects = raycaster.intersectObjects(meshes, layer.recursive);
        if (intersects.length > 0) {
            const hit = intersects[0];
            foundLayer = layer;
            foundHit = {
                object: hit.object,
                point: hit.point,
                uv: hit.uv || null,
            };
            if (layer.mapHit) {
                Object.assign(foundHit, layer.mapHit(hit.object));
            }
            break; // First priority layer with a hit wins
        }
    }

    if (foundLayer && foundHit) {
        if (hoveredLayer !== foundLayer || hoveredObject !== foundHit.object) {
            clearHover();
            hoveredLayer = foundLayer;
            hoveredObject = foundHit.object;
            applyHoverHighlight(foundHit.object);
            foundLayer.onHover(foundHit);
        }
        if (canvasEl) canvasEl.style.cursor = 'pointer';
    } else {
        if (hoveredLayer) {
            clearHover();
        }
        if (canvasEl) canvasEl.style.cursor = '';
    }
}

function onPointerLeave() {
    pointerValid = false;
    clearHover();
    if (canvasEl) canvasEl.style.cursor = '';
}

function onClick(event) {
    if (!cameraRef || !canvasEl) return;

    const rect = canvasEl.getBoundingClientRect();
    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointerNdc, cameraRef);

    for (const layer of layers) {
        if (!layer.onClick) continue;

        const meshes = layer.getMeshes();
        if (!meshes || meshes.length === 0) continue;

        const intersects = raycaster.intersectObjects(meshes, layer.recursive);
        if (intersects.length > 0) {
            const hit = intersects[0];
            const hitData = {
                object: hit.object,
                point: hit.point,
                uv: hit.uv || null,
            };
            if (layer.mapHit) {
                Object.assign(hitData, layer.mapHit(hit.object));
            }
            layer.onClick(hitData);
            return; // First priority layer with a hit consumes the click
        }
    }
}

// --- Hover highlight ---

function applyHoverHighlight(obj) {
    if (!obj || !obj.material) return;
    hoveredOriginalEmissive = obj.material.emissive
        ? obj.material.emissive.clone()
        : null;
    hoveredOriginalEmissiveIntensity = obj.material.emissiveIntensity ?? 0;

    if (obj.material.emissive) {
        // Brighten emissive slightly for hover feedback
        obj.material.emissive.lerp(new THREE.Color(0xffffff), 0.15);
    }
}

function clearHover() {
    if (hoveredObject && hoveredObject.material) {
        if (hoveredOriginalEmissive) {
            hoveredObject.material.emissive.copy(hoveredOriginalEmissive);
        }
        if (hoveredOriginalEmissiveIntensity !== null) {
            hoveredObject.material.emissiveIntensity = hoveredOriginalEmissiveIntensity;
        }
    }
    if (hoveredLayer && hoveredLayer.onLeave) {
        hoveredLayer.onLeave();
    }
    hoveredLayer = null;
    hoveredObject = null;
    hoveredOriginalEmissive = null;
    hoveredOriginalEmissiveIntensity = null;
}
