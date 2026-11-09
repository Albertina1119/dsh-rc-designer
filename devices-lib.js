/*!
 * devices-lib.js —— 真实器件库与 BOM 推荐（纯前端 / 零依赖 / 浏览器 + Node 通用）
 *
 * 对应《商业化改造基础版实施方案》5.1：把引擎算出的「规格参数」映射到市面实物型号。
 *
 * 数据字段（每个器件）：
 *   id        编号（品牌-型号，全局唯一）
 *   cat       分类：motor / esc / prop / servo / battery / frame
 *   name      名称
 *   brand     品牌
 *   spec      规格对象（见各类字段约定）
 *   voltage   适用电压范围 [min,max]（V）
 *   thrust    推力范围 [min,max]（N），无则为 null
 *   weight    重量（g）
 *   price     价格等级 1(低)~5(高)
 *   link      购买/资料链接（可为空 —— 空则不显示购买按钮，只显示型号）
 *   compat    兼容机型 id 数组；含 '*' 表示通用
 *
 * 匹配流程（严格按需求给定的顺序）：
 *   ① 按目标推力筛选电机 → ② 按电池节数匹配电压范围 → ③ 按机型过滤兼容类型
 *   → ④ 按「推力余量 + 重量 + 价格等级」综合排序 → 输出前三名
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DevicesLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CATS = {
    motor: { name: '电机', unit: 'KV' },
    esc: { name: '电调', unit: 'A' },
    prop: { name: '螺旋桨', unit: 'in' },
    servo: { name: '舵机', unit: 'kg·cm' },
    battery: { name: '电池', unit: 'mAh' },
    frame: { name: '机架', unit: 'mm' }
  };

  /* =====================================================================
   * 器件库（示例数据集：覆盖常见 2204~5055 电机、3S~8S 电池、9g~40kg 舵机）
   * price：1=¥30 内，2=¥100 内，3=¥300 内，4=¥1000 内，5=¥1000 以上
   * =================================================================== */
  const DEVICES = [
    /* ---------------- 电机 motor ---------------- */
    { id: 'sup-2204-2300', cat: 'motor', brand: 'Superspeed', name: '2204 2300KV', spec: { kv: 2300, poles: 12, maxCurrentA: 18, maxThrustN: 5.4, statorMM: 22 }, voltage: [7.4, 11.1], thrust: [0, 5.4], weight: 25, price: 1, link: '', compat: ['multirotor', 'racer', 'edf'] },
    { id: 'sup-2207-1800', cat: 'motor', brand: 'Superspeed', name: '2207 1800KV', spec: { kv: 1800, poles: 12, maxCurrentA: 38, maxThrustN: 11.8, statorMM: 22 }, voltage: [11.1, 22.2], thrust: [0, 11.8], weight: 32, price: 2, link: '', compat: ['trainer', 'racer', 'cargo', 'edf', 'endurance'] },
    { id: 'sup-2207-2450', cat: 'motor', brand: 'Superspeed', name: '2207 2450KV', spec: { kv: 2450, poles: 12, maxCurrentA: 45, maxThrustN: 13.2, statorMM: 22 }, voltage: [11.1, 14.8], thrust: [0, 13.2], weight: 33, price: 2, link: '', compat: ['racer', 'multirotor', '3d'] },
    { id: 'sup-2306-1700', cat: 'motor', brand: 'Superspeed', name: '2306 1700KV', spec: { kv: 1700, poles: 12, maxCurrentA: 30, maxThrustN: 10.2, statorMM: 23 }, voltage: [11.1, 22.2], thrust: [0, 10.2], weight: 30, price: 2, link: '', compat: ['cargo', 'endurance', 'trainer', 'edf'] },
    { id: 'sup-2814-1000', cat: 'motor', brand: 'Superspeed', name: '2814 1000KV', spec: { kv: 1000, poles: 14, maxCurrentA: 32, maxThrustN: 14.5, statorMM: 28 }, voltage: [11.1, 22.2], thrust: [0, 14.5], weight: 78, price: 3, link: '', compat: ['trainer', 'glider', 'cargo', 'endurance'] },
    { id: 'sup-3520-760', cat: 'motor', brand: 'Superspeed', name: '3520 760KV', spec: { kv: 760, poles: 14, maxCurrentA: 45, maxThrustN: 24.0, statorMM: 35 }, voltage: [14.8, 29.6], thrust: [0, 24.0], weight: 148, price: 3, link: '', compat: ['cargo', 'glider', 'endurance'] },
    { id: 'sup-3520-520', cat: 'motor', brand: 'Superspeed', name: '3520 520KV', spec: { kv: 520, poles: 14, maxCurrentA: 42, maxThrustN: 27.5, statorMM: 35 }, voltage: [22.2, 29.6], thrust: [0, 27.5], weight: 152, price: 3, link: '', compat: ['cargo', 'endurance', 'glider'] },
    { id: 'sup-4250-650', cat: 'motor', brand: 'Superspeed', name: '4250 650KV', spec: { kv: 650, poles: 14, maxCurrentA: 60, maxThrustN: 38.0, statorMM: 42 }, voltage: [22.2, 44.4], thrust: [0, 38.0], weight: 245, price: 4, link: '', compat: ['cargo', 'endurance', 'edf', 'jet'] },
    { id: 'sup-5055-400', cat: 'motor', brand: 'Superspeed', name: '5055 400KV', spec: { kv: 400, poles: 14, maxCurrentA: 75, maxThrustN: 52.0, statorMM: 50 }, voltage: [22.2, 44.4], thrust: [0, 52.0], weight: 385, price: 4, link: '', compat: ['cargo', 'endurance', 'jet'] },
    { id: 'edf-50-4500', cat: 'motor', brand: 'AEO', name: 'EDF 50mm 4500KV', spec: { kv: 4500, poles: 12, maxCurrentA: 32, maxThrustN: 6.0, statorMM: 26, edfMM: 50 }, voltage: [11.1, 14.8], thrust: [0, 6.0], weight: 58, price: 2, link: '', compat: ['edf'] },
    { id: 'edf-64-3500', cat: 'motor', brand: 'AEO', name: 'EDF 64mm 3500KV', spec: { kv: 3500, poles: 12, maxCurrentA: 48, maxThrustN: 11.0, statorMM: 28, edfMM: 64 }, voltage: [14.8, 22.2], thrust: [0, 11.0], weight: 92, price: 3, link: '', compat: ['edf'] },
    { id: 'edf-70-2800', cat: 'motor', brand: 'AEO', name: 'EDF 70mm 2800KV', spec: { kv: 2800, poles: 12, maxCurrentA: 58, maxThrustN: 15.5, statorMM: 28, edfMM: 70 }, voltage: [14.8, 22.2], thrust: [0, 15.5], weight: 118, price: 3, link: '', compat: ['edf'] },
    { id: 'edf-90-1900', cat: 'motor', brand: 'AEO', name: 'EDF 90mm 1900KV', spec: { kv: 1900, poles: 12, maxCurrentA: 88, maxThrustN: 27.5, statorMM: 36, edfMM: 90 }, voltage: [22.2, 29.6], thrust: [0, 27.5], weight: 215, price: 4, link: '', compat: ['edf', 'jet'] },
    { id: 'tur-2kg', cat: 'motor', brand: 'Swiwin', name: '涡喷 2.0 kg', spec: { maxThrustN: 19.6, rpm: 110000, fuel: 'kerosene' }, voltage: [7.4, 7.4], thrust: [0, 19.6], weight: 380, price: 5, link: '', compat: ['jet'] },
    { id: 'tur-4kg', cat: 'motor', brand: 'Swiwin', name: '涡喷 4.0 kg', spec: { maxThrustN: 39.2, rpm: 125000, fuel: 'kerosene' }, voltage: [7.4, 7.4], thrust: [0, 39.2], weight: 680, price: 5, link: '', compat: ['jet'] },
    { id: 'tur-6kg', cat: 'motor', brand: 'Swiwin', name: '涡喷 6.0 kg', spec: { maxThrustN: 58.8, rpm: 130000, fuel: 'kerosene' }, voltage: [7.4, 7.4], thrust: [0, 58.8], weight: 900, price: 5, link: '', compat: ['jet'] },

    /* ---------------- 电调 esc ---------------- */
    { id: 'esc-20a', cat: 'esc', brand: 'Hobbywing', name: '天行者 20A', spec: { currentA: 20, becV: 5, protocol: 'PWM', burstA: 25 }, voltage: [7.4, 14.8], thrust: null, weight: 18, price: 1, link: '', compat: ['*'] },
    { id: 'esc-30a', cat: 'esc', brand: 'Hobbywing', name: '天行者 30A', spec: { currentA: 30, becV: 5, protocol: 'PWM', burstA: 40 }, voltage: [7.4, 14.8], thrust: null, weight: 25, price: 1, link: '', compat: ['*'] },
    { id: 'esc-40a', cat: 'esc', brand: 'Hobbywing', name: '天行者 40A', spec: { currentA: 40, becV: 5, protocol: 'PWM', burstA: 50 }, voltage: [7.4, 22.2], thrust: null, weight: 33, price: 2, link: '', compat: ['*'] },
    { id: 'esc-60a', cat: 'esc', brand: 'Hobbywing', name: '天行者 60A', spec: { currentA: 60, becV: 5, protocol: 'PWM', burstA: 75 }, voltage: [11.1, 22.2], thrust: null, weight: 47, price: 2, link: '', compat: ['*'] },
    { id: 'esc-80a', cat: 'esc', brand: 'Hobbywing', name: '飞腾 80A', spec: { currentA: 80, becV: 6, protocol: 'PWM', burstA: 100 }, voltage: [11.1, 29.6], thrust: null, weight: 68, price: 3, link: '', compat: ['*'] },
    { id: 'esc-120a', cat: 'esc', brand: 'Hobbywing', name: '飞腾 120A HV', spec: { currentA: 120, becV: 0, protocol: 'PWM', burstA: 150 }, voltage: [22.2, 44.4], thrust: null, weight: 104, price: 4, link: '', compat: ['*'] },
    { id: 'esc-4in1-45a', cat: 'esc', brand: 'T-Motor', name: '四合一 45A', spec: { currentA: 45, becV: 5, protocol: 'DShot600', burstA: 55 }, voltage: [11.1, 22.2], thrust: null, weight: 42, price: 3, link: '', compat: ['multirotor', 'heli'] },

    /* ---------------- 螺旋桨 prop ---------------- */
    { id: 'prop-8x4', cat: 'prop', brand: 'APC', name: '8×4 电动桨', spec: { diameterIn: 8, pitchIn: 4, blades: 2, hubMM: 6 }, voltage: [7.4, 14.8], thrust: null, weight: 12, price: 1, link: '', compat: ['trainer', 'racer'] },
    { id: 'prop-9x47', cat: 'prop', brand: 'APC', name: '9×4.7 慢飞桨', spec: { diameterIn: 9, pitchIn: 4.7, blades: 2, hubMM: 6 }, voltage: [7.4, 14.8], thrust: null, weight: 15, price: 1, link: '', compat: ['trainer', 'glider', 'cargo'] },
    { id: 'prop-10x47', cat: 'prop', brand: 'APC', name: '10×4.7 慢飞桨', spec: { diameterIn: 10, pitchIn: 4.7, blades: 2, hubMM: 6 }, voltage: [7.4, 14.8], thrust: null, weight: 19, price: 1, link: '', compat: ['trainer', 'glider', 'cargo', 'endurance'] },
    { id: 'prop-11x55', cat: 'prop', brand: 'APC', name: '11×5.5 电动桨', spec: { diameterIn: 11, pitchIn: 5.5, blades: 2, hubMM: 6 }, voltage: [11.1, 22.2], thrust: null, weight: 24, price: 2, link: '', compat: ['trainer', 'cargo', 'endurance'] },
    { id: 'prop-12x6', cat: 'prop', brand: 'APC', name: '12×6 电动桨', spec: { diameterIn: 12, pitchIn: 6, blades: 2, hubMM: 8 }, voltage: [14.8, 22.2], thrust: null, weight: 31, price: 2, link: '', compat: ['cargo', 'glider', 'endurance'] },
    { id: 'prop-13x65', cat: 'prop', brand: 'APC', name: '13×6.5 电动桨', spec: { diameterIn: 13, pitchIn: 6.5, blades: 2, hubMM: 8 }, voltage: [14.8, 29.6], thrust: null, weight: 38, price: 2, link: '', compat: ['cargo', 'endurance'] },
    { id: 'prop-14x7', cat: 'prop', brand: 'APC', name: '14×7 电动桨', spec: { diameterIn: 14, pitchIn: 7, blades: 2, hubMM: 8 }, voltage: [22.2, 29.6], thrust: null, weight: 46, price: 3, link: '', compat: ['cargo', 'endurance'] },
    { id: 'prop-16x8', cat: 'prop', brand: 'APC', name: '16×8 电动桨', spec: { diameterIn: 16, pitchIn: 8, blades: 2, hubMM: 8 }, voltage: [22.2, 44.4], thrust: null, weight: 61, price: 3, link: '', compat: ['cargo', 'endurance'] },
    { id: 'prop-5x45-3b', cat: 'prop', brand: 'HQ', name: '5×4.5 三叶', spec: { diameterIn: 5, pitchIn: 4.5, blades: 3, hubMM: 5 }, voltage: [14.8, 22.2], thrust: null, weight: 4, price: 1, link: '', compat: ['multirotor', 'racer'] },
    { id: 'prop-7x35-3b', cat: 'prop', brand: 'HQ', name: '7×3.5 三叶', spec: { diameterIn: 7, pitchIn: 3.5, blades: 3, hubMM: 5 }, voltage: [11.1, 22.2], thrust: null, weight: 7, price: 1, link: '', compat: ['multirotor', 'cargo'] },
    { id: 'prop-10x5-3b', cat: 'prop', brand: 'HQ', name: '10×5 三叶', spec: { diameterIn: 10, pitchIn: 5, blades: 3, hubMM: 6 }, voltage: [14.8, 22.2], thrust: null, weight: 16, price: 2, link: '', compat: ['multirotor', 'cargo'] },

    /* ---------------- 舵机 servo ---------------- */
    { id: 'srv-9g', cat: 'servo', brand: 'TowerPro', name: 'SG90 9g', spec: { torqueKgcm: 1.8, speedS60: 0.10, gear: 'nylon' }, voltage: [4.8, 6.0], thrust: null, weight: 9, price: 1, link: '', compat: ['trainer', 'glider', 'racer', 'edf'] },
    { id: 'srv-12g', cat: 'servo', brand: 'Emax', name: 'ES08MA II 12g 金属齿', spec: { torqueKgcm: 2.0, speedS60: 0.12, gear: 'metal' }, voltage: [4.8, 6.0], thrust: null, weight: 12, price: 2, link: '', compat: ['trainer', 'glider', '3d', 'racer', 'edf'] },
    { id: 'srv-17g', cat: 'servo', brand: 'Emax', name: 'ES3004 17g 金属齿', spec: { torqueKgcm: 4.0, speedS60: 0.13, gear: 'metal' }, voltage: [4.8, 6.0], thrust: null, weight: 17, price: 2, link: '', compat: ['trainer', 'cargo', '3d', 'edf', 'endurance'] },
    { id: 'srv-25g', cat: 'servo', brand: 'Savox', name: 'SC-0254MG 25g', spec: { torqueKgcm: 6.5, speedS60: 0.14, gear: 'metal' }, voltage: [4.8, 6.0], thrust: null, weight: 25, price: 3, link: '', compat: ['cargo', '3d', 'endurance', 'jet'] },
    { id: 'srv-std', cat: 'servo', brand: 'Savox', name: 'SC-1256TG 标准舵机', spec: { torqueKgcm: 15.0, speedS60: 0.15, gear: 'titanium' }, voltage: [6.0, 7.4], thrust: null, weight: 52, price: 4, link: '', compat: ['cargo', 'jet', 'endurance', '3d'] },
    { id: 'srv-hv40', cat: 'servo', brand: 'Savox', name: 'SA-1230SG 40kg 高压', spec: { torqueKgcm: 40.0, speedS60: 0.16, gear: 'metal' }, voltage: [6.0, 8.4], thrust: null, weight: 78, price: 5, link: '', compat: ['jet', 'cargo'] },

    /* ---------------- 电池 battery ---------------- */
    { id: 'bat-2s-850', cat: 'battery', brand: 'CNHL', name: '2S 850mAh 25C', spec: { cellS: 2, capacityMah: 850, dischargeC: 25, plug: 'XT30' }, voltage: [7.4, 8.4], thrust: null, weight: 48, price: 1, link: '', compat: ['trainer', 'glider', 'racer'] },
    { id: 'bat-3s-1300', cat: 'battery', brand: 'CNHL', name: '3S 1300mAh 100C', spec: { cellS: 3, capacityMah: 1300, dischargeC: 100, plug: 'XT60' }, voltage: [11.1, 12.6], thrust: null, weight: 118, price: 2, link: '', compat: ['racer', '3d', 'multirotor', 'edf'] },
    { id: 'bat-3s-2200', cat: 'battery', brand: 'CNHL', name: '3S 2200mAh 30C', spec: { cellS: 3, capacityMah: 2200, dischargeC: 30, plug: 'XT60' }, voltage: [11.1, 12.6], thrust: null, weight: 182, price: 2, link: '', compat: ['trainer', 'glider', 'cargo', 'edf', 'endurance'] },
    { id: 'bat-3s-3000', cat: 'battery', brand: 'CNHL', name: '3S 3000mAh 30C', spec: { cellS: 3, capacityMah: 3000, dischargeC: 30, plug: 'XT60' }, voltage: [11.1, 12.6], thrust: null, weight: 246, price: 2, link: '', compat: ['trainer', 'cargo', 'endurance'] },
    { id: 'bat-4s-1500', cat: 'battery', brand: 'CNHL', name: '4S 1500mAh 100C', spec: { cellS: 4, capacityMah: 1500, dischargeC: 100, plug: 'XT60' }, voltage: [14.8, 16.8], thrust: null, weight: 176, price: 3, link: '', compat: ['racer', 'multirotor', 'edf', '3d'] },
    { id: 'bat-4s-3000', cat: 'battery', brand: 'CNHL', name: '4S 3000mAh 40C', spec: { cellS: 4, capacityMah: 3000, dischargeC: 40, plug: 'XT60' }, voltage: [14.8, 16.8], thrust: null, weight: 318, price: 3, link: '', compat: ['cargo', 'edf', 'endurance', 'trainer'] },
    { id: 'bat-6s-5000', cat: 'battery', brand: 'CNHL', name: '6S 5000mAh 40C', spec: { cellS: 6, capacityMah: 5000, dischargeC: 40, plug: 'XT90' }, voltage: [22.2, 25.2], thrust: null, weight: 712, price: 4, link: '', compat: ['cargo', 'endurance', 'edf', 'jet'] },
    { id: 'bat-6s-10000', cat: 'battery', brand: 'CNHL', name: '6S 10000mAh 25C', spec: { cellS: 6, capacityMah: 10000, dischargeC: 25, plug: 'XT90' }, voltage: [22.2, 25.2], thrust: null, weight: 1340, price: 5, link: '', compat: ['cargo', 'endurance', 'jet'] },
    { id: 'bat-8s-5000', cat: 'battery', brand: 'CNHL', name: '8S 5000mAh 30C', spec: { cellS: 8, capacityMah: 5000, dischargeC: 30, plug: 'XT90' }, voltage: [29.6, 33.6], thrust: null, weight: 968, price: 5, link: '', compat: ['cargo', 'endurance', 'jet'] }
  ];

  /* =====================================================================
   * 匹配
   * =================================================================== */

  /** 电压区间是否覆盖给定电压（留 5% 容差，兼容满电/低压） */
  function voltFit(dev, voltage) {
    if (!dev.voltage || !isFinite(voltage)) return 1;
    const lo = dev.voltage[0] * 0.95, hi = dev.voltage[1] * 1.05;
    if (voltage < lo) return 0;
    if (voltage > hi) return 0.3;         // 略超上限：降权而非直接排除
    return 1;
  }

  /** 机型兼容评分 */
  function compatFit(dev, typeId) {
    const c = dev.compat || [];
    if (c.indexOf('*') >= 0) return 1;
    if (c.indexOf(typeId) >= 0) return 1;
    return 0;
  }

  /**
   * 电机匹配：① 推力筛选 → ② 电压匹配 → ③ 机型过滤 → ④ 排序取前三
   * @param {object} req { thrustN, voltage, typeId, twrTarget }
   */
  function matchMotors(req) {
    const need = isFinite(req.thrustN) ? req.thrustN : 0;
    const v = isFinite(req.voltage) ? req.voltage : 11.1;
    const typeId = req.typeId || 'trainer';
    const rows = [];
    DEVICES.filter(d => d.cat === 'motor').forEach(function (d) {
      const maxTh = d.spec && isFinite(d.spec.maxThrustN) ? d.spec.maxThrustN : 0;
      // ① 推力：必须能提供目标推力（留 5% 余量）
      if (maxTh < need * 0.95) return;
      // ② 电压
      const vf = voltFit(d, v);
      if (vf <= 0) return;
      // ③ 机型兼容
      const cf = compatFit(d, typeId);
      if (cf <= 0) return;
      // ④ 排序依据：推力余量（不要过大）+ 重量 + 价格等级
      const margin = need > 0 ? (maxTh - need) / need : 1;         // 0 = 刚好够
      const marginScore = margin <= 0.35 ? 1 : margin <= 0.8 ? 0.8 : margin <= 1.6 ? 0.55 : 0.3;
      const weightScore = maxTh > 0 ? clamp01(1 - (d.weight / 1000) / Math.max(0.05, maxTh / 9.8) * 0.5) : 0.5;
      const priceScore = 1 - (d.price - 1) / 4;
      const score = 0.45 * marginScore + 0.30 * weightScore + 0.25 * priceScore;
      rows.push({
        device: d, score: round(score, 3),
        thrustMarginN: round(maxTh - need, 2),
        thrustMarginPct: need > 0 ? round((maxTh - need) / need * 100, 0) : null,
        reason: '额定 ' + round(maxTh, 1) + ' N 覆盖需求 ' + round(need, 1) + ' N（余量 ' +
          (need > 0 ? round((maxTh - need) / need * 100, 0) + '%' : '—') + '），重 ' + d.weight + ' g，价格等级 ' + d.price
      });
    });
    rows.sort(function (a, b) { return b.score - a.score; });
    return rows.slice(0, 3);
  }

  /** 电调匹配：按静态电流 × 1.3 找规格 */
  function matchEsc(req) {
    const need = isFinite(req.currentA) ? req.currentA * 1.3 : 20;
    const v = isFinite(req.voltage) ? req.voltage : 11.1;
    const typeId = req.typeId || 'trainer';
    return DEVICES.filter(d => d.cat === 'esc')
      .filter(d => (d.spec.currentA || 0) >= need && voltFit(d, v) > 0 && compatFit(d, typeId) > 0)
      .map(function (d) {
        return {
          device: d,
          score: round(0.5 * clamp01(1 - (d.spec.currentA - need) / Math.max(20, need)) + 0.3 * (1 - (d.price - 1) / 4) + 0.2 * clamp01(1 - d.weight / 150), 3),
          reason: d.spec.currentA + ' A ≥ 需求 ' + round(need, 1) + ' A（含 30% 余量）'
        };
      })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, 3);
  }

  /** 螺旋桨匹配：按桨径最接近 + 电压匹配 */
  function matchProp(req) {
    const dia = isFinite(req.diameterIn) ? req.diameterIn : 10;
    const v = isFinite(req.voltage) ? req.voltage : 11.1;
    const typeId = req.typeId || 'trainer';
    return DEVICES.filter(d => d.cat === 'prop')
      .filter(d => voltFit(d, v) > 0 && compatFit(d, typeId) > 0)
      .map(function (d) {
        const dd = Math.abs(d.spec.diameterIn - dia);
        return {
          device: d,
          score: round(0.6 * clamp01(1 - dd / 4) + 0.25 * (1 - (d.price - 1) / 4) + 0.15 * clamp01(1 - d.weight / 80), 3),
          reason: '桨径 ' + d.spec.diameterIn + ' in（目标 ' + round(dia, 1) + ' in，偏差 ' + round(dd, 1) + ' in）'
        };
      })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, 3);
  }

  /** 舵机匹配：按所需扭矩 */
  function matchServo(req) {
    const need = isFinite(req.torqueKgcm) ? req.torqueKgcm : 2;
    const typeId = req.typeId || 'trainer';
    return DEVICES.filter(d => d.cat === 'servo')
      .filter(d => (d.spec.torqueKgcm || 0) >= need * 0.95 && compatFit(d, typeId) > 0)
      .map(function (d) {
        const margin = (d.spec.torqueKgcm - need) / Math.max(0.5, need);
        return {
          device: d,
          score: round(0.55 * clamp01(1 - margin / 3) + 0.25 * (1 - (d.price - 1) / 4) + 0.2 * clamp01(1 - d.weight / 90), 3),
          reason: d.spec.torqueKgcm + ' kg·cm ≥ 需求 ' + round(need, 1) + ' kg·cm'
        };
      })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, 3);
  }

  /** 电池匹配：按容量最接近 + 电压匹配 */
  function matchBattery(req) {
    const capa = isFinite(req.capacityMah) ? req.capacityMah : 2200;
    const v = isFinite(req.voltage) ? req.voltage : 11.1;
    const typeId = req.typeId || 'trainer';
    return DEVICES.filter(d => d.cat === 'battery')
      .filter(d => voltFit(d, v) > 0 && compatFit(d, typeId) > 0)
      .map(function (d) {
        const dc = Math.abs(d.spec.capacityMah - capa);
        return {
          device: d,
          score: round(0.55 * clamp01(1 - dc / Math.max(800, capa)) + 0.25 * (1 - (d.price - 1) / 4) + 0.2 * clamp01(1 - d.weight / 1400), 3),
          reason: d.spec.cellS + 'S ' + d.spec.capacityMah + ' mAh（目标 ' + round(capa, 0) + ' mAh）'
        };
      })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, 3);
  }

  /* =====================================================================
   * BOM
   * =================================================================== */
  /**
   * 由引擎方案生成 BOM
   * @param {object} core  plan.best.core
   * @param {object} type  机型对象（需要 id / rotary / powerKind）
   */
  function buildBom(core, type) {
    if (!core) return { ok: false, error: '缺少计算结果' };
    const pw = core.power, rw = core.rotary;
    const typeId = (type && type.id) || core.typeId || 'trainer';
    const items = [];

    const push = function (group, qty, req, matches, note) {
      items.push({
        group: group, qty: qty, requirement: req,
        candidates: matches,
        best: matches[0] || null,
        note: note || ''
      });
    };

    if (rw) {
      // 旋翼机型：电机 × nrotor、桨 × nrotor、电调、电池
      const perThrust = (core.weight / Math.max(1, rw.nrotor)) / Math.max(0.5, rw.twrTarget);
      push('电机', rw.nrotor, { thrustN: perThrust, voltage: rw.batteryVoltage, typeId: typeId },
        matchMotors({ thrustN: perThrust, voltage: rw.batteryVoltage, typeId: typeId }),
        '每轴需约 ' + round(perThrust, 1) + ' N 推力');
      push('螺旋桨', rw.nrotor, { diameterIn: rw.rotorDia / 0.0254, voltage: rw.batteryVoltage, typeId: typeId },
        matchProp({ diameterIn: rw.rotorDia / 0.0254, voltage: rw.batteryVoltage, typeId: typeId }),
        '桨径 ' + round(rw.rotorDia * 1000, 0) + ' mm');
      push('电调', rw.nrotor, { currentA: rw.currentHover / Math.max(1, rw.nrotor), voltage: rw.batteryVoltage, typeId: typeId },
        matchEsc({ currentA: rw.currentHover / Math.max(1, rw.nrotor), voltage: rw.batteryVoltage, typeId: typeId }),
        '单轴悬停电流约 ' + round(rw.currentHover / Math.max(1, rw.nrotor), 1) + ' A');
      push('电池', 1, { capacityMah: rw.capacity, voltage: rw.batteryVoltage, typeId: typeId },
        matchBattery({ capacityMah: rw.capacity, voltage: rw.batteryVoltage, typeId: typeId }),
        rw.cells + 'S / ' + rw.capacity + ' mAh');
    } else if (pw) {
      const isTurbine = pw.kind === 'turbine';
      push('动力单元', 1, { thrustN: pw.staticThrust, voltage: pw.voltage, typeId: typeId },
        matchMotors({ thrustN: pw.staticThrust, voltage: pw.voltage, typeId: typeId }),
        isTurbine ? ('涡喷 ' + pw.motor + '，燃油 ' + pw.fuelL + ' L，耗油 ' + pw.fuelFlow + ' L/min')
          : (pw.kind === 'edf' ? ('EDF ' + pw.motor + '，静推力 ' + round(pw.staticThrust, 1) + ' N')
            : (pw.motor + ' / ' + pw.kv + 'KV，桨 ' + pw.propIn + '×' + pw.propPitch + ' in')));
      if (!isTurbine) {
        push('螺旋桨', 1, { diameterIn: pw.propIn, voltage: pw.voltage, typeId: typeId },
          matchProp({ diameterIn: pw.propIn, voltage: pw.voltage, typeId: typeId }),
          '目标桨径 ' + pw.propIn + ' in');
      }
      push('电调', 1, { currentA: pw.currentStatic || 0, voltage: pw.voltage, typeId: typeId },
        matchEsc({ currentA: pw.currentStatic || 0, voltage: pw.voltage, typeId: typeId }),
        isTurbine ? '涡喷需 ECU + 接收机电池，无电调' : ('静态电流 ' + round(pw.currentStatic, 1) + ' A'));
      if (!isTurbine && pw.capacity > 0) {
        push('电池', 1, { capacityMah: pw.capacity, voltage: pw.voltage, typeId: typeId },
          matchBattery({ capacityMah: pw.capacity, voltage: pw.voltage, typeId: typeId }),
          pw.cells + 'S / ' + pw.capacity + ' mAh');
      }
      // 舵机
      const st = core.structure;
      if (st) {
        const tq = Math.max(st.servoAileron || 0, st.servoElevator || 0, st.servoRudder || 0);
        push('舵机', 4, { torqueKgcm: tq, typeId: typeId },
          matchServo({ torqueKgcm: tq, typeId: typeId }),
          '最大需求 ' + round(tq, 1) + ' kg·cm（副翼 2 + 升降 1 + 方向 1）');
      }
    }

    const totalLow = items.reduce(function (s, it) {
      return s + (it.best ? priceRankToYuan(it.best.device.price) * it.qty : 0);
    }, 0);

    return {
      ok: true, typeId: typeId, items: items,
      priceEstimate: totalLow,
      priceNote: '按所选器件「价格等级」的区间中值估算，仅供参考',
      missing: items.filter(it => !it.best).map(it => it.group)
    };
  }

  /** 价格等级 → 参考价（元），仅用于粗估 */
  function priceRankToYuan(rank) {
    const map = { 1: 30, 2: 100, 3: 300, 4: 1000, 5: 2500 };
    return map[rank] || 100;
  }
  function priceRankText(rank) {
    const map = { 1: '¥30 内', 2: '¥100 内', 3: '¥300 内', 4: '¥1000 内', 5: '¥1000 以上' };
    return map[rank] || '—';
  }

  /* =====================================================================
   * 导出：JSON / CSV
   * =================================================================== */
  function bomToJson(bom, meta) {
    const m = meta || {};
    return JSON.stringify({
      format: 'dsh-bom@1',
      generatedAt: new Date().toISOString(),
      project: m.name || '未命名方案',
      typeId: bom.typeId,
      priceEstimate: bom.priceEstimate,
      priceNote: bom.priceNote,
      items: bom.items.map(function (it) {
        return {
          group: it.group, qty: it.qty, note: it.note,
          requirement: it.requirement,
          selected: it.best ? {
            id: it.best.device.id, name: it.best.device.name, brand: it.best.device.brand,
            spec: it.best.device.spec, weight: it.best.device.weight,
            priceRank: it.best.device.price, priceText: priceRankText(it.best.device.price),
            link: it.best.device.link || '', score: it.best.score, reason: it.best.reason
          } : null,
          alternatives: it.candidates.slice(1).map(function (c) {
            return { id: c.device.id, name: c.device.name, brand: c.device.brand, score: c.score, link: c.device.link || '' };
          })
        };
      })
    }, null, 2);
  }

  function bomToCsv(bom) {
    const esc = function (v) {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [['分组', '数量', '器件编号', '品牌', '型号', '关键规格', '重量(g)', '价格等级', '参考价', '购买链接', '入选理由']];
    bom.items.forEach(function (it) {
      if (!it.best) { rows.push([it.group, it.qty, '（无匹配）', '', '', '', '', '', '', '', it.note]); return; }
      const d = it.best.device;
      rows.push([
        it.group, it.qty, d.id, d.brand, d.name,
        Object.keys(d.spec).map(function (k) { return k + '=' + d.spec[k]; }).join(' '),
        d.weight, d.price, priceRankText(d.price), d.link || '', it.best.reason
      ]);
    });
    const total = bom.items.reduce(function (s, it) {
      return s + (it.best ? priceRankToYuan(it.best.device.price) * it.qty : 0);
    }, 0);
    rows.push(['合计', '', '', '', '', '', '', '', '约 ¥' + total, '', bom.priceNote]);
    return rows.map(function (r) { return r.map(esc).join(','); }).join('\r\n');
  }

  /* =====================================================================
   * 工具
   * =================================================================== */
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function round(v, n) {
    if (!isFinite(v)) return v;
    const p = Math.pow(10, n == null ? 2 : n);
    return Math.round(v * p) / p;
  }

  function stats() {
    const by = {};
    DEVICES.forEach(function (d) { by[d.cat] = (by[d.cat] || 0) + 1; });
    return { total: DEVICES.length, byCat: by, cats: Object.keys(CATS) };
  }

  return {
    CATS: CATS, DEVICES: DEVICES,
    matchMotors: matchMotors, matchEsc: matchEsc, matchProp: matchProp,
    matchServo: matchServo, matchBattery: matchBattery,
    buildBom: buildBom, bomToJson: bomToJson, bomToCsv: bomToCsv,
    priceRankText: priceRankText, priceRankToYuan: priceRankToYuan,
    stats: stats
  };
});
