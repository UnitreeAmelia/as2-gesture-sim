/* ══════════════════════════════════════════════════════
   gait.js — AS2 的腿部逆运动学与 trot 步态
   尺寸全部取自 unitree_mujoco/unitree_robots/as2/as2.xml
   ══════════════════════════════════════════════════════ */

export const L1 = 0.212;        // 大腿  hip → knee
export const L2 = 0.21344;      // 小腿  knee → foot
export const HIP_X = 0.2119;    // 髋关节前后位置
export const HIP_Y = 0.06;      // 髋关节左右位置
export const THIGH_DY = 0.1054; // 大腿相对髋的横向偏置
export const FOOT_Y = HIP_Y + THIGH_DY;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);

/* ── 单腿逆运动学 ──────────────────────────────
   输入：脚相对「髋关节原点」的目标位移 (dx, dy, dz)，单位米，z 向下为负
         dyOff：大腿相对髋的横向偏置（左腿 +0.1054，右腿 -0.1054）
   输出：三个关节角（MJCF 约定，弧度）
        q1 髋 绕 x 轴（正 = 腿往 +y 侧摆）
        q2 大腿 绕 y 轴（正 = 往后摆）
        q3 小腿 绕 y 轴（负 = 膝盖前折）

   关键：髋转动时，大腿的横向偏置也跟着一起转，所以腿平面不是过髋原点、
   而是过「转过 q1 之后的大腿关节」。不处理这一项，站立时四腿会外撇近 20°。
   ───────────────────────────────────────────── */
export function solveLeg(dx, dy, dz, dyOff = 0) {
  // 1. 整条腿（含横向偏置）在髋坐标系里是一条定长向量
  const dTot = Math.hypot(dx, dy, dz);

  // 2. 反解出「未转动时」大腿根到脚的 z 分量
  const pz = -Math.sqrt(Math.max(0, dTot * dTot - dx * dx - dyOff * dyOff));

  // 3. 髋关节角 = 目标方向角 - 偏置方向角
  const q1 = Math.atan2(dz, dy) - Math.atan2(pz, dyOff);

  // 4. 之后的平面二连杆：目标 (dx, -r)，r 是到髋的竖直距离
  const r = -pz;
  let d = Math.hypot(dx, r);
  d = clamp(d, Math.abs(L1 - L2) + 1e-4, L1 + L2 - 1e-4);

  const cosQ3 = clamp((d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1);
  const q3 = -Math.acos(cosQ3);                       // 膝盖一律前折

  const alpha = Math.atan2(-dx, r);                   // 目标方向相对 -z
  const beta = Math.atan2(L2 * Math.sin(q3), L1 + L2 * Math.cos(q3));
  const q2 = alpha - beta;

  return { q1, q2, q3 };
}

/* 正运动学：返回值用来验证 IK 是否真的把脚送到了目标点 */
export function legFK(q1, q2, q3, dyOff = 0) {
  const px = -L1 * Math.sin(q2) - L2 * Math.sin(q2 + q3);
  const pz = -L1 * Math.cos(q2) - L2 * Math.cos(q2 + q3);
  return {
    x: px,
    y: dyOff * Math.cos(q1) - pz * Math.sin(q1),
    z: dyOff * Math.sin(q1) + pz * Math.cos(q1),
  };
}

/* ── trot 步态 ─────────────────────────────────
   对角腿同相：FL+RR 一组，FR+RL 另一组
   ───────────────────────────────────────────── */
export const LEGS = [
  { name: 'FL', sx: 1, sy: 1, phase: 0.0 },
  { name: 'FR', sx: 1, sy: -1, phase: 0.5 },
  { name: 'RL', sx: -1, sy: 1, phase: 0.5 },
  { name: 'RR', sx: -1, sy: -1, phase: 0.0 },
];

export class Gait {
  constructor() {
    this.phase = 0;
    this.height = 0.285;   // 站立时躯干离地高度
    this.duty = 0.55;      // 支撑相占空比
    this.lift = 0.055;     // 抬脚高度
    this.freq = 0;         // 当前步频
    this.stride = { x: 0, y: 0 };
    this.speed = 0;
    this.footTargets = LEGS.map((l) => ({
      x: l.sx * HIP_X,
      y: l.sy * FOOT_Y,
      z: -this.height,
    }));
  }

  /**
   * @param dt    帧间隔
   * @param vx    前进速度 m/s
   * @param vy    横移速度 m/s
   * @param vyaw  转向角速度 rad/s
   */
  update(dt, vx, vy, vyaw) {
    const speed = Math.hypot(vx, vy);
    const turnRate = Math.abs(vyaw);

    // 速度决定步频与步长；起步时轻微加速，避免从静止突然跳步
    const moving = speed > 0.015 || turnRate > 0.06;
    const targetFreq = moving ? 1.7 + Math.min(speed, 1.6) * 1.05 + turnRate * 0.32 : 0;
    this.speed = lerp(this.speed, speed, 1 - Math.exp(-dt * 6));

    this.freq = moving ? lerp(this.freq || targetFreq, targetFreq, 1 - Math.exp(-dt * 4)) : 0;

    if (moving) {
      this.phase = (this.phase + this.freq * dt) % 1;
    } else {
      // 停下时把相位缓慢收回到 0，四脚回到中立位
      this.phase = this.phase < 0.5 ? lerp(this.phase, 0, 1 - Math.exp(-dt * 5)) : 1 + lerp(this.phase, 1, 1 - Math.exp(-dt * 5));
    }

    const Tst = this.freq > 0.01 ? this.duty / this.freq : 1;

    for (let i = 0; i < LEGS.length; i++) {
      const leg = LEGS[i];
      const nomX = leg.sx * HIP_X;
      const nomY = leg.sy * FOOT_Y;

      // 该脚位置处，机身速度带来的相对位移（含转向的切向分量）
      const vLegX = vx - vyaw * nomY;
      const vLegY = vy + vyaw * nomX;
      const sx = vLegX * Tst;
      const sy = vLegY * Tst;

      let u = (this.phase + leg.phase) % 1;
      if (u < 0) u += 1;

      let px, py, pz;
      if (u < this.duty) {
        // 支撑相：脚相对机身向后滑
        const s = u / this.duty;
        px = nomX + sx * (0.5 - s);
        py = nomY + sy * (0.5 - s);
        pz = -this.height;
      } else {
        // 摆动相：抬脚前送
        const s = (u - this.duty) / (1 - this.duty);
        const e = smoothstep(s);
        px = nomX + sx * (e - 0.5);
        py = nomY + sy * (e - 0.5);
        pz = -this.height + this.lift * Math.sin(Math.PI * s);
      }

      this.footTargets[i].x = px;
      this.footTargets[i].y = py;
      this.footTargets[i].z = pz;
    }

    return this.footTargets;
  }

  /* 躯干随步态轻微起伏 */
  bob() {
    return Math.sin(this.phase * Math.PI * 4) * 0.009 * Math.min(1, this.speed * 3);
  }
}
