// `App` is created by util.js (loaded first); don't redeclare it here.
App.bag = (() => {
  const { $, h } = App.util;

  // ---------- tile bag badge + popover (TILE BAG / DEFINITIONS tabs) ----------
  let lastBagStateSig = null;

  function renderBagUi(S) {
    const badge = $('bag-badge');
    if (badge) badge.textContent = String(S.bag_count);
    renderDefs(S);
    const pop = $('bag-pop');
    if (!pop || pop.hidden) return;

    const bagSig = JSON.stringify([S.bag_count, S.show_distribution, S.tiles, S.letter_values]);
    if (lastBagStateSig === bagSig) return;
    lastBagStateSig = bagSig;

    const t = S.tiles || {};
    const body = $('bag-tab-bag');
    if (!body) return;
    body.replaceChildren();
    if (S.show_distribution === false || t.hidden) {
      body.append(h('p', { class: 'bag-hidden', text: 'The tile distribution is hidden in this game.' }));
    } else {
      const vals = S.letter_values || {};
      const letters = Object.keys(vals).filter((l) => l !== '?').sort((a, b) => a.localeCompare(b));
      if (vals['?'] !== undefined) letters.push('?');
      const grid = h('div', { class: 'bag-grid' });
      for (const l of letters) {
        const n = (t.letters && t.letters[l]) || 0;
        grid.append(h('div', { class: 'bag-tile' + (n ? '' : ' is-empty'), title: `${n} left` },
          h('span', { class: 'bag-letter', text: l === '?' ? '' : l }),
          h('sup', { text: String(vals[l]) }),
          h('span', { class: 'bag-n', text: String(n) })));
      }
      body.append(grid);
    }
    body.append(h('div', { class: 'bag-total' },
      h('span', { text: 'Tiles in bag' }), h('b', { text: String(S.bag_count) }),
      h('small', { text: ` · ${t.total != null ? t.total : S.bag_count} unseen (bag + opponents’ racks)` })));
  }

  // ---------- definitions tab ----------
  const defCache = {};
  let defWord = null;

  // fetch -> { ok: true, data } | { ok: false } (reached the server, no such entry) | { ok: null } (network error)
  async function getJson(url) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) return { ok: false };
      return { ok: true, data: await r.json() };
    } catch (err) { return { ok: null }; }
  }
  const htmlText = (html) => new DOMParser().parseFromString(html, 'text/html').body.textContent.trim();

  // Wiktionary: the REST payload is keyed by the headword's language code; keep only the game's language
  // (an "eta" page also has Spanish, Finnish... entries) and fall back to everything if that key is absent.
  function wiktionaryDefs(data, lang) {
    const groups = data[lang] ? [data[lang]] : Object.values(data);
    const out = [];
    for (const entries of groups) for (const e of entries) for (const d of e.definitions || []) {
      const text = htmlText(d.definition || '');
      if (text) out.push(text);
    }
    return out;
  }

  async function lookupOne(word, lang, state) {
    const sources = lang === 'en'
      ? [
        async () => {
          const res = await getJson('https://api.dictionaryapi.dev/v2/entries/en/' + encodeURIComponent(word));
          if (res.ok !== true) return res.ok === null ? (state.network = true, []) : [];
          const out = [];
          for (const e of res.data) for (const m of e.meanings || []) for (const d of m.definitions || []) out.push(d.definition);
          return out;
        },
        async () => {
          const res = await getJson('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(word));
          if (res.ok !== true) return res.ok === null ? (state.network = true, []) : [];
          return wiktionaryDefs(res.data, 'en');
        },
      ]
      : [async () => {
        const res = await getJson(`https://${lang}.wiktionary.org/api/rest_v1/page/definition/` + encodeURIComponent(word));
        if (res.ok !== true) return res.ok === null ? (state.network = true, []) : [];
        return wiktionaryDefs(res.data, lang);
      }];
    for (const src of sources) {
      const defs = await src();
      if (defs.length) return defs;
    }
    return [];
  }

  // Candidate base forms for plurals / verb forms, tried only when the word itself has no entry.
  function stems(word) {
    const out = [];
    const add = (w) => { if (w.length > 1 && w !== word && !out.includes(w)) out.push(w); };
    if (word.endsWith('ies')) add(word.slice(0, -3) + 'y');
    if (word.endsWith('es')) add(word.slice(0, -2));
    if (word.endsWith('s')) add(word.slice(0, -1));
    if (word.endsWith('ed')) { add(word.slice(0, -2)); add(word.slice(0, -1)); }
    if (word.endsWith('ing')) { add(word.slice(0, -3)); add(word.slice(0, -3) + 'e'); }
    return out;
  }

  async function fetchDefinition(word, lang) {
    const key = lang + ':' + word;
    if (defCache[key]) return defCache[key];
    const lower = word.toLowerCase();
    const state = { network: false };
    let result = await lookupOne(lower, lang, state);
    if (!result.length && lang === 'en') {
      for (const stem of stems(lower)) {
        const base = await lookupOne(stem, lang, state);
        if (base.length) { result = base.slice(0, 4).map((d) => `(form of “${stem}”) ${d}`); break; }
      }
    }
    if (!result.length) {
      // Nothing found: distinguish "no entry" from "could not reach the dictionary"; only cache real answers.
      if (state.network) return null;
      defCache[key] = [];
      return [];
    }
    defCache[key] = result.slice(0, 8);
    return defCache[key];
  }

  function renderDefs(S) {
    const tab = document.querySelector('#bag-pop .bag-tab[data-tab="defs"]');
    const body = $('bag-tab-defs');
    if (!tab || !body) return;
    const locked = !!S.definitions_locked;
    tab.disabled = locked;
    tab.title = locked ? 'Locked in challenge games until you use a challenge' : '';
    tab.textContent = locked ? 'Definitions 🔒' : 'Definitions';
    if (locked && !body.hidden) setBagTab('bag');
    body.replaceChildren();
    if (locked) return;
    const words = S.definition_words || [];
    if (!words.length) { body.append(h('p', { class: 'bag-hidden', text: 'No words have been played yet.' })); return; }
    if (!defWord || !words.includes(defWord)) defWord = words[0];
    const chips = h('div', { class: 'def-chips' });
    for (const w of words.slice(0, 20)) {
      chips.append(h('button', { type: 'button', class: 'def-chip' + (w === defWord ? ' is-active' : ''), text: w, onclick: () => { defWord = w; renderDefs(S); } }));
    }
    const box = h('div', { class: 'def-box' }, h('h3', { class: 'def-title', text: defWord.toLowerCase() }), h('p', { class: 'bag-hidden', text: 'Loading…' }));
    body.append(chips, box, h('div', { class: 'def-attr', text: 'Powered by ' + (S.language === 'en' ? 'Free Dictionary API + Wiktionary' : 'Wiktionary') }));
    const asked = defWord;
    fetchDefinition(asked, S.language).then((defs) => {
      if (asked !== defWord) return;
      box.querySelector('p').remove();
      if (!defs || !defs.length) { box.append(h('p', { class: 'bag-hidden', text: defs === null ? 'Could not reach the dictionary.' : 'No definition found.' })); return; }
      box.append(h('ol', { class: 'def-list' }, ...defs.map((d) => h('li', { text: d }))));
    });
  }

  function setBagTab(name) {
    for (const tab of document.querySelectorAll('#bag-pop .bag-tab')) tab.classList.toggle('is-active', tab.dataset.tab === name);
    const bagTab = $('bag-tab-bag');
    const defsTab = $('bag-tab-defs');
    if (bagTab) bagTab.hidden = name !== 'bag';
    if (defsTab) defsTab.hidden = name !== 'defs';
  }

  let bagOpener = null;
  let bagTrapRemove = null;

  function toggleBagPop(S, force, opener = null) {
    const pop = $('bag-pop');
    if (!pop) return;
    const willShow = force !== undefined ? force : pop.hidden;
    pop.hidden = !willShow;
    if (willShow) {
      if (opener) bagOpener = opener;
      if (S) { setBagTab('bag'); renderBagUi(S); }
      const firstTab = pop.querySelector('.bag-tab');
      if (firstTab && typeof firstTab.focus === 'function') firstTab.focus();
      if (window.App.util && window.App.util.trapFocus) {
        bagTrapRemove = window.App.util.trapFocus(pop, () => toggleBagPop(null, false));
      }
      const onDocKey = (e) => {
        if (e.key === 'Escape') {
          toggleBagPop(null, false);
          document.removeEventListener('keydown', onDocKey);
        }
      };
      document.addEventListener('keydown', onDocKey);
    } else {
      if (bagTrapRemove) {
        bagTrapRemove();
        bagTrapRemove = null;
      }
      if (bagOpener && typeof bagOpener.focus === 'function') {
        try { bagOpener.focus(); } catch (_) {}
        bagOpener = null;
      }
    }
  }

  function initBag(getState) {
    const bagBtn = $('bag-btn');
    if (bagBtn) {
      bagBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pop = $('bag-pop');
        const isHidden = !pop || pop.hidden;
        toggleBagPop(getState(), isHidden, bagBtn);
      });
      for (const tab of document.querySelectorAll('#bag-pop .bag-tab')) {
        tab.addEventListener('click', () => { if (!tab.disabled) setBagTab(tab.dataset.tab); });
      }
      // The definitions tab rebuilds its own DOM when a word chip is clicked, so by the time this runs the
      // clicked element is detached and `closest()` would wrongly say "outside". Use the original event path.
      document.addEventListener('click', (e) => {
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
        if (path.some((n) => n && (n.id === 'bag-pop' || n.id === 'bag-btn'))) return;
        if (!path.length && e.target.closest && e.target.closest('#bag-pop, #bag-btn')) return;
        toggleBagPop(null, false);
      });
    }
  }

  return {
    renderBagUi,
    initBag,
  };
})();
window.App = App;
