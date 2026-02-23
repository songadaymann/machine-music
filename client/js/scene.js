// scene.js -- Void scene with fly/orbit camera controls and post-processing pipeline.
// Agents populate this space via world contributions, visual sessions, etc.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    EffectComposer, EffectPass, RenderPass, Effect,
    BloomEffect, SMAAEffect, ToneMappingEffect,
    SMAAPreset, ToneMappingMode, BlendFunction,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import * as environment from './environment.js';
import * as interaction from './interaction.js';

let renderer, scene, camera, controls;
let composer = null;
let n8aoPass = null;
let retroEffect = null;
let retroEffectPass = null;
let clock;
let canvasEl = null;
let retroFxEnabled = true;
let aoEnabled = true;

const updateCallbacks = [];
const cameraModeListeners = new Set();
const environmentModeListeners = new Set();

const ENVIRONMENT_MODE = 'void';
let cameraMode = 'orbit'; // orbit | fly

const flyKeys = new Set();
let flyYaw = 0;
let flyPitch = 0;

const FLY_LOOK_SENSITIVITY = 0.0022;
const FLY_MOVE_SPEED = 22;
const FLY_BOOST_MULTIPLIER = 2.1;
const FLY_MIN_Y = 0.7;
const FLY_MAX_Y = 74;

const VEC_FORWARD = new THREE.Vector3();
const VEC_RIGHT = new THREE.Vector3();
const VEC_UP = new THREE.Vector3();
const VEC_MOVE = new THREE.Vector3();

// --- Public API ---

export function getScene() { return scene; }
export function getCamera() { return camera; }
export function getRenderer() { return renderer; }
export function getComposer() { return composer; }
export function getClock() { return clock; }
export function getCameraMode() { return cameraMode; }
export function canUseFlyMode() { return !isTouchLikeDevice(); }
export function getEnvironmentMode() { return ENVIRONMENT_MODE; }
export function getRoomForPosition(_x, _z) {
    return 'void';
}
export function getCameraRoom() {
    return 'void';
}

export function onCameraModeChange(fn) {
    cameraModeListeners.add(fn);
    return () => cameraModeListeners.delete(fn);
}

export function onEnvironmentModeChange(fn) {
    environmentModeListeners.add(fn);
    return () => environmentModeListeners.delete(fn);
}

export function setEnvironmentMode() {
    emitEnvironmentModeChange();
    return ENVIRONMENT_MODE;
}

export function toggleEnvironmentMode() {
    emitEnvironmentModeChange();
    return ENVIRONMENT_MODE;
}

export function setCameraMode(nextMode) {
    if (!controls || !camera) return cameraMode;

    const requested = nextMode === 'fly' ? 'fly' : 'orbit';
    if (requested === 'fly' && !canUseFlyMode()) {
        cameraMode = 'orbit';
        emitCameraModeChange();
        return cameraMode;
    }

    if (cameraMode === requested) return cameraMode;

    cameraMode = requested;
    if (cameraMode === 'fly') {
        controls.enabled = false;
        controls.autoRotate = false;
        syncFlyAnglesFromCamera();
        if (canvasEl) canvasEl.style.cursor = 'crosshair';
    } else {
        controls.enabled = true;
        controls.autoRotate = false;
        const lookDir = new THREE.Vector3();
        camera.getWorldDirection(lookDir);
        controls.target.copy(camera.position).addScaledVector(lookDir, 10);
        controls.update();
        if (document.pointerLockElement === canvasEl) {
            document.exitPointerLock?.();
        }
        if (canvasEl) canvasEl.style.cursor = 'grab';
    }

    emitCameraModeChange();
    return cameraMode;
}

export function toggleCameraMode() {
    return setCameraMode(cameraMode === 'orbit' ? 'fly' : 'orbit');
}

export function onUpdate(fn) {
    updateCallbacks.push(fn);
}

// --- Init ---

export function init(canvas) {
    clock = new THREE.Clock();
    canvasEl = canvas;

    renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false, // SMAA handles anti-aliasing in post
        alpha: false,
        powerPreference: 'high-performance',
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Tone mapping handled by ToneMappingEffect in post-processing
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 800);
    camera.position.set(0, 12, 40);
    camera.lookAt(0, 0, 0);
    syncFlyAnglesFromCamera();

    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 0, 0);
    controls.minDistance = 3;
    controls.maxDistance = 500;
    controls.maxPolarAngle = Math.PI / 2.01;
    controls.autoRotate = false;

    addVoidLights();
    scene.add(buildGroundPlane());

    // Environment: procedural sky gradient + IBL reflections on all PBR materials
    environment.init(scene, renderer, 'void');

    setupPostProcessing();
    installToggles();

    window.addEventListener('resize', onResize);
    bindInputListeners();
    installVirtualControllerBridge();
    setCameraMode('fly');
    emitEnvironmentModeChange();

    animate();
}

function addVoidLights() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 0.3);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(20, 30, 20);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 4096;
    keyLight.shadow.mapSize.height = 4096;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 200;
    keyLight.shadow.camera.left = -60;
    keyLight.shadow.camera.right = 60;
    keyLight.shadow.camera.top = 60;
    keyLight.shadow.camera.bottom = -60;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xd0d8ff, 0.4);
    fillLight.position.set(-15, 20, -10);
    scene.add(fillLight);
}

function buildGroundPlane() {
    const group = new THREE.Group();
    group.name = 'void-ground';

    // Layer 1: Shadow-receiving base plane (MeshStandardMaterial)
    const basePlane = new THREE.Mesh(
        new THREE.PlaneGeometry(600, 600),
        new THREE.MeshStandardMaterial({
            color: 0xe8e8e8,
            roughness: 0.95,
            metalness: 0.0,
        })
    );
    basePlane.rotation.x = -Math.PI / 2;
    basePlane.receiveShadow = true;
    basePlane.name = 'void-ground-base';
    group.add(basePlane);

    // Layer 2: Transparent grid overlay (ShaderMaterial)
    const gridUniforms = {
        cameraPos: { value: new THREE.Vector3() },
        gridColor: { value: new THREE.Color(0x888888) },
        fadeDist: { value: 150.0 },
    };

    const gridPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(600, 600),
        new THREE.ShaderMaterial({
            uniforms: gridUniforms,
            transparent: true,
            depthWrite: false,
            vertexShader: /* glsl */`
                varying vec3 vWorldPos;
                void main() {
                    vec4 worldPos = modelMatrix * vec4(position, 1.0);
                    vWorldPos = worldPos.xyz;
                    gl_Position = projectionMatrix * viewMatrix * worldPos;
                }
            `,
            fragmentShader: /* glsl */`
                uniform vec3 cameraPos;
                uniform vec3 gridColor;
                uniform float fadeDist;
                varying vec3 vWorldPos;

                float gridLine(float coord, float lineWidth) {
                    float d = abs(fract(coord - 0.5) - 0.5);
                    return 1.0 - smoothstep(0.0, lineWidth, d);
                }

                void main() {
                    float dist = distance(vWorldPos.xz, cameraPos.xz);
                    float fade = 1.0 - smoothstep(fadeDist * 0.5, fadeDist, dist);

                    // Fine grid (1-unit)
                    float fineX = gridLine(vWorldPos.x, 0.04);
                    float fineZ = gridLine(vWorldPos.z, 0.04);
                    float fine = max(fineX, fineZ) * 0.25;

                    // Coarse grid (10-unit)
                    float coarseX = gridLine(vWorldPos.x * 0.1, 0.03);
                    float coarseZ = gridLine(vWorldPos.z * 0.1, 0.03);
                    float coarse = max(coarseX, coarseZ) * 0.5;

                    float line = max(fine, coarse) * fade;
                    if (line < 0.01) discard;

                    gl_FragColor = vec4(gridColor, line);
                }
            `,
        })
    );
    gridPlane.rotation.x = -Math.PI / 2;
    gridPlane.position.y = 0.005; // Slight offset to prevent z-fighting
    gridPlane.name = 'void-ground-grid';
    group.add(gridPlane);

    // Update camera position uniform each frame for distance-based fade
    onUpdate(() => {
        if (camera) {
            gridUniforms.cameraPos.value.copy(camera.position);
        }
    });

    return group;
}

// --- Parcel overlay ---

let parcelOverlayGroup = null;

export function setParcelOverlay(parcelSnapshot) {
    if (parcelOverlayGroup) {
        scene.remove(parcelOverlayGroup);
        parcelOverlayGroup = null;
    }
    if (!parcelSnapshot) return;

    parcelOverlayGroup = new THREE.Group();
    parcelOverlayGroup.name = 'parcel-overlay';

    const Y = 0.02;

    // Town square ring
    const sq = parcelSnapshot.townSquare;
    if (sq) {
        const segments = 64;
        const points = [];
        for (let i = 0; i <= segments; i++) {
            const a = (i / segments) * Math.PI * 2;
            points.push(new THREE.Vector3(
                Math.cos(a) * sq.radius + sq.center.x,
                Y,
                Math.sin(a) * sq.radius + sq.center.z
            ));
        }
        const sqGeo = new THREE.BufferGeometry().setFromPoints(points);
        const sqLine = new THREE.Line(sqGeo, new THREE.LineBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.5 }));
        sqLine.name = 'town-square-ring';
        parcelOverlayGroup.add(sqLine);
    }

    // Parcel boundaries
    const TIER_COLORS = { premium: 0xff6644, standard: 0x44aaff, free: 0x66ff88 };
    for (const parcel of parcelSnapshot.parcels) {
        const b = parcel.bounds;
        const color = TIER_COLORS[parcel.tier] ?? 0x888888;
        const opacity = parcel.owner ? 0.4 : 0.15;

        const corners = [
            new THREE.Vector3(b.minX, Y, b.minZ),
            new THREE.Vector3(b.maxX, Y, b.minZ),
            new THREE.Vector3(b.maxX, Y, b.maxZ),
            new THREE.Vector3(b.minX, Y, b.maxZ),
            new THREE.Vector3(b.minX, Y, b.minZ), // close loop
        ];
        const geo = new THREE.BufferGeometry().setFromPoints(corners);
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
        line.name = `parcel-${parcel.id}`;
        parcelOverlayGroup.add(line);
    }

    scene.add(parcelOverlayGroup);
}

// --- Post-processing pipeline (pmndrs/postprocessing + n8ao) ---

function setupPostProcessing() {
    if (!renderer || !scene || !camera) return;

    const w = window.innerWidth;
    const h = window.innerHeight;

    composer = new EffectComposer(renderer, {
        frameBufferType: THREE.HalfFloatType,
    });

    // Pass 1: Base render
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    // Pass 2: Ambient Occlusion (n8ao)
    try {
        n8aoPass = new N8AOPostPass(scene, camera, w, h);
        n8aoPass.configuration.halfRes = true;
        n8aoPass.configuration.screenSpaceRadius = true;
        n8aoPass.configuration.aoRadius = 64;
        n8aoPass.configuration.distanceFalloff = 0.3;
        n8aoPass.configuration.intensity = 1.0;
        composer.addPass(n8aoPass);
        console.log('[scene] N8AO ambient occlusion enabled');
    } catch (err) {
        console.warn('[scene] N8AO failed to initialize:', err.message);
        n8aoPass = null;
    }

    // Pass 3: Effects (bloom + SMAA + tone mapping)
    const bloom = new BloomEffect({
        blendFunction: BlendFunction.ADD,
        mipmapBlur: true,
        luminanceThreshold: 1.0,
        luminanceSmoothing: 0.3,
        intensity: 0.5,
    });

    const smaa = new SMAAEffect({ preset: SMAAPreset.ULTRA });

    const toneMapping = new ToneMappingEffect({
        mode: ToneMappingMode.ACES_FILMIC,
    });

    const mainEffectPass = new EffectPass(camera, bloom, smaa, toneMapping);
    composer.addPass(mainEffectPass);

    // Pass 4: Retro dither (optional, toggleable)
    retroEffect = new RetroDitherEffect();
    retroEffectPass = new EffectPass(camera, retroEffect);
    retroEffectPass.enabled = retroFxEnabled;
    composer.addPass(retroEffectPass);

    console.log('[scene] Post-processing pipeline ready (bloom, SMAA, ACES, retro dither)');
}

function installToggles() {
    window.DEBUG = window.DEBUG || {};
    window.DEBUG.toggleRetroFx = () => {
        retroFxEnabled = !retroFxEnabled;
        if (retroEffectPass) retroEffectPass.enabled = retroFxEnabled;
        console.info(`[scene] Retro FX ${retroFxEnabled ? 'enabled' : 'disabled'}`);
        return retroFxEnabled;
    };
    window.DEBUG.toggleAO = () => {
        aoEnabled = !aoEnabled;
        if (n8aoPass) n8aoPass.enabled = aoEnabled;
        console.info(`[scene] Ambient Occlusion ${aoEnabled ? 'enabled' : 'disabled'}`);
        return aoEnabled;
    };
}

function onResize() {
    if (!camera || !renderer) return;

    const w = window.innerWidth;
    const h = window.innerHeight;

    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);

    if (composer) {
        composer.setSize(w, h);
    }
}

function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    const elapsed = clock.getElapsedTime();

    if (cameraMode === 'fly') {
        updateFlyMovement(delta);
    } else {
        controls.update();
    }

    for (const fn of updateCallbacks) {
        try {
            fn(delta, elapsed);
        } catch (e) {
            console.error('[scene] update error:', e);
        }
    }

    // Update interaction hover highlights
    interaction.update(delta, elapsed);

    // Update retro shader time uniform
    if (retroEffect) {
        retroEffect.time = elapsed;
    }

    // Always render through the composer — passes are toggled individually
    if (composer) {
        composer.render(delta);
    } else {
        renderer.render(scene, camera);
    }
}

// --- Retro Dither Effect (pmndrs/postprocessing Effect subclass) ---

class RetroDitherEffect extends Effect {
    constructor() {
        super('RetroDitherEffect', retroDitherFragment, {
            uniforms: new Map([
                ['resolution', new THREE.Uniform(new THREE.Vector2(window.innerWidth, window.innerHeight))],
                ['time', new THREE.Uniform(0)],
                ['pixelSize', new THREE.Uniform(1.75)],
                ['colorLevels', new THREE.Uniform(26.0)],
                ['ditherStrength', new THREE.Uniform(0.58)],
                ['scanlineStrength', new THREE.Uniform(0.018)],
                ['vignetteStrength', new THREE.Uniform(0.035)],
                ['brightness', new THREE.Uniform(1.32)],
                ['saturation', new THREE.Uniform(0.9)],
            ]),
        });
    }

    get time() {
        return this.uniforms.get('time').value;
    }
    set time(value) {
        this.uniforms.get('time').value = value;
    }

    update(_renderer, _inputBuffer, _deltaTime) {
        const res = this.uniforms.get('resolution');
        res.value.set(window.innerWidth, window.innerHeight);
    }
}

const retroDitherFragment = /* glsl */`
    uniform vec2 resolution;
    uniform float time;
    uniform float pixelSize;
    uniform float colorLevels;
    uniform float ditherStrength;
    uniform float scanlineStrength;
    uniform float vignetteStrength;
    uniform float brightness;
    uniform float saturation;

    float bayer4(vec2 p) {
        vec2 fc = mod(floor(p), 4.0);
        float idx = fc.x + fc.y * 4.0;

        if (idx < 0.5) return 0.0 / 16.0;
        if (idx < 1.5) return 8.0 / 16.0;
        if (idx < 2.5) return 2.0 / 16.0;
        if (idx < 3.5) return 10.0 / 16.0;

        if (idx < 4.5) return 12.0 / 16.0;
        if (idx < 5.5) return 4.0 / 16.0;
        if (idx < 6.5) return 14.0 / 16.0;
        if (idx < 7.5) return 6.0 / 16.0;

        if (idx < 8.5) return 3.0 / 16.0;
        if (idx < 9.5) return 11.0 / 16.0;
        if (idx < 10.5) return 1.0 / 16.0;
        if (idx < 11.5) return 9.0 / 16.0;

        if (idx < 12.5) return 15.0 / 16.0;
        if (idx < 13.5) return 7.0 / 16.0;
        if (idx < 14.5) return 13.0 / 16.0;
        return 5.0 / 16.0;
    }

    void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec2 pixelStep = max(vec2(1.0), vec2(pixelSize));
        vec2 snappedUv = floor(uv * resolution / pixelStep) * pixelStep / resolution;

        vec3 color = texture2D(inputBuffer, snappedUv).rgb;
        color *= brightness;
        color = clamp(color, 0.0, 1.0);
        float luma = dot(color, vec3(0.299, 0.587, 0.114));
        color = mix(vec3(luma), color, saturation);

        float threshold = bayer4(gl_FragCoord.xy) - 0.5;
        color = floor(color * colorLevels + threshold * ditherStrength) / colorLevels;
        color = clamp(color, 0.0, 1.0);

        float scan = sin((snappedUv.y * resolution.y + time * 75.0) * 0.92) * 0.5 + 0.5;
        color *= 1.0 - scanlineStrength * scan;

        float dist = distance(uv, vec2(0.5));
        float vignette = 1.0 - smoothstep(0.34, 0.84, dist);
        color *= mix(1.0 - vignetteStrength, 1.0, vignette);

        outputColor = vec4(color, inputColor.a);
    }
`;

// --- Input ---

function bindInputListeners() {
    window.addEventListener('keydown', (event) => {
        if (event.defaultPrevented) return;
        const target = event.target;
        const tag = target && typeof target.tagName === 'string'
            ? target.tagName.toLowerCase()
            : '';
        const typingInField = tag === 'input' || tag === 'textarea' || target?.isContentEditable;
        if (typingInField) return;
        flyKeys.add(event.code);
    });

    window.addEventListener('keyup', (event) => {
        flyKeys.delete(event.code);
    });

    document.addEventListener('mousemove', (event) => {
        if (cameraMode !== 'fly') return;
        if (document.pointerLockElement !== canvasEl) return;

        flyYaw -= event.movementX * FLY_LOOK_SENSITIVITY;
        flyPitch -= event.movementY * FLY_LOOK_SENSITIVITY;
        const pitchLimit = Math.PI / 2 - 0.02;
        flyPitch = Math.max(-pitchLimit, Math.min(pitchLimit, flyPitch));
        applyFlyOrientation();
    });

    if (canvasEl) {
        canvasEl.addEventListener('click', () => {
            if (cameraMode !== 'fly') return;
            if (document.pointerLockElement === canvasEl) return;
            canvasEl.requestPointerLock?.();
        });
    }

    document.addEventListener('pointerlockchange', () => {
        if (!canvasEl) return;
        if (cameraMode !== 'fly') {
            canvasEl.classList.remove('fly-locked');
            return;
        }
        const locked = document.pointerLockElement === canvasEl;
        canvasEl.classList.toggle('fly-locked', locked);
    });
}

function updateFlyMovement(delta) {
    if (!camera) return;

    const forwardAxis =
        Number(flyKeys.has('KeyW') || flyKeys.has('ArrowUp')) -
        Number(flyKeys.has('KeyS') || flyKeys.has('ArrowDown'));
    const strafeAxis =
        Number(flyKeys.has('KeyD') || flyKeys.has('ArrowRight')) -
        Number(flyKeys.has('KeyA') || flyKeys.has('ArrowLeft'));
    const verticalAxis =
        Number(flyKeys.has('KeyE') || flyKeys.has('Space')) -
        Number(flyKeys.has('KeyQ') || flyKeys.has('ShiftLeft') || flyKeys.has('ShiftRight'));

    VEC_MOVE.set(0, 0, 0);
    camera.getWorldDirection(VEC_FORWARD).normalize();
    VEC_RIGHT.crossVectors(VEC_FORWARD, camera.up).normalize();
    VEC_UP.copy(camera.up).normalize();

    if (forwardAxis !== 0) VEC_MOVE.addScaledVector(VEC_FORWARD, forwardAxis);
    if (strafeAxis !== 0) VEC_MOVE.addScaledVector(VEC_RIGHT, strafeAxis);
    if (verticalAxis !== 0) VEC_MOVE.addScaledVector(VEC_UP, verticalAxis);

    if (VEC_MOVE.lengthSq() < 0.0001) return;
    VEC_MOVE.normalize();

    const boosted = flyKeys.has('ControlLeft') || flyKeys.has('ControlRight');
    const speed = FLY_MOVE_SPEED * (boosted ? FLY_BOOST_MULTIPLIER : 1);
    camera.position.addScaledVector(VEC_MOVE, speed * delta);
    camera.position.y = Math.min(FLY_MAX_Y, Math.max(FLY_MIN_Y, camera.position.y));
}

function syncFlyAnglesFromCamera() {
    if (!camera) return;
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    flyPitch = euler.x;
    flyYaw = euler.y;
}

function applyFlyOrientation() {
    if (!camera) return;
    const euler = new THREE.Euler(flyPitch, flyYaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(euler);
}

function emitCameraModeChange() {
    for (const fn of cameraModeListeners) {
        try {
            fn(cameraMode);
        } catch (err) {
            console.error('[scene] cameraMode listener error:', err);
        }
    }
}

function emitEnvironmentModeChange() {
    for (const fn of environmentModeListeners) {
        try {
            fn(ENVIRONMENT_MODE);
        } catch (err) {
            console.error('[scene] environmentMode listener error:', err);
        }
    }
}

function isTouchLikeDevice() {
    return window.matchMedia?.('(pointer: coarse)')?.matches || 'ontouchstart' in window;
}

function installVirtualControllerBridge() {
    if (window.__musicPlaceVirtualControllerBridgeInstalled) return;
    window.__musicPlaceVirtualControllerBridgeInstalled = true;

    window.addEventListener('message', (event) => {
        const { type, key, eventType } = event.data || {};
        if (type !== 'keyEvent' || !key || !eventType) return;
        if (eventType !== 'keydown' && eventType !== 'keyup') return;

        document.dispatchEvent(new KeyboardEvent(eventType, {
            key,
            code: key,
            bubbles: true,
            cancelable: true,
        }));
    });
}
