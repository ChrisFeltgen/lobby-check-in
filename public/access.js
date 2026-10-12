// Shared by the kiosk and the monitor. With "Restrict access to signed-in users, or to screens opened with an access link" on (Management,
// Security), a screen opens only for someone who is signed in, or for a browser that has been opened with an access link.
// The server enforces that on every route the screens use, so what this script does is the part people see:
//
//  1. An access link ends in #key=... . The key is handed to the server, which gives the browser a cookie, and the
//     address is cleaned so the key is not left in the history. If the server cannot be reached yet (a screen that starts
//     before its network does), the key is kept in the address and handed over as soon as the server answers.
//  2. The screen asks whether it may open. If not, a lock screen covers the page and it asks again every few seconds.
//  3. If the server later refuses what the screen asks for (the link was revoked, or the setting was turned on), the lock
//     screen comes up, and the page reloads by itself once it is allowed again.
//
// window.screenAccessReady resolves when the page may start. It also resolves when the server cannot be reached, so the
// page's own "connection lost" handling takes over. window.screenAccess.locked says whether the lock screen is up.
// The page is loaded with data-screen="kiosk" or data-screen="monitor", which says which kind of link opens it.
(function () {
  var script = document.currentScript;
  var SCREEN = script && script.getAttribute('data-screen') === 'monitor' ? 'monitor' : 'kiosk';
  var BASE = location.pathname.replace(/[^/]*$/, '');
  var originalFetch = window.fetch.bind(window);
  var locked = false;
  var started = false;     // set once the page has been allowed to start
  var reason = '';         // 'invalid' when the link in the address was refused

  window.screenAccess = {};
  Object.defineProperty(window.screenAccess, 'locked', { get: function () { return locked; } });

  // ---- 1. The key in the address ----

  // The key is written after a # (kiosk.html#key=...), which a browser never sends to the web server, so it cannot turn up
  // in the host's logs or in a referrer. A key after a ? is accepted too, in case a link was typed that way.
  function keyInAddress() {
    return new URLSearchParams(location.hash.replace(/^#/, '')).get('key') || new URLSearchParams(location.search).get('key');
  }

  function cleanAddress() {
    var query = new URLSearchParams(location.search);
    query.delete('key');
    var hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    hash.delete('key');
    var q = query.toString();
    var h = hash.toString();
    try {
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + (h ? '#' + h : ''));
    } catch (e) { /* the address stays as it is */ }
  }

  // Resolves once the server has answered about the key, whether or not it was accepted.
  function redeemKey() {
    var key = keyInAddress();
    if (!key) return Promise.resolve();
    return new Promise(function (done) {
      function attempt() {
        originalFetch(BASE + 'api/access/redeem', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ key: key })
        }).then(function (res) {
          if (res.status === 429) { setTimeout(attempt, 15000); return; }   // too many tries: wait, then try again
          if (!res.ok) reason = 'invalid';
          cleanAddress();
          done();
        }, function () {
          setTimeout(attempt, 3000);   // the server cannot be reached yet: keep the key and try again
        });
      }
      attempt();
    });
  }

  // ---- 2. May this screen open? ----

  // { restricted, allowed, linkScope }, or null when the server cannot be asked.
  function check() {
    return originalFetch(BASE + 'api/access/status?screen=' + SCREEN, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : null; }, function () { return null; });
  }

  function mayOpen(status) {
    return !status || !status.restricted || status.allowed;
  }

  window.screenAccessReady = redeemKey().then(function () {
    return new Promise(function (resolve) {
      function step() {
        check().then(function (status) {
          if (mayOpen(status)) {
            started = true;
            hideLock();
            resolve();
            return;
          }
          showLock(status);
          setTimeout(step, 5000);
        });
      }
      step();
    });
  });

  // ---- 3. Refused while it is running ----

  window.fetch = function () {
    return originalFetch.apply(window, arguments).then(function (res) {
      if (res.status === 401 && started && !locked) {
        res.clone().json().then(function (body) {
          if (body && body.code === 'ACCESS_LOCKED') lock();
        }, function () { /* not the answer that means locked */ });
      }
      return res;
    });
  };

  // A page whose live connection is refused calls this, so it finds out at once that it has been locked (its link was
  // revoked, say) and does not wait for its next regular check.
  window.screenAccess.refused = function () {
    if (!started || locked) return;
    check().then(function (status) { if (status && !mayOpen(status)) lock(status); });
  };

  function lock(status) {
    if (locked) return;
    showLock(status || null);
    (function watch() {
      setTimeout(function () {
        check().then(function (status) {
          if (status && mayOpen(status)) { location.reload(); return; }
          if (status) showLock(status);
          watch();
        });
      }, 5000);
    })();
  }

  // ---- The lock screen ----

  var TEXT = {
    kiosk: {
      en: ['Kiosk unavailable', 'Please see a staff member for help.'],
      es: ['Quiosco no disponible', 'Por favor, pida ayuda al personal.']
    },
    monitor: {
      en: ['This display is not available right now.', ''],
      es: ['Esta pantalla no está disponible en este momento.', '']
    }
  };

  var STYLE = '' +
    '#screen-lock{position:fixed;top:0;right:0;bottom:0;left:0;z-index:3000;display:flex;align-items:center;justify-content:center;padding:32px;box-sizing:border-box;text-align:center;overflow:auto;background:#0d1b2a;color:#f1f5f9;font-family:system-ui,"Segoe UI",Roboto,sans-serif}' +
    '#screen-lock .sl-card{max-width:820px;width:100%;display:flex;flex-direction:column;align-items:center;gap:12px}' +
    '#screen-lock .sl-icon{width:96px;height:96px;border-radius:50%;background:rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center}' +
    '#screen-lock .sl-icon svg{width:52px;height:52px}' +
    '#screen-lock h2{margin:8px 0 0;font-size:clamp(32px,5.6vmin,56px);font-weight:700;line-height:1.15}' +
    '#screen-lock p{margin:0;font-size:clamp(22px,3.2vmin,32px);line-height:1.35}' +
    '#screen-lock .sl-lang{width:100%;display:flex;flex-direction:column;align-items:center;gap:8px}' +
    '#screen-lock .sl-lang+.sl-lang{margin-top:14px;padding-top:18px;border-top:1px solid rgba(255,255,255,.18)}' +
    '#screen-lock .sl-staff{margin-top:26px;padding-top:18px;border-top:1px solid rgba(255,255,255,.18);width:100%;font-size:18px;line-height:1.4;color:#b6c2d1}' +
    '#screen-lock .sl-staff a{display:inline-block;margin-top:12px;padding:11px 22px;border-radius:10px;background:#1f6feb;color:#fff;text-decoration:none;font-weight:600;font-size:18px}';

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Where signing in brings the person back to: this same screen, without the key.
  function returnAddress() {
    var params = new URLSearchParams(location.search);
    params.delete('key');
    var query = params.toString();
    var page = location.pathname.replace(/^.*\//, '') || (SCREEN + '.html');
    return page + (query ? '?' + query : '');
  }

  // A line for staff, saying what is wrong when it is the link and not just that the screen is locked.
  function staffNote(status) {
    if (reason === 'invalid') return 'This access link is not valid any more. Ask an administrator for a new one.';
    if (status && status.linkScope && status.linkScope !== SCREEN) {
      return 'This browser was opened with a ' + status.linkScope + ' link, which does not open the ' + SCREEN + '. Use the ' + SCREEN + ' link.';
    }
    return 'Staff: sign in to unlock this screen, or open it with its access link.';
  }

  function showLock(status) {
    locked = true;
    var box = document.getElementById('screen-lock');
    if (!box) {
      if (!document.getElementById('screen-lock-style')) {
        var style = element('style');
        style.id = 'screen-lock-style';
        style.textContent = STYLE;
        document.head.appendChild(style);
      }
      box = element('div');
      box.id = 'screen-lock';
      box.setAttribute('role', 'alert');
      var card = element('div', 'sl-card');
      var icon = element('div', 'sl-icon');
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
      card.appendChild(icon);
      ['en', 'es'].forEach(function (code) {
        var lines = TEXT[SCREEN][code];
        var block = element('div', 'sl-lang');
        block.lang = code;
        block.appendChild(element('h2', null, lines[0]));
        if (lines[1]) block.appendChild(element('p', null, lines[1]));
        card.appendChild(block);
      });
      var staff = element('div', 'sl-staff');
      staff.appendChild(element('span', 'sl-note'));
      staff.appendChild(element('br'));
      var link = element('a', null, 'Staff sign in');
      link.href = BASE + 'index.html?next=' + encodeURIComponent(returnAddress());
      staff.appendChild(link);
      card.appendChild(staff);
      box.appendChild(card);
      document.body.appendChild(box);
    }
    box.querySelector('.sl-note').textContent = staffNote(status);
  }

  function hideLock() {
    locked = false;
    var box = document.getElementById('screen-lock');
    if (box) box.remove();
  }
})();
