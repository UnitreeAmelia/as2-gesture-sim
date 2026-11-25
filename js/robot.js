/* ══════════════════════════════════════════════════════
   robot.js — 用 unitree_mujoco 的 AS2 网格搭出可驱动的四足
   坐标沿用 MJCF（x 前 / y 左 / z 上），最外层再转成 three 的 y-up
   ══════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { STLLoader } from '../vendor/STLLoader.js';
import { solveLeg, LEGS, HIP_X, HIP_Y, THIGH_DY, L1, L2 } from './gait.js';

/* 网格优先本地，缺失时回退到 unitree_mujoco 仓库的原始文件 */
const MESH_BASES = [
  'meshes/',
  'https://raw.githubusercontent.com/unitreerobotics/unitree_mujoco/main/unitree_robots/as2/meshes/',
];

function makeMaterials() {
  return {
    body: new THREE.MeshStandardMaterial({
      color: 0xdde3ec, metalness: 0.4, roughness: 0.44, side: THREE.DoubleSide,
    }),
    leg: new THREE.MeshStandardMaterial({
      color: 0xc2c9d6, metalness: 0.48, roughness: 0.38, side: THREE.DoubleSide,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: 0x30333c, metalness: 0.35, roughness: 0.66, side: THREE.DoubleSide,
    }),
    foot: new THREE.MeshStandardMaterial({
      color: 0x22242b, metalness: 0.15, roughness: 0.82,
    }),
  };
}

export class AS2 {
  constructor() {
    this.root = new THREE.Group();   // 世界位姿（位置 + yaw）
    this.body = new THREE.Group();   // MJCF 坐标
    this.body.rotation.x = -Math.PI / 2;
    this.root.add(this.body);

    this.mats = makeMaterials();
    this.legs = {};
    this.loaded = false;
  }

  async load(onProgress = () => {}) {
    const loader = new STLLoader();
    const names = ['base_link', 'FL_hip', 'FL_thigh', 'FL_calf', 'RL_hip', 'RL_thigh', 'RL_calf'];

    let geo = null;
    let lastErr = null;
    for (const base of MESH_BASES) {
      try {
        const loaded = {};
        for (let i = 0; i < names.length; i++) {
          const n = names[i];
          onProgress(i / names.length, n);
          loaded[n] = await loader.loadAsync(`${base}${n}.STL`);
          loaded[n].computeBoundingBox();
          loaded[n].computeBoundingSphere();
        }
        geo = loaded;
        break;
      } catch (err) {
        lastErr = err;
        console.warn('[mesh] 该来源失败：', base, err.message);
      }
    }
    if (!geo) throw lastErr || new Error('AS2 网格加载失败');

    // 躯干
    const bodyMesh = new THREE.Mesh(geo['base_link'], this.mats.body);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    this.body.add(bodyMesh);

    // 四条腿：前腿用 FL 组、后腿用 RL 组；右侧把网格沿 y 镜像
    for (const leg of LEGS) {
      const front = leg.sx > 0;
      const prefix = front ? 'FL' : 'RL';
      const mirror = leg.sy < 0 ? -1 : 1;

      const hip = new THREE.Group();
      hip.position.set(leg.sx * HIP_X, leg.sy * HIP_Y, 0);

      const thigh = new THREE.Group();
      thigh.position.set(0, leg.sy * THIGH_DY, 0);

      const calf = new THREE.Group();
      calf.position.set(0, 0, -L1);

      const ankle = new THREE.Group();
      ankle.position.set(0, 0, -L2);

      const hipMesh = new THREE.Mesh(geo[`${prefix}_hip`], this.mats.leg);
      const thighMesh = new THREE.Mesh(geo[`${prefix}_thigh`], this.mats.leg);
      const calfMesh = new THREE.Mesh(geo[`${prefix}_calf`], this.mats.leg);

      for (const m of [hipMesh, thighMesh, calfMesh]) {
        m.scale.y = mirror;
        m.castShadow = true;
        m.receiveShadow = true;
      }

      // 脚垫（原模型那个 STL 单个 3.4MB，换成等尺寸的球体）
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 12), this.mats.foot);
      foot.castShadow = true;
      foot.position.z = 0;

      hip.add(hipMesh, thigh);
      thigh.add(thighMesh, calf);
      calf.add(calfMesh, ankle);
      ankle.add(foot);
      this.body.add(hip);

      this.legs[leg.name] = { hip, thigh, calf, ankle, target: new THREE.Vector3() };
    }

    this.onProgress = onProgress;
    this.loaded = true;
    return this;
  }

  /* footTargets: 机身坐标系下的四只脚位置（米，z 向上） */
  setFootTargets(targets) {
    if (!this.loaded) return;
    for (let i = 0; i < LEGS.length; i++) {
      const leg = LEGS[i];
      const rig = this.legs[leg.name];
      const t = targets[i];

      // 转成相对髋关节的位移
      const dx = t.x - leg.sx * HIP_X;
      const dy = t.y - leg.sy * HIP_Y;
      const dz = t.z;

      const q = solveLeg(dx, dy, Math.min(dz, -0.08), leg.sy * THIGH_DY);
      rig.hip.rotation.x = q.q1;
      rig.thigh.rotation.y = q.q2;
      rig.calf.rotation.y = q.q3;
    }
  }

  setPose(position, yaw) {
    this.root.position.copy(position);
    this.root.rotation.y = yaw;
  }
}
