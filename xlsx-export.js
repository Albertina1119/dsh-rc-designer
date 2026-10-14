/*!
 * xlsx-export.js —— 纯前端零依赖 .xlsx 导出器（OOXML SpreadsheetML）
 *
 * 自行实现 ZIP（STORED 无压缩）与 OOXML 组装，无任何第三方库，
 * 生成的 .xlsx 与 Excel / WPS / LibreOffice 完全兼容。
 *
 * 用法：
 *   XlsxExport.buildWorkbook(payload)  → Uint8Array（.xlsx 字节）
 *   XlsxExport.download(payload, '文件名.xlsx')   （浏览器环境）
 *
 * payload = {
 *   project: { name, createdAt, version },
 *   snapshot,          // DesignEngine.snapshot() 产出的只读快照
 *   top3,              // DesignEngine.plan() 的 top3 数组
 *   anchors,           // 用户输入锚点
 *   dimensionInfo,     // 维度识别结果
 *   airfoilRecommendations,
 *   naming: { name, candidates, skipped, custom },
 *   versionHistory: [{ version, time, note }]
 * }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.XlsxExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* =======================================================================
   * 1. CRC32 + ZIP（STORED）
   * ===================================================================== */
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  const enc = (s) => new TextEncoder().encode(s);

  /** 生成 ZIP 字节流。entries: [{ name, data: Uint8Array }]，STORED 存储 */
  function zip(entries) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const dosTime = 0x6000, dosDate = 0x5821;

    entries.forEach(function (e) {
      const nameBytes = enc(e.name);
      const data = e.data;
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, dosTime, true);
      dv.setUint16(12, dosDate, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      chunks.push(local, data);

      const cen = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);

      offset += local.length + data.length;
    });

    const centralSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    central.push(end);

    const all = chunks.concat(central);
    const total = all.reduce(function (a, b) { return a + b.length; }, 0);
    const out = new Uint8Array(total);
    let p = 0;
    all.forEach(function (b) { out.set(b, p); p += b.length; });
    return out;
  }

  /* =======================================================================
   * 2. OOXML 组装
   * ===================================================================== */
  const escXml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  const escAttr = escXml;

  function colLetter(n) {
    let s = '';
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  const STYLES = {
    title: 1, subtitle: 2, header: 3, label: 4, value: 5,
    num: 6, note: 7, ok: 8, warn: 9, error: 10, key: 11, section: 12
  };

  /** 样式 id 只保留合法的非负整数，避免把文本误写进 s 属性 */
  function styleId(st) {
    if (st == null) return null;
    const n = Number(typeof st === 'object' ? st.style : st);
    return isFinite(n) && n >= 0 ? n : null;
  }

  function cellXml(ref, cell) {
    if (cell == null) return '';
    const s = styleId(cell.style);
    const hasValue = cell.v !== undefined && cell.v !== null && cell.v !== '';
    if (!hasValue) return s != null ? '<c r="' + ref + '" s="' + s + '"/>' : '';
    const st = s != null ? ' s="' + s + '"' : '';
    if (cell.f) {
      const fnum = Number(cell.v);
      return '<c r="' + ref + '"' + st + (isFinite(fnum) ? ' t="n"' : '') + '>'
        + '<f>' + escXml(cell.f) + '</f>'
        + (isFinite(fnum) ? '<v>' + fnum + '</v>' : '')
        + '</c>';
    }
    if (typeof cell.v === 'number' && isFinite(cell.v)) {
      return '<c r="' + ref + '"' + st + ' t="n"><v>' + cell.v + '</v></c>';
    }
    if (typeof cell.v === 'boolean') {
      return '<c r="' + ref + '"' + st + ' t="b"><v>' + (cell.v ? 1 : 0) + '</v></c>';
    }
    return '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">'
      + escXml(cell.v) + '</t></is></c>';
  }

  function sheetXml(sheet) {
    const cols = (sheet.cols || []).map(function (c, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.w || 18) + '" customWidth="1"/>';
    }).join('');
    const merges = (sheet.merges || []).length
      ? '<mergeCells count="' + sheet.merges.length + '">'
        + sheet.merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('')
        + '</mergeCells>'
      : '';
    const rows = (sheet.rows || []).map(function (row, ri) {
      if (!row) return '';
      const cells = row.map(function (c, ci) {
        return cellXml(colLetter(ci + 1) + (ri + 1), c);
      }).join('');
      return '<row r="' + (ri + 1) + '">' + cells + '</row>';
    }).join('');
    const freeze = sheet.freeze;
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + (freeze ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="' + freeze
        + '" topLeftCell="A' + (freeze + 1) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '')
      + '<sheetFormatPr defaultRowHeight="16"/>'
      + (cols ? '<cols>' + cols + '</cols>' : '')
      + '<sheetData>' + rows + '</sheetData>'
      + merges
      + '</worksheet>';
  }

  const STYLE_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="7">'
    + '<font><sz val="10"/><name val="Microsoft YaHei"/></font>'
    + '<font><b/><sz val="18"/><color rgb="FF1B3A5C"/><name val="Microsoft YaHei"/></font>'
    + '<font><b/><sz val="13"/><color rgb="FF1B3A5C"/><name val="Microsoft YaHei"/></font>'
    + '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font>'
    + '<font><sz val="10"/><color rgb="FF444444"/><name val="Microsoft YaHei"/></font>'
    + '<font><b/><sz val="10"/><color rgb="FF0B7285"/><name val="Microsoft YaHei"/></font>'
    + '<font><sz val="9"/><color rgb="FF777777"/><name val="Microsoft YaHei"/></font>'
    + '</fonts>'
    + '<fills count="9">'
    + '<fill><patternFill patternType="none"/></fill>'
    + '<fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FF1B3A5C"/><bgColor indexed="64"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFEAF3FB"/><bgColor indexed="64"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFE6F7EC"/><bgColor indexed="64"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF6E0"/><bgColor indexed="64"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFFDECEA"/><bgColor indexed="64"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFF3F0FF"/><bgColor indexed="64"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFDCE9F5"/><bgColor indexed="64"/></patternFill></fill>'
    + '</fills>'
    + '<borders count="2">'
    + '<border><left/><right/><top/><bottom/><diagonal/></border>'
    + '<border><left style="thin"><color rgb="FFBBD0E4"/></left><right style="thin"><color rgb="FFBBD0E4"/></right>'
    + '<top style="thin"><color rgb="FFBBD0E4"/></top><bottom style="thin"><color rgb="FFBBD0E4"/></bottom><diagonal/></border>'
    + '</borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="13">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="7" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>'
    + '<xf numFmtId="0" fontId="2" fillId="7" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>'
    + '<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>'
    + '<xf numFmtId="0" fontId="6" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>'
    + '<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="5" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="2" fillId="8" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>'
    + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';

  function buildWorkbook(payload) {
    const sheets = buildSheets(payload);
    const entries = [];

    entries.push({
      name: '[Content_Types].xml',
      data: enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + sheets.map(function (s) {
          return '<Override PartName="/xl/worksheets/sheet' + s.idx + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
        }).join('')
        + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        + '</Types>')
    });
    entries.push({
      name: '_rels/.rels',
      data: enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
        + '</Relationships>')
    });
    entries.push({
      name: 'xl/workbook.xml',
      data: enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<workbookPr/><bookViews><workbookView activeTab="0"/></bookViews>'
        + '<sheets>' + sheets.map(function (s) {
          return '<sheet name="' + escAttr(s.name) + '" sheetId="' + s.idx + '" r:id="rId' + s.idx + '"/>';
        }).join('') + '</sheets>'
        + '<calcPr calcId="171027" fullCalcOnLoad="1"/>'
        + '</workbook>')
    });
    entries.push({
      name: 'xl/_rels/workbook.xml.rels',
      data: enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + sheets.map(function (s) {
          return '<Relationship Id="rId' + s.idx + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + s.idx + '.xml"/>';
        }).join('')
        + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        + '</Relationships>')
    });
    entries.push({ name: 'xl/styles.xml', data: enc(STYLE_XML) });
    sheets.forEach(function (s) {
      entries.push({ name: 'xl/worksheets/sheet' + s.idx + '.xml', data: enc(sheetXml(s.def)) });
    });

    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const title = (payload && payload.project && payload.project.name) || 'RC 飞行器总体设计方案';
    entries.push({
      name: 'docProps/core.xml',
      data: enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        + 'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        + '<dc:title>' + escXml(title) + '</dc:title>'
        + '<dc:creator>DSH 飞行器总体设计引擎</dc:creator>'
        + '<cp:lastModifiedBy>DSH 飞行器总体设计引擎</cp:lastModifiedBy>'
        + '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>'
        + '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>'
        + '</cp:coreProperties>')
    });
    entries.push({
      name: 'docProps/app.xml',
      data: enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        + 'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        + '<Application>DSH 飞行器总体设计引擎</Application><Company>DSH</Company></Properties>')
    });

    return zip(entries);
  }

  /* =======================================================================
   * 3. 各工作表内容
   * ===================================================================== */
  const R = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 1000) / 1000 : v);
  const num = (v) => (typeof v === 'number' && isFinite(v) ? R(v) : '—');
  const S = STYLES;
  const NA = '不适用（旋翼机型）';

  function kv(label, value, note, style) {
    return [{ v: label, style: S.label }, { v: value, style: style || S.value }, { v: note || '', style: S.note }];
  }
  function section(title, span) {
    const row = [{ v: title, style: S.section }];
    for (let i = 1; i < (span || 6); i++) row.push({ style: S.section });
    return row;
  }
  function header(cols) {
    return cols.map(function (c) { return { v: c, style: S.header }; });
  }
  function pad(row, n) {
    const out = row.slice();
    while (out.length < n) out.push(null);
    return out;
  }

  function buildSheets(p) {
    const snap = p.snapshot || {};
    const top3 = p.top3 || [];
    const best = (top3[0] && top3[0].plan) ? top3[0].plan : (p.plan || {});
    const c = best.core || snap.core || {};
    const pw = c.power || null;
    const rw = c.rotary || null;
    const af = c.airfoil || {};
    const isRotary = !!rw;
    const project = p.project || {};
    const naming = p.naming || {};
    const anchors = p.anchors || {};
    const dims = p.dimensionInfo || [];
    const rec = p.airfoilRecommendations || [];
    const defs = [];

    /* ---------- 全锚点取值：用户给定 vs 引擎推荐（封面与「输入锚点」表共用） ---------- */
    let av = p.anchorValues;
    if (!av && typeof DesignEngine !== 'undefined' && DesignEngine.anchorValues && best.core) {
      av = DesignEngine.anchorValues(best);
    }
    av = av || [];
    const srcLabel = { user: '用户锚点（已采用）', engine: '引擎推荐', baseline: '模板默认' };
    const srcStyle = function (r) { return r.source === 'user' ? S.value : (r.source === 'engine' ? S.key : S.note); };
    const enumText = function (r) {
      return r.kind === 'enum' && r.options
        ? (((r.options.filter(function (o) { return o.v === r.value; })[0] || {}).t) || r.value)
        : null;
    };
    const avRec = function (r) { const t = enumText(r); return t !== null ? t : num(r.value); };
    // 封面：6 列（省略「说明」，保持封面简洁）
    const avRow6 = function (r) {
      return pad([
        { v: r.label, style: S.label },
        { v: r.userAnchor ? avRec(r) : '—', style: r.userAnchor ? S.num : S.note },
        { v: avRec(r), style: S.key },
        { v: r.unit || '', style: S.note },
        { v: srcLabel[r.source] || r.source, style: srcStyle(r) },
        { v: r.dimName || '', style: S.note }
      ], 6);
    };
    // 「输入锚点」表：7 列（含说明）
    const avRow7 = function (r) {
      return pad([
        { v: r.label, style: S.label },
        { v: r.userAnchor ? avRec(r) : '—', style: r.userAnchor ? S.num : S.note },
        { v: avRec(r), style: S.key },
        { v: r.unit || '', style: S.note },
        { v: srcLabel[r.source] || r.source, style: srcStyle(r) },
        { v: r.dimName || '', style: S.note },
        { v: (r.note || '') + (r.userAnchor ? '　（已按你的输入采用）' : ''), style: S.note }
      ], 7);
    };
    const nUser = av.filter(function (r) { return r.source === 'user'; }).length;
    const nEng = av.filter(function (r) { return r.source === 'engine'; }).length;
    const nDft = av.filter(function (r) { return r.source === 'baseline'; }).length;

    /* ---------- 1 封面 ---------- */
    defs.push({
      name: '封面', freeze: 0,
      cols: [{ w: 22 }, { w: 30 }, { w: 22 }, { w: 30 }, { w: 16 }, { w: 24 }],
      rows: [
        pad([{ v: 'RC 飞行器总体设计方案', style: S.title }], 6),
        [],
        pad(kv('方案名称', naming.name || project.name || '（未命名）', naming.skipped ? '用户选择跳过命名' : ''), 6),
        pad(kv('机型', snap.typeName || best.typeName || '—', '由锚点识别或用户指定'), 6),
        pad(kv('方案校验码', snap.checksum || '—', '基于核心计算结果的哈希，用于确认快照未被改动'), 6),
        pad(kv('生成时间', project.createdAt || new Date().toLocaleString('zh-CN'), ''), 6),
        pad(kv('引擎版本', project.version || '—', 'airfoil-lib + design-engine + xlsx-export'), 6),
        pad(kv('可行性', best.feasible === false ? '存在硬约束冲突' : '通过全部硬约束', '',
          best.feasible === false ? S.error : S.ok), 6),
        pad(kv('综合得分', best.score ? best.score.total : '—', '六维度加权：稳定 / 续航 / 速度 / 成本 / 易飞 / 易做'), 6),
        pad(kv('置信度', best.confidence != null ? best.confidence + '%' : '—', '受锚点数量与机型匹配度影响'), 6),
        [],
        section('关键结论', 6),
        header(['总体', '推荐数值', '单位', '总体', '推荐数值', '单位']),
        pad([{ v: '起飞重量', style: S.label }, { v: num(c.mass), style: S.num }, { v: 'kg', style: S.note },
          { v: '翼载', style: S.label }, { v: num(c.wlGdm2), style: S.num }, { v: 'g/dm²', style: S.note }], 6),
        pad([{ v: '翼面积', style: S.label }, { v: num(c.area), style: S.num }, { v: 'm²', style: S.note },
          { v: '失速速度', style: S.label }, { v: num(c.vStall), style: S.num }, { v: 'm/s', style: S.note }], 6),
        pad([{ v: '翼展', style: S.label }, { v: num(c.span), style: S.num }, { v: 'm', style: S.note },
          { v: '最大速度', style: S.label }, { v: num(c.perf && c.perf.vMaxCalc), style: S.num }, { v: 'm/s', style: S.note }], 6),
        pad([{ v: '展弦比', style: S.label }, { v: num(c.ar), style: S.num }, { v: '', style: S.note },
          { v: '最大升阻比', style: S.label }, { v: num(c.ldMax), style: S.num }, { v: '', style: S.note }], 6),
        pad([{ v: '翼型', style: S.label }, { v: af.designation || '—', style: S.value }, { v: '', style: S.note },
          { v: '推重比', style: S.label }, { v: num(c.perf && c.perf.thrustToWeight), style: S.num }, { v: '', style: S.note }], 6),
        pad([{ v: '旋翼', style: S.label },
          { v: isRotary ? (rw.nrotor + ' × φ' + num(rw.rotorDia * 1000) + ' mm') : '—', style: S.value }, { v: '', style: S.note },
          { v: '桨盘载荷', style: S.label }, { v: isRotary ? num(rw.diskLoading) : '—', style: S.num }, { v: 'N/m²', style: S.note }], 6),
        [],
        section('输入锚点：你给定的值  vs  引擎推荐的值', 6),
        pad(kv('你给定', nUser, '项', '勾选并输入，引擎已按此采用', S.key), 4),
        pad(kv('引擎推荐', nEng, '项', '引擎算出或择优得到的推荐值，可直接采用', S.ok), 4),
        pad(kv('模板默认', nDft, '项', '沿用机型模板基线，未参与计算', S.note), 4),
        header(['锚点', '用户给定', '推荐数值', '单位', '来源', '维度'])
      ].concat(av.map(avRow6)).concat([
        [],
        pad([{ v: '说明：某一项「用户给定」为空（—）时，右侧「推荐数值」就是引擎给出的推荐值；' +
          '两者都有值时说明引擎已按你的输入采用。完整说明见「输入锚点」工作表。', style: S.note }], 6)
      ])
    });

    /* ---------- 2 输入锚点 ---------- */
    const anchorRows = [];
    Object.keys(anchors).forEach(function (k) {
      const v = anchors[k];
      if (v === '' || v === null || v === undefined) return;
      const meta = (typeof DesignEngine !== 'undefined' && DesignEngine.ANCHOR_BY_ID) ? DesignEngine.ANCHOR_BY_ID[k] : null;
      const dim = meta && typeof DesignEngine !== 'undefined' && DesignEngine.DIMENSIONS && DesignEngine.DIMENSIONS[meta.dim]
        ? DesignEngine.DIMENSIONS[meta.dim].name : (meta ? meta.dim : '—');
      anchorRows.push(pad([{ v: meta ? meta.label : k, style: S.label }, { v: v, style: S.num },
        { v: meta ? meta.unit : '', style: S.note }, { v: dim, style: S.value },
        { v: '用户锚点', style: S.value }, { v: meta && meta.kind === 'enum' ? '风格/枚举锚点' : '数值锚点', style: S.note }], 6));
    });
    const srcMap = { anchor: '用户锚点', baseline: '机型模板基线', derived: '规则库推导' };
    const srcRows = Object.keys(best.source || {}).map(function (k) {
      return pad([{ v: k, style: S.label }, { v: num((best.values || {})[k]), style: S.num }, { v: '', style: S.note },
        { v: srcMap[best.source[k]] || best.source[k], style: S.value }], 6);
    });
    // 全锚点一览：用户给定值 与 引擎推荐值 分列并列（复用封面已算好的 av）
    const avRows = av.map(avRow7);
    defs.push({
      name: '输入锚点', freeze: 1,
      cols: [{ w: 20 }, { w: 18 }, { w: 20 }, { w: 10 }, { w: 18 }, { w: 10 }, { w: 44 }],
      rows: [
        pad([{ v: '一、输入锚点与引擎推荐', style: S.title }], 7),
        [],
        pad(kv('用户锚点', nUser, '项', '你勾选并输入的值，引擎已按此采用（见「用户给定」列）', S.key), 4),
        pad(kv('引擎推荐', nEng, '项', '引擎算出或择优得到的推荐值，如桨径、电机 KV、续航 —— 可直接采用', S.ok), 4),
        pad(kv('模板默认', nDft, '项', '沿用该机型模板基线，未参与计算', S.note), 4),
        [],
        section('全部锚点一览：用户给定值 与 引擎推荐值 并列对照', 7),
        header(['锚点', '用户给定', '推荐数值', '单位', '来源', '维度', '说明'])
      ].concat(avRows.length ? avRows : [pad([{ v: '（无锚点数据）', style: S.note }], 7)]).concat([
        [],
        section('识别到的维度', 7),
        header(['维度', '说明', '', '', '', '', ''])
      ]).concat(dims.length
        ? dims.map(function (d) { return pad([{ v: d.name, style: S.value }, { v: '用户锚点覆盖该维度', style: S.note }], 7); })
        : [pad([{ v: '（无）', style: S.note }], 7)]).concat([
        [],
        section('内部参数补全来源（模板基线 + 规则库）', 7),
        header(['内部参数', '最终取值', '单位', '来源', '', '', ''])
      ]).concat(srcRows.map(function (r) { return r.concat([null, null, null]).slice(0, 7); }))
    });

    /* ---------- 3 推荐方案 ---------- */
    const cmpRows = [pad(header(['目标', '定位', '翼面积 m²', '翼展 m', '展弦比', '翼载 g/dm²',
      '失速 m/s', '翼型 / 旋翼', '综合分']), 9)];
    top3.forEach(function (t) {
      const x = t.plan.core;
      cmpRows.push(pad([
        { v: t.label, style: S.value }, { v: t.tag, style: S.note },
        { v: num(x.area), style: S.num }, { v: num(x.span), style: S.num }, { v: num(x.ar), style: S.num },
        { v: num(x.wlGdm2), style: S.num }, { v: num(x.vStall), style: S.num },
        { v: x.airfoil ? x.airfoil.designation : (x.rotary ? x.rotary.nrotor + ' 旋翼' : '—'), style: S.value },
        { v: t.plan.score.total, style: S.num }], 9));
    });
    const detail = [];
    top3.forEach(function (t) {
      const x = t.plan.core;
      const px = x.power, rx = x.rotary;
      detail.push([]);
      detail.push(pad([{ v: '◆ ' + t.label + '（' + t.tag + '）', style: S.subtitle }], 6));
      detail.push(pad(kv('选择依据', t.objectiveReason, ''), 6));
      detail.push(pad(kv('总体参数', '起飞 ' + num(x.mass) + ' kg｜翼面积 ' + num(x.area) + ' m²｜翼展 ' + num(x.span)
        + ' m｜机身长 ' + num(x.fuselageLength * 1000) + ' mm｜平均弦长 ' + num(x.meanChord * 1000)
        + ' mm｜展弦比 ' + num(x.ar) + '｜梢根比 ' + num(x.taper)), 6));
      detail.push(pad(kv('气动性能', x.airfoil
        ? ('失速 ' + num(x.vStall) + ' m/s｜最大速度 ' + num(x.perf.vMaxCalc) + ' m/s｜L/D ' + num(x.ldMax)
          + '｜CLmax(3D) ' + num(x.clMax3d) + '｜翼型 ' + x.airfoil.designation)
        : ('旋翼机型：最大速度估计 ' + num(x.perf.vMaxCalc) + ' m/s｜推重比 ' + num(x.perf.thrustToWeight)), ''), 6));
      detail.push(pad(kv('重心稳定', x.cg.staticMargin == null ? NA
        : ('MAC ' + num(x.cg.mac * 1000) + ' mm｜重心 ' + num(x.cg.cgPct * 100) + '% MAC｜静稳定裕度 '
          + num(x.cg.staticMargin) + '%'), ''), 6));
      detail.push(pad(kv('尾翼', (x.tail.vh === 0 && rx) ? NA
        : ('平尾 ' + num(x.tail.Sh * 1e4) + ' cm²（Vh ' + num(x.tail.vh) + '）｜垂尾 ' + num(x.tail.Sv * 1e4)
          + ' cm²（Vv ' + num(x.tail.vv) + '）｜尾臂 ' + num(x.tail.lh * 1000) + ' mm'), ''), 6));
      detail.push(pad(kv('动力', px
        ? (px.cells + 'S｜' + (px.motor || '—') + '/' + px.kv + ' KV｜桨 ' + px.propIn + '×' + px.propPitch
          + ' in｜静推力 ' + num(px.staticThrust) + ' N｜静态电流 ' + num(px.currentStatic) + ' A｜电调 ' + px.escA
          + ' A｜续航约 ' + num(px.enduranceMin) + ' min')
        : (rx ? (rx.nrotor + ' 旋翼｜单桨 φ' + num(rx.rotorDia * 1000) + ' mm｜桨盘载荷 ' + num(rx.diskLoading)
          + ' N/m²｜悬停功率 ' + num(rx.powerHover) + ' W｜续航约 ' + num(rx.enduranceMin) + ' min') : '—'), ''), 6));      detail.push(pad(kv('结构', x.structure.materials + '｜碳管 φ' + num(x.structure.sparDiaMM) + ' mm｜翼肋间距 '
        + num(x.structure.ribSpacing * 1000) + ' mm｜副翼舵机 ' + num(x.structure.servoAileron) + ' kg·cm', ''), 6));
      detail.push(pad(kv('评分', t.plan.score.dimensions.map(function (d) { return d.name + ' ' + d.score; }).join('｜')
        + '｜总计 ' + t.plan.score.total, ''), 6));
      detail.push(pad(kv('警告', t.warnings.length ? t.warnings.join('；') : '无', '',
        t.warnings.length ? S.warn : S.ok), 6));
    });
    defs.push({
      name: '推荐方案', freeze: 0,
      cols: [{ w: 20 }, { w: 30 }, { w: 22 }, { w: 22 }, { w: 22 }, { w: 30 }],
      rows: [
        pad([{ v: '二、Top3 推荐方案', style: S.title }], 6),
        [],
        section('多方案择优对比', 9)
      ].concat(cmpRows).concat(detail)
    });

    /* ---------- 4 总体参数 ---------- */
    defs.push({
      name: '总体参数', freeze: 0,
      cols: [{ w: 24 }, { w: 18 }, { w: 12 }, { w: 52 }, { w: 16 }, { w: 16 }],
      rows: [
        pad([{ v: '三、总体参数', style: S.title }], 6),
        [],
        header(['参数', '推荐值', '单位', '说明 / 公式', '', '']),
        pad(kv('起飞重量', num(c.mass), 'kg', '用户锚点或由翼载反推'), 4),
        pad(kv('翼面积 S', num(c.area), 'm²', 'S = m·10 / wl[g/dm²]'), 4),
        pad(kv('翼展 b', num(c.span), 'm', 'b = √(AR·S)'), 4),
        pad(kv('机身长度', num(c.fuselageLength * 1000), 'mm',
          'L = 0.35·cr + h_cg·cr + lh + c_t（机头 + 机翼段 + 尾臂 + 平尾弦长）'), 4),
        pad(kv('机身长度 / 翼展', num(c.fuselageRatio), '', '常规经验区间 0.55 ~ 0.85'), 4),
        pad(kv('机翼平均弦长', num(c.meanChord * 1000), 'mm', 'c̄ = S / b'), 4),
        pad(kv('展弦比 AR', num(c.ar), '', 'AR = b² / S'), 4),
        pad(kv('梢根比 λ', num(c.taper), '', '尖弦 / 根弦'), 4),
        pad(kv('根弦 cr', num(c.planform && c.planform.root * 1000), 'mm', 'cr = 2S / (b(1+λ))'), 4),
        pad(kv('尖弦 ct', num(c.planform && c.planform.tip * 1000), 'mm', 'ct = λ·cr'), 4),
        pad(kv('平均气动弦 MAC', num(c.cg && c.cg.mac * 1000), 'mm', 'MAC = (2/3)·cr·(1+λ+λ²)/(1+λ)'), 4),
        pad(kv('翼载', num(c.wlGdm2), 'g/dm²', 'wl = m[g] / S[dm²]'), 4),
        pad(kv('翼载（力）', num(c.wingLoading), 'N/m²', 'W / S'), 4),
        pad(kv('失速速度 Vs', num(c.vStall), 'm/s', 'Vs = √(2W / (ρ·S·CLmax))'), 4),
        pad(kv('三维 CLmax', num(c.clMax3d), '', 'CLmax,2D × 有限展弦比折减'), 4),
        pad(kv('最大速度', num(c.perf && c.perf.vMaxCalc), 'm/s', '可用推力曲线与阻力曲线交点'), 4),
        pad(kv('最大升阻比 L/D', num(c.ldMax), '', 'L/D = 1 / (2√(CD0·k))'), 4),
        pad(kv('零升阻力 CD0', num(c.cd0), '', '翼型型阻 + 部件干扰阻力'), 4),
        pad(kv('诱导阻力因子 k', num(c.kInduced), '', 'k = 1 / (π·AR·e)'), 4),
        pad(kv('奥斯瓦尔德效率 e', num(c.oswald), '', '经验式，随展弦比变化'), 4),
        pad(kv('巡航雷诺数', num(c.reCruise), '', 'Re = V·MAC / ν'), 4),
        pad(kv('推重比 T/W', num(c.perf && c.perf.thrustToWeight), '', '静推力 / 起飞重量'), 4),
        pad(kv('爬升率', num(c.perf && c.perf.roc), 'm/s', 'ROC = (Pavail − Plevel) / W'), 4),
        pad(kv('盘旋半径', num(c.perf && c.perf.turnRadius), 'm', 'R = V² / (g√(n²−1))'), 4),
        pad(kv('整机单位功率', num(rw ? rw.powerHover / c.mass : (pw ? pw.powerStatic / c.mass : NaN)), 'W/kg',
          '功率 / 起飞重量'), 4)
      ]
    });

    /* ---------- 5 翼型参数 ---------- */
    defs.push({
      name: '翼型参数', freeze: 0,
      cols: [{ w: 24 }, { w: 16 }, { w: 12 }, { w: 50 }, { w: 16 }, { w: 16 }],
      rows: [
        pad([{ v: '四、NACA 翼型', style: S.title }], 6),
        [],
        section('选定翼型', 6),
        header(['参数', '推荐值', '单位', '说明', '', '']),
        pad(kv('编号', af.designation || (isRotary ? NA : '—'), '', af.series || ''), 4),
        pad(kv('最大厚度', af.tc ? num(af.tc * 100) : '—', '% 弦长', 't/c'), 4),
        pad(kv('最大弯度', af.camber != null ? num(af.camber * 100) : '—', '% 弦长', 'm/c'), 4),
        pad(kv('最大弯度位置', af.pos != null ? num(af.pos * 100) : '—', '% 弦长', 'p/c'), 4),
        pad(kv('设计升力系数', num(af.dc), '', '五位 / 六位翼型的设计 CL'), 4),
        pad(kv('二维 CLmax', num(af.clmax), '', '模型尺度经验值（Re ≈ 1e5~3e5）'), 4),
        pad(kv('二维型阻 CD0', num(af.cd0), '', '设计升力附近的二维型阻'), 4),
        pad(kv('失速迎角', num(af.aStall), '°', '二维经验值'), 4),
        pad(kv('零升力矩系数 Cm0', num(af.cm0), '', '负值表示低头力矩'), 4),
        pad(kv('二维升力线斜率 a0', num(af.a0), '1/deg', '资料值约 0.10~0.11'), 4),
        pad(kv('数据来源', af.tabulated ? '内置翼型库' : (af.valid ? '厚度/弯度经验模型估算' : '—'), '', af.notes || ''), 4),
        [],
        section('推荐 Top3 翼型', 9),
        header(['排名', '编号', '厚度 %', '弯度 %', 'CLmax', 'CD0 (counts)', '失速迎角 °', '匹配分', '推荐理由'])
      ].concat(rec.length ? rec.map(function (a, i) {
        return pad([
          { v: i + 1, style: S.num }, { v: a.designation, style: S.value },
          { v: num(a.tc * 100), style: S.num }, { v: num(a.camber * 100), style: S.num },
          { v: num(a.clmax), style: S.num }, { v: num(a.cd0 * 1e4), style: S.num },
          { v: num(a.aStall), style: S.num }, { v: a.score, style: S.num },
          { v: (a.why || []).join('；'), style: S.note }], 9);
      }) : [pad([{ v: '（旋翼机型不使用固定翼型库）', style: S.note }], 9)])
    });

    /* ---------- 6 机翼参数 ---------- */
    defs.push({
      name: '机翼参数', freeze: 0,
      cols: [{ w: 24 }, { w: 18 }, { w: 14 }, { w: 48 }, { w: 16 }, { w: 16 }],
      rows: [
        pad([{ v: '五、机翼参数', style: S.title }], 6),
        [],
        header(['参数', '推荐值', '单位', '说明', '', '']),
        pad(kv('翼型', af.designation || '—', '', ''), 4),
        pad(kv('机身长度', num(c.fuselageLength * 1000), 'mm', '用于绘制侧视图与布置设备'), 4),
        pad(kv('机身长度 / 翼展', num(c.fuselageRatio), '', '常规 0.55 ~ 0.85'), 4),
        pad(kv('翼展', num(c.span * 1000), 'mm', ''), 4),
        pad(kv('翼面积', num(c.area * 1e4), 'cm²', ''), 4),
        pad(kv('展弦比', num(c.ar), '', ''), 4),
        pad(kv('梢根比', num(c.taper), '', ''), 4),
        pad(kv('平均弦长 c̄', num(c.meanChord * 1000), 'mm', 'c̄ = S / b'), 4),
        pad(kv('根弦', num(c.planform && c.planform.root * 1000), 'mm', 'cr = 2S/(b(1+λ))'), 4),
        pad(kv('尖弦', num(c.planform && c.planform.tip * 1000), 'mm', 'ct = λ·cr'), 4),
        pad(kv('平均气动弦 MAC', num(c.cg && c.cg.mac * 1000), 'mm', ''), 4),
        pad(kv('MAC 展向位置', num(c.planform && c.planform.yMac * 1000), 'mm', '距对称面'), 4),
        pad(kv('后掠角', num(c.sweep), '°', '1/4 弦线处'), 4),
        pad(kv('上反角', num(c.dihedral), '°', ''), 4),
        pad(kv('扭转角', num(c.twist), '°', '正值为翼根相对翼尖抬头'), 4),
        pad(kv('副翼弦长比', num(c.tail && c.tail.aileronRatio * 100), '% 局部弦长', ''), 4),
        pad(kv('副翼展长比', '60 ~ 70', '% 半翼展', '常规布局经验值'), 4),
        pad(kv('三维升力线斜率', num(c.a3dPerDeg), '1/rad', '含低展弦比修正与后掠修正'), 4),
        pad(kv('雷诺数（巡航）', num(c.reCruise), '', 'Re = V·MAC / ν'), 4),
        pad(kv('雷诺数（失速）', num(c.reStall), '', ''), 4),
        pad(kv('浸润面积', num(c.swet), 'm²', 'Swet ≈ 2.02·S·(1 + 0.6·t/c)'), 4)
      ]
    });

    /* ---------- 7 尾翼参数 ---------- */
    const tailSh = c.tail ? c.tail.Sh : NaN;
    const tailSv = c.tail ? c.tail.Sv : NaN;
    defs.push({
      name: '尾翼参数', freeze: 0,
      cols: [{ w: 26 }, { w: 18 }, { w: 14 }, { w: 52 }, { w: 16 }, { w: 16 }],
      rows: [
        pad([{ v: '六、尾翼参数', style: S.title }], 6),
        [],
        header(['参数', '推荐值', '单位', '说明 / 公式', '', '']),
        pad(kv('平尾面积 Sh', num(tailSh * 1e4), 'cm²', 'Vh = Sh·lh / (S·MAC)'), 4),
        pad(kv('平尾展长', num(Math.sqrt(Math.max(0, tailSh) * (c.ar * 0.55)) * 1000), 'mm',
          '按平尾展弦比约 ' + num(c.ar * 0.55) + ' 估算'), 4),
        pad(kv('平尾平均弦长', num((tailSh / Math.max(0.01, Math.sqrt(Math.max(0, tailSh) * c.ar * 0.55))) * 1000), 'mm',
          'Sh / 平尾展长'), 4),
        pad(kv('平尾容量 Vh', num(c.tail && c.tail.vh), '', '常规经验区间 0.35 ~ 0.72'), 4),
        pad(kv('升降舵弦长比', num(c.tail && c.tail.elevRatio * 100), '% 局部弦长', '常规 35 ~ 45%'), 4),
        pad(kv('垂尾面积 Sv', num(tailSv * 1e4), 'cm²', 'Vv = Sv·lv / (S·b)'), 4),
        pad(kv('垂尾高度', num(Math.sqrt(Math.max(0, tailSv) * 1.6) * 1000), 'mm', '按垂尾展弦比约 1.6 估算'), 4),
        pad(kv('垂尾容量 Vv', num(c.tail && c.tail.vv), '', '常规经验区间 0.022 ~ 0.070'), 4),
        pad(kv('方向舵弦长比', num(c.tail && c.tail.rudderRatio * 100), '% 局部弦长', '常规 35 ~ 45%'), 4),
        pad(kv('尾臂 lh（重心→平尾焦点）', num(c.tail && c.tail.lh * 1000), 'mm', '影响俯仰力矩与配平'), 4),
        pad(kv('尾臂 lv（重心→垂尾焦点）', num(c.tail && c.tail.lv * 1000), 'mm', ''), 4),
        pad(kv('尾翼翼型建议', isRotary ? NA : '对称翼型 NACA 0009 ~ 0012', '', '对称翼型正反舵效一致'), 4)
      ]
    });

    /* ---------- 8 重心与稳定 ---------- */
    const cgOk = c.cg && c.cg.staticMargin != null;
    defs.push({
      name: '重心与稳定', freeze: 0,
      cols: [{ w: 26 }, { w: 18 }, { w: 14 }, { w: 52 }, { w: 16 }, { w: 16 }],
      rows: [
        pad([{ v: '七、重心与稳定性', style: S.title }], 6),
        [],
        header(['参数', '推荐值', '单位', '说明', '', '']),
        pad(kv('平均气动弦 MAC', num(c.cg && c.cg.mac * 1000), 'mm', ''), 4),
        pad(kv('机翼焦点位置', cgOk ? num(c.cg.acPct * 100) : NA, cgOk ? '% MAC' : '',
          '机翼 + 平尾组合焦点（中性点）'), 4),
        pad(kv('重心位置', cgOk ? num(c.cg.cgPct * 100) : NA, cgOk ? '% MAC' : '', '设计目标重心'), 4),
        pad(kv('重心距前缘', cgOk ? num(c.cg.cgMM * 1000) : NA, cgOk ? 'mm' : '', '沿 MAC 测量'), 4),
        pad(kv('静稳定裕度', cgOk ? num(c.cg.staticMargin) : NA, cgOk ? '% MAC' : '',
          '（焦点 − 重心）/ MAC，正值表示纵向稳定'), 4),
        pad(kv('重心允许范围', cgOk
          ? (num((c.cg.cgPct - 0.05) * 100) + ' ~ ' + num((c.cg.cgPct + 0.04) * 100)) : NA,
          cgOk ? '% MAC' : '', '建议调试范围'), 4),
        pad(kv('推力线', cgOk ? (c.cg.thrustLine || '-2°') : NA, '', '相对翼弦，向下为负'), 4),
        pad(kv('电池安装位置', isRotary ? '机腹配重仓中心' : '重心前后 ±30 mm 范围内可调', '', '通过移动电池微调重心'), 4),
        pad(kv('首飞建议', isRotary ? '先做悬停配平与陀螺校准' : '重心取建议范围前 1/3 处', '', '略头重更安全，试飞后再逐步后移'), 4)
      ]
    });

    /* ---------- 9 动力系统 ---------- */
    const powerRows = [header(['参数', '推荐值', '单位', '说明', '', ''])];
    if (pw) {
      powerRows.push(pad(kv('动力形式', '电动 + 定距螺旋桨', '', '直驱'), 4));
      powerRows.push(pad(kv('电机规格', (pw.motor || '—') + ' / ' + pw.kv + ' KV', '',
        '按目标推力自动择优' + (pw.autoSelected ? '（引擎自动选择）' : '（用户锁定）')), 4));
      powerRows.push(pad(kv('电机重量', num(pw.motorMass), 'g', ''), 4));
      powerRows.push(pad(kv('螺旋桨', pw.propIn + ' × ' + pw.propPitch, 'inch', '桨距比约 ' + num(pw.pitchRatio)), 4));
      powerRows.push(pad(kv('螺旋桨直径', num(pw.propIn * 25.4), 'mm', ''), 4));
      powerRows.push(pad(kv('电池', pw.cells + 'S / ' + pw.capacity + ' mAh', '', '标称电压 ' + num(pw.voltage) + ' V'), 4));
      powerRows.push(pad(kv('可用静推力', num(pw.staticThrust), 'N', 'T = CT·ρ·n²·D⁴'), 4));
      powerRows.push(pad(kv('推重比（实际）', num(c.perf.thrustToWeight), '', '静推力 / 起飞重量'), 4));
      powerRows.push(pad(kv('推重比（目标）', num(pw.twrTarget), '', '用户锚点或机型模板'), 4));
      powerRows.push(pad(kv('静态电流', num(pw.currentStatic), 'A', '峰值工况，用于选电调与电机'), 4));
      powerRows.push(pad(kv('静态输入功率', num(pw.powerStatic), 'W', 'V × I'), 4));
      powerRows.push(pad(kv('电调建议规格', pw.escA + ' A', '', '静态电流 × 1.25 余量'), 4));
      powerRows.push(pad(kv('静态转速', num(pw.rpmStatic), 'rpm', '由电机扭矩与桨扭矩平衡求解'), 4));
      powerRows.push(pad(kv('桨距速度', num(pw.pitchSpeed), 'm/s', 'n × 螺距，高速段推力衰减界限'), 4));
      powerRows.push(pad(kv('巡航速度', num(pw.vCruise), 'm/s', '按目标速度的 0.78 取值'), 4));
      powerRows.push(pad(kv('巡航电流', num(pw.currentCruise), 'A', ''), 4));
      powerRows.push(pad(kv('电池能量', num(pw.energyWh), 'Wh', '容量 × 标称电压'), 4));
      powerRows.push(pad(kv('预计续航', num(pw.enduranceMin), 'min', '按可用电量 80% 估算'), 4));
      powerRows.push(pad(kv('能量转换效率', num(pw.efficiency * 100), '%', '轴功率 / 电功率'), 4));
      if (pw.warnings && pw.warnings.length) {
        pw.warnings.forEach(function (w, i) {
          powerRows.push(pad([{ v: i === 0 ? '动力警告' : '', style: S.label }, { v: w, style: S.warn }], 6));
        });
      }
    } else if (rw) {
      powerRows.push(pad(kv('动力形式', rw.kind === 'helicopter' ? '电动直升机' : '电动多旋翼', '', ''), 4));
      powerRows.push(pad(kv('旋翼数量', rw.nrotor, '个', ''), 4));
      powerRows.push(pad(kv('单个旋翼直径', num(rw.rotorDia * 1000), 'mm', 'D = 2√(A/π)'), 4));
      powerRows.push(pad(kv('桨盘载荷', num(rw.diskLoading), 'N/m²', 'DL = W / 总桨盘面积'), 4));
      powerRows.push(pad(kv('总桨盘面积', num(rw.diskArea), 'm²', ''), 4));
      powerRows.push(pad(kv('推重比（目标）', num(rw.twrTarget), '', '用户锚点或机型模板'), 4));
      powerRows.push(pad(kv('悬停轴功率', num(rw.powerHover), 'W', 'P = T^1.5 / (FM·√(2ρA))'), 4));
      powerRows.push(pad(kv('悬停电功率', num(rw.powerHoverElec), 'W', '含电调与电机损失'), 4));
      powerRows.push(pad(kv('悬停电流', num(rw.currentHover), 'A', ''), 4));
      powerRows.push(pad(kv('电池', rw.cells + 'S / ' + rw.capacity + ' mAh', '', '标称 ' + num(rw.batteryVoltage) + ' V'), 4));
      powerRows.push(pad(kv('电调建议规格', rw.escA + ' A', '', ''), 4));
      powerRows.push(pad(kv('预计悬停续航', num(rw.enduranceMin), 'min', '按可用电量 80% 估算'), 4));
      powerRows.push(pad(kv('桨叶弦长建议', num(rw.bladeChord * 1000), 'mm', ''), 4));
      powerRows.push(pad(kv('最大速度估计', num(rw.vMaxEstimate), 'm/s', ''), 4));
    }
    defs.push({
      name: '动力系统', freeze: 0,
      cols: [{ w: 26 }, { w: 22 }, { w: 14 }, { w: 50 }, { w: 16 }, { w: 16 }],
      rows: [pad([{ v: '八、动力系统', style: S.title }], 6), []].concat(powerRows)
    });

    /* ---------- 10 结构材料 ---------- */
    const stc = c.structure || {};
    defs.push({
      name: '结构材料', freeze: 0,
      cols: [{ w: 24 }, { w: 28 }, { w: 12 }, { w: 50 }, { w: 16 }, { w: 16 }],
      rows: [
        pad([{ v: '九、结构与材料', style: S.title }], 6),
        [],
        header(['项目', '推荐值 / 建议', '单位', '说明', '', '']),
        pad(kv('主体材料', stc.materials || '—', '', '按机型与用途推荐'), 4),
        pad(kv('设计过载', num(stc.nLimit), 'G', '机动载荷系数'), 4),
        pad(kv('安全系数', num(stc.safetyFactor), '', '极限载荷 = 限制载荷 × 安全系数'), 4),
        pad(kv('翼根弯矩（极限）', num(stc.rootMoment), 'N·m', 'M = (W/S)·(b/2)²/8 · n · SF'), 4),
        pad(kv('主梁截面高度', num(stc.sparH * 1000), 'mm', '约 0.7 × 翼型厚度 × 根弦'), 4),
        pad(kv('碳管主梁规格', 'φ' + num(stc.sparDiaMM), 'mm', '按许用弯曲应力 900 MPa 反算（薄壁圆管）'), 4),
        pad(kv('翼肋间距', num(stc.ribSpacing * 1000), 'mm', '蒙皮不塌陷的最小间距'), 4),
        pad(kv('副翼舵机', num(stc.servoAileron), 'kg·cm', '按舵面铰链力矩 + 经验下限'), 4),
        pad(kv('升降舵舵机', num(stc.servoElevator), 'kg·cm', ''), 4),
        pad(kv('方向舵舵机', num(stc.servoRudder), 'kg·cm', ''), 4),
        pad(kv('蒙皮建议', af.tc > 0.14 ? '泡沫 / 巴尔沙蒙皮，局部碳纤维加强' : '热缩膜或玻璃纤维蒙皮', '', ''), 4),
        pad(kv('加工难度', c.area < 0.25 ? '中等（小尺寸，精度要求高）' : '常规（板材切割 + 木工）', '', ''), 4)
      ]
    });

    /* ---------- 10b Inventor 建模设计参数 ---------- */
    let mp = p.modelingParams;
    if (!mp && typeof DesignEngine !== 'undefined' && DesignEngine.modelingParams && best.core) {
      mp = DesignEngine.modelingParams(best);
    }
    mp = mp || [];
    const mpGroups = [];
    mp.forEach(function (it) { if (mpGroups.indexOf(it.group) < 0) mpGroups.push(it.group); });
    const mpRows = [header(['类别', '参数', '数值', '单位', '说明 / 建模提示'])];
    mpGroups.forEach(function (g) {
      mpRows.push(pad([{ v: g, style: S.key }, { v: '', style: S.note }, { v: '', style: S.note },
        { v: '', style: S.note }, { v: '', style: S.note }], 5));
      mp.filter(function (x) { return x.group === g; }).forEach(function (it) {
        mpRows.push(pad([
          { v: '', style: S.note },
          { v: it.name, style: S.label },
          { v: it.value === null ? '—' : it.value, style: S.num },
          { v: it.unit || '', style: S.note },
          { v: it.note || '', style: S.note }
        ], 5));
      });
    });
    defs.push({
      name: 'Inventor 建模参数', freeze: 1,
      cols: [{ w: 18 }, { w: 30 }, { w: 26 }, { w: 12 }, { w: 72 }],
      rows: [
        pad([{ v: '十、Inventor 建模设计参数', style: S.title }], 5),
        [],
        pad([{ v: '用途：直接把下面尺寸输入 Autodesk Inventor（或 SolidWorks / Fusion 360）建立三维模型。', style: S.note }], 5),
        pad([{ v: '长度单位统一为 mm，角度为 °；坐标原点建议取「机翼根弦前缘」，机身对称面为 XZ 平面。', style: S.note }], 5),
        pad([{ v: '标 ★ 的条目是建模时最容易漏掉、但会直接影响装配的尺寸。', style: S.note }], 5),
        [],
        pad(kv('参数项合计', mp.length, '项', '按 ' + mpGroups.length + ' 个零件/系统分组：' + mpGroups.join(' / '), S.key), 5),
        []
      ].concat(mpRows)
    });

    /* ---------- 11 约束校验 ---------- */
    const consRows = [header(['级别', '类别', '检查项', '实测值', '经验区间', '结论'])];
    (best.constraints || []).forEach(function (it) {
      const sty = it.level === 'error' ? S.error : it.level === 'warn' ? S.warn : S.ok;
      const lv = it.level === 'error' ? '不通过' : it.level === 'warn' ? '警告' : '通过';
      consRows.push(pad([{ v: lv, style: sty }, { v: it.cat, style: S.label }, { v: it.name, style: S.value },
        { v: String(it.value), style: S.num }, { v: String(it.band), style: S.note }, { v: it.msg, style: S.note }], 6));
    });
    const nErr = (best.errors || []).length, nWarn = (best.warnings || []).length;
    defs.push({
      name: '约束校验', freeze: 1,
      cols: [{ w: 12 }, { w: 12 }, { w: 28 }, { w: 20 }, { w: 22 }, { w: 54 }],
      rows: [
        pad([{ v: '十、约束校验', style: S.title }], 6),
        [],
        pad(kv('硬约束错误', nErr, '项', nErr ? '存在硬约束冲突，方案需调整' : '全部通过', nErr ? S.error : S.ok), 4),
        pad(kv('软约束警告', nWarn, '项', nWarn ? '建议关注' : '无警告', nWarn ? S.warn : S.ok), 4),
        pad(kv('校验项总数', (best.constraints || []).length, '项', '覆盖数值范围 / 经验区间 / 交叉冲突三类'), 4),
        [],
        section('逐项校验结果', 6)
      ].concat(consRows)
    });

    /* ---------- 12 评分明细 ---------- */
    const scoreNote = {
      stability: '静稳定裕度、尾容量、失速迎角、升阻比综合',
      range: '最大升阻比、翼载、巡航功率综合',
      speed: '可达最大速度、零升阻力、推重比综合',
      cost: '功率规模、起飞重量、翼展综合（分越高越省）',
      easyfly: '失速速度、翼载、稳定性、推重比综合',
      buildability: '翼型厚度、展弦比、尺寸、翼肋间距综合'
    };
    const scoreRows = [header(['维度', '得分', '权重', '评分说明', '', ''])];
    const weightRows = [];
    if (best.score) {
      best.score.dimensions.forEach(function (d) {
        scoreRows.push(pad([{ v: d.name, style: S.label }, { v: d.score, style: S.num },
          { v: num(d.weight), style: S.num }, { v: scoreNote[d.key] || '', style: S.note }], 4));
        weightRows.push(pad([{ v: d.name, style: S.label }, { v: num(d.weight), style: S.num }], 4));
      });
      scoreRows.push(pad([{ v: '综合得分', style: S.key }, { v: best.score.total, style: S.key },
        { v: '', style: S.note }, { v: '六维加权总分（锚点一致性修正 ' + best.score.consistency + '%）', style: S.note }], 4));
    }
    defs.push({
      name: '评分明细', freeze: 0,
      cols: [{ w: 16 }, { w: 12 }, { w: 12 }, { w: 68 }, { w: 16 }, { w: 16 }],
      rows: [
        pad([{ v: '十一、多目标评分', style: S.title }], 6),
        [],
        section('六维度得分（0~100，越高越好）', 4)
      ].concat(scoreRows).concat([
        [],
        section('评分权重（随机型变化）', 4),
        header(['维度', '权重', '', '', '', ''])
      ]).concat(weightRows)
    });

    /* ---------- 13 推荐理由 ---------- */
    const reasonRows = [];
    top3.forEach(function (t) {
      reasonRows.push(pad([{ v: '◆ ' + t.label + '（' + t.tag + '）— 综合 ' + t.plan.score.total + ' 分', style: S.subtitle }], 6));
      (t.reasons || []).forEach(function (r, i) {
        reasonRows.push(pad([{ v: String(i + 1), style: S.num }, { v: r, style: S.value }], 6));
      });
      (t.warnings || []).forEach(function (w) {
        reasonRows.push(pad([{ v: '!', style: S.warn }, { v: w, style: S.warn }], 6));
      });
      reasonRows.push([]);
    });
    defs.push({
      name: '推荐理由', freeze: 0,
      cols: [{ w: 8 }, { w: 118 }, { w: 16 }, { w: 16 }, { w: 16 }, { w: 16 }],
      rows: [pad([{ v: '十二、推荐理由与警告', style: S.title }], 6), [], section('逐方案说明', 6)].concat(reasonRows)
    });

    /* ---------- 14 方案对比 ---------- */
    const compareKeys = [
      ['机身长度 (mm)', function (x) { return num(x.core.fuselageLength * 1000); }],
      ['机身长度/翼展', function (x) { return num(x.core.fuselageRatio); }],
      ['平均弦长 (mm)', function (x) { return num(x.core.meanChord * 1000); }],
      ['根弦 (mm)', function (x) { return num(x.core.planform.root * 1000); }],
      ['尖弦 (mm)', function (x) { return num(x.core.planform.tip * 1000); }],
      ['MAC (mm)', function (x) { return num(x.core.cg.mac * 1000); }],
      ['起飞重量 (kg)', function (x) { return num(x.core.mass); }],
      ['翼面积 (m²)', function (x) { return num(x.core.area); }],
      ['翼展 (m)', function (x) { return num(x.core.span); }],
      ['展弦比', function (x) { return num(x.core.ar); }],
      ['梢根比', function (x) { return num(x.core.taper); }],
      ['翼载 (g/dm²)', function (x) { return num(x.core.wlGdm2); }],
      ['翼型', function (x) { return x.core.airfoil ? x.core.airfoil.designation : '—'; }],
      ['失速速度 (m/s)', function (x) { return num(x.core.vStall); }],
      ['最大速度 (m/s)', function (x) { return num(x.core.perf.vMaxCalc); }],
      ['最大升阻比', function (x) { return num(x.core.ldMax); }],
      ['静稳定裕度 (%MAC)', function (x) { return num(x.core.cg.staticMargin); }],
      ['平尾容量 Vh', function (x) { return num(x.core.tail.vh); }],
      ['垂尾容量 Vv', function (x) { return num(x.core.tail.vv); }],
      ['推重比', function (x) { return num(x.core.perf.thrustToWeight); }],
      ['电机 / KV', function (x) {
        return x.core.power ? (x.core.power.motor + ' / ' + x.core.power.kv)
          : (x.core.rotary ? x.core.rotary.nrotor + ' 旋翼' : '—');
      }],
      ['桨径 × 螺距 (in)', function (x) {
        return x.core.power ? (x.core.power.propIn + ' × ' + x.core.power.propPitch) : '—';
      }],
      ['电池', function (x) {
        return x.core.power ? (x.core.power.cells + 'S ' + x.core.power.capacity + 'mAh')
          : (x.core.rotary ? x.core.rotary.cells + 'S ' + x.core.rotary.capacity + 'mAh' : '—');
      }],
      ['电调 (A)', function (x) {
        return x.core.power ? x.core.power.escA : (x.core.rotary ? x.core.rotary.escA : '—');
      }],
      ['预计续航 (min)', function (x) {
        return x.core.power ? num(x.core.power.enduranceMin) : (x.core.rotary ? num(x.core.rotary.enduranceMin) : '—');
      }],
      ['碳管规格 (mm)', function (x) { return 'φ' + num(x.core.structure.sparDiaMM); }],
      ['副翼舵机 (kg·cm)', function (x) { return num(x.core.structure.servoAileron); }],
      ['硬约束错误', function (x) { return (x.errors || []).length; }],
      ['警告数', function (x) { return (x.warnings || []).length; }],
      ['综合得分', function (x) { return x.score ? x.score.total : '—'; }]
    ];
    const cmp2 = [pad(header(['对比项'].concat(top3.map(function (t) { return t.label + '（' + t.tag + '）'; }))), 6)];
    compareKeys.forEach(function (k) {
      cmp2.push(pad([{ v: k[0], style: S.label }].concat(top3.map(function (t) {
        return { v: k[1](t.plan), style: S.num };
      })), 6));
    });
    defs.push({
      name: '方案对比', freeze: 1,
      cols: [{ w: 26 }, { w: 26 }, { w: 26 }, { w: 26 }, { w: 16 }, { w: 16 }],
      rows: [pad([{ v: '十三、方案对比', style: S.title }], 6), [], section('重点参数逐项对比', 6)].concat(cmp2)
    });

    /* ---------- 15 飞机命名 ---------- */
    const nameRows = [header(['候选名称', '说明', '', '', '', ''])];
    (naming.candidates || []).forEach(function (n, i) {
      nameRows.push(pad([{ v: n, style: S.value }, { v: i === 0 ? '首选项' : '备选', style: S.note }], 6));
    });
    defs.push({
      name: '飞机命名', freeze: 0,
      cols: [{ w: 34 }, { w: 30 }, { w: 16 }, { w: 16 }, { w: 16 }, { w: 16 }],
      rows: [
        pad([{ v: '十四、飞机命名（非必填）', style: S.title }], 6),
        [],
        pad(kv('最终名称', naming.name || '（未命名，已跳过）', '', S.value), 4),
        pad(kv('命名方式', naming.skipped ? '跳过命名' : (naming.custom ? '用户自定义' : '引擎自动生成'), '',
          '不命名不影响方案保存与导出'), 4),
        pad(kv('命名规则', '中文意象 + 型号，或 DSH-机型-翼展-电池节数', '',
          '例如：游隼-120 / DSH-教练-120S3'), 4),
        [],
        section('候选名称', 6)
      ].concat(nameRows)
    });

    /* ---------- 16 公式依赖 ---------- */
    const formulas = [
      ['wingAreaFromLoading', 'S = m[kg] × 10 / wl[g/dm²]', '由起飞重量与翼载反推翼面积', 'm²'],
      ['span', 'b = √(AR × S)', '由展弦比与翼面积求翼展', 'm'],
      ['aspectRatio', 'AR = b² / S', '展弦比定义式', '—'],
      ['rootChord', 'cr = 2S / (b(1+λ))', '梯形翼根弦', 'm'],
      ['tipChord', 'ct = λ × cr', '梯形翼尖弦', 'm'],
      ['meanAeroChord', 'MAC = (2/3)·cr·(1+λ+λ²)/(1+λ)', '平均气动弦长', 'm'],
      ['macPosition', 'y = (b/6)·(1+2λ)/(1+λ)', 'MAC 的展向位置', 'm'],
      ['wingLoading', 'wl = W / S', '翼载（力）', 'N/m²'],
      ['liftCurveSlope', 'a = a0 / (1 + a0·κ/(π·AR))，κ = 1 + 2/AR', '三维升力线斜率（含低展弦比修正）', '1/rad'],
      ['clMax3D', 'CLmax,3D = CLmax,2D × (0.88 + 0.12·AR/8)', '有限翼展最大升力系数折减', '—'],
      ['stallSpeed', 'Vs = √(2W / (ρ·S·CLmax,3D))', '失速速度', 'm/s'],
      ['reynolds', 'Re = V·MAC / ν，ν = 1.81e-5', '雷诺数', '—'],
      ['wettedArea', 'Swet ≈ 2.02·S·(1 + 0.6·t/c)', '机翼浸润面积估算', 'm²'],
      ['zeroLiftDrag', 'CD0 = CD0,wing·(Swet/S) + CD0,fuse + ΔCD', '零升阻力装配', '—'],
      ['oswald', 'e = 1.78(1 − 0.045·AR^0.68) − 0.64', '奥斯瓦尔德效率因子', '—'],
      ['inducedDrag', 'k = 1/(π·AR·e)', '诱导阻力因子', '—'],
      ['maxLiftToDrag', 'L/D = 1/(2√(CD0·k))', '最大升阻比', '—'],
      ['bestGlideSpeed', 'Vmd = √(2W/(ρ·S·√(CD0/k)))', '最大升阻比速度', 'm/s'],
      ['tailVolumeH', 'Vh = Sh·lh / (S·MAC)', '平尾容量', '—'],
      ['tailVolumeV', 'Vv = Sv·lv / (S·b)', '垂尾容量', '—'],
      ['neutralPoint', 'h_n = (h_ac + Vh·η·(a_t/a)·(1−dε/dα)) / (1 + Vh·η·(a_t/a)·(1−dε/dα))', '全机焦点（中性点）', '%MAC'],
      ['staticMargin', 'SM = h_n − h_cg', '静稳定裕度', '%MAC'],
      ['thrust', 'T = CT·ρ·n²·D⁴，CT ≈ 0.095', '螺旋桨静推力', 'N'],
      ['propTorque', 'Q = CP·ρ·n²·D⁵/(2π)，CP ≈ 0.022', '螺旋桨气动扭矩', 'N·m'],
      ['motorTorque', 'Q = Kt·((V − Ke·ω)/R0 − I0)，Ke = Kt = 60/(2π·KV)', '无刷电机扭矩（SI 单位）', 'N·m'],
      ['powerPoint', '二分法求解 Qmotor(rpm) = Qprop(rpm) 的静态工作点', '转速与电流求解', 'rpm, A'],
      ['vMaxSolve', '求解 D(V) = T(V) 的交点，T(V) 随桨距速度衰减', '最大平飞速度', 'm/s'],
      ['climbRate', 'ROC = (Pavail − Plevel) / W', '爬升率', 'm/s'],
      ['turnRadius', 'R = V² / (g√(n²−1))，n = T/W', '定常盘旋半径', 'm'],
      ['rootBending', 'M = (W/S)·(b/2)²/8 · n_limit · SF', '翼根极限弯矩', 'N·m'],
      ['sparSizing', 'W_req = M/(0.8·σ)，薄壁圆管 W = (π/32)(D⁴−d⁴)/D', '碳管主梁直径反算', 'mm'],
      ['diskLoading', 'DL = W / A_disk，A_disk = n·π·D²/4', '旋翼桨盘载荷', 'N/m²'],
      ['hoverPower', 'P = T^1.5 / (FM·√(2ρ·A_disk))', '悬停功率（动量理论）', 'W'],
      ['endurance', 't = E[Wh] × 0.8 / P[W] × 60', '续航时间', 'min'],
      ['servoTorque', 'M_hinge = 0.10·q·S_surface·c，q = 0.5ρV²', '舵面铰链力矩', 'N·m'],
      ['scores', 'Score = Σ(w_i · tent(值, 目标, 容差)) / Σw_i', '多目标加权评分', '0~100'],
      ['pickTop3', '按均衡 / 稳定易飞 / 性能-续航-成本三个目标函数各取最优', 'Top3 方案生成', '—']
    ];
    defs.push({
      name: '公式依赖', freeze: 1,
      cols: [{ w: 22 }, { w: 62 }, { w: 46 }, { w: 12 }, { w: 16 }, { w: 16 }],
      rows: [
        pad([{ v: '十五、公式依赖清单', style: S.title }], 6),
        [],
        section('本方案用到的全部计算公式与依赖关系', 6),
        header(['公式 ID', '表达式', '用途', '单位', '', ''])
      ].concat(formulas.map(function (f) {
        return pad([{ v: f[0], style: S.value }, { v: f[1], style: S.label }, { v: f[2], style: S.note },
          { v: f[3], style: S.num }], 6);
      }))
    });

    /* ---------- 17 版本历史 ---------- */
    const hist = (p.versionHistory || []).slice();
    const histRows = [header(['版本', '时间', '变更说明', '', '', ''])];
    if (!hist.length) {
      histRows.push(pad([{ v: 'v1.0', style: S.value },
        { v: project.createdAt || new Date().toLocaleString('zh-CN'), style: S.note },
        { v: '初始方案生成（' + (snap.typeName || '') + '，校验码 ' + (snap.checksum || '—') + '）', style: S.note }], 6));
    } else {
      hist.forEach(function (h) {
        histRows.push(pad([{ v: h.version, style: S.value }, { v: h.time, style: S.note }, { v: h.note, style: S.note }], 6));
      });
    }
    defs.push({
      name: '版本历史', freeze: 1,
      cols: [{ w: 14 }, { w: 26 }, { w: 72 }, { w: 16 }, { w: 16 }, { w: 16 }],
      rows: [
        pad([{ v: '十六、版本历史与快照', style: S.title }], 6),
        [],
        pad(kv('快照校验码', snap.checksum || '—', '基于核心计算结果的哈希，可用于确认方案未被改动', S.value), 4),
        pad(kv('快照时间', snap.createdAt || '—', ''), 4),
        pad(kv('是否只读', snap.readonly ? '是（已冻结）' : '否', ''), 4),
        pad(kv('引擎版本', 'design-engine ' + (project.version || '—'), 'airfoil-lib + design-engine + xlsx-export'), 4),
        [],
        section('变更记录', 6)
      ].concat(histRows)
    });

    return defs.map(function (def, i) {
      return { idx: i + 1, name: def.name, def: def };
    });
  }

  /* =======================================================================
   * 4. 下载（浏览器）
   * ===================================================================== */
  function download(payload, filename) {
    const bytes = buildWorkbook(payload);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || '设计方案.xlsx';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1500);
    return bytes.length;
  }

  return { buildWorkbook: buildWorkbook, download: download, zip: zip, crc32: crc32, STYLES: STYLES };
});
