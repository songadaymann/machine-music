// particles.js -- Particle system for music visualization and ambient effects.
// Uses InstancedMesh with billboard quads for efficient GPU rendering.

import * as THREE from 'three';
import * as music from './music.js';

let sceneRef = null;
let cameraRef = null;
let initialized = false;

const MAX_PARTICLES = 800;

// Particle pool
const particles = [];
let instancedMesh = null;

// Temp objects (avoid per-frame allocation)
const tempMatrix = new THREE.Matrix4();
const tempPosition = new THREE.Vector3();
const tempQuaternion = new THREE.Quaternion();
const tempScale = new THREE.Vector3();
const tempColor = new THREE.Color();

// Emitters
const emitters = [];

// Beat tracking
let prevRms = 0;
const BEAT_THRESHOLD = 0.08;
const BEAT_COOLDOWN = 0.15; // seconds
let beatCooldownTimer = 0;

/**
 * Initialize the particle system.
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 */
export function init(scene, camera) {
    if (initialized) return;
    sceneRef = scene;
    cameraRef = camera;
    initialized = true;

    // Create particle pool
    for (let i = 0; i < MAX_PARTICLES; i++) {
        particles.push({
            alive: false,
            pos: new THREE.Vector3(),
            vel: new THREE.Vector3(),
            life: 0,
            maxLife: 1,
            size: 0.1,
            color: new THREE.Color(1, 1, 1),
            alpha: 1,
            gravity: 0,
        });
    }

    // Billboard quad geometry (two triangles)
    const geo = new THREE.PlaneGeometry(0.15, 0.15);

    const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
    });

    instancedMesh = new THREE.InstancedMesh(geo, mat, MAX_PARTICLES);
    instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    instancedMesh.frustumCulled = false;
    instancedMesh.name = 'particle-system';

    // Hide all initially
    for (let i = 0; i < MAX_PARTICLES; i++) {
        tempMatrix.makeScale(0, 0, 0);
        instancedMesh.setMatrixAt(i, tempMatrix);
        instancedMesh.setColorAt(i, tempColor.set(0xffffff));
    }
    instancedMesh.instanceMatrix.needsUpdate = true;
    instancedMesh.instanceColor.needsUpdate = true;

    sceneRef.add(instancedMesh);

    // Start ambient emitter
    addEmitter(ambientEmitter());
}

/**
 * Update particles each frame.
 * @param {number} delta
 * @param {number} elapsed
 */
export function update(delta, elapsed) {
    if (!initialized || !instancedMesh) return;

    // Beat detection
    detectBeat(delta);

    // Run emitters
    for (const emitter of emitters) {
        emitter(delta, elapsed);
    }

    // Billboard quaternion (face camera)
    const billboardQuat = new THREE.Quaternion();
    if (cameraRef) {
        billboardQuat.copy(cameraRef.quaternion);
    }

    // Update particle physics + instance matrices
    let aliveCount = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
        const p = particles[i];
        if (!p.alive) {
            tempMatrix.makeScale(0, 0, 0);
            instancedMesh.setMatrixAt(i, tempMatrix);
            continue;
        }

        p.life -= delta;
        if (p.life <= 0) {
            p.alive = false;
            tempMatrix.makeScale(0, 0, 0);
            instancedMesh.setMatrixAt(i, tempMatrix);
            continue;
        }

        // Physics
        p.vel.y -= p.gravity * delta;
        p.pos.addScaledVector(p.vel, delta);

        // Life ratio (0 = just born, 1 = about to die)
        const t = 1 - p.life / p.maxLife;

        // Fade out in last 30% of life
        const alpha = t > 0.7 ? (1 - t) / 0.3 : 1;

        // Scale down near end of life
        const scale = p.size * (1 - t * 0.5);

        tempPosition.copy(p.pos);
        tempScale.setScalar(scale);
        tempMatrix.compose(tempPosition, billboardQuat, tempScale);
        instancedMesh.setMatrixAt(i, tempMatrix);

        // Tint color with alpha baked in (since instanceColor doesn't support alpha)
        tempColor.copy(p.color).multiplyScalar(alpha);
        instancedMesh.setColorAt(i, tempColor);

        aliveCount++;
    }

    instancedMesh.instanceMatrix.needsUpdate = true;
    if (instancedMesh.instanceColor) {
        instancedMesh.instanceColor.needsUpdate = true;
    }
    instancedMesh.count = MAX_PARTICLES;
}

/**
 * Emit a burst of sparkle particles at a position.
 * @param {THREE.Vector3|{x,y,z}} pos
 * @param {number} [count=15]
 * @param {string|number} [color=0xffdd44]
 */
export function sparkle(pos, count = 15, color = 0xffdd44) {
    for (let i = 0; i < count; i++) {
        const p = allocParticle();
        if (!p) break;

        p.pos.set(pos.x || 0, pos.y || 0, pos.z || 0);
        p.vel.set(
            (Math.random() - 0.5) * 4,
            Math.random() * 3 + 1,
            (Math.random() - 0.5) * 4
        );
        p.life = 0.6 + Math.random() * 0.6;
        p.maxLife = p.life;
        p.size = 0.08 + Math.random() * 0.12;
        p.color.set(color);
        p.gravity = 3;
        p.alive = true;
    }
}

/**
 * Add a custom emitter function.
 * @param {(delta: number, elapsed: number) => void} fn
 */
export function addEmitter(fn) {
    emitters.push(fn);
}

// --- Beat detection ---

function detectBeat(delta) {
    beatCooldownTimer -= delta;
    const rms = music.getOutputRms();
    const isPlaying = music.getIsPlaying();

    if (isPlaying && rms > BEAT_THRESHOLD && rms > prevRms * 1.3 && beatCooldownTimer <= 0) {
        beatCooldownTimer = BEAT_COOLDOWN;
        emitBeatParticles(rms);
    }

    prevRms = rms;
}

function emitBeatParticles(intensity) {
    const count = Math.floor(3 + intensity * 20);
    const hue = (performance.now() * 0.0001) % 1;

    for (let i = 0; i < count; i++) {
        const p = allocParticle();
        if (!p) break;

        // Emit from near the origin (center stage area)
        const angle = Math.random() * Math.PI * 2;
        const radius = 2 + Math.random() * 8;
        p.pos.set(
            Math.cos(angle) * radius,
            0.5 + Math.random() * 2,
            Math.sin(angle) * radius
        );
        p.vel.set(
            (Math.random() - 0.5) * 2,
            2 + Math.random() * 4 * intensity,
            (Math.random() - 0.5) * 2
        );
        p.life = 0.8 + Math.random() * 1.2;
        p.maxLife = p.life;
        p.size = 0.06 + Math.random() * 0.15;
        p.color.setHSL((hue + Math.random() * 0.2) % 1, 0.8, 0.6);
        p.gravity = 1.5;
        p.alive = true;
    }
}

// --- Ambient emitter ---

function ambientEmitter() {
    let timer = 0;
    const INTERVAL = 0.3; // seconds between ambient spawns

    return (delta) => {
        timer += delta;
        if (timer < INTERVAL) return;
        timer -= INTERVAL;

        const p = allocParticle();
        if (!p) return;

        // Spawn in a ring around the scene
        const angle = Math.random() * Math.PI * 2;
        const radius = 5 + Math.random() * 30;
        p.pos.set(
            Math.cos(angle) * radius,
            1 + Math.random() * 15,
            Math.sin(angle) * radius
        );
        p.vel.set(
            (Math.random() - 0.5) * 0.3,
            0.2 + Math.random() * 0.3,
            (Math.random() - 0.5) * 0.3
        );
        p.life = 3 + Math.random() * 4;
        p.maxLife = p.life;
        p.size = 0.03 + Math.random() * 0.06;
        p.color.setHSL(0, 0, 0.7 + Math.random() * 0.3);
        p.gravity = -0.02; // Float upward slightly
        p.alive = true;
    };
}

// --- Pool management ---

function allocParticle() {
    // Find a dead particle
    for (let i = 0; i < MAX_PARTICLES; i++) {
        if (!particles[i].alive) return particles[i];
    }
    // Recycle oldest (lowest remaining life)
    let oldest = particles[0];
    for (let i = 1; i < MAX_PARTICLES; i++) {
        if (particles[i].life < oldest.life) oldest = particles[i];
    }
    return oldest;
}
