// scene-generative-arena.js -- Archived procedural indoor arena baseline for future reuse.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let renderer, scene, camera, controls;
let clock;
let canvasEl = null;
const updateCallbacks = [];
const cameraModeListeners = new Set();
const environmentModeListeners = new Set();

const ENVIRONMENT_MODE = 'indoor_arena';
let cameraMode = 'orbit'; // orbit | fly

const ARENA = Object.freeze({
    floorWidth: 34,
    floorDepth: 24,
    edgeGap: 2.2,
    lowerRows: 14,
    upperRows: 12,
    tierRise: 0.34,
    tierDepth: 0.52,
    upperTierY: 6.7,
    upperTierZ: 7.2,
    standWidthLong: 44,
    standWidthShort: 30,
    wallHeight: 18,
    ceilingY: 20.5,
});

const flyKeys = new Set();
let flyYaw = 0;
let flyPitch = 0;
const FLY_LOOK_SENSITIVITY = 0.0022;
const FLY_MOVE_SPEED = 8.5;
const FLY_BOOST_MULTIPLIER = 2.1;
const FLY_MIN_Y = 0.65;
const FLY_MAX_Y = 54;

const VEC_FORWARD = new THREE.Vector3();
const VEC_RIGHT = new THREE.Vector3();
const VEC_UP = new THREE.Vector3();
const VEC_MOVE = new THREE.Vector3();

const TMP_VEC = new THREE.Vector3();
const TMP_SCALE = new THREE.Vector3();
const TMP_QUAT = new THREE.Quaternion();
const TMP_MATRIX = new THREE.Matrix4();
const TMP_COLOR = new THREE.Color();
const SCALE_AVATAR_PATH = '/models/animations/idle.glb';
const scaleAvatarLoader = new GLTFLoader();

// --- Public API ---

export function getScene() { return scene; }
export function getCamera() { return camera; }
export function getRenderer() { return renderer; }
export function getClock() { return clock; }
export function getCameraMode() { return cameraMode; }
export function canUseFlyMode() { return !isTouchLikeDevice(); }
export function getEnvironmentMode() { return ENVIRONMENT_MODE; }

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
    renderer.toneMappingExposure = 1.08;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x10131a);
    scene.fog = new THREE.FogExp2(0x10131a, 0.0045);

    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 260);
    camera.position.set(0, 11.8, 31.5);
    camera.lookAt(0, 3.8, 0);
    syncFlyAnglesFromCamera();

    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 3.8, 0);
    controls.minDistance = 4;
    controls.maxDistance = 86;
    controls.maxPolarAngle = Math.PI / 2.01;
    controls.autoRotate = false;

    addArenaLights();
    scene.add(buildArenaInterior());

    window.addEventListener('resize', onResize);
    bindInputListeners();
    installVirtualControllerBridge();
    setCameraMode('orbit');

    animate();
}

function getArenaExtents() {
    const standDepth = ARENA.upperTierZ + ARENA.upperRows * ARENA.tierDepth + 2.8;
    return {
        halfX: ARENA.floorWidth * 0.5 + ARENA.edgeGap + standDepth + 2.5,
        halfZ: ARENA.floorDepth * 0.5 + ARENA.edgeGap + standDepth + 2.5,
    };
}

function addArenaLights() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.32);
    scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0xb7c0d0, 0x0f1016, 0.24);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.72);
    keyLight.position.set(12, 18, 10);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 90;
    keyLight.shadow.camera.left = -36;
    keyLight.shadow.camera.right = 36;
    keyLight.shadow.camera.top = 30;
    keyLight.shadow.camera.bottom = -30;
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x9ca7b8, 0.22);
    fillLight.position.set(-14, 10, -10);
    scene.add(fillLight);
}

function buildArenaInterior() {
    const group = new THREE.Group();
    group.name = 'procedural-indoor-arena';

    addArenaFloor(group);
    addScaleAvatar(group);
    addFloorRailings(group);
    addSeatingBowl(group);
    addPerimeterWalls(group);
    addCeilingStructure(group);
    addSpeakerClusters(group);

    return group;
}

function addScaleAvatar(group) {
    const anchor = new THREE.Group();
    anchor.name = 'scale-avatar';
    anchor.position.set(0, 0, 0);
    group.add(anchor);

    const base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.6, 0.08, 24),
        new THREE.MeshStandardMaterial({
            color: 0x6a6f79,
            roughness: 0.72,
            metalness: 0.22,
        })
    );
    base.position.y = 0.06;
    base.receiveShadow = true;
    anchor.add(base);

    const fallback = createFallbackScaleAvatar();
    anchor.add(fallback);

    scaleAvatarLoader.load(
        SCALE_AVATAR_PATH,
        (gltf) => {
            const model = gltf.scene.clone(true);
            model.traverse((child) => {
                if (!child.isMesh) return;
                child.castShadow = true;
                child.receiveShadow = true;
            });

            normalizeModelHeight(model, 1.85);
            model.updateMatrixWorld(true);

            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            model.position.x -= center.x;
            model.position.z -= center.z;
            model.position.y -= box.min.y;

            if (fallback.parent) fallback.parent.remove(fallback);
            anchor.add(model);
            console.info(`[scene] Scale avatar loaded from ${SCALE_AVATAR_PATH}`);
        },
        undefined,
        (error) => {
            console.warn(`[scene] Scale avatar GLB load failed (${SCALE_AVATAR_PATH}), keeping fallback`, error);
        }
    );
}

function normalizeModelHeight(object3D, targetHeight) {
    object3D.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object3D);
    const height = box.max.y - box.min.y;
    if (!Number.isFinite(height) || height <= 0) return;

    const scale = THREE.MathUtils.clamp(targetHeight / height, 0.25, 4.0);
    object3D.scale.setScalar(scale);
    object3D.updateMatrixWorld(true);
}

function createFallbackScaleAvatar() {
    const avatar = new THREE.Group();
    avatar.name = 'scale-avatar-fallback';

    const bodyMat = new THREE.MeshStandardMaterial({
        color: 0x8b93a0,
        roughness: 0.62,
        metalness: 0.18,
    });
    const darkMat = new THREE.MeshStandardMaterial({
        color: 0x2f343e,
        roughness: 0.72,
        metalness: 0.12,
    });

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.62, 14), bodyMat);
    torso.position.y = 1.14;
    torso.castShadow = true;
    avatar.add(torso);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 12), bodyMat);
    head.position.y = 1.56;
    head.castShadow = true;
    avatar.add(head);

    const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.46, 8), darkMat);
    armL.position.set(-0.28, 1.16, 0);
    armL.rotation.z = 0.15;
    armL.castShadow = true;
    avatar.add(armL);

    const armR = armL.clone();
    armR.position.x = 0.28;
    armR.rotation.z = -0.15;
    avatar.add(armR);

    const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.52, 8), darkMat);
    legL.position.set(-0.1, 0.52, 0);
    legL.castShadow = true;
    avatar.add(legL);

    const legR = legL.clone();
    legR.position.x = 0.1;
    avatar.add(legR);

    const footGeo = new THREE.BoxGeometry(0.16, 0.07, 0.3);
    const footL = new THREE.Mesh(footGeo, darkMat);
    footL.position.set(-0.1, 0.225, 0.08);
    footL.castShadow = true;
    footL.receiveShadow = true;
    avatar.add(footL);

    const footR = footL.clone();
    footR.position.x = 0.1;
    avatar.add(footR);

    return avatar;
}

function addArenaFloor(group) {
    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(ARENA.floorWidth, ARENA.floorDepth),
        new THREE.MeshStandardMaterial({
            color: 0xd9dce2,
            roughness: 0.86,
            metalness: 0.02,
        })
    );
    floor.rotation.x = -Math.PI / 2;
    // Keep the main floor slightly above surrounding slabs to avoid z-fighting.
    floor.position.y = 0.02;
    floor.receiveShadow = true;
    group.add(floor);

    const border = new THREE.Mesh(
        new THREE.BoxGeometry(ARENA.floorWidth + 3.2, 0.28, ARENA.floorDepth + 3.2),
        new THREE.MeshStandardMaterial({
            color: 0x1d1f26,
            roughness: 0.9,
            metalness: 0.05,
        })
    );
    border.position.y = -0.16;
    border.receiveShadow = true;
    group.add(border);
}

function addFloorRailings(group) {
    const railMat = new THREE.MeshStandardMaterial({
        color: 0x838892,
        roughness: 0.28,
        metalness: 0.72,
    });
    const panelMat = new THREE.MeshStandardMaterial({
        color: 0xa6adb9,
        roughness: 0.12,
        metalness: 0.18,
        transparent: true,
        opacity: 0.2,
    });

    const topY = 1.12;
    const panelY = 0.58;
    const halfW = ARENA.floorWidth * 0.5 + 0.3;
    const halfD = ARENA.floorDepth * 0.5 + 0.3;

    const rails = [
        { sx: ARENA.floorWidth + 0.6, sz: 0.08, x: 0, z: halfD },
        { sx: ARENA.floorWidth + 0.6, sz: 0.08, x: 0, z: -halfD },
        { sx: 0.08, sz: ARENA.floorDepth + 0.6, x: halfW, z: 0 },
        { sx: 0.08, sz: ARENA.floorDepth + 0.6, x: -halfW, z: 0 },
    ];

    for (const rail of rails) {
        const top = new THREE.Mesh(
            new THREE.BoxGeometry(rail.sx, 0.06, rail.sz),
            railMat
        );
        top.position.set(rail.x, topY, rail.z);
        top.castShadow = true;
        group.add(top);

        const panel = new THREE.Mesh(
            new THREE.BoxGeometry(rail.sx, 1.0, rail.sz),
            panelMat
        );
        panel.position.set(rail.x, panelY, rail.z);
        group.add(panel);
    }
}

function addSeatingBowl(group) {
    const sections = [
        { x: 0, z: -ARENA.floorDepth * 0.5 - ARENA.edgeGap, rotY: Math.PI, width: ARENA.standWidthLong },
        { x: 0, z: ARENA.floorDepth * 0.5 + ARENA.edgeGap, rotY: 0, width: ARENA.standWidthLong },
        { x: ARENA.floorWidth * 0.5 + ARENA.edgeGap, z: 0, rotY: Math.PI / 2, width: ARENA.standWidthShort },
        { x: -ARENA.floorWidth * 0.5 - ARENA.edgeGap, z: 0, rotY: -Math.PI / 2, width: ARENA.standWidthShort },
    ];

    for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const stand = createGrandstand(section.width, i);
        stand.position.set(section.x, 0, section.z);
        stand.rotation.y = section.rotY;
        group.add(stand);
    }
}

function createGrandstand(width, variant) {
    const stand = new THREE.Group();

    const lower = createSeatingTier({
        width,
        rows: ARENA.lowerRows,
        baseY: 0.86,
        baseZ: 0.25,
        accentOffset: variant * 3,
    });
    stand.add(lower);

    const upper = createSeatingTier({
        width: width * 0.92,
        rows: ARENA.upperRows,
        baseY: ARENA.upperTierY,
        baseZ: ARENA.upperTierZ,
        accentOffset: variant * 5 + 2,
    });
    stand.add(upper);

    const balcony = new THREE.Mesh(
        new THREE.BoxGeometry(width * 1.02, 1.15, 2.4),
        new THREE.MeshStandardMaterial({
            color: 0x2d313a,
            roughness: 0.62,
            metalness: 0.24,
        })
    );
    balcony.position.set(0, ARENA.upperTierY - 0.72, ARENA.upperTierZ - 1.2);
    balcony.castShadow = true;
    balcony.receiveShadow = true;
    stand.add(balcony);

    const underStrip = new THREE.Mesh(
        new THREE.BoxGeometry(width * 0.94, 0.14, 0.26),
        new THREE.MeshStandardMaterial({
            color: 0x3f2f18,
            roughness: 0.4,
            metalness: 0.34,
            emissive: 0x7a4d1c,
            emissiveIntensity: 0.42,
        })
    );
    underStrip.position.set(0, ARENA.upperTierY - 1.02, ARENA.upperTierZ - 2.38);
    stand.add(underStrip);

    const openingMat = new THREE.MeshBasicMaterial({ color: 0x06070c });
    for (const offset of [-0.34, 0, 0.34]) {
        const opening = new THREE.Mesh(
            new THREE.BoxGeometry(width * 0.12, 2.0, 0.18),
            openingMat
        );
        opening.position.set(offset * width, ARENA.upperTierY + 0.4, ARENA.upperTierZ - 2.0);
        stand.add(opening);
    }

    return stand;
}

function createSeatingTier({ width, rows, baseY, baseZ, accentOffset }) {
    const tier = new THREE.Group();

    const stepMat = new THREE.MeshStandardMaterial({
        color: 0x6e737e,
        roughness: 0.84,
        metalness: 0.05,
    });
    const aisleMat = new THREE.MeshStandardMaterial({
        color: 0xbec3cc,
        roughness: 0.7,
        metalness: 0.04,
    });
    const seatMat = new THREE.MeshStandardMaterial({
        color: 0x5b6069,
        roughness: 0.7,
        metalness: 0.12,
        vertexColors: true,
    });

    const stepGeo = new THREE.BoxGeometry(width, ARENA.tierRise + 0.01, ARENA.tierDepth + 0.02);
    for (let row = 0; row < rows; row++) {
        const step = new THREE.Mesh(stepGeo, stepMat);
        step.position.set(
            0,
            baseY + row * ARENA.tierRise + (ARENA.tierRise + 0.01) * 0.5,
            baseZ + row * ARENA.tierDepth + (ARENA.tierDepth + 0.02) * 0.5
        );
        step.receiveShadow = true;
        tier.add(step);
    }

    const seatPitch = 0.48;
    const cols = Math.max(8, Math.floor(width / seatPitch));
    const aisleCenters = [0.2, 0.5, 0.8];
    const aisleHalfCols = 1;
    const isAisle = (col) => aisleCenters.some((t) => {
        const centerCol = Math.round((cols - 1) * t);
        return Math.abs(col - centerCol) <= aisleHalfCols;
    });

    let seatCount = 0;
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            if (!isAisle(col)) seatCount++;
        }
    }

    const seatGeo = new THREE.BoxGeometry(1, 1, 1);
    const backGeo = new THREE.BoxGeometry(1, 1, 1);
    const seats = new THREE.InstancedMesh(seatGeo, seatMat, seatCount);
    const backs = new THREE.InstancedMesh(backGeo, seatMat, seatCount);
    seats.castShadow = false;
    seats.receiveShadow = true;
    backs.castShadow = false;
    backs.receiveShadow = true;

    const baseSeat = new THREE.Color(0x535861);
    const altSeat = new THREE.Color(0x5e646e);
    const accentSeat = new THREE.Color(0xaa4f96);
    let idx = 0;

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            if (isAisle(col)) continue;

            const x = (col - (cols - 1) * 0.5) * seatPitch;
            const y = baseY + row * ARENA.tierRise + 0.19;
            const z = baseZ + row * ARENA.tierDepth + 0.15;

            TMP_VEC.set(x, y, z);
            TMP_SCALE.set(0.42, 0.15, 0.42);
            TMP_MATRIX.compose(TMP_VEC, TMP_QUAT.identity(), TMP_SCALE);
            seats.setMatrixAt(idx, TMP_MATRIX);

            TMP_VEC.set(x, y + 0.13, z + 0.14);
            TMP_SCALE.set(0.42, 0.26, 0.08);
            TMP_MATRIX.compose(TMP_VEC, TMP_QUAT.identity(), TMP_SCALE);
            backs.setMatrixAt(idx, TMP_MATRIX);

            const accent =
                ((row + accentOffset) % 6 === 2 || (row + accentOffset) % 7 === 0) &&
                (col + row * 3 + accentOffset) % 9 < 2;

            const seatColor = accent
                ? accentSeat
                : ((col + row + accentOffset) % 2 === 0 ? baseSeat : altSeat);

            seats.setColorAt(idx, seatColor);
            TMP_COLOR.copy(seatColor).multiplyScalar(0.76);
            backs.setColorAt(idx, TMP_COLOR);

            idx++;
        }
    }

    seats.instanceMatrix.needsUpdate = true;
    backs.instanceMatrix.needsUpdate = true;
    if (seats.instanceColor) seats.instanceColor.needsUpdate = true;
    if (backs.instanceColor) backs.instanceColor.needsUpdate = true;

    tier.add(seats);
    tier.add(backs);

    for (const t of aisleCenters) {
        const centerCol = Math.round((cols - 1) * t);
        const x = (centerCol - (cols - 1) * 0.5) * seatPitch;
        for (let row = 0; row < rows; row++) {
            const stair = new THREE.Mesh(
                new THREE.BoxGeometry(seatPitch * 2.3, 0.06, 0.34),
                aisleMat
            );
            stair.position.set(
                x,
                baseY + row * ARENA.tierRise + 0.2,
                baseZ + row * ARENA.tierDepth + 0.16
            );
            stair.receiveShadow = true;
            tier.add(stair);
        }
    }

    return tier;
}

function addPerimeterWalls(group) {
    const extents = getArenaExtents();
    const wallMat = new THREE.MeshStandardMaterial({
        color: 0x11141b,
        roughness: 0.92,
        metalness: 0.08,
    });

    const walls = [
        new THREE.Mesh(
            new THREE.BoxGeometry(extents.halfX * 2 + 4, ARENA.wallHeight, 1.5),
            wallMat
        ),
        new THREE.Mesh(
            new THREE.BoxGeometry(extents.halfX * 2 + 4, ARENA.wallHeight, 1.5),
            wallMat
        ),
        new THREE.Mesh(
            new THREE.BoxGeometry(1.5, ARENA.wallHeight, extents.halfZ * 2 + 4),
            wallMat
        ),
        new THREE.Mesh(
            new THREE.BoxGeometry(1.5, ARENA.wallHeight, extents.halfZ * 2 + 4),
            wallMat
        ),
    ];

    walls[0].position.set(0, ARENA.wallHeight * 0.5, -extents.halfZ - 0.8);
    walls[1].position.set(0, ARENA.wallHeight * 0.5, extents.halfZ + 0.8);
    walls[2].position.set(extents.halfX + 0.8, ARENA.wallHeight * 0.5, 0);
    walls[3].position.set(-extents.halfX - 0.8, ARENA.wallHeight * 0.5, 0);

    for (const wall of walls) {
        wall.receiveShadow = true;
        wall.castShadow = true;
        group.add(wall);
    }

    const ribbonMat = new THREE.MeshStandardMaterial({
        color: 0x4d391f,
        roughness: 0.3,
        metalness: 0.4,
        emissive: 0x7b4c1f,
        emissiveIntensity: 0.28,
    });

    const ribbonNorth = new THREE.Mesh(
        new THREE.BoxGeometry(extents.halfX * 2 - 2, 0.18, 0.34),
        ribbonMat
    );
    ribbonNorth.position.set(0, 6.8, -extents.halfZ + 1.2);
    group.add(ribbonNorth);

    const ribbonSouth = ribbonNorth.clone();
    ribbonSouth.position.z = extents.halfZ - 1.2;
    group.add(ribbonSouth);

    const ribbonEast = new THREE.Mesh(
        new THREE.BoxGeometry(0.34, 0.18, extents.halfZ * 2 - 2),
        ribbonMat
    );
    ribbonEast.position.set(extents.halfX - 1.2, 6.8, 0);
    group.add(ribbonEast);

    const ribbonWest = ribbonEast.clone();
    ribbonWest.position.x = -extents.halfX + 1.2;
    group.add(ribbonWest);
}

function addCeilingStructure(group) {
    const extents = getArenaExtents();

    const roof = new THREE.Mesh(
        new THREE.BoxGeometry(extents.halfX * 2 + 6, 1.0, extents.halfZ * 2 + 6),
        new THREE.MeshStandardMaterial({
            color: 0x0a0d13,
            roughness: 0.92,
            metalness: 0.12,
        })
    );
    roof.position.y = ARENA.ceilingY;
    roof.receiveShadow = true;
    group.add(roof);

    const trussMat = new THREE.MeshStandardMaterial({
        color: 0x171b24,
        roughness: 0.55,
        metalness: 0.64,
    });

    for (let x = -extents.halfX; x <= extents.halfX; x += 3.4) {
        const beam = new THREE.Mesh(
            new THREE.BoxGeometry(0.14, 0.22, extents.halfZ * 2 + 3),
            trussMat
        );
        beam.position.set(x, ARENA.ceilingY - 0.58, 0);
        beam.castShadow = true;
        group.add(beam);
    }

    for (let z = -extents.halfZ; z <= extents.halfZ; z += 3.4) {
        const beam = new THREE.Mesh(
            new THREE.BoxGeometry(extents.halfX * 2 + 3, 0.22, 0.14),
            trussMat
        );
        beam.position.set(0, ARENA.ceilingY - 0.58, z);
        beam.castShadow = true;
        group.add(beam);
    }

    const bulbGeo = new THREE.SphereGeometry(0.09, 10, 8);
    const coolBulbMat = new THREE.MeshBasicMaterial({ color: 0xf2f4ff });
    const warmBulbMat = new THREE.MeshBasicMaterial({ color: 0xffd268 });
    const lightY = ARENA.ceilingY - 1.05;

    for (let x = -extents.halfX + 2.2; x <= extents.halfX - 2.2; x += 2.6) {
        for (let z = -extents.halfZ + 2.2; z <= extents.halfZ - 2.2; z += 2.6) {
            const selector = Math.round((x + z) * 10);
            if (Math.abs(selector) % 5 !== 0 && Math.abs(selector) % 7 !== 0) continue;

            const bulb = new THREE.Mesh(
                bulbGeo,
                Math.abs(selector) % 9 === 0 ? warmBulbMat : coolBulbMat
            );
            bulb.position.set(x, lightY, z);
            group.add(bulb);
        }
    }
}

function addSpeakerClusters(group) {
    const arrays = [
        { x: -5.8, z: -2.2, rotY: Math.PI * 0.75 },
        { x: 5.8, z: -2.2, rotY: Math.PI * 0.25 },
        { x: -5.8, z: 2.2, rotY: -Math.PI * 0.75 },
        { x: 5.8, z: 2.2, rotY: -Math.PI * 0.25 },
    ];

    for (const cfg of arrays) {
        const array = createSpeakerArray();
        array.position.set(cfg.x, ARENA.ceilingY - 1.2, cfg.z);
        array.rotation.y = cfg.rotY;
        group.add(array);
    }
}

function createSpeakerArray() {
    const speakerMat = new THREE.MeshStandardMaterial({
        color: 0x2b2f37,
        roughness: 0.62,
        metalness: 0.35,
    });
    const speakerGeo = new THREE.BoxGeometry(0.58, 0.34, 0.28);
    const array = new THREE.Group();

    for (let i = 0; i < 8; i++) {
        const box = new THREE.Mesh(speakerGeo, speakerMat);
        box.position.y = -i * 0.34;
        box.rotation.x = -0.23 + i * 0.05;
        box.castShadow = true;
        array.add(box);
    }

    return array;
}

function onResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
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

    renderer.render(scene, camera);
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
