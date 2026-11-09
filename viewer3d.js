/*!
 * viewer3d.js —— 三视图 / 3D 线框预览（Three.js 正交相机，零后端）
 *
 * 对应《商业化改造基础版实施方案》5.2：
 *   · 顶视 / 侧视 / 前视 三个正交视图 + 一个透视/轴测视图（四视图布局）
 *   · 正交相机（OrthographicCamera）不产生近大远小变形，适合工程制图
 *   · 由翼展、弦长、翼型坐标、机身长度、尾翼参数生成简化线框
 *   · 默认只画线框（LineSegments / EdgesGeometry），不加载纹理
 *   · 鼠标左键拖拽旋转、滚轮缩放、右键/Shift 拖拽平移
 *   · 移动端默认单视图，并提供视图切换按钮
 *
 * 依赖：vendor/three.min.js（已本地化，离线可用）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Viewer3D = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* =====================================================================
   * 1. 纯数据：几何构建（不依赖 Three.js，可在 Node 里测试）
   *
   * 坐标约定（直接采用 Three.js 右手系，避免渲染时再换算）：
   *   X = 展向（右翼 +X，左翼 -X）
   *   Y = 向上（机背 +Y）
   *   Z = 前后（机头 -Z，机尾 +Z）
   * 单位：米。
   * =================================================================== */
  function buildGeometry(core, modeling, contour) {
    const c = core || {};
    const pf = c.planform || {};
    const t = c.tail || {};
    const num = function (v, d) { return isFinite(v) ? v : d; };
    const m = {};
    (modeling || []).forEach(function (it) { m[it.name] = it.value; });

    const span = num(pf.span, num(c.span, 1.2));
    const root = num(pf.root, 0.24);
    const tip = num(pf.tip, root * 0.7);
    const fusL = isFinite(m['机身总长']) ? m['机身总长'] / 1000 : num(c.fuselageLength, 0.9);
    const tailSpan = num(c.tailSpanH, span * 0.36);
    const tailChord = num(c.tailChordH, root * 0.6);
    const finH = isFinite(m['垂尾高度']) ? m['垂尾高度'] / 1000 : root * 1.5;
    const finRoot = isFinite(m['垂尾根弦']) ? m['垂尾根弦'] / 1000 : tailChord * 1.1;
    const dihedral = num(c.dihedral, 0) * Math.PI / 180;
    const sweep = num(c.sweep, 0) * Math.PI / 180;

    const parts = [];
    const WING = 'wing', BODY = 'body', TAIL = 'tail', ROTOR = 'rotor';

    /* ---------- 机翼：翼型放样线框 ---------- */
    const prof = (contour && contour.points && contour.points.length > 8)
      ? contour.points.map(function (p) {
        const k = contour.chord || 1;
        return [p[0] / k, p[1] / k];       // 归一化 (0=前缘, 1=后缘)
      })
      : defaultAirfoil();

    // 机身中心线位置：机翼前缘放在重心附近偏后
    const cgPct = num(c.cg && c.cg.cgPct, 0.35);
    const noseZ = -fusL * 0.45;
    const bodyZ0 = noseZ;
    const bodyZ1 = fusL * 0.55;
    const zLE = noseZ + fusL * (0.30 + cgPct * 0.25);   // 翼根前缘 z
    const yWing = 0.02;                                  // 机翼相对机身中心线的高度

    // 站位（半翼展方向）：少而精，0..5 共 6 个，让线框像「面」而不是「梳子」
    const ST = 6;
    const stations = [];
    for (let i = 0; i < ST; i++) {
      const f = i / (ST - 1);
      const chord = root + (tip - root) * f;
      const x = f * span / 2;
      const y = yWing + Math.tan(dihedral) * x;
      const z = zLE + Math.tan(sweep) * x;
      stations.push({ f: f, chord: chord, x: x, y: y, z: z });
    }

    const wingLines = [];
    // ① 展向连接线：把翼型同一索引的点在不同站位连起来（每 3 点取 1，避免过密）
    const step = Math.max(1, Math.floor(prof.length / 14));
    for (let k = 0; k < prof.length; k += step) {
      const line = stations.map(function (s) {
        return [s.x, s.y + prof[k][1] * s.chord, s.z + prof[k][0] * s.chord];
      });
      wingLines.push(line);
    }
    // ② 翼根与翼尖的翼型轮廓（闭合），让截面形状可读
    [stations[0], stations[stations.length - 1]].forEach(function (s) {
      const loop = prof.map(function (p) {
        return [s.x, s.y + p[1] * s.chord, s.z + p[0] * s.chord];
      });
      loop.push(loop[0]);
      wingLines.push(loop);
    });
    // ③ 前缘 / 后缘线
    wingLines.push(stations.map(function (s) { return [s.x, s.y, s.z]; }));
    wingLines.push(stations.map(function (s) { return [s.x, s.y, s.z + s.chord]; }));

    parts.push({ name: '机翼（右）', kind: 'line', group: WING, data: wingLines });
    // 左翼镜像（X 取反）
    parts.push({
      name: '机翼（左）', kind: 'line', group: WING,
      data: wingLines.map(function (line) {
        return line.map(function (p) { return [-p[0], p[1], p[2]]; });
      })
    });

    /* ---------- 机身：锥形分段长方体 ---------- */
    const bodyW = Math.max(0.030, root * 0.20);
    const bodyH = Math.max(0.036, root * 0.26);
    const sect = [
      { z: bodyZ0, w: bodyW * 0.30, h: bodyH * 0.30 },              // 机头
      { z: bodyZ0 + fusL * 0.10, w: bodyW * 0.85, h: bodyH * 0.80 },
      { z: bodyZ0 + fusL * 0.30, w: bodyW, h: bodyH },              // 最宽（电机/电池舱）
      { z: zLE, w: bodyW * 0.98, h: bodyH * 0.98 },                 // 机翼安装处
      { z: bodyZ1 - fusL * 0.14, w: bodyW * 0.55, h: bodyH * 0.62 },
      { z: bodyZ1, w: bodyW * 0.28, h: bodyH * 0.34 }               // 尾端
    ];
    const bodyLines = [];
    // 纵向 4 条棱线 + 顶/底中线（让机身有体积感）
    [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 1], [0, -1]].forEach(function (q) {
      bodyLines.push(sect.map(function (s) {
        return [q[0] * s.w / 2, q[1] * s.h / 2, s.z];
      }));
    });
    // 截面矩形（只画 4 个关键截面，避免线太多）
    [0, 2, 3, 5].forEach(function (si) {
      const s = sect[si], w = s.w / 2, h = s.h / 2;
      bodyLines.push([[-w, -h, s.z], [w, -h, s.z], [w, h, s.z], [-w, h, s.z], [-w, -h, s.z]]);
    });
    parts.push({ name: '机身', kind: 'line', group: BODY, data: bodyLines });

    /* ---------- 平尾 ---------- */
    const hz = zLE + root * 0.35 + num(t.lh, fusL * 0.55) * 0.92;
    const tz = Math.min(hz, bodyZ1 - tailChord * 0.35);
    const tailLines = [];
    const tailRoot = [0, yWing * 0.6, tz];
    const tailTipL = [-tailSpan / 2, yWing * 0.6, tz + tailChord * 0.06];
    const tailTipR = [tailSpan / 2, yWing * 0.6, tz + tailChord * 0.06];
    const tailTER = [tailSpan / 2, yWing * 0.6, tz + tailChord];
    const tailTEL = [-tailSpan / 2, yWing * 0.6, tz + tailChord];
    tailLines.push([tailTipL, tailRoot, tailTipR, tailTER, tailTEL, tailTipL]);
    tailLines.push([[0, yWing * 0.6, tz], [0, yWing * 0.6, tz + tailChord]]);
    parts.push({ name: '平尾', kind: 'line', group: TAIL, data: tailLines });

    /* ---------- 垂尾 ---------- */
    const finZ = tz;
    parts.push({
      name: '垂尾', kind: 'line', group: TAIL, data: [[
        [0, bodyH * 0.4, finZ],
        [0, bodyH * 0.4 + finH, finZ + finRoot * 0.45],
        [0, bodyH * 0.4 + finH, finZ + finRoot * 0.95],
        [0, bodyH * 0.4, finZ + finRoot],
        [0, bodyH * 0.4, finZ]
      ]]
    });

    /* ---------- 旋翼（旋翼机型）---------- */
    if (c.rotary) {
      const rr = c.rotary;
      const n = rr.nrotor || 4;
      const arm = Math.max(0.06, rr.rotorDia * 0.68);
      const rotorLines = [];
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n + Math.PI / 4;
        const cx = Math.cos(a) * arm, cz = Math.sin(a) * arm;
        rotorLines.push([[0, 0, 0], [cx, 0, cz]]);
        rotorLines.push(circle3(cx, 0, cz, Math.max(0.03, rr.rotorDia / 2), 28));
        rotorLines.push([[cx, 0, cz], [cx, 0.012, cz]]);
      }
      parts.push({ name: '旋翼与机臂', kind: 'line', group: ROTOR, data: rotorLines });
      parts.push({ name: '机身', kind: 'line', group: BODY, data: [box3(arm * 1.15, 0.05, arm * 1.15)] });
    }

    function circle3(cx, cy, cz, r, nSeg) {
      const out = [];
      for (let i = 0; i <= nSeg; i++) {
        const a = (Math.PI * 2 * i) / nSeg;
        out.push([cx + r * Math.cos(a), cy, cz + r * Math.sin(a)]);
      }
      return out;
    }
    function box3(w, h, d) {
      const x = w / 2, y = h / 2, z = d / 2;
      return [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], [-x, -y, -z]];
    }
    function defaultAirfoil() {
      const out = [];
      const N = 24;
      const yt = function (x) {
        return 0.6 * (0.2969 * Math.sqrt(Math.max(0, x)) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
      };
      for (let i = 0; i <= N; i++) {
        const x = 0.5 * (1 - Math.cos((Math.PI * i) / N));
        out.push([x, yt(x)]);
      }
      for (let i = N; i >= 1; i--) {
        const x = 0.5 * (1 - Math.cos((Math.PI * i) / N));
        out.push([x, -yt(x)]);
      }
      return out;
    }

    return {
      parts: parts,
      bounds: {
        span: span,
        length: fusL,
        height: Math.max(bodyH, finH) + Math.abs(yWing),
        x: span / 2, yTop: Math.max(bodyH / 2, finH), zFront: noseZ, zBack: bodyZ1
      },
      unit: 'm',
      convention: { X: '展向', Y: '向上', Z: '前后(机头 -Z)' }
    };
  }

  function num(v, d) { return isFinite(v) ? v : d; }

  /* =====================================================================
   * 2. 渲染器（需要浏览器 + Three.js）
   * =================================================================== */
  const VIEWS = [
    { key: 'top', name: '顶视', pos: [0, 1, 0], up: [0, 0, -1] },
    { key: 'side', name: '侧视', pos: [1, 0, 0], up: [0, 1, 0] },
    { key: 'front', name: '前视', pos: [0, 0, -1], up: [0, 1, 0] },
    { key: 'iso', name: '轴测', pos: [0.9, 0.7, 0.9], up: [0, 1, 0] }
  ];

  function createViewer(container, opts) {
    const THREE = (typeof window !== 'undefined' && (window.THREE || window.three));
    if (!THREE) return { ok: false, error: 'Three.js 未加载' };
    if (!container) return { ok: false, error: '缺少容器' };
    const o = opts || {};

    const state = {
      layout: o.layout === 'single' ? 'single' : 'quad',
      active: o.active || 'iso',
      geometry: null, parts: [],
      objects: [], scene: null, renderer: null,
      ortho: {}, rot: { x: 0.6, y: 0.8 }, dist: 2.2, target: { x: 0, y: 0, z: 0 },
      dispose: dispose, setGeometry: setGeometry, setLayout: setLayout, setActive: setActive, refresh: refresh
    };

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1526);
    state.scene = scene;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setScissorTest(true);
    container.innerHTML = '';
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.cursor = 'grab';
    state.renderer = renderer;

    // 灯光（线框为主，加一点环境光让轴向辅助更清楚）
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));

    // 轴向参考（不喧宾夺主）
    const axes = new THREE.AxesHelper(0.6);
    axes.material.opacity = 0.35;
    axes.material.transparent = true;
    scene.add(axes);

    const rootGroup = new THREE.Group();
    scene.add(rootGroup);

    function clearParts() {
      while (rootGroup.children.length) {
        const c = rootGroup.children.pop();
        rootGroup.remove(c);
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      }
      state.parts = [];
    }

    function setGeometry(geo) {
      clearParts();
      state.geometry = geo;
      if (!geo) { refresh(); return { lines: 0 }; }
      // 分组配色：机翼青、机身蓝、尾翼绿、旋翼橙
      const COLORS = {
        wing: 0x4cc9f0, body: 0x8fb3e0, tail: 0x39d98a, rotor: 0xffb020
      };
      const mats = {};
      Object.keys(COLORS).forEach(function (k) {
        mats[k] = new THREE.LineBasicMaterial({
          color: COLORS[k], transparent: true, opacity: k === 'wing' ? 0.9 : 0.78
        });
      });
      geo.parts.forEach(function (part) {
        const mat = mats[part.group] || mats.body;
        (part.data || []).forEach(function (line) {
          if (!line || line.length < 2) return;
          // 几何已按 Three.js 右手系构建（X 展向 / Y 向上 / Z 前后），无需换算
          const pts = line.map(function (p) { return new THREE.Vector3(p[0], p[1], p[2]); });
          const g = new THREE.BufferGeometry().setFromPoints(pts);
          rootGroup.add(new THREE.Line(g, mat));
        });
      });
      frameCamera();
      refresh();
      return { lines: rootGroup.children.length };
    }

    function frameCamera() {
      const b = (state.geometry && state.geometry.bounds) || { span: 1.2, length: 1, height: 0.3 };
      // 依据三轴尺寸确定取景尺度，让模型占画面 60~70%，避免过小或溢出
      const span = b.span || 1.2, len = b.length || 1, hgt = b.height || 0.3;
      state.dist = Math.max(span, len) * 0.62 + hgt * 0.4;
      state.center = { x: 0, y: b.yTop ? Math.min(0.04, hgt * 0.2) : 0, z: ((b.zFront || -0.5) + (b.zBack || 0.5)) / 2 };
      rootGroup.position.set(0, 0, 0);
      Object.keys(state.ortho).forEach(function (k) {
        setOrthoExtent(state.ortho[k], state.dist);
      });
    }

    function setOrthoExtent(cam, ext) {
      const el = renderer.domElement;
      const aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
      const h = ext * 0.62, w = h * aspect;
      cam.left = -w; cam.right = w; cam.top = h; cam.bottom = -h;
      cam.near = -50; cam.far = 50;
      cam.updateProjectionMatrix();
    }

    // 建立 4 个正交相机
    VIEWS.forEach(function (v) {
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
      setOrthoExtent(cam, 0.8);
      state.ortho[v.key] = cam;
    });

    function camPos(key) {
      const v = VIEWS.filter(function (x) { return x.key === key; })[0] || VIEWS[3];
      const d = state.dist;
      if (v.key === 'iso') {
        return new THREE.Vector3(
          Math.sin(state.rot.y) * Math.cos(state.rot.x) * d,
          Math.sin(state.rot.x) * d,
          Math.cos(state.rot.y) * Math.cos(state.rot.x) * d
        );
      }
      return new THREE.Vector3(v.pos[0] * d, v.pos[1] * d, v.pos[2] * d);
    }

    function renderView(key, vp) {
      const cam = state.ortho[key];
      const p = camPos(key);
      cam.position.copy(p);
      const v = VIEWS.filter(function (x) { return x.key === key; })[0] || VIEWS[3];
      cam.up.set(v.up[0], v.up[1], v.up[2]);
      if (key === 'top') cam.up.set(0, 0, -1);
      cam.lookAt(0, 0, 0);
      renderer.setViewport(vp.x, vp.y, vp.w, vp.h);
      renderer.setScissor(vp.x, vp.y, vp.w, vp.h);
      setOrthoExtent(cam, Math.max(0.6, state.dist * 0.62));
      renderer.render(scene, cam);
    }

    function refresh() {
      const el = renderer.domElement;
      const cw = container.clientWidth || 600;
      const ch = Math.max(240, container.clientHeight || 360);
      renderer.setSize(cw, ch, false);
      const W = cw, H = ch;
      if (state.layout === 'single') {
        renderView(state.active, { x: 0, y: 0, w: W, h: H });
      } else {
        const hw = W / 2, hh = H / 2;
        renderView('top', { x: 0, y: hh, w: hw, h: hh });
        renderView('side', { x: hw, y: hh, w: hw, h: hh });
        renderView('front', { x: 0, y: 0, w: hw, h: hh });
        renderView('iso', { x: hw, y: 0, w: hw, h: hh });
      }
    }

    function setLayout(l) { state.layout = l === 'single' ? 'single' : 'quad'; refresh(); }
    function setActive(k) { state.active = k; state.layout = 'single'; refresh(); }
    function dispose() {
      clearParts();
      try { renderer.dispose(); } catch (e) {}
      container.innerHTML = '';
    }

    /* ---- 交互：旋转 / 缩放 / 平移 ---- */
    let dragging = null, last = null;
    const el = renderer.domElement;
    el.addEventListener('mousedown', function (e) {
      dragging = (e.button === 2 || e.shiftKey) ? 'pan' : 'rot';
      last = { x: e.clientX, y: e.clientY };
      el.style.cursor = 'grabbing';
      e.preventDefault();
    });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('mouseup', function () { dragging = null; last = null; el.style.cursor = 'grab'; });
    window.addEventListener('mousemove', function (e) {
      if (!dragging || !last) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      if (dragging === 'rot') {
        state.rot.y += dx * 0.008;
        state.rot.x = Math.max(-1.45, Math.min(1.45, state.rot.x + dy * 0.008));
      } else {
        state.target.x -= dx * state.dist * 0.0022;
        state.target.y += dy * state.dist * 0.0022;
        rootGroup.position.set(state.target.x, state.target.y, 0);
      }
      refresh();
    });
    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      state.dist = Math.max(0.2, Math.min(20, state.dist * (1 + (e.deltaY > 0 ? 0.12 : -0.12))));
      refresh();
    }, { passive: false });
    // 触摸
    let touch = null;
    el.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) touch = { mode: 'rot', x: e.touches[0].clientX, y: e.touches[0].clientY };
      else if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        touch = { mode: 'pinch', d: d };
      }
    }, { passive: true });
    el.addEventListener('touchmove', function (e) {
      if (!touch) return;
      if (touch.mode === 'rot' && e.touches.length === 1) {
        const dx = e.touches[0].clientX - touch.x, dy = e.touches[0].clientY - touch.y;
        touch.x = e.touches[0].clientX; touch.y = e.touches[0].clientY;
        state.rot.y += dx * 0.01;
        state.rot.x = Math.max(-1.45, Math.min(1.45, state.rot.x + dy * 0.01));
        refresh();
      } else if (touch.mode === 'pinch' && e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        state.dist = Math.max(0.2, Math.min(20, state.dist * (touch.d / Math.max(1, d))));
        touch.d = d;
        refresh();
      }
      e.preventDefault();
    }, { passive: false });
    el.addEventListener('touchend', function () { touch = null; }, { passive: true });

    window.addEventListener('resize', function () { refresh(); });

    return Object.assign({ ok: true }, state);
  }

  return {
    VIEWS: VIEWS, buildGeometry: buildGeometry, createViewer: createViewer
  };
});
