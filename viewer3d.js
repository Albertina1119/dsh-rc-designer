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
   *    统一单位：米。返回 { parts: [{ name, kind, data }] }
   * =================================================================== */
  function buildGeometry(core, modeling, contour) {
    const c = core || {};
    const pf = c.planform || {};
    const t = c.tail || {};
    const mm = function (v) { return isFinite(v) ? v : null; };
    const m = {};
    (modeling || []).forEach(function (it) { m[it.name] = it.value; });

    const span = num(pf.span, c.span) || 1.2;
    const root = num(pf.root, 0.24);
    const tip = num(pf.tip, root * 0.7);
    const fusL = mm(m['机身总长']) ? m['机身总长'] / 1000 : (num(c.fuselageLength, 0.9));
    const tailSpan = num(c.tailSpanH, span * 0.36);
    const tailChord = num(c.tailChordH, root * 0.6);
    const lh = num(t.lh, fusL * 0.55);
    const finH = mm(m['垂尾高度']) ? m['垂尾高度'] / 1000 : root * 1.6;
    const finRoot = mm(m['垂尾根弦']) ? m['垂尾根弦'] / 1000 : tailChord * 1.1;

    const parts = [];

    // ---- 机翼：按翼型轮廓放样成上下两条轮廓线 + 若干翼肋站位 ----
    const pts = (contour && contour.points) ? contour.points.map(function (p) {
      return [p[0] / (contour.chord || 1), p[1] / (contour.chord || 1)];   // 归一化
    }) : defaultAirfoil();
    const stations = 9;
    const wingLines = [];
    for (let i = 0; i < stations; i++) {
      const f = i / (stations - 1);                      // 0=根 1=尖
      const y = f * span / 2;                             // 半翼展
      const chord = root + (tip - root) * f;
      const zOff = -f * 0;                                // 后掠为 0
      const dih = f * span / 2 * Math.tan((num(c.dihedral, 5) * Math.PI) / 180);
      const loop = [];
      for (let k = 0; k < pts.length; k++) {
        loop.push([pts[k][0] * chord + zOff, y, pts[k][1] * chord + dih]);
      }
      loop.push(loop[0]);
      wingLines.push(loop);
    }
    // 左右两侧
    const wingLeft = wingLines.map(function (loop) {
      return loop.map(function (p) { return [-p[0], -p[1], p[2]]; });
    });
    parts.push({ name: '机翼（右）', kind: 'line', data: wingLines });
    parts.push({ name: '机翼（左）', kind: 'line', data: wingLeft });
    // 前后缘连线
    const leLine = wingLines.map(function (loop) { return loop[0]; });
    const teLine = wingLines.map(function (loop) { return loop[loop.length - 2]; });
    parts.push({ name: '前缘', kind: 'line', data: [leLine, leLine.map(function (p) { return [-p[0], -p[1], p[2]]; })] });
    parts.push({ name: '后缘', kind: 'line', data: [teLine, teLine.map(function (p) { return [-p[0], -p[1], p[2]]; })] });

    // ---- 机身：长方体线框（按机头→机尾分段，带一点收窄）----
    const bodyW = Math.max(0.035, root * 0.24);
    const bodyH = Math.max(0.04, root * 0.30);
    const noseZ = -fusL * 0.42;   // 机头在 -Z
    const tailZ = fusL * 0.58;
    const sect = [
      { z: noseZ, w: bodyW * 0.35, h: bodyH * 0.35 },
      { z: noseZ + fusL * 0.12, w: bodyW, h: bodyH },
      { z: noseZ + fusL * 0.45, w: bodyW, h: bodyH },
      { z: tailZ - fusL * 0.06, w: bodyW * 0.45, h: bodyH * 0.55 },
      { z: tailZ, w: bodyW * 0.3, h: bodyH * 0.4 }
    ];
    const bodyLines = [];
    // 四条纵向棱线
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (q) {
      const line = sect.map(function (s) { return [q[0] * s.w / 2, q[1] * s.h / 2, s.z]; });
      bodyLines.push(line);
    });
    // 截面矩形
    sect.forEach(function (s) {
      const w = s.w / 2, h = s.h / 2;
      bodyLines.push([[-w, -h, s.z], [w, -h, s.z], [w, h, s.z], [-w, h, s.z], [-w, -h, s.z]]);
    });
    parts.push({ name: '机身', kind: 'line', data: bodyLines });

    // ---- 平尾 ----
    const hz = cgZ() + lh;      // 平尾在重心后 lh
    const tailLE = [[0, -tailSpan * 0.5, hz], [0, tailSpan * 0.5, hz]];
    const tailTE = [[-tailChord, -tailSpan * 0.5, hz + tailChord * 0.0], [-tailChord, tailSpan * 0.5, hz + tailChord * 0.0]];
    parts.push({
      name: '平尾', kind: 'line', data: [
        [tailLE[0], tailLE[1], tailTE[1], tailTE[0], tailLE[0]],
        [tailLE[0], tailTE[0]], [tailLE[1], tailTE[1]]
      ]
    });

    // ---- 垂尾 ----
    const finZ = hz;
    parts.push({
      name: '垂尾', kind: 'line', data: [[
        [-finRoot, 0, finZ],
        [-finRoot * 0.45, finH, finZ + finRoot * 0.35],
        [0, finH, finZ + finRoot * 0.35],
        [0, 0, finZ],
        [-finRoot, 0, finZ]
      ]]
    });

    // ---- 旋翼（旋翼机型）----
    if (c.rotary) {
      const rr = c.rotary;
      const n = rr.nrotor || 4;
      const arm = rr.rotorDia * 0.7071;
      const discLines = [];
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n + Math.PI / 4;
        const cx = Math.cos(a) * arm, cy = Math.sin(a) * arm;
        discLines.push(armLine([0, 0, 0], [cx, cy, 0]));
        discLines.push(circle(cx, cy, rr.rotorDia / 2, 0));
      }
      parts.push({ name: '旋翼与机臂', kind: 'line', data: discLines });
      parts.push({ name: '机身', kind: 'line', data: [box(arm * 1.1, arm * 1.1, 0.06)] });
    }

    function cgZ() { return noseZ + fusL * (num(c.cg && c.cg.cgPct, 0.35)); }

    function armLine(a, b) { return [a, b]; }
    function circle(cx, cy, r, z) {
      const out = [];
      for (let i = 0; i <= 36; i++) {
        const a = (Math.PI * 2 * i) / 36;
        out.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
      }
      return out;
    }
    function box(w, d, h) {
      const x = w / 2, z = d / 2, y = h / 2;
      return [[-x, -z, -y], [x, -z, -y], [x, z, -y], [-x, z, -y], [-x, -z, -y]];
    }
    function defaultAirfoil() {
      const out = [];
      for (let i = 0; i <= 20; i++) {
        const x = 0.5 * (1 - Math.cos((Math.PI * i) / 20));
        const yt = 0.6 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
        out.push([x, yt]);
      }
      for (let i = 20; i >= 0; i--) {
        const x = 0.5 * (1 - Math.cos((Math.PI * i) / 20));
        const yt = 0.6 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
        out.push([x, -yt]);
      }
      return out;
    }

    return {
      parts: parts,
      bounds: { span: span, length: fusL, height: Math.max(bodyH, finH) },
      unit: 'm'
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
      if (!geo) { refresh(); return; }
      const mat = new THREE.LineBasicMaterial({ color: 0x7fb6ff, transparent: true, opacity: 0.92 });
      const matAccent = new THREE.LineBasicMaterial({ color: 0x39d98a, transparent: true, opacity: 0.9 });
      geo.parts.forEach(function (part) {
        const m = (part.name.indexOf('机翼') >= 0) ? mat : matAccent;
        (part.data || []).forEach(function (line) {
          if (!line || line.length < 2) return;
          const pts = line.map(function (p) { return new THREE.Vector3(p[0], p[2], p[1]); }); // (x, y_up→z? ) 见下
          const g = new THREE.BufferGeometry().setFromPoints(pts);
          const seg = new THREE.Line(g, m);
          rootGroup.add(seg);
        });
      });
      // 说明：几何数据里约定 [x=前后(机身轴), y=展向, z=上下]，
      // Three.js 用 Y 轴向上，所以映射为 (x_three = z_geo? ) —— 统一到：X 展向、Y 向上、Z 前后
      frameCamera();
      refresh();
      return { lines: rootGroup.children.length };
    }

    function frameCamera() {
      const b = (state.geometry && state.geometry.bounds) || { span: 1.2, length: 1, height: 0.3 };
      const ext = Math.max(b.span, b.length, b.height) * 0.62;
      state.dist = ext * 1.35;
      Object.keys(state.ortho).forEach(function (k) {
        const cam = state.ortho[k];
        setOrthoExtent(cam, ext);
      });
    }

    function setOrthoExtent(cam, ext) {
      const el = renderer.domElement;
      const aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
      const h = ext * 1.15, w = h * aspect;
      cam.left = -w; cam.right = w; cam.top = h; cam.bottom = -h;
      cam.near = -100; cam.far = 100;
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
