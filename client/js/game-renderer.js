// game-renderer.js -- Renders template-based mini-games on in-world screens.

import * as THREE from 'three';
import { onUpdate } from './scene.js';

const SCREEN_WIDTH = 800;
const SCREEN_HEIGHT = 600;
const SCREEN_SCALE = 8;
const SCREEN_ASPECT = SCREEN_WIDTH / SCREEN_HEIGHT;
const REDRAW_INTERVAL = 1 / 20; // 20 FPS for game rendering

let sceneRef = null;
let cameraRef = null;
let canvasEl = null;
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

// sessionId -> { canvas, ctx, texture, mesh, gameState, template, lastConfigSig }
const gameScreens = new Map();

// --- Template engines ---

const gameTemplates = {
    click_target: {
        init(config) {
            return {
                score: 0,
                round: 0,
                maxRounds: clamp(config.rounds ?? 5, 1, 20),
                targets: [],
                spawnRate: clamp(config.spawnRate ?? 1, 0.5, 5),
                targetSize: clamp(config.targetSize ?? 1, 0.3, 3),
                lifetime: clamp(config.lifetime ?? 3, 1, 10),
                maxTargets: clamp(config.maxTargets ?? 5, 1, 20),
                colors: resolveColors(config.colors, ['#ff4444', '#44ff44', '#4444ff']),
                spawnTimer: 0,
                active: true,
            };
        },
        tick(state, delta) {
            if (!state.active) return;
            state.spawnTimer += delta;
            if (state.spawnTimer >= 1 / state.spawnRate && state.targets.length < state.maxTargets) {
                state.spawnTimer = 0;
                state.targets.push({
                    x: 60 + Math.random() * (SCREEN_WIDTH - 120),
                    y: 60 + Math.random() * (SCREEN_HEIGHT - 120),
                    r: state.targetSize * 25,
                    color: state.colors[Math.floor(Math.random() * state.colors.length)],
                    age: 0,
                });
            }
            // Age and remove expired targets
            for (let i = state.targets.length - 1; i >= 0; i--) {
                state.targets[i].age += delta;
                if (state.targets[i].age > state.lifetime) {
                    state.targets.splice(i, 1);
                }
            }
        },
        render(ctx, state, w, h) {
            // Background
            ctx.fillStyle = '#0a0a1a';
            ctx.fillRect(0, 0, w, h);

            // Title
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 24px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('CLICK TARGET', w / 2, 30);

            // Score
            ctx.font = '18px monospace';
            ctx.textAlign = 'left';
            ctx.fillText(`Score: ${state.score}`, 20, 60);

            // Targets
            for (const target of state.targets) {
                const alpha = 1 - (target.age / state.lifetime) * 0.6;
                ctx.globalAlpha = alpha;
                ctx.beginPath();
                ctx.arc(target.x, target.y, target.r, 0, Math.PI * 2);
                ctx.fillStyle = target.color;
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.globalAlpha = 1;
            }

            if (!state.active) {
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillRect(0, 0, w, h);
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 36px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`GAME OVER - Score: ${state.score}`, w / 2, h / 2);
            }
        },
        onInput(state, uv) {
            if (!state.active) return;
            const px = uv.x * SCREEN_WIDTH;
            const py = (1 - uv.y) * SCREEN_HEIGHT;
            for (let i = state.targets.length - 1; i >= 0; i--) {
                const t = state.targets[i];
                const dx = px - t.x;
                const dy = py - t.y;
                if (dx * dx + dy * dy <= t.r * t.r) {
                    state.targets.splice(i, 1);
                    state.score++;
                    state.round++;
                    if (state.round >= state.maxRounds) state.active = false;
                    return;
                }
            }
        },
    },

    memory_match: {
        init(config) {
            const grid = Array.isArray(config.gridSize) ? config.gridSize : [4, 4];
            const cols = clamp(grid[0] ?? 4, 2, 6);
            const rows = clamp(grid[1] ?? 4, 2, 6);
            const totalPairs = Math.floor((cols * rows) / 2);
            const colors = resolveColors(config.colors, [
                '#ff4444', '#44ff44', '#4444ff', '#ffff44',
                '#ff44ff', '#44ffff', '#ff8844', '#88ff44',
            ]);
            const flipTime = clamp(config.flipTime ?? 1.5, 0.5, 5);

            // Build shuffled card array
            const cards = [];
            for (let i = 0; i < totalPairs; i++) {
                const c = colors[i % colors.length];
                cards.push({ color: c, pairId: i, flipped: false, matched: false });
                cards.push({ color: c, pairId: i, flipped: false, matched: false });
            }
            // Fill remaining cells if odd total
            if (cols * rows > cards.length) {
                cards.push({ color: '#333', pairId: -1, flipped: false, matched: true });
            }
            shuffle(cards);

            return {
                cols,
                rows,
                cards,
                flipTime,
                flipped: [],  // indices of currently flipped cards
                flipTimer: 0,
                score: 0,
                moves: 0,
                complete: false,
            };
        },
        tick(state, delta) {
            if (state.flipped.length === 2) {
                state.flipTimer += delta;
                if (state.flipTimer >= state.flipTime) {
                    const [a, b] = state.flipped;
                    if (state.cards[a].pairId === state.cards[b].pairId) {
                        state.cards[a].matched = true;
                        state.cards[b].matched = true;
                        state.score++;
                    }
                    state.cards[a].flipped = false;
                    state.cards[b].flipped = false;
                    state.flipped = [];
                    state.flipTimer = 0;

                    // Check completion
                    if (state.cards.every(c => c.matched)) {
                        state.complete = true;
                    }
                }
            }
        },
        render(ctx, state, w, h) {
            ctx.fillStyle = '#0a0a1a';
            ctx.fillRect(0, 0, w, h);

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 22px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('MEMORY MATCH', w / 2, 28);

            ctx.font = '16px monospace';
            ctx.textAlign = 'left';
            ctx.fillText(`Pairs: ${state.score}  Moves: ${state.moves}`, 20, 54);

            const padX = 40;
            const padY = 70;
            const cellW = (w - padX * 2) / state.cols;
            const cellH = (h - padY - 30) / state.rows;
            const gap = 4;

            for (let i = 0; i < state.cards.length; i++) {
                const card = state.cards[i];
                const col = i % state.cols;
                const row = Math.floor(i / state.cols);
                const x = padX + col * cellW + gap;
                const y = padY + row * cellH + gap;
                const cw = cellW - gap * 2;
                const ch = cellH - gap * 2;

                if (card.matched) {
                    ctx.fillStyle = card.color;
                    ctx.globalAlpha = 0.3;
                    ctx.fillRect(x, y, cw, ch);
                    ctx.globalAlpha = 1;
                } else if (card.flipped) {
                    ctx.fillStyle = card.color;
                    ctx.fillRect(x, y, cw, ch);
                } else {
                    ctx.fillStyle = '#334';
                    ctx.fillRect(x, y, cw, ch);
                    ctx.strokeStyle = '#556';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(x, y, cw, ch);
                }
            }

            if (state.complete) {
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillRect(0, 0, w, h);
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 36px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`COMPLETE! Moves: ${state.moves}`, w / 2, h / 2);
            }
        },
        onInput(state, uv) {
            if (state.complete || state.flipped.length >= 2) return;
            const px = uv.x * SCREEN_WIDTH;
            const py = (1 - uv.y) * SCREEN_HEIGHT;

            const padX = 40;
            const padY = 70;
            const cellW = (SCREEN_WIDTH - padX * 2) / state.cols;
            const cellH = (SCREEN_HEIGHT - padY - 30) / state.rows;

            const col = Math.floor((px - padX) / cellW);
            const row = Math.floor((py - padY) / cellH);
            if (col < 0 || col >= state.cols || row < 0 || row >= state.rows) return;

            const idx = row * state.cols + col;
            const card = state.cards[idx];
            if (!card || card.flipped || card.matched) return;

            card.flipped = true;
            state.flipped.push(idx);
            state.moves++;
        },
    },
};

// --- Public API ---

export function init(scene, camera, canvas) {
    if (!scene || sceneRef) return;
    sceneRef = scene;
    cameraRef = camera;
    canvasEl = canvas || null;
    if (canvasEl) {
        canvasEl.addEventListener('click', onPointerClick);
    }
    onUpdate((delta) => tick(delta));
}

export function update(session) {
    if (!sceneRef) return;
    const sessionId = session.id;
    const participants = Array.isArray(session.participants) ? session.participants : [];
    const position = session.position || { x: 0, z: 0 };

    // Game config comes from creator
    const creator = participants[0];
    const output = creator?.output;
    if (!output || !output.template) return;

    const templateName = output.template;
    const template = gameTemplates[templateName];
    if (!template) return;

    const configSig = JSON.stringify(output);
    let screen = gameScreens.get(sessionId);

    if (screen && screen.lastConfigSig === configSig) return;

    // New config or new session — reinitialize
    if (screen) {
        removeScreen(sessionId);
    }

    screen = createScreen(sessionId, position);
    screen.template = template;
    screen.gameState = template.init(output.config || {});
    screen.lastConfigSig = configSig;
    screen.title = output.title || templateName;
    gameScreens.set(sessionId, screen);
}

export function remove(sessionId) {
    removeScreen(sessionId);
}

export function removeStale(activeIds) {
    for (const sessionId of gameScreens.keys()) {
        if (!activeIds.has(sessionId)) removeScreen(sessionId);
    }
}

export function toggle(sessionId) {
    const screen = gameScreens.get(sessionId);
    if (!screen || !screen.mesh) return;
    screen.mesh.visible = !screen.mesh.visible;
}

export function getState() {
    const active = [];
    for (const [sessionId, screen] of gameScreens.entries()) {
        active.push({
            sessionId,
            template: screen.title,
            visible: screen.mesh?.visible ?? false,
            score: screen.gameState?.score ?? 0,
        });
    }
    return { activeGames: active.length, games: active };
}

// --- Internal ---

function createScreen(sessionId, position) {
    const canvas = document.createElement('canvas');
    canvas.width = SCREEN_WIDTH;
    canvas.height = SCREEN_HEIGHT;
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
        emissiveIntensity: 0.4,
        roughness: 0.3,
        metalness: 0.1,
        side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(position.x || 0, 4.5, position.z || 0);
    mesh.lookAt(0, 4.5, 0);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.gameSessionId = sessionId;

    if (sceneRef) sceneRef.add(mesh);

    return {
        canvas, ctx, texture, mesh,
        template: null,
        gameState: null,
        lastConfigSig: '',
        title: '',
        redrawCooldown: 0,
    };
}

function removeScreen(sessionId) {
    const screen = gameScreens.get(sessionId);
    if (!screen) return;
    if (screen.mesh && sceneRef) sceneRef.remove(screen.mesh);
    screen.texture?.dispose();
    screen.mesh?.geometry?.dispose();
    screen.mesh?.material?.dispose();
    gameScreens.delete(sessionId);
}

function tick(delta) {
    for (const [, screen] of gameScreens) {
        if (!screen.template || !screen.gameState || !screen.mesh?.visible) continue;

        // Tick game logic
        screen.template.tick(screen.gameState, delta);

        // Throttle rendering
        screen.redrawCooldown -= delta;
        if (screen.redrawCooldown <= 0) {
            screen.redrawCooldown = REDRAW_INTERVAL;
            screen.template.render(screen.ctx, screen.gameState, SCREEN_WIDTH, SCREEN_HEIGHT);
            screen.texture.needsUpdate = true;
        }
    }
}

function onPointerClick(event) {
    if (!cameraRef || !canvasEl) return;

    const rect = canvasEl.getBoundingClientRect();
    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointerNdc, cameraRef);

    // Check intersection with all game screen meshes
    const meshes = [];
    for (const [, screen] of gameScreens) {
        if (screen.mesh?.visible) meshes.push(screen.mesh);
    }

    const hits = raycaster.intersectObjects(meshes);
    if (hits.length === 0) return;

    const hit = hits[0];
    const sessionId = hit.object.userData.gameSessionId;
    const screen = gameScreens.get(sessionId);
    if (!screen || !screen.template || !screen.gameState) return;

    // Get UV coordinates at hit point
    const uv = hit.uv;
    if (!uv) return;

    screen.template.onInput(screen.gameState, uv);
}

function resolveColors(input, defaults) {
    if (!Array.isArray(input) || input.length === 0) return defaults;
    const valid = input
        .filter(c => typeof c === 'string')
        .map(c => c.trim())
        .filter(c => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c))
        .slice(0, 8);
    return valid.length > 0 ? valid : defaults;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}
