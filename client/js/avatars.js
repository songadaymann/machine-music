// avatars.js -- Load GLB avatar model + separate animation GLBs, clone per bot
//
// Model: /models/generic-model/generic.glb (character mesh + skeleton)
// Animations: /models/animations/*.glb (idle, walk, drums, bass, guitar, piano, punch, fallingDown, gettingUp)
// Falls back to procedural capsule avatars if loading fails.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { getSlotPosition } from './instruments.js';
import { getScene, getClock, onUpdate } from './scene.js';

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
const THOUGHT_BUBBLE_WIDTH = 2.8;
const THOUGHT_BUBBLE_HEIGHT = 1.2;
let avatarScale = 1.95;     // scale the generic model -- adjustable at runtime
let avatarYOffset = 0.1;    // Y offset for all avatars -- adjustable at runtime

// --- State ---
let templateScene = null;     // the loaded GLB scene graph (to clone)
let animationClips = {};      // { name: AnimationClip }
let modelLoaded = false;
let loadFailed = false;

const avatars = new Map();    // botName -> AvatarState

// AvatarState:
// {
//   name, group, mixer, actions, currentAction,
//   targetPosition, slotId, slotType,
//   thinking, thinkingText,
//   drama: null | 'punch' | 'fallingDown' | 'gettingUp'
// }

// --- Public API ---

export function getAvatar(botName) { return avatars.get(botName); }
export function getAllAvatars() { return avatars; }
export function getAvatarScale() { return avatarScale; }

export function setAvatarScale(scale) {
    avatarScale = scale;
    // Update template (affects future clones)
    if (templateScene) {
        templateScene.scale.setScalar(scale);
    }
    // Update all existing avatars
    for (const [, avatar] of avatars) {
        // The first child of the group is the cloned model scene
        const model = avatar.group.children[0];
        if (model && model.isObject3D) {
            model.scale.setScalar(scale);
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

        // Scale it
        templateScene.scale.setScalar(avatarScale);

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
        if (rigInfo.boneNames.length > 0) {
            console.log('[avatars] First 5 bone names:', rigInfo.boneNames.slice(0, 5));
        }

        // Build lookup sets for retargeting
        const nodeNameSet = new Set(rigInfo.nodeNames);
        // Detect if model uses "mixamorig:" prefix (with colon)
        const modelHasColon = rigInfo.boneNames.some(n => n.includes('mixamorig:'));
        console.log(`[avatars] Model bone naming: ${modelHasColon ? 'mixamorig:Xxx (colon)' : 'mixamorigXxx (no colon)'}`);

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

                    // Retarget track names to match model bone names.
                    // Issues we handle:
                    //   1. Path prefixes: "Armature/mixamorig:Hips" -> "mixamorig:Hips"
                    //   2. Colon mismatch: anim has "mixamorigHips", model has "mixamorig:Hips" (or vice versa)
                    let retargetCount = 0;
                    const unresolvedTargets = new Set();
                    for (const track of clip.tracks) {
                        const dotIdx = track.name.indexOf('.');
                        if (dotIdx === -1) continue;
                        let nodeName = track.name.substring(0, dotIdx);
                        const prop = track.name.substring(dotIdx);

                        // Strip path prefixes (e.g. "Armature/")
                        if (nodeName.includes('/')) {
                            nodeName = nodeName.split('/').pop();
                        }
                        // Strip FBX path separators (e.g. "Armature|mixamorig:Hips")
                        if (nodeName.includes('|')) {
                            nodeName = nodeName.split('|').pop();
                        }

                        // Fix colon mismatch between animation and model
                        if (!nodeNameSet.has(nodeName)) {
                            if (modelHasColon && nodeName.startsWith('mixamorig') && !nodeName.includes(':')) {
                                // Animation: "mixamorigHips" -> Model: "mixamorig:Hips"
                                nodeName = 'mixamorig:' + nodeName.substring('mixamorig'.length);
                                retargetCount++;
                            } else if (!modelHasColon && nodeName.includes('mixamorig:')) {
                                // Animation: "mixamorig:Hips" -> Model: "mixamorigHips"
                                nodeName = nodeName.replace('mixamorig:', 'mixamorig');
                                retargetCount++;
                            }
                        }

                        if (!nodeNameSet.has(nodeName)) {
                            unresolvedTargets.add(nodeName);
                        }

                        track.name = nodeName + prop;
                    }

                    if (name === 'idle') {
                        console.log(`[avatars] Retargeted ${retargetCount}/${clip.tracks.length} tracks in idle clip`);
                        const sample = clip.tracks.slice(0, 3).map(t => t.name);
                        console.log('[avatars] Sample retargeted track names:', sample);
                        if (unresolvedTargets.size > 0) {
                            console.warn(
                                `[avatars] idle clip has ${unresolvedTargets.size} unresolved track targets:`,
                                [...unresolvedTargets].slice(0, 8)
                            );
                        }
                    }

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

function createGLBAvatar(name) {
    const group = new THREE.Group();
    group.name = `avatar-${name}`;

    // SkeletonUtils.clone handles SkinnedMesh + Bone references correctly
    const clone = cloneSkeleton(templateScene);
    group.add(clone);

    addNameTag(group, name, 2.8);
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

function createThoughtBubble(yPos) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
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

    const msg = (text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!msg) {
        bubble.texture.needsUpdate = true;
        return;
    }

    const x = 16;
    const y = 16;
    const width = w - 32;
    const height = h - 52;
    const radius = 18;

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
    ctx.font = '500 30px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lines = wrapText(ctx, msg, width - 40, 3);
    const lineHeight = 34;
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

    for (const word of words) {
        const testLine = line ? `${line} ${word}` : word;
        if (ctx.measureText(testLine).width <= maxWidth) {
            line = testLine;
        } else {
            if (line) lines.push(line);
            line = word;
            if (lines.length === maxLines - 1) break;
        }
    }
    if (line && lines.length < maxLines) lines.push(line);

    if (lines.length && lines.join(' ') !== text) {
        lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, 40)}...`;
    }
    return lines;
}

// --- Spawn / get avatar ---

export function ensureAvatar(botName) {
    if (avatars.has(botName)) return avatars.get(botName);

    const scn = getScene();
    const useGLB = modelLoaded && !loadFailed;
    const group = useGLB
        ? createGLBAvatar(botName)
        : createProceduralAvatar(botName);
    const thoughtBubble = createThoughtBubble(useGLB ? 3.8 : 2.4);
    group.add(thoughtBubble.sprite);

    console.log(`[avatars] Created avatar "${botName}" (${useGLB ? 'GLB' : 'procedural'}, children: ${group.children.length})`);

    // Start off-stage
    group.position.set(0, avatarYOffset, 12);

    // Animation mixer (for GLB models)
    let mixer = null;
    const actions = {};
    if (modelLoaded && Object.keys(animationClips).length > 0) {
        mixer = new THREE.AnimationMixer(group);
        for (const [animName, clip] of Object.entries(animationClips)) {
            actions[animName] = mixer.clipAction(clip);
        }
        // Start with idle
        if (actions.idle) {
            actions.idle.play();
        }
    }

    const state = {
        name: botName,
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
    };

    avatars.set(botName, state);
    scn.add(group);
    return state;
}

// --- Assign avatar to a slot ---

export function assignToSlot(botName, slotId) {
    const avatar = ensureAvatar(botName);
    const slotPos = getSlotPosition(slotId);
    if (!slotPos) return;

    avatar.slotId = slotId;
    avatar.slotType = slotPos.info.type;

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

    avatar.slotId = null;
    avatar.slotType = null;

    // Send them back off-stage
    avatar.targetPosition = new THREE.Vector3(
        (Math.random() - 0.5) * 8,
        0,
        12 + Math.random() * 3,
    );
    switchAction(avatar, 'walk');
}

// --- Drama: overwrite sequences ---

export function playOverwriteDrama(attackerName, victimName) {
    const attacker = avatars.get(attackerName);
    const victim = avatars.get(victimName);

    // Attacker throws a punch
    if (attacker) {
        playDramaSequence(attacker, 'punch', () => {
            // After punch, go to playing animation
            const playAnim = getPlayingAnim(attacker);
            switchAction(attacker, playAnim);
        });
    }

    // Victim falls down, then gets up, then walks away
    if (victim) {
        playDramaSequence(victim, 'fallingDown', () => {
            setTimeout(() => {
                playDramaSequence(victim, 'gettingUp', () => {
                    // Now walk off-stage
                    removeFromSlot(victimName);
                });
            }, 1000);
        });
    }
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

function switchAction(avatar, actionName) {
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
                    } else {
                        switchAction(avatar, 'idle');
                    }
                }
            }

            // Procedural bob (for procedural avatars without mixer)
            if (avatar.slotId !== null && !avatar.targetPosition && !avatar.mixer) {
                const bob = Math.sin(elapsed * BOB_SPEED * Math.PI * 2) * BOB_AMOUNT;
                avatar.group.position.y = avatarYOffset + bob;
            }

            if (avatar.thinking && avatar.thoughtBubble?.sprite) {
                avatar.thoughtBubble.sprite.visible = true;
            }
        }
    });
}
