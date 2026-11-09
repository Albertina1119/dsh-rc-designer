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

  const VERSION = '1.1.0';
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
      id: 'trainer-basic', name: '入门练习机 · 1.2 m 翼展', typeId: 'trainer',
      tag: '最适合第一架', anchors: { wl: 45, twr: 0.65, vmax: 20, span: 1.2 },
      why: '翼载取 45 g/dm² 让失速速度落在 7 m/s 附近，手抛起飞容错大；推重比 0.65 既能爬升又不会因为动力过猛而难控。翼展 1.2 m 是携带与制作成本的平衡点。',
      points: ['翼型自动推荐会落在 NACA 2412 / 23012 一类，失速和缓', '静稳定裕度建议 14% MAC 左右，首飞先按此设重心', '材料选轻木 + 泡沫，损毁后易修复']
    },
    {
      id: 'fpv-longrange', name: 'FPV 长航时 · 载重平台', typeId: 'cargo',
      tag: '挂载与续航优先', anchors: { wl: 60, twr: 0.7, vmax: 22, payload: 0.6, endurance: 25 },
      why: '带 600 g 载荷时翼载会明显上升，所以先用翼载锚点把机翼面积定下来，再由引擎反推翼展与展弦比。推重比 0.7 保证挂载后仍能爬升。',
      points: ['翼型倾向厚一些（2415 / 4415），内部空间给电池与设备', '注意碳管主梁直径会随翼根弯矩上升', '续航估算按可用电量 80%，实际留 20% 余量返航']
    },
    {
      id: 'heli-450', name: '450 级直升机', typeId: 'heli',
      tag: '旋翼机型示例', anchors: { mass: 1.1, disk: 120, nrotor: 1, twr: 1.8, style: 3 },
      why: '直升机用桨盘载荷而非翼载作为主约束：桨盘载荷 120 N/m² 对应约 0.7 m 主旋翼直径，属于 450 级常规配置。',
      points: ['旋翼机型不计算机翼与尾翼参数，改为旋翼几何与轴距', '推重比 1.8 是直升机悬停+机动的常见取值', '合规提示里 1.1 kg 属于微型无人机区间']
    },
    {
      id: 'racer-quad', name: '5 寸竞速四轴', typeId: 'multirotor',
      tag: '多旋翼示例', anchors: { mass: 0.65, disk: 200, nrotor: 4, twr: 4, style: 5 },
      why: '桨盘载荷 200 N/m² 对应 5 寸桨（127 mm），是竞速机标准配置；推重比 4 才能支撑急加速与翻滚。',
      points: ['风格拉到 5（激进），引擎会加大推重比与舵面行程', '碳纤维机架 + 铝柱，抗摔优先', '电池容量别贪大，否则重量抵消续航收益']
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
   * 7. Changelog
   * =================================================================== */
  const CHANGELOG = [
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
    CASES: CASES,
    WEIGHT_CLASSES: WEIGHT_CLASSES, weightClass: weightClass,
    COMPLIANCE_ITEMS: COMPLIANCE_ITEMS, complianceReport: complianceReport,
    CHANGELOG: CHANGELOG
  };
});
