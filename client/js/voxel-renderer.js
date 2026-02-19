// voxel-renderer.js -- Renders voxel blocks using InstancedMesh for performance.
// Each block type gets one InstancedMesh (shared geometry + material, many instances).

import * as THREE from 'three';
import { onUpdate } from './scene.js';

let sceneRef = null;
let voxelGroup = null;
let currentSignature = '';
let animatedMeshes = []; // { mesh, type, elapsed }

// Block type -> material properties
const BLOCK_MATERIALS = {
    stone:    { color: 0x808080, roughness: 0.9, metalness: 0.1 },
    brick:    { color: 0x8B4513, roughness: 0.8, metalness: 0.05 },
    wood:     { color: 0xDEB887, roughness: 0.85, metalness: 0.0 },
    plank:    { color: 0xC19A6B, roughness: 0.8, metalness: 0.0 },
    glass:    { color: 0xADD8E6, roughness: 0.1, metalness: 0.0, transparent: true, opacity: 0.3 },
    metal:    { color: 0xA0A0A0, roughness: 0.3, metalness: 0.9 },
    grass:    { color: 0x228B22, roughness: 0.9, metalness: 0.0 },
    dirt:     { color: 0x8B6914, roughness: 0.95, metalness: 0.0 },
    sand:     { color: 0xF4E99B, roughness: 0.95, metalness: 0.0 },
    water:    { color: 0x1E90FF, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.6, emissive: 0x0A1A3A, emissiveIntensity: 0.2 },
    ice:      { color: 0xE0FFFF, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.8 },
    lava:     { color: 0xFF4500, roughness: 0.6, metalness: 0.0, emissive: 0xFF2000, emissiveIntensity: 1.5 },
    concrete: { color: 0xC0C0C0, roughness: 0.85, metalness: 0.05 },
    marble:   { color: 0xF5F5F5, roughness: 0.2, metalness: 0.15 },
    obsidian: { color: 0x1A1A2E, roughness: 0.1, metalness: 0.4, emissive: 0x0D0D1A, emissiveIntensity: 0.3 },
    glow:     { color: 0xFFFF00, roughness: 0.5, metalness: 0.0, emissive: 0xFFFF00, emissiveIntensity: 2.0 },
};

// Shared box geometry (1x1x1 unit cube)
let sharedGeometry = null;

// Block type -> THREE.MeshStandardMaterial (created once, reused)
const materialCache = new Map();

function getSharedGeometry() {
    if (!sharedGeometry) {
        sharedGeometry = new THREE.BoxGeometry(1, 1, 1);
    }
    return sharedGeometry;
}

function getMaterial(blockType) {
    if (materialCache.has(blockType)) return materialCache.get(blockType);

    const def = BLOCK_MATERIALS[blockType];
    if (!def) return null;

    const mat = new THREE.MeshStandardMaterial({
        color: def.color,
        roughness: def.roughness ?? 0.5,
        metalness: def.metalness ?? 0.1,
        emissive: def.emissive ?? 0x000000,
        emissiveIntensity: def.emissiveIntensity ?? 0,
        transparent: def.transparent ?? false,
        opacity: def.opacity ?? 1,
        side: THREE.FrontSide,
    });
    materialCache.set(blockType, mat);
    return mat;
}

export function init(scene) {
    if (!scene || sceneRef) return;
    sceneRef = scene;
    voxelGroup = new THREE.Group();
    voxelGroup.name = 'world-voxels';
    sceneRef.add(voxelGroup);

    // Animate water and lava
    onUpdate((_delta, elapsed) => animateBlocks(elapsed));
}

/**
 * Update voxel rendering from the merged voxel array in a WorldSnapshot.
 * @param {Array<{x: number, y: number, z: number, block: string}>} voxels
 */
export function updateGlobal(voxels) {
    if (!sceneRef || !voxelGroup) return;

    // Signature-based dedup: quick hash of voxel count + positions
    const sig = buildSignature(voxels);
    if (sig === currentSignature) return;
    currentSignature = sig;

    // Dispose old instanced meshes
    disposeGroup();

    animatedMeshes = [];

    if (!voxels || voxels.length === 0) return;

    // Group blocks by type
    const byType = new Map();
    for (const v of voxels) {
        if (!v || !BLOCK_MATERIALS[v.block]) continue;
        if (!byType.has(v.block)) byType.set(v.block, []);
        byType.get(v.block).push(v);
    }

    const geo = getSharedGeometry();
    const dummy = new THREE.Object3D();

    for (const [blockType, blocks] of byType) {
        const mat = getMaterial(blockType);
        if (!mat) continue;

        const mesh = new THREE.InstancedMesh(geo, mat, blocks.length);
        mesh.name = `voxel-${blockType}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            // Center blocks at integer coords: block at (0,0,0) occupies (0,0,0)-(1,1,1)
            dummy.position.set(b.x + 0.5, b.y + 0.5, b.z + 0.5);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        }

        mesh.instanceMatrix.needsUpdate = true;
        voxelGroup.add(mesh);

        // Track animated block types for the update loop
        if (blockType === 'water' || blockType === 'lava') {
            animatedMeshes.push({ mesh, type: blockType, count: blocks.length, blocks });
        }
    }
}

function animateBlocks(elapsed) {
    if (animatedMeshes.length === 0) return;

    const dummy = new THREE.Object3D();

    for (const entry of animatedMeshes) {
        const { mesh, type, blocks } = entry;
        if (!mesh.parent) continue; // disposed

        for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            const baseY = b.y + 0.5;

            if (type === 'water') {
                // Gentle wave: small Y offset based on position + time
                const wave = Math.sin(elapsed * 1.5 + b.x * 0.3 + b.z * 0.3) * 0.08;
                dummy.position.set(b.x + 0.5, baseY + wave, b.z + 0.5);
            } else if (type === 'lava') {
                // Slow pulsing Y + slight scale pulse
                const pulse = Math.sin(elapsed * 0.8 + b.x * 0.2 + b.z * 0.2) * 0.05;
                const scalePulse = 1 + Math.sin(elapsed * 1.2 + b.x * 0.4) * 0.03;
                dummy.position.set(b.x + 0.5, baseY + pulse, b.z + 0.5);
                dummy.scale.set(scalePulse, scalePulse, scalePulse);
            }

            dummy.rotation.set(0, 0, 0);
            if (type === 'water') dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
    }
}

function disposeGroup() {
    if (!voxelGroup) return;
    // InstancedMesh shares geometry and material — don't dispose those (they're cached)
    // Just remove the instanced meshes from the group
    while (voxelGroup.children.length > 0) {
        const child = voxelGroup.children[0];
        voxelGroup.remove(child);
        // InstancedMesh itself can be disposed (frees instance buffer)
        if (child.dispose) child.dispose();
    }
}

function buildSignature(voxels) {
    if (!voxels || voxels.length === 0) return '';
    // Fast signature: count + hash of first, middle, last block + total
    const n = voxels.length;
    const first = voxels[0];
    const mid = voxels[Math.floor(n / 2)];
    const last = voxels[n - 1];
    return `${n}:${first.x},${first.y},${first.z},${first.block}|${mid.x},${mid.y},${mid.z},${mid.block}|${last.x},${last.y},${last.z},${last.block}`;
}
