const App = window.App || {};
App.util = (() => {
  const $ = (id) => document.getElementById(id);

  /** Create an element: h('div', {class: 'x', onclick: fn}, child, 'text', ...) */
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [key, val] of Object.entries(props)) {
      if (val === null || val === undefined || val === false) continue;
      if (key === 'class') el.className = val;
      else if (key === 'text') el.textContent = val;
      else if (key === 'dataset') Object.assign(el.dataset, val);
      else if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2), val);
      else el.setAttribute(key, val === true ? '' : val);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid);
    }
    return el;
  }

  // localStorage can throw (private mode, blocked storage); never let it break the game.
  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch (_) { return null; } },
    set(key, val) { try { window.localStorage.setItem(key, val); } catch (_) { /* ignore */ } },
    del(key) { try { window.localStorage.removeItem(key); } catch (_) { /* ignore */ } },
  };

  const timerText = (config, key) => {
    const secs = config && config.timers ? config.timers[key] : 0;
    if (!secs) return 'No timer';
    return secs < 120 ? `${secs} seconds per turn` : `${secs / 60} minutes per turn`;
  };

  const LENGTH_LABEL = { short: 'Short', medium: 'Medium', full: 'Full' };
  const lengthText = (key) => LENGTH_LABEL[key] || key;

  return {
    $,
    h,
    store,
    timerText,
    lengthText,
  };
})();
window.App = App;
