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
   * 翼肋 DXF：由翼型轮廓点生成，可选加主梁孔 / 主梁槽 / 定位孔
   * @param {object} contour AeroLib.contour() 的返回值（已按弦长缩放）
   * @param {object} opt {
   *   chordMM, airfoil,
   *   sparDiaMM,        // 圆孔直径（mm），与 sparSlot 二选一或都不传
   *   sparPosPct,       // 孔/槽中心在弦向的位置（0~1，默认 0.30）
   *   sparSlot,         // { w, h } 矩形梁槽（mm），传了就用矩形代替圆孔
   *   jig               // true = 加两个定位孔（⌀3 mm，位于 15% / 85% 弦长）
   * }
   */
  function ribDxf(contour, opt) {
    const o = opt || {};
    if (!contour || !contour.points || !contour.points.length) {
      return { ok: false, error: '缺少翼型坐标点' };
    }
    const chord = isFinite(o.chordMM) ? o.chordMM : (contour.chord || 100);
    const pts = contour.points.map(function (p) { return [p[0], p[1]]; });
    const entities = [];
    entities.push(polyBody(pts, 'RIB_OUTLINE', 7));

    const posPct = isFinite(o.sparPosPct) ? o.sparPosPct : 0.30;
    const cx = chord * posPct;
    const features = [];

    // 主梁槽（矩形）优先，其次圆孔
    if (o.sparSlot && o.sparSlot.w > 0 && o.sparSlot.h > 0) {
      const w = o.sparSlot.w / 2, h = o.sparSlot.h / 2;
      entities.push(polyBody([[cx - w, -h], [cx + w, -h], [cx + w, h], [cx - w, h]], 'SPAR_SLOT', 1));
      features.push('梁槽 ' + o.sparSlot.w + '×' + o.sparSlot.h + ' mm @ ' + Math.round(posPct * 100) + '% 弦长');
    } else if (isFinite(o.sparDiaMM) && o.sparDiaMM > 0) {
      const r = o.sparDiaMM / 2;
      entities.push(polyBody(circlePts(cx, 0, r, 32), 'SPAR_HOLE', 1));
      features.push('主梁孔 ⌀' + o.sparDiaMM + ' mm @ ' + Math.round(posPct * 100) + '% 弦长');
    }

    // 定位孔：两个 ⌀3 mm，位于 15% / 85% 弦长，沿弦线下方 8% 弦长处
    if (o.jig) {
      const jr = 1.5;
      const jy = -Math.max(3, chord * 0.08);
      [0.15, 0.85].forEach(function (f, i) {
        entities.push(polyBody(circlePts(chord * f, jy, jr, 16), 'JIG_HOLE', 3));
      });
      features.push('定位孔 2 × ⌀3 mm @ 15% / 85% 弦长');
    }

    const dxf = assembleDxf(entities);
    return {
      ok: true, dxf: dxf,
      pointCount: pts.length,
      chordMM: chord,
      features: features,
      layer: 'RIB_OUTLINE',
      filename: (o.airfoil || 'airfoil').replace(/\s+/g, '_') + '_rib_' + Math.round(chord) + 'mm.dxf'
    };
  }

  /** 圆点集 */
  function circlePts(cx, cy, r, n) {
    const out = [];
    const N = n || 24;
    for (let i = 0; i < N; i++) {
      const a = (Math.PI * 2 * i) / N;
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return out;
  }

  /** 单条闭合多段线的 DXF 片段（不含 SECTION 包装） */
  function polyBody(pts, layer, color) {
    const list = (pts || []).filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); });
    let s = '';
    s += dxfPair(0, 'POLYLINE') + dxfPair(8, layer || '0') + dxfPair(62, color == null ? 7 : color);
    s += dxfPair(66, 1) + dxfPair(70, 1);
    s += dxfPair(10, 0) + dxfPair(20, 0) + dxfPair(30, 0);
    list.forEach(function (p) {
      s += dxfPair(0, 'VERTEX') + dxfPair(8, layer || '0');
      s += dxfPair(10, +p[0].toFixed(4)) + dxfPair(20, +p[1].toFixed(4)) + dxfPair(30, 0);
    });
    s += dxfPair(0, 'SEQEND') + dxfPair(8, layer || '0');
    return s;
  }

  /** 用若干实体片段组装完整 DXF（R12 / mm / 含图层表） */
  function assembleDxf(bodies) {
    const layers = {};
    bodies.forEach(function (b) {
      const m = /\n8\n([^\n]+)\n/.exec(b);
      const c = /\n62\n(\d+)\n/.exec(b);
      if (m) layers[m[1]] = c ? Number(c[1]) : 7;
    });
    let maxX = 0, maxY = 0;
    bodies.forEach(function (b) {
      const re = /\n10\n(-?[\d.]+)\n20\n(-?[\d.]+)\n/g;
      let m;
      while ((m = re.exec(b))) {
        const x = parseFloat(m[1]), y = parseFloat(m[2]);
        if (isFinite(x) && Math.abs(x) > maxX) maxX = Math.abs(x);
        if (isFinite(y) && Math.abs(y) > maxY) maxY = Math.abs(y);
      }
    });

    let s = '';
    s += dxfPair(0, 'SECTION') + dxfPair(2, 'HEADER');
    s += dxfPair(9, '$ACADVER') + dxfPair(1, 'AC1009');
    s += dxfPair(9, '$INSUNITS') + dxfPair(70, 4);
    s += dxfPair(9, '$MEASUREMENT') + dxfPair(70, 1);
    s += dxfPair(9, '$EXTMIN') + dxfPair(10, 0) + dxfPair(20, -maxY.toFixed(3)) + dxfPair(30, 0);
    s += dxfPair(9, '$EXTMAX') + dxfPair(10, maxX.toFixed(3)) + dxfPair(20, maxY.toFixed(3)) + dxfPair(30, 0);
    s += dxfPair(0, 'ENDSEC');

    s += dxfPair(0, 'SECTION') + dxfPair(2, 'TABLES');
    s += dxfPair(0, 'TABLE') + dxfPair(2, 'LAYER') + dxfPair(70, Object.keys(layers).length);
    Object.keys(layers).forEach(function (name) {
      s += dxfPair(0, 'LAYER') + dxfPair(2, name) + dxfPair(70, 0) +
        dxfPair(62, layers[name]) + dxfPair(6, 'CONTINUOUS');
    });
    s += dxfPair(0, 'ENDTAB') + dxfPair(0, 'ENDSEC');

    s += dxfPair(0, 'SECTION') + dxfPair(2, 'ENTITIES') + bodies.join('');
    s += dxfPair(0, 'ENDSEC') + dxfPair(0, 'EOF');
    return s;
  }

  /* =====================================================================
   * 2. 批量打包 ZIP（STORED 无压缩，与 xlsx-export 同思路，零依赖）
   * =================================================================== */
  const CRC_TABLE = (function () {
    const t = new Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8Bytes(str) {
    const s = String(str);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const c2 = s.charCodeAt(i + 1);
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        i++;
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function le16(v) { return [v & 0xff, (v >> 8) & 0xff]; }
  function le32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

  /**
   * 打包成 ZIP（STORED，无压缩）
   * @param {Array<{name:string, content:string}>} files
   * @returns {Uint8Array}
   */
  function zipStore(files) {
    const enc = [];
    const central = [];
    let offset = 0;
    (files || []).forEach(function (f) {
      const nameBytes = utf8Bytes(f.name);
      const data = utf8Bytes(f.content);
      const crc = crc32(data);
      const local = []
        .concat(le32(0x04034b50), le16(20), le16(0x0800), le16(0), le16(0), le16(0))
        .concat(le32(crc), le32(data.length), le32(data.length))
        .concat(le16(nameBytes.length), le16(0))
        .concat(nameBytes)
        .concat(data);
      enc.push(local);
      central.push([]
        .concat(le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(0), le16(0), le16(0))
        .concat(le32(crc), le32(data.length), le32(data.length))
        .concat(le16(nameBytes.length), le16(0), le16(0), le16(0), le16(0), le32(0))
        .concat(le32(offset))
        .concat(nameBytes));
      offset += local.length;
    });
    const cd = central.reduce(function (a, b) { return a.concat(b); }, []);
    const end = []
      .concat(le32(0x06054b50), le16(0), le16(0))
      .concat(le16(files.length), le16(files.length))
      .concat(le32(cd.length), le32(offset), le16(0));
    const all = enc.reduce(function (a, b) { return a.concat(b); }, []).concat(cd, end);
    return typeof Uint8Array !== 'undefined' ? new Uint8Array(all) : all;
  }

  /**
   * 批量导出翼肋：一次生成多个弦长/站位的 DXF 并打包
   * @param {Array<{chordMM:number, contour:object, airfoil:string}>} list
   * @param {object} opt 同 ribDxf 的 opt（chordMM 会被逐项覆盖）
   */
  function ribBatch(list, opt) {
    const o = opt || {};
    const files = [];
    const summary = [];
    (list || []).forEach(function (item, i) {
      const r = ribDxf(item.contour, Object.assign({}, o, {
        chordMM: item.chordMM, airfoil: item.airfoil || o.airfoil
      }));
      if (!r.ok) { summary.push({ index: i + 1, ok: false, error: r.error }); return; }
      files.push({ name: r.filename, content: r.dxf });
      summary.push({
        index: i + 1, ok: true, name: r.filename,
        chordMM: r.chordMM, points: r.pointCount, features: r.features
      });
    });
    // 附带一份说明清单
    const manifest = [
      '翼肋批量导出清单',
      '生成时间：' + new Date().toLocaleString('zh-CN'),
      '单位：毫米（DXF 内 $INSUNITS=4）',
      '图层：RIB_OUTLINE=翼型轮廓，SPAR_HOLE/SPAR_SLOT=主梁孔/槽，JIG_HOLE=定位孔',
      '',
      '序号\t文件名\t弦长(mm)\t轮廓点数\t特征'
    ].concat(summary.filter(function (s) { return s.ok; }).map(function (s) {
      return s.index + '\t' + s.name + '\t' + s.chordMM + '\t' + s.points + '\t' + (s.features || []).join('；');
    })).join('\n');
    files.push({ name: '翼肋导出清单.txt', content: manifest });

    return {
      ok: files.length > 1,
      count: summary.filter(function (s) { return s.ok; }).length,
      files: files,
      summary: summary,
      zip: zipStore(files),
      filename: (o.airfoil || 'airfoil').replace(/\s+/g, '_') + '_ribs_' + summary.filter(function (s) { return s.ok; }).length + '件.zip'
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
    ribBatch: ribBatch, zipStore: zipStore, crc32: crc32,
    fuselageSvg: fuselageSvg, validateSvg: validateSvg, geoFromCore: geoFromCore
  };
});
