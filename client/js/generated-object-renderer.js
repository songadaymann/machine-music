// generated-object-renderer.js -- Loads and places Meshy-generated GLB world objects.
// Uses URL-keyed cache (like customAvatarCache in avatars.js) for on-demand loading.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let sceneRef = null;
let objectGroup = null;
let currentSignature = '';

const loader = new GLTFLoader();

// URL -> Promise<THREE.Group> cache (load once, clone many)
const glbCache = new Map();

/**
 * Initialize the generated object renderer.
 * @param {THREE.Scene} scene
 */
export function init(scene) {
    if (!scene || sceneRef) return;
    sceneRef = scene;
    objectGroup = new THREE.Group();
    objectGroup.name = 'world-generated-objects';
    sceneRef.add(objectGroup);
}

/**
 * Load a GLB by URL, caching the result.
 * @returns {Promise<THREE.Group>}
 */
function loadGLB(url) {
    if (glbCache.has(url)) return glbCache.get(url);

    const promise = new Promise((resolve, reject) => {
        loader.load(
            url,
            (gltf) => {
                const group = new THREE.Group();
                const scene = gltf.scene;

                // Normalize Meshy materials (same fixes as avatar pipeline)
                scene.traverse(child => {
                    if (child.isMesh && child.material) {
                        const mat = child.material;
                        // Meshy models often have excessive emissive/metalness
                        if (mat.emissiveIntensity > 1) mat.emissiveIntensity = 0.3;
                        if (mat.metalness > 0.9) mat.metalness = 0.5;
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });

                // Normalize height to ~2 units (same as avatar pipeline)
                const box = new THREE.Box3().setFromObject(scene);
                const height = box.max.y - box.min.y;
                if (height > 0) {
                    const targetHeight = 2;
                    const s = targetHeight / height;
                    scene.scale.setScalar(s);
                }

                group.add(scene);
                resolve(group);
            },
            undefined,
            (err) => {
                console.warn(`[generated-object-renderer] Failed to load ${url}:`, err);
                reject(err);
            }
        );
    });

    glbCache.set(url, promise);
    return promise;
}

/**
 * Update generated object placements from the world snapshot.
 * @param {Array<{url: string, pos: number[], rotation?: number[], scale?: number}>} items
 */
export async function updateGlobal(items) {
    if (!sceneRef || !objectGroup) return;

    const sig = buildSignature(items);
    if (sig === currentSignature) return;
    currentSignature = sig;

    // Dispose old clones
    disposeGroup();

    if (!items || items.length === 0) return;

    // Load all GLBs in parallel, then place them
    const loadResults = await Promise.allSettled(
        items.map(async (placement) => {
            if (!placement || !placement.url) return null;
            try {
                const template = await loadGLB(placement.url);
                return { template, placement };
            } catch {
                return null;
            }
        })
    );

    for (const result of loadResults) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const { template, placement } = result.value;

        const clone = template.clone();

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

        // Scale (on top of auto-normalized scale)
        if (typeof placement.scale === 'number') {
            clone.scale.setScalar(clamp(placement.scale, 0.1, 10));
        }

        // Wrap in LOD for distance-based detail reduction
        const lod = wrapInLOD(clone);
        lod.position.copy(clone.position);
        lod.rotation.copy(clone.rotation);
        lod.scale.copy(clone.scale);
        clone.position.set(0, 0, 0);
        clone.rotation.set(0, 0, 0);
        clone.scale.set(1, 1, 1);
        objectGroup.add(lod);
    }
}

function wrapInLOD(clone) {
    const lod = new THREE.LOD();

    // Level 0: full detail (0-30 units)
    lod.addLevel(clone, 0);

    // Level 1: colored box proxy (30-100 units)
    const box = new THREE.Box3().setFromObject(clone);
    const size = new THREE.Vector3();
    box.getSize(size);
    const proxyGeo = new THREE.BoxGeometry(
        Math.max(size.x, 0.2),
        Math.max(size.y, 0.2),
        Math.max(size.z, 0.2)
    );
    let proxyColor = 0x888888;
    clone.traverse(child => {
        if (child.isMesh && child.material?.color && proxyColor === 0x888888) {
            proxyColor = child.material.color.getHex();
        }
    });
    const proxyMat = new THREE.MeshStandardMaterial({
        color: proxyColor,
        roughness: 0.8,
    });
    const proxy = new THREE.Mesh(proxyGeo, proxyMat);
    proxy.castShadow = true;
    const center = new THREE.Vector3();
    box.getCenter(center);
    proxy.position.copy(center);
    const proxyGroup = new THREE.Group();
    proxyGroup.add(proxy);
    lod.addLevel(proxyGroup, 30);

    // Level 2: hidden (100+ units)
    lod.addLevel(new THREE.Group(), 100);

    return lod;
}

function disposeGroup() {
    if (!objectGroup) return;
    while (objectGroup.children.length > 0) {
        const child = objectGroup.children[0];
        objectGroup.remove(child);
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
