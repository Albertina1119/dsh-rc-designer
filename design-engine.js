/*!
 * design-engine.js —— RC 飞行器总体设计引擎
 *
 * 覆盖：机型库 / 锚点池 / 维度识别与推理路径 / 参数补全 / NACA 推荐 /
 *       公式计算 / 约束校验 / 多目标评分 / 多方案择优 / Top3 / 锁定重算 /
 *       命名模块 / 只读快照
 *
 * 依赖 airfoil-lib.js（浏览器为全局 AeroLib，Node 下自动 require）
 */
(function (root, factory) {
  const lib = (typeof module === 'object' && module.exports)
    ? require('./airfoil-lib.js')
    : root.AeroLib;
  const api = factory(lib);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DesignEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Aero) {
  'use strict';
  if (!Aero) throw new Error('design-engine.js 需要 airfoil-lib.js');

  const G = 9.80665;
  const clamp = Aero.clamp;
  const round = function (v, n) {
    if (!isFinite(v)) return v;
    const p = Math.pow(10, n == null ? 3 : n);
    return Math.round(v * p) / p;
  };
  const VERSION = '1.0.0';

  /* =======================================================================
   * 1. 机型库：设计区间 / 目标值 / 加权规则
   * ===================================================================== */
  const TYPES = [
    {
      id: 'trainer', name: '固定翼 · 练习机', short: '练习机', style: 'trainer',
      anchors: { ar: 6.0, wl: 45, twr: 0.65, vmax: 22, span: 1.2, mass: 1.2 },
      range: {
        ar: [4.5, 8.0], wl: [25, 65], twr: [0.45, 1.0], vmax: [14, 30], stall: [6, 12],
        vh: [0.40, 0.70], vv: [0.030, 0.060], sm: [8, 20], re: [8e4, 4e5], pmax: [120, 320]
      },
      weights: { stability: 1.35, range: 0.85, speed: 0.7, cost: 1.1, easyfly: 1.35, buildability: 1.15 },
      notes: '低速和缓、失速温和，重心容错大，适合入门与日常飞行。'
    },
    {
      id: 'glider', name: '滑翔机 / 长航时', short: '滑翔机', style: 'glider',
      anchors: { ar: 9.5, wl: 30, twr: 0.30, vmax: 16, span: 2.0, mass: 0.9 },
      range: {
        ar: [6.5, 16.0], wl: [15, 55], twr: [0.18, 0.70], vmax: [10, 26], stall: [4.5, 10],
        vh: [0.38, 0.65], vv: [0.022, 0.055], sm: [6, 18], re: [6e4, 3e5], pmax: [60, 200]
      },
      weights: { stability: 1.1, range: 1.6, speed: 0.45, cost: 0.9, easyfly: 1.05, buildability: 0.95 },
      notes: '追求升阻比与低翼载，滞空时间长，起降依赖手抛或牵引。'
    },
    {
      id: '3d', name: '3D 特技机', short: '3D 机', style: '3d',
      anchors: { ar: 5.0, wl: 32, twr: 1.9, vmax: 24, span: 1.1, mass: 0.9 },
      range: {
        ar: [4.0, 6.5], wl: [20, 55], twr: [1.3, 2.8], vmax: [16, 32], stall: [5, 10],
        vh: [0.42, 0.72], vv: [0.035, 0.070], sm: [2, 10], re: [5e4, 2.5e5], pmax: [400, 1200]
      },
      weights: { stability: 0.75, range: 0.6, speed: 0.9, cost: 0.9, easyfly: 0.7, buildability: 1.0 },
      notes: '推重比 1.3 以上、舵面大、重心靠后，强调悬停与暴力机动。'
    },
    {
      id: 'racer', name: '竞速机', short: '竞速机', style: 'racer',
      anchors: { ar: 4.5, wl: 75, twr: 1.6, vmax: 42, span: 0.8, mass: 0.9 },
      range: {
        ar: [3.2, 6.0], wl: [50, 140], twr: [0.9, 2.6], vmax: [28, 70], stall: [10, 20],
        vh: [0.35, 0.60], vv: [0.028, 0.055], sm: [5, 15], re: [1.5e5, 9e5], pmax: [400, 1500]
      },
      weights: { stability: 1.0, range: 0.4, speed: 1.8, cost: 0.7, easyfly: 0.55, buildability: 0.85 },
      notes: '小展弦比薄翼、高翼载高功率，速度优先，低速特性苛刻。'
    },
    {
      id: 'cargo', name: '载重 / FPV 平台', short: '载重机', style: 'cargo',
      anchors: { ar: 6.5, wl: 70, twr: 0.75, vmax: 20, span: 1.6, mass: 3.0 },
      range: {
        ar: [5.0, 9.5], wl: [45, 120], twr: [0.50, 1.1], vmax: [13, 28], stall: [8, 14],
        vh: [0.42, 0.72], vv: [0.032, 0.062], sm: [8, 20], re: [1.2e5, 6e5], pmax: [110, 260]
      },
      weights: { stability: 1.25, range: 1.15, speed: 0.55, cost: 0.95, easyfly: 1.0, buildability: 1.2 },
      notes: '厚翼大翼面积、结构强，强调载荷能力与飞行稳定性。'
    },
    {
      id: 'endurance', name: '长航时 / 巡航', short: '长航时机', style: 'endurance',
      anchors: { ar: 8.0, wl: 45, twr: 0.55, vmax: 19, span: 1.8, mass: 1.8 },
      range: {
        ar: [6.0, 12.0], wl: [28, 80], twr: [0.35, 0.95], vmax: [12, 28], stall: [6, 12],
        vh: [0.40, 0.68], vv: [0.030, 0.058], sm: [8, 20], re: [1e5, 5e5], pmax: [90, 220]
      },
      weights: { stability: 1.15, range: 1.55, speed: 0.6, cost: 0.9, easyfly: 0.95, buildability: 1.0 },
      notes: '低翼载高升阻比，巡航效率优先，滞空时间最大化。'
    },
    {
      id: 'multirotor', name: '多旋翼', short: '多旋翼', style: 'cargo', rotary: true,
      anchors: { wl: 90, twr: 2.0, vmax: 15, mass: 1.5, disk: 80, nrotor: 4 },
      range: {
        wl: [40, 200], twr: [1.6, 3.2], vmax: [8, 28], disk: [30, 250], stall: [0, 1],
        ar: [0, 0], vh: [0, 0], vv: [0, 0], sm: [0, 0], re: [0, 0], pmax: [120, 400]
      },
      weights: { stability: 1.3, range: 1.3, speed: 0.7, cost: 1.0, easyfly: 1.4, buildability: 1.1 },
      notes: '旋翼悬停，桨盘载荷决定悬停功率；结构简单但续航受电池限制。',
      params: [
        { key: 'nrotor', label: '旋翼数量', unit: '个', min: 3, max: 8, step: 1, kind: 'int', def: 4, hint: '四旋翼=4，六旋翼=6' },
        { key: 'disk', label: '桨盘载荷', unit: 'N/m²', min: 30, max: 250, step: 5, kind: 'num', def: 80, hint: '悬停拉力/桨盘面积，FPV 常用 50~120' }
      ]
    },
    {
      id: 'heli', name: '直升机', short: '直升机', style: 'cargo', rotary: true,
      anchors: { wl: 200, twr: 1.8, vmax: 20, mass: 2.0, disk: 250, nrotor: 1 },
      range: {
        wl: [80, 450], twr: [1.4, 2.6], vmax: [10, 32], disk: [100, 450], stall: [0, 1],
        ar: [0, 0], vh: [0, 0], vv: [0, 0], sm: [0, 0], re: [0, 0], pmax: [150, 500]
      },
      weights: { stability: 1.2, range: 1.1, speed: 0.75, cost: 0.95, easyfly: 0.85, buildability: 0.85 },
      notes: '主旋翼桨盘载荷高，悬停功率大，传动与尾桨设计难度高。',
      params: [
        { key: 'nrotor', label: '主旋翼数量', unit: '个', min: 1, max: 3, step: 1, kind: 'int', def: 1, hint: '共轴双旋翼填 2' },
        { key: 'disk', label: '桨盘载荷', unit: 'N/m²', min: 100, max: 450, step: 10, kind: 'num', def: 250, hint: '直升机通常 150~400 N/m²' }
      ]
    }
  ];
  const TYPE_BY_ID = {};
  TYPES.forEach(function (t) { TYPE_BY_ID[t.id] = t; });

  /* =======================================================================
   * 2. 锚点池（覆盖几何 / 重量 / 动力 / 性能 / 风格 5 个维度）
   * ===================================================================== */
  const DIMENSIONS = {
    geometry: { name: '几何', color: '#4cc9f0' },
    weight: { name: '重量', color: '#f9c74f' },
    power: { name: '动力', color: '#f8961e' },
    performance: { name: '性能', color: '#90be6d' },
    style: { name: '风格', color: '#c77dff' }
  };

  const ANCHORS = [
    { id: 'span', label: '翼展', unit: 'm', dim: 'geometry', min: 0.3, max: 4.0, step: 0.05, def: 1.2, rotaryOk: false },
    { id: 'area', label: '翼面积', unit: 'm²', dim: 'geometry', min: 0.03, max: 1.2, step: 0.01, def: 0.25, rotaryOk: false },
    { id: 'ar', label: '展弦比', unit: '', dim: 'geometry', min: 2.5, max: 18, step: 0.1, def: 6.0, rotaryOk: false },
    { id: 'taper', label: '梢根比', unit: '', dim: 'geometry', min: 0.3, max: 1.0, step: 0.05, def: 0.7, rotaryOk: false },
    { id: 'chord', label: '平均弦长', unit: 'm', dim: 'geometry', min: 0.05, max: 0.6, step: 0.005, def: 0.2, rotaryOk: false },
    { id: 'mass', label: '起飞重量', unit: 'kg', dim: 'weight', min: 0.08, max: 12, step: 0.05, def: 1.2 },
    { id: 'wl', label: '翼载', unit: 'g/dm²', dim: 'weight', min: 10, max: 200, step: 1, def: 45 },
    { id: 'payload', label: '有效载荷', unit: 'kg', dim: 'weight', min: 0, max: 6, step: 0.05, def: 0.3 },
    { id: 'voltage', label: '电池电压', unit: 'V', dim: 'power', min: 3.7, max: 50, step: 0.1, def: 14.8 },
    { id: 'kv', label: '电机 KV', unit: 'KV', dim: 'power', min: 60, max: 4000, step: 10, def: 1000 },
    { id: 'prop', label: '桨径', unit: 'in', dim: 'power', min: 3, max: 30, step: 0.5, def: 10 },
    { id: 'capa', label: '电池容量', unit: 'mAh', dim: 'power', min: 300, max: 30000, step: 100, def: 3000 },
    { id: 'twr', label: '推重比', unit: '', dim: 'power', min: 0.15, max: 3.5, step: 0.05, def: 0.65 },
    { id: 'vmax', label: '目标最大速度', unit: 'm/s', dim: 'performance', min: 6, max: 80, step: 0.5, def: 22 },
    { id: 'vstall', label: '目标失速速度', unit: 'm/s', dim: 'performance', min: 3, max: 22, step: 0.5, def: 8 },
    { id: 'endurance', label: '目标续航', unit: 'min', dim: 'performance', min: 2, max: 180, step: 1, def: 12 },
    { id: 'style', label: '飞行风格', unit: '', dim: 'style', min: 1, max: 5, step: 1, kind: 'enum', rotaryOk: false,
      options: [{ v: 1, t: '1 极稳（慢速、容错优先）' }, { v: 2, t: '2 稳（练习/休闲）' }, { v: 3, t: '3 均衡（通用）' }, { v: 4, t: '4 灵活（特技倾向）' }, { v: 5, t: '5 激进（极限性能）' }] },
    { id: 'disk', label: '桨盘载荷', unit: 'N/m²', dim: 'performance', min: 30, max: 450, step: 5, def: 80, rotaryOnly: true },
    { id: 'nrotor', label: '旋翼数量', unit: '个', dim: 'geometry', min: 1, max: 8, step: 1, kind: 'int', def: 4, rotaryOnly: true }
  ];
  const ANCHOR_BY_ID = {};
  ANCHORS.forEach(function (a) { ANCHOR_BY_ID[a.id] = a; });

  const CELL = 1.225;   // 海平面空气密度 kg/m³

  /* ---------- 动力系统模型常数 ----------
   * 无量纲形式（n = 转/秒，D = 米）：T = CT·ρ·n²·D⁴ ，P = CP·ρ·n³·D⁵
   * 标定依据：10×4.7 桨 @8000 rpm ≈ 9 N 静推力、约 110 W 轴功率
   */
  /* ---------- 动力系统模型常数 ----------
   * 无量纲形式（n = 转/秒，D = 米）：T = CT·ρ·n²·D⁴ ，P = CP·ρ·n³·D⁵
   * 标定依据（模型界实测）：10×4.7 桨 @8000~9500 rpm ≈ 9 N 静推力、约 110 W 轴功率；
   * 5×4.5 桨 @2300 KV/4S ≈ 800 g 拉力、约 260 W 输入功率。
   * 绝对推力不确定度约 ±20%，用于方案比选与量级判断足够可靠。
   */
  const PROP_CT = 0.095;
  const PROP_CP = 0.022;
  const MOTOR_KT_FRAC = 0.95;   // Kt ≈ 0.95/Kv（含效率修正）
  const STALL_FACTOR = 3.0;     // 堵转电流上限 ≈ 3× 持续电流（决定静态峰值扭矩）
  const ETA_ESC = 0.95;         // 电调效率
  const PROP_PITCH_RATIO = 0.58;

  /**
   * 常用无刷电机库（按定子尺寸分档，参数为同级别典型值）
   *   R0 等效内阻 Ω、I0 空载电流 A、imax 持续电流 A、mass 重量 g
   *   propMin / propMax：该级别合理的桨径区间（in），超出即为不合理搭配
   */
  const MOTORS = [
    { name: '1104', kv: [4000, 6000, 7500], R0: 0.85, I0: 1.30, imax: 9, mass: 6, propMin: 2, propMax: 3.5, rpmMax: 55000 },
    { name: '1407', kv: [2800, 3600, 4100], R0: 0.55, I0: 1.20, imax: 16, mass: 12, propMin: 2.5, propMax: 4.5, rpmMax: 48000 },
    { name: '1806', kv: [1400, 2300, 2700], R0: 0.40, I0: 0.90, imax: 22, mass: 20, propMin: 3, propMax: 6.0, rpmMax: 40000 },
    { name: '2204', kv: [1400, 1800, 2300], R0: 0.30, I0: 0.70, imax: 26, mass: 25, propMin: 4, propMax: 7.0, rpmMax: 36000 },
    { name: '2205', kv: [1500, 2300, 2600], R0: 0.26, I0: 0.70, imax: 30, mass: 28, propMin: 4, propMax: 7.0, rpmMax: 36000 },
    { name: '2207', kv: [1400, 1800, 2450], R0: 0.22, I0: 0.80, imax: 38, mass: 32, propMin: 4, propMax: 8.0, rpmMax: 34000 },
    { name: '2212', kv: [920, 1000, 1400, 2200], R0: 0.20, I0: 0.70, imax: 30, mass: 52, propMin: 6, propMax: 11.0, rpmMax: 22000 },
    { name: '2216', kv: [800, 900, 1100], R0: 0.15, I0: 0.80, imax: 34, mass: 68, propMin: 8, propMax: 12.0, rpmMax: 18000 },
    { name: '2814', kv: [700, 870, 1000], R0: 0.095, I0: 1.10, imax: 42, mass: 105, propMin: 9, propMax: 14.0, rpmMax: 15000 },
    { name: '3520', kv: [520, 700, 850], R0: 0.058, I0: 1.50, imax: 55, mass: 175, propMin: 11, propMax: 16.0, rpmMax: 13000 },
    { name: '4250', kv: [410, 500, 620], R0: 0.038, I0: 2.00, imax: 70, mass: 270, propMin: 13, propMax: 18.0, rpmMax: 11500 },
    { name: '5055', kv: [300, 400, 470], R0: 0.026, I0: 2.80, imax: 90, mass: 380, propMin: 15, propMax: 22.0, rpmMax: 10000 }
  ];

  /**
   * 螺旋桨-电机静态工作点求解
   *   桨扭矩  Q = P_aero / (2π·n)   ，P_aero = CP·ρ·n³·D⁵·kTip（计入桨尖损失）
   *   电机扭矩 Q = Kt·(V − Ke·ω)/R0 − Kt·I0，电流上限 3× 持续电流
   * 返回 { rpm, current, thrust, powerMech, powerElec, eta, overCurrent, stalled }
   */
  function solvePowerPoint(motor, kv, voltage, propM) {
    // KV 单位 rpm/V：空载时 ω_rad/s = V·(2π/60)·kv，故 Ke = 60/(2π·kv) (V·s/rad)
    const ke = (MOTOR_KT_FRAC * 60) / (2 * Math.PI * kv);
    const kt = ke;                                          // N·m/A（SI 下数值相等）
    const R0 = motor.R0;
    const rpmNoLoad = (voltage / ke) * (60 / (2 * Math.PI));
    const rpmCap = Math.min(motor.rpmMax, rpmNoLoad);
    const D4 = Math.pow(propM, 4), D5 = Math.pow(propM, 5);
    const qPropAt = function (rpm) {
      const n = Math.max(0, rpm) / 60;
      return (PROP_CP * CELL * n * n * n * D5 * tipLoss(rpm, propM)) / (2 * Math.PI * Math.max(1e-6, n));
    };
    const iAt = function (rpm) {
      const w = (Math.max(0, rpm) / 60) * 2 * Math.PI;
      return Math.max(0, (voltage - ke * w) / R0 - motor.I0);
    };
    const qMotorAt = function (rpm) { return kt * iAt(rpm); };
    const f = function (rpm) { return qMotorAt(rpm) - qPropAt(rpm); };
    // 转速上限：电机机械极限或空载转速
    const capped = f(rpmCap) > 0;
    let lo = 0, hi = rpmCap;
    if (!capped) {
      for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        if (f(mid) > 0) lo = mid; else hi = mid;
      }
    }
    const rpm = capped ? rpmCap : (lo + hi) / 2;
    const n = rpm / 60;
    const thrust = PROP_CT * CELL * n * n * D4;
    const powerMech = PROP_CP * CELL * n * n * n * D5 * tipLoss(rpm, propM);
    const current = iAt(rpm);
    const powerElec = voltage * current;
    return {
      rpm: rpm, current: current, thrust: thrust, powerMech: powerMech, powerElec: powerElec,
      R0: R0, rpmCap: rpmCap, capped: capped,
      eta: powerElec > 0.5 ? clamp(powerMech / powerElec, 0.1, 0.92) : 0.5,
      overCurrent: current > motor.imax,
      overloaded: current > motor.imax * 1.4
    };
  }
  /** 桨尖损失：桨尖接近压缩性时效率下降（实测标定，含粘性损失下限） */
  function tipLoss(rpm, propM) {
    const vt = ((rpm / 60) * 2 * Math.PI * (propM / 2)) / 343;
    return Math.max(0.30, 1 / (1 + 6 * Math.pow(Math.max(0, vt - 0.25), 1.4)));
  }

  /**
   * 在「电机 × KV × 桨径」组合空间里搜索满足目标静推力的最佳配置
   * 目标函数：推力误差 + 超电流惩罚 + 过载/轻载惩罚 + 重量惩罚 + 锁定值贴近惩罚
   */
  function pickPowerCombo(targetN, voltage, hints) {
    const h = hints || {};
    const out = [];
    MOTORS.forEach(function (motor) {
      motor.kv.forEach(function (kv) {
        const ke = MOTOR_KT_FRAC / kv * (2 * Math.PI / 60);
        const rpmNoLoad = (voltage / ke) * (60 / (2 * Math.PI));
        for (let D = 3; D <= 24; D += 0.5) {
          if (D < motor.propMin - 0.1 || D > motor.propMax + 0.1) continue;   // 不合理的电机-桨搭配
          const sol = solvePowerPoint(motor, kv, voltage, D * 0.0254);
          if (!(sol.thrust > 0.05)) continue;
          const idleFrac = sol.rpm / Math.max(1, rpmNoLoad);
          const thrustErr = Math.abs(sol.thrust - targetN) / Math.max(0.3, targetN);
          // 硬性不合理：转速被上限卡住（桨太小带不动）、过载、超电流、转速过高
          if (sol.capped) continue;
          const overload = idleFrac < 0.40;
          const hardOver = sol.current > motor.imax * 1.05;
          const tooFast = sol.rpm > Math.min(motor.rpmMax, 26000) * 0.98;
          if (overload || hardOver || tooFast) continue;
          const overPen = sol.current > motor.imax * 0.9 ? (sol.current / (motor.imax * 0.9) - 1) * 1.5 : 0;
          const lightPen = idleFrac > 0.95 ? (idleFrac - 0.95) * 3 : 0;       // 大马拉小车
          const massPen = (motor.mass / 380) * 0.45;                          // 偏好轻量
          const sizePen = D > 16 ? (D - 16) * 0.06 : 0;                       // 超大桨不便携
          const kvPen = h.kv ? Math.abs(Math.log(kv / h.kv)) * 0.30 : 0;
          const Dpen = h.prop ? Math.abs(D - h.prop) * 0.06 : 0;
          out.push({
            motor: motor, kv: kv, D: D, sol: sol,
            cost: thrustErr * 2.6 + overPen + lightPen + massPen + sizePen + kvPen + Dpen
          });
        }
      });
    });
    out.sort(function (a, b) { return a.cost - b.cost; });
    if (out.length) return out;
    // 兜底：放宽约束再搜一次，保证任何推力需求都有方案
    MOTORS.forEach(function (motor) {
      motor.kv.forEach(function (kv) {
        for (let D = 3; D <= 24; D += 0.5) {
          if (D < motor.propMin - 0.1 || D > motor.propMax + 0.1) continue;
          const sol = solvePowerPoint(motor, kv, voltage, D * 0.0254);
          if (!(sol.thrust > 0.05)) continue;
          out.push({
            motor: motor, kv: kv, D: D, sol: sol,
            cost: Math.abs(sol.thrust - targetN) / Math.max(0.3, targetN) * 3 + (motor.mass / 380) * 0.6
          });
        }
      });
    });
    out.sort(function (a, b) { return a.cost - b.cost; });
    return out;
  }

  /* ---------- 预计算：静推力 → 最佳动力配置（避免候选池生成时重复搜索） ---------- */
  const COMBO_CACHE = {};
  function powerTable(voltage) {
    const key = voltage.toFixed(2);
    if (COMBO_CACHE[key]) return COMBO_CACHE[key];
    const T = [], rows = [];
    for (let i = 0; i <= 40; i++) {
      T.push(2 + i * 2);                                   // 2 N ~ 82 N，步长 2 N
    }
    T.forEach(function (target) { rows.push(pickPowerCombo(target, voltage, {})[0] || null); });
    COMBO_CACHE[key] = { T: T, rows: rows };
    return COMBO_CACHE[key];
  }
  /** 按目标静推力取最接近的预计算配置，并按锁定值微调 */
  function pickPowerComboFast(targetN, voltage, hints) {
    const h = hints || {};
    const tab = powerTable(voltage);
    let idx = 0, bestD = Infinity;
    for (let i = 0; i < tab.T.length; i++) {
      const d = Math.abs(tab.T[i] - targetN);
      if (d < bestD) { bestD = d; idx = i; }
    }
    let pick = tab.rows[idx];
    if (!pick) return null;
    // 若用户锁定了桨径或 KV，在候选里挑最贴近的（小范围重搜，代价可控）
    if (h.prop || h.kv) {
      const cands = pickPowerCombo(targetN, voltage, h);
      if (cands.length) pick = cands[0];
    }
    return pick;
  }

  /** 由电池节数得到标称电压 */
  function packVoltage(cells) { return cells * 3.7; }

  /* =======================================================================
   * 3. 工具
   * ===================================================================== */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** 梯形评分：目标值 tol 内满分，超出后线性衰减，范围外为 0 */
  function tentScore(value, target, tol, rangeSpan) {
    if (!isFinite(value)) return 0;
    const d = Math.abs(value - target);
    if (d <= tol) return 100;
    const decay = Math.max(tol * 3, rangeSpan);
    return Math.max(0, 100 * (1 - (d - tol) / decay));
  }
  function inBand(v, band) { return v >= band[0] && v <= band[1]; }
  function bandScore(v, band) {
    if (!isFinite(v)) return 0;
    if (v >= band[0] && v <= band[1]) return 100;
    const span = band[1] - band[0];
    const d = v < band[0] ? band[0] - v : v - band[1];
    return Math.max(0, 100 * (1 - d / Math.max(span, 1e-6) / 1.5));
  }
  function bandPenalty(v, band, hardFactor) {
    if (v >= band[0] && v <= band[1]) return 0;
    const span = Math.max(band[1] - band[0], 1e-6);
    const d = v < band[0] ? (band[0] - v) / span : (v - band[1]) / span;
    return d * hardFactor;
  }

  /* =======================================================================
   * 4. 维度识别与推理路径
   *     依据用户输入锚点落在各机型设计区间内的程度，推断机型与推荐路径
   * ===================================================================== */
  function inferType(anchors) {
    const numeric = Object.keys(anchors).filter(function (k) {
      const a = ANCHOR_BY_ID[k];
      return a && a.kind !== 'enum' && isFinite(anchors[k]) && anchors[k] !== null && anchors[k] !== '';
    });
    const style = Number(anchors.style || 0);
    const rotorWanted = isFinite(anchors.disk) || isFinite(anchors.nrotor);
    const dims = {};
    numeric.forEach(function (k) { dims[ANCHOR_BY_ID[k].dim] = (dims[ANCHOR_BY_ID[k].dim] || 0) + 1; });
    if (style) dims.style = 1;
    const dimList = Object.keys(dims);

    const scores = TYPES.map(function (t) {
      let s = 0, hits = 0;
      const detail = [];
      const r = t.range;
      const isRotary = !!t.rotary;
      if (r.ar && r.ar[1] > 0 && isFinite(anchors.ar)) { const p = bandPenalty(anchors.ar, r.ar, 1.4); s -= p; hits++; detail.push('展弦比 ' + round(anchors.ar, 1) + (p === 0 ? ' 命中' : ' 偏离' + round(p, 2))); }
      if (isFinite(anchors.wl)) { const p = bandPenalty(anchors.wl, r.wl, 1.5); s -= p; hits++; detail.push('翼载 ' + round(anchors.wl, 0) + (p === 0 ? ' 命中' : ' 偏离' + round(p, 2))); }
      if (isFinite(anchors.twr)) { const p = bandPenalty(anchors.twr, r.twr, 1.2); s -= p; hits++; detail.push('推重比 ' + round(anchors.twr, 2) + (p === 0 ? ' 命中' : ' 偏离' + round(p, 2))); }
      if (isFinite(anchors.vmax)) { const p = bandPenalty(anchors.vmax, r.vmax, 1.0); s -= p; hits++; detail.push('目标速度 ' + round(anchors.vmax, 0) + (p === 0 ? ' 命中' : ' 偏离' + round(p, 2))); }
      if (isFinite(anchors.disk) && r.disk) { const p = bandPenalty(anchors.disk, r.disk, 1.2); s -= p; hits++; }

      // 风格锚点带强指向性
      if (style) {
        if (style === 5 && t.id === 'racer') s += 0.9;
        if (style === 5 && t.id === '3d') s += 0.9;
        if (style >= 4 && (t.id === 'racer' || t.id === '3d')) s += 0.5;
        if (style <= 2 && (t.id === 'trainer' || t.id === 'glider')) s += 0.5;
        if (style === 3 && !t.rotary && t.id !== 'trainer') s += 0.2;
        if (rotorWanted && !isRotary) s -= 1.8;
        if (rotorWanted && isRotary) s += 0.5;
        if (!rotorWanted && isRotary) s -= 1.0;
      } else {
        if (rotorWanted) { if (!t.rotary) s -= 1.8; }
        else if (t.rotary) s -= 0.4;
      }

      // 多旋翼 / 直升机判别：桨盘载荷 + 旋翼数量
      if (isFinite(anchors.disk)) {
        if (t.id === 'multirotor') s += anchors.disk <= 140 ? 0.7 : -0.9;
        if (t.id === 'heli') s += anchors.disk >= 160 ? 0.7 : -0.9;
      }
      if (isFinite(anchors.nrotor)) {
        if (t.id === 'multirotor') s += anchors.nrotor >= 3 ? 0.8 : -1.0;
        if (t.id === 'heli') s += anchors.nrotor <= 2 ? 0.8 : -1.0;
      }

      // 展弦比锚点是很好的判别器
      if (isFinite(anchors.ar) && !isRotary) {
        if (anchors.ar >= 7.5) {
          if (t.id === 'glider') s += 0.5;
          else if (t.id === 'endurance') s += (isFinite(anchors.wl) && anchors.wl >= 35) ? 0.8 : 0.35;
          else s -= 0.2;
        }
        if (anchors.ar <= 5.5) { if (t.id === '3d' || t.id === 'racer') s += 0.4; else s -= 0.15; }
      }
      // 翼载/推重比组合进一步区分滑翔机与长航时
      if (!isRotary && isFinite(anchors.wl) && isFinite(anchors.twr)) {
        if (t.id === 'glider' && anchors.wl <= 32 && anchors.twr <= 0.45) s += 0.3;
        if (t.id === 'endurance' && anchors.wl >= 38) s += 0.3;
      }
      // 超小推重比是无动力滑翔机的强特征
      if (!isRotary && isFinite(anchors.twr) && anchors.twr < 0.25) {
        if (t.id === 'glider') s += 0.7; else if (t.id === 'endurance') s -= 0.3;
      }
      // 电池电压 + KV 组合暗示大功率小机体（3D/竞速）
      if (isFinite(anchors.voltage) && isFinite(anchors.kv)) {
        const hot = anchors.kv / (anchors.voltage * 10);
        if (hot > 8 && (t.id === '3d' || t.id === 'racer')) s += 0.3;
        if (hot < 2 && (t.id === 'trainer' || t.id === 'cargo')) s += 0.2;
      }
      return { type: t, score: s, hits: hits, detail: detail };
    });

    scores.sort(function (a, b) { return b.score - a.score; });
    const best = scores[0];
    const margin = scores.length > 1 ? best.score - scores[1].score : 1;

    const core = numeric.filter(function (k) { return ['wl', 'twr', 'ar', 'vmax', 'vstall', 'span', 'mass', 'disk'].indexOf(k) >= 0; }).length;
    let conf = core >= 3 ? 92 : core === 2 ? 80 : core === 1 ? 62 : 45;
    if (margin > 1.2) conf += 5;
    if (margin < 0.25) conf -= 8;
    conf = clamp(conf, 25, 96);

    // 推理路径描述
    let path, why;
    if (core >= 3) { path = '多锚点收敛'; why = '基于 ' + core + ' 个核心性能锚点直接匹配机型设计区间，参数补全依赖度低。'; }
    else if (core >= 1) { path = '性能锚点主导'; why = '以性能锚点定位机型，几何与动力参数由模板基线插值补全。'; }
    else if (isFinite(anchors.span) || isFinite(anchors.area) || isFinite(anchors.mass)) { path = '几何/重量锚点反推'; why = '从尺寸与重量出发，按该机型的经验比例反推翼载、推重比与速度目标。'; }
    else if (isFinite(anchors.voltage) || isFinite(anchors.kv) || isFinite(anchors.prop)) { path = '动力系统反推'; why = '从动力配置估计可用推力与速度，再反推翼面积与重量。'; }
    else { path = '模板基线推导'; why = '锚点信息有限，主要由机型模板基线与规则库补全。'; }

    return {
      typeId: best.type.id, typeName: best.type.name, confidence: Math.round(conf),
      path: path, why: why, dims: dimList,
      ranking: scores.map(function (x) { return { id: x.type.id, name: x.type.short, score: round(x.score, 2) }; })
    };
  }

  /* =======================================================================
   * 5. 参数补全：模板基线 + 规则库
   * ===================================================================== */
  /**
   * 把用户锚点与机型基线合并成完整输入集，并记录每个参数的来源
   * 来源标记：anchor（用户锚点）/ baseline（机型模板）/ derived（规则推导）
   *
   * 需要联立求解的关系组：
   *   几何组1：area = b² / AR
   *   几何组2：area = m[kg]·1000 / (wl[g/dm²]·100)
   */
  function completeAnchors(anchors, type, anchorKeys) {
    const values = {}, src = {};
    const R = type.range;
    const num = function (v) { return isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : null; };
    // 真正的“用户锚点”集合：只有这些键算 anchor，其余都是模板基线或规则推导
    const userKeys = {};
    (anchorKeys || Object.keys(anchors || {})).forEach(function (k) { userKeys[k] = 1; });

    // 1) 模板基线打底
    Object.keys(type.anchors).forEach(function (k) {
      const a = ANCHOR_BY_ID[k];
      values[k] = a ? clamp(type.anchors[k], a.min, a.max) : type.anchors[k];
      src[k] = 'baseline';
    });
    // 2) 用户锚点覆盖（并按锚点定义夹取）
    Object.keys(anchors || {}).forEach(function (k) {
      const a = ANCHOR_BY_ID[k];
      if (!a) return;
      const v = num(anchors[k]);
      if (v === null) return;
      values[k] = clamp(v, a.min, a.max);
      src[k] = userKeys[k] ? 'anchor' : 'baseline';
    });

    const clampAr = function (v) { return R.ar && R.ar[1] > 0 ? clamp(v, R.ar[0], R.ar[1]) : v; };
    const clampWl = function (v) { return clamp(v, R.wl[0], R.wl[1]); };
    const hasArea = function () { return src.area === 'anchor'; };
    const isAnchor = function (k) { return src[k] === 'anchor'; };

    // 3) 模板可能未声明 area / taper，这里用规则补齐基线，避免后续出现 NaN
    if (!isFinite(values.area)) {
      values.area = isFinite(values.mass) && isFinite(values.wl) ? (values.mass * 10) / values.wl : 0.25;
      src.area = 'baseline';
    }
    if (!isFinite(values.span)) {
      const arRef = isFinite(values.ar) && values.ar > 0 ? values.ar : 6;
      values.span = Math.sqrt(Math.max(0.001, values.area) * arRef);
      src.span = 'baseline';
    }
    if (!isFinite(values.taper)) { values.taper = 0.7; src.taper = 'baseline'; }
    if (!isFinite(values.prop)) { values.prop = 10; src.prop = 'baseline'; }
    if (!isFinite(values.kv)) { values.kv = 1000; src.kv = 'baseline'; }
    if (!isFinite(values.voltage)) { values.voltage = 11.1; src.voltage = 'baseline'; }
    if (!isFinite(values.capa)) { values.capa = 3000; src.capa = 'baseline'; }
    if (!isFinite(values.payload)) { values.payload = 0; src.payload = 'baseline'; }

    // 3) 几何组：展示/计算所需的翼展与翼面积必须优先确定下来
    if (isAnchor('area')) {
      if (isAnchor('span')) values.ar = clampAr((values.span * values.span) / values.area);
      else { values.span = Math.sqrt(values.area * clampAr(values.ar)); src.span = 'derived'; }
      if (!isAnchor('ar')) src.ar = 'derived';
      if (!isAnchor('span')) src.span = 'derived';
    } else if (isAnchor('ar') && isAnchor('span')) {
      values.area = (values.span * values.span) / values.ar; src.area = 'derived';
    } else if (isAnchor('ar') && isAnchor('chord')) {
      values.area = Math.pow(values.ar * values.chord * values.chord, 1); src.area = 'derived';   // S = AR·c̄²
      values.span = values.ar * values.chord; src.span = 'derived';
    } else if (isAnchor('span') && isAnchor('chord')) {
      values.area = values.span * values.chord; src.area = 'derived';
      values.ar = clampAr((values.span * values.span) / values.area); src.ar = 'derived';
    }

    // 4) 重量组：area = m·10/wl  ⇒  由翼载与重量互换
    if (isAnchor('wl') && !hasArea()) {
      const mRef = isAnchor('mass') ? values.mass : values.mass;
      values.area = (mRef * 10) / values.wl; src.area = 'derived';
    } else if (isAnchor('mass') && isAnchor('wl')) {
      values.area = (values.mass * 10) / values.wl; src.area = 'derived';
    } else if (isAnchor('mass') && hasArea()) {
      values.wl = clampWl((values.mass * 10) / values.area); src.wl = 'derived';
    } else if (isAnchor('wl') && hasArea()) {
      values.mass = (values.wl * values.area) / 10; src.mass = 'derived';
    }

    // 5) 由最终确定的面积/重量补齐这对关系中的另一项（保持物理自洽）
    if (!isAnchor('wl')) {
      if (isFinite(values.mass) && isFinite(values.area) && values.area > 0) { values.wl = clampWl((values.mass * 10) / values.area); src.wl = 'derived'; }
    }
    if (!isAnchor('mass') && !isAnchor('wl')) {
      if (isFinite(values.wl) && isFinite(values.area)) { values.mass = (values.wl * values.area) / 10; src.mass = 'derived'; }
    } else if (isAnchor('wl') && !isAnchor('mass')) {
      values.mass = (values.wl * values.area) / 10; src.mass = 'derived';
    }
    if (!isAnchor('span') && isAnchor('ar') && isAnchor('area')) { values.span = Math.sqrt(values.ar * values.area); src.span = 'derived'; }
    values.area = clamp(values.area, 0.01, 3.0);
    values.span = clamp(values.span, 0.15, 6.0);
    values.mass = clamp(values.mass, 0.03, 20);

    // 5b) 关键一致性修正：翼展与翼面积确定后，派生出的展弦比必须落在该机型合理区间内。
    //     否则会出现 AR=60 这类荒谬结果（例如滑翔机翼展 2 m 但只装 100 g）。
    if (R.ar && R.ar[1] > 0 && !isAnchor('ar')) {
      const arNow = (values.span * values.span) / values.area;
      if (arNow < R.ar[0] * 0.92 || arNow > R.ar[1] * 1.08) {
        const arUse = arNow < R.ar[0] ? R.ar[0] : R.ar[1];
        if (!isAnchor('span')) {
          values.span = clamp(Math.sqrt(arUse * values.area), 0.15, 6.0);
          values.ar = arUse; src.span = 'derived';
        } else {
          values.area = clamp((values.span * values.span) / arUse, 0.01, 3.0);
          values.ar = arUse; src.area = 'derived';
        }
        if (!isAnchor('wl')) values.wl = clampWl((values.mass * 10) / values.area);
      } else {
        values.ar = arNow;
      }
    }

    // 6) 动力与目标值推导
    if (isAnchor('voltage')) {
      values.cells = Math.max(1, Math.round(values.voltage / 3.7)); src.cells = 'derived';
    } else if (!values.cells) {
      values.cells = Math.max(1, Math.round((values.voltage || 11.1) / 3.7)); src.cells = 'derived';
    }
    if (isFinite(values.mass) && isFinite(values.area) && values.area > 0) {
      // 目标巡航升力系数（按 1.3 倍失速速度的经验点）
      const vRef = 1.3 * Math.sqrt((2 * values.mass * G) / (CELL * values.area * 1.4)) || 12;
      values.needCl = clamp((2 * values.mass * G) / (CELL * values.area * Math.max(6, vRef * vRef)), 0.2, 1.6);
      src.needCl = 'derived';
    }
    if (!isAnchor('prop') && isFinite(values.kv)) {
      const V = isFinite(values.voltage) ? values.voltage : 11.1;
      // 经验：桨径(in) ≈ 30 / (KV·√(V/11.1)/1000) 的一半，取常见搭配
      const rpm = values.kv * V;
      values.prop = clamp(Math.round((60 / Math.max(2, rpm / 1000)) * 2) / 2, 4, 26);
      src.prop = 'derived';
    }
    // 7) 风格锚点保持枚举原值
    if (!isAnchor('style')) values.style = values.style || 3;
    return { values: values, source: src };
  }

  /* =======================================================================
   * 6. 核心公式计算
   * ===================================================================== */
  function computeCore(inp, type, airfoil, opts) {
    const o = opts || {};
    const S = inp.area, b = inp.span, m = inp.mass;
    const W = m * G;
    const lambda = clamp(inp.taper == null ? 0.7 : inp.taper, 0.3, 1);
    const pf = Aero.planform(b, S, lambda);
    const AR = pf.ar;

    const sweep = clamp(o.sweep == null ? 0 : o.sweep, -5, 35);
    const dihedral = clamp(o.dihedral == null ? type.sweepDefault || 5 : o.dihedral, -5, 15);
    const twist = clamp(o.twist == null ? 0 : o.twist, -6, 4);

    // --- 翼型与升力 / 阻力（旋翼机型按机臂-短舱处理，不参与升力面计算） ---
    const af = airfoil || Aero.estimate('NACA 2412', (type.anchors.vmax || 20) * pf.mac / 1.81e-5);
    let a3dPerDeg = NaN, a3dPerDegDeg = NaN, clMax3d = NaN, vStall = NaN, reStall = NaN;
    let reCruise = NaN, aStall3d = NaN, Swet = NaN, cd0 = NaN, e = NaN, k = NaN;
    let clMd = NaN, ldMax = NaN, vMd = NaN;
    if (!o.rotary) {
      a3dPerDeg = Aero.liftCurveSlope(af.a0, AR, sweep);                     // 1/rad
      a3dPerDegDeg = a3dPerDeg * (Math.PI / 180);                            // 1/deg
      clMax3d = af.clmax * (0.88 + 0.12 * clamp(AR / 8, 0.4, 1.15));         // 有限翼展 3D CLmax 经验折减
      vStall = Math.sqrt((2 * W) / (CELL * S * Math.max(0.4, clMax3d)));
      reStall = Aero.reynolds(vStall, pf.mac, CELL);
      reCruise = Aero.reynolds(type.anchors.vmax || 20, pf.mac, CELL);
      aStall3d = af.aStall - (af.clmax - clMax3d) / Math.max(0.02, a3dPerDegDeg);
      Swet = 2.02 * S * (1 + 0.6 * af.tc);
      const cd0fuse = 0.0022;
      cd0 = clamp((af.cd0 * Swet) / S + cd0fuse + 0.0007 * (1 + Math.abs(sweep) / 30), 0.008, 0.12);
      e = clamp(1.78 * (1 - 0.045 * Math.pow(AR, 0.68)) - 0.64, 0.55, 0.98);
      k = 1 / (Math.PI * AR * e);
      clMd = Math.sqrt(cd0 / k);
      ldMax = 1 / (2 * Math.sqrt(cd0 * k));
      vMd = Math.sqrt((2 * W) / (CELL * S * clMd));
    }
    const wl = (m * 1000) / (S * 100);                                       // g/dm²
    const wingLoading = W / S;                                               // N/m²

    // --- 尾翼与重心（迭代两次收敛；旋翼机型无此部分） ---
    const qRatio = 0.92;
    let lh = 0.55 * b, Sh = 0, Sv = 0, lv = lh;
    const bands = { vh: type.range.vh, vv: type.range.vv };
    let acPct = 0.25, cgPct = 0.25, acWing = 0.25;
    let vh = 0, vv = 0;
    let staticMargin = 0;
    for (let it = 0; !o.rotary && it < 3; it++) {
      Sh = (bands.vh ? (bands.vh[0] + bands.vh[1]) / 2 : 0.5) * S * pf.mac / Math.max(0.15, lh);
      Sv = (bands.vv ? (bands.vv[0] + bands.vv[1]) / 2 : 0.04) * S * b / Math.max(0.15, lv);
      // 机翼 + 平尾 组合焦点
      const dEps = 0.35;
      const tailLift = (qRatio * Sh * a3dPerDeg * (1 - dEps)) / (S * a3dPerDeg);
      acWing = 0.25 * Math.cos((sweep * Math.PI) / 180) + 0.02;
      acPct = (acWing + tailLift * (lh / pf.mac)) / (1 + tailLift);
      const smTarget = clamp(0.5 * (type.range.sm[0] + type.range.sm[1]), type.range.sm[0], type.range.sm[1]);
      cgPct = clamp(acPct - smTarget / 100, 0.10, 0.45);
      lh = Math.max(0.2, 0.25 * pf.mac + (0.42 * b) - (cgPct - 0.25) * pf.mac);
      lv = lh;
      vh = (Sh * lh) / (S * pf.mac);
      vv = (Sv * lv) / (S * b);
    }
    const mac = pf.mac, acMM = acPct * mac;
    const cgMM = cgPct * mac;
    staticMargin = (acPct - cgPct) * 100;
    // 旋翼机型没有机翼-尾翼配平概念，这些字段不参与校验
    if (o.rotary) { acPct = null; cgPct = null; staticMargin = null; }

    // --- 动力系统 ---
    const rhoAtField = CELL;
    const payload = isFinite(inp.payload) ? inp.payload : 0;
    let power = null, rotary = null;

    if (!type.rotary) {
      const twr = isFinite(inp.twr) ? inp.twr : 0.65;
      const targetThrust = twr * W;
      const V = isFinite(inp.voltage) ? inp.voltage : 11.1;
      const capa = isFinite(inp.capa) ? inp.capa : 3000;
      const cells = isFinite(inp.cells) ? inp.cells : Math.max(1, Math.round(V / 3.7));
      // 只有用户显式锚定的桨径/KV 才作为硬约束，否则在组合空间里自动择优
      const srcMap = o.source || {};
      const kvHint = (srcMap.kv === 'anchor' && isFinite(inp.kv) && inp.kv > 0) ? inp.kv : null;
      const propHint = (srcMap.prop === 'anchor' && isFinite(inp.prop) && inp.prop > 0) ? inp.prop : null;

      // 优先尊重用户锁定的桨径 / KV，否则在「电机 × KV × 桨径」空间里搜索
      let propIn, kv, sol, motor;
      if (propHint && kvHint) {
        propIn = propHint; kv = kvHint;
        motor = MOTORS.reduce(function (best, m) {
          const inRange = m.kv.some(function (k) { return Math.abs(k - kvHint) / kvHint < 0.35; });
          const sizeFit = Math.abs(m.propMax - propHint);
          const score = (inRange ? 0 : 10) + sizeFit + m.mass / 1000;
          return (!best || score < best._s) ? Object.assign({}, m, { _s: score }) : best;
        }, null);
        sol = solvePowerPoint(motor, kv, V, propIn * 0.0254);
      } else {
        const c0 = pickPowerComboFast(targetThrust, V, { kv: kvHint, prop: propHint });
        if (c0) { propIn = c0.D; kv = c0.kv; sol = c0.sol; motor = c0.motor; }
        else { propIn = propHint || 10; kv = kvHint || 1000; motor = MOTORS[6]; sol = solvePowerPoint(motor, kv, V, propIn * 0.0254); }
      }
      const propM = propIn * 0.0254;
      const Aprop = Math.PI * Math.pow(propM / 2, 2);
      const thrustMax = sol.thrust;
      const Twr = thrustMax / W;
      const pMax = sol.powerElec;
      const pitch = round(propIn * PROP_PITCH_RATIO, 1);
      const pitchSpeed = (sol.rpm / 60) * (pitch * 0.0254);

      // 巡航状态（按目标速度的 0.78，且高于 1.25 倍失速速度）
      const vCruise = clamp((type.anchors.vmax || 20) * 0.78, vStall * 1.25, 60);
      const clCruise = (2 * W) / (CELL * S * vCruise * vCruise);
      const cdCruise = cd0 + k * clCruise * clCruise;
      const dragCruise = 0.5 * CELL * vCruise * vCruise * S * cdCruise;
      const pCruiseMech = dragCruise * vCruise;
      const pCruiseElec = pCruiseMech / Math.max(0.3, sol.eta * ETA_ESC);
      const energyWh = (capa / 1000) * (cells * 3.7);
      const enduranceMin = (energyWh * 0.8) / Math.max(5, pCruiseElec) * 60;
      const iCruise = pCruiseElec / Math.max(4, V);
      const escA = Math.max(20, Math.ceil((sol.current * 1.25) / 5) * 5);

      const warnings = [];
      if (Twr < twr * 0.92) warnings.push('该配置的可用静推力 ' + round(thrustMax, 2) + ' N 低于目标 ' + round(targetThrust, 2) + ' N（实际推重比 ' + round(Twr, 2) + '），建议加大桨径或提高电压');
      if (sol.current > motor.imax) warnings.push('静态电流 ' + round(sol.current, 1) + ' A 超过 ' + motor.name + ' 的持续电流 ' + motor.imax + ' A，需换更大电机');
      if (sol.rpm > 30000) warnings.push('静态转速 ' + round(sol.rpm, 0) + ' rpm 偏高，桨尖马赫数与噪音偏大');
      if (pitchSpeed < (inp.vmax || 20) * 1.15) warnings.push('桨距速度 ' + round(pitchSpeed, 1) + ' m/s 低于目标最大速度，高速段推力会明显衰减');

      power = {
        kind: 'propeller', twrTarget: twr, targetThrust: targetThrust,
        staticThrust: thrustMax, staticTwr: Twr,
        propIn: propIn, propPitch: pitch, pitchRatio: PROP_PITCH_RATIO, pitchSpeed: pitchSpeed,
        kv: kv, motor: motor.name, motorMass: motor.mass, motorImax: motor.imax,
        cells: cells, voltage: V, capacity: capa,
        powerStatic: pMax, powerStaticMech: sol.powerMech,
        powerCruiseMech: pCruiseMech, powerCruiseElec: pCruiseElec,
        currentStatic: sol.current, currentCruise: iCruise, rpmStatic: sol.rpm,
        loadFactor: sol.rpm / Math.max(1, (V / (MOTOR_KT_FRAC / kv)) * (60 / (2 * Math.PI))),
        escA: escA, energyWh: energyWh, enduranceMin: enduranceMin,
        vCruise: vCruise, diskLoadingProp: thrustMax / Aprop, efficiency: sol.eta,
        warnings: warnings, autoSelected: !(propHint && kvHint)
      };
    } else {
      const nrotor = clamp(Math.round(inp.nrotor || (type.id === 'heli' ? 1 : 4)), 1, 8);
      const dl = isFinite(inp.disk) ? inp.disk : (type.id === 'heli' ? 250 : 80);
      const diskArea = W / dl;                                  // m²  总桨盘面积
      const rotorDia = 2 * Math.sqrt(diskArea / nrotor / Math.PI);
      const fm = type.id === 'heli' ? 0.62 : 0.70;
      const pHover = Math.pow(W, 1.5) / (fm * Math.sqrt(2 * CELL * diskArea));
      const pElec = pHover / 0.78;
      const capa = isFinite(inp.capa) ? inp.capa : 5000;
      const cells = isFinite(inp.cells) ? inp.cells : Math.max(1, Math.round((inp.voltage || 14.8) / 3.7));
      const energyWh = (capa / 1000) * (cells * 3.7);
      const enduranceMin = (energyWh * 0.8) / Math.max(5, pElec) * 60;
      const hoverTwr = 1.0;
      const twr = isFinite(inp.twr) ? inp.twr : (type.id === 'heli' ? 1.8 : 2.0);
      const vMax = Math.sqrt(Math.max(1, (twr * W) / (0.5 * CELL * diskArea * 1.1)));
      rotary = {
        kind: type.id === 'heli' ? 'helicopter' : 'multirotor', nrotor: nrotor, diskLoading: dl,
        diskArea: diskArea, rotorDia: rotorDia, hoverTwr: hoverTwr, twrTarget: twr,
        powerHover: pHover, powerHoverElec: pElec, currentHover: pElec / Math.max(4, (inp.voltage || 14.8)),
        cells: cells, batteryVoltage: inp.voltage || 3.7 * cells, capacity: capa, energyWh: energyWh,
        enduranceMin: enduranceMin, vMaxEstimate: vMax,
        bladeChord: type.id === 'heli' ? (0.05 * rotorDia) : rotorDia * 0.12,
        escA: Math.max(20, Math.ceil((pElec / Math.max(4, inp.voltage || 14.8)) * 1.3 / 5) * 5)
      };
    }

    // --- 性能 ---
    const thrustAvail = !type.rotary ? power.staticThrust : rotary.twrTarget * W;
    // 最大平飞速度：可用推力随速度衰减（桨距速度处归零），与阻力曲线求交
    const propPitchSpeed = !type.rotary && power ? power.pitchSpeed : 0;
    const thrustAt = function (v) {
      if (!propPitchSpeed || v >= propPitchSpeed) return 0;
      const x = v / propPitchSpeed;
      return thrustAvail * clamp(1 - 0.55 * x * x - 0.45 * Math.pow(x, 6), 0, 1);
    };
    const vMaxCalc = (function () {
      let lo = 1, hi = propPitchSpeed ? Math.min(propPitchSpeed * 0.98, 130) : 130;
      if (hi <= lo) return vStall;
      for (let i = 0; i < 70; i++) {
        const v = (lo + hi) / 2;
        const cl = (2 * W) / (CELL * S * v * v);
        const cd = cd0 + k * cl * cl;
        const D = 0.5 * CELL * v * v * S * cd;
        if (D < thrustAt(v)) lo = v; else hi = v;
      }
      return (lo + hi) / 2;
    })();
    const clAtVmax = (2 * W) / (CELL * S * vMaxCalc * vMaxCalc);
    const pLevelMax = 0.5 * CELL * vMaxCalc * vMaxCalc * S * (cd0 + k * clAtVmax * clAtVmax) * vMaxCalc;
    const pAvail = power && power.kind === 'propeller' ? power.powerStatic : (rotary ? rotary.powerHoverElec * 0.85 : 0);
    const roc = Math.max(0, (pAvail * 0.72 - pLevelMax) / W);
    const sinkRate = 1 / Math.max(0.5, ldMax) * Math.sqrt((2 * W) / (CELL * S)) * 0.85;
    const turnRadius = (vStall * 1.35) * (vStall * 1.35) / (G * Math.sqrt(Math.max(0.01, Math.pow(Math.max(1, thrustAvail / W), 2) - 1)));

    // --- 结构 ---
    const nLimit = { trainer: 4.5, glider: 5.5, '3d': 8.0, racer: 9.0, cargo: 4.0, endurance: 4.5, multirotor: 3.0, heli: 4.0 }[type.id] || 5;
    const halfSpan = b / 2;
    const wlN = W / S;
    // 翼根弯矩：均布升力悬臂梁 + 过载 + 安全系数
    const rootMoment = ((wlN * halfSpan * halfSpan) / 8) * nLimit * 1.5;
    const sparH = clamp(af.tc * pf.root * 0.7, 0.006, 0.08);
    const sigma = 0.9e9;                                   // 碳纤维许用弯曲应力（含 1.5 安全系数）
    const sparArea = rootMoment / (sigma * sparH * 0.8);
    // 碳管按薄壁圆管定尺寸（壁厚取常见规格），蒙皮分担部分弯矩故按 80% 计
    const wall = rootMoment > 60 ? 0.0015 : rootMoment > 15 ? 0.0012 : 0.001;
    const Wr = rootMoment / (0.8 * sigma);                 // 需要的截面模量
    let D = 0.006;
    for (let i = 0; i < 40; i++) {
      const di = Math.max(0.0005, D - 2 * wall);
      const sec = (Math.PI / 32) * (Math.pow(D, 4) - Math.pow(di, 4)) / Math.max(1e-6, D);
      D = D + (Wr - sec) / Math.max(1e-9, Math.abs(Wr) + 1e-12) * D * 0.35;
      D = clamp(D, 0.004, 0.045);
    }
    const sparDiaMM = clamp(D * 1000, 4, 45);
    const ribSpacing = clamp(pf.root * 0.55, 0.05, 0.20);
    // 舵机扭矩：铰链力矩主导 + 经验下限（符合模型界常用规格）
    const vRefServo = Math.max(type.anchors.vmax || 20, 12) * 1.3;
    const qDyn = 0.5 * CELL * vRefServo * vRefServo;
    const servoOf = function (fracChord, surfaceFrac, minT) {
      const hinge = 0.10 * qDyn * (S * surfaceFrac) * (pf.mac * fracChord);   // N·m
      const t = (hinge / 0.0980665) * 1.8;                                    // → kg·cm（含连杆效率与余量）
      return round(clamp(Math.max(t, minT), 0.8, 80), 1);
    };
    const bigPlane = S > 0.35;
    const servoAileron = servoOf(0.32, 0.11, type.id === '3d' ? 3.2 : bigPlane ? 3.0 : 1.8);
    const servoElevator = servoOf(0.42, 0.065, type.id === '3d' ? 3.0 : bigPlane ? 2.6 : 1.5);
    const servoRudder = servoOf(0.40, 0.055, bigPlane ? 2.4 : 1.4);
    const materials = {
      trainer: '轻木 + 巴尔沙蒙皮 / EPP 泡沫',
      glider: '碳纤维主梁 + 玻璃纤维蒙皮',
      '3d': '巴尔沙 + 轻木构架，热缩膜蒙皮',
      racer: '碳纤维/凯夫拉复合 + 泡沫夹芯',
      cargo: '泡沫夹芯 + 碳管桁架',
      endurance: '碳管主梁 + 泡沫/玻璃纤维蒙皮',
      multirotor: '碳纤维机架板 + 铝柱',
      heli: '碳纤维机身板 + 铝合金传动'
    }[type.id] || '轻木/泡沫常规结构';

    return {
      planform: pf, ar: AR, span: b, area: S, taper: lambda, sweep: sweep, dihedral: dihedral, twist: twist,
      airfoil: af, a3dPerDeg: a3dPerDeg, a3dPerDegDeg: a3dPerDegDeg, clMax3d: clMax3d,
      mass: m, weight: W, wingLoading: wingLoading, wlGdm2: wl, payload: payload,
      vStall: vStall, reStall: reStall, reCruise: reCruise, aStall3d: aStall3d,
      cd0: cd0, oswald: e, kInduced: k, clMd, ldMax: ldMax, vMd: vMd, swet: Swet,
      tail: {
        lh: lh, lv: lv, Sh: Sh, Sv: Sv, vh: vh, vv: vv,
        elevRatio: 0.40, rudderRatio: 0.38, aileronRatio: clamp(0.28 - (type.id === '3d' ? 0.06 : 0), 0.18, 0.35)
      },
      cg: { mac: mac, acPct: acPct, cgPct: cgPct, acMM: acMM, cgMM: cgMM, staticMargin: staticMargin, thrustLine: '-2° (相对翼弦)' },      power: power, rotary: rotary,
      perf: {
        thrustAvail: thrustAvail, thrustToWeight: thrustAvail / W, vMaxCalc: vMaxCalc,
        propPitchSpeed: propPitchSpeed,
        clAtVmax: clAtVmax, pLevelMax: pLevelMax, pAvail: pAvail, roc: roc, sinkRate: sinkRate,
        turnRadius: turnRadius, ldMax: ldMax, clMd: clMd, vMd: vMd
      },
      structure: {
        nLimit: nLimit, rootMoment: rootMoment, sparH: sparH, sparDiaMM: sparDiaMM,
        ribSpacing: ribSpacing, materials: materials,
        servoAileron: servoAileron, servoElevator: servoElevator, servoRudder: servoRudder,
        safetyFactor: 1.5
      }
    };
  }

  /* =======================================================================
   * 7. 约束校验
   * ===================================================================== */
  function check(core, type) {
    const items = [];
    const add = function (level, cat, name, value, band, msg) {
      items.push({ level: level, cat: cat, name: name, value: value, band: band, msg: msg });
    };
    const soft = function (v, band, cat, name, unit, lowMsg, highMsg) {
      if (!band || band[1] <= 0 || !isFinite(v)) return;
      const p = bandPenalty(v, band, 1);
      if (p === 0) { add('ok', cat, name, round(v, 2) + unit, band[0] + '~' + band[1] + unit, '在经验区间内'); return; }
      const level = p > 0.22 ? 'warn' : 'ok';
      add(level, cat, name, round(v, 2) + unit, band[0] + '~' + band[1] + unit, v < band[0] ? lowMsg : highMsg);
    };
    const cross = function (cond, cat, name, value, msg, level) {
      if (cond) items.push({ level: level || 'warn', cat: cat, name: name, value: value, band: '—', msg: msg });
      else items.push({ level: 'ok', cat: cat, name: name, value: value, band: '—', msg: '无冲突' });
    };
    const R = type.range;

    if (type.rotary) {
      // 旋翼机型：只做范围校验，不做升力面/尾容量校验
      const rw = core.rotary;
      soft(rw && rw.diskLoading, type.range.disk, '经验', '桨盘载荷', ' N/m²', '桨盘载荷偏低，桨径过大', '桨盘载荷偏高，悬停功率大');
      soft(rw && rw.twrTarget, type.range.twr, '经验', '推重比', '', '推重比偏低，抗风与机动能力差', '推重比偏高，电机与电调规格上升');
      cross(rw && rw.enduranceMin < 3, '交叉', '续航 vs 电池', rw ? round(rw.enduranceMin, 1) + ' min' : '—',
        '悬停续航不足 3 分钟，需加大电池容量或减轻重量');
      cross(rw && rw.rotorDia > 0.45, '交叉', '旋翼直径 vs 机架', rw ? round(rw.rotorDia * 1000, 0) + ' mm' : '—',
        '单个旋翼直径超过 450 mm，机架与折叠结构难度上升');
      return items;
    }

    // --- 数值范围（硬） ---
    if (!core || !isFinite(core.area) || core.area <= 0) { add('error', '范围', '翼面积', core && core.area, '>0', '翼面积缺失或不合法'); return items; }
    if (!isFinite(core.mass) || core.mass <= 0) add('error', '范围', '起飞重量', core.mass, '>0', '起飞重量缺失或不合法');
    if (core.span <= 0) add('error', '范围', '翼展', core.span, '>0', '翼展不合法');
    add(core.vStall < 2 ? 'error' : core.vStall > 30 ? 'error' : 'ok', '范围', '失速速度',
      round(core.vStall, 2) + ' m/s', '2~30 m/s', core.vStall > 30 ? '失速速度过高，起降困难' : core.vStall < 2 ? '失速速度过低，翼载过小' : '在合理范围内');
    if (!(core.cd0 < 0.12)) add('error', '范围', '零升阻力', round(core.cd0, 4), '<0.12', '零升阻力异常');

    // --- 经验区间（软/硬交叉） ---
    if (!type.rotary) {
      soft(core.ar, R.ar, '经验', '展弦比', '', '展弦比偏小，诱导阻力大、滑翔差', '展弦比偏大，结构刚度与滚转惯量变差');
      soft(core.wlGdm2, R.wl, '经验', '翼载', ' g/dm²', '翼载偏低，抗风性差', '翼载偏高，失速速度上升、起降变难');
      soft(core.tail.vh, R.vh, '经验', '平尾容量 Vh', '', '平尾容量偏小，俯仰稳定性不足', '平尾容量偏大，平尾阻力与重量增加');
      soft(core.tail.vv, R.vv, '经验', '垂尾容量 Vv', '', '垂尾容量偏小，航向稳定性不足', '垂尾容量偏大，垂尾阻力增加');
      soft(core.cg.staticMargin, R.sm, '经验', '静稳定裕度', ' %MAC', '静稳定裕度偏小，纵向易发散', '静稳定裕度偏大，俯仰配平阻力大、机动迟钝');
      soft(core.reCruise, R.re, '经验', '巡航雷诺数', '', '雷诺数偏低，翼型性能下降明显', '雷诺数偏高（超出模型常用范围）');
    }

    // --- 交叉冲突 ---
    if (!type.rotary) {
      cross(core.vStall > (type.range.stall[1]),
        '交叉', '失速速度 vs 机型期望', round(core.vStall, 1) + ' m/s > ' + type.range.stall[1],
        '失速速度超出该机型期望上限，需加大翼面积或减轻重量', core.vStall > type.range.stall[1] * 1.25 ? 'error' : 'warn');
      cross(core.perf.thrustToWeight < type.range.twr[0],
        '交叉', '推重比 vs 机型期望', round(core.perf.thrustToWeight, 2) + ' < ' + type.range.twr[0],
        '可用推重比低于该机型下限，爬升与加速能力不足', core.perf.thrustToWeight < type.range.twr[0] * 0.75 ? 'error' : 'warn');
      cross(core.wlGdm2 > type.range.wl[1] && core.perf.thrustToWeight < 0.7,
        '交叉', '高翼载 + 低推重比', round(core.wlGdm2, 0) + ' g/dm² / T/W ' + round(core.perf.thrustToWeight, 2),
        '高翼载与低推重比同时出现，起飞距离与盘旋性能会明显恶化');
      cross(core.power && core.power.rpmStatic > 45000 && core.power.propIn < 7,
        '交叉', '电机 KV / 桨径 / 电压匹配', core.power ? round(core.power.rpmStatic, 0) + ' rpm @ ' + core.power.propIn + 'in' : '—',
        '转速过高而桨径偏小，推力效率低，建议降低 KV 或加大桨径');
      cross(core.power && core.power.escA > 0 && core.power.escA > 120,
        '交叉', '电调电流余量', core.power ? core.power.escA + ' A' : '—', '所需电调规格过大，建议提高电压或降低功率');
      cross(core.cg.staticMargin < type.range.sm[0] * 1.6 && type.style === '3d' && core.cg.staticMargin < 3,
        '交叉', '3D 机重心过前', round(core.cg.staticMargin, 1) + ' %MAC', '3D 机需要靠后的重心，否则无法悬停与平旋');
    } else {
      const tw = core.rotary.twrTarget;
      cross(tw < type.range.twr[0], '交叉', '推重比 vs 机型期望', round(tw, 2) + ' < ' + type.range.twr[0],
        '推重比不足，抗风与机动能力差', tw < type.range.twr[0] * 0.85 ? 'error' : 'warn');
      cross(core.rotary.enduranceMin < 3, '交叉', '续航 vs 电池', round(core.rotary.enduranceMin, 1) + ' min',
        '悬停续航不足 3 分钟，需加大电池容量或减轻重量');
    }
    cross(core.aStall3d < 6, '交叉', '失速迎角', round(core.aStall3d, 1) + '°', '可用失速迎角过小，操纵窗口窄');
    cross(core.ldMax < 4, '交叉', '最大升阻比', round(core.ldMax, 1), '升阻比过低，巡航效率差');

    return items;
  }
  function hardFails(items) {
    return items.filter(function (i) { return i.level === 'error'; });
  }

  /* =======================================================================
   * 8. 多目标评分
   * ===================================================================== */
  function score(core, type, consistency) {
    const R = type.range;
    const t = type.anchors;
    const W = type.weights;
    const cons = clamp(consistency == null ? 1 : consistency, 0, 1);
    const S = function (v, target, tol, span) { return tentScore(v, target, tol, span); };

    let stability, range, speed, cost, easyfly, buildability;
    if (!type.rotary) {
      // 稳定性：静稳定裕度 + 尾容量 + 失速裕度
      stability = 0.34 * tentScore(core.cg.staticMargin, (R.sm[0] + R.sm[1]) / 2, (R.sm[1] - R.sm[0]) / 2, 16)
        + 0.22 * tentScore(core.tail.vh, (R.vh[0] + R.vh[1]) / 2, (R.vh[1] - R.vh[0]) / 2, 0.5)
        + 0.16 * tentScore(core.tail.vv, (R.vv[0] + R.vv[1]) / 2, (R.vv[1] - R.vv[0]) / 2, 0.06)
        + 0.14 * tentScore(core.aStall3d, 14, 3, 10)
        + 0.14 * tentScore(core.ldMax, 10, 4, 8);
      // 续航：翼载 + 升阻比 + 功率
      range = 0.38 * tentScore(core.ldMax, Math.max(7, t.ldMaxTarget || 11), 3.5, 8)
        + 0.32 * tentScore(core.wlGdm2, t.wl, 14, 40)
        + 0.30 * tentScore(core.perf.pLevelMax, (core.power ? core.power.powerStatic : 300) * 0.8, 80, 300);
      // 速度：实际可达最大速度 + 低阻 + 推重比
      speed = 0.62 * tentScore(core.perf.vMaxCalc, t.vmax, Math.max(3, t.vmax * 0.2), 14)
        + 0.20 * tentScore(core.cd0, 0.019, 0.007, 0.045)
        + 0.18 * tentScore(core.perf.thrustToWeight, Math.max(t.twr, 0.6), 0.25, 1.4);
      // 成本：功率规模 + 尺寸
      cost = 0.45 * tentScore(core.power ? core.power.powerStatic : 200, 200, 120, 700)
        + 0.25 * tentScore(core.mass, type.id === 'trainer' ? 1.0 : 1.6, 0.8, 5)
        + 0.30 * tentScore(core.span, type.id === 'glider' ? 2.4 : 1.2, 0.6, 2.4);
      // 易飞：失速速度 + 翼载 + 稳定性
      easyfly = 0.40 * tentScore(core.vStall, (R.stall[0] + R.stall[1]) / 2, (R.stall[1] - R.stall[0]) / 2, 9)
        + 0.28 * tentScore(core.wlGdm2, (R.wl[0] + R.wl[1]) / 2, (R.wl[1] - R.wl[0]) / 2, 45)
        + 0.20 * stability
        + 0.12 * tentScore(core.perf.thrustToWeight, Math.max(0.6, t.twr), 0.35, 1.5);
      // 易做：翼型厚度 + 展弦比 + 结构
      buildability = 0.34 * tentScore(core.airfoil.tc * 100, 13, 4, 12)
        + 0.26 * tentScore(core.ar, 6, 2.2, 10)
        + 0.22 * tentScore(core.span, 1.3, 0.7, 2.6)
        + 0.18 * tentScore(core.structure.ribSpacing, 0.11, 0.05, 0.14);
    } else {
      stability = 0.5 * tentScore(core.rotary.twrTarget, 2.0, 0.6, 1.6) + 0.5 * tentScore(core.rotary.nrotor, 4, 1.5, 4);
      range = 0.7 * tentScore(core.rotary.enduranceMin, 12, 8, 40) + 0.3 * tentScore(core.rotary.diskLoading, 80, 40, 200);
      speed = 0.5 * tentScore(core.rotary.vMaxEstimate, 18, 8, 30) + 0.5 * tentScore(core.rotary.twrTarget, 2.2, 0.7, 1.6);
      cost = 0.5 * tentScore(core.rotary.powerHover, 150, 120, 600) + 0.5 * tentScore(core.mass, 1.2, 1.0, 5);
      easyfly = 0.6 * tentScore(core.rotary.twrTarget, 2.2, 0.6, 1.6) + 0.4 * tentScore(core.rotary.diskLoading, 70, 40, 200);
      buildability = 0.6 * tentScore(core.rotary.nrotor, 4, 1.5, 4) + 0.4 * tentScore(core.rotary.rotorDia, 0.25, 0.15, 0.5);
    }

    // 一致性折减：锚点被大幅改动时降低所有维度得分
    const raw = { stability: stability, range: range, speed: speed, cost: cost, easyfly: easyfly, buildability: buildability };
    const wsum = W.stability + W.range + W.speed + W.cost + W.easyfly + W.buildability;
    let total = (stability * W.stability + range * W.range + speed * W.speed + cost * W.cost + easyfly * W.easyfly + buildability * W.buildability) / wsum;

    const label = { stability: '稳定', range: '续航', speed: '速度', cost: '成本', easyfly: '易飞', buildability: '易做' };
    return {
      dimensions: ['stability', 'range', 'speed', 'cost', 'easyfly', 'buildability'].map(function (k) {
        return { key: k, name: label[k], score: Math.round(clamp(raw[k], 0, 100)), weight: W[k] };
      }),
      total: Math.round(clamp(total * (0.75 + 0.25 * cons), 0, 100)),
      consistency: Math.round(cons * 100)
    };
  }

  /* =======================================================================
   * 9. 单方案构建（候选 → 完整方案对象）
   * ===================================================================== */
  function buildPlan(input, type, seedInfo) {
    const completed = completeAnchors(input.anchors || {}, type, input.anchorKeys);
    const values = completed.values;
    const src = completed.source;
    // 合并用户对派生参数的直接指定
    ['sweep', 'dihedral', 'twist', 'airfoil'].forEach(function (k) {
      if (input[k] !== undefined && input[k] !== null && input[k] !== '') values[k] = input[k];
    });

    const ReEst = clamp(values.needCl ? values.mass : 1, 0, 1e6);
    const macGuess = isFinite(values.area) && isFinite(values.span) ? (2 / 3) * ((2 * values.area) / (values.span * 1.7)) * ((1 + 0.7 + 0.49) / 1.7) : 0.2;
    const ReGuess = clamp((values.vmax || 20) * macGuess / 1.81e-5, 3e4, 2e6);
    const af = values.airfoil
      ? Aero.estimate(values.airfoil, ReGuess)
      : (function () {
        const rec = Aero.recommendAirfoils({
          style: type.style, Re: ReGuess,
          needCl: values.needCl, wantLowTorque: type.id === 'glider' || type.id === 'endurance',
          forbidSymmetric: type.id !== '3d'
        }, 1)[0];
        return Aero.estimate(rec ? rec.designation : 'NACA 2412', ReGuess);
      })();

    const core = computeCore(values, type, af, {
      sweep: input.sweep, dihedral: input.dihedral, twist: input.twist,
      rotary: !!type.rotary, source: src
    });
    const constraints = check(core, type);
    const fails = hardFails(constraints);
    const warnings = constraints.filter(function (i) { return i.level === 'warn'; });

    // 一致性：实际结果与用户锚点期望的贴合度
    const cons = (function () {
      let n = 0, acc = 0;
      const cmp = function (actual, target, tol) {
        if (!isFinite(target) || !isFinite(actual)) return;
        n++; acc += clamp(1 - Math.abs(actual - target) / (Math.abs(target) * tol + 1e-9), 0, 1);
      };
      if (src.mass === 'anchor') cmp(core.mass, input.anchors.mass, 0.25);
      if (src.area === 'anchor') cmp(core.area, input.anchors.area, 0.25);
      if (src.wl === 'anchor') cmp(core.wlGdm2, input.anchors.wl, 0.3);
      if (src.vmax === 'anchor') cmp(core.perf.vMaxCalc, input.anchors.vmax, 0.35);
      if (src.vstall === 'anchor') cmp(core.vStall, input.anchors.vstall, 0.35);
      if (src.twr === 'anchor') cmp(core.perf.thrustToWeight, input.anchors.twr, 0.4);
      if (src.ar === 'anchor') cmp(core.ar, input.anchors.ar, 0.25);
      if (src.span === 'anchor') cmp(core.span, input.anchors.span, 0.25);
      return n ? acc / n : 1;
    })();

    const sc = score(core, type, cons);
    return {
      typeId: type.id, typeName: type.name, seed: seedInfo || null,
      values: values, source: src, core: core, constraints: constraints,
      errors: fails, warnings: warnings, score: sc,
      feasible: fails.length === 0,
      confidence: clamp(Math.round(seedInfo && seedInfo.confidence ? seedInfo.confidence : 80), 20, 98)
    };
  }

  /* =======================================================================
   * 10. 候选池生成 + 硬约束过滤 + 多目标排序
   * ===================================================================== */
  /**
   * 生成候选池。freeKeys 中的键由搜索决定（不作为硬锚点），
   * 用于在用户未指定重量/面积时探索"重量-翼载-面积"组合空间。
   */
  function generateCandidates(input, type, freeKeys) {
    const anchors = input.anchors || {};
    const has = function (k) {
      return anchors[k] !== undefined && anchors[k] !== null && anchors[k] !== '' && isFinite(Number(anchors[k]));
    };
    const rand = mulberry32(input.seed == null ? 20240715 : input.seed);
    const free = {};
    (freeKeys || []).forEach(function (k) { free[k] = 1; });
    const anchorKeys = Object.keys(anchors).filter(function (k) { return has(k) && !free[k]; });

    const base = completeAnchors(anchors, type, anchorKeys).values;
    const centerMass = free.mass ? (type.anchors.mass || base.mass) : base.mass;
    const centerArea = free.area
      ? ((isFinite(base.area) && !has('area') && !has('wl'))
        ? (centerMass * 10) / (type.anchors.wl || 45) : base.area)
      : base.area;
    const centerTaper = base.taper;

    const list = [];
    const N = 44;
    for (let i = 0; i < N; i++) {
      const jitter = function (mag) { return 1 + (rand() * 2 - 1) * mag; };
      const a = Object.assign({}, anchors);
      if (free.area) a.area = clamp(centerArea * jitter(0.30), 0.02, 1.6);
      if (free.mass) a.mass = clamp(centerMass * jitter(0.35), 0.08, 14);
      if (free.taper) a.taper = clamp(centerTaper * jitter(0.18), 0.35, 1);
      list.push(a);
    }
    // 保证有一个严格等于模板基线的候选
    list.unshift(Object.assign({}, anchors));

    const built = list.map(function (a) {
      return buildPlan(Object.assign({}, input, { anchors: a, anchorKeys: anchorKeys }), type, { confidence: 80 });
    });

    const ok = built.filter(function (p) { return p.feasible; });
    ok.sort(function (x, y) {
      // 先按总分，再按警告数量，再按一致性
      if (y.score.total !== x.score.total) return y.score.total - x.score.total;
      if (x.warnings.length !== y.warnings.length) return x.warnings.length - y.warnings.length;
      return y.score.consistency - x.score.consistency;
    });
    return { all: built, feasible: ok, best: ok[0] || built[0] };
  }

  /* =======================================================================
   * 11. Top3 输出（均衡 / 稳定易飞 / 性能·长航时·低成本）
   * ===================================================================== */
  const OBJECTIVES = [
    {
      key: 'balanced', name: '均衡推荐', tag: '综合最优',
      pick: function (p) { return p.score.total; },
      reason: function (p) { return '六个维度加权后综合得分最高（' + p.score.total + ' 分），没有明显短板，适合作为首选方案。'; }
    },
    {
      key: 'stable', name: '稳定易飞', tag: '上手最顺',
      pick: function (p) {
        const s = p.score.dimensions;
        const get = function (k) { return s.filter(function (d) { return d.key === k; })[0].score; };
        return 0.55 * get('stability') + 0.45 * get('easyfly');
      },
      reason: function (p) {
        return '稳定 ' + p.score.dimensions[0].score + ' 分 / 易飞 ' + p.score.dimensions[4].score + ' 分，静稳定裕度 '
          + round(p.core.cg.staticMargin, 1) + '% MAC、失速速度 ' + round(p.core.vStall, 1) + ' m/s，低速容错大。';
      }
    },
    {
      key: 'performance', name: '性能 / 长航时 / 低成本', tag: '效率或经济性最优',
      pick: function (p) {
        const s = p.score.dimensions;
        const get = function (k) { return s.filter(function (d) { return d.key === k; })[0].score; };
        return Math.max(0.5 * get('speed') + 0.5 * get('range'), 0.7 * get('cost') + 0.3 * get('buildability'));
      },
      reason: function (p) {
        return '速度 ' + p.score.dimensions[2].score + ' / 续航 ' + p.score.dimensions[1].score + ' / 成本 '
          + p.score.dimensions[3].score + ' 分，兼顾性能与制造经济性。';
      }
    }
  ];

  function pickTop3(cands) {
    const pool = cands.feasible.length ? cands.feasible : cands.all;
    const chosen = [], used = [];
    OBJECTIVES.forEach(function (obj) {
      let best = null, bs = -1;
      pool.forEach(function (p) {
        if (used.indexOf(p) >= 0) return;
        const v = obj.pick(p);
        // 与已选方案差异太小则轻微降权，保证三套方案的多样性
        let pen = 0;
        used.forEach(function (u) {
          const dArea = Math.abs(u.core.area - p.core.area) / Math.max(0.01, u.core.area);
          const dWl = Math.abs(u.core.wlGdm2 - p.core.wlGdm2) / Math.max(1, u.core.wlGdm2);
          if (dArea < 0.06 && dWl < 0.08) pen += 8;
        });
        if (v - pen > bs) { bs = v - pen; best = p; }
      });
      if (!best) best = pool[0];
      used.push(best);
      chosen.push({ objective: obj, plan: best });
    });
    return chosen;
  }

  /* =======================================================================
   * 12. 推荐理由 / 警告 / 置信度
   * ===================================================================== */
  function explain(plan, type, inferred) {
    const c = plan.core, src = plan.source, af = c.airfoil;
    const lines = [];
    const from = function (k) { return src[k] === 'anchor' ? '（来自您的锚点）' : '（按模板基线/规则补全）'; };

    lines.push('机型判定为「' + type.name + '」，推理路径：' + inferred.path + '，置信度 ' + plan.confidence + '%。' + inferred.why);
    lines.push('总体：起飞重量 ' + round(c.mass, 2) + ' kg' + from('mass') + '，翼面积 ' + round(c.area, 3) + ' m²，翼展 '
      + round(c.span, 3) + ' m，展弦比 ' + round(c.ar, 2) + '，梢根比 ' + round(c.taper, 2) + '，翼载 '
      + round(c.wlGdm2, 1) + ' g/dm²。');
    lines.push('翼型：' + af.designation + '（厚度 ' + round(af.tc * 100, 1) + '%、弯度 ' + round(af.camber * 100, 1)
      + '%、CLmax ' + round(af.clmax, 2) + '、CD0 ' + round(af.cd0 * 1e4, 0) + ' counts、失速迎角 ' + round(af.aStall, 1)
      + '°）。' + (af.notes || ''));
    lines.push('气动：三维 CLmax ' + round(c.clMax3d, 2) + '，失速速度 ' + round(c.vStall, 1) + ' m/s，最大升阻比 '
      + round(c.ldMax, 1) + '（' + round(c.vMd, 1) + ' m/s），巡航雷诺数 ' + (c.reCruise / 1000).toFixed(0) + 'k。');
    lines.push('尾翼与重心：平尾 ' + round(c.tail.Sh * 1e4, 0) + ' cm²（Vh ' + round(c.tail.vh, 3) + '）、垂尾 '
      + round(c.tail.Sv * 1e4, 0) + ' cm²（Vv ' + round(c.tail.vv, 3) + '）、尾臂 ' + round(c.tail.lh * 1000, 0)
      + ' mm；MAC ' + round(c.cg.mac * 1000, 0) + ' mm，重心位于 MAC 的 ' + round(c.cg.cgPct * 100, 1) + '%（静稳定裕度 '
      + round(c.cg.staticMargin, 1) + '% MAC）。');
    if (c.power) {
      lines.push('动力：' + c.power.cells + 'S 电池（' + round(c.power.voltage, 1) + ' V）+ ' + c.power.kv + ' KV 电机 + '
        + c.power.propIn + ' in 桨；静态推力 ' + round(c.power.staticThrust, 2) + ' N（推重比 ' + round(c.perf.thrustToWeight, 2)
        + '），最大电流约 ' + round(c.power.currentStatic, 1) + ' A，建议 ' + c.power.escA + ' A 电调；巡航电流约 '
        + round(c.power.currentCruise, 1) + ' A，预计续航 ' + round(c.power.enduranceMin, 0) + ' min。');
    } else if (c.rotary) {
      lines.push('动力：' + c.rotary.nrotor + ' 个旋翼，单个直径 ' + round(c.rotary.rotorDia * 1000, 0) + ' mm，桨盘载荷 '
        + round(c.rotary.diskLoading, 0) + ' N/m²；悬停功率 ' + round(c.rotary.powerHover, 0) + ' W（电功率约 '
        + round(c.rotary.powerHoverElec, 0) + ' W），' + c.rotary.cells + 'S ' + c.rotary.capacity + ' mAh 电池预计悬停 '
        + round(c.rotary.enduranceMin, 1) + ' min。');
    }
    lines.push('结构：' + c.structure.materials + '；碳管主梁建议 φ' + round(c.structure.sparDiaMM, 1) + ' mm，翼肋间距约 '
      + round(c.structure.ribSpacing * 1000, 0) + ' mm，设计过载 ' + c.structure.nLimit + ' G（安全系数 '
      + c.structure.safetyFactor + '）；副翼/平尾/方向舵舵机建议 ' + round(c.structure.servoAileron, 1) + ' / '
      + round(c.structure.servoElevator, 1) + ' / ' + round(c.structure.servoRudder, 1) + ' kg·cm。');
    return lines;
  }

  /* =======================================================================
   * 13. 命名模块（非必填）
   * ===================================================================== */
  const NAME_WORDS = {
    first: ['云', '星', '风', '苍', '疾', '凌', '青', '赤', '霜', '雷'],
    second: ['隼', '翼', '影', '燕', '雕', '羽', '雁', '鹭', '鸢', '翎'],
    first2: ['Silver', 'Swift', 'Night', 'Solar', 'Iron', 'Sky', 'Storm', 'Zephyr', 'Aero', 'Nova'],
    second2: ['Hawk', 'Arrow', 'Falcon', 'Rider', 'Wing', 'Drift', 'Lark', 'Spirit', 'Kite', 'Voyager'],
    callsign: ['先锋', '游隼', '夜航', '长风', '极光', '猎鹰', '轻骑', '白鹭', '远望', '疾风']
  };
  const TYPE_CN = { trainer: '教练', glider: '滑翔', '3d': '特技', racer: '竞速', cargo: '驮运', endurance: '巡航', multirotor: '旋翼', heli: '直升机' };

  function generateNames(plan, type, batch) {
    const n = batch == null ? 0 : batch;
    const rand = mulberry32(1000 + n * 7919);
    const pick = function (arr) { return arr[Math.floor(rand() * arr.length)]; };
    const pick2 = function (arr, a) { return arr[a % arr.length]; };
    const i1 = Math.floor(rand() * NAME_WORDS.first.length);
    const i2 = Math.floor(rand() * NAME_WORDS.second.length);
    const j1 = Math.floor(rand() * NAME_WORDS.first2.length);
    const j2 = Math.floor(rand() * NAME_WORDS.second2.length);
    const spanCm = Math.round(plan.core.span * 100);
    const cells = plan.core.power ? plan.core.power.cells : (plan.core.rotary ? plan.core.rotary.cells : 3);
    const out = [
      pick(NAME_WORDS.first) + pick(NAME_WORDS.second) + '-' + spanCm,
      'DSH-' + (TYPE_CN[type.id] || 'FW') + '-' + String(spanCm).padStart(3, '0') + 'S' + cells,
      pick2(NAME_WORDS.first2, j1) + ' ' + pick2(NAME_WORDS.second2, j2) + ' ' + spanCm,
      pick(NAME_WORDS.callsign) + round(plan.core.mass * 10, 0),
      '「' + pick(NAME_WORDS.first) + pick(NAME_WORDS.second) + '」' + TYPE_CN[type.id] + ' ' + spanCm + 'cm'
    ];
    return out.slice(0, 4);
  }
  function validateName(name) {
    const s = String(name == null ? '' : name).trim();
    if (!s) return { ok: false, msg: '名称不能为空' };
    if (s.length > 24) return { ok: false, msg: '名称不能超过 24 个字符' };
    if (!/^[\u4e00-\u9fa5A-Za-z0-9 _\-（）().·]+$/.test(s)) return { ok: false, msg: '只能使用中英文、数字、空格与 - _ . （）' };
    return { ok: true, msg: '名称可用' };
  }

  /* =======================================================================
   * 14. 顶层 API
   * ===================================================================== */
  /**
   * anchors: { span?, area?, ar?, taper?, chord?, mass?, wl?, payload?, voltage?, kv?, prop?,
   *            capa?, twr?, vmax?, vstall?, endurance?, style?, disk?, nrotor? }
   * options: { typeId?, airfoil?, sweep?, dihedral?, twist?, seed?, locked? }
   */
  function plan(anchors, options) {
    const opts = options || {};
    const inferred = inferType(anchors || {});
    const type = TYPE_BY_ID[opts.typeId || inferred.typeId || 'trainer'];
    if (!type) return { ok: false, error: '未知机型：' + opts.typeId };

    const input = Object.assign({}, opts, {
      anchors: anchors || {},
      anchorKeys: Object.keys(anchors || {}).filter(function (k) {
        return anchors[k] !== undefined && anchors[k] !== null && anchors[k] !== '' && isFinite(Number(anchors[k]));
      })
    });
    // 未被用户锚定的重量与面积交给候选池搜索（翼载/展弦比锚定时尤其重要）
    const freeKeys = ['mass', 'area', 'taper'].filter(function (k) {
      return input.anchorKeys.indexOf(k) < 0;
    });
    input.freeKeys = freeKeys;
    const cands = generateCandidates(input, type, freeKeys);

    if (!cands.feasible.length && cands.all.length === 0) {
      return { ok: false, error: '无法生成可行方案，请检查锚点取值范围。' };
    }

    const tops = pickTop3(cands);
    // 机型若由用户显式指定，推理路径改为说明"手动指定"
    if (opts.typeId) {
      inferred.path = '手动指定机型';
      inferred.why = '用户直接指定「' + type.name + '」，引擎跳过机型判别，只做参数补全与可行性校验。';
      inferred.typeId = type.id;
      inferred.typeName = type.name;
    }
    const plans = tops.map(function (t) {
      const p = t.plan;
      return {
        key: t.objective.key, label: t.objective.name, tag: t.objective.tag,
        objectiveReason: t.objective.reason(p) + ' ' + t.objective.pick(p).toFixed(1) + ' 分。',
        plan: p,
        reasons: explain(p, type, inferred),
        warnings: p.warnings.map(function (w) { return w.name + '：' + w.msg; }),
        confidence: p.confidence
      };
    });

    const airfoilRec = Aero.recommendAirfoils({
      style: type.style, Re: cands.best.core.reCruise || 2e5, needCl: cands.best.values.needCl,
      wantLowTorque: type.id === 'glider' || type.id === 'endurance', forbidSymmetric: type.id !== '3d'
    }, 3);

    return {
      ok: true, version: VERSION, typeId: type.id, typeName: type.name,
      inferred: inferred, candidatesEvaluated: cands.all.length, feasibleCount: cands.feasible.length,
      top3: plans, best: plans[0].plan, airfoilRecommendations: airfoilRec,
      dimensionInfo: (inferred ? inferred.dims : []).map(function (d) { return DIMENSIONS[d]; })
    };
  }

  /** 用户修改/锁定参数后重新计算并重新推荐 */
  function replan(state, anchors, options) {
    const res = plan(anchors, options);
    if (!res.ok) return res;
    // 锁定：把锁定的参数写回，重新构建三套方案
    const locked = (options && options.locked) || {};
    const lockedKeys = Object.keys(locked).filter(function (k) { return locked[k]; });
    if (lockedKeys.length) {
      res.top3 = res.top3.map(function (t) {
        const merged = Object.assign({}, t.plan.values);
        lockedKeys.forEach(function (k) {
          const flat = {
            span: 'span', area: 'area', ar: 'ar', taper: 'taper', mass: 'mass', wl: 'wl',
            twr: 'twr', kv: 'kv', prop: 'prop', voltage: 'voltage', capa: 'capa', payload: 'payload'
          }[k];
          if (flat && merged[flat] !== undefined) merged[flat] = Number(lockedValue(locked, k, merged[flat]));
        });
        if (locked.airfoil && typeof locked.airfoil === 'string') merged.airfoil = locked.airfoil;
        const newAnchors = Object.assign({}, anchors, lockedToAnchors(locked, merged));
        const p = buildPlan(Object.assign({}, options, { anchors: newAnchors, anchorKeys: Object.keys(newAnchors) }), TYPE_BY_ID[res.typeId], { confidence: t.plan.confidence });
        return Object.assign({}, t, { plan: p, warnings: p.warnings.map(function (w) { return w.name + '：' + w.msg; }) });
      });
      res.best = res.top3[0].plan;
    }
    return res;
  }
  function lockedValue(locked, k, fallback) {
    return typeof locked[k] === 'number' || typeof locked[k] === 'string' ? locked[k] : fallback;
  }
  function lockedToAnchors(locked, merged) {
    const out = {};
    ['span', 'area', 'ar', 'taper', 'mass', 'wl', 'twr', 'kv', 'prop', 'voltage', 'capa', 'payload'].forEach(function (k) {
      if (typeof locked[k] === 'number' || (typeof locked[k] === 'string' && isFinite(Number(locked[k])))) out[k] = Number(locked[k]);
    });
    return out;
  }

  /** 只读快照（方案冻结） */
  function snapshot(planObj, meta) {
    const m = meta || {};
    const deep = JSON.parse(JSON.stringify({
      version: VERSION,
      createdAt: m.createdAt || new Date().toISOString(),
      name: m.name || '',
      typeId: planObj.typeId, typeName: planObj.typeName,
      values: planObj.values, source: planObj.source, core: planObj.core,
      constraints: planObj.constraints, score: planObj.score,
      confidence: planObj.confidence, feasible: planObj.feasible,
      reasons: m.reasons || [], warnings: planObj.warnings.map(function (w) { return w.name + '：' + w.msg; }),
      anchors: m.anchors || {}, dimensionInfo: m.dimensionInfo || [],
      airfoilRecommendations: m.airfoilRecommendations || [],
      lockedParams: m.lockedParams || {}, versionHistory: m.versionHistory || []
    }));
    deep.readonly = true;
    deep.checksum = (function (s) {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
      return 'DSH-' + h.toString(16).toUpperCase();
    })(JSON.stringify(deep.core));
    return deep;
  }

  return {
    VERSION: VERSION, TYPES: TYPES, TYPE_BY_ID: TYPE_BY_ID,
    ANCHORS: ANCHORS, ANCHOR_BY_ID: ANCHOR_BY_ID, DIMENSIONS: DIMENSIONS,
    OBJECTIVES: OBJECTIVES,
    inferType: inferType, completeAnchors: completeAnchors, computeCore: computeCore,
    check: check, score: score, buildPlan: buildPlan, generateCandidates: generateCandidates,
    plan: plan, replan: replan, snapshot: snapshot,
    explain: explain, generateNames: generateNames, validateName: validateName,
    _internals: {
      MOTORS: MOTORS, solvePowerPoint: solvePowerPoint, pickPowerCombo: pickPowerCombo,
      pickPowerComboFast: pickPowerComboFast, powerTable: powerTable,
      PROP_CT: PROP_CT, PROP_CP: PROP_CP
    },
    helpers: { round: round, tentScore: tentScore, bandScore: bandScore, bandPenalty: bandPenalty }
  };
});
