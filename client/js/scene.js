// scene.js -- Blank void scene with fly/orbit camera controls.
// Agents populate this space via world contributions, visual sessions, etc.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

let renderer, scene, camera, controls;
let composer = null;
let retroPass = null;
let clock;
let canvasEl = null;
let retroFxEnabled = true;

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
        antialias: true,
        alpha: false,
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.38;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0f0f0);

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

    setupRetroPostprocess();
    installRetroFxToggle();

    window.addEventListener('resize', onResize);
    bindInputListeners();
    installVirtualControllerBridge();
    setCameraMode('fly');
    emitEnvironmentModeChange();

    animate();
}

function addVoidLights() {
    const ambient = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 0.6);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(20, 30, 20);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 300;
    keyLight.shadow.camera.left = -120;
    keyLight.shadow.camera.right = 120;
    keyLight.shadow.camera.top = 120;
    keyLight.shadow.camera.bottom = -120;
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xd0d8ff, 0.4);
    fillLight.position.set(-15, 20, -10);
    scene.add(fillLight);
}

function buildGroundPlane() {
    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(600, 600),
        new THREE.MeshStandardMaterial({
            color: 0xe8e8e8,
            roughness: 0.9,
            metalness: 0.0,
        })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'void-ground';
    return ground;
}

function setupRetroPostprocess() {
    if (!renderer || !scene || !camera) return;

    composer = new EffectComposer(renderer);
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    composer.setSize(window.innerWidth, window.innerHeight);

    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    retroPass = new ShaderPass(createRetroDitherShader());
    retroPass.uniforms.resolution.value.set(window.innerWidth, window.innerHeight);
    composer.addPass(retroPass);
}

function createRetroDitherShader() {
    return {
        uniforms: {
            tDiffuse: { value: null },
            resolution: { value: new THREE.Vector2(1, 1) },
            time: { value: 0 },
            pixelSize: { value: 1.75 },
            colorLevels: { value: 26 },
            ditherStrength: { value: 0.58 },
            scanlineStrength: { value: 0.018 },
            vignetteStrength: { value: 0.035 },
            brightness: { value: 1.32 },
            saturation: { value: 0.9 },
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D tDiffuse;
            uniform vec2 resolution;
            uniform float time;
            uniform float pixelSize;
            uniform float colorLevels;
            uniform float ditherStrength;
            uniform float scanlineStrength;
            uniform float vignetteStrength;
            uniform float brightness;
            uniform float saturation;

            varying vec2 vUv;

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

            void main() {
                vec2 pixelStep = max(vec2(1.0), vec2(pixelSize));
                vec2 uv = floor(vUv * resolution / pixelStep) * pixelStep / resolution;

                vec3 color = texture2D(tDiffuse, uv).rgb;
                color *= brightness;
                color = clamp(color, 0.0, 1.0);
                float luma = dot(color, vec3(0.299, 0.587, 0.114));
                color = mix(vec3(luma), color, saturation);

                float threshold = bayer4(gl_FragCoord.xy) - 0.5;
                color = floor(color * colorLevels + threshold * ditherStrength) / colorLevels;
                color = clamp(color, 0.0, 1.0);

                float scan = sin((uv.y * resolution.y + time * 75.0) * 0.92) * 0.5 + 0.5;
                color *= 1.0 - scanlineStrength * scan;

                float dist = distance(vUv, vec2(0.5));
                float vignette = 1.0 - smoothstep(0.34, 0.84, dist);
                color *= mix(1.0 - vignetteStrength, 1.0, vignette);

                gl_FragColor = vec4(color, 1.0);
            }
        `,
    };
}

function installRetroFxToggle() {
    window.toggleRetroFx = () => {
        retroFxEnabled = !retroFxEnabled;
        console.info(`[scene] Retro FX ${retroFxEnabled ? 'enabled' : 'disabled'}`);
        return retroFxEnabled;
    };
}

function onResize() {
    if (!camera || !renderer) return;

    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);

    if (composer) {
        composer.setSize(window.innerWidth, window.innerHeight);
    }
    if (retroPass) {
        retroPass.uniforms.resolution.value.set(window.innerWidth, window.innerHeight);
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

    if (retroPass) {
        retroPass.uniforms.time.value = elapsed;
    }

    if (retroFxEnabled && composer) {
        composer.render();
    } else {
        renderer.render(scene, camera);
    }
}

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
