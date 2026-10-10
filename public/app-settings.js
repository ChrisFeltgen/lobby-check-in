// Loads the public settings from the server (see /api/public-settings) and makes them available as
// window.appSettings and window.appSettingsReady. Applies the logo and organisation name to the page.
// Each page applies the other settings it uses itself. The server holds the defaults.
(function () {
  var BASE = location.pathname.replace(/[^/]*$/, '');

  function apply(s) {
    // The uploaded logo when one is set. With no logo set, the header shows none.
    document.querySelectorAll('img.logo').forEach(function (img) {
      if (s.logoUrl) {
        img.src = BASE + s.logoUrl;
        img.style.visibility = '';
      } else {
        img.parentNode.remove();
      }
    });
    var org = (s.org_name || '').trim();
    document.querySelectorAll('[data-org-name]').forEach(function (node) {
      node.textContent = org;
      node.hidden = !org;
    });
    if (org && document.title.indexOf(org) < 0) document.title = document.title + ' · ' + org;
  }

  // Retries until the server answers: the pages can't work without these settings, so they wait.
  function load() {
    return fetch(BASE + 'api/public-settings', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .catch(function () {
        return new Promise(function (done) { setTimeout(done, 5000); }).then(load);
      });
  }

  window.appSettingsReady = load().then(function (s) {
    window.appSettings = s;
    apply(s);
    return s;
  });

  // Checks the settings every minute. When something has changed, applies it and calls onChange with the new values.
  window.watchAppSettings = function (onChange) {
    var last = JSON.stringify(window.appSettings);
    setInterval(function () {
      fetch(BASE + 'api/public-settings', { cache: 'no-store', credentials: 'same-origin' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (s) {
          if (!s) return;
          var text = JSON.stringify(s);
          if (text === last) return;
          last = text;
          window.appSettings = s;
          apply(s);
          onChange(s);
        })
        .catch(function () { /* try again next minute */ });
    }, 60000);
  };
})();
