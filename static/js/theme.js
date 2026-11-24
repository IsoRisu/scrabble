/* Theme preference: 'auto' (follow the OS), 'light' or 'dark'.
 * Loaded in <head> so the saved choice is applied before first paint.
 * Any <button data-theme-toggle> cycles auto -> dark -> light. */
(() => {
  const KEY = 'scrabble.theme';
  const ORDER = ['auto', 'dark', 'light'];
  const LABEL = { auto: 'Auto (system)', dark: 'Dark', light: 'Light' };
  const root = document.documentElement;

  const read = () => {
    try { const v = window.localStorage.getItem(KEY); return ORDER.includes(v) ? v : 'auto'; } catch (_) { return 'auto'; }
  };
  const write = (v) => { try { window.localStorage.setItem(KEY, v); } catch (_) { /* ignore */ } };

  function apply(pref) {
    if (pref === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', pref);
    const dark = pref === 'dark' || (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#1c1410' : '#ffe1c0');
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.textContent = 'Theme: ' + LABEL[pref];
      btn.setAttribute('aria-label', 'Colour theme: ' + LABEL[pref] + '. Click to change.');
    });
  }

  apply(read());
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (read() === 'auto') apply('auto'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
  }
  document.addEventListener('DOMContentLoaded', () => {
    apply(read());
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = ORDER[(ORDER.indexOf(read()) + 1) % ORDER.length];
        write(next);
        apply(next);
      });
    });
  });
})();
