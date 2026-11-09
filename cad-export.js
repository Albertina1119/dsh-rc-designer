/*!
 * cad-export.js —— 制造文件导出（纯前端 / 零依赖 / 浏览器 + Node 通用）
 *
 * 对应《商业化改造基础版实施方案》5.3：
 *   1) 翼肋 DXF：由 NACA 翼型坐标点生成闭合多段线，单位毫米
 *   2) 机身侧视 SVG：机身轮廓 + 机翼厚度参考线 + 尺寸标注
 *
 * ⚠ 与方案的偏离（已在交付说明中标注）：
 *   方案指定使用 dxf-writer 库，但该 npm 包只发布 CommonJS 入口（main: index.js）
 *   且带依赖，CDN 上没有任何浏览器单文件构建（dist/* 全部 404）。
 *   本项目是零构建静态站，无法从中受益，因此实现了一个等效的 DXF R12 写出器：
 *   输出标准 ASCII DXF（AC1009），$INSUNITS = 4（毫米），实体为 POLYLINE + VERTEX，
 *   含闭合标志，AutoCAD / LibreCAD / Fusion 360 / Inventor 均可直接打开。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CadExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* =====================================================================
   * 1. DXF R12 写出器
   * =================================================================== */
  function dxfPair(code, value) {
    return String(code) + '\n' + String(value) + '\n';
  }

  /**
   * 生成闭合多段线 DXF
   * @param {Array<[number,number]>} pts 点序列（mm），会自动闭合
   * @param {object} opt { layer, color, version }
   * @returns {string} DXF 文本
   */
  function polylineDxf(pts, opt) {
    const o = opt || {};
    const layer = o.layer || 'AIRFOIL';
    const color = o.color == null ? 7 : o.color;
    const list = (pts || []).filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); });
    let s = '';
    // ---- HEADER ----
    s += dxfPair(0, 'SECTION') + dxfPair(2, 'HEADER');
    s += dxfPair(9, '$ACADVER') + dxfPair(1, 'AC1009');
    s += dxfPair(9, '$INSUNITS') + dxfPair(70, 4);        // 4 = 毫米
    s += dxfPair(9, '$MEASUREMENT') + dxfPair(70, 1);     // 公制
    s += dxfPair(9, '$EXTMIN') + dxfPair(10, 0) + dxfPair(20, 0) + dxfPair(30, 0);
    let maxX = 0, maxY = 0, minY = 0;
    list.forEach(function (p) {
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
      if (p[1] < minY) minY = p[1];
    });
    s += dxfPair(9, '$EXTMAX') + dxfPair(10, +maxX.toFixed(3)) + dxfPair(20, +maxY.toFixed(3)) + dxfPair(30, 0);
    s += dxfPair(0, 'ENDSEC');
    // ---- TABLES（最小图层表，便于 CAD 里区分图层）----
    s += dxfPair(0, 'SECTION') + dxfPair(2, 'TABLES');
    s += dxfPair(0, 'TABLE') + dxfPair(2, 'LAYER') + dxfPair(70, 1);
    s += dxfPair(0, 'LAYER') + dxfPair(2, layer) + dxfPair(70, 0) + dxfPair(62, color) + dxfPair(6, 'CONTINUOUS');
    s += dxfPair(0, 'ENDTAB') + dxfPair(0, 'ENDSEC');
    // ---- ENTITIES ----
    s += dxfPair(0, 'SECTION') + dxfPair(2, 'ENTITIES');
    s += dxfPair(0, 'POLYLINE') + dxfPair(8, layer) + dxfPair(62, color);
    s += dxfPair(66, 1) + dxfPair(70, 1);                 // 66=顶点跟随, 70=1 闭合
    s += dxfPair(10, 0) + dxfPair(20, 0) + dxfPair(30, 0);
    list.forEach(function (p) {
      s += dxfPair(0, 'VERTEX') + dxfPair(8, layer);
      s += dxfPair(10, +p[0].toFixed(4)) + dxfPair(20, +p[1].toFixed(4)) + dxfPair(30, 0);
    });
    s += dxfPair(0, 'SEQEND') + dxfPair(8, layer);
    s += dxfPair(0, 'ENDSEC');
    s += dxfPair(0, 'EOF');
    return s;
  }

  /**
   * 翼肋 DXF：由翼型轮廓点生成
   * @param {object} contour AeroLib.contour() 的返回值（已按弦长缩放）
   * @param {object} opt { chordMM, airfoil, sparDiaMM, sparPosPct, label }
   */
  function ribDxf(contour, opt) {
    const o = opt || {};
    if (!contour || !contour.points || !contour.points.length) {
      return { ok: false, error: '缺少翼型坐标点' };
    }
    const pts = contour.points.map(function (p) { return [p[0], p[1]]; });
    let dxf = polylineDxf(pts, { layer: 'RIB_OUTLINE' });
    // 主梁孔：单独一条闭合圆（用多边形近似），作为第二个 POLYLINE
    if (isFinite(o.sparDiaMM) && o.sparDiaMM > 0) {
      const r = o.sparDiaMM / 2;
      const cx = (o.chordMM || contour.chord || 100) * (isFinite(o.sparPosPct) ? o.sparPosPct / 100 : 0.30);
      const cy = 0;
      const hole = [];
      for (let i = 0; i < 32; i++) {
        const a = (Math.PI * 2 * i) / 32;
        hole.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      const holeDxf = polylineDxf(hole, { layer: 'SPAR_HOLE', color: 1 });
      // 把孔的多段线插到 ENTITIES 段内
      dxf = dxf.replace(dxfPair(0, 'ENDSEC') + dxfPair(0, 'EOF'),
        holeDxf.replace(/^[\s\S]*?ENTITIES\n/, '').replace(dxfPair(0, 'ENDSEC') + dxfPair(0, 'EOF'), '') +
        dxfPair(0, 'ENDSEC') + dxfPair(0, 'EOF'));
    }
    return {
      ok: true, dxf: dxf,
      pointCount: pts.length,
      chordMM: o.chordMM || contour.chord || null,
      layer: 'RIB_OUTLINE',
      filename: (o.airfoil || 'airfoil').replace(/\s+/g, '_') + '_rib_' + Math.round(o.chordMM || contour.chord || 0) + 'mm.dxf'
    };
  }

  /** 简易 DXF 结构自检（供测试与界面提示） */
  function validateDxf(text) {
    const t = String(text || '');
    const checks = {
      hasHeader: t.indexOf('SECTION\n2\nHEADER') >= 0 || t.indexOf('SECTION\r\n2\r\nHEADER') >= 0,
      hasEntities: t.indexOf('\nENTITIES') >= 0,
      hasPolyline: t.indexOf('\nPOLYLINE') >= 0,
      hasVertex: t.indexOf('\nVERTEX') >= 0,
      hasSeqend: t.indexOf('\nSEQEND') >= 0,
      hasEof: /\nEOF\s*$/.test(t),
      insUnitsMM: t.indexOf('$INSUNITS') >= 0 && /\$INSUNITS\n70\n4\n/.test(t),
      acadVersion: /AC1009/.test(t)
    };
    checks.ok = Object.keys(checks).every(function (k) { return checks[k] === true; });
    return checks;
  }

  /* =====================================================================
   * 2. 机身侧视 SVG
   * =================================================================== */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function n(v, d) {
    if (!isFinite(v)) return '0';
    return String(+(+v).toFixed(d == null ? 1 : d));
  }

  /**
   * 生成机身侧视 SVG
   * @param {object} geo { fuselageLength, rootChord, mac, tipChord, tailArm, tailChord,
   *                       wingThicknessPct, tailThicknessPct, cgFromNose, wingHeight, tailHeight,
   *                       airfoil, typeName, projectName }
   *   长度单位 mm
   */
  function fuselageSvg(geo) {
    const g = geo || {};
    const L = num(g.fuselageLength, 900);        // 机身总长
    const cr = num(g.rootChord, 240);            // 根弦
    const cg = num(g.cgFromNose, L * 0.33);      // 重心距机头
    const lh = num(g.tailArm, L * 0.55);         // 尾臂（重心→平尾）
    const ct = num(g.tailChord, cr * 0.6);       // 平尾弦长
    const tcW = num(g.wingThicknessPct, 12) / 100;
    const tcT = num(g.tailThicknessPct, 10) / 100;
    const wh = num(g.wingHeight, L * 0.06);      // 机翼安装高度（机身中心线以上）
    const th = num(g.tailHeight, L * 0.02);

    // 布局：留出四周标注空间
    const padX = Math.max(70, L * 0.09);
    const padY = 90;
    const viewW = L + padX * 2;
    const viewH = Math.max(240, cr * 1.9 + 150);
    const oy = viewH * 0.56;                     // 机身中心线 y
    const ox = padX;                             // 机头 x=0 对应画布 ox

    const X = function (mm) { return ox + mm; };
    const Y = function (mm) { return oy - mm; };  // 屏幕 y 向下，取反

    // 机身外形（简化侧视：机头 → 机背 → 尾锥 → 机腹）
    const noseR = Math.min(L * 0.055, 60);
    const topAtWing = L * 0.055;
    const botAtWing = L * 0.05;
    const bodyTop = [
      [0, 0],
      [noseR * 0.35, topAtWing * 0.55],
      [noseR, topAtWing * 0.88],
      [L * 0.18, topAtWing],
      [Math.max(L * 0.22, cg - cr * 0.5), topAtWing * 1.02],
      [cg + cr * 0.5, topAtWing * 0.95],
      [L * 0.72, topAtWing * 0.62],
      [L - ct * 0.15, th + tcT * ct * 0.5 + L * 0.004]
    ];
    const bodyBot = [
      [L - ct * 0.15, th + tcT * ct * 0.5 + L * 0.004],
      [L * 0.82, -botAtWing * 0.35],
      [cg + cr * 0.5, -botAtWing * 0.98],
      [Math.max(L * 0.22, cg - cr * 0.5), -botAtWing * 1.02],
      [L * 0.18, -botAtWing * 0.85],
      [noseR, -botAtWing * 0.7],
      [noseR * 0.35, -botAtWing * 0.45],
      [0, 0]
    ];
    const bodyPath = bodyTop.map(function (p, i) {
      return (i === 0 ? 'M' : 'L') + n(X(p[0])) + ' ' + n(Y(p[1]));
    }).join(' ') + bodyBot.map(function (p) { return ' L' + n(X(p[0])) + ' ' + n(Y(p[1])); }).join('') + ' Z';

    // 机翼（侧视为一个带厚度的截面）
    const wingX0 = Math.max(0, cg - cr * 0.42);
    const wingY = wh;
    const wt = Math.max(3, cr * tcW);
    const wingPath = 'M' + n(X(wingX0)) + ' ' + n(Y(wingY - wt * 0.5)) +
      ' L' + n(X(wingX0 + cr)) + ' ' + n(Y(wingY - wt * 0.25)) +
      ' L' + n(X(wingX0 + cr)) + ' ' + n(Y(wingY + wt * 0.25)) +
      ' L' + n(X(wingX0)) + ' ' + n(Y(wingY + wt * 0.5)) + ' Z';

    // 平尾（在机尾）
    const tailX0 = Math.min(L - ct, cg + lh - ct * 0.5);
    const tt = Math.max(2, ct * tcT);
    const tailPath = 'M' + n(X(tailX0)) + ' ' + n(Y(th - tt * 0.5)) +
      ' L' + n(X(tailX0 + ct)) + ' ' + n(Y(th - tt * 0.15)) +
      ' L' + n(X(tailX0 + ct)) + ' ' + n(Y(th + tt * 0.15)) +
      ' L' + n(X(tailX0)) + ' ' + n(Y(th + tt * 0.5)) + ' Z';

    // 垂尾
    const finH = Math.max(cr * 0.45, L * 0.14);
    const finX0 = L - ct * 1.05;
    const finPath = 'M' + n(X(finX0)) + ' ' + n(Y(th)) +
      ' L' + n(X(L - ct * 0.25)) + ' ' + n(Y(th + finH)) +
      ' L' + n(X(L)) + ' ' + n(Y(th + finH * 0.96)) +
      ' L' + n(X(L)) + ' ' + n(Y(th)) + ' Z';

    // 重心标记
    const cgX = X(cg), cgY = Y(wh - wt * 0.5 - Math.max(14, cr * 0.12));

    // 尺寸线辅助
    const dimY1 = Y(-Math.max(botAtWing, 20) - cr * 0.55);
    const dimY2 = Y(-Math.max(botAtWing, 20) - cr * 0.95);

    const fontSize = Math.max(11, Math.min(16, L / 60));
    const strokeW = Math.max(1, Math.min(2.2, L / 600));

    const svg = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + n(viewW) + '" height="' + n(viewH) + '" viewBox="0 0 ' + n(viewW) + ' ' + n(viewH) + '">',
      '<title>' + esc((g.projectName || '方案') + ' 机身侧视图') + '</title>',
      '<desc>单位：毫米。机头为 X=0，机身上方为正 Y。翼型 ' + esc(g.airfoil || '—') + '</desc>',
      '<rect x="0" y="0" width="' + n(viewW) + '" height="' + n(viewH) + '" fill="#ffffff"/>',
      // 中心线
      '<line x1="' + n(ox - 40) + '" y1="' + n(Y(0)) + '" x2="' + n(ox + L + 40) + '" y2="' + n(Y(0)) +
      '" stroke="#9aa8bd" stroke-width="0.8" stroke-dasharray="18 6 4 6"/>',
      '<text x="' + n(ox - 40) + '" y="' + n(Y(0) - 6) + '" font-size="' + n(fontSize * 0.78) + '" fill="#7b8aa3">机身中心线</text>',
      // 机身
      '<path d="' + bodyPath + '" fill="#eef3fa" stroke="#22314a" stroke-width="' + n(strokeW) + '"/>',
      // 机翼
      '<path d="' + wingPath + '" fill="#cfe0f5" stroke="#22314a" stroke-width="' + n(strokeW) + '"/>',
      // 平尾
      '<path d="' + tailPath + '" fill="#d8e6f7" stroke="#22314a" stroke-width="' + n(strokeW) + '"/>',
      // 垂尾
      '<path d="' + finPath + '" fill="#d8e6f7" stroke="#22314a" stroke-width="' + n(strokeW) + '"/>',
      // 机翼厚度参考线
      '<line x1="' + n(X(wingX0) - 8) + '" y1="' + n(Y(wingY - wt * 0.5)) + '" x2="' + n(X(wingX0) - 8) + '" y2="' + n(Y(wingY + wt * 0.5)) +
      '" stroke="#e07a1f" stroke-width="' + n(strokeW) + '"/>',
      '<text x="' + n(X(wingX0) - 14) + '" y="' + n(Y(wingY) - 4) + '" font-size="' + n(fontSize * 0.8) + '" fill="#c86712" text-anchor="end">厚度 ' + n(wt) + '</text>',
      // 重心标记
      '<circle cx="' + n(cgX) + '" cy="' + n(cgY) + '" r="' + n(Math.max(3, strokeW * 2.2)) + '" fill="#c33"/>',
      '<line x1="' + n(cgX) + '" y1="' + n(cgY) + '" x2="' + n(cgX) + '" y2="' + n(Y(0) + 6) + '" stroke="#c33" stroke-width="0.8"/>',
      '<text x="' + n(cgX) + '" y="' + n(cgY - 10) + '" font-size="' + n(fontSize * 0.82) + '" fill="#c33" text-anchor="middle">CG</text>',
      // 总长尺寸
      '<line x1="' + n(X(0)) + '" y1="' + n(dimY1) + '" x2="' + n(X(L)) + '" y2="' + n(dimY1) + '" stroke="#556" stroke-width="0.9" marker-start="url(#a)" marker-end="url(#a)"/>',
      '<line x1="' + n(X(0)) + '" y1="' + n(dimY1 - 12) + '" x2="' + n(X(0)) + '" y2="' + n(dimY1 + 12) + '" stroke="#556" stroke-width="0.9"/>',
      '<line x1="' + n(X(L)) + '" y1="' + n(dimY1 - 12) + '" x2="' + n(X(L)) + '" y2="' + n(dimY1 + 12) + '" stroke="#556" stroke-width="0.9"/>',
      '<text x="' + n(X(L / 2)) + '" y="' + n(dimY1 - 8) + '" font-size="' + n(fontSize) + '" fill="#33405a" text-anchor="middle">机身总长 ' + n(L) + ' mm</text>',
      // 尾臂尺寸
      '<line x1="' + n(X(cg)) + '" y1="' + n(dimY2) + '" x2="' + n(X(Math.min(L - ct * 0.5, cg + lh))) + '" y2="' + n(dimY2) + '" stroke="#556" stroke-width="0.9"/>',
      '<line x1="' + n(X(cg)) + '" y1="' + n(dimY2 - 10) + '" x2="' + n(X(cg)) + '" y2="' + n(dimY2 + 10) + '" stroke="#556" stroke-width="0.9"/>',
      '<text x="' + n(X(cg + Math.min(L - ct * 0.5, cg + lh) - cg) / 2 + 0) + '" y="' + n(dimY2 + 20) + '" font-size="' + n(fontSize * 0.86) + '" fill="#33405a" text-anchor="middle">尾臂 ' + n(lh) + ' mm</text>',
      // 根弦尺寸
      '<line x1="' + n(X(wingX0)) + '" y1="' + n(Y(wingY - wt * 0.5) - 16) + '" x2="' + n(X(wingX0 + cr)) + '" y2="' + n(Y(wingY - wt * 0.5) - 16) + '" stroke="#556" stroke-width="0.8"/>',
      '<text x="' + n(X(wingX0 + cr / 2)) + '" y="' + n(Y(wingY - wt * 0.5) - 21) + '" font-size="' + n(fontSize * 0.8) + '" fill="#33405a" text-anchor="middle">根弦 ' + n(cr) + ' mm</text>',
      // 标题
      '<text x="' + n(ox) + '" y="' + n(28) + '" font-size="' + n(fontSize * 1.15) + '" fill="#1b2740" font-weight="600">' +
      esc((g.projectName || '方案') + ' · 机身侧视图') + '</text>',
      '<text x="' + n(ox) + '" y="' + n(46) + '" font-size="' + n(fontSize * 0.82) + '" fill="#7b8aa3">' +
      esc((g.typeName || '') + '　翼型 ' + (g.airfoil || '—') + '　单位 mm　机头 X=0') + '</text>',
      // 箭头定义
      '<defs><marker id="a" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">' +
      '<path d="M0 0 L10 5 L0 10 z" fill="#556"/></marker></defs>',
      '</svg>'
    ].join('\n');

    return {
      ok: true, svg: svg,
      width: Math.round(viewW), height: Math.round(viewH),
      filename: (g.projectName || '方案').replace(/[\\/:*?"<>|]/g, '_') + '_fuselage.svg'
    };
  }

  function num(v, dft) { return isFinite(v) ? v : dft; }

  /** SVG 结构自检 */
  function validateSvg(text) {
    const t = String(text || '');
    const checks = {
      xmlDecl: t.indexOf('<?xml') === 0,
      hasSvg: t.indexOf('<svg ') > 0,
      hasViewBox: /viewBox="/.test(t),
      hasTitle: /<title>/.test(t),
      hasPath: /<path /.test(t),
      hasText: /<text /.test(t),
      closed: /<\/svg>\s*$/.test(t),
      noExternal: !/xlink:href="http/.test(t) && !/<image /.test(t)
    };
    checks.ok = Object.keys(checks).every(function (k) { return checks[k] === true; });
    return checks;
  }

  /** 由引擎 core + modelingParams 组装侧视图几何 */
  function geoFromCore(core, modeling, meta) {
    const m = {};
    (modeling || []).forEach(function (it) { m[it.name] = it.value; });
    const c = core || {};
    const pf = c.planform || {};
    const mm = function (v) { return isFinite(v) ? v : null; };
    return {
      fuselageLength: mm(m['机身总长']) || (isFinite(c.fuselageLength) ? c.fuselageLength * 1000 : 900),
      rootChord: mm(m['根弦 cr']) || (isFinite(pf.root) ? pf.root * 1000 : 240),
      mac: mm(m['平均气动弦 MAC']) || (isFinite(c.cg && c.cg.mac) ? c.cg.mac * 1000 : 220),
      tailArm: mm(m['尾臂 lh']) || (isFinite(c.tail && c.tail.lh) ? c.tail.lh * 1000 : 500),
      tailChord: mm(m['平尾根弦']) || 150,
      wingThicknessPct: (c.airfoil && isFinite(c.airfoil.tc) ? c.airfoil.tc * 100 : 12),
      tailThicknessPct: 10,
      cgFromNose: mm(m['重心距机头']) || 0,
      wingHeight: mm(m['建议最大截面高']) ? m['建议最大截面高'] * 0.55 : 40,
      tailHeight: 4,
      airfoil: (c.airfoil && c.airfoil.designation) || '—',
      typeName: (meta && meta.typeName) || '',
      projectName: (meta && meta.projectName) || '方案'
    };
  }

  return {
    polylineDxf: polylineDxf, ribDxf: ribDxf, validateDxf: validateDxf,
    fuselageSvg: fuselageSvg, validateSvg: validateSvg, geoFromCore: geoFromCore
  };
});
