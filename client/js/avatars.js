// avatars.js -- Load GLB avatar model + separate animation GLBs, clone per bot
//
// Model: /models/generic-model/generic.glb (character mesh + skeleton)
// Animations: /models/animations/*.glb
// (idle, walk, drums, bass, guitar, piano, punch, fallingDown, gettingUp, plus optional social clips)
// Falls back to procedural capsule avatars if loading fails.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { getSlotPosition } from './instruments.js';
import { getScene, getClock, onUpdate } from './scene.js';
import { getArrivalSpawnPoint, getQueueRestPoint } from './world-layout.js';

// --- Config ---
const MODEL_PATH = '/models/generic-model/generic.glb';
const ANIM_BASE = '/models/animations/';
const ANIM_FILES = {
    idle:        'idle.glb',
    walk:        'walk.glb',
    drums:       'drums.glb',
    bass:        'bass.glb',
    guitar:      'guitar.glb',
    piano:       'piano.glb',
    punch:       'punch.glb',
    fallingDown: 'fallingDown.glb',
    gettingUp:   'gettingUp.glb',
    dance:       'dance.glb',
    headbob:     'headbob.glb',
    chatGesture: 'chatGesture.glb',
    cheer:       'cheer.glb',
    rest:        'rest.glb',
    stretch:     'stretch.glb',
};
const FALLBACK_MODEL_PATH = `${ANIM_BASE}${ANIM_FILES.idle}`;

// Map slot type -> animation name for "playing" state
const SLOT_ANIM = {
    drums:  'drums',
    bass:   'bass',
    chords: 'piano',
    melody: 'guitar',
    wild:   'drums',   // wild card -- use drums for now
};

const WALK_SPEED = 3;       // units per second
const BOB_SPEED = 3;        // bops per second when playing (procedural fallback)
const BOB_AMOUNT = 0.1;
const DRAMA_STRIKE_DISTANCE = 1.15;
const DRAMA_MAX_WAIT_MS = 4500;
const DRAMA_GETUP_DELAY_MS = 1000;
const THOUGHT_BUBBLE_WIDTH = 4.2;
const THOUGHT_BUBBLE_HEIGHT = 1.9;
const DEFAULT_CUSTOM_MODEL_HEIGHT = 1.7;
let avatarScale = 1.95;     // target avatar height in scene units -- adjustable at runtime
let avatarYOffset = 0.1;    // Y offset for all avatars -- adjustable at runtime

// --- State ---
let templateScene = null;     // the loaded GLB scene graph (to clone)
let animationClips = {};      // { name: AnimationClip }
let modelLoaded = false;
let loadFailed = false;
let modelBaseHeight = 1;
let modelSourcePath = MODEL_PATH;
const customAvatarCache = new Map(); // glbUrl -> Promise<{ scene, clipMap, rawHeight } | null>

const avatars = new Map();    // botName -> AvatarState

// AvatarState:
// {
//   name, group, mixer, actions, currentAction,
//   targetPosition, slotId, slotType,
//   thinking, thinkingText,
//   drama: null | 'punch' | 'fallingDown' | 'gettingUp',
//   pendingStrike: null | { victimName: string, queuedAtMs: number },
//   pendingAttackerName: null | string,
//   customGlbUrl: string | null,
//   customAvatarHeight: number | null,
//   jamSessionId: string | null,
//   jamStyle: string | null
// }

// --- Public API ---

export function getAvatar(botName) { return avatars.get(botName); }
export function getAllAvatars() { return avatars; }
export function getAvatarScale() { return avatarScale; }

export function setAvatarScale(scale) {
    const next = Number(scale);
    if (!Number.isFinite(next) || next <= 0) {
        console.warn('[avatars] Ignoring invalid avatar scale:', scale);
        return;
    }
    avatarScale = Math.min(Math.max(next, 0.1), 20);

    const appliedScale = avatarScale / Math.max(modelBaseHeight, 0.0001);

    // Update template (affects future clones)
    if (templateScene) {
        templateScene.scale.setScalar(appliedScale);
    }
    // Update all existing avatars
    for (const [, avatar] of avatars) {
        if (!avatar.isGLB) continue;
        if (avatar.customGlbUrl) continue; // custom avatars are pre-scaled at load time
        // The first child of the group is the cloned model scene
        const model = avatar.group.children[0];
        if (model && model.isObject3D) {
            model.scale.setScalar(appliedScale);
        }
    }
}

export function getAvatarYOffset() { return avatarYOffset; }

export function setAvatarYOffset(y) {
    avatarYOffset = y;
    // Update all existing avatars that are stationary (not walking)
    for (const [, avatar] of avatars) {
        if (!avatar.targetPosition) {
            avatar.group.position.y = y;
        }
    }
}

export function getLoadStatus() {
    return { modelLoaded, loadFailed, animCount: Object.keys(animationClips).length };
}

// --- Loader ---

const loader = new GLTFLoader();

function loadGLB(path) {
    return new Promise((resolve, reject) => {
        loader.load(path, resolve, undefined, reject);
    });
}

function inspectRig(scene) {
    let meshCount = 0;
    let skinnedCount = 0;
    const boneNames = [];
    const nodeNames = [];
    let helperNodeCount = 0;

    scene.traverse((child) => {
        if (child.isMesh) meshCount++;
        if (child.isSkinnedMesh) skinnedCount++;
        if (child.isBone) boneNames.push(child.name);
        if (child.name) nodeNames.push(child.name);
        if (child.name && child.name.includes('$AssimpFbx$')) helperNodeCount++;
    });

    return {
        meshCount,
        skinnedCount,
        boneNames,
        nodeNames,
        helperNodeCount,
    };
}

function hasSkinnedMesh(object3D) {
    let skinned = false;
    object3D.traverse((child) => {
        if (child.isSkinnedMesh) skinned = true;
    });
    return skinned;
}

function measureHeight(object3D) {
    const box = new THREE.Box3().setFromObject(object3D);
    if (
        !Number.isFinite(box.min.y) ||
        !Number.isFinite(box.max.y)
    ) {
        return null;
    }
    const h = box.max.y - box.min.y;
    if (!Number.isFinite(h) || h <= 0) return null;
    return h;
}

function inferCustomActionName(rawName) {
    const name = (rawName || '').toLowerCase();
    if (name.includes('idle') || name.includes('rest')) return 'idle';
    if (name.includes('walk') || name.includes('run')) return 'walk';
    if (name.includes('dance')) return 'dance';
    if (name.includes('headbob') || name.includes('head-bob') || name.includes('bob')) return 'headbob';
    if (name.includes('chat') || name.includes('talk') || name.includes('gesture')) return 'chatGesture';
    if (name.includes('cheer') || name.includes('clap')) return 'cheer';
    if (name.includes('stretch')) return 'stretch';
    if (name.includes('drum')) return 'drums';
    if (name.includes('bass')) return 'bass';
    if (name.includes('guitar') || name.includes('melody')) return 'guitar';
    if (name.includes('piano') || name.includes('keys') || name.includes('chord')) return 'piano';
    if (name.includes('punch') || name.includes('hit') || name.includes('attack')) return 'punch';
    if (name.includes('fall')) return 'fallingDown';
    if (name.includes('getup') || name.includes('get-up') || name.includes('stand')) return 'gettingUp';
    return null;
}

function buildClipMapFromAnimations(animations) {
    const clipMap = {};
    if (!Array.isArray(animations)) return clipMap;

    for (const clip of animations) {
        if (!clip) continue;
        const inferred = inferCustomActionName(clip.name);
        if (inferred && !clipMap[inferred]) {
            clipMap[inferred] = clip;
            continue;
        }
        // Keep original name as secondary key if no canonical mapping exists yet.
        if (clip.name && !clipMap[clip.name]) {
            clipMap[clip.name] = clip;
        }
    }

    if (!clipMap.idle && animations[0]) {
        clipMap.idle = animations[0];
    }

    return clipMap;
}

function normalizeCustomAvatarMaterial(material) {
    const materials = Array.isArray(material) ? material : [material];
    for (const mat of materials) {
        if (!mat || !mat.isMaterial) continue;

        if (mat.map && mat.map.isTexture) {
            mat.map.colorSpace = THREE.SRGBColorSpace;
        }

        if (mat.color && mat.color.isColor) {
            mat.color.setRGB(1, 1, 1);
        }

        // Meshy rigged outputs often duplicate baseColor as emissive with full intensity.
        // Keep only a small emissive lift so models are readable without washing to white.
        const hasDuplicateEmissive = !!(mat.emissiveMap && mat.map && mat.emissiveMap === mat.map);
        if (hasDuplicateEmissive) {
            if (mat.emissive && mat.emissive.isColor) {
                mat.emissive.setRGB(1, 1, 1);
            }
            mat.emissiveIntensity = 0.08;
        } else if (mat.emissiveMap && typeof mat.emissiveIntensity === 'number' && mat.emissiveIntensity > 0.3) {
            mat.emissiveIntensity = 0.3;
        }

        // Meshy materials can come in very metallic/dark for this scene rig.
        if (typeof mat.metalness === 'number' && mat.metalness > 0.55) {
            mat.metalness = 0.55;
        }
        if (typeof mat.roughness === 'number' && mat.roughness < 0.45) {
            mat.roughness = 0.45;
        }

        // Clamp overly hot specular from exported extension values.
        if (typeof mat.specularIntensity === 'number' && mat.specularIntensity > 1) {
            mat.specularIntensity = 1;
        }
        if (mat.specularColor && mat.specularColor.isColor) {
            mat.specularColor.r = Math.min(mat.specularColor.r, 1);
            mat.specularColor.g = Math.min(mat.specularColor.g, 1);
            mat.specularColor.b = Math.min(mat.specularColor.b, 1);
        }

        mat.toneMapped = true;
        mat.needsUpdate = true;
    }
}

function sanitizeCustomAvatarHeight(value) {
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0) return null;
    return Math.min(Math.max(next, 0.1), 20);
}

async function loadCustomAvatar(glbUrl) {
    if (!glbUrl) return null;
    if (customAvatarCache.has(glbUrl)) {
        return customAvatarCache.get(glbUrl);
    }

    const pending = (async () => {
        try {
            const gltf = await loadGLB(glbUrl);
            const rigInfo = inspectRig(gltf.scene);
            if (rigInfo.skinnedCount === 0 || rigInfo.boneNames.length === 0) {
                console.warn(
                    `[avatars] Custom avatar has no rig (${glbUrl}); ` +
                    `loading as static mesh`
                );
            }

            const rawHeight = measureHeight(gltf.scene) || 1;
            gltf.scene.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                    normalizeCustomAvatarMaterial(child.material);
                }
            });

            const clipMap = buildClipMapFromAnimations(gltf.animations || []);

            if (!clipMap.idle) {
                const firstClip = Object.values(clipMap)[0];
                if (firstClip) clipMap.idle = firstClip;
            }

            return { scene: gltf.scene, clipMap, rawHeight };
        } catch (error) {
            console.warn(`[avatars] Failed to load custom avatar (${glbUrl}):`, error);
            return null;
        }
    })();

    customAvatarCache.set(glbUrl, pending);
    return pending;
}

// --- Load model + all animations ---

export async function loadModel() {
    try {
        // Load character mesh (fallback to idle.glb rig if generic model is unrigged)
        let sourcePath = MODEL_PATH;
        let modelGltf = await loadGLB(sourcePath);
        let rigInfo = inspectRig(modelGltf.scene);

        const hasAssimpHelpers = rigInfo.helperNodeCount > 0;
        if (rigInfo.skinnedCount === 0 || rigInfo.boneNames.length === 0 || hasAssimpHelpers) {
            if (hasAssimpHelpers) {
                console.warn(
                    `[avatars] ${MODEL_PATH} contains ${rigInfo.helperNodeCount} Assimp FBX helper nodes. ` +
                    `This rig shape is often incompatible with clean Mixamo clips and can cause mesh folding.`
                );
            }
            console.warn(
                `[avatars] ${MODEL_PATH} is not a safe runtime rig ` +
                `(skinned: ${rigInfo.skinnedCount}, bones: ${rigInfo.boneNames.length}, helpers: ${rigInfo.helperNodeCount}). ` +
                `Falling back to ${FALLBACK_MODEL_PATH}.`
            );
            sourcePath = FALLBACK_MODEL_PATH;
            modelGltf = await loadGLB(sourcePath);
            rigInfo = inspectRig(modelGltf.scene);
        }

        if (rigInfo.skinnedCount === 0 || rigInfo.boneNames.length === 0) {
            throw new Error(
                `No rigged avatar model found (source: ${sourcePath}, skinned: ${rigInfo.skinnedCount}, bones: ${rigInfo.boneNames.length})`
            );
        }

        templateScene = modelGltf.scene;
        modelSourcePath = sourcePath;

        const rawHeight = measureHeight(templateScene);
        if (rawHeight) {
            modelBaseHeight = rawHeight;
        } else {
            modelBaseHeight = 1;
            console.warn(`[avatars] Could not measure model height for ${sourcePath}; using base height = 1`);
        }

        // Normalize to target avatar height, so different source rigs stay visible.
        const appliedScale = avatarScale / Math.max(modelBaseHeight, 0.0001);
        templateScene.scale.setScalar(appliedScale);

        // Enable shadows on all meshes
        templateScene.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        // Log what we got
        console.log(
            `[avatars] Loaded character model from ${sourcePath}: ` +
            `${rigInfo.meshCount} meshes, ${rigInfo.skinnedCount} skinned, ${rigInfo.boneNames.length} bones, ` +
            `${rigInfo.helperNodeCount} helper nodes`
        );
        console.log(
            `[avatars] Model height(raw): ${modelBaseHeight.toFixed(3)} | target height: ${avatarScale.toFixed(3)} | applied scale: ${appliedScale.toFixed(4)}`
        );
        if (rigInfo.boneNames.length > 0) {
            console.log('[avatars] First 5 bone names:', rigInfo.boneNames.slice(0, 5));
        }

        // Load all animation GLBs in parallel
        const animEntries = Object.entries(ANIM_FILES);
        const results = await Promise.allSettled(
            animEntries.map(([name, file]) =>
                loadGLB(ANIM_BASE + file).then(gltf => ({ name, gltf }))
            )
        );

        for (const result of results) {
            if (result.status === 'fulfilled') {
                const { name, gltf } = result.value;
                if (gltf.animations && gltf.animations.length > 0) {
                    const clip = gltf.animations[0];
                    clip.name = name;
                    animationClips[name] = clip;
                }
            } else {
                console.warn('[avatars] Failed to load animation:', result.reason);
            }
        }

        modelLoaded = true;
        console.log(
            `[avatars] Loaded ${Object.keys(animationClips).length} animations:`,
            Object.keys(animationClips)
        );
    } catch (err) {
        console.warn('[avatars] Failed to load model, using procedural avatars:', err.message);
        loadFailed = true;
    }
}

// --- Create a procedural avatar (fallback) ---

function createProceduralAvatar(name) {
    const group = new THREE.Group();
    group.name = `avatar-${name}`;

    const bodyMat = new THREE.MeshStandardMaterial({
        color: 0x667788, roughness: 0.6, metalness: 0.3,
    });

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.6, 12), bodyMat);
    torso.position.y = 0.8;
    torso.castShadow = true;
    group.add(torso);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), bodyMat);
    head.position.y = 1.3;
    head.castShadow = true;
    group.add(head);

    const eyeMat = new THREE.MeshStandardMaterial({
        color: 0x2a6e5a, emissive: 0x2a6e5a, emissiveIntensity: 0.8,
    });
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 4), eyeMat);
    eyeL.position.set(-0.07, 1.33, 0.15);
    group.add(eyeL);
    const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 4), eyeMat);
    eyeR.position.set(0.07, 1.33, 0.15);
    group.add(eyeR);

    const legMat = new THREE.MeshStandardMaterial({ color: 0x556677, roughness: 0.7 });
    const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 6), legMat);
    legL.position.set(-0.1, 0.25, 0);
    legL.castShadow = true;
    group.add(legL);
    const legR = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 6), legMat);
    legR.position.set(0.1, 0.25, 0);
    legR.castShadow = true;
    group.add(legR);

    addNameTag(group, name, 1.7);
    return group;
}

// --- Create avatar from GLB template ---

function createGLBAvatar(name, sceneTemplate = templateScene, sourceLabel = modelSourcePath) {
    const group = new THREE.Group();
    group.name = `avatar-${name}`;

    // Use SkeletonUtils only for actual skinned rigs.
    // Static refine/preview meshes clone more reliably with Object3D.clone.
    const clone = hasSkinnedMesh(sceneTemplate)
        ? cloneSkeleton(sceneTemplate)
        : sceneTemplate.clone(true);
    const cloneHeight = measureHeight(clone);
    if (!cloneHeight || cloneHeight < 0.02) {
        console.warn(
            `[avatars] GLB clone for "${name}" from ${sourceLabel} has invalid bounds (height: ${cloneHeight}). ` +
            `Using procedural fallback.`
        );
        return null;
    }
    group.add(clone);

    addNameTag(group, name, 2.8);
    return group;
}

function createCustomGLBAvatar(name, customData, customGlbUrl, customAvatarHeight = null) {
    const group = createGLBAvatar(name, customData.scene, customGlbUrl);
    if (!group) return null;

    const targetHeight = sanitizeCustomAvatarHeight(customAvatarHeight) ?? avatarScale;
    const measuredHeight = Number(customData.rawHeight);
    const hasSaneMeasuredHeight =
        Number.isFinite(measuredHeight) &&
        measuredHeight >= 0.4 &&
        measuredHeight <= 6;
    const baseHeight = hasSaneMeasuredHeight
        ? measuredHeight
        : DEFAULT_CUSTOM_MODEL_HEIGHT;
    const model = group.children[0];
    if (model && model.isObject3D) {
        const appliedScale = targetHeight / Math.max(baseHeight, 0.0001);
        model.scale.setScalar(appliedScale);
    }

    if (!hasSaneMeasuredHeight) {
        console.warn(
            `[avatars] Custom avatar "${name}" reported atypical height (${customData.rawHeight}); ` +
            `using default base height ${DEFAULT_CUSTOM_MODEL_HEIGHT}`
        );
    }

    return group;
}

// --- Shared name tag ---

function addNameTag(group, name, yPos) {
    const tagCanvas = document.createElement('canvas');
    tagCanvas.width = 256;
    tagCanvas.height = 64;
    const ctx = tagCanvas.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#fff';
    ctx.font = '20px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(name.length > 16 ? name.slice(0, 16) : name, 128, 40);

    const tagTexture = new THREE.CanvasTexture(tagCanvas);
    const tagMat = new THREE.SpriteMaterial({ map: tagTexture, transparent: true });
    const tag = new THREE.Sprite(tagMat);
    tag.position.set(0, yPos, 0);
    tag.scale.set(1.5, 0.4, 1);
    group.add(tag);
}

function createAvatarState(botName, group, options = {}) {
    const {
        useGLB = false,
        clipMap = {},
        customGlbUrl = null,
        customAvatarHeight = null,
    } = options;

    const thoughtBubble = createThoughtBubble(useGLB ? 3.8 : 2.4);
    group.add(thoughtBubble.sprite);

    // Animation mixer (for GLB models)
    let mixer = null;
    const actions = {};
    if (useGLB && clipMap && Object.keys(clipMap).length > 0) {
        mixer = new THREE.AnimationMixer(group);
        for (const [animName, clip] of Object.entries(clipMap)) {
            actions[animName] = mixer.clipAction(clip);
        }
        const idleAction = actions.idle || Object.values(actions)[0];
        if (idleAction) idleAction.play();
    }

    return {
        name: botName,
        isGLB: useGLB,
        group,
        mixer,
        actions,
        currentAction: 'idle',
        targetPosition: null,
        slotId: null,
        slotType: null,
        thinking: false,
        thinkingText: '',
        thoughtBubble,
        drama: null,
        pendingStrike: null,
        pendingAttackerName: null,
        customGlbUrl,
        customAvatarHeight: sanitizeCustomAvatarHeight(customAvatarHeight),
        jamSessionId: null,
        jamStyle: null,
    };
}

function createThoughtBubble(yPos) {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 420;
    const ctx = canvas.getContext('2d');

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(0, yPos, 0);
    sprite.scale.set(THOUGHT_BUBBLE_WIDTH, THOUGHT_BUBBLE_HEIGHT, 1);
    sprite.visible = false;

    return { canvas, ctx, texture, sprite };
}

function drawThoughtBubble(bubble, text) {
    if (!bubble || !bubble.ctx) return;
    const ctx = bubble.ctx;
    const w = bubble.canvas.width;
    const h = bubble.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const msg = (text || '').replace(/\s+/g, ' ').trim().slice(0, 520);
    if (!msg) {
        bubble.texture.needsUpdate = true;
        return;
    }

    const x = 20;
    const y = 20;
    const width = w - 40;
    const height = h - 62;
    const radius = 22;

    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 3;
    roundedRectPath(ctx, x, y, width, height, radius);
    ctx.fill();
    ctx.stroke();

    // Bubble tail
    ctx.beginPath();
    ctx.moveTo(w * 0.45, h - 36);
    ctx.lineTo(w * 0.5, h - 4);
    ctx.lineTo(w * 0.56, h - 36);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#1f1f1f';
    ctx.font = '500 27px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lines = wrapText(ctx, msg, width - 52, 7);
    const lineHeight = 41;
    const textY = y + (height / 2) - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, i) => {
        ctx.fillText(line, w / 2, textY + i * lineHeight);
    });

    bubble.texture.needsUpdate = true;
}

function roundedRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function wrapText(ctx, text, maxWidth, maxLines) {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    let truncated = false;

    for (const word of words) {
        const testLine = line ? `${line} ${word}` : word;
        if (ctx.measureText(testLine).width <= maxWidth) {
            line = testLine;
        } else {
            if (line) lines.push(line);
            line = word;
            if (lines.length === maxLines - 1) {
                truncated = true;
                break;
            }
        }
    }
    if (line && lines.length < maxLines && !truncated) lines.push(line);
    if (truncated && lines.length) {
        lines[lines.length - 1] = `${lines[lines.length - 1]}...`;
    }
    return lines;
}

// --- Spawn / get avatar ---

export function ensureAvatar(botName) {
    if (avatars.has(botName)) return avatars.get(botName);

    const scn = getScene();
    let useGLB = modelLoaded && !loadFailed;
    let group = null;
    if (useGLB) {
        group = createGLBAvatar(botName);
        if (!group) {
            useGLB = false;
            group = createProceduralAvatar(botName);
        }
    } else {
        group = createProceduralAvatar(botName);
    }

    console.log(`[avatars] Created avatar "${botName}" (${useGLB ? 'GLB' : 'procedural'}, children: ${group.children.length})`);

    // Start from arrival gate lane.
    const spawn = getArrivalSpawnPoint(botName);
    group.position.set(spawn.x, avatarYOffset, spawn.z);
    group.lookAt(0, avatarYOffset, 0);
    const state = createAvatarState(botName, group, {
        useGLB,
        clipMap: useGLB ? animationClips : {},
        customGlbUrl: null,
    });

    avatars.set(botName, state);
    scn.add(group);
    return state;
}

function removeAvatarInstance(botName) {
    const avatar = avatars.get(botName);
    if (!avatar) return null;
    avatars.delete(botName);
    if (avatar.group?.parent) {
        avatar.group.parent.remove(avatar.group);
    }
    return avatar;
}

function snapshotAvatarRuntime(avatar) {
    if (!avatar) return null;
    return {
        position: avatar.group.position.clone(),
        rotationY: avatar.group.rotation.y,
        targetPosition: avatar.targetPosition ? avatar.targetPosition.clone() : null,
        slotId: avatar.slotId,
        slotType: avatar.slotType,
        jamSessionId: avatar.jamSessionId,
        jamStyle: avatar.jamStyle,
        thinking: avatar.thinking,
        thinkingText: avatar.thinkingText,
        pendingStrike: avatar.pendingStrike,
        pendingAttackerName: avatar.pendingAttackerName,
    };
}

function restoreAvatarRuntime(avatar, snapshot) {
    if (!avatar || !snapshot) return;
    avatar.group.position.copy(snapshot.position);
    avatar.group.rotation.y = snapshot.rotationY;
    avatar.targetPosition = snapshot.targetPosition;
    avatar.slotId = snapshot.slotId;
    avatar.slotType = snapshot.slotType;
    avatar.jamSessionId = snapshot.jamSessionId || null;
    avatar.jamStyle = snapshot.jamStyle || null;
    avatar.pendingStrike = snapshot.pendingStrike;
    avatar.pendingAttackerName = snapshot.pendingAttackerName;
    if (snapshot.thinking && snapshot.thinkingText) {
        avatar.thinking = true;
        avatar.thinkingText = snapshot.thinkingText;
        drawThoughtBubble(avatar.thoughtBubble, snapshot.thinkingText);
        avatar.thoughtBubble.sprite.visible = true;
    }
}

async function ensureAvatarWithSource(botName, customGlbUrl, customAvatarHeight = null) {
    if (!customGlbUrl) return ensureAvatar(botName);
    const normalizedHeight = sanitizeCustomAvatarHeight(customAvatarHeight);

    const existing = avatars.get(botName);
    if (
        existing?.customGlbUrl === customGlbUrl &&
        existing?.customAvatarHeight === normalizedHeight
    ) {
        return existing;
    }

    const customData = await loadCustomAvatar(customGlbUrl);
    if (!customData) {
        return ensureAvatar(botName);
    }

    const beforeSwap = avatars.get(botName);
    if (
        beforeSwap?.customGlbUrl === customGlbUrl &&
        beforeSwap?.customAvatarHeight === normalizedHeight
    ) {
        return beforeSwap;
    }

    const snapshot = snapshotAvatarRuntime(beforeSwap);
    removeAvatarInstance(botName);

    const scn = getScene();
    let group = createCustomGLBAvatar(botName, customData, customGlbUrl, normalizedHeight);
    let useGLB = true;
    if (!group) {
        useGLB = false;
        group = createProceduralAvatar(botName);
    }

    const state = createAvatarState(botName, group, {
        useGLB,
        clipMap: useGLB ? customData.clipMap : {},
        customGlbUrl: useGLB ? customGlbUrl : null,
        customAvatarHeight: useGLB ? normalizedHeight : null,
    });

    if (snapshot) {
        restoreAvatarRuntime(state, snapshot);
    } else {
        const spawn = getArrivalSpawnPoint(botName);
        state.group.position.set(spawn.x, avatarYOffset, spawn.z);
        state.group.lookAt(0, avatarYOffset, 0);
    }

    avatars.set(botName, state);
    scn.add(group);

    if (state.slotId !== null && !state.targetPosition) {
        switchAction(state, getPlayingAnim(state));
    } else if (state.slotId === null) {
        switchAction(state, 'idle');
    }

    console.log(`[avatars] Loaded custom avatar for "${botName}" from ${customGlbUrl}`);
    return state;
}

// --- Assign avatar to a slot ---

export async function assignToSlot(botName, slotId, customGlbUrl = null, customAvatarHeight = null) {
    const avatar = customGlbUrl
        ? await ensureAvatarWithSource(botName, customGlbUrl, customAvatarHeight)
        : ensureAvatar(botName);
    const slotPos = getSlotPosition(slotId);
    if (!slotPos) return;

    avatar.slotId = slotId;
    avatar.slotType = slotPos.info.type;
    avatar.jamSessionId = null;
    avatar.jamStyle = null;

    // Target: stand in front of the instrument, facing center
    const offset = new THREE.Vector3(0, 0, 0.8);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), slotPos.rotation);
    avatar.targetPosition = slotPos.position.clone().add(offset);

    switchAction(avatar, 'walk');
}

// --- Remove avatar from slot (got overwritten) ---

export function removeFromSlot(botName) {
    const avatar = avatars.get(botName);
    if (!avatar) return;

    clearThinking(botName);
    avatar.slotId = null;
    avatar.slotType = null;

    // Return bot to deterministic queue staging lane.
    const queueSpot = getQueueRestPoint(botName);
    avatar.targetPosition = new THREE.Vector3(queueSpot.x, 0, queueSpot.z);
    switchAction(avatar, 'walk');
}

function resolveJamAnimation(avatar, style) {
    const preferred = String(style || '').trim();
    const candidates = [];
    if (preferred) candidates.push(preferred);
    if (preferred === 'chat') candidates.push('chatGesture');
    if (preferred === 'listen') candidates.push('headbob');
    // Creative activity styles fall back to expressive animations
    if (preferred === 'paint') candidates.push('chatGesture', 'dance');
    if (preferred === 'build') candidates.push('dance', 'chatGesture');
    if (preferred === 'play') candidates.push('cheer', 'dance');
    candidates.push('dance', 'headbob', 'idle');

    for (const name of candidates) {
        if (avatar.actions[name]) return name;
    }
    return 'idle';
}

function computeJamOffset(botName, index, total) {
    const ring = Math.max(1, total);
    const seed = Math.abs(botName.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0)) % 17;
    const angle = ((index + seed * 0.07) / ring) * Math.PI * 2;
    const radius = 1.4 + (seed % 4) * 0.22;
    return new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
}

export async function assignToJam(
    botName,
    jamState = {}
) {
    const {
        jamId = null,
        center = null,
        style = 'dance',
        participantIndex = 0,
        participantCount = 1,
        customGlbUrl = null,
        customAvatarHeight = null,
    } = jamState;

    const avatar = customGlbUrl
        ? await ensureAvatarWithSource(botName, customGlbUrl, customAvatarHeight)
        : ensureAvatar(botName);

    avatar.slotId = null;
    avatar.slotType = null;
    avatar.jamSessionId = jamId;
    avatar.jamStyle = style;

    const centerPos = center instanceof THREE.Vector3
        ? center
        : new THREE.Vector3(Number(center?.x) || 0, 0, Number(center?.z) || 0);
    const offset = computeJamOffset(botName, participantIndex, participantCount);
    avatar.targetPosition = centerPos.clone().add(offset);
    switchAction(avatar, 'walk');
}

export function removeFromJam(botName) {
    const avatar = avatars.get(botName);
    if (!avatar) return;
    if (avatar.slotId !== null) return;
    avatar.jamSessionId = null;
    avatar.jamStyle = null;

    const queueSpot = getQueueRestPoint(botName);
    avatar.targetPosition = new THREE.Vector3(queueSpot.x, 0, queueSpot.z);
    switchAction(avatar, 'walk');
}

// --- Creative session assignment ---

export async function assignToSession(
    botName,
    sessionState = {}
) {
    const {
        sessionId = null,
        center = null,
        style = 'dance',
        participantIndex = 0,
        participantCount = 1,
        customGlbUrl = null,
        customAvatarHeight = null,
    } = sessionState;

    const avatar = customGlbUrl
        ? await ensureAvatarWithSource(botName, customGlbUrl, customAvatarHeight)
        : ensureAvatar(botName);

    avatar.slotId = null;
    avatar.slotType = null;
    avatar.jamSessionId = sessionId;
    avatar.jamStyle = style;

    const centerPos = center instanceof THREE.Vector3
        ? center
        : new THREE.Vector3(Number(center?.x) || 0, 0, Number(center?.z) || 0);
    const offset = computeJamOffset(botName, participantIndex, participantCount);
    avatar.targetPosition = centerPos.clone().add(offset);
    switchAction(avatar, 'walk');
}

export function removeFromSession(botName) {
    const avatar = avatars.get(botName);
    if (!avatar) return;
    if (avatar.slotId !== null) return;
    avatar.jamSessionId = null;
    avatar.jamStyle = null;

    const queueSpot = getQueueRestPoint(botName);
    avatar.targetPosition = new THREE.Vector3(queueSpot.x, 0, queueSpot.z);
    switchAction(avatar, 'walk');
}

// --- Drama: overwrite sequences ---

export function playOverwriteDrama(attackerName, victimName) {
    const attacker = ensureAvatar(attackerName);
    const victim = avatars.get(victimName);
    if (!victim) return;

    // Keep only one pending attacker for this victim.
    clearPendingStrikeForVictim(victimName);
    attacker.pendingStrike = {
        victimName,
        queuedAtMs: performance.now(),
    };
    victim.pendingAttackerName = attackerName;
}

function clearPendingStrikeForVictim(victimName) {
    for (const [, avatar] of avatars) {
        if (avatar.pendingStrike?.victimName === victimName) {
            avatar.pendingStrike = null;
        }
    }
    const victim = avatars.get(victimName);
    if (victim) {
        victim.pendingAttackerName = null;
    }
}

function resolvePendingStrike(attacker, nowMs) {
    const pending = attacker.pendingStrike;
    if (!pending || attacker.drama) return;

    const victim = avatars.get(pending.victimName);
    if (!victim) {
        attacker.pendingStrike = null;
        return;
    }
    if (victim.drama) return;

    const distance = attacker.group.position.distanceTo(victim.group.position);
    const waitedMs = nowMs - pending.queuedAtMs;
    const canStrike = distance <= DRAMA_STRIKE_DISTANCE || waitedMs >= DRAMA_MAX_WAIT_MS;
    if (!canStrike) return;

    attacker.pendingStrike = null;
    victim.pendingAttackerName = null;

    // Contact-driven drama: punch + fall happen together when attacker is close.
    playDramaSequence(attacker, 'punch', () => {
        switchAction(attacker, getPlayingAnim(attacker));
    });

    playDramaSequence(victim, 'fallingDown', () => {
        setTimeout(() => {
            playDramaSequence(victim, 'gettingUp', () => {
                removeFromSlot(victim.name);
            });
        }, DRAMA_GETUP_DELAY_MS);
    });
}

function playDramaSequence(avatar, animName, onComplete) {
    if (!avatar.mixer || !avatar.actions[animName]) {
        // No animation available, skip
        if (onComplete) onComplete();
        return;
    }

    avatar.drama = animName;

    const action = avatar.actions[animName];
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;

    // Listen for when this clip finishes
    const onFinished = (e) => {
        if (e.action === action) {
            avatar.mixer.removeEventListener('finished', onFinished);
            avatar.drama = null;
            if (onComplete) onComplete();
        }
    };
    avatar.mixer.addEventListener('finished', onFinished);

    switchAction(avatar, animName);
}

// --- Get the correct playing animation for a slot type ---

function getPlayingAnim(avatar) {
    if (!avatar.slotType) return 'idle';
    const animName = SLOT_ANIM[avatar.slotType] || 'idle';
    return avatar.actions[animName] ? animName : 'idle';
}

// --- Show thinking state ---

export function setThinking(botName, text) {
    const avatar = ensureAvatar(botName);
    avatar.thinking = true;
    avatar.thinkingText = text;
    drawThoughtBubble(avatar.thoughtBubble, text);
    avatar.thoughtBubble.sprite.visible = true;
}

export function clearThinking(botName) {
    const avatar = avatars.get(botName);
    if (avatar) {
        avatar.thinking = false;
        avatar.thinkingText = '';
        if (avatar.thoughtBubble) {
            avatar.thoughtBubble.sprite.visible = false;
        }
    }
}

// --- Switch animation ---

export function switchAction(avatar, actionName) {
    if (!avatar.mixer || !avatar.actions[actionName]) return;
    if (avatar.currentAction === actionName) return;

    const current = avatar.actions[avatar.currentAction];
    const next = avatar.actions[actionName];

    // Reset loop mode for non-drama anims
    if (!['punch', 'fallingDown', 'gettingUp'].includes(actionName)) {
        next.setLoop(THREE.LoopRepeat);
        next.clampWhenFinished = false;
    }

    if (current) current.fadeOut(0.3);
    next.reset().fadeIn(0.3).play();
    avatar.currentAction = actionName;
}

// --- Update loop (called every frame) ---

export function init() {
    onUpdate((delta, elapsed) => {
        const nowMs = performance.now();
        for (const [, avatar] of avatars) {
            // Update animation mixer
            if (avatar.mixer) {
                avatar.mixer.update(delta);
            }

            // Skip movement during drama sequences
            if (avatar.drama) continue;

            // Move toward target position
            if (avatar.targetPosition) {
                const target = avatar.targetPosition.clone();
                target.y = avatarYOffset; // apply Y offset
                const dist = avatar.group.position.distanceTo(target);
                if (dist > 0.1) {
                    const dir = target.clone().sub(avatar.group.position).normalize();
                    avatar.group.position.add(dir.multiplyScalar(WALK_SPEED * delta));

                    // Face movement direction
                    avatar.group.lookAt(
                        target.x,
                        avatar.group.position.y,
                        target.z
                    );
                } else {
                    // Arrived
                    avatar.group.position.copy(target);
                    avatar.targetPosition = null;

                    // Look toward center
                    avatar.group.lookAt(0, avatar.group.position.y, 0);

                    // Switch to slot-appropriate playing animation or idle
                    if (avatar.slotId !== null) {
                        switchAction(avatar, getPlayingAnim(avatar));
                    } else if (avatar.jamSessionId) {
                        switchAction(avatar, resolveJamAnimation(avatar, avatar.jamStyle));
                    } else {
                        switchAction(avatar, 'idle');
                    }
                }
            }

            // Procedural bob (for procedural avatars without mixer)
            if (avatar.slotId !== null && !avatar.targetPosition && !avatar.mixer) {
                const bob = Math.sin(elapsed * BOB_SPEED * Math.PI * 2) * BOB_AMOUNT;
                avatar.group.position.y = avatarYOffset + bob;
            } else if (avatar.jamSessionId && !avatar.targetPosition && !avatar.mixer) {
                const bob = Math.sin(elapsed * (BOB_SPEED * 0.65) * Math.PI * 2) * (BOB_AMOUNT * 0.75);
                avatar.group.position.y = avatarYOffset + bob;
            }

            if (avatar.thinking && avatar.thoughtBubble?.sprite) {
                avatar.thoughtBubble.sprite.visible = true;
            }

            // Resolve overwrite drama after movement, so punch/fall sync at contact.
            resolvePendingStrike(avatar, nowMs);
        }
    });
}
