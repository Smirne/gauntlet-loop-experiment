// Smoke-test bootstrap. Verifies vendored three + importmap + dev server +
// headless capture end to end before the real game is built on top.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { installCapture } from './core/Capture.js';

const W = innerWidth || 1600;
const H = innerHeight || 900;

const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1119);
const camera = new THREE.PerspectiveCamera(45, W / H, 2, 2000);
camera.position.set(70, 55, 110);
camera.lookAt(0, 4, 0);

scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x30240f, 1.1));
const sun = new THREE.DirectionalLight(0xfff2df, 3.2);
sun.position.set(60, 100, 40);
scene.add(sun);

const box = new THREE.Mesh(
  new THREE.BoxGeometry(30, 12, 55),
  new THREE.MeshStandardMaterial({ color: 0xe23b2e, roughness: 0.28, metalness: 0.1 })
);
box.position.y = 6;
scene.add(box);
scene.add(new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x2a3040, roughness: 0.9 })
));

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), 0.45, 0.5, 0.85));
composer.addPass(new OutputPass());

const engine = {
  renderer,
  composer,
  scene,
  camera,
  onResize(w, h) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    composer.setSize(w, h);
  },
  renderFrame() {
    composer.render();
  },
};
installCapture(engine);

document.getElementById('boot')?.remove();
renderer.setAnimationLoop((t) => {
  box.rotation.y = t * 0.0006;
  engine.renderFrame();
});

window.__mgReady = { smoke: true, three: THREE.REVISION };
console.log('[MICRO GAUNTLET] smoke test running, three r' + THREE.REVISION);
