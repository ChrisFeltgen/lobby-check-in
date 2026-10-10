// Light/dark theme. Loaded in <head> so the saved theme is applied before the page paints.
(function () {
  var KEY = 'queueTheme';

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function current() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  var initial = saved();
  if (initial) document.documentElement.setAttribute('data-theme', initial);

  // The sun and moon icons are both in each page's HTML; app.css shows the one for the mode a click
  // switches *to*, so the icon is right from the first paint. This script only sets the label.
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;

    function label() {
      var dark = current() === 'dark';
      btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    }

    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* storage unavailable: theme still applies for this page */ }
      label();
    });

    label();
  });
})();
