// visual-renderer.js -- Renders 2D art from visual sessions onto in-world canvas screens.

import * as THREE from 'three';
import { onUpdate } from './scene.js';

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;
const SCREEN_SCALE = 8; // world units for the screen plane
const SCREEN_ASPECT = DEFAULT_WIDTH / DEFAULT_HEIGHT;

let sceneRef = null;
let canvasEl = null;

// sessionId -> { canvas, ctx, texture, mesh, lastSignature }
const screens = new Map();

// Named CSS colors accepted by the validator
const CSS_COLORS = new Set([
    'red', 'green', 'blue', 'white', 'black', 'yellow', 'cyan', 'magenta',
    'orange', 'purple', 'pink', 'brown', 'gray', 'grey', 'navy', 'teal',
    'lime', 'aqua', 'maroon', 'olive', 'silver', 'fuchsia', 'coral',
    'salmon', 'gold', 'khaki', 'indigo', 'violet', 'crimson', 'turquoise',
]);

export function init(scene, canvas) {
    if (!scene || sceneRef) return;
    sceneRef = scene;
    canvasEl = canvas || null;
    onUpdate(() => {});
}

export function update(session) {
    if (!sceneRef) return;
    const sessionId = session.id;
    const participants = Array.isArray(session.participants) ? session.participants : [];
    const position = session.position || { x: 0, z: 0 };

    // Build a signature to avoid redundant redraws
    const sig = buildSignature(participants);
    let screen = screens.get(sessionId);

    if (screen && screen.lastSignature === sig) return;

    if (!screen) {
        screen = createScreen(sessionId, position);
        screens.set(sessionId, screen);
    }

    screen.lastSignature = sig;
    drawComposite(screen, participants);
    screen.texture.needsUpdate = true;
}

export function remove(sessionId) {
    const screen = screens.get(sessionId);
    if (!screen) return;
    if (screen.mesh && sceneRef) sceneRef.remove(screen.mesh);
    screen.texture.dispose();
    screen.mesh?.geometry?.dispose();
    screen.mesh?.material?.dispose();
    screens.delete(sessionId);
}

export function removeStale(activeIds) {
    for (const sessionId of screens.keys()) {
        if (!activeIds.has(sessionId)) remove(sessionId);
    }
}

export function toggle(sessionId) {
    const screen = screens.get(sessionId);
    if (!screen || !screen.mesh) return;
    screen.mesh.visible = !screen.mesh.visible;
}

export function getState() {
    const active = [];
    for (const [sessionId, screen] of screens.entries()) {
        active.push({
            sessionId,
            visible: screen.mesh?.visible ?? false,
        });
    }
    return { activeScreens: active.length, screens: active };
}

function buildSignature(participants) {
    return participants
        .map(p => `${p.botName || ''}:${JSON.stringify(p.output || {})}`)
        .join('|');
}

function createScreen(sessionId, position) {
    const canvas = document.createElement('canvas');
    canvas.width = DEFAULT_WIDTH;
    canvas.height = DEFAULT_HEIGHT;
    const ctx = canvas.getContext('2d');

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    const geo = new THREE.PlaneGeometry(SCREEN_SCALE, SCREEN_SCALE / SCREEN_ASPECT);
    const mat = new THREE.MeshStandardMaterial({
        map: texture,
        emissive: 0xffffff,
        emissiveMap: texture,
        emissiveIntensity: 0.3,
        roughness: 0.4,
        metalness: 0.1,
        side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    // Position the screen at session coordinates, elevated
    mesh.position.set(position.x || 0, 4.5, position.z || 0);
    // Face toward center
    mesh.lookAt(0, 4.5, 0);
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    if (sceneRef) sceneRef.add(mesh);

    return { canvas, ctx, texture, mesh, lastSignature: '' };
}

function drawComposite(screen, participants) {
    const { ctx, canvas } = screen;
    const w = canvas.width;
    const h = canvas.height;

    // Find creator (first participant) for canvas settings
    const creator = participants[0];
    const creatorOutput = creator?.output;
    const bg = creatorOutput?.canvas?.background || '#1a1a2e';

    // Clear and fill background
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = resolveColor(bg, '#1a1a2e');
    ctx.fillRect(0, 0, w, h);

    // Draw each participant's elements in join order (first = bottom layer)
    for (const participant of participants) {
        const output = participant?.output;
        if (!output || !Array.isArray(output.elements)) continue;
        for (const el of output.elements) {
            drawElement(ctx, el);
        }
    }
}

function drawElement(ctx, el) {
    if (!el || !el.type) return;

    ctx.save();
    ctx.globalAlpha = clamp(el.opacity ?? 1, 0, 1);

    switch (el.type) {
        case 'rect':
            drawRect(ctx, el);
            break;
        case 'circle':
            drawCircle(ctx, el);
            break;
        case 'ellipse':
            drawEllipse(ctx, el);
            break;
        case 'line':
            drawLine(ctx, el);
            break;
        case 'text':
            drawText(ctx, el);
            break;
        case 'path':
            drawPath(ctx, el);
            break;
        case 'polygon':
            drawPolygon(ctx, el);
            break;
    }

    ctx.restore();
}

function drawRect(ctx, el) {
    if (el.rotation) {
        ctx.save();
        ctx.translate(el.x + el.w / 2, el.y + el.h / 2);
        ctx.rotate((el.rotation * Math.PI) / 180);
        if (el.fill) {
            ctx.fillStyle = resolveColor(el.fill);
            ctx.fillRect(-el.w / 2, -el.h / 2, el.w, el.h);
        }
        if (el.stroke) {
            ctx.strokeStyle = resolveColor(el.stroke);
            ctx.lineWidth = el.strokeWidth || 1;
            ctx.strokeRect(-el.w / 2, -el.h / 2, el.w, el.h);
        }
        ctx.restore();
    } else {
        if (el.fill) {
            ctx.fillStyle = resolveColor(el.fill);
            ctx.fillRect(el.x, el.y, el.w, el.h);
        }
        if (el.stroke) {
            ctx.strokeStyle = resolveColor(el.stroke);
            ctx.lineWidth = el.strokeWidth || 1;
            ctx.strokeRect(el.x, el.y, el.w, el.h);
        }
    }
}

function drawCircle(ctx, el) {
    ctx.beginPath();
    ctx.arc(el.cx, el.cy, el.r, 0, Math.PI * 2);
    if (el.fill) {
        ctx.fillStyle = resolveColor(el.fill);
        ctx.fill();
    }
    if (el.stroke) {
        ctx.strokeStyle = resolveColor(el.stroke);
        ctx.lineWidth = el.strokeWidth || 1;
        ctx.stroke();
    }
}

function drawEllipse(ctx, el) {
    ctx.beginPath();
    ctx.ellipse(el.cx, el.cy, el.rx, el.ry, 0, 0, Math.PI * 2);
    if (el.fill) {
        ctx.fillStyle = resolveColor(el.fill);
        ctx.fill();
    }
    if (el.stroke) {
        ctx.strokeStyle = resolveColor(el.stroke);
        ctx.lineWidth = el.strokeWidth || 1;
        ctx.stroke();
    }
}

function drawLine(ctx, el) {
    ctx.beginPath();
    ctx.moveTo(el.x1, el.y1);
    ctx.lineTo(el.x2, el.y2);
    ctx.strokeStyle = resolveColor(el.stroke || '#ffffff');
    ctx.lineWidth = el.strokeWidth || 1;
    ctx.stroke();
}

function drawText(ctx, el) {
    const size = clamp(el.fontSize || 16, 8, 72);
    const family = el.fontFamily || 'monospace';
    ctx.font = `${size}px ${family}`;
    ctx.fillStyle = resolveColor(el.fill || '#ffffff');
    ctx.textAlign = el.align || 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(el.content || '').slice(0, 100), el.x, el.y);
}

function drawPath(ctx, el) {
    const points = Array.isArray(el.points) ? el.points : [];
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
    }
    if (el.closed) ctx.closePath();
    if (el.fill) {
        ctx.fillStyle = resolveColor(el.fill);
        ctx.fill();
    }
    if (el.stroke) {
        ctx.strokeStyle = resolveColor(el.stroke);
        ctx.lineWidth = el.strokeWidth || 1;
        ctx.stroke();
    }
}

function drawPolygon(ctx, el) {
    const points = Array.isArray(el.points) ? el.points : [];
    if (points.length < 3) return;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
    }
    ctx.closePath();
    if (el.fill) {
        ctx.fillStyle = resolveColor(el.fill);
        ctx.fill();
    }
    if (el.stroke) {
        ctx.strokeStyle = resolveColor(el.stroke);
        ctx.lineWidth = el.strokeWidth || 1;
        ctx.stroke();
    }
}

function resolveColor(value, fallback) {
    if (!value) return fallback || '#ffffff';
    const s = String(value).trim().toLowerCase();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return s;
    if (CSS_COLORS.has(s)) return s;
    return fallback || '#ffffff';
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}
