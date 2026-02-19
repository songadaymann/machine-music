// world-layout.js -- Shared geometry for the broadcast arena shell.

import * as THREE from 'three';

export const DEFAULT_SLOT_COUNT = 8;

export const ARENA_CENTER = new THREE.Vector3(0, 0, 0);
export const FLOOR_RADIUS = 36;
export const STAGE_DISK_RADIUS = 7.4;
export const STAGE_RING_RADIUS = 6.65;
export const SLOT_RING_RADIUS = 5.55;
export const STAGE_WALKWAY_WIDTH = 2.8;

export const ARRIVAL_GATE_CENTER = new THREE.Vector3(0, 0, 12.8);
const ARRIVAL_GATE_EXIT_Z = ARRIVAL_GATE_CENTER.z - 0.8;

const SLOT_ARC_START = THREE.MathUtils.degToRad(210);
const SLOT_ARC_END = THREE.MathUtils.degToRad(330);

const QUEUE_RAIL_POINTS = [
    new THREE.Vector3(1.8, 0.06, 12.2),
    new THREE.Vector3(4.6, 0.06, 11.1),
    new THREE.Vector3(7.5, 0.06, 10.0),
    new THREE.Vector3(9.8, 0.06, 7.5),
    new THREE.Vector3(10.1, 0.06, 3.9),
    new THREE.Vector3(9.7, 0.06, 0.1),
    new THREE.Vector3(8.8, 0.06, -3.3),
    new THREE.Vector3(7.2, 0.06, -6.8),
];

const queueRailCurve = new THREE.CatmullRomCurve3(QUEUE_RAIL_POINTS, false, 'catmullrom', 0.08);

function hashString(input) {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
    }
    return hash;
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

export function getSlotTransform(index, count = DEFAULT_SLOT_COUNT) {
    const clampedIndex = Math.max(0, Math.min(count - 1, index));
    const t = count <= 1 ? 0.5 : clampedIndex / (count - 1);
    const angle = SLOT_ARC_START + t * (SLOT_ARC_END - SLOT_ARC_START);
    const x = Math.cos(angle) * SLOT_RING_RADIUS;
    const z = Math.sin(angle) * SLOT_RING_RADIUS;
    const position = new THREE.Vector3(x, 0, z);
    const rotation = Math.atan2(-x, -z);
    return { position, rotation, angle };
}

export function getQueueCurve() {
    return queueRailCurve;
}

export function getQueuePoint(t) {
    const p = queueRailCurve.getPoint(clamp01(t));
    return new THREE.Vector3(p.x, 0, p.z);
}

export function getQueueRestPoint(botName = '') {
    const hash = hashString(botName || 'bot');
    const t = 0.12 + ((hash % 780) / 1000);
    return getQueuePoint(t);
}

export function getArrivalSpawnPoint(botName = '') {
    const hash = hashString(botName || 'bot');
    const lane = ((hash % 1000) / 1000 - 0.5) * STAGE_WALKWAY_WIDTH * 0.7;
    const zJitter = ((Math.floor(hash / 1000) % 1000) / 1000) * 0.9;
    return new THREE.Vector3(ARRIVAL_GATE_CENTER.x + lane, 0, ARRIVAL_GATE_EXIT_Z + zJitter);
}
