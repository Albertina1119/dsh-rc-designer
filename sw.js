/*!
 * sw.js —— Service Worker（离线可用 + 绝不让用户卡在旧版本）
 *
 * 修复的关键问题：早期版本对所有静态资源都用「缓存优先」，
 * 结果升级后会出现「新 HTML + 旧 JS」的混搭，界面上的新功能整块消失，
 * 看起来就像「功能被改没了」。现在改为：
 *
 *   · 导航请求（HTML）      → 网络优先，断网回退缓存
 *   · 代码资源（js/json）    → 网络优先，断网回退缓存  ← 关键修正
 *   · 大体积不变资源（three.min.js、图标）→ 缓存优先（内容不变，省流量）
 *   · 更新                   → 新 SW 装好进 waiting，由页面提示；收到 SKIP_WAITING 才接管
 *
 * 这样在线用户永远拿到最新代码，离线用户仍有完整可用副本。
 */
const VERSION = 'v1.7.0';
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
  './viewer3d.js',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg',
  './robots.txt',
  './sitemap.xml'
];

/* 内容不会变、体积大 → 缓存优先 */
const IMMUTABLE = /vendor\/three\.min\.js|icon-\d+\.svg$/;

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(PRECACHE.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () { return null; });
      }));
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
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** 网络优先：拿得到就用网络，顺手更新缓存；拿不到回退缓存 */
function networkFirst(req) {
  return fetch(req).then(function (res) {
    if (res && res.status === 200 && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy).catch(function () {}); });
    }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (hit) {
      return hit || caches.match('./index.html') || caches.match('./');
    });
  });
}

/** 缓存优先：命中即返回 */
function cacheFirst(req) {
  return caches.match(req).then(function (hit) {
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
  });
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  if (IMMUTABLE.test(url.pathname)) {
    e.respondWith(cacheFirst(req));
    return;
  }
  // HTML / JS / JSON / 其他：网络优先，保证在线用户永远是最新代码
  e.respondWith(networkFirst(req));
});
