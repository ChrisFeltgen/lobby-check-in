'use strict';

// Keeps the screens openable when the server cannot be reached.
//
// Stopping the app (or the host losing it) can leave the web server with nothing at the address, so it answers
// every page with its own "404 Not Found". A page already open carries on and says the connection is lost, but a
// kiosk that is restarted, or a page that is reloaded, during that time would otherwise land on the 404 and stay
// there, even after the server is back.
//
// So this keeps a copy of the pages and their scripts and styles, and uses it only when the server cannot supply
// them. The server is always asked first, so a new version is picked up as soon as it is uploaded. Nothing from
// /api/ or the live connection is ever kept: the page still has to ask the server for its data, and says so when
// it cannot get it.

var CACHE = 'lobby-pages-v1';
var SCOPE = self.registration.scope; // for example https://example.org/virtual-queue/
var SCOPE_PATH = new URL(SCOPE).pathname;
var PRECACHE = ['index.html', 'queue.html', 'kiosk.html', 'monitor.html', 'app.css', 'theme.js', 'app-settings.js', 'access.js', 'icons.js', 'socket.io/socket.io.js'];

// The address inside this folder, or null for anything that is not ours.
function relativeTo(url) {
  if (url.origin !== self.location.origin || url.pathname.indexOf(SCOPE_PATH) !== 0) return null;
  return url.pathname.slice(SCOPE_PATH.length);
}

// What is kept: the pages and their scripts and styles. The folder itself opens index.html.
function cacheable(relative) {
  if (relative === null) return false;
  if (relative === '' || relative === 'socket.io/socket.io.js') return true;
  if (relative === 'sw.js' || relative.indexOf('api/') === 0 || relative.indexOf('socket.io/') === 0) return false;
  return /\.(html|js|css)$/.test(relative);
}

function keyFor(relative) {
  return new Request(SCOPE + (relative || 'index.html'));
}

function saved(relative) {
  return caches.open(CACHE).then(function (cache) { return cache.match(keyFor(relative)); });
}

function networkFirst(request, relative) {
  return fetch(request).then(function (response) {
    // Redirects are for the browser to follow.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) return response;
    if (response.ok) {
      var copy = response.clone();
      caches.open(CACHE).then(function (cache) { return cache.put(keyFor(relative), copy); });
      return response;
    }
    // An error page from the web server, such as 404 while the app is stopped: use the saved copy if there is one.
    return saved(relative).then(function (hit) { return hit || response; });
  }, function () {
    // The server could not be reached at all.
    return saved(relative).then(function (hit) { return hit || Response.error(); });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(PRECACHE.map(function (relative) {
        return fetch(new Request(SCOPE + relative, { cache: 'reload' })).then(function (response) {
          if (response.ok) return cache.put(keyFor(relative), response);
        }).catch(function () { /* kept next time it is fetched */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (name) { return name !== CACHE; }).map(function (name) { return caches.delete(name); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var relative = relativeTo(new URL(request.url));
  if (!cacheable(relative)) return;
  event.respondWith(networkFirst(request, relative));
});
