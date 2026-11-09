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
    { id: 'sup-2207-1800', cat: 'motor', brand: 'Superspeed', name: '2207 1800KV', spec: { kv: 1800, poles: 12, maxCurrentA: 38, maxThrustN: 11.8, statorMM: 22 }, voltage: [11.1, 22.2], thrust: [0, 11.8], weight: 32, price: 2, link: '', compat: ['trainer', 'racer', 'cargo', 'edf', 'endurance', 'glider', '3d'] },
    { id: 'sup-2207-2450', cat: 'motor', brand: 'Superspeed', name: '2207 2450KV', spec: { kv: 2450, poles: 12, maxCurrentA: 45, maxThrustN: 13.2, statorMM: 22 }, voltage: [11.1, 14.8], thrust: [0, 13.2], weight: 33, price: 2, link: '', compat: ['racer', 'multirotor', '3d', 'glider'] },
    { id: 'sup-2306-1700', cat: 'motor', brand: 'Superspeed', name: '2306 1700KV', spec: { kv: 1700, poles: 12, maxCurrentA: 30, maxThrustN: 10.2, statorMM: 23 }, voltage: [11.1, 22.2], thrust: [0, 10.2], weight: 30, price: 2, link: '', compat: ['cargo', 'endurance', 'trainer', 'edf', 'glider'] },
    { id: 'sup-2814-1000', cat: 'motor', brand: 'Superspeed', name: '2814 1000KV', spec: { kv: 1000, poles: 14, maxCurrentA: 32, maxThrustN: 14.5, statorMM: 28 }, voltage: [11.1, 22.2], thrust: [0, 14.5], weight: 78, price: 3, link: '', compat: ['trainer', 'glider', 'cargo', 'endurance', 'heli'] },
    { id: 'sup-3542-1000', cat: 'motor', brand: 'Superspeed', name: '3542 1000KV', spec: { kv: 1000, poles: 14, maxCurrentA: 55, maxThrustN: 22.0, statorMM: 35 }, voltage: [11.1, 22.2], thrust: [0, 22.0], weight: 165, price: 3, link: '', compat: ['3d', 'trainer', 'cargo', 'heli'] },
    { id: 'sup-3548-1100', cat: 'motor', brand: 'Superspeed', name: '3548 1100KV', spec: { kv: 1100, poles: 14, maxCurrentA: 70, maxThrustN: 26.5, statorMM: 35 }, voltage: [11.1, 22.2], thrust: [0, 26.5], weight: 196, price: 3, link: '', compat: ['3d', 'racer', 'cargo', 'heli'] },
    { id: 'sup-3520-760', cat: 'motor', brand: 'Superspeed', name: '3520 760KV', spec: { kv: 760, poles: 14, maxCurrentA: 45, maxThrustN: 24.0, statorMM: 35 }, voltage: [11.1, 29.6], thrust: [0, 24.0], weight: 148, price: 3, link: '', compat: ['cargo', 'glider', 'endurance', 'heli'] },
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
    { id: 'esc-heli-60a', cat: 'esc', brand: 'Hobbywing', name: '铂金 60A V4（直升机）', spec: { currentA: 60, becV: 6, protocol: 'PWM', burstA: 80, gov: '定速' }, voltage: [11.1, 25.2], thrust: null, weight: 63, price: 4, link: '', compat: ['heli'] },
    { id: 'esc-80a', cat: 'esc', brand: 'Hobbywing', name: '飞腾 80A', spec: { currentA: 80, becV: 6, protocol: 'PWM', burstA: 100 }, voltage: [11.1, 29.6], thrust: null, weight: 68, price: 3, link: '', compat: ['*'] },
    { id: 'esc-120a', cat: 'esc', brand: 'Hobbywing', name: '飞腾 120A HV', spec: { currentA: 120, becV: 0, protocol: 'PWM', burstA: 150 }, voltage: [22.2, 44.4], thrust: null, weight: 104, price: 4, link: '', compat: ['*'] },
    { id: 'esc-4in1-45a', cat: 'esc', brand: 'T-Motor', name: '四合一 45A', spec: { currentA: 45, becV: 5, protocol: 'DShot600', burstA: 55 }, voltage: [11.1, 22.2], thrust: null, weight: 42, price: 3, link: '', compat: ['multirotor', 'heli'] },

    /* ---------------- 螺旋桨 prop ---------------- */
    { id: 'prop-6x4', cat: 'prop', brand: 'APC', name: '6×4 电动桨', spec: { diameterIn: 6, pitchIn: 4, blades: 2, hubMM: 5 }, voltage: [3.7, 44.4], thrust: null, weight: 7, price: 1, link: '', compat: ['trainer', 'racer', 'edf', 'glider', 'endurance'] },
    { id: 'prop-6x45-3b', cat: 'prop', brand: 'HQ', name: '6×4.5 三叶', spec: { diameterIn: 6, pitchIn: 4.5, blades: 3, hubMM: 5 }, voltage: [3.7, 44.4], thrust: null, weight: 6, price: 1, link: '', compat: ['multirotor', 'racer', 'edf'] },
    { id: 'prop-7x4', cat: 'prop', brand: 'APC', name: '7×4 慢飞桨', spec: { diameterIn: 7, pitchIn: 4, blades: 2, hubMM: 6 }, voltage: [3.7, 44.4], thrust: null, weight: 9, price: 1, link: '', compat: ['trainer', 'glider', 'edf', 'endurance'] },
    { id: 'prop-7x5', cat: 'prop', brand: 'APC', name: '7×5 电动桨', spec: { diameterIn: 7, pitchIn: 5, blades: 2, hubMM: 6 }, voltage: [3.7, 44.4], thrust: null, weight: 10, price: 1, link: '', compat: ['trainer', 'racer', 'edf', 'endurance'] },
    { id: 'prop-8x4', cat: 'prop', brand: 'APC', name: '8×4 电动桨', spec: { diameterIn: 8, pitchIn: 4, blades: 2, hubMM: 6 }, voltage: [3.7, 44.4], thrust: null, weight: 12, price: 1, link: '', compat: ['trainer', 'racer', 'edf', 'glider', 'endurance'] },
    { id: 'prop-8x6', cat: 'prop', brand: 'APC', name: '8×6 电动桨', spec: { diameterIn: 8, pitchIn: 6, blades: 2, hubMM: 6 }, voltage: [3.7, 44.4], thrust: null, weight: 13, price: 1, link: '', compat: ['trainer', 'racer'] },
    { id: 'prop-9x47', cat: 'prop', brand: 'APC', name: '9×4.7 慢飞桨', spec: { diameterIn: 9, pitchIn: 4.7, blades: 2, hubMM: 6 }, voltage: [3.7, 44.4], thrust: null, weight: 15, price: 1, link: '', compat: ['trainer', 'glider', 'cargo', '3d'] },
    { id: 'prop-9x6', cat: 'prop', brand: 'APC', name: '9×6 电动桨', spec: { diameterIn: 9, pitchIn: 6, blades: 2, hubMM: 6 }, voltage: [3.7, 44.4], thrust: null, weight: 16, price: 1, link: '', compat: ['trainer', 'cargo', 'edf', '3d'] },
    { id: 'prop-10x47', cat: 'prop', brand: 'APC', name: '10×4.7 慢飞桨', spec: { diameterIn: 10, pitchIn: 4.7, blades: 2, hubMM: 6 }, voltage: [3.7, 44.4], thrust: null, weight: 19, price: 1, link: '', compat: ['trainer', 'glider', 'cargo', 'endurance', '3d'] },
    { id: 'prop-10x5', cat: 'prop', brand: 'APC', name: '10×5 电动桨', spec: { diameterIn: 10, pitchIn: 5, blades: 2, hubMM: 6 }, voltage: [3.7, 44.4], thrust: null, weight: 20, price: 1, link: '', compat: ['trainer', 'cargo', 'endurance'] },
    { id: 'prop-11x55', cat: 'prop', brand: 'APC', name: '11×5.5 电动桨', spec: { diameterIn: 11, pitchIn: 5.5, blades: 2, hubMM: 6 }, voltage: [3.7, 44.4], thrust: null, weight: 24, price: 2, link: '', compat: ['trainer', 'cargo', 'endurance', '3d'] },
    { id: 'prop-11x7', cat: 'prop', brand: 'APC', name: '11×7 电动桨', spec: { diameterIn: 11, pitchIn: 7, blades: 2, hubMM: 6 }, voltage: [3.7, 44.4], thrust: null, weight: 26, price: 2, link: '', compat: ['cargo', 'endurance', 'trainer'] },
    { id: 'prop-12x6', cat: 'prop', brand: 'APC', name: '12×6 电动桨', spec: { diameterIn: 12, pitchIn: 6, blades: 2, hubMM: 8 }, voltage: [3.7, 44.4], thrust: null, weight: 31, price: 2, link: '', compat: ['cargo', 'glider', 'endurance', '3d'] },
    { id: 'prop-13x65', cat: 'prop', brand: 'APC', name: '13×6.5 电动桨', spec: { diameterIn: 13, pitchIn: 6.5, blades: 2, hubMM: 8 }, voltage: [3.7, 44.4], thrust: null, weight: 38, price: 2, link: '', compat: ['cargo', 'endurance'] },
    { id: 'prop-14x7', cat: 'prop', brand: 'APC', name: '14×7 电动桨', spec: { diameterIn: 14, pitchIn: 7, blades: 2, hubMM: 8 }, voltage: [3.7, 44.4], thrust: null, weight: 46, price: 3, link: '', compat: ['cargo', 'endurance'] },
    { id: 'prop-15x8', cat: 'prop', brand: 'APC', name: '15×8 电动桨', spec: { diameterIn: 15, pitchIn: 8, blades: 2, hubMM: 8 }, voltage: [3.7, 44.4], thrust: null, weight: 55, price: 3, link: '', compat: ['cargo', 'endurance'] },
    { id: 'prop-16x8', cat: 'prop', brand: 'APC', name: '16×8 电动桨', spec: { diameterIn: 16, pitchIn: 8, blades: 2, hubMM: 8 }, voltage: [3.7, 44.4], thrust: null, weight: 61, price: 3, link: '', compat: ['cargo', 'endurance'] },
    { id: 'prop-5x45-3b', cat: 'prop', brand: 'HQ', name: '5×4.5 三叶', spec: { diameterIn: 5, pitchIn: 4.5, blades: 3, hubMM: 5 }, voltage: [3.7, 44.4], thrust: null, weight: 4, price: 1, link: '', compat: ['multirotor', 'racer'] },
    { id: 'prop-7x35-3b', cat: 'prop', brand: 'HQ', name: '7×3.5 三叶', spec: { diameterIn: 7, pitchIn: 3.5, blades: 3, hubMM: 5 }, voltage: [3.7, 44.4], thrust: null, weight: 7, price: 1, link: '', compat: ['multirotor', 'cargo'] },
    { id: 'prop-10x5-3b', cat: 'prop', brand: 'HQ', name: '10×5 三叶', spec: { diameterIn: 10, pitchIn: 5, blades: 3, hubMM: 6 }, voltage: [3.7, 44.4], thrust: null, weight: 16, price: 2, link: '', compat: ['multirotor', 'cargo', 'heli'] },

    /* ---------------- 舵机 servo ---------------- */
    { id: 'srv-9g', cat: 'servo', brand: 'TowerPro', name: 'SG90 9g', spec: { torqueKgcm: 1.8, speedS60: 0.10, gear: 'nylon' }, voltage: [4.8, 6.0], thrust: null, weight: 9, price: 1, link: '', compat: ['trainer', 'glider', 'racer', 'edf'] },
    { id: 'srv-12g', cat: 'servo', brand: 'Emax', name: 'ES08MA II 12g 金属齿', spec: { torqueKgcm: 2.0, speedS60: 0.12, gear: 'metal' }, voltage: [4.8, 6.0], thrust: null, weight: 12, price: 2, link: '', compat: ['trainer', 'glider', '3d', 'racer', 'edf'] },
    { id: 'srv-17g', cat: 'servo', brand: 'Emax', name: 'ES3004 17g 金属齿', spec: { torqueKgcm: 4.0, speedS60: 0.13, gear: 'metal' }, voltage: [4.8, 6.0], thrust: null, weight: 17, price: 2, link: '', compat: ['trainer', 'cargo', '3d', 'edf', 'endurance'] },
    { id: 'srv-25g', cat: 'servo', brand: 'Savox', name: 'SC-0254MG 25g', spec: { torqueKgcm: 6.5, speedS60: 0.14, gear: 'metal' }, voltage: [4.8, 6.0], thrust: null, weight: 25, price: 3, link: '', compat: ['cargo', '3d', 'endurance', 'jet'] },
    { id: 'srv-std', cat: 'servo', brand: 'Savox', name: 'SC-1256TG 标准舵机', spec: { torqueKgcm: 15.0, speedS60: 0.15, gear: 'titanium' }, voltage: [6.0, 7.4], thrust: null, weight: 52, price: 4, link: '', compat: ['cargo', 'jet', 'endurance', '3d'] },
    { id: 'srv-hv40', cat: 'servo', brand: 'Savox', name: 'SA-1230SG 40kg 高压', spec: { torqueKgcm: 40.0, speedS60: 0.16, gear: 'metal' }, voltage: [6.0, 8.4], thrust: null, weight: 78, price: 5, link: '', compat: ['jet', 'cargo'] },
    { id: 'srv-hv60', cat: 'servo', brand: 'Savox', name: 'SA-1283SG 60kg 高压', spec: { torqueKgcm: 60.0, speedS60: 0.18, gear: 'metal' }, voltage: [6.0, 8.4], thrust: null, weight: 118, price: 5, link: '', compat: ['jet', 'cargo', '3d'] },

    /* ---------------- 电池 battery ---------------- */
    { id: 'bat-2s-850', cat: 'battery', brand: 'CNHL', name: '2S 850mAh 25C', spec: { cellS: 2, capacityMah: 850, dischargeC: 25, plug: 'XT30' }, voltage: [7.4, 8.4], thrust: null, weight: 48, price: 1, link: '', compat: ['trainer', 'glider', 'racer'] },
    { id: 'bat-3s-1300', cat: 'battery', brand: 'CNHL', name: '3S 1300mAh 100C', spec: { cellS: 3, capacityMah: 1300, dischargeC: 100, plug: 'XT60' }, voltage: [11.1, 12.6], thrust: null, weight: 118, price: 2, link: '', compat: ['racer', '3d', 'multirotor', 'edf'] },
    { id: 'bat-3s-2200', cat: 'battery', brand: 'CNHL', name: '3S 2200mAh 30C', spec: { cellS: 3, capacityMah: 2200, dischargeC: 30, plug: 'XT60' }, voltage: [11.1, 12.6], thrust: null, weight: 182, price: 2, link: '', compat: ['trainer', 'glider', 'cargo', 'edf', 'endurance'] },
    { id: 'bat-3s-3000', cat: 'battery', brand: 'CNHL', name: '3S 3000mAh 30C', spec: { cellS: 3, capacityMah: 3000, dischargeC: 30, plug: 'XT60' }, voltage: [11.1, 12.6], thrust: null, weight: 246, price: 2, link: '', compat: ['trainer', 'cargo', 'endurance', 'heli'] },
    { id: 'bat-4s-1500', cat: 'battery', brand: 'CNHL', name: '4S 1500mAh 100C', spec: { cellS: 4, capacityMah: 1500, dischargeC: 100, plug: 'XT60' }, voltage: [14.8, 16.8], thrust: null, weight: 176, price: 3, link: '', compat: ['racer', 'multirotor', 'edf', '3d'] },
    { id: 'bat-4s-3000', cat: 'battery', brand: 'CNHL', name: '4S 3000mAh 40C', spec: { cellS: 4, capacityMah: 3000, dischargeC: 40, plug: 'XT60' }, voltage: [14.8, 16.8], thrust: null, weight: 318, price: 3, link: '', compat: ['cargo', 'edf', 'endurance', 'trainer'] },
    { id: 'bat-6s-5000', cat: 'battery', brand: 'CNHL', name: '6S 5000mAh 40C', spec: { cellS: 6, capacityMah: 5000, dischargeC: 40, plug: 'XT90' }, voltage: [22.2, 25.2], thrust: null, weight: 712, price: 4, link: '', compat: ['cargo', 'endurance', 'edf', 'jet'] },
    { id: 'bat-6s-10000', cat: 'battery', brand: 'CNHL', name: '6S 10000mAh 25C', spec: { cellS: 6, capacityMah: 10000, dischargeC: 25, plug: 'XT90' }, voltage: [22.2, 25.2], thrust: null, weight: 1340, price: 5, link: '', compat: ['cargo', 'endurance', 'jet'] },
    { id: 'bat-8s-5000', cat: 'battery', brand: 'CNHL', name: '8S 5000mAh 30C', spec: { cellS: 8, capacityMah: 5000, dischargeC: 30, plug: 'XT90' }, voltage: [29.6, 33.6], thrust: null, weight: 968, price: 5, link: '', compat: ['cargo', 'endurance', 'jet'] }
  ];

  /* =====================================================================
   * 匹配（修正版）
   *
   * 修复的 4 个问题：
   *  ① 螺旋桨改为「与目标桨径差值最小」优先；差值 > 1 英寸的移到 alternative（可替代）组
   *  ② 电池按「节数」硬过滤，节数不匹配直接淘汰（不再靠电压容差蒙过去）
   *  ③ 电机做「电压 × KV × 桨径」联合校验，并与电调 / 电池做电流自洽检查
   *  ④ 交叉校验的不等式方向（在 design-engine.js 的 rel() 中修正，此处配合输出通过/警告/错误）
   *
   * 所有 match* 函数统一返回 { primary: [...], alternative: [...], checks: [...] }
   * =================================================================== */

  /** 电压区间是否覆盖给定电压（仅用于非电池类；留 5% 容差） */
  function voltFit(dev, voltage) {
    if (!dev.voltage || !isFinite(voltage)) return 1;
    const lo = dev.voltage[0] * 0.95, hi = dev.voltage[1] * 1.05;
    if (voltage < lo) return 0;
    if (voltage > hi) return 0;      // 修正：超范围一律淘汰，不再保留 0.3 的"降权"
    return 1;
  }

  /** 机型兼容评分 */
  function compatFit(dev, typeId) {
    const c = dev.compat || [];
    if (c.indexOf('*') >= 0) return 1;
    if (c.indexOf(typeId) >= 0) return 1;
    return 0;
  }

  /** 由电压推算电池节数（3.7 V/节，就近取整） */
  function cellsOf(voltage) {
    if (!isFinite(voltage) || voltage <= 0) return null;
    return Math.max(1, Math.round(voltage / 3.7));
  }

  /** 给定桨径下的合理转速区间（rpm）—— 用于「电压 × KV × 桨径」联合校验
   *  区间按常见「电机 KV × 电池节数 × 桨径」实测组合校准：
   *  小桨高转速、大桨低转速；下限放宽到常见配置的实际带载转速。 */
  function rpmBandForProp(diaIn) {
    const d = isFinite(diaIn) ? diaIn : 10;
    if (d <= 5) return [18000, 48000];
    if (d <= 6.5) return [12000, 42000];
    if (d <= 8) return [10000, 32000];
    if (d <= 10) return [8500, 26000];
    if (d <= 11.5) return [7500, 20000];
    if (d <= 13) return [6000, 16000];
    if (d <= 16) return [4500, 12000];
    return [3000, 9000];
  }

  /**
   * 电机联合校验：电压 × KV × 桨径
   * @returns { ok:boolean, level:'ok'|'warn'|'error', rpm, band, note }
   */
  function jointCheckMotor(dev, req) {
    const kv = dev.spec && isFinite(dev.spec.kv) ? dev.spec.kv : null;
    const v = isFinite(req.voltage) ? req.voltage : null;
    const dia = isFinite(req.propIn) ? req.propIn : null;
    const isEdm = !!(dev.spec && dev.spec.edfMM);
    const isTurbine = !!(dev.spec && dev.spec.fuel);

    if (isTurbine) {
      const need = isFinite(req.thrustN) ? req.thrustN : 0;
      const have = dev.spec.maxThrustN || 0;
      const ok = have >= need * 0.95;
      return {
        ok: ok, level: ok ? 'ok' : 'error', rpm: dev.spec.rpm || null, band: null,
        note: '涡喷：额定 ' + round(have, 1) + ' N ' + (ok ? '≥' : '<') + ' 需求 ' + round(need, 1) + ' N'
      };
    }
    if (isEdm) {
      const wantMm = isFinite(req.fanMm) ? req.fanMm : (dia ? dia * 25.4 : null);
      const devMm = dev.spec.edfMM;
      const d = wantMm ? Math.abs(devMm - wantMm) / wantMm : 0;
      const ok = d <= 0.15;
      return {
        ok: ok, level: ok ? 'ok' : (d <= 0.3 ? 'warn' : 'error'), rpm: null, band: null,
        note: '涵道：' + devMm + ' mm ' + (wantMm ? ('vs 目标 ' + round(wantMm, 0) + ' mm（偏差 ' + round(d * 100, 0) + '%）') : '')
      };
    }
    if (kv === null || v === null || dia === null) {
      return { ok: true, level: 'ok', rpm: null, band: null, note: '缺少 KV / 电压 / 桨径，跳过联合校验' };
    }
    const rpm = kv * v * 0.85;                 // 带载转速（经验：空载 × 0.85）
    const band = rpmBandForProp(dia);
    if (rpm >= band[0] && rpm <= band[1]) {
      return {
        ok: true, level: 'ok', rpm: round(rpm, 0), band: band,
        note: '转速 ' + round(rpm, 0) + ' rpm @ ' + round(v, 1) + 'V × ' + kv + 'KV，' +
          '落在 ' + round(dia, 1) + 'in 桨的合理区间 ' + band[0] + '~' + band[1] + ' rpm 内'
      };
    }
    const off = rpm < band[0] ? (band[0] - rpm) / band[0] : (rpm - band[1]) / band[1];
    const lvl = off > 0.45 ? 'error' : 'warn';
    const hint = rpm < band[0]
      ? '转速偏低，桨径相对 KV 偏大，建议提高 KV 或减小桨径（否则电流大、易过热）'
      : '转速偏高，桨径相对 KV 偏小，建议降低 KV 或加大桨径（否则效率低、噪声大）';
    return { ok: false, level: lvl, rpm: round(rpm, 0), band: band, note: hint };
  }

  /**
   * 电机匹配：① 推力 → ② 电压 → ③ 机型兼容 → ④ 电压×KV×桨径 联合校验 → ⑤ 排序
   */
  function matchMotors(req) {
    const need = isFinite(req.thrustN) ? req.thrustN : 0;
    const v = isFinite(req.voltage) ? req.voltage : 11.1;
    const typeId = req.typeId || 'trainer';
    const main = [], alt = [], checks = [];

    DEVICES.filter(function (d) { return d.cat === 'motor'; }).forEach(function (d) {
      const maxTh = d.spec && isFinite(d.spec.maxThrustN) ? d.spec.maxThrustN : 0;
      // ① 推力：必须能提供目标推力（留 5% 余量）
      if (maxTh < need * 0.95) return;
      // ② 电压
      if (voltFit(d, v) <= 0) return;
      // ③ 机型兼容
      if (compatFit(d, typeId) <= 0) return;

      const jc = jointCheckMotor(d, {
        voltage: v, propIn: req.propIn, thrustN: need, fanMm: req.fanMm
      });

      const margin = need > 0 ? (maxTh - need) / need : 1;
      const marginScore = margin <= 0.35 ? 1 : margin <= 0.8 ? 0.8 : margin <= 1.6 ? 0.55 : 0.3;
      const weightScore = maxTh > 0 ? clamp01(1 - (d.weight / 1000) / Math.max(0.05, maxTh / 9.8) * 0.5) : 0.5;
      const priceScore = 1 - (d.price - 1) / 4;
      const score = 0.45 * marginScore + 0.30 * weightScore + 0.25 * priceScore;

      const row = {
        device: d, score: round(score, 3),
        thrustMarginN: round(maxTh - need, 2),
        thrustMarginPct: need > 0 ? round((maxTh - need) / need * 100, 0) : null,
        level: jc.level,
        reason: '额定 ' + round(maxTh, 1) + ' N 覆盖需求 ' + round(need, 1) + ' N（余量 ' +
          (need > 0 ? round((maxTh - need) / need * 100, 0) + '%' : '—') + '），重 ' + d.weight +
          ' g，价格等级 ' + d.price + '；' + jc.note
      };
      if (jc.ok) main.push(row);
      else alt.push(row);
      checks.push({ id: d.id, level: jc.level, note: jc.note });
    });

    main.sort(function (a, b) { return b.score - a.score; });
    alt.sort(function (a, b) { return b.score - a.score; });
    return { primary: main.slice(0, 3), alternative: alt.slice(0, 3), checks: checks };
  }

  /** 电调匹配：按静态电流 × 1.3 找规格，电压与机型同样过滤 */
  function matchEsc(req) {
    const need = isFinite(req.currentA) && req.currentA > 0 ? req.currentA * 1.3 : 20;
    const v = isFinite(req.voltage) ? req.voltage : 11.1;
    const typeId = req.typeId || 'trainer';
    const rows = DEVICES.filter(function (d) { return d.cat === 'esc'; })
      .filter(function (d) {
        return (d.spec.currentA || 0) >= need && voltFit(d, v) > 0 && compatFit(d, typeId) > 0;
      })
      .map(function (d) {
        return {
          device: d,
          score: round(0.5 * clamp01(1 - (d.spec.currentA - need) / Math.max(20, need)) +
            0.3 * (1 - (d.price - 1) / 4) + 0.2 * clamp01(1 - d.weight / 150), 3),
          level: 'ok',
          reason: d.spec.currentA + ' A ≥ 需求 ' + round(need, 1) + ' A（已含 30% 余量）'
        };
      })
      .sort(function (a, b) { return b.score - a.score; });
    return { primary: rows.slice(0, 3), alternative: [], checks: [] };
  }

  /**
   * 螺旋桨匹配：修正为「与目标桨径差值最小」优先；
   * 差值 > 1 英寸的移入 alternative（可替代）分组，不再混在推荐里。
   */
  function matchProp(req) {
    const dia = isFinite(req.diameterIn) ? req.diameterIn : 10;
    const v = isFinite(req.voltage) ? req.voltage : 11.1;
    const typeId = req.typeId || 'trainer';
    const limit = 1.0;                         // 允许的最大桨径偏差（英寸）

    const all = DEVICES.filter(function (d) { return d.cat === 'prop'; })
      .filter(function (d) { return voltFit(d, v) > 0 && compatFit(d, typeId) > 0; })
      .map(function (d) {
        const dd = Math.abs(d.spec.diameterIn - dia);
        return {
          device: d,
          dd: round(dd, 2),
          score: round(0.70 * clamp01(1 - dd / 4) + 0.18 * (1 - (d.price - 1) / 4) +
            0.12 * clamp01(1 - d.weight / 80), 3),
          level: dd <= limit ? 'ok' : 'warn',
          reason: '桨径 ' + d.spec.diameterIn + ' in vs 目标 ' + round(dia, 1) + ' in（差 ' +
            round(dd, 2) + ' in' + (dd <= limit ? '，可用' : '，超 1 in 归入可替代') + '）'
        };
      });

    // 主排序：先按与目标桨径的差值（小在前），差值相同再看得分
    all.sort(function (a, b) {
      if (Math.abs(a.dd - b.dd) > 1e-9) return a.dd - b.dd;
      return b.score - a.score;
    });

    const primary = all.filter(function (x) { return x.dd <= limit; });
    const alternative = all.filter(function (x) { return x.dd > limit; });
    return { primary: primary.slice(0, 3), alternative: alternative.slice(0, 3), checks: [] };
  }

  /** 舵机匹配：按所需扭矩 */
  function matchServo(req) {
    const need = isFinite(req.torqueKgcm) ? req.torqueKgcm : 2;
    const typeId = req.typeId || 'trainer';
    const rows = DEVICES.filter(function (d) { return d.cat === 'servo'; })
      .filter(function (d) {
        return (d.spec.torqueKgcm || 0) >= need * 0.95 && compatFit(d, typeId) > 0;
      })
      .map(function (d) {
        const margin = (d.spec.torqueKgcm - need) / Math.max(0.5, need);
        return {
          device: d,
          level: 'ok',
          score: round(0.55 * clamp01(1 - margin / 3) + 0.25 * (1 - (d.price - 1) / 4) +
            0.2 * clamp01(1 - d.weight / 90), 3),
          reason: d.spec.torqueKgcm + ' kg·cm ≥ 需求 ' + round(need, 1) + ' kg·cm'
        };
      })
      .sort(function (a, b) { return b.score - a.score; });
    return { primary: rows.slice(0, 3), alternative: [], checks: [] };
  }

  /**
   * 电池匹配：修正为「节数硬过滤」。
   * 节数 = round(电压 / 3.7)，只有 spec.cellS 完全相等的电池才进入候选。
   */
  function matchBattery(req) {
    const capa = isFinite(req.capacityMah) ? req.capacityMah : 2200;
    const v = isFinite(req.voltage) ? req.voltage : 11.1;
    const typeId = req.typeId || 'trainer';
    const cells = cellsOf(v);
    const eliminated = [];

    const rows = DEVICES.filter(function (d) { return d.cat === 'battery'; })
      .filter(function (d) {
        // ① 节数硬过滤（不匹配直接淘汰，记入 eliminated 供界面说明）
        if (cells !== null && d.spec.cellS !== cells) {
          eliminated.push({ id: d.id, cellS: d.spec.cellS, want: cells });
          return false;
        }
        // ② 机型兼容
        return compatFit(d, typeId) > 0;
      })
      .map(function (d) {
        const dc = Math.abs(d.spec.capacityMah - capa);
        return {
          device: d,
          level: 'ok',
          score: round(0.55 * clamp01(1 - dc / Math.max(800, capa)) +
            0.25 * (1 - (d.price - 1) / 4) + 0.2 * clamp01(1 - d.weight / 1400), 3),
          reason: d.spec.cellS + 'S ' + d.spec.capacityMah + ' mAh（目标 ' + round(capa, 0) +
            ' mAh，' + cells + 'S 硬匹配）'
        };
      })
      .sort(function (a, b) { return b.score - a.score; });

    return {
      primary: rows.slice(0, 3), alternative: [],
      checks: [{ level: rows.length ? 'ok' : 'error', note: cells + 'S 需求下' + (rows.length ? '有 ' + rows.length + ' 款匹配' : '无匹配电池') + '（已淘汰 ' + eliminated.length + ' 款节数不符）' }],
      eliminated: eliminated
    };
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
      const m = matches || { primary: [], alternative: [], checks: [] };
      items.push({
        group: group, qty: qty, requirement: req,
        candidates: m.primary || [],
        alternatives: m.alternative || [],
        checks: m.checks || [],
        best: (m.primary || [])[0] || null,
        note: note || ''
      });
    };

    if (rw) {
      const perThrust = (core.weight / Math.max(1, rw.nrotor)) / Math.max(0.5, rw.twrTarget);
      const cellN = cellsOf(rw.batteryVoltage);
      push('电机', rw.nrotor,
        { thrustN: perThrust, voltage: rw.batteryVoltage, propIn: rw.rotorDia / 0.0254, typeId: typeId },
        matchMotors({ thrustN: perThrust, voltage: rw.batteryVoltage, propIn: rw.rotorDia / 0.0254, typeId: typeId }),
        '每轴需约 ' + round(perThrust, 1) + ' N（' + cellN + 'S）');
      push('螺旋桨', rw.nrotor,
        { diameterIn: rw.rotorDia / 0.0254, voltage: rw.batteryVoltage, typeId: typeId },
        matchProp({ diameterIn: rw.rotorDia / 0.0254, voltage: rw.batteryVoltage, typeId: typeId }),
        '目标桨径 ' + round(rw.rotorDia * 1000, 0) + ' mm（' + round(rw.rotorDia / 0.0254, 2) + ' in）');
      push('电调', rw.nrotor,
        { currentA: rw.currentHover / Math.max(1, rw.nrotor), voltage: rw.batteryVoltage, typeId: typeId },
        matchEsc({ currentA: rw.currentHover / Math.max(1, rw.nrotor), voltage: rw.batteryVoltage, typeId: typeId }),
        '单轴悬停电流约 ' + round(rw.currentHover / Math.max(1, rw.nrotor), 1) + ' A');
      push('电池', 1, { capacityMah: rw.capacity, voltage: rw.batteryVoltage, typeId: typeId },
        matchBattery({ capacityMah: rw.capacity, voltage: rw.batteryVoltage, typeId: typeId }),
        rw.cells + 'S / ' + rw.capacity + ' mAh（节数硬匹配）');
    } else if (pw) {
      const isTurbine = pw.kind === 'turbine';
      const isEdf = pw.kind === 'edf';
      const cellN = cellsOf(pw.voltage);
      push('动力单元', 1,
        { thrustN: pw.staticThrust, voltage: pw.voltage, propIn: pw.propIn, fanMm: pw.edfMm, typeId: typeId },
        matchMotors({ thrustN: pw.staticThrust, voltage: pw.voltage, propIn: pw.propIn, fanMm: pw.edfMm, typeId: typeId }),
        isTurbine ? ('涡喷 ' + pw.motor + '，燃油 ' + pw.fuelL + ' L，耗油 ' + pw.fuelFlow + ' L/min')
          : (isEdf ? ('EDF ' + pw.motor + '，静推力 ' + round(pw.staticThrust, 1) + ' N，' + cellN + 'S')
            : (pw.motor + ' / ' + pw.kv + 'KV，桨 ' + pw.propIn + '×' + pw.propPitch + ' in，' + cellN + 'S')));
      if (!isTurbine && !isEdf) {
        // 涵道风扇的桨叶与风扇是一体，不需要单独选螺旋桨
        push('螺旋桨', 1, { diameterIn: pw.propIn, voltage: pw.voltage, typeId: typeId },
          matchProp({ diameterIn: pw.propIn, voltage: pw.voltage, typeId: typeId }),
          '目标桨径 ' + pw.propIn + ' in（差 ≤1 in 进推荐，超 1 in 归可替代）');
      }
      push('电调', 1, { currentA: pw.currentStatic || 0, voltage: pw.voltage, typeId: typeId },
        matchEsc({ currentA: pw.currentStatic || 0, voltage: pw.voltage, typeId: typeId }),
        isTurbine ? '涡喷需 ECU + 接收机电池，无电调' : ('静态电流 ' + round(pw.currentStatic, 1) + ' A × 1.3'));
      if (!isTurbine && pw.capacity > 0) {
        push('电池', 1, { capacityMah: pw.capacity, voltage: pw.voltage, typeId: typeId },
          matchBattery({ capacityMah: pw.capacity, voltage: pw.voltage, typeId: typeId }),
          pw.cells + 'S / ' + pw.capacity + ' mAh（节数硬匹配）');
      }
      const st = core.structure;
      if (st) {
        const tq = Math.max(st.servoAileron || 0, st.servoElevator || 0, st.servoRudder || 0);
        push('舵机', 4, { torqueKgcm: tq, typeId: typeId },
          matchServo({ torqueKgcm: tq, typeId: typeId }),
          '最大需求 ' + round(tq, 1) + ' kg·cm（副翼 2 + 升降 1 + 方向 1）');
      }
    }

    // ---- 电机 ↔ 电调 ↔ 电池 电流自洽检查（三级） ----
    const consistency = [];
    const motorItem = items.filter(function (it) { return it.group === '电机' || it.group === '动力单元'; })[0];
    const escItem = items.filter(function (it) { return it.group === '电调'; })[0];
    const batItem = items.filter(function (it) { return it.group === '电池'; })[0];

    if (motorItem && motorItem.best && escItem && escItem.best) {
      const mMax = motorItem.best.device.spec.maxCurrentA;
      const escA = escItem.best.device.spec.currentA;
      // ⚠ 电调应按「设计点静态电流 × 余量」选，而不是按电机厂家极限电流选；
      //   电机极限电流只用来判断「是否把小电机顶到过载」。
      const drawA = pw ? (pw.currentStatic || 0) : (rw ? (rw.currentHover || 0) : 0);
      if (isFinite(drawA) && drawA > 0) {
        const need = drawA * 1.25;
        if (escA < need) {
          consistency.push({
            level: escA < drawA ? 'error' : 'warn',
            item: '电调 ↔ 设计电流',
            note: '设计点静态电流 ' + round(drawA, 1) + ' A（×1.25 = ' + round(need, 1) + ' A），所选电调 ' + escA + ' A',
            advice: '换 ≥ ' + Math.ceil(need / 5) * 5 + ' A 的电调，否则持续大油门会过热'
          });
        } else {
          consistency.push({
            level: 'ok', item: '电调 ↔ 设计电流',
            note: '设计点 ' + round(drawA, 1) + ' A × 1.25 = ' + round(need, 1) + ' A ≤ 电调 ' + escA + ' A',
            advice: '无需调整'
          });
        }
      }
      if (isFinite(mMax) && mMax > 0 && isFinite(drawA) && drawA > 0) {
        if (drawA > mMax) {
          consistency.push({
            level: drawA > mMax * 1.2 ? 'error' : 'warn',
            item: '电机负荷',
            note: '设计点电流 ' + round(drawA, 1) + ' A 超过电机额定最大 ' + mMax + ' A',
            advice: '换更大电机，或减小桨径 / 降低电压，把电流压到 ' + mMax + ' A 以内'
          });
        } else {
          consistency.push({
            level: 'ok', item: '电机负荷',
            note: '设计点电流 ' + round(drawA, 1) + ' A ≤ 电机额定 ' + mMax + ' A',
            advice: '无需调整'
          });
        }
      }
      // 电池放电能力（按设计电流，不看电机极限）
      if (batItem && batItem.best && isFinite(drawA) && drawA > 0) {
        {
          const bs = batItem.best.device.spec;
          const contA = (bs.capacityMah / 1000) * bs.dischargeC;
          if (contA < drawA * 1.2) {
            consistency.push({
              level: contA < drawA ? 'error' : 'warn',
              item: '电池 ↔ 设计电流',
              note: '电池持续放电约 ' + round(contA, 1) + ' A（' + bs.capacityMah + ' mAh × ' + bs.dischargeC +
                'C），设计电流 ' + round(drawA, 1) + ' A',
              advice: '换更高 C 率或更大容量电池（建议持续放电 ≥ ' + Math.ceil(drawA * 1.2) + ' A）'
            });
          } else {
            consistency.push({
              level: 'ok', item: '电池 ↔ 设计电流',
              note: '电池持续放电约 ' + round(contA, 1) + ' A ≥ 设计电流 ' + round(drawA, 1) + ' A × 1.2',
              advice: '无需调整'
            });
          }
          // 节数一致性
          const wantCells = cellsOf(pw ? pw.voltage : (rw ? rw.batteryVoltage : 11.1));
          if (wantCells !== null && bs.cellS !== wantCells) {
            consistency.push({
              level: 'error', item: '电池节数',
              note: '方案需要 ' + wantCells + 'S，所选电池为 ' + bs.cellS + 'S',
              advice: '按 ' + wantCells + 'S 重新选电池（节数不匹配会直接改变转速与推力）'
            });
          }
        }
      }
    }

    const totalLow = items.reduce(function (s, it) {
      return s + (it.best ? priceRankToYuan(it.best.device.price) * it.qty : 0);
    }, 0);

    return {
      ok: true, typeId: typeId, items: items,
      consistency: consistency,
      consistencySummary: {
        ok: consistency.filter(function (c) { return c.level === 'ok'; }).length,
        warn: consistency.filter(function (c) { return c.level === 'warn'; }).length,
        error: consistency.filter(function (c) { return c.level === 'error'; }).length
      },
      priceEstimate: totalLow,
      priceNote: '按所选器件「价格等级」的区间中值估算，仅供参考',
      missing: items.filter(function (it) { return !it.best; }).map(function (it) { return it.group; })
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
      consistency: bom.consistency || [],
      consistencySummary: bom.consistencySummary || null,
      items: bom.items.map(function (it) {
        const pack = function (c) {
          return c ? {
            id: c.device.id, name: c.device.name, brand: c.device.brand,
            spec: c.device.spec, weight: c.device.weight,
            priceRank: c.device.price, priceText: priceRankText(c.device.price),
            link: c.device.link || '', score: c.score, level: c.level || 'ok', reason: c.reason
          } : null;
        };
        return {
          group: it.group, qty: it.qty, note: it.note,
          requirement: it.requirement,
          selected: pack(it.best),
          alternatives: (it.alternatives || []).map(pack),
          checks: it.checks || []
        };
      })
    }, null, 2);
  }

  function bomToCsv(bom) {
    const esc = function (v) {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [['分组', '数量', '类型', '器件编号', '品牌', '型号', '关键规格', '重量(g)', '价格等级', '参考价', '购买链接', '入选/说明']];
    bom.items.forEach(function (it) {
      if (!it.best) { rows.push([it.group, it.qty, '无匹配', '', '', '', '', '', '', '', '', it.note]); return; }
      const d = it.best.device;
      rows.push([
        it.group, it.qty, '推荐', d.id, d.brand, d.name,
        Object.keys(d.spec || {}).map(function (k) { return k + '=' + d.spec[k]; }).join(' '),
        d.weight, d.price, priceRankText(d.price), d.link || '', it.best.reason
      ]);
      (it.alternatives || []).forEach(function (c) {
        const a = c.device;
        rows.push([
          it.group, it.qty, '可替代', a.id, a.brand, a.name,
          Object.keys(a.spec || {}).map(function (k) { return k + '=' + a.spec[k]; }).join(' '),
          a.weight, a.price, priceRankText(a.price), a.link || '', c.reason
        ]);
      });
    });
    (bom.consistency || []).forEach(function (c) {
      rows.push(['自洽校验', '', c.level === 'ok' ? '通过' : (c.level === 'warn' ? '警告' : '错误'),
        '', '', c.item, '', '', '', '', '', c.note + '；建议：' + c.advice]);
    });
    const total = bom.items.reduce(function (s, it) {
      return s + (it.best ? priceRankToYuan(it.best.device.price) * it.qty : 0);
    }, 0);
    rows.push(['合计', '', '', '', '', '', '', '', '', '约 ¥' + total, '', bom.priceNote]);
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
