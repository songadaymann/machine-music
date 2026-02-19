// world-renderer.js -- Modifies the Three.js environment based on world session output.

import * as THREE from 'three';
import { onUpdate } from './scene.js';
import * as voxelRenderer from './voxel-renderer.js';
import * as catalogRenderer from './catalog-renderer.js';
import * as generatedObjectRenderer from './generated-object-renderer.js';

let sceneRef = null;

// sessionId -> { elements: THREE.Group, envOverrides: object }
const worldSessions = new Map();

// Captured original environment state for reset
let originalEnv = null;

// Global shared world state (separate from session-scoped)
let globalGroup = null;
let globalMotionItems = [];
let globalSignature = '';

// Geometry constructors for element types
const GEOMETRY_MAP = {
    box: (s) => new THREE.BoxGeometry(s, s, s),
    sphere: (s) => new THREE.SphereGeometry(s * 0.5, 24, 16),
    cylinder: (s) => new THREE.CylinderGeometry(s * 0.3, s * 0.3, s, 24),
    torus: (s) => new THREE.TorusGeometry(s * 0.4, s * 0.12, 16, 32),
    cone: (s) => new THREE.ConeGeometry(s * 0.4, s, 24),
    plane: (s) => new THREE.PlaneGeometry(s, s),
    ring: (s) => new THREE.RingGeometry(s * 0.2, s * 0.5, 32),
};

// Motion presets
const MOTION_FNS = {
    float: (mesh, elapsed, speed) => {
        mesh.position.y = mesh.userData.baseY + Math.sin(elapsed * speed) * 0.5;
    },
    spin: (mesh, elapsed, speed) => {
        mesh.rotation.y = elapsed * speed;
    },
    pulse: (mesh, elapsed, speed) => {
        const s = 1 + Math.sin(elapsed * speed * 2) * 0.15;
        mesh.scale.setScalar(s * mesh.userData.baseScale);
    },
    none: () => {},
};

export function init(scene) {
    if (!scene || sceneRef) return;
    sceneRef = scene;
    captureOriginalEnvironment();
    voxelRenderer.init(scene);
    catalogRenderer.init(scene);
    generatedObjectRenderer.init(scene);
    onUpdate((delta, elapsed) => animateMotions(elapsed));
}

export function update(session) {
    if (!sceneRef) return;
    const sessionId = session.id;
    const participants = Array.isArray(session.participants) ? session.participants : [];

    // Build signature
    const sig = buildSignature(participants);
    let entry = worldSessions.get(sessionId);
    if (entry && entry.lastSignature === sig) return;

    // Remove old elements for this session
    if (entry) {
        removeSessionElements(entry);
    }

    entry = {
        group: new THREE.Group(),
        motionItems: [],
        envApplied: false,
        lastSignature: sig,
    };
    entry.group.name = `world-session-${sessionId}`;
    sceneRef.add(entry.group);
    worldSessions.set(sessionId, entry);

    // Creator (first participant) controls environment
    const creator = participants[0];
    if (creator?.output) {
        applyEnvironment(creator.output);
        entry.envApplied = true;
    }

    // All participants contribute elements
    for (const participant of participants) {
        const output = participant?.output;
        if (!output || !Array.isArray(output.elements)) continue;
        for (const elDef of output.elements) {
            const mesh = buildElement(elDef);
            if (mesh) {
                entry.group.add(mesh);
                const motion = elDef.motion || 'none';
                const speed = clamp(elDef.motionSpeed ?? 1, 0.1, 5);
                if (motion !== 'none' && MOTION_FNS[motion]) {
                    entry.motionItems.push({ mesh, motionFn: MOTION_FNS[motion], speed });
                }
            }
        }
    }
}

export function remove(sessionId) {
    const entry = worldSessions.get(sessionId);
    if (!entry) return;
    removeSessionElements(entry);
    if (entry.envApplied) restoreEnvironment();
    worldSessions.delete(sessionId);
}

export function removeStale(activeIds) {
    for (const sessionId of worldSessions.keys()) {
        if (!activeIds.has(sessionId)) remove(sessionId);
    }
}

export function toggle(sessionId) {
    const entry = worldSessions.get(sessionId);
    if (!entry) return;
    entry.group.visible = !entry.group.visible;
}

export function getState() {
    const active = [];
    for (const [sessionId, entry] of worldSessions.entries()) {
        active.push({
            sessionId,
            elementCount: entry.group.children.length,
            visible: entry.group.visible,
            envApplied: entry.envApplied,
        });
    }
    return { activeSessions: active.length, sessions: active };
}

/**
 * Update the shared global world from a WorldSnapshot.
 * Called on init and whenever a world_snapshot SSE event arrives.
 */
export function updateGlobal(snapshot) {
    if (!sceneRef || !snapshot) return;

    // Signature-based dedup
    const sig = JSON.stringify(snapshot);
    if (sig === globalSignature) return;
    globalSignature = sig;

    // Remove previous global elements
    if (globalGroup) {
        globalGroup.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => m.dispose());
                } else {
                    child.material.dispose();
                }
            }
        });
        sceneRef.remove(globalGroup);
    }

    // Remove previous global point lights
    const lightsToRemove = [];
    sceneRef.traverse(child => {
        if (child.userData?.globalWorldLight) lightsToRemove.push(child);
    });
    for (const light of lightsToRemove) {
        sceneRef.remove(light);
        if (light.dispose) light.dispose();
    }

    globalGroup = new THREE.Group();
    globalGroup.name = 'world-global';
    globalMotionItems = [];

    // Apply environment from merged snapshot
    if (snapshot.environment && Object.keys(snapshot.environment).length > 0) {
        applyEnvironment(snapshot.environment, true);
    }

    // Build elements from all contributions
    const contributions = Array.isArray(snapshot.contributions) ? snapshot.contributions : [];
    for (const contrib of contributions) {
        const elements = Array.isArray(contrib.elements) ? contrib.elements : [];
        for (const elDef of elements) {
            const mesh = buildElement(elDef);
            if (mesh) {
                globalGroup.add(mesh);
                const motion = elDef.motion || 'none';
                const speed = clamp(elDef.motionSpeed ?? 1, 0.1, 5);
                if (motion !== 'none' && MOTION_FNS[motion]) {
                    globalMotionItems.push({ mesh, motionFn: MOTION_FNS[motion], speed });
                }
            }
        }
    }

    sceneRef.add(globalGroup);

    // Update sub-renderers with merged data from all contributions
    voxelRenderer.updateGlobal(snapshot.voxels || []);
    catalogRenderer.updateGlobal(snapshot.catalog_items || []);
    generatedObjectRenderer.updateGlobal(snapshot.generated_items || []);
}

function buildSignature(participants) {
    return participants
        .map(p => `${p.botName || ''}:${JSON.stringify(p.output || {})}`)
        .join('|');
}

function removeSessionElements(entry) {
    if (entry.group && sceneRef) {
        // Dispose geometries and materials
        entry.group.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => m.dispose());
                } else {
                    child.material.dispose();
                }
            }
        });
        sceneRef.remove(entry.group);
    }
    entry.motionItems = [];
}

function captureOriginalEnvironment() {
    if (!sceneRef || originalEnv) return;
    originalEnv = {
        background: sceneRef.background ? sceneRef.background.clone() : null,
        fog: sceneRef.fog ? {
            color: sceneRef.fog.color.clone(),
            near: sceneRef.fog.near,
            far: sceneRef.fog.far,
        } : null,
    };
}

function applyEnvironment(output, isGlobal = false) {
    if (!sceneRef) return;

    if (output.sky) {
        const color = resolveColor(output.sky);
        if (color) sceneRef.background = new THREE.Color(color);
    }

    if (output.fog) {
        const fogColor = resolveColor(output.fog.color || '#000000');
        const near = clamp(output.fog.near ?? 10, 0, 500);
        const far = clamp(output.fog.far ?? 200, near + 1, 500);
        sceneRef.fog = new THREE.Fog(fogColor, near, far);
    }

    if (output.lighting?.ambient) {
        const ambientLight = findChildByType(sceneRef, 'AmbientLight');
        if (ambientLight) {
            const c = resolveColor(output.lighting.ambient.color);
            if (c) ambientLight.color.set(c);
            if (typeof output.lighting.ambient.intensity === 'number') {
                ambientLight.intensity = clamp(output.lighting.ambient.intensity, 0, 5);
            }
        }
    }

    if (Array.isArray(output.lighting?.points)) {
        // Add point lights (max 5 enforced by validator)
        const lightTag = isGlobal ? 'globalWorldLight' : 'worldSessionLight';
        for (const ptDef of output.lighting.points.slice(0, 5)) {
            const pos = Array.isArray(ptDef.pos) ? ptDef.pos : [0, 5, 0];
            const color = resolveColor(ptDef.color || '#ffffff');
            const intensity = clamp(ptDef.intensity ?? 1, 0, 5);
            const light = new THREE.PointLight(color, intensity, 100);
            light.position.set(
                clamp(pos[0] ?? 0, -100, 100),
                clamp(pos[1] ?? 5, -100, 100),
                clamp(pos[2] ?? 0, -100, 100)
            );
            light.userData[lightTag] = true;
            sceneRef.add(light);
        }
    }
}

function restoreEnvironment() {
    if (!sceneRef || !originalEnv) return;
    sceneRef.background = originalEnv.background;
    if (originalEnv.fog) {
        sceneRef.fog = new THREE.Fog(
            originalEnv.fog.color,
            originalEnv.fog.near,
            originalEnv.fog.far
        );
    } else {
        sceneRef.fog = null;
    }

    // Remove world session point lights
    const toRemove = [];
    sceneRef.traverse(child => {
        if (child.userData?.worldSessionLight) toRemove.push(child);
    });
    for (const light of toRemove) {
        sceneRef.remove(light);
        if (light.dispose) light.dispose();
    }
}

function buildElement(def) {
    if (!def || !def.type) return null;
    const geometryFn = GEOMETRY_MAP[def.type];
    if (!geometryFn) return null;

    const scaleVal = typeof def.scale === 'number' ? def.scale : 1;
    const baseScale = clamp(scaleVal, 0.05, 30);
    const geo = geometryFn(baseScale);

    const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(def.color || '#888888'),
        roughness: clamp(def.roughness ?? 0.5, 0, 1),
        metalness: clamp(def.metalness ?? 0.1, 0, 1),
        emissive: resolveColor(def.emissive || '#000000'),
        emissiveIntensity: clamp(def.emissiveIntensity ?? 0, 0, 5),
        transparent: (def.opacity ?? 1) < 1,
        opacity: clamp(def.opacity ?? 1, 0, 1),
        side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);

    // Position
    const pos = Array.isArray(def.pos) ? def.pos : [0, 0, 0];
    mesh.position.set(
        clamp(pos[0] ?? 0, -100, 100),
        clamp(pos[1] ?? 0, -100, 100),
        clamp(pos[2] ?? 0, -100, 100)
    );

    // Scale (array or uniform)
    if (Array.isArray(def.scale)) {
        mesh.scale.set(
            clamp(def.scale[0] ?? 1, 0.05, 30),
            clamp(def.scale[1] ?? 1, 0.05, 30),
            clamp(def.scale[2] ?? 1, 0.05, 30)
        );
    }

    // Rotation
    if (Array.isArray(def.rotation)) {
        mesh.rotation.set(
            def.rotation[0] ?? 0,
            def.rotation[1] ?? 0,
            def.rotation[2] ?? 0
        );
    }

    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.baseY = mesh.position.y;
    mesh.userData.baseScale = baseScale;

    return mesh;
}

function animateMotions(elapsed) {
    for (const [, entry] of worldSessions) {
        if (!entry.group.visible) continue;
        for (const item of entry.motionItems) {
            item.motionFn(item.mesh, elapsed, item.speed);
        }
    }
    // Global shared world motions
    for (const item of globalMotionItems) {
        item.motionFn(item.mesh, elapsed, item.speed);
    }
}

function findChildByType(parent, typeName) {
    let found = null;
    parent.traverse(child => {
        if (!found && child.type === typeName) found = child;
    });
    return found;
}

function resolveColor(value) {
    if (!value) return null;
    const s = String(value).trim().toLowerCase();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return s;
    // Accept basic named colors
    const NAMED = new Set([
        'red', 'green', 'blue', 'white', 'black', 'yellow', 'cyan', 'magenta',
        'orange', 'purple', 'pink', 'brown', 'gray', 'grey', 'navy', 'teal',
        'lime', 'aqua', 'maroon', 'olive', 'silver', 'fuchsia', 'coral',
        'salmon', 'gold', 'khaki', 'indigo', 'violet', 'crimson', 'turquoise',
    ]);
    if (NAMED.has(s)) return s;
    return null;
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}
