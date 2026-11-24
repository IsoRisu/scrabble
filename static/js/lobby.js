/* Scrabble lobby (index page) client script. */
(() => {
  'use strict';

  const { $, store } = window.App.util;

  const LAST_KEY = 'scrabble.last';
  const SESSION_KEY = (room) => `scrabble.session.${room}`;

  function loadSession(room) {
    try {
      const parsed = JSON.parse(store.get(SESSION_KEY(room)) || 'null');
      return parsed && typeof parsed.token === 'string' ? parsed : null;
    } catch (_) { return null; }
  }

  function clearSession(room) {
    store.del(SESSION_KEY(room));
    try {
      const last = JSON.parse(store.get(LAST_KEY) || 'null');
      if (last && last.room === room) store.del(LAST_KEY);
    } catch (_) { store.del(LAST_KEY); }
  }

  function initIndex() {
    const createBtn = $('create-btn');
    const createError = $('create-error');
    const createForm = $('create-form');

    const handleCreate = async (event) => {
      if (event) event.preventDefault();
      createBtn.disabled = true;
      createError.hidden = true;
      const mode = $('create-mode') ? $('create-mode').value : 'wild';
      const length = $('create-length') ? $('create-length').value : 'medium';
      const timer = $('create-timer') ? $('create-timer').value : 'off';
      const language = $('create-language') ? $('create-language').value : 'en';
      const auto_check = $('create-autocheck') ? $('create-autocheck').checked : true;
      const show_distribution = $('create-showdist') ? $('create-showdist').checked : true;
      try {
        const res = await fetch('/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, length, timer, language, auto_check, show_distribution }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not create a game.');
        window.location.href = data.path;
      } catch (err) {
        createError.textContent = err.message || 'Could not create a game.';
        createError.hidden = false;
        createBtn.disabled = false;
      }
    };

    if (createForm) {
      createForm.addEventListener('submit', handleCreate);
    } else {
      createBtn.addEventListener('click', handleCreate);
    }

    $('join-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const raw = $('join-code').value.trim();
      const fromLink = raw.match(/\/join\/([A-Za-z0-9]+)/);
      const code = (fromLink ? fromLink[1] : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const error = $('join-error');
      if (code.length !== 8) {
        error.textContent = 'Room codes are 8 characters long.';
        error.hidden = false;
        return;
      }
      window.location.href = `/join/${code}`;
    });

    let last = null;
    try { last = JSON.parse(store.get(LAST_KEY) || 'null'); } catch (_) { last = null; }
    if (last && typeof last.room === 'string' && loadSession(last.room)) {
      fetch(`/api/room/${encodeURIComponent(last.room)}`)
        .then((res) => res.json())
        .then((info) => {
          if (!info.exists) { clearSession(last.room); return; }
          $('rejoin-code').textContent = last.room;
          $('rejoin-link').href = `/join/${last.room}`;
          $('rejoin').hidden = false;
          $('rejoin-forget').addEventListener('click', () => {
            clearSession(last.room);
            $('rejoin').hidden = true;
          });
        })
        .catch(() => { /* offline: just don't show the banner */ });
    }
  }

  if (document.body.dataset.page === 'index') {
    initIndex();
  }
})();