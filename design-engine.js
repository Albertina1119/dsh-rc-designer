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
        vh: [0.40, 0.70], vv: [0.030, 0.060], sm: [8, 20], re: [8e4, 4e5], pmax: [120, 320],
        fus: [0.58, 0.82]      // 机身长度 / 翼展
      },
      weights: { stability: 1.35, range: 0.85, speed: 0.7, cost: 1.1, easyfly: 1.35, buildability: 1.15 },
      notes: '低速和缓、失速温和，重心容错大，适合入门与日常飞行。'
    },
    {
      id: 'glider', name: '滑翔机 / 长航时', short: '滑翔机', style: 'glider',
      anchors: { ar: 9.5, wl: 30, twr: 0.30, vmax: 16, span: 2.0, mass: 0.9 },
      range: {
        ar: [6.5, 16.0], wl: [15, 55], twr: [0.18, 0.70], vmax: [10, 26], stall: [4.5, 10],
        vh: [0.38, 0.65], vv: [0.022, 0.055], sm: [6, 18], re: [6e4, 3e5], pmax: [60, 200],
        fus: [0.46, 0.74]
      },
      weights: { stability: 1.1, range: 1.6, speed: 0.45, cost: 0.9, easyfly: 1.05, buildability: 0.95 },
      notes: '追求升阻比与低翼载，滞空时间长，起降依赖手抛或牵引。'
    },
    {
      id: '3d', name: '3D 特技机', short: '3D 机', style: '3d',
      anchors: { ar: 5.0, wl: 32, twr: 1.9, vmax: 24, span: 1.1, mass: 0.9 },
      range: {
        ar: [4.0, 6.5], wl: [20, 55], twr: [1.3, 2.8], vmax: [16, 32], stall: [5, 10],
        vh: [0.42, 0.72], vv: [0.035, 0.070], sm: [2, 10], re: [5e4, 2.5e5], pmax: [400, 1200],
        fus: [0.66, 0.95]
      },
      weights: { stability: 0.75, range: 0.6, speed: 0.9, cost: 0.9, easyfly: 0.7, buildability: 1.0 },
      notes: '推重比 1.3 以上、舵面大、重心靠后，强调悬停与暴力机动。'
    },
    {
      id: 'racer', name: '竞速机', short: '竞速机', style: 'racer',
      anchors: { ar: 4.5, wl: 75, twr: 1.6, vmax: 42, span: 0.8, mass: 0.9 },
      range: {
        ar: [3.2, 6.0], wl: [50, 140], twr: [0.9, 2.6], vmax: [28, 70], stall: [10, 20],
        vh: [0.35, 0.60], vv: [0.028, 0.055], sm: [5, 15], re: [1.5e5, 9e5], pmax: [400, 1500],
        fus: [0.62, 0.92]
      },
      weights: { stability: 1.0, range: 0.4, speed: 1.8, cost: 0.7, easyfly: 0.55, buildability: 0.85 },
      notes: '小展弦比薄翼、高翼载高功率，速度优先，低速特性苛刻。'
    },
    {
      id: 'cargo', name: '载重 / FPV 平台', short: '载重机', style: 'cargo',
      anchors: { ar: 6.5, wl: 70, twr: 0.75, vmax: 20, span: 1.6, mass: 3.0 },
      range: {
        ar: [5.0, 9.5], wl: [45, 120], twr: [0.50, 1.1], vmax: [13, 28], stall: [8, 14],
        vh: [0.42, 0.72], vv: [0.032, 0.062], sm: [8, 20], re: [1.2e5, 6e5], pmax: [110, 260],
        fus: [0.55, 0.80]
      },
      weights: { stability: 1.25, range: 1.15, speed: 0.55, cost: 0.95, easyfly: 1.0, buildability: 1.2 },
      notes: '厚翼大翼面积、结构强，强调载荷能力与飞行稳定性。'
    },
    {
      id: 'endurance', name: '长航时 / 巡航', short: '长航时机', style: 'endurance',
      anchors: { ar: 8.0, wl: 45, twr: 0.55, vmax: 19, span: 1.8, mass: 1.8 },
      range: {
        ar: [6.0, 12.0], wl: [28, 80], twr: [0.35, 0.95], vmax: [12, 28], stall: [6, 12],
        vh: [0.40, 0.68], vv: [0.030, 0.058], sm: [8, 20], re: [1e5, 5e5], pmax: [90, 220],
        fus: [0.50, 0.78]
      },
      weights: { stability: 1.15, range: 1.55, speed: 0.6, cost: 0.9, easyfly: 0.95, buildability: 1.0 },
      notes: '低翼载高升阻比，巡航效率优先，滞空时间最大化。'
    },
    {
      id: 'edf', name: '涵道风扇机', short: '涵道机', style: 'racer',
      anchors: { ar: 3.6, wl: 95, twr: 0.75, vmax: 38, span: 0.9, mass: 1.1 },
      range: {
        ar: [2.8, 5.0], wl: [65, 150], twr: [0.45, 1.3], vmax: [28, 62], stall: [11, 22],
        vh: [0.30, 0.55], vv: [0.022, 0.048], sm: [6, 16], re: [1.8e5, 9e5], pmax: [350, 1100],
        fus: [0.68, 1.02]
      },
      weights: { stability: 0.95, range: 0.45, speed: 1.65, cost: 0.75, easyfly: 0.6, buildability: 0.8 },
      notes: '涵道风扇（EDF）推进：小展弦比薄翼 + 高翼载，靠风扇静推力起飞，推重比通常 0.5~0.8，加速与高速段表现好但低速升力紧张。',
      powerKind: 'edf'
    },
    {
      id: 'jet', name: '小型喷气机', short: '喷气机', style: 'racer',
      anchors: { ar: 4.2, wl: 140, twr: 0.85, vmax: 62, span: 1.5, mass: 6.0 },
      range: {
        ar: [3.2, 6.5], wl: [95, 230], twr: [0.55, 1.5], vmax: [42, 105], stall: [14, 28],
        vh: [0.26, 0.50], vv: [0.020, 0.045], sm: [8, 20], re: [4.5e5, 3e6], pmax: [800, 4000],
        fus: [0.72, 1.05]
      },
      weights: { stability: 1.0, range: 0.5, speed: 1.85, cost: 0.55, easyfly: 0.45, buildability: 0.6 },
      notes: '微型涡喷推进：翼载高、速度段高，起飞滑跑长，燃油按分钟消耗，起降与散热是主要难点。',
      powerKind: 'turbine'
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
    { id: 'style', label: '飞行风格', unit: '', dim: 'style', min: 1, max: 5, step: 1, kind: 'enum', def: 3, rotaryOk: false,
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
  function completeAnchors(anchors, type, anchorKeys, raw) {
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
      src[k] = 'template';
    });
    // 2) 用户锚点覆盖（并按锚点定义夹取）
    Object.keys(anchors || {}).forEach(function (k) {
      const a = ANCHOR_BY_ID[k];
      if (!a) return;
      const v = num(anchors[k]);
      if (v === null) return;
      values[k] = clamp(v, a.min, a.max);
      src[k] = userKeys[k] ? 'anchor' : 'template';
    });

    const clampAr = function (v) { return R.ar && R.ar[1] > 0 ? clamp(v, R.ar[0], R.ar[1]) : v; };
    const clampWl = function (v) { return clamp(v, R.wl[0], R.wl[1]); };
    const hasArea = function () { return src.area === 'anchor'; };
    const isAnchor = function (k) { return src[k] === 'anchor'; };

    /* ---------------- 纯输入模式（raw）----------------
     * 用户关掉「引擎推荐」时启用：**不做候选搜索、不做多目标择优**，
     * 但仍然要把「用户没给的值」按物理关系算出来。
     *
     * 早期实现是在这里直接 return，把面积/翼展钉在机型模板上：
     *   起飞 4 kg + 翼载 80 g/dm² → 面积仍给模板的 0.2667 m²、翼展仍 1.200 m
     * 结果是「纯输入」模式实际上忽略了输入，用户改重量/翼载对尺寸毫无影响。
     * 现在的做法：
     *   ① 机型模板只在「物理上确实欠定」的项上兜底，并标 src='template'；
     *   ② 面积 / 翼展不预设模板值，交给下面的通用推导链
     *      （几何 area⇄span⇄ar⇄chord、重量 mass⇄wl⇄area）；
     *   ③ 只有真正缺少必要输入时才回落到模板，界面可据此区分
     *      「你指定 / 算出来 / 模板假设」。
     * 与引擎补全模式的差别因此变成「有没有搜索与择优」，而不是「算不算」。
     */
    if (raw) {
      const tplA = type.anchors || {};
      Object.keys(tplA).forEach(function (k) {
        if (!isFinite(values[k])) values[k] = tplA[k];
        if (src[k] !== 'anchor') src[k] = 'template';
      });
      // 面积与翼展必须由锚点推导，不能被模板预占
      if (!isAnchor('area')) { values.area = NaN; src.area = 'derived'; }
      if (!isAnchor('span')) { values.span = NaN; src.span = 'derived'; }
      if (!isAnchor('mass')) { /* mass 交给推导链由 wl/area 反算，算不出才用模板 */ }
      if (!isFinite(values.taper)) { values.taper = 0.7; }
      if (!isFinite(values.payload)) { values.payload = 0; }
      // 不 return：继续走通用推导链
    }

    // 3) 面积：优先由「重量 ÷ 翼载」算出；两者都缺才落到 0.25 m² 兜底
    if (!isFinite(values.area)) {
      if (isFinite(values.mass) && isFinite(values.wl) && values.wl > 0) {
        values.area = (values.mass * 10) / values.wl;
        src.area = 'derived';
      } else {
        values.area = 0.25;
        src.area = 'template';
      }
    }
    // 翼展：由「面积 × 展弦比」算出；展弦比缺失才用模板/经验值 6
    if (!isFinite(values.span)) {
      const arGiven = isFinite(values.ar) && values.ar > 0;
      const arRef = arGiven ? values.ar : 6;
      values.span = Math.sqrt(Math.max(0.001, values.area) * arRef);
      src.span = arGiven ? 'derived' : 'template';
    }
    if (!isFinite(values.taper)) { values.taper = 0.7; src.taper = 'template'; }
    if (!isFinite(values.prop)) { values.prop = 10; src.prop = 'template'; }
    if (!isFinite(values.kv)) { values.kv = 1000; src.kv = 'template'; }
    if (!isFinite(values.voltage)) { values.voltage = 11.1; src.voltage = 'template'; }
    if (!isFinite(values.capa)) { values.capa = 3000; src.capa = 'template'; }
    if (!isFinite(values.payload)) { values.payload = 0; src.payload = 'template'; }

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
    // 若用户同时锚定翼展与弦长，面积与展弦比都已被唯一确定，不得再"修正"，
    // 否则会悄悄覆盖弦长锚点；此时把偏离交给三级校验以「警告」形式呈现。
    if (R.ar && R.ar[1] > 0 && !isAnchor('ar') && !(isAnchor('span') && isAnchor('chord'))) {
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

    // --- 机身长度 ---
    // 由「机头 + 重心前机身 + 尾臂 + 平尾弦长」累加得到：
    //   L = 0.35·cr（电机与电池舱） + h_cg·cr（机翼段，h_cg 为重心在 MAC 上的位置）
    //       + lh（重心到平尾焦点的尾臂） + c_t（平尾平均弦长）
    // 并以「机身长度 / 翼展」比值对照该机型的经验区间做合理性校验。
    let fuselageLength = NaN, fusRatio = NaN, tailChordH = NaN, tailSpanH = NaN;
    // 尾翼完整几何：面积 → 翼展 → 根弦/尖弦 → 展弦比
    //   平尾：展弦比按主翼 0.55 折减（clamp 2.5~6.0），梢根比 0.80
    //   垂尾：展弦比 1.40（面积/高度关系），梢根比 0.75
    // 这几个常数同时被 Inventor 建模参数、Excel 与 3D 预览引用，
    // 集中在核心计算里定义，避免下游各自算一套互相打架。
    const AR_TAIL_H = clamp(AR * 0.55, 2.5, 6.0);
    const TAPER_H = 0.80, TAPER_V = 0.75, AR_TAIL_V = 1.40;
    let tailRootH = NaN, tailTipH = NaN, tailSpanV = NaN, tailRootV = NaN, tailTipV = NaN;
    if (!o.rotary) {
      tailSpanH = Math.sqrt(Math.max(0.001, Sh) * AR_TAIL_H);
      tailChordH = tailSpanH > 0 ? Sh / tailSpanH : NaN;
      tailRootH = tailSpanH > 0 ? (2 * Sh) / (tailSpanH * (1 + TAPER_H)) : NaN;
      tailTipH = isFinite(tailRootH) ? tailRootH * TAPER_H : NaN;
      tailSpanV = Math.sqrt(Math.max(0.001, Sv) * AR_TAIL_V);
      tailRootV = tailSpanV > 0 ? (2 * Sv) / (tailSpanV * (1 + TAPER_V)) : NaN;
      tailTipV = isFinite(tailRootV) ? tailRootV * TAPER_V : NaN;
      fuselageLength = 0.35 * pf.root + cgPct * pf.root + lh + tailChordH;
      fusRatio = fuselageLength / b;
    }
    // 旋翼机型：机身长度 ≈ 最大旋翼直径 × 1.05（机架需容纳桨盘）
    if (o.rotary) { acPct = null; cgPct = null; staticMargin = null; }

    // --- 动力系统 ---
    const rhoAtField = CELL;
    const payload = isFinite(inp.payload) ? inp.payload : 0;
    let power = null, rotary = null;

    /* ---------- 涵道风扇（EDF）/ 微型涡喷（turbine）动力 ----------
     * 这两种机型不用「电机 KV × 桨径」模型：
     *   EDF      → 由目标静推力选定标准涵道直径，功率按 3.4 g/W 折算
     *   turbine  → 由目标静推力选定涡喷推力级别，续航按燃油消耗率折算
     * 输出字段与螺旋桨方案保持一致（cells/voltage/capacity/escA/staticThrust/
     * currentStatic/powerStatic/enduranceMin…），便于下游 Excel / 建模 / 校验复用。
     */
    if (!type.rotary && (type.powerKind === 'edf' || type.powerKind === 'turbine')) {
      const twrT = isFinite(inp.twr) ? inp.twr : 0.65;
      const targetThrustT = twrT * W;
      const V0 = isFinite(inp.voltage) ? inp.voltage : 22.2;
      const cells0 = isFinite(inp.cells) ? inp.cells : Math.max(1, Math.round(V0 / 3.7));

      if (type.powerKind === 'edf') {
        // 标准涵道级别：直径 mm → 额定静推力 N（工程经验值）
        const EDF = [
          { mm: 50, th: 6.0, mass: 55, a: 30 }, { mm: 64, th: 11.0, mass: 85, a: 45 },
          { mm: 70, th: 15.0, mass: 110, a: 55 }, { mm: 80, th: 20.5, mass: 150, a: 70 },
          { mm: 90, th: 27.0, mass: 205, a: 85 }, { mm: 105, th: 35.0, mass: 290, a: 105 },
          { mm: 120, th: 46.0, mass: 400, a: 130 }
        ];
        const pickEd = EDF.reduce(function (b, e) {
          return Math.abs(e.th - targetThrustT) < Math.abs(b.th - targetThrustT) ? e : b;
        }, EDF[0]);
        const thrustN = pickEd.th;
        const effGW = 3.4;
        const pElec = (thrustN * 1000 / 9.80665) / effGW;      // W
        const currentA = pElec / V0;
        const capaT = isFinite(inp.capa) ? inp.capa : Math.round(2200 + 900 * cells0);
        const energyWh = (capaT / 1000) * (cells0 * 3.7);
        const pCruiseElec = pElec * 0.62;
        const enduranceMin = (energyWh * 0.8) / Math.max(8, pCruiseElec) * 60;
        const escA = Math.max(30, Math.ceil((currentA * 1.3) / 5) * 5);
        power = {
          kind: 'edf', twrTarget: twrT, targetThrust: targetThrustT,
          staticThrust: round(thrustN, 2), staticTwr: round(thrustN / W, 3),
          propIn: round(pickEd.mm / 25.4, 1), propPitch: 0, pitchRatio: 0,
          pitchSpeed: round(30000 + pickEd.mm * 220, 0),
          kv: 0, motor: 'EDF ' + pickEd.mm + 'mm', motorMass: pickEd.mass, motorImax: pickEd.a,
          cells: cells0, voltage: round(V0, 1), capacity: capaT,
          powerStatic: round(pElec, 1), powerStaticMech: round(pElec * 0.88, 1),
          powerCruiseMech: round(pCruiseElec * 0.88, 1), powerCruiseElec: round(pCruiseElec, 1),
          currentStatic: round(currentA, 2), currentCruise: round(pCruiseElec / V0, 2),
          rpmStatic: round(30000 + pickEd.mm * 220, 0),
          loadFactor: round(thrustN / W, 3), escA: escA,
          energyWh: round(energyWh, 2), enduranceMin: round(enduranceMin, 1),
          vCruise: round(clamp((type.anchors.vmax || 35) * 0.78, vStall * 1.25, 90), 2),
          diskLoadingProp: round(thrustN / (Math.PI * Math.pow(pickEd.mm / 1000 / 2, 2)), 1),
          efficiency: 0.88,        // 电机 + 风扇总效率
          edfMm: pickEd.mm, autoSelected: true, warnings: []
        };
      } else {
        // 微型涡喷：推力级别（kg）与燃油
        const TURB = [
          { kg: 2.0, mass: 380, flow: 0.28 }, { kg: 3.0, mass: 520, flow: 0.38 },
          { kg: 4.0, mass: 680, flow: 0.48 }, { kg: 6.0, mass: 900, flow: 0.66 },
          { kg: 8.0, mass: 1150, flow: 0.85 }, { kg: 12.0, mass: 1600, flow: 1.20 }
        ];
        const tgtKg = targetThrustT / 9.80665;
        const pickT = TURB.reduce(function (b, t) {
          return Math.abs(t.kg - tgtKg) < Math.abs(b.kg - tgtKg) ? t : b;
        }, TURB[0]);
        const thrustN = pickT.kg * 9.80665;
        // 燃油：按级别给出油箱容积（L）与消耗率（L/min）
        const fuelL = clamp(round(pickT.flow * 16, 1), 1.0, 12.0);
        const fuelFlow = pickT.flow;                       // L/min
        const enduranceMin = round((fuelL * 0.85) / Math.max(0.05, fuelFlow), 1);
        // 等效轴功：喷流功率 ≈ 推力 × 有效排气速度（约 180 m/s 量级）
        const pMech = thrustN * 180;
        power = {
          kind: 'turbine', twrTarget: twrT, targetThrust: targetThrustT,
          staticThrust: round(thrustN, 2), staticTwr: round(thrustN / W, 3),
          propIn: round(40 + pickT.kg * 6, 1), propPitch: 0, pitchRatio: 0,
          pitchSpeed: round(180, 0),
          kv: 0, motor: '涡喷 ' + pickT.kg.toFixed(1) + ' kg', motorMass: pickT.mass, motorImax: 0,
          cells: 0, voltage: 7.4, capacity: 0,
          powerStatic: round(pMech, 0), powerStaticMech: round(pMech, 0),
          powerCruiseMech: round(pMech * 0.8, 0), powerCruiseElec: round(pMech * 0.8, 0),
          currentStatic: 0, currentCruise: 0,
          rpmStatic: round(60000 + pickT.kg * 25000, 0),
          loadFactor: round(thrustN / W, 3), escA: 0,
          energyWh: round(fuelL * 9.6, 2), enduranceMin: enduranceMin,
          vCruise: round(clamp((type.anchors.vmax || 60) * 0.78, vStall * 1.25, 150), 2),
          diskLoadingProp: 0, efficiency: 0.42,   // 热力→推力总效率
          turbineKg: pickT.kg, fuelL: fuelL, fuelFlow: pickT.flow,
          autoSelected: true, warnings: []
        };
      }
    } else if (!type.rotary) {
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
      // 旋翼机型机身长度：机架需容纳桨盘，取最大旋翼直径的 1.05 倍
      fuselageLength = rotorDia * 1.05;
      fusRatio = fuselageLength / Math.max(0.01, b);
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
      trainer: '轻木 + 巴尔沙蒙皮 / EPP 泡沫',
      edf: '轻木构架 + 玻璃纤维蒙皮，涵道筒碳纤/玻纤',
      jet: '碳纤维 + 玻璃纤维复合，蜂窝夹芯承力',
      heli: '碳纤维机身板 + 铝合金传动'
    }[type.id] || '轻木/泡沫常规结构';

    return {
      planform: pf, ar: AR, span: b, area: S, taper: lambda, sweep: sweep, dihedral: dihedral, twist: twist,
      meanChord: pf.meanChord, fuselageLength: fuselageLength, fuselageRatio: fusRatio,
      tailChordH: tailChordH, tailSpanH: tailSpanH,
      airfoil: af, a3dPerDeg: a3dPerDeg, a3dPerDegDeg: a3dPerDegDeg, clMax3d: clMax3d,
      mass: m, weight: W, wingLoading: wingLoading, wlGdm2: wl, payload: payload,
      vStall: vStall, reStall: reStall, reCruise: reCruise, aStall3d: aStall3d,
      cd0: cd0, oswald: e, kInduced: k, clMd, ldMax: ldMax, vMd: vMd, swet: Swet,
      tail: {
        lh: lh, lv: lv, Sh: Sh, Sv: Sv, vh: vh, vv: vv,
        elevRatio: 0.40, rudderRatio: 0.38, aileronRatio: clamp(0.28 - (type.id === '3d' ? 0.06 : 0), 0.18, 0.35),
        // ---- 平尾几何 ----
        spanH: tailSpanH, chordH: tailChordH, rootChordH: tailRootH, tipChordH: tailTipH,
        arH: (isFinite(tailSpanH) && isFinite(tailChordH) && tailChordH > 0) ? tailSpanH / tailChordH : NaN,
        taperH: TAPER_H,
        // ---- 垂尾几何 ----
        spanV: tailSpanV, chordV: tailRootV, rootChordV: tailRootV, tipChordV: tailTipV,
        arV: AR_TAIL_V, taperV: TAPER_V,
        // ---- 舵面弦长（绝对长度）----
        elevatorChord: (isFinite(tailRootH) ? 0.40 * tailRootH : NaN),
        rudderChord: (isFinite(tailRootV) ? 0.38 * tailRootV : NaN)
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
      },
      material: materialRecommendation({
        planform: pf, ar: AR, span: b, area: S, taper: lambda, meanChord: pf.meanChord,
        mass: m, wlGdm2: wl, vStall: vStall, rotary: rotary,
        perf: { vMaxCalc: vMaxCalc },
        tail: {
          lh: lh, lv: lv, Sh: Sh, Sv: Sv, vh: vh, vv: vv,
          spanH: tailSpanH, chordH: tailChordH, rootChordH: tailRootH, tipChordH: tailTipH,
          spanV: tailSpanV, chordV: tailRootV, rootChordV: tailRootV, tipChordV: tailTipV,
          arH: (isFinite(tailSpanH) && isFinite(tailChordH) && tailChordH > 0) ? tailSpanH / tailChordH : NaN,
          arV: AR_TAIL_V, taperH: TAPER_H, taperV: TAPER_V
        },
        structure: {
          nLimit: nLimit, rootMoment: rootMoment, sparDiaMM: sparDiaMM,
          ribSpacing: ribSpacing, materials: materials, safetyFactor: 1.5
        }
      }, type)
    };
  }

  /* =======================================================================
   * 7. 约束校验
   * ===================================================================== */
  function check(core, type, src) {
    const SRC = src || {};
    // 该值是否由用户锚点直接指定（锚点驱动的偏离是刻意选择，只降级为警告）
    const fromAnchor = function (k) { return SRC[k] === 'anchor'; };
    const items = [];
    /**
     * 三级校验：level ∈ 'ok' | 'warn' | 'error'
     * 每项都带 advice（可执行建议），界面层据此显示「等级 + 提示 + 建议」。
     * 兼容说明：level 字段沿用原有取值，旧调用方（Excel 导出等）无需改动。
     */
    const add = function (level, cat, name, value, band, msg, advice) {
      items.push({
        level: level, cat: cat, name: name, value: value, band: band, msg: msg,
        advice: advice || (level === 'ok' ? '无需调整' : '请按提示方向调整该参数')
      });
    };
    /**
     * 经验区间校验：
     *   - 在区间内 → ok
     *   - 只要超出区间（不论多少）→ 至少 warn，绝不显示「通过」
     *   - 偏差很大 → 仍为 warn（错误级别只留给物理不可行项，以免把可行方案判死）
     */
    const soft = function (v, band, cat, name, unit, lowMsg, highMsg, adviceLow, adviceHigh) {
      if (!band || band[1] <= 0 || !isFinite(v)) return;
      const u = unit || '';
      const p = bandPenalty(v, band, 1);
      const rangeTxt = band[0] + '~' + band[1] + u;
      if (p === 0) {
        add('ok', cat, name, round(v, 2) + u, rangeTxt, '在经验区间内', '无需调整');
        return;
      }
      const tooLow = v < band[0];
      const cur = round(v, 2);
      const adv = tooLow
        ? (adviceLow || ('把 ' + name + ' 提高到 ' + band[0] + u + ' 以上（当前 ' + cur + u + '）'))
        : (adviceHigh || ('把 ' + name + ' 降低到 ' + band[1] + u + ' 以下（当前 ' + cur + u + '）'));
      add('warn', cat, name, cur + u, rangeTxt, tooLow ? lowMsg : highMsg, adv);
    };
    const cross = function (cond, cat, name, value, msg, level, advice) {
      if (cond) {
        items.push({
          level: level || 'warn', cat: cat, name: name, value: value, band: '—', msg: msg,
          advice: advice || '按提示方向调整相关参数后重新生成'
        });
      } else {
        items.push({ level: 'ok', cat: cat, name: name, value: value, band: '—', msg: '无冲突', advice: '无需调整' });
      }
    };
    /**
     * 关系型校验（带方向的不等式）。
     * ⚠ 修复的 Bug：旧写法把实测值硬编码成「X < 下限」/「X > 上限」，
     * 条件不成立时也照样显示违反符号，于是界面上出现「0.72 < 0.45 → 通过」这种
     * 自相矛盾的结论。本函数按真实关系输出 ≥ / ≤ / < / >，并把限值放进「经验区间」列。
     *
     * @param dir 'min' = 期望 actual ≥ limit（越大越好）；'max' = 期望 actual ≤ limit（越小越好）
     * @param errRatio 超出限值多少比例后升级为「错误」（默认 0.25，即 25%）
     */
    const rel = function (actual, limit, dir, cat, name, unit, msgOk, msgBad, adviceBad, errRatio, forced) {
      if (!isFinite(actual) || !isFinite(limit)) return;
      const u = unit || '';
      const a = round(actual, 2), L = round(limit, 2);
      const pass = dir === 'min' ? actual >= limit : actual <= limit;
      const symOk = dir === 'min' ? '≥' : '≤';
      const symBad = dir === 'min' ? '<' : '>';
      const band = symOk + ' ' + L + u + (dir === 'min' ? '（下限）' : '（上限）');
      if (pass) {
        add('ok', cat, name, a + u + ' ' + symOk + ' ' + L + u, band, msgOk || '满足该机型要求', '无需调整');
        return;
      }
      const bad = Math.abs(actual - limit) / Math.max(1e-9, Math.abs(limit));
      // 若这个偏离来自用户显式锚点（forced），说明是刻意的设计选择，
      // 最多降到「警告」——否则用户一旦给出偏离常规的锚点，整个方案会被判不可行。
      const level = forced ? 'warn' : (bad > (isFinite(errRatio) ? errRatio : 0.25) ? 'error' : 'warn');
      add(level, cat, name, a + u + ' ' + symBad + ' ' + L + u, band,
        (msgBad || '偏离该机型要求') + (forced ? '（该值由你的锚点指定）' : ''),
        adviceBad || ('把 ' + name + ' 调到 ' + band + ' 以内'));
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
      soft(core.ar, R.ar, '经验', '展弦比', '', '展弦比偏小，诱导阻力大、滑翔差', '展弦比偏大，结构刚度与滚转惯量变差',
        '加大翼展或减小翼面积，把展弦比提到 ' + R.ar[0] + ' 以上',
        '缩短翼展或加大弦长，把展弦比降到 ' + R.ar[1] + ' 以下');
      soft(core.vStall, R.stall, '经验', '失速速度', ' m/s', '失速速度偏低，翼载过小、抗风差', '失速速度偏高，起降与低速盘旋困难',
        '加大翼载（减小翼面积或加载）或换用更高 CLmax 的翼型', '加大翼面积、降低翼载，或换用高升力翼型');
      soft(core.wlGdm2, R.wl, '经验', '翼载', ' g/dm²', '翼载偏低，抗风性差', '翼载偏高，失速速度上升、起降变难',
        '加大翼面积或减重，把这翼载提到 ' + R.wl[0] + ' 以上',
        '加大翼面积或减重，把翼载降到 ' + R.wl[1] + ' 以下');
      soft(core.tail.vh, R.vh, '经验', '平尾容量 Vh', '', '平尾容量偏小，俯仰稳定性不足', '平尾容量偏大，平尾阻力与重量增加');
      soft(core.tail.vv, R.vv, '经验', '垂尾容量 Vv', '', '垂尾容量偏小，航向稳定性不足', '垂尾容量偏大，垂尾阻力增加');
      soft(core.cg.staticMargin, R.sm, '经验', '静稳定裕度', ' %MAC', '静稳定裕度偏小，纵向易发散', '静稳定裕度偏大，俯仰配平阻力大、机动迟钝');
      soft(core.reCruise, R.re, '经验', '巡航雷诺数', '', '雷诺数偏低，翼型性能下降明显', '雷诺数偏高（超出模型常用范围）');
      soft(core.fuselageRatio, R.fus, '经验', '机身长度 / 翼展', '', '机身偏短，尾力臂不足或设备舱拥挤', '机身偏长，结构重量与俯仰惯量增加');
      if (isFinite(core.fuselageLength) && core.fuselageLength > 0) {
        add('ok', '范围', '机身长度', round(core.fuselageLength * 1000, 0) + ' mm',
          '按机头+机翼段+尾臂+平尾弦长累加', '机身长度已给出，用于绘制侧视图与布置设备');
      }
    }

    // --- 交叉冲突 ---
    if (!type.rotary) {
      rel(core.vStall, type.range.stall[1], 'max', '交叉', '失速速度 vs 机型期望', ' m/s',
        '失速速度不超过该机型期望上限',
        '失速速度超出该机型期望上限，起降与低速盘旋会变难',
        '加大翼面积或减轻重量，把失速速度降到 ' + type.range.stall[1] + ' m/s 以下', 0.25,
        fromAnchor('wl') || fromAnchor('mass') || fromAnchor('area') || fromAnchor('span') || fromAnchor('ar'));
      rel(core.perf.thrustToWeight, type.range.twr[0], 'min', '交叉', '推重比 vs 机型期望', '',
        '推重比达到该机型下限，爬升与加速能力够用',
        '可用推重比低于该机型下限，爬升与加速能力不足',
        '换更大推力的动力组合（加大桨径 / 提高 KV 或电压 / 降低起飞重量），把推重比提到 ' +
        type.range.twr[0] + ' 以上', 0.25, fromAnchor('twr'));
      cross(core.wlGdm2 > type.range.wl[1] && core.perf.thrustToWeight < 0.7,
        '交叉', '高翼载 + 低推重比',
        round(core.wlGdm2, 0) + ' g/dm²（上限 ' + type.range.wl[1] + '） / T/W ' + round(core.perf.thrustToWeight, 2),
        '高翼载与低推重比同时出现，起飞距离与盘旋性能会明显恶化',
        'warn',
        '优先加大翼面积降低翼载；至少把推重比提到 0.7 以上再试飞');
      cross(core.power && core.power.rpmStatic > 45000 && core.power.propIn < 7,
        '交叉', '电机 KV / 桨径 / 电压匹配', core.power ? round(core.power.rpmStatic, 0) + ' rpm @ ' + core.power.propIn + 'in' : '—',
        '转速过高而桨径偏小，推力效率低', 'warn',
        '降低电机 KV 或加大桨径（一般让转速落在 30000 rpm 以内效率最好）');
      cross(core.power && core.power.escA > 0 && core.power.escA > 120,
        '交叉', '电调电流余量', core.power ? core.power.escA + ' A（上限 120 A）' : '—',
        '所需电调规格过大，建议提高电压或降低功率', 'warn',
        '提高电池节数（同样功率下电流更低）或减重以小功率配置');
      cross(core.cg.staticMargin < type.range.sm[0] * 1.6 && type.style === '3d' && core.cg.staticMargin < 3,
        '交叉', '3D 机重心过前', round(core.cg.staticMargin, 1) + ' %MAC（3D 需 ≤ 3）',
        '3D 机需要靠后的重心，否则无法悬停与平旋', 'warn',
        '把电池后移，让重心落到 MAC 的 3% 以内（首飞仍建议先留 5% 余量）');
    } else {
      const tw = core.rotary.twrTarget;
      rel(tw, type.range.twr[0], 'min', '交叉', '推重比 vs 机型期望', '',
        '推重比达到该机型下限',
        '推重比不足，抗风与机动能力差',
        '加大桨径 / 提高电压 / 减重，把推重比提到 ' + type.range.twr[0] + ' 以上', 0.15, fromAnchor('twr'));
      rel(core.rotary.enduranceMin, 3, 'min', '交叉', '续航 vs 电池', ' min',
        '悬停续航不低于 3 分钟',
        '悬停续航不足 3 分钟，需加大电池容量或减轻重量',
        '加大电池容量（mAh）或减重；若已接近结构极限，考虑提高电压以降低电流', 0.34);
    }
    rel(core.aStall3d, 6, 'min', '交叉', '失速迎角', '°',
      '可用失速迎角够用',
      '可用失速迎角过小，操纵窗口窄',
      '换用厚度更大或弯度更高的翼型（如 2412 → 4415），提高失速迎角', 0.17);
    rel(core.ldMax, 4, 'min', '交叉', '最大升阻比', '',
      '升阻比够用',
      '升阻比过低，巡航效率差',
      '加大展弦比、换低阻翼型，或降低翼载以减小诱导阻力', 0.25);

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
    const completed = completeAnchors(input.anchors || {}, type, input.anchorKeys, input.raw);
    const values = completed.values;
    const src = completed.source;
    // 合并用户对派生参数的直接指定；翼型同时兼容 opts.airfoil 与 anchors.airfoil 两种传入方式
    ['sweep', 'dihedral', 'twist', 'airfoil'].forEach(function (k) {
      if (input[k] !== undefined && input[k] !== null && input[k] !== '') values[k] = input[k];
    });
    if ((values.airfoil === undefined || values.airfoil === '' || values.airfoil === null)
      && input.anchors && input.anchors.airfoil) {
      values.airfoil = input.anchors.airfoil;
    }
    // 兜底清洗：把「NACA NACA 2412」「naca2412」之类统一成「NACA 2412」，
    // 避免因为前缀重复而查不到翼型、导致整套气动数据变成 NaN。
    if (values.airfoil !== undefined && values.airfoil !== null && values.airfoil !== '') {
      const bare = String(values.airfoil).replace(/^\s*(NACA\s*)+/i, '').replace(/\s+/g, '').trim();
      values.airfoil = 'NACA ' + bare;
    }

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
    // 若指定的翼型编号没被识别、临时替换成了 NACA 2412，必须明确告知用户
    if (af && af.substituted) {
      core.airfoilWarning = '翼型编号「' + values.airfoil + '」无法识别（' + (af.reason || '') +
        '），本次已临时按 NACA 2412 计算。请改用 4 位（2412）、5 位（23012）或 6 位（65-210）编号。';
    }
    const constraints = check(core, type, src);
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
    // 翼型编号无法识别时的警告，进入统一警告列表，界面与 Excel 都能看到
    const allWarnings = warnings.slice();
    if (core.airfoilWarning) {
      allWarnings.unshift({ name: '翼型', msg: core.airfoilWarning, level: 'warn' });
    }
    return {
      typeId: type.id, typeName: type.name, seed: seedInfo || null,
      values: values, source: src, core: core, constraints: constraints,
      errors: fails, warnings: allWarnings, score: sc,
      feasible: fails.length === 0,
      // clean = 既无错误也无警告，完全落在该机型的经验区间内
      clean: fails.length === 0 && constraints.every(function (c) { return c.level === 'ok'; }),
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
    // 硬性保证：只要存在可行方案，best 一定从可行集里取
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
      + round(c.span, 3) + ' m，机身长度 ' + round(c.fuselageLength * 1000, 0) + ' mm（L/b = '
      + round(c.fuselageRatio, 2) + '），机翼弦长 ' + round(c.meanChord * 1000, 0) + ' mm（根弦 '
      + round(c.planform.root * 1000, 0) + ' / 尖弦 ' + round(c.planform.tip * 1000, 0) + ' mm），展弦比 '
      + round(c.ar, 2) + '，梢根比 ' + round(c.taper, 2) + '，翼载 ' + round(c.wlGdm2, 1) + ' g/dm²。');
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
   * 12b. 全锚点取值汇总
   *      把「用户锚点」与「引擎计算出的其余锚点」并列输出，
   *      供界面锚点表与 Excel 的「输入锚点」表使用。
   * ===================================================================== */
  /**
   * 返回全部锚点的最终取值与来源。
   *   source: 'user'     用户勾选并输入的锚点（value 即用户输入值）
   *           'engine'   引擎计算 / 择优得到的值（如桨径、电机 KV、续航等）
   *           'baseline' 引擎沿用机型模板基线，未做改动
   */
  function anchorValues(plan) {
    if (!plan || !plan.core) return [];
    const c = plan.core, vals = plan.values || {}, src = plan.source || {};
    const pw = c.power || null, rw = c.rotary || null;
    const isNum = function (v) { return typeof v === 'number' && isFinite(v); };

    // 每个锚点由「引擎算出」的取值
    const computed = {
      span: c.span,
      area: c.area,
      ar: c.ar,
      taper: c.taper,
      chord: c.meanChord,                          // 平均几何弦长 S/b
      mass: c.mass,
      wl: c.wlGdm2,
      payload: isNum(c.payload) ? c.payload : vals.payload,
      voltage: pw ? pw.voltage : (rw ? rw.batteryVoltage : vals.voltage),
      kv: pw ? pw.kv : null,                       // 引擎实际选定的电机 KV
      prop: pw ? pw.propIn : null,                 // 引擎实际选定的桨径 ← 文档举例
      capa: pw ? pw.capacity : (rw ? rw.capacity : vals.capa),
      twr: rw ? rw.twrTarget : (c.perf ? c.perf.thrustToWeight : vals.twr),
      vmax: rw ? rw.vMaxEstimate : (c.perf ? c.perf.vMaxCalc : vals.vmax),
      vstall: isNum(c.vStall) ? c.vStall : null,
      endurance: pw ? pw.enduranceMin : (rw ? rw.enduranceMin : null),
      style: vals.style,
      disk: rw ? rw.diskLoading : null,
      nrotor: rw ? rw.nrotor : null
    };

    // 补充说明：让用户知道这个值是怎么来的
    const extra = {
      prop: pw ? ('桨 ' + pw.propIn + '×' + pw.propPitch + ' in，' + (pw.autoSelected ? '引擎自动择优' : '用户指定')) : '',
      kv: pw ? ((pw.motor || '') + ' 电机，' + (pw.autoSelected ? '引擎自动择优' : '用户指定')) : '',
      chord: '平均几何弦长 c̄ = S / b',
      wl: '翼载 = m[g] / S[dm²]',
      twr: pw ? '实际静推力 / 起飞重量' : '目标推重比',
      vmax: rw ? '动量理论估计值' : '推力与阻力曲线交点',
      vstall: 'Vs = √(2W/(ρS·CLmax))',
      endurance: '按可用电量 80% 估算',
      area: 'S = m·10 / wl',
      ar: 'AR = b² / S',
      disk: 'DL = W / 总桨盘面积',
      nrotor: rw ? (rw.kind === 'helicopter' ? '直升机主旋翼数' : '多旋翼数量') : '',
      voltage: pw ? ('电池 ' + pw.cells + 'S') : (rw ? ('电池 ' + rw.cells + 'S') : ''),
      capa: pw ? ('电池 ' + pw.cells + 'S / ' + pw.capacity + ' mAh') : (rw ? ('电池 ' + rw.cells + 'S / ' + rw.capacity + ' mAh') : '')
    };

    return ANCHORS.map(function (a) {
      const isUser = src[a.id] === 'anchor';
      const v = isUser ? vals[a.id] : computed[a.id];
      const tpl = (TYPE_BY_ID[plan.typeId] || {}).anchors || {};
      const near = function (x, y) { return isNum(x) && isNum(y) && Math.abs(x - y) <= 1e-9; };
      // 三个来源：用户输入 / 引擎计算 / 模板默认
      let source;
      if (isUser) source = 'user';
      else if (!isNum(v)) source = 'baseline';
      else if (tpl[a.id] !== undefined ? near(v, tpl[a.id]) : near(v, a.def)) source = 'baseline';
      else source = 'engine';
      // 这些只可能由引擎算出，即使恰好等于默认值也标成 engine
      if (!isUser && isNum(v) && ['prop', 'kv', 'chord', 'vstall', 'endurance', 'disk', 'nrotor'].indexOf(a.id) >= 0) {
        source = 'engine';
      }
      // 原数值：用户给了就是用户值，否则取机型模板基线（模板没有则取锚点默认值）
      let base = isUser ? vals[a.id] : (tpl[a.id] !== undefined ? tpl[a.id] : a.def);
      if (!isNum(base)) base = null;
      const changed = isNum(v) && isNum(base) && Math.abs(v - base) > 1e-9;
      return {
        id: a.id, label: a.label, unit: a.unit, dim: a.dim,
        dimName: (DIMENSIONS[a.dim] || {}).name || a.dim,
        kind: a.kind || 'num',
        value: isNum(v) ? v : null,
        base: base,                       // 原数值（用户输入 或 机型模板默认）
        changed: changed,                 // 推荐值是否与原数值不同
        source: source,
        note: extra[a.id] || '',
        userAnchor: isUser,
        options: a.options || null
      };
    }).filter(function (r) { return r.value !== null || r.userAnchor; });
  }

  /* =======================================================================
   * 12b. 制造材料推荐（按用途）
   *
   * 需求：根据飞机用途推荐机翼制造材料（载重机 / 竞速机…各不同），
   *       并给出平尾、垂尾的翼展、弦长与材质。
   *
   * 设计原则：
   *   · 先按机型给「主推方案」（primary），这是该用途下最主流、性价比最高的做法；
   *   · 再按计算出的展弦比 / 翼根弯矩 / 最大速度追加「修正建议」（modifiers），
   *     因为同一用途下大展弦比或高过载会改变结构选型；
   *   · 同时给 2 条「备选方案」（alternatives）说明什么情况下换它、代价是什么；
   *   · 给 1~2 条「不推荐」（avoid），避免新手踩坑。
   *
   * 难度 / 成本 / 重量三档：低 / 中 / 高。
   * ===================================================================== */
  const WING_MATERIAL_PROFILES = {
    trainer: {
      primary: '轻木（Balsa）构架 + 轻木翼肋 + 热缩膜蒙皮',
      structure: '轻木 D-box 前缘盒 + 轻木翼肋 + 碳管主梁 + 热缩膜后段',
      spar: '碳纤维圆管 φ6~8 mm（也可用桦木主梁，成本更低）',
      skin: '前缘轻木蒙皮 + 后段热缩膜；拼色直接贴在膜上',
      ribs: '轻木 2~3 mm，间距 90~110 mm',
      process: '激光切翼肋 → 木质胶接 → 热缩膜熨烫（常温，无需烘箱）',
      difficulty: '低', cost: '低', weight: '中',
      reasons: [
        '练习机翼载低（约 40~50 g/dm²），翼根弯矩小，不需要复材承力',
        '轻木自重轻、易切割、摔坏后单片可换，返修成本几乎为零',
        '热缩膜可反复熨烫修形，是练习机最经济的蒙皮方案'
      ],
      alternatives: [
        { name: 'EPP / EPO 泡沫整体成型', when: '首飞阶段、预计频繁摔机', tradeoff: '耐摔性最好，但刚度低，高速会翼面颤振' },
        { name: '3 mm DTFB 泡沫板 + 纤维胶带', when: '1 m 以内超轻练习机', tradeoff: '成本最低、制作最快，寿命与气动精度较差' }
      ],
      avoid: ['全碳纤维蒙皮（对练习机过重、过贵，且摔后无法局部修补）', '蜂窝夹芯（局部破损会扩散，返修困难）']
    },
    glider: {
      primary: '碳纤维主梁 + 玻璃纤维（玻纤）蒙皮 + 巴尔沙夹芯',
      structure: '碳管/碳扁梁承弯 + 玻纤布蒙皮承扭 + 巴尔沙或 Rohacell 夹芯',
      spar: '碳纤维扁梁（上下面各一条）或碳管 φ8~12 mm，大展弦比需双梁',
      skin: '1~2 层 25~50 g/m² 玻纤布 + 环氧，真空袋压',
      ribs: '巴尔沙 2 mm 或 Rohacell 3 mm，间距 120~150 mm（夹芯可不用肋）',
      process: '阴模/阳模铺层 + 真空袋压 + 常温或 60 ℃ 固化',
      difficulty: '中', cost: '中', weight: '轻',
      reasons: [
        '滑翔机靠升阻比取胜，翼面必须高精度、低粗糙度，玻纤蒙皮比热缩膜平整得多',
        '展弦比 9~12 时翼根弯矩大而结构高度小，必须用碳梁承担弯矩',
        '玻纤承扭 + 碳梁承弯是「材料各司其职」的经典组合，比全碳便宜很多且不易脆断'
      ],
      alternatives: [
        { name: '全碳纤维 + 蜂窝夹芯', when: 'F3F/F3B 竞赛级、需要极限刚度', tradeoff: '刚度最高，但价格高、脆性大、局部损伤难修' },
        { name: '轻木 + 热缩膜（传统构架）', when: '2 m 以内休闲滑翔、预算有限', tradeoff: '便宜易修，但翼面精度与刚度不足，高速会损失升阻比' }
      ],
      avoid: ['纯热缩膜蒙皮配大展弦比（膜会随温度松弛，翼型失真）', '单根细碳管配超长翼展（扭转刚度不够，易发生副翼反效）']
    },
    '3d': {
      primary: '巴尔沙（Balsa）构架 + 轻木翼肋 + 热缩膜蒙皮',
      structure: '巴尔沙 D-box + 轻木翼肋 + 碳管主梁 + 热缩膜；副翼段加固',
      spar: '碳纤维管 φ8~10 mm 或碳扁梁，副翼铰链线加碳条',
      skin: '热缩膜（低收缩型），铰链处贴纤维胶带',
      ribs: '轻木 2.5 mm，间距 70~90 mm（3D 机动载荷大，肋要密）',
      process: '激光切翼肋 → 木质胶接 → 热缩膜；副翼需单独做铰链梁',
      difficulty: '中', cost: '低', weight: '轻',
      reasons: [
        '3D 机要求「轻 + 大舵面 + 高刚度」，巴尔沙构架在同等重量下比泡沫刚得多',
        '推重比接近 2、舵面偏转大，翼面扭转刚度必须靠密肋 + 碳梁保证',
        '热缩膜重量最轻且可局部补强，是 3D 机的标准蒙皮'
      ],
      alternatives: [
        { name: 'EPP 泡沫 + 碳片加强', when: '低空 3D 练习、经常撞地', tradeoff: '极耐摔，但重量偏大、翼面精度差' },
        { name: '玻纤蒙皮 + 泡沫夹芯', when: '大尺寸 3D（>1.6 m）', tradeoff: '刚度更好，但重量增加，低速 3D 动作会变迟钝' }
      ],
      avoid: ['大面积蜂窝夹芯（重量分布靠外，转动惯量大，3D 动作变慢）', '纯泡沫无加强（大舵面偏转时翼面会扭曲）']
    },
    racer: {
      primary: '碳纤维 / 凯夫拉复合 + PMI 泡沫夹芯（或玻纤-碳混铺）',
      structure: '碳纤维上下蒙皮 + 泡沫夹芯承弯，凯夫拉用于抗冲击部位（前缘、翼尖）',
      spar: '碳纤维单向带（UD）做上下翼梁帽 + 碳布腹板，形成工字梁',
      skin: '1K/3K 碳布 + 环氧，前缘加 1 层凯夫拉防撞',
      ribs: '夹芯结构无需密集翼肋，仅在舵面铰链与主梁处设加强肋',
      process: '阴模铺层 + 真空袋压 + 中温固化（80~120 ℃）',
      difficulty: '高', cost: '高', weight: '轻',
      reasons: [
        '竞速机翼载高、速度 40 m/s 以上，动压与翼根弯矩都是练习机的数倍，必须复材承力',
        '碳纤维比刚度最高，同样刚度下最轻；凯夫拉抗冲击，放在前缘可避免小石子打穿',
        '夹芯结构把蒙皮推到翼型最外侧，抗弯效率最高，同时保持翼面精度'
      ],
      alternatives: [
        { name: '玻纤 + 碳梁（半复材）', when: '入门竞速、预算有限', tradeoff: '成本降一半，但刚度与重量不如全碳，极速会略低' },
        { name: '轻木构架 + 碳梁 + 热缩膜', when: '5 寸级小型竞速机', tradeoff: '制作快、易修，但高速时膜会鼓起，翼型失真' }
      ],
      avoid: ['纯玻璃纤维蒙皮配大展弦比（刚度不足，高速副翼反效）', '木材主梁（竞速载荷下会疲劳开裂）']
    },
    cargo: {
      primary: '泡沫夹芯 + 碳管桁架 + 玻纤蒙皮（局部碳加强）',
      structure: 'EPS/XPS 泡沫夹芯 + 碳管前后梁 + 玻纤蒙皮；机身用碳管/木桁架',
      spar: '前后双碳管 φ10~14 mm 或碳扁梁，载荷集中在翼根需加加强肋',
      skin: '玻纤布 + 环氧；机翼上表面局部加碳布提高承压能力',
      ribs: '轻木/胶合板 3 mm 加强肋（仅在挂点、起落架、翼根处）',
      process: '泡沫热切割 → 碳管埋入 → 玻纤手糊/真空袋压',
      difficulty: '中', cost: '中', weight: '中',
      reasons: [
        '载重机需要「大内部容积 + 高承弯能力」，泡沫夹芯最便宜地提供厚度与抗弯惯性矩',
        '有效载荷集中在机身/翼下挂点，必须在挂点做加强肋，把集中力扩散到主梁',
        '玻纤蒙皮韧性好，起降擦碰不易像碳纤那样脆裂'
      ],
      alternatives: [
        { name: '全碳纤维 + 蜂窝夹芯', when: '载荷 > 2 kg、需要极限减重', tradeoff: '最轻最强，但成本高、修复困难' },
        { name: '轻木 + 玻纤蒙皮（传统构架）', when: '小批量自制、载荷 < 1 kg', tradeoff: '便宜好修，但内部容积小、承弯能力有限' }
      ],
      avoid: ['纯泡沫无梁（挂载后翼根会直接折断）', '单根细碳管（前后梁间距不足时抗扭差，机翼会扭转）']
    },
    endurance: {
      primary: '碳管主梁 + 泡沫/玻纤蒙皮',
      structure: '单/双碳管主梁 + XPS 泡沫夹芯 + 玻纤蒙皮；长翼展需分段对接',
      spar: '碳纤维圆管 φ8~12 mm，分段处用碳管插接 + 玻纤缠绕加强',
      skin: '25~50 g/m² 玻纤布 + 环氧，翼面打磨到 Ra 1.6 以下',
      ribs: '轻木 2 mm，间距 120~160 mm',
      process: '泡沫热切割 + 碳管埋入 + 玻纤真空袋压',
      difficulty: '中', cost: '中', weight: '轻',
      reasons: [
        '长航时的关键是升阻比，翼面必须平整光滑，玻纤蒙皮优于热缩膜',
        '长翼展带来大翼根弯矩，碳管主梁是最轻的承弯方案',
        '分段对接便于运输，插接处缠绕玻纤可恢复 80% 以上刚度'
      ],
      alternatives: [
        { name: '全碳 + Rohacell 夹芯', when: '目标续航 > 60 min 的竞赛级', tradeoff: '刚度与精度最好，但成本高' },
        { name: '轻木构架 + 热缩膜', when: '1.5 m 以内休闲长航时', tradeoff: '便宜易修，翼面精度略差' }
      ],
      avoid: ['过薄的单层玻纤蒙皮（易出现局部凹陷，破坏层流）', '翼尖不加轻质结构（翼尖颤振会累积成翼面疲劳）']
    },
    edf: {
      primary: '轻木构架 + 玻璃纤维蒙皮（涵道筒用碳纤/玻纤缠绕）',
      structure: '轻木/胶合板构架 + 玻纤蒙皮；进气口与涵道筒单独做承力件',
      spar: '碳管主梁 φ8~10 mm，涵道安装框用 3 mm 胶合板 + 玻纤加强',
      skin: '玻纤布 + 环氧，进气唇口用碳布加强并倒圆',
      ribs: '轻木 2.5 mm，间距 80~100 mm',
      process: '木质构架胶接 + 玻纤蒙皮；涵道筒可买成品或用玻纤缠绕自制',
      difficulty: '中', cost: '中', weight: '中',
      reasons: [
        '涵道机的推力来自高速射流，进气唇口形状与内壁光滑度直接决定推力，木构架 + 玻纤最容易做出光滑内壁',
        '涵道筒是独立承力件，需与机身框可靠连接，否则振动会导致开裂',
        '翼载约 90~110 g/dm²，翼根弯矩中等，碳管单梁足够'
      ],
      alternatives: [
        { name: 'EPO 泡沫整机成型', when: '量产型 EDF 像真机', tradeoff: '一致性好、制作快，但刚度低，高速会翼面颤振' },
        { name: '全玻纤阴模成型', when: '需要高表面质量与强度', tradeoff: '外观与强度最好，但模具成本高' }
      ],
      avoid: ['涵道筒用薄热缩膜/纸筒（高速气流会吸瘪）', '进气口直角（会产生严重分离，推力损失 20% 以上）']
    },
    jet: {
      primary: '碳纤维 + 玻璃纤维复合，蜂窝/泡沫夹芯承力（耐高温区用玻纤+隔热层）',
      structure: '碳布/碳带蒙皮 + 蜂窝或 PMI 夹芯；排气段用玻纤 + 隔热棉',
      spar: '碳纤维工字梁（上下翼梁帽 + 腹板），翼根与起落架框整体加强',
      skin: '碳布 + 环氧（中温固化）；高温区改用玻纤或加铝箔隔热',
      ribs: '夹芯结构，仅在翼根、起落架、舵面铰链处设加强肋',
      process: '阴模铺层 + 真空袋压 + 中温固化；关键接头二次胶接 + 螺栓',
      difficulty: '高', cost: '高', weight: '轻',
      reasons: [
        '涡喷机型翼载 140 g/dm² 以上、速度 60 m/s 量级，结构必须按高动压与疲劳设计',
        '涡喷排气温度可达 600~700 ℃，普通碳纤环氧会软化，必须用玻纤 + 隔热层隔离',
        '起落架冲击载荷要经加强框传到主梁，接头是全线最薄弱环节，需螺栓 + 胶接双保险'
      ],
      alternatives: [
        { name: '玻纤 + 碳梁（半复材）', when: '入门涡喷、速度 < 50 m/s', tradeoff: '成本低、耐热性更好，但刚度与重量不如全碳' },
        { name: '木质构架 + 玻纤蒙皮', when: '小型涡喷（<3 kg 推力）', tradeoff: '制作简单，但疲劳寿命短，不适合长期高频飞行' }
      ],
      avoid: ['碳纤维直接暴露在排气段（高温 + 氧化会迅速失效）', '环氧胶接承力接头（长期振动会脱胶，必须机械紧固辅助）']
    },
    multirotor: {
      primary: '碳纤维机架板（3K 碳板）+ 铝合金柱 + 碳管机臂',
      structure: '上下碳板夹层 + 铝柱支撑；机臂用碳管或碳板一体切割',
      spar: '机臂碳管 φ16~25 mm（按轴距与桨径定）',
      skin: '不适用（多旋翼无机翼蒙皮），电池仓可用玻纤/PC 壳保护',
      ribs: '不适用',
      process: 'CNC 切割碳板 + 铝柱螺栓连接；碳板边缘需封边防分层',
      difficulty: '中', cost: '中', weight: '轻',
      reasons: [
        '多旋翼的载荷是「电机振动 + 起降冲击」，碳板抗弯刚度高、加工方便，是行业标准',
        '机臂用碳管可在最小重量下获得最大抗弯刚度，撞机时优先断臂而非断机架',
        '铝柱提供层间高度与紧固点，比整体碳件更易维修'
      ],
      alternatives: [
        { name: '玻纤板机架', when: '练习机、预算有限', tradeoff: '便宜、韧性好不易断，但刚度与重量不如碳板' },
        { name: '注塑/PC 一体壳', when: '消费级航拍机', tradeoff: '外观好、抗摔，但重且不易维修' }
      ],
      avoid: ['纯 3D 打印 PLA 机架（刚度低、高温软化、振动下会开裂）', '碳板与铝直接接触不加绝缘（碳导电，会短路）']
    },
    heli: {
      primary: '碳纤维机身侧板 + 铝合金传动件 + 玻纤头罩',
      structure: '2.0~2.5 mm 碳板侧板 + 铝柱/铝框构成受力框架；主轴/尾管为铝或碳',
      spar: '不适用（旋翼机型），主旋翼用碳纤/玻纤桨',
      skin: '头罩用玻纤或 PETG 吸塑，仅整流不承力',
      ribs: '不适用',
      process: 'CNC 切碳板 + 铝件车削 + 螺栓装配',
      difficulty: '高', cost: '高', weight: '中',
      reasons: [
        '直升机的主受力是主旋翼传来的交变弯矩与扭矩，碳板侧板 + 铝框是最成熟的框架方案',
        '传动系统需要高精度与耐磨，铝件比复材更合适',
        '头罩只整流不承力，玻纤/吸塑即可，损坏后可单独更换'
      ],
      alternatives: [
        { name: '全铝机身', when: '老旧机型或大级别', tradeoff: '维修方便，但重量大、振动传递明显' },
        { name: '玻纤侧板', when: '练习机型', tradeoff: '韧性好、便宜，但刚度不足，大桨会共振' }
      ],
      avoid: ['碳板与金属件直接螺栓连接不加垫片（会压溃碳板孔边）', '省掉主旋翼动平衡（振动会加速所有结构疲劳）']
    }
  };

  /* 尾翼材料：按尾翼载荷等级分三档 */
  const TAIL_MATERIAL_PROFILES = {
    light: {
      material: '轻木构架 + 轻木翼肋 + 热缩膜蒙皮',
      structure: '轻木 D-box 前缘 + 轻木翼肋 + 碳管或桦木梁 + 热缩膜',
      reason: '尾翼面积小、载荷低，轻木构架在同等刚度下最轻且易修补',
      difficulty: '低', cost: '低'
    },
    stiff: {
      material: '巴尔沙实心（或轻木 + 碳条加强）+ 热缩膜 / 玻纤蒙皮',
      structure: '巴尔沙实心板削形 + 碳条贴铰链线 + 热缩膜；或轻木框 + 玻纤蒙皮',
      reason: '大舵面高速度下尾翼会颤振，实心巴尔沙 + 碳条能以最小重量获得足够扭转刚度',
      difficulty: '中', cost: '低'
    },
    comp: {
      material: '碳纤维/玻纤复合 + 泡沫夹芯（或全玻纤阴模件）',
      structure: '上下碳布蒙皮 + 泡沫夹芯 + 碳梁；铰链处预埋碳条或铝管',
      reason: '高速机型尾翼动压高，且涡喷排气会烘烤结构，复材 + 夹芯兼顾刚度与耐温',
      difficulty: '高', cost: '高'
    }
  };

  /**
   * 推荐制造材料（机翼 + 平尾 + 垂尾）
   * @returns {object} { wing, tail:{ h, v, cls }, modifiers[], summary, isRotary }
   */
  function materialRecommendation(core, type) {
    const t = type || {};
    const c = core || {};
    const st = c.structure || {};
    const isRotary = !!c.rotary;
    const prof = WING_MATERIAL_PROFILES[t.id] || WING_MATERIAL_PROFILES.trainer;

    /* ---- 修正建议：同一用途下，展弦比 / 弯矩 / 速度会改变结构选型 ---- */
    const modifiers = [];
    const ar = isFinite(c.ar) ? c.ar : 6;
    const moment = isFinite(st.rootMoment) ? st.rootMoment : 0;
    const vmax = c.perf && isFinite(c.perf.vMaxCalc) ? c.perf.vMaxCalc : 0;
    const span = isFinite(c.span) ? c.span : 1.2;

    if (!isRotary) {
      if (ar >= 10) {
        modifiers.push({
          level: 'warn', key: '大展弦比',
          note: '展弦比 ' + round(ar, 1) + ' ≥ 10：翼根弯矩大而结构高度小',
          advice: '主梁必须用碳纤维（扁梁或双梁），单根碳管会扭转不足；翼肋间距缩到 110 mm 以内'
        });
      } else if (ar <= 4.2 && t.id !== 'heli') {
        modifiers.push({
          level: 'info', key: '小展弦比',
          note: '展弦比 ' + round(ar, 1) + ' ≤ 4.2：弦长相对厚，抗弯容易满足',
          advice: '可以用更简单的结构（单梁 + 轻木蒙皮），把重量预算留给动力与设备'
        });
      }
      if (moment >= 120) {
        modifiers.push({
          level: 'error', key: '高翼根弯矩',
          note: '翼根弯矩 ' + round(moment, 0) + ' N·m 属于高载荷',
          advice: '必须做双梁或工字梁 + 翼根加强框；单梁/木质主梁在该载荷下会疲劳开裂，不要用'
        });
      } else if (moment >= 60) {
        modifiers.push({
          level: 'warn', key: '中等翼根弯矩',
          note: '翼根弯矩 ' + round(moment, 0) + ' N·m 需要可靠的主梁接头',
          advice: '主梁在翼根处加一层碳布缠绕或碳扁梁搭接，长度 ≥ 3 倍梁高'
        });
      }
      if (vmax >= 45) {
        modifiers.push({
          level: 'warn', key: '高速颤振风险',
          note: '最大速度约 ' + round(vmax, 0) + ' m/s，翼面动压高',
          advice: '蒙皮必须与翼肋可靠胶接（热缩膜不可用于副翼段），副翼做质量平衡，铰链缝隙贴胶带'
        });
      }
      if (span >= 2.4) {
        modifiers.push({
          level: 'info', key: '大翼展运输',
          note: '翼展 ' + round(span, 2) + ' m，整根运输困难',
          advice: '做成中段 + 两侧外翼三段式，插接套管用碳管套碳管，接缝处玻纤缠绕 2 层补强'
        });
      }
      if (isFinite(c.mass) && c.mass >= 5) {
        modifiers.push({
          level: 'info', key: '大起飞重量',
          note: '起飞重量 ' + round(c.mass, 1) + ' kg，属于需要实名与场地要求的级别',
          advice: '结构按 1.5 倍安全系数设计，所有承力接头用螺栓 + 胶接双保险，首飞前做地面加载试验'
        });
      }
    }

    /* ---- 平尾 / 垂尾材料 ---- */
    let clsH = 'light', clsV = 'light';
    if (!isRotary) {
      const tailLoad = (t.id === 'jet' || t.id === 'racer' || t.id === 'edf') ? 3
        : (t.id === '3d' || t.id === 'cargo' ? 2
          : (vmax >= 35 || (isFinite(c.tail && c.tail.Sh) && c.tail.Sh > 0.09) ? 2 : 1));
      const pick = function (base) {
        const lv = Math.min(3, base + (vmax >= 55 ? 1 : 0));
        return lv >= 3 ? 'comp' : (lv === 2 ? 'stiff' : 'light');
      };
      clsH = pick(tailLoad);
      // 垂尾承受螺旋桨滑流与侧风，通常比平尾高一档
      clsV = pick(tailLoad + (t.id === '3d' || t.id === 'racer' ? 1 : 0));
    }
    const ph = TAIL_MATERIAL_PROFILES[clsH];
    const pv = TAIL_MATERIAL_PROFILES[clsV];
    const tl = c.tail || {};
    const tail = isRotary ? null : {
      h: {
        cls: clsH, material: ph.material, structure: ph.structure, reason: ph.reason,
        difficulty: ph.difficulty, cost: ph.cost,
        span: tl.spanH, chord: tl.chordH, rootChord: tl.rootChordH, tipChord: tl.tipChordH,
        ar: tl.arH, area: tl.Sh
      },
      v: {
        cls: clsV, material: pv.material, structure: pv.structure, reason: pv.reason,
        difficulty: pv.difficulty, cost: pv.cost,
        span: tl.spanV, chord: tl.chordV, rootChord: tl.rootChordV, tipChord: tl.tipChordV,
        ar: tl.arV, area: tl.Sv
      }
    };

    const summary = isRotary
      ? (t.name || '旋翼机') + '：' + prof.primary
      : (t.name || '固定翼') + ' 机翼推荐「' + prof.primary + '」；平尾 ' + ph.material.split(' + ')[0] +
        '、垂尾 ' + pv.material.split(' + ')[0];

    return {
      isRotary: isRotary,
      typeId: t.id || null,
      typeName: t.name || null,
      wing: prof,
      tail: tail,
      modifiers: modifiers,
      summary: summary,
      // 一句话工艺路线，便于在导出表里单列
      route: prof.process
    };
  }

  /* =======================================================================
   * 12c. Inventor 建模设计参数
   *      输出 3D 建模（Autodesk Inventor 等）直接可用的尺寸，
   *      按零件分组：建模基准 / 机翼 / 副翼 / 机身 / 平尾 / 垂尾 /
   *                  重心与电池仓 / 动力安装 / 结构与材料
   *      长度一律给 mm（CAD 单位），角度给 °。
   * ===================================================================== */
  function modelingParams(plan) {
    if (!plan || !plan.core) return [];
    const c = plan.core, pf = c.planform || {}, t = c.tail || {}, cg = c.cg || {};
    const pw = c.power || null, rw = c.rotary || null, st = c.structure || {};
    // 注意：isFinite(null) 在 JS 中为 true（Number(null)===0），必须显式判断类型
    const isNum = function (v) { return typeof v === 'number' && isFinite(v); };
    const mm = function (m) { return isNum(m) ? +(m * 1000).toFixed(1) : null; };
    const r1 = function (v) { return isNum(v) ? +v.toFixed(1) : null; };
    const r2 = function (v) { return isNum(v) ? +v.toFixed(2) : null; };

    // ---- 尾翼几何：直接取核心计算结果（几何常数在核心计算里统一定义，
    //      避免这里再算一套与 Excel / 3D 预览不一致的值）----
    const taperH = isNum(t.taperH) ? t.taperH : 0.80;
    const taperV = isNum(t.taperV) ? t.taperV : 0.75;
    const bH = c.rotary ? null : (isNum(t.spanH) ? t.spanH : c.tailSpanH);
    const rootH = c.rotary ? null : (isNum(t.rootChordH) ? t.rootChordH : null);
    const tipH = c.rotary ? null : (isNum(t.tipChordH) ? t.tipChordH : null);
    const hV = c.rotary ? 0 : (isNum(t.spanV) ? t.spanV : 0);
    const rootV = c.rotary ? null : (isNum(t.rootChordV) ? t.rootChordV : null);
    const tipV = c.rotary ? null : (isNum(t.tipChordV) ? t.tipChordV : null);
    // ---- 舵面弦长 ----
    const aileronChord = (!c.rotary && isNum(t.aileronRatio) && isNum(c.meanChord)) ? t.aileronRatio * c.meanChord : null;
    const elevatorChord = isNum(t.elevatorChord) ? t.elevatorChord
      : ((isNum(t.elevRatio) && isNum(rootH)) ? t.elevRatio * rootH : null);
    const rudderChord = isNum(t.rudderChord) ? t.rudderChord
      : ((isNum(t.rudderRatio) && isNum(rootV)) ? t.rudderRatio * rootV : null);
    // 材料推荐
    const mat = c.material || null;

    // ---- 电池仓尺寸（按 0.36 Wh/cm³ 体积能量密度反推，再留 4 mm 余量）----
    let bayL = null, bayW = null, bayH = null;
    if (pw) {
      const wh = (pw.capacity / 1000) * pw.cells * 3.7;
      const volMM = (wh / 0.36) * 1000;
      const hh = Math.pow(volMM / 5.88, 1 / 3);
      bayH = Math.ceil(hh + 4); bayW = Math.ceil(1.4 * hh + 4); bayL = Math.ceil(4.2 * hh + 6);
    } else if (rw) {
      bayH = 30; bayW = 45; bayL = 110;
    }

    // ---- 电机安装孔距（按电机定子尺寸经验取值）----
    let mount = null;
    if (pw && pw.motor) {
      const s = String(pw.motor).replace(/\D/g, '');
      const d = Number(s.slice(0, 2));
      if (d <= 18) mount = [12, 16];
      else if (d <= 23) mount = [16, 19];
      else if (d <= 28) mount = [19, 25];
      else if (d <= 35) mount = [25, 25];
      else mount = [25, 32];
    }

    const propDiaMM = pw ? r1(pw.propIn * 25.4) : (rw ? mm(rw.rotorDia) : null);
    const items = [];
    const add = function (group, name, value, unit, note) {
      items.push({ group: group, name: name, value: value, unit: unit || '', note: note || '' });
    };

    // ============ 建模基准 ============
    add('建模基准', '坐标原点建议', '机翼根弦前缘', '', 'X 轴指向机尾，Y 轴指向右翼，Z 轴向上；机身对称面为 XZ 平面');
    add('建模基准', '总长（机身）', mm(c.fuselageLength), 'mm', '机头最前端 → 尾端');
    add('建模基准', '总翼展', mm(c.span), 'mm', '翼尖到翼尖（不含翼尖小翼）');
    add('建模基准', '全机高度', r1((hV || 0) * 1000 + (st.sparDiaMM || 0) * 2) || null, 'mm', '机身下部 → 垂尾顶端');
    add('建模基准', '整机建模单位', 'mm', '', 'Inventor 零件与装配统一用 mm，导出 STEP 前不要改比例');
    add('建模基准', '引用翼型', c.airfoil ? c.airfoil.designation : '—', '',
      c.airfoil ? (c.airfoil.series + '，厚度 ' + r1(c.airfoil.tc * 100) + '%，弯度 ' + r1(c.airfoil.camber * 100) + '%') : '');
    add('建模基准', '翼型曲线生成方式', c.airfoil ? '按 ' + c.airfoil.designation + ' 公式生成' : '—', '',
      '弦长归一化后按 4/5/6 位公式生成上下面坐标，再按各站位弦长缩放');

    // ============ 机翼（仅固定翼）============
    if (!c.rotary) {
    add('机翼', '半翼展（单侧）', mm(c.span / 2), 'mm', '对称件：建一侧后镜像即可');
    add('机翼', '根弦 cr', mm(pf.root), 'mm', '翼根（机身侧）弦长');
    add('机翼', '尖弦 ct', mm(pf.tip), 'mm', '翼尖弦长');
    add('机翼', '梢根比 λ', r2(c.taper), '', 'ct / cr');
    add('机翼', '平均几何弦长 c̄', mm(c.meanChord), 'mm', 'c̄ = S / b');
    add('机翼', '平均气动弦 MAC', mm(cg.mac), 'mm', '气动计算基准');
    add('机翼', 'MAC 展向位置', mm(pf.yMac), 'mm', '从对称面量起，用于标注重心');
    add('机翼', '机翼面积 S', isFinite(c.area) ? +(c.area * 1e4).toFixed(1) : null, 'cm²', '单侧 × 2');
    add('机翼', '展弦比 AR', r2(c.ar), '', 'b² / S');
    add('机翼', '上反角', r1(c.dihedral), '°', '左右翼各抬起的角度（从对称面量）');
    add('机翼', '后掠角', r1(c.sweep), '°', '前缘后掠');
    add('机翼', '扭转角（翼尖）', r1(c.twist), '°', '负值为气动扭转（洗流）');
    add('机翼', '翼型厚度', r1((c.airfoil ? c.airfoil.tc : 0) * 100), '% 弦长', '最大厚度位置约 30% 弦长');
    add('机翼', '翼型最大弯度', r1((c.airfoil ? c.airfoil.camber : 0) * 100), '% 弦长', c.airfoil && c.airfoil.pos ? ('位置 ' + r1(c.airfoil.pos * 100) + '% 弦长') : '');
    add('机翼', '最大厚度（绝对值）', mm(pf.root * (c.airfoil ? c.airfoil.tc : 0)), 'mm', '按根弦算；翼尖按尖弦比例缩放');

    // ============ 副翼 ============
    add('副翼', '副翼弦长', mm(aileronChord), 'mm', '弦长比 ' + r1((t.aileronRatio || 0) * 100) + '%（相对平均弦长）');
    add('副翼', '展向起点（距对称面）', mm(c.span * 0.17), 'mm', '约为半翼展的 34%，避开机身尾流');
    add('副翼', '展向终点（距对称面）', mm(c.span * 0.45), 'mm', '约为半翼展的 90%，留 5% 翼尖不切');
    add('副翼', '单侧副翼长度', mm(c.span * 0.28), 'mm', '副翼 + 襟副翼总展长');
    add('副翼', '副翼面积（单侧）', isFinite(aileronChord) ? +((aileronChord * c.span * 0.28) * 1e4).toFixed(1) : null, 'cm²', '参考值');

    // ============ 机身 ============
    add('机身', '机身总长', mm(c.fuselageLength), 'mm', 'L = 0.35·cr + h_cg·cr + lh + c_t');
    add('机身', '机头段长', mm(0.35 * pf.root), 'mm', '前端 → 机翼前缘（含电机座/防火墙）');
    add('机身', '机翼安装段长', mm((cg.cgPct || 0) * pf.root), 'mm', '机翼前缘 → 重心位置');
    add('机身', '尾段长（重心 → 平尾）', mm(t.lh), 'mm', '尾臂 lh，同时是垂尾的力臂 lv');
    add('机身', '机身长 / 翼展', r2(c.fuselageRatio), '', '常规固定翼 0.55 ~ 0.85');
    add('机身', '建议最大截面宽', r1(Math.max(28, (bayW || 40) + 4)), 'mm', '略大于电池仓宽度，便于装拆');
    add('机身', '建议最大截面高', r1(Math.max(30, (bayH || 30) + 6)), 'mm', '需容纳电池 + 电调走线');
    add('机身', '机头安装角（拉力线）', cg.thrustLine || '—', '', '电机轴相对翼弦的夹角');

    // ============ 平尾 ============
    add('平尾', '平尾翼展', mm(c.tailSpanH), 'mm', '含升降舵，翼尖到翼尖');
    add('平尾', '平尾根弦', mm(rootH), 'mm', '按梢根比 ' + r2(taperH) + ' 反推');
    add('平尾', '平尾尖弦', mm(tipH), 'mm', '根弦 × 梢根比');
    add('平尾', '平尾平均弦长', mm(t.chordH), 'mm', 'Sh / 翼展');
    add('平尾', '平尾展弦比', r2(t.arH), '', 'ARh = 翼展² / 面积');
    add('平尾', '平尾面积', isFinite(t.Sh) ? +(t.Sh * 1e4).toFixed(1) : null, 'cm²', '尾容量 Vh = ' + r2(t.vh));
    add('平尾', '平尾梢根比', r2(taperH), '', '尖弦 / 根弦');
    add('平尾', '尾臂 lh', mm(t.lh), 'mm', '机翼 MAC 25% → 平尾 MAC 25%');
    add('平尾', '升降舵弦长', mm(elevatorChord), 'mm', '弦长比 ' + r1((t.elevRatio || 0) * 100) + '%');
    add('平尾', '平尾安装角', '0 ~ -1', '°', '相对机翼弦线，略负以配平');
    add('平尾', '平尾材质', mat && mat.tail ? mat.tail.h.material : '—', '', mat && mat.tail ? mat.tail.h.reason : '');
    add('平尾', '平尾结构方案', mat && mat.tail ? mat.tail.h.structure : '—', '', mat && mat.tail ? ('制作难度 ' + mat.tail.h.difficulty + '，成本 ' + mat.tail.h.cost) : '');

    // ============ 垂尾 ============
    add('垂尾', '垂尾高度（翼展）', mm(hV), 'mm', '根部到翼尖的垂直距离，按展弦比 ' + r2(t.arV) + ' 反推');
    add('垂尾', '垂尾根弦', mm(rootV), 'mm', '按梢根比 ' + r2(taperV) + ' 反推');
    add('垂尾', '垂尾尖弦', mm(tipV), 'mm', '根弦 × 梢根比');
    add('垂尾', '垂尾平均弦长', mm(t.chordV), 'mm', '根弦 + 尖弦 的平均');
    add('垂尾', '垂尾展弦比', r2(t.arV), '', 'ARv = 高度² / 面积');
    add('垂尾', '垂尾面积', isFinite(t.Sv) ? +(t.Sv * 1e4).toFixed(1) : null, 'cm²', '尾容量 Vv = ' + r2(t.vv));
    add('垂尾', '垂尾梢根比', r2(taperV), '', '尖弦 / 根弦');
    add('垂尾', '方向舵弦长', mm(rudderChord), 'mm', '弦长比 ' + r1((t.rudderRatio || 0) * 100) + '%');
    add('垂尾', '垂尾后掠角', '0 ~ 10', '°', '常规 5°，竞速机可加大');
    add('垂尾', '垂尾材质', mat && mat.tail ? mat.tail.v.material : '—', '', mat && mat.tail ? mat.tail.v.reason : '');
    add('垂尾', '垂尾结构方案', mat && mat.tail ? mat.tail.v.structure : '—', '', mat && mat.tail ? ('制作难度 ' + mat.tail.v.difficulty + '，成本 ' + mat.tail.v.cost) : '');
    }  // end !rotary：机翼 / 副翼 / 平尾 / 垂尾 仅固定翼适用

    // ============ 重心与电池仓 ============
    add('重心与电池仓', 'MAC 位置', mm(cg.mac), 'mm', '从机翼根弦前缘往机尾量');
    add('重心与电池仓', '气动焦点', r1((cg.acPct || 0) * 100), '% MAC', '距 MAC 前缘 ' + mm(cg.acMM) + ' mm');
    add('重心与电池仓', '设计重心', r1((cg.cgPct || 0) * 100), '% MAC', '距 MAC 前缘 ' + mm(cg.cgMM) + ' mm');
    add('重心与电池仓', '重心距机头', mm(0.35 * pf.root + (cg.cgMM || 0)), 'mm', '★ 建模时以此为基准标注电池仓位置');
    add('重心与电池仓', '允许重心范围', r1((cg.cgPct || 0) * 100 - 5) + ' ~ ' + r1((cg.cgPct || 0) * 100 + 5), '% MAC',
      '即 ' + mm((cg.cgMM || 0) - 0.05 * cg.mac) + ' ~ ' + mm((cg.cgMM || 0) + 0.05 * cg.mac) + ' mm（距 MAC 前缘）');
    add('重心与电池仓', '静稳定裕度', r1(cg.staticMargin), '% MAC', '12 ~ 18% 为佳，越大越稳但越迟钝');
    add('重心与电池仓', '电池仓尺寸（长×宽×高）', bayL ? (bayL + ' × ' + bayW + ' × ' + bayH) : '—', 'mm',
      '已留 4~6 mm 装拆余量，仓体中心对准设计重心');
    add('重心与电池仓', '电池规格', pw ? (pw.cells + 'S ' + pw.capacity + ' mAh') : (rw ? (rw.cells + 'S ' + rw.capacity + ' mAh') : '—'), '',
      pw ? ('约 ' + r1(pw.energyWh) + ' Wh') : '');

    // ============ 动力安装 ============
    add('动力安装', '动力形式', pw ? '电动 + 定距螺旋桨' : (rw ? (rw.kind === 'helicopter' ? '电动直升机' : '多旋翼') : '—'), '', '');
    if (pw) {
      add('动力安装', '电机型号', pw.motor, '', (pw.kv || '') + ' KV，重约 ' + (pw.motorMass || '—') + ' g');
      add('动力安装', '电机安装孔距', mount ? (mount[0] + ' × ' + mount[1]) : '—', 'mm', '十字孔距，M3 螺钉；建模时做通孔或预埋螺母');
      add('动力安装', '电机最大直径', r1(pw.motor ? Number(String(pw.motor).replace(/\D/g, '').slice(0, 2)) + 4 : null) || '—', 'mm', '机身机头端需留出此直径');
      add('动力安装', '螺旋桨', pw.propIn + ' × ' + pw.propPitch, 'in', '直径 ' + propDiaMM + ' mm');
      add('动力安装', '桨盘所需净空', propDiaMM, 'mm', '★ 机身两侧、起落架、机翼下方都必须留出此直径的无阻挡空间');
      add('动力安装', '建议离地净空', r1(propDiaMM * 0.15), 'mm', '约为桨径 15%，防止桨尖触地');
      add('动力安装', '电调规格', pw.escA + ' A', '', '静态电流 ' + r1(pw.currentStatic) + ' A，留 30% 余量');
      add('动力安装', '电机座倾角', '右拉 2 ~ 3', '°', '抵消螺旋桨反扭矩，建模时把电机座做成偏转面');
    }
    if (rw) {
      add('动力安装', '旋翼数量', rw.nrotor, '个', '');
      add('动力安装', '单桨直径', mm(rw.rotorDia), 'mm', '相邻桨尖间距建议 ≥ 桨径的 5%');
      add('动力安装', '轴距（对角）', mm(rw.rotorDia * 1.414), 'mm', '四轴按正方形布置时的对角距离');
      add('动力安装', '桨盘净空', mm(rw.rotorDia * 1.05), 'mm', '含机臂宽度');
    }

    // ============ 结构与材料 ============
    add('结构与材料', '主体材料', st.materials || '—', '', '按机型给出的简写，详见「机翼材质」各分项');
    if (mat && mat.wing) {
      add('结构与材料', '机翼材质（推荐）', mat.wing.primary, '', mat.wing.reasons[0] || '');
      add('结构与材料', '机翼结构方案', mat.wing.structure, '', '按用途与载荷选型');
      add('结构与材料', '主梁方案', mat.wing.spar, '', '承弯构件，直径需与翼型内腔匹配');
      add('结构与材料', '蒙皮方案', mat.wing.skin, '', '承扭与外形精度');
      add('结构与材料', '翼肋方案', mat.wing.ribs, '', '维持翼型形状');
      add('结构与材料', '制造工艺', mat.wing.process, '', '制作难度 ' + mat.wing.difficulty + '，成本 ' + mat.wing.cost + '，重量 ' + mat.wing.weight);
      add('结构与材料', '机翼备选方案', mat.wing.alternatives.map(function (a) { return a.name; }).join(' / '), '',
        mat.wing.alternatives.map(function (a) { return a.name + '：' + a.when + '（' + a.tradeoff + '）'; }).join('；'));
      add('结构与材料', '不推荐做法', mat.wing.avoid.join('；'), '', '这些做法在该用途下会明显吃亏');
    }
    add('结构与材料', '设计过载', st.nLimit + ' G', '', '机翼需承受 ' + r1(st.nLimit * c.mass * 9.80665) + ' N 的升力');
    add('结构与材料', '安全系数', st.safetyFactor, '', '');
    add('结构与材料', '翼根弯矩', r1(st.rootMoment) + ' N·m', '', '建模时碳管主梁按此校核');
    add('结构与材料', '碳管主梁直径', r1(st.sparDiaMM), 'mm', '★ 翼型内腔需留出此直径的圆孔；建议外径 ' + r1(st.sparDiaMM) + ' mm');
    add('结构与材料', '主梁位置', '约 30% 弦长', '', '与翼型最大厚度位置重合，受力最优');
    add('结构与材料', '翼肋间距', r1((st.ribSpacing || 0) * 1000), 'mm', '均布 ' + Math.max(2, Math.round((c.span / 2) / (st.ribSpacing || 0.15))) + ' 片/侧');
    add('结构与材料', '副翼舵机扭矩', st.servoAileron + ' kg·cm', '', '共 2 个，装在机翼中段');
    add('结构与材料', '升降舵舵机扭矩', st.servoElevator + ' kg·cm', '', '1 个，装机身尾段');
    add('结构与材料', '方向舵舵机扭矩', st.servoRudder + ' kg·cm', '', '1 个，装机身尾段');
    add('结构与材料', '舵机安装孔建议', 'M2 螺钉 × 4', '', '按所选舵机实际尺寸开孔，长宽各留 0.5 mm 间隙');

    return items;
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
  const TYPE_CN = { trainer: '教练', glider: '滑翔', '3d': '特技', racer: '竞速', cargo: '驮运', endurance: '巡航', edf: '涵道', jet: '喷气', multirotor: '旋翼', heli: '直升机' };

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

    /* ---- 纯输入模式（noAuto）：不搜索、不择优、不联动推导 ---- */
    if (opts.noAuto) {
      const ak = input.anchorKeys;
      // 三套变体只微调梢根比，保证 Top3 结构完整；不碰用户锚定的任何项
      const variants = [
        { tag: '严格按机型模板 + 你的输入' },
        { tag: '梢根比取 0.60', taper: 0.60 },
        { tag: '梢根比取 0.85', taper: 0.85 }
      ];
      const rawBuilt = variants.map(function (v) {
        const a = Object.assign({}, input.anchors);
        if (v.taper != null && a.taper === undefined) a.taper = v.taper;
        const p = buildPlan(Object.assign({}, input, { anchors: a, anchorKeys: ak, raw: true }), type,
          { confidence: 60, rawTag: v.tag });
        p.rawTag = v.tag;
        return p;
      });
      const rawOk = rawBuilt.filter(function (p) { return p.feasible; });
      const rawCands = { all: rawBuilt, feasible: rawOk, best: rawOk[0] || rawBuilt[0] };
      const rawTop3 = pickTop3(rawCands);
      const rawBest = rawTop3[0].plan;
      const rawAirfoilRec = Aero.recommendAirfoils({
        style: type.style, Re: rawBest.core.reCruise || 2e5, needCl: rawBest.values.needCl,
        wantLowTorque: type.id === 'glider' || type.id === 'endurance', forbidSymmetric: type.id !== '3d'
      }, 3);
      const rawPlans = rawTop3.map(function (t) {
        return {
          key: t.objective.key, label: t.objective.name, tag: t.plan.rawTag || t.objective.tag,
          plan: t.plan,
          reasons: explain(t.plan, type, inferred),
          warnings: t.plan.warnings.map(function (w) { return w.name + '：' + w.msg; })
        };
      });
      return {
        ok: true, version: VERSION, typeId: type.id, typeName: type.name,
        mode: 'raw', modeName: '纯输入模式（未使用引擎推荐）',
        inferred: inferred,
        candidatesEvaluated: rawBuilt.length, feasibleCount: rawOk.length,
        top3: rawPlans, best: rawBest, airfoilRecommendations: rawAirfoilRec,
        anchorValues: anchorValues(rawBest),
        modelingParams: modelingParams(rawBest),
        dimensionInfo: (inferred ? inferred.dims : []).map(function (d) { return DIMENSIONS[d]; })
      };
    }

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
      mode: 'auto', modeName: '引擎补全并择优',
      inferred: inferred, candidatesEvaluated: cands.all.length, feasibleCount: cands.feasible.length,
      cleanCount: cands.all.filter(function (p) { return p.clean; }).length,
      top3: plans, best: plans[0].plan, airfoilRecommendations: airfoilRec,
      // 全锚点取值汇总（含引擎计算出的其余锚点，如桨径 / 电机 KV / 续航等）
      anchorValues: anchorValues(plans[0].plan),
      // Inventor 建模设计参数（按零件分组，长度统一 mm）
      modelingParams: modelingParams(plans[0].plan),
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
    anchorValues: anchorValues, modelingParams: modelingParams,
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
