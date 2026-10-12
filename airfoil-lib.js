/*!
 * airfoil-lib.js —— 翼型库与气动/几何公式库（纯 JS，无依赖，浏览器 + Node 通用）
 *
 *   1) NACA 4/5/6 位翼型几何生成（厚度分布、中弧线、上下表面坐标）
 *   2) 内置翼型性能数据库（4 位 / 5 位 / 6 位）
 *   3) 任意 NACA 编号的解析、校验与性能估计（含雷诺数修正）
 *   4) 机翼平面形状、MAC、尾容量、升力线斜率、标准大气、雷诺数
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AeroLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PI = 3.141592653589793;
  const DEG = PI / 180;
  const RAD = 180 / PI;
  const clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };
  const lerp = function (a, b, t) { return a + (b - a) * t; };

  /* =======================================================================
   * 1. NACA 四位厚度分布（标准多项式）
   * ===================================================================== */
  function thicknessDist(x, tc, closed) {
    const s = Math.sqrt(Math.max(0, x));
    const last = closed ? 0.1015 : 0.1036;
    return 5 * tc * (0.2969 * s - 0.1260 * x - 0.3516 * x * x + 0.2843 * x * x * x - last * x * x * x * x);
  }

  /** 四位中弧线 */
  function camber4(x, m, p) {
    if (!m || m <= 1e-9) return { y: 0, dy: 0 };
    if (x < p) {
      return { y: (m / (p * p)) * (2 * p * x - x * x), dy: (2 * m / (p * p)) * (p - x) };
    }
    const q = 1 - p;
    return { y: (m / (q * q)) * ((1 - 2 * p) + 2 * p * x - x * x), dy: (2 * m / (q * q)) * (p - x) };
  }

  /** 五位中弧线（NACA 报告 824） */
  function camber5(x, cl, p) {
    const k1 = camber5K1(cl, p);
    if (p <= 0) return { y: 0, dy: 0 };
    if (x < p) {
      return {
        y: (k1 / 6) * (x * x * x - 3 * p * x * x + p * p * (3 - p) * x),
        dy: (k1 / 6) * (3 * x * x - 6 * p * x + p * p * (3 - p))
      };
    }
    return { y: (k1 / 6) * p * p * p * (1 - x), dy: -(k1 / 6) * p * p * p };
  }
  function camber5K1(cl, p) {
    const tbl = [
      [0.05, 0.30, 361.0], [0.10, 0.30, 150.0], [0.15, 0.30, 83.2], [0.20, 0.30, 52.6], [0.25, 0.30, 36.8],
      [0.05, 0.20, 361.0], [0.10, 0.20, 146.0], [0.15, 0.20, 80.0], [0.20, 0.20, 49.6], [0.25, 0.20, 34.6],
      [0.05, 0.40, 361.0], [0.10, 0.40, 154.0], [0.15, 0.40, 86.4], [0.20, 0.40, 55.6], [0.25, 0.40, 39.2]
    ];
    let best = tbl[9], bestD = Infinity;
    for (let i = 0; i < tbl.length; i++) {
      const d = Math.abs(tbl[i][0] - p) * 4 + Math.abs(tbl[i][1] - cl);
      if (d < bestD) { bestD = d; best = tbl[i]; }
    }
    return best[2];
  }

  /** 单点上下表面坐标 */
  function shape(x, spec) {
    const gen = spec.gen || 4;
    const c = gen === 5 ? camber5(x, spec.camber || 0, spec.pos || 0.15)
                        : camber4(x, spec.camber || 0, spec.pos || 0.4);
    const th = thicknessDist(x, spec.tc, gen === 5);
    const theta = Math.atan(c.dy);
    return {
      xu: x - th * Math.sin(theta), yu: c.y + th * Math.cos(theta),
      xl: x + th * Math.sin(theta), yl: c.y - th * Math.cos(theta),
      yc: c.y, yt: th
    };
  }

  /** 生成完整坐标（默认 80 点/面，余弦分布） */
  function coord(designation, n) {
    const a = parse(designation);
    if (!a.valid) return null;
    const N = n || 80, up = [], lo = [];
    for (let i = 0; i <= N; i++) {
      const x = 0.5 * (1 - Math.cos((PI * i) / N));
      const p = shape(x, a);
      up.push([p.xu, p.yu]);
      lo.push([p.xl, p.yl]);
    }
    return { upper: up, lower: lo, meta: a };
  }

  /* =======================================================================
   * 2. 内置翼型性能数据库
   *    clmax: 二维最大升力系数（Re≈1e5~3e5 模型尺度经验值）
   *    cd0  : 设计升力系数附近二维型阻
   *    cm0  : 零升力矩系数（负 = 低头）
   * ===================================================================== */
  const DB = [
    // ---- 4 位：通用 / 练习 ----
    { d: 'NACA 2412', gen: 4, tc: 0.12, camber: 0.02, pos: 0.40, clmax: 1.60, cd0: 0.0074, aStall: 15.0, cm0: -0.053, a0: 0.104, dc: 0.020, tags: ['通用', '练习'], notes: '经典全能翼型，模型界最常用，失速和缓。' },
    { d: 'NACA 2415', gen: 4, tc: 0.15, camber: 0.02, pos: 0.40, clmax: 1.66, cd0: 0.0090, aStall: 16.5, cm0: -0.055, a0: 0.104, dc: 0.020, tags: ['练习', '载重'], notes: '厚翼型、升力高、内部空间大，适合载重与低速。' },
    { d: 'NACA 2418', gen: 4, tc: 0.18, camber: 0.02, pos: 0.40, clmax: 1.70, cd0: 0.0108, aStall: 17.5, cm0: -0.057, a0: 0.104, dc: 0.020, tags: ['载重', 'FPV'], notes: '很厚，结构友好；阻力偏大，适合慢速长航时。' },
    { d: 'NACA 4412', gen: 4, tc: 0.12, camber: 0.04, pos: 0.40, clmax: 1.72, cd0: 0.0080, aStall: 15.0, cm0: -0.100, a0: 0.106, dc: 0.040, tags: ['通用', '练习', '滑翔'], notes: '升阻比优秀，滑翔机与练习机常青树。' },
    { d: 'NACA 4415', gen: 4, tc: 0.15, camber: 0.04, pos: 0.40, clmax: 1.78, cd0: 0.0097, aStall: 16.0, cm0: -0.102, a0: 0.106, dc: 0.040, tags: ['滑翔', '载重'], notes: '高升力 + 厚截面，适合大翼载与慢速盘旋。' },
    { d: 'NACA 4418', gen: 4, tc: 0.18, camber: 0.04, pos: 0.40, clmax: 1.82, cd0: 0.0117, aStall: 16.5, cm0: -0.104, a0: 0.106, dc: 0.040, tags: ['载重'], notes: '厚且弯，升力极高；高速阻力明显。' },
    { d: 'NACA 3412', gen: 4, tc: 0.12, camber: 0.03, pos: 0.40, clmax: 1.66, cd0: 0.0077, aStall: 15.0, cm0: -0.076, a0: 0.105, dc: 0.030, tags: ['通用'], notes: '介于 2412 与 4412 之间的折中，力矩适中。' },
    { d: 'NACA 3415', gen: 4, tc: 0.15, camber: 0.03, pos: 0.40, clmax: 1.72, cd0: 0.0093, aStall: 16.0, cm0: -0.078, a0: 0.105, dc: 0.030, tags: ['通用', '练习'], notes: '厚截面版 3412，结构空间好。' },
    // ---- 4 位：3D / 特技 / 尾翼（对称） ----
    { d: 'NACA 0012', gen: 4, tc: 0.12, camber: 0.00, pos: 0.00, clmax: 1.20, cd0: 0.0066, aStall: 13.0, cm0: 0.000, a0: 0.102, dc: 0.000, tags: ['3D', '对称', '尾翼'], notes: '全对称翼型，正反特技一致，3D 首选。' },
    { d: 'NACA 0015', gen: 4, tc: 0.15, camber: 0.00, pos: 0.00, clmax: 1.28, cd0: 0.0082, aStall: 14.5, cm0: 0.000, a0: 0.100, dc: 0.000, tags: ['3D', '对称'], notes: '对称厚翼型，3D 与特技机常用；迟失速。' },
    { d: 'NACA 0018', gen: 4, tc: 0.18, camber: 0.00, pos: 0.00, clmax: 1.34, cd0: 0.0100, aStall: 15.5, cm0: 0.000, a0: 0.098, dc: 0.000, tags: ['3D', '对称', '结构'], notes: '很厚、刚性最好，适合大尺寸 3D 与碳管主梁。' },
    { d: 'NACA 0009', gen: 4, tc: 0.09, camber: 0.00, pos: 0.00, clmax: 1.06, cd0: 0.0058, aStall: 11.5, cm0: 0.000, a0: 0.104, dc: 0.000, tags: ['竞速', '对称', '尾翼'], notes: '薄对称，阻力低，适合高速尾翼与竞速机。' },
    { d: 'NACA 0010', gen: 4, tc: 0.10, camber: 0.00, pos: 0.00, clmax: 1.12, cd0: 0.0062, aStall: 12.0, cm0: 0.000, a0: 0.103, dc: 0.000, tags: ['尾翼', '对称'], notes: '薄对称，尾翼/舵面与小型竞速机常用。' },
    { d: 'NACA 0006', gen: 4, tc: 0.06, camber: 0.00, pos: 0.00, clmax: 0.92, cd0: 0.0056, aStall: 10.0, cm0: 0.000, a0: 0.105, dc: 0.000, tags: ['尾翼', '超薄'], notes: '超薄对称，仅推荐做尾翼或极高速舵面。' },
    // ---- 高速 / 竞速 ----
    { d: 'NACA 2410', gen: 4, tc: 0.10, camber: 0.02, pos: 0.40, clmax: 1.46, cd0: 0.0066, aStall: 13.5, cm0: -0.051, a0: 0.106, dc: 0.020, tags: ['竞速', '高速'], notes: '薄翼低阻，竞速机常用；低速升力略紧。' },
    { d: 'NACA 2408', gen: 4, tc: 0.08, camber: 0.02, pos: 0.40, clmax: 1.32, cd0: 0.0060, aStall: 12.0, cm0: -0.049, a0: 0.107, dc: 0.020, tags: ['竞速', '高速', '滑翔'], notes: '极薄翼，阻力低；低速失速突然。' },
    { d: 'NACA 1408', gen: 4, tc: 0.08, camber: 0.01, pos: 0.40, clmax: 1.18, cd0: 0.0058, aStall: 11.5, cm0: -0.028, a0: 0.106, dc: 0.010, tags: ['竞速', '高速'], notes: '低弯度薄翼，高速穿透力强。' },
    // ---- 5 位 ----
    { d: 'NACA 23012', gen: 5, tc: 0.12, camber: 0.0184, pos: 0.15, clmax: 1.58, cd0: 0.0070, aStall: 14.0, cm0: -0.066, a0: 0.105, dc: 0.020, tags: ['通用', '练习'], notes: '前部大弯度，升力高且力矩不大，短距起降友好。' },
    { d: 'NACA 23015', gen: 5, tc: 0.15, camber: 0.0184, pos: 0.15, clmax: 1.64, cd0: 0.0086, aStall: 15.5, cm0: -0.068, a0: 0.104, dc: 0.020, tags: ['练习', '载重'], notes: '厚截面 230 系列，载重平台常用。' },
    { d: 'NACA 23018', gen: 5, tc: 0.18, camber: 0.0184, pos: 0.15, clmax: 1.70, cd0: 0.0104, aStall: 16.5, cm0: -0.070, a0: 0.103, dc: 0.020, tags: ['载重', 'FPV'], notes: '厚、升力高，适合大载重长航时平台。' },
    { d: 'NACA 23021', gen: 5, tc: 0.21, camber: 0.0184, pos: 0.15, clmax: 1.74, cd0: 0.0126, aStall: 17.5, cm0: -0.072, a0: 0.101, dc: 0.020, tags: ['载重', '超厚'], notes: '超厚翼型，极致载重与结构空间，速度牺牲大。' },
    { d: 'NACA 23112', gen: 5, tc: 0.12, camber: 0.0184, pos: 0.15, clmax: 1.60, cd0: 0.0070, aStall: 14.0, cm0: -0.066, a0: 0.105, dc: 0.020, tags: ['通用', '练习'], notes: '23012 的 1.3 倍弯度版本，升力再提升。' },
    { d: 'NACA 23010', gen: 5, tc: 0.10, camber: 0.0184, pos: 0.15, clmax: 1.46, cd0: 0.0066, aStall: 12.5, cm0: -0.064, a0: 0.107, dc: 0.020, tags: ['竞速', '高速'], notes: '薄的 230 系列，高速性能好。' },
    // ---- 6 位（层流） ----
    { d: 'NACA 66-012', gen: 6, tc: 0.12, camber: 0.01, pos: 0.40, clmax: 1.42, cd0: 0.0056, aStall: 13.0, cm0: -0.035, a0: 0.108, dc: 0.010, tags: ['竞速', '层流'], notes: '层流翼型，低阻区宽；表面对工艺质量要求高。' },
    { d: 'NACA 65-210', gen: 6, tc: 0.10, camber: 0.015, pos: 0.50, clmax: 1.38, cd0: 0.0054, aStall: 12.5, cm0: -0.060, a0: 0.109, dc: 0.020, tags: ['竞速', '层流', '滑翔'], notes: '层流 + 适度弯度，竞速与滑翔 L/D 都优秀。' },
    { d: 'NACA 65-415', gen: 6, tc: 0.15, camber: 0.03, pos: 0.50, clmax: 1.58, cd0: 0.0066, aStall: 14.5, cm0: -0.090, a0: 0.108, dc: 0.030, tags: ['长航时', '层流'], notes: '高升力层流翼型，长航时效率好。' },
    { d: 'NACA 65-3-618', gen: 6, tc: 0.18, camber: 0.025, pos: 0.50, clmax: 1.55, cd0: 0.0078, aStall: 15.5, cm0: -0.075, a0: 0.107, dc: 0.025, tags: ['载重', '长航时'], notes: '厚层流翼型，兼顾载重与巡航效率。' },
    { d: 'NACA 6409', gen: 6, tc: 0.09, camber: 0.00, pos: 0.40, clmax: 1.18, cd0: 0.0059, aStall: 12.0, cm0: -0.010, a0: 0.106, dc: 0.000, tags: ['飞翼', '低力矩'], notes: '低力矩翼型，飞翼/无尾布局自稳的关键。' }
  ];

  const BY_NAME = new Map();
  DB.forEach(function (r) {
    BY_NAME.set(r.d.toUpperCase(), r);
    BY_NAME.set(r.d.toUpperCase().replace(/\s+/g, ''), r);
    BY_NAME.set(r.d.toUpperCase().replace(/^NACA\s*/, ''), r);
  });

  /* =======================================================================
   * 3. NACA 编号解析
   * ===================================================================== */
  function clean(s) {
    // 去掉全部前缀 NACA（含重复出现的情况，如 "NACA NACA 2412"）与所有空白
    return String(s == null ? '' : s).toUpperCase().replace(/\s+/g, '').replace(/^(NACA)+/, '');
  }

  function fromRow(row) {
    return {
      valid: true, gen: row.gen, tc: row.tc, camber: row.camber, pos: row.pos,
      cl: row.dc, dc: row.dc,
      code: String(row.d).replace(/^NACA\s*/i, ''),   // 裸编号，如 "2412"
      full: row.d,                                    // 完整写法，如 "NACA 2412"
      series: 'NACA ' + row.gen + ' 位翼型',
      clmax: row.clmax, cd0: row.cd0, aStall: row.aStall, cm0: row.cm0, a0: row.a0,
      notes: row.notes, tags: row.tags.slice(), tabulated: true, reason: ''
    };
  }

  function parse(designation) {
    const c = clean(designation);
    if (!c) return { valid: false, reason: '编号为空', code: c };
    const paren = /[-/]/.test(c);

    // 四位
    if (/^\d{4}$/.test(c)) {
      const m = Number(c.charAt(0)) / 100;
      const p = Number(c.charAt(1)) / 10;
      const tc = Number(c.slice(2)) / 100;
      if (!(tc > 0.01 && tc <= 0.35)) return { valid: false, reason: '厚度须在 1%~35% 弦长之间', code: c };
      if (m > 0 && (p <= 0.05 || p >= 0.95)) return { valid: false, reason: '最大弯度位置须在 5%~95% 弦长之间', code: c };
      const known = BY_NAME.get(c);
      if (known) return fromRow(known);
      return { valid: true, gen: 4, tc: tc, camber: m, pos: m ? p : 0, dc: m * 0.9, code: c, series: 'NACA 四位翼型', reason: '' };
    }

    // 五位
    if (/^\d{5}$/.test(c)) {
      const lead = c.slice(0, 3);
      const tc = Number(c.slice(3)) / 100;
      const map = { 210: 0.10, 220: 0.20, 230: 0.30, 231: 0.30, 232: 0.30, 233: 0.30, 240: 0.40, 241: 0.40, 250: 0.50, 270: 0.70 };
      const cl = map[lead];
      if (cl === undefined) return { valid: false, reason: '未识别的五位系列（支持 210/220/230/231/240/250 等）', code: c };
      if (!(tc > 0.01 && tc <= 0.30)) return { valid: false, reason: '厚度须在 1%~30% 弦长之间', code: c };
      const known = BY_NAME.get(c);
      if (known) return fromRow(known);
      return { valid: true, gen: 5, tc: tc, camber: cl * 0.0614, pos: 0.15, cl: cl, dc: cl, code: c, series: 'NACA 五位翼型', reason: '' };
    }

    // 六位
    if (paren) {
      const m6 = c.match(/^6(?:-)?(\d)?(?:-)?\(?(\d(?:\.\d+)?)?\)?-?(\d{2,3})$/);
      if (m6) {
        const last = m6[3];
        const tc = Number(last.slice(-2)) / 100;
        const cl = m6[2] ? Number(m6[2]) / 10 : 0.2;
        const known = BY_NAME.get(c) || BY_NAME.get('6-' + c.replace(/^6-?/, ''));
        if (known) return fromRow(known);
        if (!(tc > 0.01 && tc <= 0.25)) return { valid: false, reason: '六位翼型厚度须在 1%~25% 弦长之间', code: c };
        return { valid: true, gen: 6, tc: tc, camber: cl * 0.075, pos: 0.5, cl: cl, dc: cl, code: c, series: 'NACA 六位（层流）翼型', reason: '' };
      }
    }
    return { valid: false, reason: '无法识别：请用 4 位（2412）、5 位（23012）或 6 位（65-210）编号', code: c };
  }

  /* =======================================================================
   * 4. 性能估计（表内直取，表外按厚度/弯度经验模型）
   * ===================================================================== */
  function applyReynolds(a, Re) {
    if (!(Re > 0)) return Object.assign({}, a, { Re: 0, reFactor: 1 });
    const d = clamp(Math.log10(Re) - Math.log10(2.0e5), -1.2, 1.0);
    const kCl = clamp(1 + 0.07 * d, 0.85, 1.10);
    const kCd = clamp(1 - 0.18 * d, 0.75, 1.7);
    return Object.assign({}, a, {
      clmax: clamp(a.clmax * kCl, 0.5, 2.6),
      cd0: clamp(a.cd0 * kCd, 0.0035, 0.05),
      aStall: clamp(a.aStall * (1 + 0.04 * d), 6, 24),
      Re: Re, reFactor: kCd
    });
  }

  function estimate(designation, Re) {
    const p = parse(designation);
    // 编号无法识别时，绝不能返回缺少气动数据的空壳（否则下游全是 NaN）。
    // 这里退回 NACA 2412 的完整数据，并留下 substituted / reason 供上层提示。
    if (!p.valid) {
      const fb = BY_NAME.get('2412');
      const base = fromRow(fb);
      return applyReynolds(Object.assign(base, {
        designation: String(designation),
        estimate: true, substituted: true, reason: p.reason,
        notes: '编号「' + designation + '」无法识别（' + p.reason + '），已临时按 NACA 2412 计算。'
      }), Re);
    }

    const key = clean(designation);
    const row = BY_NAME.get(key) || BY_NAME.get(key.replace(/^6-/, '6')) || BY_NAME.get(key.replace(/^6/, '6-'));
    if (row) return applyReynolds(Object.assign(fromRow(row), { designation: row.d, estimate: false }), Re);

    const tc = p.tc, cam = p.camber, dc = p.dc, tcp = tc * 100;
    // 经验拟合（与内置表同量级）：0012→1.20、2412→1.44、2415→1.75、4415→1.93、23012→1.55
    const camberEffect = cam < 0.005 ? 0.55 * cam : 2.4 * cam + 8 * cam * dc;
    const base = {
      valid: true,
      designation: 'NACA ' + p.code,
      gen: p.gen, tc: tc, camber: cam, pos: p.pos, dc: dc, cl: p.cl,
      clmax: clamp(1.02 + 0.37 * tc + camberEffect, 0.7, 2.3),
      cd0: clamp(0.0040 + 0.034 * tc + 0.052 * cam, 0.004, 0.03),
      aStall: clamp(9.5 + 34 * tc + 22 * cam, 8, 20),
      cm0: -(0.42 * dc + 0.008),
      a0: clamp(0.100 + 0.03 * tc, 0.095, 0.112),
      series: p.series,
      notes: '非内置翼型，性能由厚度/弯度经验模型估算。',
      tags: ['自定义'], tabulated: false, estimate: true
    };
    return applyReynolds(base, Re);
  }

  /* =======================================================================
   * 5. 翼型推荐（按机型用途 + 雷诺数 + 升力需求综合打分）
   * ===================================================================== */
  const THICK_BAND = {
    trainer: [11, 14], glider: [8.5, 12], '3d': [12, 18], racer: [7, 10.5],
    cargo: [14, 19], endurance: [11, 16], 'flying-wing': [8, 12]
  };
  const CLASSIC = ['NACA 2412', 'NACA 4412', 'NACA 0012', 'NACA 23012', 'NACA 2415', 'NACA 0015', 'NACA 6409', 'NACA 65-210'];

  function recommendAirfoils(rec, topN) {
    const N = topN || 3;
    const style = (rec && rec.style) || 'trainer';
    const Re = (rec && rec.Re) || 2.0e5;
    const needCl = rec && rec.needCl;
    const band = THICK_BAND[style] || [10, 14];
    const scored = [];

    DB.forEach(function (row) {
      const a = fromRow(row);
      const tcp = a.tc * 100;
      const sym = a.camber < 0.005;
      const why = [];
      let s = 50;

      // 厚度匹配
      const tcErr = tcp < band[0] ? band[0] - tcp : (tcp > band[1] ? tcp - band[1] : 0);
      s -= tcErr * 4.5;
      if (tcErr === 0) why.push('厚度 ' + tcp.toFixed(0) + '% 正落在该机型最佳区间 ' + band[0] + '~' + band[1] + '%');

      if (CLASSIC.indexOf(row.d) >= 0) s += 6;

      // 用途匹配
      if (style === '3d') {
        if (sym) { s += 18; why.push('对称翼型，正飞/倒飞一致，特技动作不偏'); } else s -= 12;
      } else if (style === 'racer') {
        if (a.cd0 <= 0.0062) { s += 12; why.push('型阻仅 ' + Math.round(a.cd0 * 1e4) + ' counts，高速阻力小'); }
        if (sym && needCl > 0.55) s -= 10;
        if (a.camber >= 0.01 && a.camber <= 0.03) s += 4;
      } else if (style === 'glider') {
        if (sym) s -= 26;
        if (a.cd0 <= 0.0066) { s += 12; why.push('低阻薄翼/层流特性，滑翔比好'); }
        if (a.camber >= 0.025 && a.camber <= 0.045) { s += 10; why.push('弯度适中，低阻区升力充足'); }
        if (tcp > 13) s -= 6;
      } else if (style === 'cargo' || style === 'endurance') {
        if (tcp >= 14) { s += 10; why.push('厚截面内部空间大，便于主梁与设备布置'); }
        if (a.clmax >= 1.55) { s += 6; why.push('升力高，可降低起降速度'); }
        if (sym) s -= 10;
      } else if (style === 'flying-wing') {
        if (Math.abs(a.cm0) <= 0.02) { s += 24; why.push('零升力矩极小，飞翼配平损失小'); } else s -= 20;
        if (a.cd0 <= 0.0062) s += 8;
        if (a.camber >= 0.015 && a.camber <= 0.03) s += 6;
        if (row.d === 'NACA 6409') { s += 12; why.push('专为低力矩设计的翼型，飞翼/无尾布局首选'); }
      } else { // trainer
        if (a.camber >= 0.015 && a.camber <= 0.045) { s += 10; why.push('有弯度、失速和缓，练习机手感友好'); }
        if (sym) s -= 14;
        if (tcp >= 11 && tcp <= 15) s += 6;
      }

      // 升力需求
      if (needCl) {
        s -= Math.abs(a.clmax - needCl) * (needCl > a.clmax ? 26 : 9);
        if (a.clmax + 0.05 >= needCl) why.push('CLmax ' + a.clmax.toFixed(2) + ' 覆盖设计需求 ' + needCl.toFixed(2));
        else why.push('CLmax ' + a.clmax.toFixed(2) + ' 略低于需求 ' + needCl.toFixed(2) + '，需加大翼面积');
      }

      // 雷诺数
      if (Re < 1.2e5) { if (tcp < 9) { s -= 12; why.push('低雷诺数下过薄翼型易提前分离'); } else s += 6; }
      if (Re > 6e5 && a.gen === 6) { s += 8; why.push('高雷诺数下层流翼型减阻收益明显'); }
      if (Re < 1.5e5 && a.gen === 6) s -= 8;

      if (rec && rec.forbidSymmetric && sym) s -= 40;
      if (rec && rec.wantLowTorque && Math.abs(a.cm0) > 0.02) s -= 10;

      scored.push({
        designation: row.d, gen: a.gen, tc: a.tc, camber: a.camber, dc: a.dc,
        clmax: a.clmax, cd0: a.cd0, aStall: a.aStall, cm0: a.cm0, a0: a.a0,
        notes: a.notes, tags: a.tags, why: why.slice(0, 4),
        score: Math.round(clamp(s, 1, 99))
      });
    });

    scored.sort(function (x, y) { return y.score - x.score || x.cd0 - y.cd0; });

    // 去重：同厚度档 + 同弯度类型只留最优，保证 Top3 有区分度
    const seen = {}, top = [];
    scored.forEach(function (a) {
      const key = Math.round(a.tc * 100) + '|' + (a.camber < 0.005 ? 'sym' : 'cam');
      if (seen[key]) return;
      seen[key] = 1;
      top.push(a);
    });
    // 若多样性约束导致不足 N 个，再从完整排序补足
    for (let i = 0; top.length < N && i < scored.length; i++) {
      if (top.indexOf(scored[i]) < 0) top.push(scored[i]);
    }
    return top.slice(0, N);
  }

  /* =======================================================================
   * 6. 常用公式
   * ===================================================================== */
  function isa(h) {
    const T = 288.15 - 0.0065 * (h || 0);
    return { T: T, rho: 1.225 * Math.pow(T / 288.15, 4.2561) };
  }
  function reynolds(V, chord, rho, mu) {
    return (V * chord) / (mu || 1.81e-5);
  }
  /** 机翼平面形状（矩形/梯形） */
  function planform(span, area, taper) {
    const lambda = clamp(taper == null ? 1 : taper, 0.25, 1);
    const root = (2 * area) / (span * (1 + lambda));
    const tip = root * lambda;
    const mac = (2 / 3) * root * ((1 + lambda + lambda * lambda) / (1 + lambda));
    const yMac = (span / 6) * ((1 + 2 * lambda) / (1 + lambda));
    return {
      span: span, area: area, ar: (span * span) / area, taper: lambda,
      root: root, tip: tip, mac: mac, yMac: yMac,
      meanChord: area / span            // 平均几何弦长 c̄ = S / b
    };
  }
  /** 尾容量 Vh = Sh·lh/(S·MAC)，Vv = Sv·lv/(S·b) */
  function tailVolume(Sh, Sv, lh, lv, S, mac, span) {
    return { vh: (Sh * lh) / (S * mac), vv: (Sv * lv) / (S * span) };
  }
  /**
   * 三维升力线斜率（1/rad）
   * 采用 Pratt & Whitney / 教科书有限翼展修正：a = a0 / (1 + a0/(π·AR·cosΛ))
   * 典型值：AR=2→3.05、AR=6→4.20、AR=12→4.99、AR→∞→a0
   */
  function liftCurveSlope(a0, ar, sweepDeg) {
    // a0 传入单位统一按 1/deg 处理（内置表与经验公式均为该单位），内部换算成 1/rad
    const a2dDeg = (typeof a0 === 'number' && a0 > 0.02 && a0 < 0.2) ? a0 : 0.104;
    const a2d = a2dDeg * RAD;                       // 1/rad，二维约 5.9~6.1
    const AR = (typeof ar === 'number' && ar > 0.5) ? ar : 6;
    const cosS = Math.cos(((typeof sweepDeg === 'number' ? sweepDeg : 0) * Math.PI) / 180);
    const kappa = 1 + 2 / AR;                       // 低展弦比经验修正（Raymer/Anderson）
    return (a2d * cosS) / (1 + (a2d * kappa * cosS) / (Math.PI * AR));
  }

  return {
    PI: PI, DEG: DEG, RAD: RAD, clamp: clamp, lerp: lerp,
    isa: isa, reynolds: reynolds,
    AIRFOILS: DB, DB: DB, t4: thicknessDist, thicknessDist: thicknessDist,
    camber4: camber4, camber5: camber5, shape: shape, coord: coord,
    parse: parse, estimate: estimate, applyReynolds: applyReynolds,
    recommendAirfoils: recommendAirfoils,
    planform: planform, tailVolume: tailVolume, liftCurveSlope: liftCurveSlope,
    all: function () { return DB.map(fromRow); },
    thicknessBand: THICK_BAND
  };
});
