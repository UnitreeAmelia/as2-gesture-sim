/* ══════════════════════════════════════════════════════
   hand-tracker.js — 手部关键点追踪 + 手势解析
   基于 MediaPipe Tasks Vision（浏览器本地推理，GPU 加速）
   ══════════════════════════════════════════════════════ */

const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const LOCAL_BUNDLE = new URL('../vendor/vision_bundle.mjs', import.meta.url).href;
const LOCAL_WASM = new URL('../wasm', import.meta.url).href.replace(/\/$/, '');
const CDN_BUNDLE = `${CDN_BASE}/vision_bundle.mjs`;
const CDN_WASM = `${CDN_BASE}/wasm`;
const CDN_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const LOCAL_MODEL = new URL('../models/hand_landmarker.task', import.meta.url).href;

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/* 手型比例：用掌心宽度归一化，这样和手离镜头的远近无关 */
function dist2D(a, b, aspect) {
  const dx = (a.x - b.x) * aspect;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export function analyzeHand(lm, aspect) {
  const palmW = dist2D(lm[0], lm[9], aspect) || 1e-4;
  const pinch = dist2D(lm[4], lm[8], aspect) / palmW;

  // 捏合 ≈ 0.2，完全张开 ≈ 0.95 以上
  const openness = smoothstep(0.20, 0.92, pinch);

  // 手掌中心（取腕部 + 指根平均）
  let sx = 0, sy = 0;
  for (const i of [0, 5, 9, 13, 17]) { sx += lm[i].x; sy += lm[i].y; }
  const cx = 1 - sx / 5;   // 镜像，和预览画面一致
  const cy = sy / 5;

  // 手掌朝向（腕 → 中指根），竖直时约 -PI/2
  const roll = Math.atan2(
    (lm[9].x - lm[0].x) * aspect,
    lm[9].y - lm[0].y
  );

  // 五指伸展数量（用于状态文案）
  const tips = [8, 12, 16, 20];
  const pips = [6, 10, 14, 18];
  let extended = 0;
  for (let i = 0; i < 4; i++) {
    if (dist2D(lm[tips[i]], lm[0], aspect) > dist2D(lm[pips[i]], lm[0], aspect) * 1.18) extended++;
  }

  return { openness, pinch, cx, cy, roll, extended };
}

export class HandTracker {
  constructor() {
    this.landmarker = null;
    this.stream = null;
    this.lastTs = -1;
    this.ready = false;
    this.backend = '—';
  }

  async load(onStage = () => {}) {
    // 优先用本地文件（离线可用、加载快），失败再回退 CDN
    const sources = [
      { bundle: LOCAL_BUNDLE, wasm: LOCAL_WASM, tag: 'local' },
      { bundle: CDN_BUNDLE, wasm: CDN_WASM, tag: 'cdn' },
    ];
    let lastErr = null;

    for (const src of sources) {
      let HandLandmarker = null;
      let vision = null;

      try {
        onStage('正在载入识别引擎…');
        const mod = await import(/* @vite-ignore */ src.bundle);
        HandLandmarker = mod.HandLandmarker;

        onStage('正在准备推理环境…');
        vision = await mod.FilesetResolver.forVisionTasks(src.wasm);
      } catch (err) {
        lastErr = err;
        console.warn(`[hand] 引擎加载失败（${src.tag}）`, err);
        continue;
      }

      onStage('正在载入手部模型…');

      for (const delegate of ['GPU', 'CPU']) {
        for (const model of [LOCAL_MODEL, CDN_MODEL]) {
          try {
            this.landmarker = await HandLandmarker.createFromOptions(vision, {
              baseOptions: { modelAssetPath: model, delegate },
              runningMode: 'VIDEO',
              numHands: 1,
              minHandDetectionConfidence: 0.5,
              minHandPresenceConfidence: 0.5,
              minTrackingConfidence: 0.5,
            });
            this.backend = delegate;
            this.ready = true;
            return true;
          } catch (err) {
            lastErr = err;
            console.warn(`[hand] ${delegate} + ${model} 失败`, err);
          }
        }
      }
    }

    throw lastErr || new Error('手部模型加载失败');
  }

  async openCamera(videoEl) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头（需要 https 或 localhost）');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
      },
    });
    videoEl.srcObject = this.stream;
    await videoEl.play();

    if (videoEl.readyState < 2) {
      await new Promise((res) => {
        const onReady = () => { videoEl.removeEventListener('loadeddata', onReady); res(); };
        videoEl.addEventListener('loadeddata', onReady);
      });
    }
    return this.stream;
  }

  /* 返回第一个检测到的手，没有则返回 null */
  detect(videoEl) {
    if (!this.ready || !videoEl || videoEl.readyState < 2 || !videoEl.videoWidth) return null;

    const ts = Math.max(performance.now(), this.lastTs + 1);
    this.lastTs = ts;

    let res;
    try {
      res = this.landmarker.detectForVideo(videoEl, ts);
    } catch (err) {
      return null;
    }
    const lm = res?.landmarks?.[0];
    if (!lm) return null;

    const aspect = (videoEl.videoWidth || 4) / (videoEl.videoHeight || 3);
    return { landmarks: lm, gesture: analyzeHand(lm, aspect) };
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.landmarker?.close) {
      try { this.landmarker.close(); } catch (_) {}
      this.landmarker = null;
    }
    this.ready = false;
  }
}

/* 把手部骨架画到主画布上 */
export function drawSkeleton(ctx, landmarks, w, h) {
  if (!landmarks) return;
  const px = (p) => [(1 - p.x) * w, p.y * h];

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 连线
  ctx.strokeStyle = 'rgba(255, 160, 205, 0.42)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    const [x1, y1] = px(landmarks[a]);
    const [x2, y2] = px(landmarks[b]);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();

  // 关节点
  for (let i = 0; i < landmarks.length; i++) {
    const [x, y] = px(landmarks[i]);
    const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;
    ctx.beginPath();
    ctx.arc(x, y, isTip ? 4.2 : 2.4, 0, Math.PI * 2);
    ctx.fillStyle = isTip ? 'rgba(255, 225, 240, 0.95)' : 'rgba(255, 175, 215, 0.7)';
    ctx.fill();
  }

  // 拇指-食指连线：这条线就是控制花开的那条"弦"
  const [tx, ty] = px(landmarks[4]);
  const [ix, iy] = px(landmarks[8]);
  ctx.beginPath();
  ctx.setLineDash([5, 5]);
  ctx.moveTo(tx, ty);
  ctx.lineTo(ix, iy);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.restore();
}
