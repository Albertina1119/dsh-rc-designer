/*!
 * app-shell.js —— 商业化外壳（纯前端 / 零依赖 / 浏览器 + Node 通用）
 *
 * 对应《商业化改造基础版实施方案》中「无需后端即可落地」的部分：
 *   1) 本地项目管理（localStorage）＋ 历史版本快照 ＋ 回滚        （方案 4.1 / 4.2）
 *   2) .dshproj 导入导出 ＋ 分享链接（状态编码进 URL，免登录可读） （方案 4.4 / 4.5）
 *   3) 术语词典 ＋ 正文自动释义                                   （方案 6.2）
 *   4) 标杆案例库（可一键载入）                                    （方案 6.4）
 *   5) 适航 / 重量分级合规提示（提示性，非法律意见）                （方案 5.5）
 *   6) Changelog ＋ 版本号                                        （方案 7 / 8）
 *
 * 明确不包含（需服务端，本模块不伪造）：
 *   真实注册登录 / 跨设备同步 / 协作编辑 / 云端存储 / 禁飞区数据接入
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AppShell = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '2.0.0';
  const SCHEMA = 'dsh-project@1';
  const STORE_KEY = 'dsh.rcDesigner.v1';

  /* =====================================================================
   * 1. base64url（浏览器与 Node 通用，不依赖 atob/btoa/Buffer）
   * =================================================================== */
  const B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const B64M = (function () {
    const m = {};
    for (let i = 0; i < B64C.length; i++) m[B64C.charAt(i)] = i;
    return m;
  })();

  /** 字符串 → UTF-8 字节数组（含代理对处理） */
  function utf8Bytes(str) {
    const s = String(str == null ? '' : str), out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
          i++;
        } else {
          out.push(0xef, 0xbf, 0xbd);
        }
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return out;
  }

  /** UTF-8 字节数组 → 字符串 */
  function utf8Str(bytes) {
    let out = '', i = 0;
    while (i < bytes.length) {
      const b = bytes[i++];
      if (b < 0x80) { out += String.fromCharCode(b); continue; }
      if (b < 0xe0) {
        out += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
      } else if (b < 0xf0) {
        out += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
      } else {
        const cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
        const v = cp - 0x10000;
        out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 1023));
      }
    }
    return out;
  }

  /** base64url 编码（无填充） */
  function b64enc(str) {
    const b = utf8Bytes(str);
    let out = '';
    for (let i = 0; i < b.length; i += 3) {
      const b1 = b[i], b2 = b[i + 1], b3 = b[i + 2];
      out += B64C.charAt(b1 >> 2);
      out += B64C.charAt(((b1 & 3) << 4) | (b2 === undefined ? 0 : b2 >> 4));
      if (b2 === undefined) break;
      out += B64C.charAt(((b2 & 15) << 2) | (b3 === undefined ? 0 : b3 >> 6));
      if (b3 === undefined) break;
      out += B64C.charAt(b3 & 63);
    }
    return out;
  }

  /** base64url 解码（容错：忽略非法字符） */
  function b64dec(s) {
    const clean = String(s || '').replace(/[^A-Za-z0-9\-_]/g, '');
    const bytes = [];
    let buf = 0, bits = 0;
    for (let i = 0; i < clean.length; i++) {
      const v = B64M[clean.charAt(i)];
      if (v === undefined) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 0xff); }
    }
    return utf8Str(bytes);
  }

  /** 把状态对象编码成 URL 安全字符串 */
  function packState(state) {
    try { return b64enc(encodeURIComponent(JSON.stringify(state || {}))); }
    catch (e) { return ''; }
  }

  /** 解码；失败返回 null 而不是抛错 */
  function unpackState(str) {
    if (!str) return null;
    try { return JSON.parse(decodeURIComponent(b64dec(str))); }
    catch (e) { return null; }
  }

  /* =====================================================================
   * 2. .dshproj 文件格式（方案 4.5）
   * =================================================================== */
  function makeProjectFile(state, meta) {
    const m = meta || {};
    return JSON.stringify({
      format: SCHEMA,
      meta: {
        name: m.name || '未命名方案',
        author: m.author || 'local',
        ts: Math.floor(Date.now() / 1000),
        app: 'dsh-rc-designer',
        appVersion: VERSION
      },
      state: state || {}
    }, null, 2);
  }

  function parseProjectFile(text) {
    let j;
    try { j = JSON.parse(String(text || '')); }
    catch (e) { return { ok: false, error: '不是合法的 JSON 文件' }; }
    if (!j || typeof j !== 'object') return { ok: false, error: '文件内容为空或格式错误' };
    if (j.format !== SCHEMA) {
      return { ok: false, error: '不是本工具的方案文件（需要 format = "' + SCHEMA + '"，实际为 "' + (j.format || '无') + '"）' };
    }
    if (!j.state || typeof j.state !== 'object') return { ok: false, error: '方案文件缺少 state 字段' };
    return { ok: true, meta: j.meta || {}, state: j.state };
  }

  /** 生成分享链接（状态全部编码在 URL hash，服务端零参与） */
  function makeShareUrl(baseUrl, state) {
    const base = String(baseUrl || '').split('#')[0];
    return base + '#d=' + packState(state);
  }

  /** 从 URL 里取出分享状态 */
  function readShareHash(hash) {
    const h = String(hash == null ? (typeof location !== 'undefined' ? location.hash : '') : hash);
    const m = /(?:^#|&)d=([A-Za-z0-9\-_]+)/.exec(h);
    return m ? unpackState(m[1]) : null;
  }

  /* =====================================================================
   * 3. 本地项目管理 + 历史版本（方案 4.1 / 4.2 的前端实现）
   * =================================================================== */
  function memStorage() {
    const m = {};
    return {
      getItem: function (k) { return m[k] === undefined ? null : m[k]; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; },
      __mem: m
    };
  }

  function ProjectStore(storage, key) {
    const K = key || STORE_KEY;
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : memStorage());

    function readAll() {
      try {
        const raw = st.getItem(K);
        if (!raw) return { projects: [], seq: 1 };
        const j = JSON.parse(raw);
        return {
          projects: Array.isArray(j.projects) ? j.projects : [],
          seq: isFinite(j.seq) ? j.seq : 1
        };
      } catch (e) { return { projects: [], seq: 1 }; }
    }

    function writeAll(db) {
      try { st.setItem(K, JSON.stringify(db)); return true; }
      catch (e) { return false; }
    }

    function uid() {
      // 不用共享 db 的 seq（save() 会用自己的副本回写，导致 seq 被覆盖 → ID 撞车）
      return 'p' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    /** 方案列表（不含版本明细，按更新时间倒序） */
    function list() {
      return readAll().projects.map(function (p) {
        return {
          id: p.id, name: p.name, typeName: p.typeName, typeId: p.typeId,
          createdAt: p.createdAt, updatedAt: p.updatedAt,
          versionCount: (p.versions || []).length,
          score: p.state && p.state.score != null ? p.state.score : null,
          mode: p.state && p.state.mode ? p.state.mode : null
        };
      }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    }

    function get(id) {
      return readAll().projects.filter(function (p) { return p.id === id; })[0] || null;
    }

    /** 新建或覆盖保存；每次保存都追加一个版本快照 */
    function save(input) {
      const db = readAll();
      const now = Date.now();
      const inState = input.state || {};
      let p = input.id ? db.projects.filter(function (x) { return x.id === input.id; })[0] : null;
      const isNew = !p;
      if (!p) {
        p = {
          id: uid(), createdAt: now, versions: [],
          name: input.name || ('方案 ' + new Date(now).toLocaleString('zh-CN')),
          state: inState, versions: []
        };
        db.projects.push(p);
      }
      p.name = input.name || p.name;
      p.state = inState;
      p.typeId = inState.typeId || p.typeId || '';
      p.typeName = inState.typeName || p.typeName || '';
      p.updatedAt = now;
      p.versions = p.versions || [];
      const vno = p.versions.length + 1;
      p.versions.push({
        no: vno, ts: now, note: input.note || ('第 ' + vno + ' 次保存'),
        score: inState.score != null ? inState.score : null,
        anchors: JSON.parse(JSON.stringify(inState.anchors || {})),
        state: JSON.parse(JSON.stringify(inState))
      });
      // 只保留最近 30 个版本，避免撑爆 localStorage
      if (p.versions.length > 30) p.versions = p.versions.slice(-30);
      writeAll(db);
      return { ok: true, id: p.id, name: p.name, versionNo: vno, isNew: isNew };
    }

    function rename(id, name) {
      const db = readAll();
      const p = db.projects.filter(function (x) { return x.id === id; })[0];
      if (!p) return false;
      p.name = String(name || '').trim() || p.name;
      p.updatedAt = Date.now();
      return writeAll(db);
    }

    function remove(id) {
      const db = readAll();
      const n = db.projects.length;
      db.projects = db.projects.filter(function (x) { return x.id !== id; });
      writeAll(db);
      return db.projects.length < n;
    }

    function versions(id) {
      const p = get(id);
      if (!p) return [];
      return (p.versions || []).map(function (v) {
        return { no: v.no, ts: v.ts, note: v.note, score: v.score, anchors: v.anchors };
      });
    }

    /** 取某个版本的完整状态（用于回滚 / 对比） */
    function versionState(id, no) {
      const p = get(id);
      if (!p) return null;
      const v = (p.versions || []).filter(function (x) { return x.no === Number(no); })[0];
      return v ? JSON.parse(JSON.stringify(v.state)) : null;
    }

    function clear() { st.removeItem(K); return true; }

    /** 存储占用（字节），用于提示用户本地容量 */
    function usage() {
      const raw = st.getItem(K) || '';
      return { bytes: raw.length, kb: Math.round(raw.length / 1024 * 10) / 10, projects: readAll().projects.length };
    }

    return {
      list: list, get: get, save: save, rename: rename, remove: remove,
      versions: versions, versionState: versionState, clear: clear, usage: usage
    };
  }

  /* =====================================================================
   * 4. 术语词典（方案 6.2）
   * =================================================================== */
  const GLOSSARY = [
    { term: '锚点', en: 'Anchor', def: '用户明确指定的输入参数。引擎只保证这些值被采纳，其余参数由规则推导或择优得出。锚点越多越精确，但约束也越强。', rel: ['补全', '择优'] },
    { term: '翼载', en: 'Wing Loading, W/S', def: '起飞重量除以机翼面积，常用 g/dm² 表示。翼载低 → 失速慢、好飞但抗风差；翼载高 → 速度快但起降难。模型机常见 30~80 g/dm²。', rel: ['失速速度', '翼面积'] },
    { term: '推重比', en: 'Thrust-to-Weight Ratio, T/W', def: '静推力除以起飞重量。模型固定翼 0.5~0.8 可平飞+爬升，0.8 以上可垂直机动；多旋翼必须 > 1 才能悬停，常用 2 左右。', rel: ['静推力'] },
    { term: 'MAC', en: 'Mean Aerodynamic Chord', def: '平均气动弦长。锥形翼各剖面的等效弦长，重心位置与静稳定裕度都以它为基准度量。', rel: ['静稳定裕度', '气动焦点'] },
    { term: '梢根比', en: 'Taper Ratio, λ', def: '翼尖弦长除以翼根弦长。0.4~0.8 常见；λ 太小翼尖先失速，λ=1 为矩形翼（最易制作）。', rel: ['根弦', '尖弦'] },
    { term: '静稳定裕度', en: 'Static Margin, SM', def: '重心到气动焦点的距离，以 %MAC 表示。12~18% 为佳：太小易抬头失控，太大则迟钝、配平阻力高。', rel: ['MAC', '气动焦点'] },
    { term: '雷诺数', en: 'Reynolds Number, Re', def: '惯性力与粘性力之比。模型机（弦长 0.1~0.3 m）常在 5e4~5e5，此时翼型性能与全尺寸差异明显，需选适合低 Re 的翼型。', rel: ['翼型'] },
    { term: 'Vh / Vv', en: 'Tail Volume Coefficient', def: '尾容量系数 = 尾翼面积 × 尾臂 ÷ (机翼面积 × MAC)。衡量尾翼"够不够力"，平尾 Vh 常用 0.4~0.6，垂尾 Vv 0.03~0.05。', rel: ['尾臂'] },
    { term: '尾臂', en: 'Tail Arm, lh', def: '重心到平尾气动中心的距离。尾臂越长尾翼可越小，但机身更长、更重。', rel: ['Vh / Vv'] },
    { term: '失速速度', en: 'Stall Speed, Vs', def: '升力系数达到 CLmax 时的最低速度：Vs = √(2W/(ρS·CLmax))。低于此速度无法维持平飞。', rel: ['翼载', 'CLmax'] },
    { term: 'CLmax', en: 'Maximum Lift Coefficient', def: '翼型能达到的最大升力系数（二维）。三维机翼还会因展弦比与后掠损失一部分，记作 CLmax3D。', rel: ['失速速度', '展弦比'] },
    { term: '展弦比', en: 'Aspect Ratio, AR', def: '翼展平方除以机翼面积。AR 大 → 诱导阻力小、滑翔好；AR 小 → 灵活、结构强。模型机常见 4~10。', rel: ['诱导阻力'] },
    { term: '诱导阻力', en: 'Induced Drag', def: '产生升力的代价，与升力系数平方成正比、与展弦比成反比。低速大迎角时占主导。', rel: ['展弦比'] },
    { term: 'NACA 编号', en: 'NACA Airfoil Code', def: '4 位（如 2412 = 弯度 2%、位置 40%、厚度 12%）、5 位（23012，前缘大弯度）、6 位（65-210，层流翼型）三种。数字直接对应几何参数。', rel: ['翼型'] },
    { term: '气动焦点', en: 'Aerodynamic Center', def: '俯仰力矩系数不随升力变化的点，约在 MAC 的 25% 处。重心必须在它之前才有静稳定性。', rel: ['静稳定裕度', 'MAC'] },
    { term: '桨盘载荷', en: 'Disk Loading', def: '旋翼/多旋翼重量除以桨盘总面积（N/m²）。越低悬停效率越高、续航越好，但桨径更大。', rel: ['多旋翼'] },
    { term: 'KV', en: 'Motor KV', def: '电机每伏转速（rpm/V）。高 KV 配小桨（高速），低 KV 配大桨（高效率）。例：3S 电池 11.1 V × 1000 KV ≈ 11000 rpm 空载。', rel: ['桨径'] },
    { term: '桨距', en: 'Prop Pitch', def: '螺旋桨旋转一圈理论前进的距离（英寸）。桨径×桨距常写作 "10×4.7"。桨距速度 = 桨距×转速，是推力的高速衰减界限。', rel: ['桨径', 'KV'] }
  ];

  function findTerm(name) {
    const n = String(name || '').trim();
    if (!n) return null;
    return GLOSSARY.filter(function (g) { return g.term === n; })[0]
      || GLOSSARY.filter(function (g) { return g.term.indexOf(n) >= 0 || n.indexOf(g.term) >= 0; })[0]
      || null;
  }

  /** 把文本里命中的术语包成带 tooltip 的 span（返回 HTML 字符串） */
  function annotateTerms(text, usedTitles) {
    let s = String(text == null ? '' : text);
    const used = usedTitles || {};
    // 长词优先，避免「翼载」被「翼」抢先匹配
    const sorted = GLOSSARY.slice().sort(function (a, b) { return b.term.length - a.term.length; });
    sorted.forEach(function (g) {
      if (used[g.term]) return;
      const i = s.indexOf(g.term);
      if (i < 0) return;
      used[g.term] = 1;
      s = s.slice(0, i) + '<span class="term" data-term="' + g.term + '">' + g.term + '</span>' + s.slice(i + g.term.length);
    });
    return s;
  }

  /* =====================================================================
   * 5. 标杆案例库（方案 6.4）
   * =================================================================== */
  const CASES = [
    {
      id: 'case-trainer', name: '入门练习机 · 1.2 m 翼展', typeId: 'trainer',
      tag: '难度 ★　最适合第一架', difficulty: 1,
      goal: '一架上手就能飞、摔了容易修、总价控制在 500 元内的电动练习机。',
      anchors: { wl: 45, twr: 0.65, vmax: 20, span: 1.2 },
      recommended: { 翼型: 'NACA 2412', 机身长度: '≈ 870 mm', 平均弦长: '≈ 222 mm', 电池: '3S 2200 mAh', 舵机: '12 g 金属齿 × 4' },
      why: '翼载取 45 g/dm² 让失速速度落在 7 m/s 附近，手抛起飞容错大；推重比 0.65 既能爬升又不会因为动力过猛而难控。翼展 1.2 m 是携带与制作成本的平衡点。',
      points: ['翼型自动推荐会落在 NACA 2412 / 23012 一类，失速和缓', '静稳定裕度建议 14% MAC 左右，首飞先按此设重心', '材料选轻木 + 泡沫，损毁后易修复']
    },
    {
      id: 'case-fpvracer', name: 'FPV 竞速机 · 5 寸穿越', typeId: 'racer',
      tag: '难度 ★★★　速度优先', difficulty: 3,
      goal: '5 寸穿越机，最大速度 40 m/s 以上，抗风好、机动凌厉。',
      anchors: { wl: 85, twr: 1.8, vmax: 42, span: 0.75 },
      recommended: { 翼型: 'NACA 0012 / 2408', 电机: '2207 2450KV', 桨: '5×4.5 三叶', 电池: '4S 1500 mAh 100C', 电调: '四合一 45A' },
      why: '竞速机的核心矛盾是「高翼载换速度」与「低速不能失控」。翼载 85 g/dm² 已经把失速速度推到 13 m/s 以上，所以推重比必须 ≥1.6 才有足够加速与改出余量。',
      points: ['小展弦比（3~5）薄翼，诱导阻力大但滚转快', '电池选高 C 率（≥100C），否则大油门会掉压', '机架优先碳纤维，抗摔比减重更重要']
    },
    {
      id: 'case-glider', name: '滑翔机 · 2 m 热气流', typeId: 'glider',
      tag: '难度 ★★　续航优先', difficulty: 2,
      goal: '2 m 翼展的手抛/牵引滑翔机，能在弱热气流里长时间滞空。',
      anchors: { ar: 11, wl: 26, twr: 0.28, span: 2.0 },
      recommended: { 翼型: 'NACA 4412 / 65-210', 展弦比: '≈ 11', 机身长度: '≈ 1050 mm', 平均弦长: '≈ 180 mm', 舵机: '9 g × 3' },
      why: '滑翔机的分数几乎全压在升阻比上，所以展弦比要拉到 10 以上、翼载压到 30 g/dm² 以内。推重比 0.28 只够爬升到起始高度，不需要更大。',
      points: ['翼型选低阻层流型（65-210）或高升力型（4412）看气流强弱', '结构刚度是展弦比的天花板，碳管主梁别省', '重心宁可略靠前，滑翔机对纵向失稳特别敏感']
    },
    {
      id: 'case-edf', name: '涵道风扇机 · 70 mm EDF', typeId: 'edf',
      tag: '难度 ★★★★　涵道推进', difficulty: 4,
      goal: '70 mm 涵道风扇动力的小型喷气像真机，能稳定加速到 40 m/s。',
      anchors: { wl: 95, twr: 0.72, vmax: 40, span: 0.9 },
      recommended: { 翼型: 'NACA 2408 / 2410', 动力: 'EDF 70 mm 2800KV', 电池: '4S 3000 mAh', 电调: '60~80 A', 尾翼: '全动平尾' },
      why: '涵道风扇的静推力明显低于同尺寸螺旋桨，所以推重比只能取 0.7 左右，靠翼载与小展弦比薄翼把速度撑起来。起飞需要滑跑或弹射，不能手抛。',
      points: ['涵道筒进出气面积比影响推力，进气口别做太小', '翼载 95 g/dm² 意味着失速速度接近 11 m/s，低速段要留速度', '风扇转速高，动平衡与进气异物是主要故障源']
    },
    {
      id: 'case-jet', name: '小型喷气机 · 4 kg 涡喷', typeId: 'jet',
      tag: '难度 ★★★★★　涡喷动力', difficulty: 5,
      goal: '4 kg 推力微型涡喷、起飞重量 6 kg 级的像真喷气机。',
      anchors: { wl: 140, twr: 0.8, vmax: 62, span: 1.5 },
      recommended: { 翼型: 'NACA 2408 / 0010', 动力: '涡喷 4.0 kg', 燃油: '≈ 2.6 L 煤油', 舵机: '25 g 以上金属齿', 结构: '碳纤维 + 玻纤复合' },
      why: '涡喷的推力不随速度衰减得快，所以高速段效率高；但翼载必须做到 140 g/dm² 才能装下油箱与涡轮。起降滑跑长、失速速度高，对场地要求最严。',
      points: ['燃油按分钟消耗，续航通常只有 10~15 分钟', '涡喷启动需要 ECU 与接收机独立供电，别和舵机共用 BEC', '高温排气区域的蒙皮必须用耐热材料']
    },
    {
      id: 'case-rotor', name: '旋翼机 · 5 寸竞速四轴', typeId: 'multirotor',
      tag: '难度 ★★★　旋翼示例', difficulty: 3,
      goal: '5 寸桨竞速四轴，推重比 4、能翻滚与急停。',
      anchors: { mass: 0.65, disk: 200, nrotor: 4, twr: 4, style: 5 },
      recommended: { 桨: '5×4.5 三叶', 电机: '2207 2450KV', 电池: '4S 1500 mAh', 电调: '四合一 45A', 轴距: '≈ 180 mm' },
      why: '桨盘载荷 200 N/m² 对应 5 寸桨（127 mm），是竞速机标准配置；推重比 4 才能支撑急加速与翻滚。风格拉到 5（激进），引擎会加大推重比与舵面行程。',
      points: ['旋翼机型不计算机翼与尾翼，改为旋翼几何与轴距', '电池容量别贪大，否则重量抵消续航收益', '碳纤维机架 + 铝柱，抗摔优先']
    }
  ];

  /* =====================================================================
   * 6. 适航 / 重量分级合规提示（方案 5.5，提示性，非法律意见）
   * =================================================================== */
  const WEIGHT_CLASSES = [
    { max: 0.25, cls: '微型', name: '微型无人机（≤0.25 kg）', notes: '多数地区无需实名登记即可飞行；仍须遵守禁飞区、限高与视距要求。' },
    { max: 4, cls: '轻型', name: '轻型无人机（0.25~4 kg）', notes: '国内需实名登记并在机体上粘贴登记标志；操控者通常需具备相应合格证。' },
    { max: 7, cls: '小型', name: '小型无人机（4~7 kg）', notes: '需实名登记、操控员执照；飞行活动可能需提前申请空域。' },
    { max: 25, cls: '中型', name: '中型无人机（7~25 kg）', notes: '属严格管理范畴，需适航/运营许可，务必咨询当地民航管理部门。' },
    { max: Infinity, cls: '大型', name: '大型无人机（>25 kg）', notes: '需完整的适航审定与运营资质，个人爱好用途极难获批。' }
  ];

  function weightClass(massKg) {
    const m = isFinite(massKg) ? Math.max(0, massKg) : 1;
    const c = WEIGHT_CLASSES.filter(function (x) { return m <= x.max; })[0] || WEIGHT_CLASSES[WEIGHT_CLASSES.length - 1];
    return { mass: Math.round(m * 1000) / 1000, cls: c.cls, name: c.name, notes: c.notes };
  }

  const COMPLIANCE_ITEMS = [
    { k: 'register', t: '实名登记', d: '起飞重量 ≥ 0.25 kg 需在民航局无人机实名登记系统登记，并把登记标志贴在机体上。' },
    { k: 'limit', t: '限高与视距', d: '常见规定为真高不超过 120 m、必须在目视视距内飞行（微型/轻型）。' },
    { k: 'nofly', t: '禁飞区与空域', d: '机场净空区、军事管理区、重点敏感区域禁飞；起飞前请用当地空域查询工具确认。' },
    { k: 'people', t: '避让人群与设施', d: '不得在人群密集区、大型活动上空飞行；避免接近高压线、通信塔。' },
    { k: 'night', t: '夜航与灯光', d: '夜航通常需要额外的照明与申请；模型机夜航风险高，不建议。' },
    { k: 'insure', t: '责任与保险', d: '建议购买第三方责任险；坠机造成他人损失需承担赔偿责任。' }
  ];

  /** 生成合规提示清单（纯规则，不联网） */
  function complianceReport(massKg, opts) {
    const o = opts || {};
    const wc = weightClass(massKg);
    const items = COMPLIANCE_ITEMS.map(function (it) {
      let level = 'info', tip = it.d;
      if (it.k === 'register') {
        level = wc.mass >= 0.25 ? 'warn' : 'ok';
        tip = wc.mass >= 0.25 ? '你的 ' + wc.mass + ' kg 已超过 0.25 kg，需要实名登记。' : '0.25 kg 以下通常无需登记。';
      }
      if (it.k === 'nofly' && o.gps) {
        tip = '起飞点 ' + o.gps + '：本工具不联网，无法校验禁飞区，请务必自行查询当地空域。';
      }
      return { key: it.k, title: it.t, level: level, text: tip };
    });
    return {
      weight: wc, items: items,
      disclaimer: '以上仅为基于公开常识的提示性信息，不构成法律意见。实际飞行前请以当地民航管理部门的最新规定为准，并对自己的飞行行为负责。'
    };
  }

  /* =====================================================================
   * 7. 帮助中心 FAQ（方案 6.3）
   * =================================================================== */
  const FAQ = [
    {
      q: '数值锚点是什么？',
      a: '锚点 = 你明确指定、要求引擎必须采纳的输入参数。例如你勾选「翼载 = 45 g/dm²」，引擎就会以这个值为硬约束反推翼面积与重量。' +
        '锚点分 5 个维度：几何、重量、动力、性能、风格。至少要给 2 个并覆盖 2 个维度，引擎才能做交叉推理；数量不设上限，给得越多越精确，但可行解空间也越小。'
    },
    {
      q: '置信度代表什么？',
      a: '置信度是引擎对「这套方案可信程度」的自评，范围 20%~98%，主要由三个因素决定：锚点数量与维度覆盖度、锚点与机型典型配置的偏离程度、约束校验的通过率。' +
        '它不是「飞行安全概率」，也不代表计算精度——只是提示你：如果锚点很少或严重偏离机型经验区间，结果就只能当方向参考。'
    },
    {
      q: '冻结方案后还能修改吗？',
      a: '冻结会生成只读快照（含校验码），用于归档与导出，快照本身不可改。但你可以随时「取消冻结」回到可编辑状态，改完再重新冻结。' +
        '每次冻结都会生成新的校验码，历史快照仍可通过「我的项目 → 历史版本」找回。'
    },
    {
      q: '校验码有什么用？',
      a: '校验码是对「核心计算结果」做的哈希（形如 DSH-练习机-120S3）。它有两个用途：一是确认你手上的方案文件与当初导出的是否一致；' +
        '二是团队沟通时用它指代某一具体版本，避免「你说的那版」产生歧义。校验码不包含时间与名称，所以同名不同参数的方案校验码一定不同。'
    },
    {
      q: '为什么某些参数超出经验区间仍然能生成方案？',
      a: '因为本工具是「设计探索」工具，不是「合规审核」工具。引擎不会因为某一项超出区间就拒绝出结果——否则你就无法试探边界设计。' +
        '超出区间会以「警告」呈现，严重冲突才标「错误」。错误只保留给物理上不成立的项（如翼面积为负、失速速度超出 2~30 m/s），' +
        '所以即使有警告，方案仍可能是一架能飞的飞机——只是偏离了该机型的常规做法。'
    },
    {
      q: '警告和错误有什么区别？',
      a: '三级校验的定义如下：<ul>' +
        '<li><b>通过</b>：实测值落在该机型的经验区间内，无需调整。</li>' +
        '<li><b>警告</b>：超出经验区间，但物理上仍可行。<b>任何超出区间的项都不会显示「通过」</b>。给出方向性建议，你可以选择接受。</li>' +
        '<li><b>错误</b>：物理或几何上不成立的组合（如翼面积 ≤ 0、失速速度 > 30 m/s）。必须修正才能得到可用方案。</li>' +
        '</ul>每项都会附「建议」，告诉你要把参数往哪个方向调。不同机型（练习机 / 竞速机 / 滑翔机 / 涵道机 / 喷气机 / 旋翼机）使用各自的经验区间，同一个数值在不同机型下的判定可能完全不同。'
    },
    {
      q: '如何导出 BOM？',
      a: '生成方案后，右栏「器件清单与 BOM」卡片会按「电机 → 电调 → 螺旋桨 → 舵机 → 电池」给出推荐型号（每类前三名）。' +
        '点卡片底部的「导出 BOM JSON」或「导出 BOM CSV」即可下载。CSV 可直接用 Excel 打开，含型号、关键规格、重量、价格等级与购买链接列。' +
        '若某器件没有收录购买链接，界面只显示型号信息、不显示购买按钮，CSV 中该列留空。'
    },
    {
      q: '如何导出翼肋 DXF？',
      a: '右栏「建模」标签页 →「制造文件」区 →「下载翼肋 DXF」。文件按当前翼型与根弦长度生成，单位毫米，实体为闭合多段线（POLYLINE），' +
        '并额外画了主梁过孔图层（SPAR_HOLE）。AutoCAD、LibreCAD、Fusion 360、Inventor 都能直接打开；打开后建议检查 $INSUNITS 是否为 4（毫米）。'
    },
    {
      q: '如何导出机身 SVG？',
      a: '同样在「建模」标签页的「制造文件」区，点「下载机身侧视 SVG」。SVG 由浏览器原生生成，含机身轮廓、机翼与尾翼截面、' +
        '重心标记、尺寸标注（总长 / 尾臂 / 根弦 / 机翼厚度），可直接用浏览器打开、打印，或导入 Illustrator / Inkscape / CorelDRAW 继续描图。'
    },
    {
      q: '三视图为什么是线框而不是精细模型？',
      a: '因为本工具输出的是「概念设计尺寸」，不是已经定稿的曲面模型。线框能最快暴露比例、位置与装配冲突，渲染耗时为 0，' +
        '而且在任何设备上都不会因为显卡差异而失真。真正的曲面建模应该在 Inventor / SolidWorks 里按「建模参数」表重建——' +
        '那张表里每项长度都已换算成毫米，可直接输入。'
    },
    {
      q: '离线模式如何使用？',
      a: '本站是纯前端单页应用，首次加载后会把核心资源注册进 Service Worker 缓存。之后即使断网，用同一个浏览器打开同一地址仍能正常使用全部计算与导出功能。' +
        '检测到新版本时页面顶部会弹出提示，可选「立即刷新」或「稍后」。注意：清浏览器数据会同时清掉离线缓存。'
    },
    {
      q: '方案数据保存在哪里？',
      a: '保存在你浏览器的 localStorage（键名 dsh.rcDesigner.v1）。刷新、关标签页都不会丢；但清缓存、换设备、无痕窗口会丢。' +
        '本站没有服务器与账号体系，所以<b>不存在云端备份</b>。重要方案请用「导出 .dshproj」保存成文件，或「分享」把参数编码进链接留存。' +
        '「我的项目」页面会显示当前占用了多少 KB，浏览器 localStorage 上限通常 5 MB，每个项目最多保留最近 30 个版本快照。'
    }
  ];
  /* =====================================================================
   * 8. Changelog
   * =================================================================== */
  const CHANGELOG = [
    {
      version: '2.0.0', date: '2026-10-15',
      highlights: [
        'Inventor 功能整体重做：删除本地桥（PowerShell + COM 自动化），彻底不再连接用户的 Inventor',
        '改为三级递进，每级单独可跑、随时可停：环境自检（零副作用）→ 只画草图（低风险）→ 草图+放样（可选）',
        '修正上一版 CreateProfile 参数个数错误（传了 2 个参数，API 只接受 1 个）',
        '不再按 WorkPlanes.Item(2)/(3) 猜平面，改为按 Plane.Normal 的法向识别',
        '宏里零文件写操作：无 Save / SaveAs / Open / Delete；新文档以不可见方式创建',
        '硬闸门：Inventor 里有任何文档打开就拒绝运行；出错时只关闭自己创建的文档',
        '新增零风险路径：手工建模包（参数 JSON + 翼型 DXF + 带具体尺寸的建模步骤）',
        '全站确认不做任何网络请求（纯静态、纯本地）'
      ]
    },
    {
      version: '1.9.0', date: '2026-10-15',
      highlights: [
        '新增「Inventor 建模」标签页：两条路都能直接出模型',
        '路径 A（零安装）：导出一键运行的 VBA 宏 InventorBuild.bas + 参数 JSON + 中文说明',
        '路径 B（一键）：配套本地桥 inventor-bridge（Node 零依赖），网页点按钮即让 Inventor 建模',
        'VBA 宏输出纯 ASCII（VBA 按系统 ANSI 读文件，中文注释会乱码）',
        '本地桥只监听 127.0.0.1、校验 Origin、只收数字参数，数据不外传'
      ]
    },
    {
      version: '1.8.1', date: '2026-10-15',
      highlights: [
        '修复：设置自定义翼型后点「生成方案」无反应 —— airfoil 混入锚点集合，导致 checkAnchorsOrWarn 读取 undefined.dim 抛异常',
        '新增 realAnchorKeys()：锚点计数、维度统计、步骤条只统计真正的数值锚点，字符串型翼型编号不再计入',
        '修复模块级状态（STAGE/TAB/VIEWS/VD/CUR_BOM）的 TDZ 时序问题，统一移到脚本顶部用 var 声明',
        '新增 scrollTop() 安全滚动封装，沙箱或老浏览器缺 window.scrollTo 时不再抛错'
      ]
    },
    {
      version: '1.8.0', date: '2026-10-15',
      highlights: [
        '纯输入模式修正：未勾选引擎推荐值时，没给的参数改由已给锚点按物理公式算出，不再直接抄机型模板',
        '面积 = 重量×10÷翼载、翼展 = √(面积×展弦比)、面积 = 翼展×弦长；推重比×重量 → 所需推力 → 桨径/电机',
        '参数表新增来源徽标：你（锚点）/ 算（推导）/ 模（模板假设），并在总体页汇总三项数量',
        '修正同时给翼展+弦长时，展弦比一致性校正会悄悄覆盖弦长锚点的问题',
        'source 标记由 baseline 细化为 anchor / derived / template'
      ]
    },
    {
      version: '1.7.0', date: '2026-10-15',
      highlights: [
        'Service Worker 改为网络优先：在线用户永远拿到最新代码，杜绝「新页面 + 旧脚本」导致的新功能整块消失',
        '约束校验：用户锚点造成的偏离由「错误」降级为「警告」，并注明「该值由你的锚点指定」',
        '新增「零警告」统计（clean 层级）：可行数恒为 100% 时也能看出候选质量分布',
        '顶栏与结果页摘要显示 候选 / 可行 / 零警告 三级数字'
      ]
    },
    {
      version: '1.6.0', date: '2026-10-15',
      highlights: [
        '按用途推荐机翼制造材料：10 机型各一套主推/备选/不推荐方案 + 工艺路线 + 难度成本',
        '按展弦比/翼根弯矩/最大速度/翼展/起飞重量追加结构修正建议',
        '平尾与垂尾补齐翼展、根弦、尖弦、平均弦、展弦比、梢根比',
        '尾翼材质按载荷分三档（轻木构架 / 巴尔沙实心 / 碳纤玻纤复合）',
        'Excel 尾翼表与结构材料表补全部材质行；工作表编号修正为连续十八张',
        '3D 预览改用 core.tail 字段，不再按中文名查找'
      ]
    },
    {
      version: '1.5.0', date: '2026-10-15',
      highlights: [
        '结果页改为 7 个标签页分屏：方案对比 / 完整参数 / 三视图 3D / 约束校验 / 器件 BOM / 评分明细 / 命名与导出',
        '每次只显示一块内容并铺满整宽，彻底消除左右空栏与超长滚动',
        '标签带角标（3 套 / 校验结论 / BOM 匹配数），生成方案后自动回到「方案对比」',
        'BOM 面板两列排布、参数表固定列宽、评分多列并排'
      ]
    },
    {
      version: '1.4.0', date: '2026-10-15',
      highlights: [
        '界面改为两段式：第 1 段选机型与锚点，第 2 段换页显示三套推荐方案',
        '结果页三套方案横排对比，3D 三视图移到方案旁，完整参数与 SGP 清单分列',
        '3D 线框重绘：翼型展向放样、机身锥形分段、分组配色（翼青/身蓝/尾绿/桨橙），修正坐标轴',
        '消除中栏大片留白，输入页改两栏并补「怎么给锚点」引导卡'
      ]
    },
    {
      version: '1.3.0', date: '2026-10-15',
      highlights: [
        '约束校验：修正不等式方向显示（满足下限显示 ≥、满足上限显示 ≤），统一接入三级判定',
        '器件匹配修复：螺旋桨按桨径差值排序且超 1 in 归「可替代」、电池按节数硬过滤、电机做电压×KV×桨径联合校验',
        '制造导出增强：翼肋可选定位孔 / 主梁槽、多站位批量打包 ZIP；机身侧视 SVG',
        '器件库扩到 62 件，10 机型 BOM 全部可推荐且电调 / 电池 / 电机自洽',
        '案例库 6 例与 FAQ 12 题写入静态 HTML（无 JS 也可阅读，details 原生折叠）',
        '无方案时制造导出按钮置灰'
      ]
    },
    {
      version: '1.2.0', date: '2026-10-14',
      highlights: ['约束校验三级化（通过 / 警告 / 错误），每项附可执行建议',
        '新增涵道风扇机与小型喷气机两种机型，各自独立经验区间',
        '真实器件库（电机 / 电调 / 桨 / 舵机 / 电池）与 BOM 推荐、JSON/CSV 导出',
        '制造文件导出：翼肋 DXF、机身侧视 SVG',
        '标杆案例库扩充到 6 个（练习机 / 竞速 / 滑翔 / 涵道 / 喷气 / 旋翼）',
        '帮助中心 FAQ 12 题，支持关键词搜索',
        'PWA 离线支持与版本更新提示']
    },
    {
      version: '1.1.0', date: '2026-10-14',
      highlights: ['本地项目管理与历史版本', '分享链接与 .dshproj 导入导出', '术语释义 / 案例库 / 帮助中心',
        '适航重量分级提示', 'SEO 与移动端适配', '引擎推荐值可开关（引擎补全 ↔ 纯输入两种设计模式）']
    },
    {
      version: '1.0.0', date: '2026-10-10',
      highlights: ['数值锚点驱动总体设计引擎', 'NACA 翼型推荐（4/5/6 位）', 'Top3 方案与六维评分',
        '约束校验与公式依赖追溯', 'Excel 导出（19 个工作表）', 'Inventor 建模参数与翼型坐标点表']
    }
  ];

  /* =====================================================================
   * 导出
   * =================================================================== */
  return {
    VERSION: VERSION, SCHEMA: SCHEMA, STORE_KEY: STORE_KEY,
    b64enc: b64enc, b64dec: b64dec, packState: packState, unpackState: unpackState,
    makeProjectFile: makeProjectFile, parseProjectFile: parseProjectFile,
    makeShareUrl: makeShareUrl, readShareHash: readShareHash,
    ProjectStore: ProjectStore, memStorage: memStorage,
    GLOSSARY: GLOSSARY, findTerm: findTerm, annotateTerms: annotateTerms,
    CASES: CASES, FAQ: FAQ,
    WEIGHT_CLASSES: WEIGHT_CLASSES, weightClass: weightClass,
    COMPLIANCE_ITEMS: COMPLIANCE_ITEMS, complianceReport: complianceReport,
    CHANGELOG: CHANGELOG
  };
});
