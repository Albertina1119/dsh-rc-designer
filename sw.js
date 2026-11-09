/*!
 * sw.js —— Service Worker（离线优先 + 版本更新提示）
 *
 * 策略（对应方案 8 的「静态资源缓存优先」）：
 *   · 预缓存：首页 + 4 个脚本 + manifest + robots/sitemap
 *   · 导航请求（HTML）：网络优先，失败回退缓存 → 保证更新能及时拿到，断网仍可打开
 *   · 静态资源（js/css/svg…）：缓存优先，命中即返回，未命中走网络并回填缓存
 *   · 更新：新 SW 装好后进入 waiting，由页面提示用户；收到 SKIP_WAITING 立即接管
 *
 * 说明：方案指定用 vite-plugin-pwa（prompt 模式）；本项目是零构建静态站，
 * 没有 Vite 构建管线，因此用等价的「手写 SW + 页面更新提示」实现同样行为：
 * 更新不自动接管，由用户点「立即刷新」或「稍后」决定。
 */
const VERSION = 'v1.2.0';
const CACHE = 'dsh-rc-' + VERSION;

const PRECACHE = [
  './',
  './index.html',
  './airfoil-lib.js',
  './design-engine.js',
  './xlsx-export.js',
  './app-shell.js',
  './devices-lib.js',
  './cad-export.js',
  './manifest.json',
  './robots.txt',
  './sitemap.xml'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // 逐个 add，单个失败不影响整体安装
      return Promise.all(PRECACHE.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () { return null; });
      }));
    }).then(function () {
      // 不自动接管：等页面提示用户后发 SKIP_WAITING
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE && k.indexOf('dsh-rc-') === 0) return caches.delete(k);
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  // 只处理同源请求
  if (url.origin !== self.location.origin) return;

  const isNavigate = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') >= 0;

  if (isNavigate) {
    // 导航：网络优先，失败回退缓存（断网仍能打开首页）
    e.respondWith(
      fetch(req).then(function (res) {
        const copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy).catch(function () {}); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('./index.html') || caches.match('./');
        });
      })
    );
    return;
  }

  // 静态资源：缓存优先
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy).catch(function () {}); });
        }
        return res;
      }).catch(function () {
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});
