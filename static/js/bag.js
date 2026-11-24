const App = window.App || {};
App.bag = (() => {
  const { $, h } = App.util;

  // ---------- tile bag badge + popover (TILE BAG / DEFINITIONS tabs) ----------
  function renderBagUi(S) {
    const badge = $('bag-badge');
    if (badge) badge.textContent = String(S.bag_count);
    renderDefs(S);
    const pop = $('bag-pop');
    if (!pop || pop.hidden) return;
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
  async function fetchDefinition(word, lang) {
    const key = lang + ':' + word;
    if (defCache[key]) return defCache[key];
    const lower = word.toLowerCase();
    let result = [];
    try {
      if (lang === 'en') {
        const r = await fetch('https://api.dictionaryapi.dev/v2/entries/en/' + encodeURIComponent(lower));
        if (r.ok) {
          const data = await r.json();
          for (const e of data) for (const m of e.meanings || []) for (const d of m.definitions || []) result.push(d.definition);
        }
      } else {
        const r = await fetch(`https://${lang}.wiktionary.org/api/rest_v1/page/definition/` + encodeURIComponent(lower));
        if (r.ok) {
          const data = await r.json();
          for (const entries of Object.values(data)) for (const e of entries) for (const d of e.definitions || []) {
            const text = new DOMParser().parseFromString(d.definition, 'text/html').body.textContent.trim();
            if (text) result.push(text);
          }
        }
      }
    } catch (err) { result = null; }
    if (result) defCache[key] = result.slice(0, 8);
    return result ? result.slice(0, 8) : null;
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
    body.append(chips, box, h('div', { class: 'def-attr', text: 'Powered by ' + (S.language === 'en' ? 'Free Dictionary API' : 'Wiktionary') }));
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
      document.addEventListener('click', (e) => { if (!e.target.closest('#bag-pop, #bag-btn')) toggleBagPop(null, false); });
    }
  }

  return {
    renderBagUi,
    initBag,
  };
})();
window.App = App;
