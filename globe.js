/* RelayPay globe — isolated Three.js module.
   API: window.RelayGlobe.setState('idle'|'listening'|'thinking'|'speaking')
        window.RelayGlobe.setVolume(0..1)
   Falls back to the inline SVG if WebGL or the CDN is unavailable. */
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) { return false; }
}

function initGlobe() {
  const host = document.querySelector('[data-globe]');
  const mount = document.querySelector('[data-globe-canvas]');
  if (!host || !mount || !webglAvailable()) return;

  const D = Math.PI / 180;
  const BLUE = new THREE.Color('#0E2A47');
  const TEAL = new THREE.Color('#16788A');
  const BG = new THREE.Color('#F6F6F3');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  const CITIES = {
    lagos: [6.52, 3.38], nairobi: [-1.29, 36.82], accra: [5.60, -0.19], capetown: [-33.92, 18.42],
    kigali: [-1.95, 30.06], london: [51.51, -0.13], newyork: [40.71, -74.01]
  };
  const ROUTES = [
    ['lagos', 'london'], ['nairobi', 'london'], ['lagos', 'newyork'], ['accra', 'lagos'],
    ['capetown', 'london'], ['kigali', 'nairobi'], ['nairobi', 'lagos'], ['accra', 'newyork'], ['capetown', 'lagos']
  ];

  const vec = (lat, lon, r = 1) => new THREE.Vector3(
    r * Math.cos(lat * D) * Math.sin(lon * D), r * Math.sin(lat * D), r * Math.cos(lat * D) * Math.cos(lon * D));

  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
  catch (e) { return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const DIST = 4.6;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  camera.position.set(0, 0, DIST);

  const tilt = new THREE.Group();
  tilt.rotation.x = 0.32;
  const spin = new THREE.Group();
  spin.rotation.y = -18 * D;
  tilt.add(spin); scene.add(tilt);

  // Occluder: page-coloured sphere hides back-side lines (reads as no fill)
  spin.add(new THREE.Mesh(new THREE.SphereGeometry(0.992, 64, 48), new THREE.MeshBasicMaterial({ color: BG })));

  const gridMat = new THREE.LineBasicMaterial({ color: BLUE, transparent: true, opacity: 0.2 });
  const equatorMat = new THREE.LineBasicMaterial({ color: BLUE, transparent: true, opacity: 0.34 });
  for (let lat = -75; lat <= 75; lat += 15) {
    const pts = [];
    for (let lon = 0; lon <= 360; lon += 3) pts.push(vec(lat, lon));
    spin.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lat === 0 ? equatorMat : gridMat));
  }
  for (let lon = 0; lon < 360; lon += 15) {
    const pts = [];
    for (let lat = -90; lat <= 90; lat += 3) pts.push(vec(lat, lon));
    spin.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gridMat));
  }

  // Silhouette ring (camera-facing, not spinning)
  {
    const r = Math.sqrt(1 - 1 / (DIST * DIST)), z = 1 / DIST, pts = [];
    for (let a = 0; a <= 360; a += 2) pts.push(new THREE.Vector3(Math.cos(a * D) * r, Math.sin(a * D) * r, z));
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: BLUE, transparent: true, opacity: 0.5 })));
  }

  // City markers
  const dotGeo = new THREE.CircleGeometry(0.016, 20);
  const dotMat = new THREE.MeshBasicMaterial({ color: BLUE });
  Object.values(CITIES).forEach(([lat, lon]) => {
    const m = new THREE.Mesh(dotGeo, dotMat);
    const p = vec(lat, lon, 1.004);
    m.position.copy(p); m.lookAt(p.clone().multiplyScalar(2));
    spin.add(m);
  });

  // Corridor arcs
  const SEG = 96;
  const arcs = ROUTES.map(([a, b]) => {
    const va = vec(...CITIES[a]).normalize(), vb = vec(...CITIES[b]).normalize();
    const th = va.angleTo(vb), s = Math.sin(th), pts = [];
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const p = va.clone().multiplyScalar(Math.sin((1 - t) * th) / s).add(vb.clone().multiplyScalar(Math.sin(t * th) / s));
      p.multiplyScalar(1 + Math.sin(Math.PI * t) * (0.03 + th * 0.12));
      pts.push(p);
    }
    const mat = new THREE.LineBasicMaterial({ color: BLUE.clone(), transparent: true, opacity: 0.55 });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    spin.add(line);
    return { line, mat };
  });

  // State
  const SPEED = { idle: 0.06, listening: 0.005, thinking: 0.025, speaking: 0.035 }; // rad/s
  let mode = 'idle', volume = 0, sVol = 0, speed = SPEED.idle;
  let drawArc = 0, drawT = 0;

  function applyArcs(dt) {
    arcs.forEach(({ line, mat }, i) => {
      if (mode === 'thinking') {
        const active = i === drawArc;
        mat.color.copy(BLUE);
        mat.opacity = active ? 0.9 : 0.14;
        const p = reduce.matches ? 1 : Math.min(drawT / 2.8, 1);
        line.geometry.setDrawRange(0, active ? Math.max(2, Math.floor(p * (SEG + 1))) : SEG + 1);
      } else if (mode === 'speaking') {
        mat.color.copy(BLUE).lerp(TEAL, 0.5 + sVol * 0.5);
        mat.opacity = 0.3 + sVol * 0.65;
        line.geometry.setDrawRange(0, SEG + 1);
      } else {
        mat.color.copy(BLUE);
        mat.opacity = mode === 'listening' ? 0.4 : 0.55;
        line.geometry.setDrawRange(0, SEG + 1);
      }
    });
    if (mode === 'thinking' && !reduce.matches) {
      drawT += dt;
      if (drawT > 3.8) { drawT = 0; drawArc = (drawArc + 1) % arcs.length; }
    }
  }

  function resize() {
    const w = mount.clientWidth, h = mount.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderOnce();
  }
  function renderOnce() { applyArcs(0); renderer.render(scene, camera); }

  let raf = null, last = 0, visible = true;
  function frame(ts) {
    const dt = Math.min((ts - (last || ts)) / 1000, 0.05); last = ts;
    speed += (SPEED[mode] - speed) * Math.min(dt * 2.5, 1);
    spin.rotation.y += speed * dt;
    sVol += (volume - sVol) * Math.min(dt * 10, 1);
    applyArcs(dt);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  function start() { if (!raf && !reduce.matches && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = null; }

  new ResizeObserver(resize).observe(mount);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); }).observe(mount);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  reduce.addEventListener('change', () => { if (reduce.matches) { stop(); renderOnce(); } else start(); });

  window.RelayGlobe = {
    setState(s) {
      if (!SPEED.hasOwnProperty(s) || s === mode) return;
      if (s === 'thinking') { drawT = 0; drawArc = (drawArc + 1) % arcs.length; }
      mode = s;
      if (reduce.matches) { sVol = volume; renderOnce(); }
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, +v || 0));
      if (reduce.matches) { sVol = volume; renderOnce(); }
    }
  };

  const init = window.__globeState || {};
  if (init.state) window.RelayGlobe.setState(init.state);
  resize();
  host.classList.add('globe--webgl');
  start();
}

try { initGlobe(); } catch (e) { /* SVG fallback stays visible */ }
