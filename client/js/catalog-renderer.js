// catalog-renderer.js -- Loads and places pre-made GLB catalog items in the world.
// Follows the same pattern as instruments.js: preload all -> modelCache -> clone on place.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let sceneRef = null;
let catalogGroup = null;
let currentSignature = '';

const loader = new GLTFLoader();

// Catalog manifest (loaded from server)
let manifest = null; // { items: { name: { path, scale, category } } }

// Model cache: item name -> THREE.Group (template)
const modelCache = new Map();

/**
 * Initialize the catalog renderer.
 * @param {THREE.Scene} scene
 */
export function init(scene) {
    if (!scene || sceneRef) return;
    sceneRef = scene;
    catalogGroup = new THREE.Group();
    catalogGroup.name = 'world-catalog';
    sceneRef.add(catalogGroup);
}

/**
 * Fetch the catalog manifest and preload all GLB models.
 * Call this during app init (non-blocking, parallel with other preloads).
 */
export async function preload() {
    try {
        const res = await fetch('/api/world/catalog');
        if (!res.ok) {
            console.warn('[catalog-renderer] Failed to fetch catalog manifest:', res.status);
            return;
        }
        manifest = await res.json();
    } catch (err) {
        console.warn('[catalog-renderer] Failed to fetch catalog manifest:', err);
        return;
    }

    if (!manifest?.items || typeof manifest.items !== 'object') {
        console.warn('[catalog-renderer] Invalid manifest format');
        return;
    }

    const entries = Object.entries(manifest.items);
    console.log(`[catalog-renderer] Preloading ${entries.length} catalog items...`);

    const results = await Promise.allSettled(
        entries.map(([name, info]) => loadCatalogItem(name, info))
    );

    const loaded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    console.log(`[catalog-renderer] Preloaded ${loaded} items (${failed} failed)`);
}

/**
 * Load a single catalog item GLB and cache it.
 */
async function loadCatalogItem(name, info) {
    return new Promise((resolve, reject) => {
        loader.load(
            info.path,
            (gltf) => {
                const group = new THREE.Group();
                const scene = gltf.scene;

                // Apply manifest scale
                const scale = info.scale ?? 1;
                scene.scale.setScalar(scale);

                // Normalize materials and enable shadows
                scene.traverse(child => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                        // Normalize materials (similar to avatar pipeline)
                        if (child.material) {
                            const mat = child.material;
                            if (mat.emissiveIntensity > 1) mat.emissiveIntensity = 0.3;
                            if (mat.metalness > 0.9) mat.metalness = 0.5;
                        }
                    }
                });

                group.add(scene);
                group.name = `catalog-template-${name}`;
                modelCache.set(name, group);
                resolve(group);
            },
            undefined,
            (err) => {
                console.warn(`[catalog-renderer] Failed to load ${name}:`, err);
                reject(err);
            }
        );
    });
}

/**
 * Clone a catalog item from cache.
 * @returns {THREE.Group | null}
 */
function cloneItem(itemName) {
    const template = modelCache.get(itemName);
    if (!template) return null;
    return template.clone();
}

/**
 * Update catalog item placements from the world snapshot.
 * @param {Array<{item: string, pos: number[], rotation?: number[], scale?: number}>} items
 */
export function updateGlobal(items) {
    if (!sceneRef || !catalogGroup) return;

    const sig = buildSignature(items);
    if (sig === currentSignature) return;
    currentSignature = sig;

    // Dispose old clones
    disposeGroup();

    if (!items || items.length === 0) return;

    for (const placement of items) {
        if (!placement || !placement.item) continue;

        const clone = cloneItem(placement.item);
        if (!clone) {
            // Unknown item — skip silently (catalog may not have it)
            continue;
        }

        // Position
        const pos = Array.isArray(placement.pos) ? placement.pos : [0, 0, 0];
        clone.position.set(
            clamp(pos[0] ?? 0, -100, 100),
            clamp(pos[1] ?? 0, -100, 100),
            clamp(pos[2] ?? 0, -100, 100)
        );

        // Rotation
        if (Array.isArray(placement.rotation)) {
            clone.rotation.set(
                placement.rotation[0] ?? 0,
                placement.rotation[1] ?? 0,
                placement.rotation[2] ?? 0
            );
        }

        // Scale (on top of manifest scale, which is baked into template)
        if (typeof placement.scale === 'number') {
            clone.scale.setScalar(clamp(placement.scale, 0.1, 10));
        }

        catalogGroup.add(clone);
    }
}

function disposeGroup() {
    if (!catalogGroup) return;
    while (catalogGroup.children.length > 0) {
        const child = catalogGroup.children[0];
        catalogGroup.remove(child);
        child.traverse(node => {
            if (node.geometry) node.geometry.dispose();
            if (node.material) {
                if (Array.isArray(node.material)) {
                    node.material.forEach(m => m.dispose());
                } else {
                    node.material.dispose();
                }
            }
        });
    }
}

function buildSignature(items) {
    if (!items || items.length === 0) return '';
    return JSON.stringify(items);
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

/**
 * Get list of available catalog item names (for debugging/info).
 */
export function getAvailableItems() {
    return Array.from(modelCache.keys());
}
