/* ══════════════════════════════════════════════════════
   main.js — 场景、手势指令、步态循环
   ══════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { AS2 } from './robot.js';
import { Gait } from './gait.js';
import { HandTracker, HAND_CONNECTIONS } from './hand-tracker.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const params = new URLSearchParams(location.search);

/* ── 渲染基础 ───────────────────────────────── */

const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080c);
scene.fog = new THREE.Fog(0x07080c, 6, 30);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.05, 120);
camera.position.set(-1.6, 0.95, 1.7);

/* 环境贴图：用一小张渐变画布做 IBL，金属才有反光，不然像磨砂塑料 */
function makeEnvMap() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#8ea9c4');
  grad.addColorStop(0.44, '#2b3542');
  grad.addColorStop(0.52, '#161b22');
  grad.addColorStop(1, '#080a0e');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 256);

  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.beginPath(); g.ellipse(110, 52, 78, 30, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(79,209,255,0.55)';
  g.beginPath(); g.ellipse(392, 92, 96, 24, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,196,120,0.35)';
  g.beginPath(); g.ellipse(250, 150, 120, 18, 0, 0, Math.PI * 2); g.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}
scene.environment = makeEnvMap();
scene.environmentIntensity = 0.85;

/* 灯光 */
const hemi = new THREE.HemisphereLight(0x9dc4ff, 0x141821, 0.7);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xffffff, 2.3);
key.position.set(3.4, 5.2, 2.6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 18;
key.shadow.camera.left = -3;
key.shadow.camera.right = 3;
key.shadow.camera.top = 3;
key.shadow.camera.bottom = -3;
key.shadow.bias = -0.0012;
key.shadow.normalBias = 0.02;
scene.add(key);

const rim = new THREE.DirectionalLight(0x6fc4ff, 1.5);
rim.position.set(-3.2, 2.1, -3.4);
scene.add(rim);

const fill = new THREE.DirectionalLight(0xffd9a8, 0.5);
fill.position.set(0.5, 1.2, 4);
scene.add(fill);

/* 地面：用重复纹理画网格，比 GridHelper 的线段有纵深、也更抗锯齿 */
function gridTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');

  g.fillStyle = '#0d1218';
  g.fillRect(0, 0, S, S);

  // 0.5m 细线
  g.strokeStyle = '#18242d';
  g.lineWidth = 1.5;
  for (let i = 1; i < 4; i++) {
    const p = (i * S) / 4;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
  }
  // 2m 主线
  g.strokeStyle = '#26404f';
  g.lineWidth = 3;
  g.strokeRect(0, 0, S, S);

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(100, 100);          // 200m 地面 / 2m 一格
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ map: gridTexture(), roughness: 0.92, metalness: 0.06 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

/* 脚下一圈冷光，让机器狗和地面有接触感 */
function radialTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.55, inner.replace(/[\d.]+\)$/, '0.05)'));
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const pool = new THREE.Mesh(
  new THREE.PlaneGeometry(6.4, 6.4),
  new THREE.MeshBasicMaterial({
    map: radialTexture('rgba(126,206,255,0.24)', 'rgba(126,206,255,0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  })
);
pool.rotation.x = -Math.PI / 2;
pool.position.y = 0.005;
scene.add(pool);

/* ── 机器人与步态 ───────────────────────────── */

const robot = new AS2();
const gait = new Gait();
scene.add(robot.root);

const sim = {
  pos: new THREE.Vector3(0, 0, 0),
  yaw: 0,
  vx: 0, vy: 0, vyaw: 0,
  cmd: { vx: 0, vy: 0, vyaw: 0 },
};

const LIMITS = { vxMax: 1.5, vxMin: -0.7, vyMax: 0.5, vyawMax: 1.15 };

/* ── 手势识别 ───────────────────────────────── */

const tracker = new HandTracker();
const video = $('cam');
const previewVideo = $('preview-video');
const overlay = $('preview-overlay');
const overlayCtx = overlay.getContext('2d');

const app = {
  mode: 'idle',          // idle | preparing | camera | mouse | demo
  landmarks: null,
  gesture: null,
  hasHand: false,
  lastSeen: 0,
  showSkeleton: true,
  showPreview: true,
  camMode: 'chase',      // chase | side
  lastVideoTime: -1,
  robotReady: false,
  braking: false,
};

const gate = $('gate');
const hud = $('hud');
const statusEl = $('status');
const statusText = $('status-text');
const previewBox = $('preview');
const toastEl = $('toast');
const btnStart = $('btn-start');
const btnMouse = $('btn-mouse');
const btnSkeleton = $('btn-skeleton');
const btnPreview = $('btn-preview');
const btnCam = $('btn-cam');
const btnFullscreen = $('btn-fullscreen');
const gateNote = $('gate-note');
const btnLabel = btnStart.querySelector('.btn-label');

const barVx = $('bar-vx');
const numVx = $('num-vx');
const barVyaw = $('bar-vyaw');
const numVyaw = $('num-vyaw');
const barFreq = $('bar-freq');
const numFreq = $('num-freq');

let toastTimer = 0;
function toast(msg, ms = 2800) {
  toastEl.textContent = msg;
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), ms);
}

let lastStatus = '';
function setStatus(text, active) {
  if (text !== lastStatus) {
    statusText.textContent = text;
    lastStatus = text;
  }
  statusEl.classList.toggle('is-active', !!active);
}

function humanError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return '摄像头权限被拒绝了 — 点地址栏左侧的摄像头图标，允许后刷新页面。';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有找到可用的摄像头设备。';
  if (name === 'NotReadableError') return '摄像头被其他程序占用了，关掉它再试。';
  if (err?.message?.includes('模型') || err?.message?.includes('fetch') || err?.message?.includes('import'))
    return '手部识别模型加载失败 — 检查网络后重试，或先用鼠标模式。';
  return `启动失败：${err?.message || '未知错误'}`;
}

/* 模型后台预载，用户点按钮时通常已经好了 */
let loadProgress = 0;
const robotPromise = robot.load((p) => {
  loadProgress = p;
  if (app.mode === 'idle' && p > 0.02) btnLabel.textContent = `模型载入中 ${Math.round(p * 100)}%`;
}).then(() => {
  app.robotReady = true;
  btnLabel.textContent = app.mode === 'idle' ? '开启摄像头' : btnLabel.textContent;
  return robot;
}).catch((err) => {
  console.error('[model]', err);
  gateNote.textContent = 'AS2 模型载入失败：' + err.message;
});

/* ── 启动 ───────────────────────────────────── */

async function startCamera() {
  if (app.mode === 'preparing' || app.mode === 'camera') return;
  app.mode = 'preparing';
  btnStart.disabled = true;
  btnStart.classList.add('is-loading');
  gateNote.classList.remove('is-error');
  gateNote.textContent = '所有识别在本机完成，画面不上传';
  btnLabel.textContent = '正在请求摄像头…';

  try {
    await robotPromise;
    await tracker.openCamera(video);
    await tracker.load((msg) => { btnLabel.textContent = msg; });

    previewVideo.srcObject = tracker.stream;
    app.mode = 'camera';
    app.lastSeen = performance.now();

    gate.classList.add('is-gone');
    hud.classList.add('is-live');
    previewBox.classList.toggle('is-on', app.showPreview);

    toast(`手势追踪就绪 · ${tracker.backend} 推理`, 3000);
  } catch (err) {
    console.error('[start]', err);
    tracker.stop();
    app.mode = 'idle';
    btnStart.disabled = false;
    btnStart.classList.remove('is-loading');
    btnLabel.textContent = '重新开启摄像头';
    gateNote.classList.add('is-error');
    gateNote.textContent = humanError(err);
  }
}

async function startMouseMode() {
  app.mode = 'mouse';
  gate.classList.add('is-gone');
  hud.classList.add('is-live');
  previewBox.classList.remove('is-on');
  app.lastSeen = performance.now();
  toast('鼠标模式 · 左右转向，上下前后', 3200);
  try { await robotPromise; } catch (_) {}
}

btnStart.addEventListener('click', startCamera);
btnMouse.addEventListener('click', startMouseMode);

btnSkeleton.addEventListener('click', () => {
  app.showSkeleton = !app.showSkeleton;
  btnSkeleton.setAttribute('aria-pressed', String(app.showSkeleton));
});
btnPreview.addEventListener('click', () => {
  app.showPreview = !app.showPreview;
  btnPreview.setAttribute('aria-pressed', String(app.showPreview));
  previewBox.classList.toggle('is-on', app.showPreview && app.mode === 'camera');
});
btnCam.addEventListener('click', () => {
  app.camMode = app.camMode === 'chase' ? 'side' : 'chase';
  btnCam.textContent = app.camMode === 'chase' ? '跟随' : '侧视';
  btnCam.setAttribute('aria-pressed', 'true');
});
btnFullscreen.addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  } catch (_) { toast('这个浏览器不支持全屏'); }
});

/* ── 输入 → 速度指令 ────────────────────────── */

const deadzone = (v, t = 0.1) => (Math.abs(v) < t ? 0 : (v - Math.sign(v) * t) / (1 - t));

/* 手势：手在画面里的位置就是一根摇杆 */
function applyGesture(g) {
  const fwd = deadzone(clamp((0.5 - g.cy) / 0.3, -1, 1), 0.12);
  const turn = deadzone(clamp((g.cx - 0.5) / 0.3, -1, 1), 0.14);

  // 拇指食指捏合 = 刹车
  const braking = g.openness < 0.16;
  app.braking = braking;

  if (braking) {
    sim.cmd.vx = 0; sim.cmd.vy = 0; sim.cmd.vyaw = 0;
    return;
  }
  sim.cmd.vx = fwd > 0 ? fwd * LIMITS.vxMax : fwd * -LIMITS.vxMin;
  sim.cmd.vyaw = -turn * LIMITS.vyawMax;
  sim.cmd.vy = 0;
}

function pointerControl(clientX, clientY) {
  if (app.mode !== 'mouse') return;
  const x = clamp(clientX / innerWidth, 0, 1);
  const y = clamp(clientY / innerHeight, 0, 1);
  const fwd = deadzone(clamp((0.5 - y) / 0.34, -1, 1), 0.1);
  const turn = deadzone(clamp((x - 0.5) / 0.34, -1, 1), 0.1);
  sim.cmd.vx = fwd > 0 ? fwd * LIMITS.vxMax : fwd * -LIMITS.vxMin;
  sim.cmd.vyaw = -turn * LIMITS.vyawMax;
  app.hasHand = true;
  app.lastSeen = performance.now();
}
addEventListener('pointermove', (e) => pointerControl(e.clientX, e.clientY), { passive: true });
addEventListener('pointerdown', (e) => pointerControl(e.clientX, e.clientY), { passive: true });

/* 键盘兜底：方向键 / WASD 手动驾驶，方便调试和录屏 */
addEventListener('keydown', (e) => {
  if (app.mode !== 'mouse') return;
  const c = sim.cmd;
  if (e.key === 'ArrowUp' || e.key === 'w') c.vx = LIMITS.vxMax;
  if (e.key === 'ArrowDown' || e.key === 's') c.vx = -LIMITS.vxMin;
  if (e.key === 'ArrowLeft' || e.key === 'a') c.vyaw = LIMITS.vyawMax;
  if (e.key === 'ArrowRight' || e.key === 'd') c.vyaw = -LIMITS.vyawMax;
});

/* ── 相机 ───────────────────────────────────── */

const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();
const lookTarget = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function updateCamera(dt) {
  const fwd = new THREE.Vector3(Math.cos(sim.yaw), 0, -Math.sin(sim.yaw));
  const left = new THREE.Vector3(-Math.sin(sim.yaw), 0, -Math.cos(sim.yaw));

  if (app.camMode === 'chase') {
    camPos.copy(sim.pos)
      .addScaledVector(fwd, -2.05)
      .addScaledVector(left, 0.72)
      .addScaledVector(UP, 0.98);
    lookTarget.copy(sim.pos).addScaledVector(fwd, 0.5).addScaledVector(UP, 0.34);
  } else {
    camPos.copy(sim.pos).addScaledVector(left, 2.1).addScaledVector(fwd, -0.38).addScaledVector(UP, 0.72);
    lookTarget.copy(sim.pos).addScaledVector(UP, 0.26);
  }

  const k = 1 - Math.exp(-dt * 3.2);
  camera.position.lerp(camPos, k);
  camTarget.lerp(lookTarget, k);
  camera.lookAt(camTarget);
}

/* ── 预览窗骨架 ─────────────────────────────── */

function drawOverlay(lm) {
  const w = overlay.width;
  const h = overlay.height;
  overlayCtx.clearRect(0, 0, w, h);
  if (!lm || !app.showSkeleton) return;

  overlayCtx.lineWidth = 2;
  overlayCtx.strokeStyle = 'rgba(79, 209, 255, 0.75)';
  overlayCtx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    overlayCtx.moveTo(lm[a].x * w, lm[a].y * h);
    overlayCtx.lineTo(lm[b].x * w, lm[b].y * h);
  }
  overlayCtx.stroke();

  for (let i = 0; i < lm.length; i++) {
    const tip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;
    overlayCtx.beginPath();
    overlayCtx.arc(lm[i].x * w, lm[i].y * h, tip ? 4 : 2.4, 0, Math.PI * 2);
    overlayCtx.fillStyle = tip ? '#eaf9ff' : 'rgba(120, 220, 255, 0.85)';
    overlayCtx.fill();
  }

  // 拇指-食指这条"刹车弦"
  overlayCtx.setLineDash([4, 4]);
  overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
  overlayCtx.lineWidth = 1.5;
  overlayCtx.beginPath();
  overlayCtx.moveTo(lm[4].x * w, lm[4].y * h);
  overlayCtx.lineTo(lm[8].x * w, lm[8].y * h);
  overlayCtx.stroke();
  overlayCtx.setLineDash([]);
}

function sizeOverlay() {
  const r = overlay.parentElement.getBoundingClientRect();
  overlay.width = Math.max(1, Math.round(r.width));
  overlay.height = Math.max(1, Math.round(r.height));
}
setTimeout(sizeOverlay, 60);
addEventListener('resize', () => { setTimeout(sizeOverlay, 60); });

/* ── 主循环 ─────────────────────────────────── */

let last = performance.now();
let diagFrames = 0;
let diagDt = 0;
const tmpPos = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();
const tmpLeft = new THREE.Vector3();

/* 一步仿真：平滑、积分、步态、相机。与渲染解耦，才能预热与逐步调试 */
function stepSim(dt) {
  const k = 1 - Math.exp(-dt * 7);
  sim.vx += (clamp(sim.cmd.vx, LIMITS.vxMin, LIMITS.vxMax) - sim.vx) * k;
  sim.vy += (clamp(sim.cmd.vy, -LIMITS.vyMax, LIMITS.vyMax) - sim.vy) * k;
  sim.vyaw += (clamp(sim.cmd.vyaw, -LIMITS.vyawMax, LIMITS.vyawMax) - sim.vyaw) * k;

  sim.yaw += sim.vyaw * dt;

  tmpFwd.set(Math.cos(sim.yaw), 0, -Math.sin(sim.yaw));
  tmpLeft.set(-Math.sin(sim.yaw), 0, -Math.cos(sim.yaw));
  sim.pos.addScaledVector(tmpFwd, sim.vx * dt).addScaledVector(tmpLeft, sim.vy * dt);

  const targets = gait.update(dt, sim.vx, sim.vy, sim.vyaw);
  robot.setFootTargets(targets);

  tmpPos.copy(sim.pos);
  tmpPos.y = gait.height + gait.bob();
  robot.setPose(tmpPos, sim.yaw);

  pool.position.x = sim.pos.x;
  pool.position.z = sim.pos.z;

  updateCamera(dt);
}

function frame(now) {
  // 时间戳可能倒退（切换标签页、无头环境虚拟时钟），负的 dt 会让平滑系数变号、
  // 速度指数级发散，必须夹到 [0, 0.05]；为 0 时按 60fps 补一帧，避免动画冻结
  const raw = (now - last) / 1000;
  const dt = Math.min(Math.max(raw, 0), 0.05) || 1 / 60;
  last = now;
  diagFrames++;
  diagDt = dt;

  /* 1. 取指令 */
  if (app.mode === 'camera') {
    const fresh = video.currentTime !== app.lastVideoTime && video.readyState >= 2;
    let hit = null;
    if (fresh) {
      app.lastVideoTime = video.currentTime;
      hit = tracker.detect(video);
    } else if (app.hasHand && app.landmarks) {
      hit = { landmarks: app.landmarks, gesture: app.gesture };
    }

    if (hit) {
      app.lastSeen = now;
      app.hasHand = true;
      app.landmarks = hit.landmarks;
      app.gesture = hit.gesture;
      applyGesture(hit.gesture);
    } else if (now - app.lastSeen > 700) {
      app.hasHand = false;
      app.landmarks = null;
      app.braking = false;
      sim.cmd.vx *= 0.9;      // 手离开 → 平滑收油，不是急停
      sim.cmd.vyaw *= 0.9;
    }
  } else if (app.mode === 'mouse') {
    if (now - app.lastSeen > 2600) {
      sim.cmd.vx *= 0.94;
      sim.cmd.vyaw *= 0.94;
    }
  } else if (app.mode === 'demo') {
    if (params.has('fx') || params.has('fy') || params.has('op')) {
      applyGesture({
        cx: Number(params.get('fx') || 0.5),
        cy: Number(params.get('fy') || 0.5),
        openness: Number(params.get('op') || 1),
        pinch: 0, roll: 0, extended: 5,
      });
    } else {
      sim.cmd.vx = Number(params.get('auto') || 0.85);
      sim.cmd.vyaw = Number(params.get('yaw') || 0);
    }
  } else {
    sim.cmd.vx = 0;
    sim.cmd.vyaw = 0;
  }

  /* 2. 仿真 + 渲染 */
  stepSim(dt);
  renderer.render(scene, camera);

  /* 3. HUD */
  if (app.mode === 'camera') {
    drawOverlay(app.landmarks);
    if (!app.hasHand) setStatus(now - app.lastSeen > 2400 ? '把手举到画面里，掌心朝我' : '没看到手 — 靠近一点', false);
    else if (app.braking) setStatus('刹车 · 拇指与食指捏合中', true);
    else if (Math.abs(sim.vx) > 0.12) setStatus(`前进 ${sim.vx.toFixed(2)} m/s`, true);
    else if (Math.abs(sim.vyaw) > 0.15) setStatus(`转向 ${(sim.vyaw * 57.3).toFixed(0)} °/s`, true);
    else setStatus('待命 · 抬高手掌前进', true);
  } else if (app.mode === 'mouse') {
    setStatus('鼠标模式 · 上下前后，左右转向', true);
  }

  const vxR = clamp(Math.abs(sim.vx) / LIMITS.vxMax, 0, 1);
  barVx.style.transform = `scaleX(${vxR.toFixed(3)})`;
  barVx.classList.toggle('is-warm', sim.vx < -0.05);
  if (numVx.textContent !== sim.vx.toFixed(2)) numVx.textContent = sim.vx.toFixed(2);

  const yawR = clamp(Math.abs(sim.vyaw) / LIMITS.vyawMax, 0, 1);
  barVyaw.style.transform = `scaleX(${yawR.toFixed(3)})`;
  if (numVyaw.textContent !== (sim.vyaw * 57.3).toFixed(0)) numVyaw.textContent = (sim.vyaw * 57.3).toFixed(0);

  const fr = clamp(gait.freq / 3.6, 0, 1);
  barFreq.style.transform = `scaleX(${fr.toFixed(3)})`;
  if (numFreq.textContent !== gait.freq.toFixed(1)) numFreq.textContent = gait.freq.toFixed(1);

  requestAnimationFrame(frame);
}

/* ── 尺寸 ───────────────────────────────────── */

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* ── 调试入口（截图 / 手动验证步态用）────────── */

if (params.has('auto') || params.has('demo')) {
  app.mode = 'demo';
  gate.classList.add('is-gone');
  hud.classList.add('is-live');
  if (params.get('side') === '1') app.camMode = 'side';
  sim.cmd.vx = Number(params.get('auto') || 0.85);
  sim.cmd.vyaw = Number(params.get('yaw') || 0);
}

/* 预热：以固定步长先跑 N 步，保证截图拿到稳定姿态而不是首帧 */
const warm = Number(params.get('warm') || 0);
if (warm > 0) {
  for (let i = 0; i < warm; i++) stepSim(1 / 60);
  camera.position.copy(camPos);
  camTarget.copy(lookTarget);
  camera.lookAt(camTarget);
}

window.__sim = { sim, gait, app, robot, setCmd: (vx, vy, vyaw) => Object.assign(sim.cmd, { vx, vy, vyaw }) };

/* 诊断面板：?diag=1 时把渲染数据写进 DOM，方便无头截图排查 */
if (params.has('diag')) {
  const d = document.createElement('pre');
  d.id = 'diag';
  d.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;color:#7ef;font:11px/1.5 ui-monospace,monospace;background:rgba(0,0,0,.6);padding:8px;max-width:60vw;white-space:pre-wrap';
  document.body.appendChild(d);
  const errs = [];
  addEventListener('error', (e) => errs.push(e.message));
  addEventListener('unhandledrejection', (e) => errs.push(String(e.reason)));
  setInterval(() => {
    const i = renderer.info;
    let meshes = 0;
    robot.root.traverse((o) => { if (o.isMesh) meshes++; });
    const bb = new THREE.Box3().setFromObject(robot.root);
    const f = (v) => v.toArray().map((n) => n.toFixed(2)).join(',');
    d.textContent = [
      `robot.loaded=${robot.loaded} children=${scene.children.length}`,
      `calls=${i.render.calls} tris=${i.render.triangles}`,
      `cam=${camera.position.toArray().map((v) => v.toFixed(2)).join(',')}`,
      `pos=${sim.pos.toArray().map((v) => v.toFixed(2)).join(',')} yaw=${sim.yaw.toFixed(2)}`,
      `vx=${sim.vx.toFixed(2)} cmd=${sim.cmd.vx.toFixed(2)} freq=${gait.freq.toFixed(2)} mode=${app.mode}`,
      `frames=${diagFrames} lastdt=${diagDt.toFixed(4)}`,
      `canvas=${renderer.domElement.width}x${renderer.domElement.height}`,
      `meshes=${meshes} bbox=${f(bb.min)} → ${f(bb.max)}`,
      `rootPos=${f(robot.root.position)} visible=${robot.root.visible}`,
      `err=${errs.slice(-2).join(' | ') || 'none'}`,
    ].join('\n');
  }, 400);
}

requestAnimationFrame(frame);

addEventListener('beforeunload', () => tracker.stop());
