// scene.js -- Three.js scene setup: renderer, camera, lights, floor, fog

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let renderer, scene, camera, controls;
let clock;
const updateCallbacks = [];

// --- Public API ---

export function getScene() { return scene; }
export function getCamera() { return camera; }
export function getRenderer() { return renderer; }
export function getClock() { return clock; }

export function onUpdate(fn) {
    updateCallbacks.push(fn);
}

// --- Init ---

export function init(canvas) {
    clock = new THREE.Clock();

    // Renderer
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
    renderer.toneMappingExposure = 1.0;

    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0ede8);
    scene.fog = new THREE.FogExp2(0xf0ede8, 0.012);

    // Camera
    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position.set(0, 8, 18);
    camera.lookAt(0, 1, 0);

    // Controls
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 1, 0);
    controls.minDistance = 5;
    controls.maxDistance = 40;
    controls.maxPolarAngle = Math.PI / 2.1; // Don't go below the floor
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.3;

    // --- Lighting ---

    // Ambient: bright base for white room
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);

    // Key light: warm from above-front
    const keyLight = new THREE.DirectionalLight(0xffeedd, 0.8);
    keyLight.position.set(5, 10, 5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 30;
    keyLight.shadow.camera.left = -10;
    keyLight.shadow.camera.right = 10;
    keyLight.shadow.camera.top = 10;
    keyLight.shadow.camera.bottom = -10;
    scene.add(keyLight);

    // Fill light: cool from the side
    const fillLight = new THREE.DirectionalLight(0x4466aa, 0.4);
    fillLight.position.set(-5, 5, -3);
    scene.add(fillLight);

    // Accent point light at center (teal, reacts to music later)
    const accentLight = new THREE.PointLight(0x2a6e5a, 1, 20);
    accentLight.position.set(0, 3, 0);
    scene.add(accentLight);

    // --- Floor ---

    const floorGeometry = new THREE.CircleGeometry(30, 64);
    const floorMaterial = new THREE.MeshStandardMaterial({
        color: 0xe8e4de,
        roughness: 0.95,
        metalness: 0.0,
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = true;
    scene.add(floor);

    // --- Grid lines on floor (subtle) ---

    const gridHelper = new THREE.GridHelper(30, 30, 0xd0ccc5, 0xd0ccc5);
    gridHelper.position.y = 0.01;
    gridHelper.material.opacity = 0.2;
    gridHelper.material.transparent = true;
    scene.add(gridHelper);

    // --- Handle resize ---

    window.addEventListener('resize', onResize);

    // --- Start render loop ---

    animate();
}

function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    const elapsed = clock.getElapsedTime();

    controls.update();

    // Call all update callbacks
    for (const fn of updateCallbacks) {
        try { fn(delta, elapsed); } catch (e) { console.error('[scene] update error:', e); }
    }

    renderer.render(scene, camera);
}
