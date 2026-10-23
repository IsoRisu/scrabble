/* Scrabble client: plain DOM + Socket.IO. The server is the source of truth;
 * this file only renders what it is told and sends intents.
 *
 * Page 1 (index.html):  create a game / join by code / rejoin banner.
 * Page 2 (game.html):   board, rack, drag & drop, live state, game settings.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
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

  const SESSION_KEY = (room) => `scrabble.session.${room}`;
  const LAST_KEY = 'scrabble.last';
  const NAME_KEY = 'scrabble.name';
  const ZOOM_KEY = 'scrabble.zoom';
  const ZOOM_CELL_KEY = 'scrabble.zoomcell';
  const RACK_KEY = (room) => `scrabble.rack.${room}`;
  // Every seat gets its own hue (golden-angle spacing keeps neighbours apart even with 16 players).
  const seatHue = (seat) => Math.round((seat * 137.508 + 275) % 360);

  function loadSession(room) {
    try {
      const parsed = JSON.parse(store.get(SESSION_KEY(room)) || 'null');
      return parsed && typeof parsed.token === 'string' ? parsed : null;
    } catch (_) { return null; }
  }
  function saveSession(room, data) {
    store.set(SESSION_KEY(room), JSON.stringify(data));
    store.set(LAST_KEY, JSON.stringify({ room }));
  }
  function clearSession(room) {
    store.del(SESSION_KEY(room));
    try {
      const last = JSON.parse(store.get(LAST_KEY) || 'null');
      if (last && last.room === room) store.del(LAST_KEY);
    } catch (_) { store.del(LAST_KEY); }
  }

  // ------------------------------------------------------------------
  // Index page
  // ------------------------------------------------------------------
  function initIndex() {
    const createBtn = $('create-btn');
    const createError = $('create-error');
    const playersSel = $('create-players');
    for (let n = 2; n <= 16; n += 1) playersSel.append(h('option', { value: String(n), text: n === 2 ? '2 players' : `${n} players (Wild)` }));

    createBtn.addEventListener('click', async () => {
      createBtn.disabled = true;
      createError.hidden = true;
      try {
        const res = await fetch('/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // More than two players only works in Wild (the default); the server picks a bag that fits.
          body: JSON.stringify(Number(playersSel.value) > 2 ? { max_players: Number(playersSel.value) } : {}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not create a game.');
        window.location.href = data.path;
      } catch (err) {
        createError.textContent = err.message || 'Could not create a game.';
        createError.hidden = false;
        createBtn.disabled = false;
      }
    });

    $('join-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const raw = $('join-code').value.trim();
      // Accept either a bare code or a pasted /join/CODE link.
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

    // "If localStorage has a session token, rejoin the room."
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

  // ------------------------------------------------------------------
  // Game page
  // ------------------------------------------------------------------
  function initGame() {
    const roomCode = document.body.dataset.room;
    const ACK_TIMEOUT = 8000;

    let socket = null;
    let config = null;       // static board config from the server (premiums, tile values)
    let S = null;            // latest server view for this player
    let version = 0;         // version of S, used to detect missed diffs
    let session = loadSession(roomCode) || { token: null, name: '' };
    let resyncPending = false;
    let gameOverShown = false;
    let busy = false;        // a turn action is awaiting its acknowledgement

    // Local, optimistic view of my tentative placement. The server's copy
    // (S.pending) wins whenever no request is in flight.
    // `selected` is a rack tile picked for tap-to-place; `selectedBoard` is a tentative tile
    // on the board picked up for moving (touch screens: a tap selects, it never removes).
    // `rackOrder` is my private, purely visual ordering of the rack (a list of letters). Server
    // rack indices never change; rackIndices() maps this order onto them.
    const local = { pending: [], selected: null, selectedBoard: null, inflight: 0, rackOrder: [] };
    // The arrangement survives reloads (per room, this browser only).
    try {
      const saved = JSON.parse(store.get(RACK_KEY(roomCode)) || '[]');
      if (Array.isArray(saved)) local.rackOrder = saved.filter((x) => typeof x === 'string' && x.length === 1).slice(0, 32);
    } catch (_) { local.rackOrder = []; }
    const saveRackOrder = () => store.set(RACK_KEY(roomCode), JSON.stringify(local.rackOrder));

    const els = {
      board: $('board'), rack: $('rack'), preview: $('preview'), banner: $('turn-banner'),
      players: $('players'), history: $('history'), bag: $('bag-count'), conn: $('conn'),
      toast: $('toast'), share: $('share'), shareUrl: $('share-url'), modalRoot: $('modal-root'),
      submit: $('btn-submit'), recall: $('btn-recall'), swap: $('btn-swap'),
      pass: $('btn-pass'), challenge: $('btn-challenge'),
      resign: $('btn-resign'), timerToggle: $('btn-timer-toggle'), skipTime: $('btn-skip-time'), tracker: $('tracker'), modeLabel: $('mode-label'),
      settingsBtn: $('btn-settings'), info: $('btn-info'), timer: $('timer'),
      boardScroll: $('board-scroll'), zoom: $('btn-zoom'), start: $('btn-start'),
      shuffle: $('btn-shuffle'), minimap: $('minimap'),
    };
    let cells = new Map();   // "row,col" -> element (absolute board coordinates, may be negative)
    let builtBounds = null;  // bounds the current DOM grid was built for
    let builtMode = null;    // scoring mode the grid's premium squares were drawn for

    // Display text for the game settings (the server owns the actual rules).
    const MODE_INFO = {
      wild: {
        label: 'Wild',
        help: 'Words are checked automatically. Letters hit by a bonus keep it for the rest of the game (letters added to them later are not multiplied). A bingo doubles the main word.',
      },
      classic: {
        label: 'Classic',
        help: 'Traditional scoring: premium squares only count on the turn they are covered and a bingo is a flat 50. Any play is accepted and your opponent may challenge it (two players).',
      },
    };
    const LANGUAGE_NAME = { en: 'English', fi: 'Suomi', fr: 'Français', es: 'Español', sv: 'Svenska' };
    const LENGTH_LABEL = { short: 'Short', medium: 'Medium', full: 'Full' };
    const timerText = (key) => {
      const secs = config && config.timers ? config.timers[key] : 0;
      if (!secs) return 'No timer';
      return secs < 120 ? `${secs} seconds per turn` : `${secs / 60} minutes per turn`;
    };
    const timerShort = (key) => (key && key !== 'off' ? ` · ${key} turns` : '');
    // The premium pattern repeats every `premium_period` squares, so the board can grow forever.
    const mod = (n, m) => ((n % m) + m) % m;
    // Wild has its own layout (no triple word squares); Classic is the standard Scrabble board.
    const currentMode = () => (S && S.mode) || document.body.dataset.mode;
    const premiumAt = (row, col) => {
      const period = config.premium_period || 14;
      const layout = currentMode() === 'wild' && config.wild_premiums ? config.wild_premiums : config.premiums;
      return layout[`${mod(row, period)},${mod(col, period)}`];
    };
    const letterMult = (row, col) => ({ DL: 2, TL: 3 }[premiumAt(row, col)] || 1);
    let deadlineAt = null;   // local time (ms) at which the current turn's clock runs out
    let pausedLeft = null;   // ms left on a paused (Wild) timer, else null
    let lastBeep = 0;
    const modeLabel = (mode) => (MODE_INFO[mode] ? MODE_INFO[mode].label : mode);
    const lengthText = (length) => {
      const tiles = config && config.lengths ? config.lengths[length] : null;
      return `${LENGTH_LABEL[length] || length}${tiles ? ` (${tiles} tiles)` : ''}`;
    };

    // ---------- derived state ----------
    const isPlaying = () => !!S && S.status === 'playing';
    const myTurn = () => isPlaying() && S.current === S.you;
    const canEdit = () => myTurn() && !S.awaiting_final;
    // Off-turn players can stage (prepare) a word; it is private and loads into the real
    // tentative placement when their turn starts. Both modes share the same placing UI.
    const canStage = () => isPlaying() && !myTurn() && S.rack.length > 0 && !(S.players[S.you] && S.players[S.you].resigned);
    const canPlace = () => canEdit() || canStage();
    const opponent = () => (S ? S.players.find((p) => p.seat !== S.you) || null : null);
    const tileValue = (letter) => {
      const values = config && config.values ? config.values[(S && S.language) || config.default_language] : null;
      return (values && values[letter]) || 0;
    };

    // ---------- toast / connection pill ----------
    let toastTimer = null;
    function toast(message, isError = false) {
      els.toast.textContent = message;
      els.toast.className = isError ? 'toast error' : 'toast';
      els.toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { els.toast.hidden = true; }, isError ? 5000 : 3500);
    }
    function setConn(kind, text) {
      els.conn.className = `conn conn-${kind}`;
      els.conn.textContent = text;
    }

    // ---------- modals ----------
    function showModal(build, { dismissible = true, onClose = null } = {}) {
      const backdrop = h('div', { class: 'modal-backdrop' });
      const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
      backdrop.append(modal);
      const api = {
        modal,
        close() {
          document.removeEventListener('keydown', onKey);
          backdrop.remove();
          if (onClose) onClose();
        },
      };
      function onKey(event) { if (event.key === 'Escape' && dismissible) api.close(); }
      if (dismissible) {
        backdrop.addEventListener('pointerdown', (event) => { if (event.target === backdrop) api.close(); });
        document.addEventListener('keydown', onKey);
      }
      build(modal, api);
      els.modalRoot.append(backdrop);
      const focusable = modal.querySelector('input, button');
      if (focusable) focusable.focus();
      return api;
    }

    function askName() {
      return new Promise((resolve) => {
        showModal((modal, api) => {
          const input = h('input', {
            type: 'text', maxlength: '20', placeholder: 'Your name', autocomplete: 'nickname',
            value: store.get(NAME_KEY) || '', 'aria-label': 'Your name',
          });
          const go = () => {
            const name = input.value.trim();
            store.set(NAME_KEY, name);
            api.close();
            resolve(name);
          };
          input.addEventListener('keydown', (event) => { if (event.key === 'Enter') go(); });
          modal.append(
            h('h2', { text: 'Welcome!' }),
            h('p', { text: 'Pick a name so your opponent knows who they are playing.' }),
            input,
            h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: go, text: 'Join game' })),
          );
        }, { dismissible: false });
      });
    }

    function fatalModal(title, message) {
      showModal((modal) => {
        modal.append(
          h('h2', { text: title }),
          h('p', { text: message }),
          h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary', href: '/', text: 'Back to home' })),
        );
      }, { dismissible: false });
    }

    function pickLetter() {
      return new Promise((resolve) => {
        let chosen = null;
        showModal((modal, api) => {
          const grid = h('div', { class: 'letter-grid' });
          for (const letter of config.alphabets[(S && S.language) || config.default_language]) {
            grid.append(h('button', {
              class: 'btn', type: 'button', text: letter,
              onclick: () => { chosen = letter; api.close(); },
            }));
          }
          modal.append(
            h('h2', { text: 'Blank tile' }),
            h('p', { text: 'Which letter should it stand for?' }),
            grid,
            h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => api.close() })),
          );
        }, { onClose: () => resolve(chosen) });
      });
    }

    function openSwapModal() {
      if (!canEdit()) return;
      const chosen = new Set();
      showModal((modal, api) => {
        const rackEl = h('div', { class: 'swap-rack' });
        const confirm = h('button', { class: 'btn btn-primary', type: 'button', text: 'Swap 0 tiles', disabled: true });
        rackIndices().forEach((index) => {
          const letter = S.rack[index];
          const tile = makeTile(letter === '?' ? '' : letter, letter === '?');
          if (letter === '?') tile.querySelector('.l').textContent = '␣';
          tile.setAttribute('role', 'button');
          tile.setAttribute('tabindex', '0');
          const toggle = () => {
            if (chosen.has(index)) chosen.delete(index); else chosen.add(index);
            tile.classList.toggle('selected', chosen.has(index));
            confirm.disabled = chosen.size === 0;
            confirm.textContent = `Swap ${chosen.size} tile${chosen.size === 1 ? '' : 's'}`;
          };
          tile.addEventListener('click', toggle);
          tile.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
          });
          rackEl.append(tile);
        });
        confirm.addEventListener('click', () => {
          api.close();
          act('swap_tiles', { indices: [...chosen].sort((a, b) => a - b) }, () => {
            local.pending = [];
            toast('Tiles swapped.');
          });
        });
        modal.append(
          h('h2', { text: 'Swap tiles' }),
          h('p', { text: 'Choose the tiles to throw back. You draw new ones and your turn ends.' }),
          rackEl,
          h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => api.close() }), confirm),
        );
      });
    }

    function showGameOver() {
      if (gameOverShown || !S || S.status !== 'finished') return;
      gameOverShown = true;
      showModal((modal, api) => {
        const rows = S.players.map((p) => {
          const adj = S.final ? S.final.adjustments[p.seat] : 0;
          const note = adj ? ` ${adj > 0 ? '+' : ''}${adj} for leftover tiles` : '';
          return h('tr', { class: S.winner === p.seat ? 'winner' : '' },
            h('td', {}, p.name + (p.seat === S.you ? ' (you)' : ''), note ? h('small', { text: note }) : null),
            h('td', { text: String(p.score) }));
        });
        const headline = S.winner === 'tie'
          ? "It's a tie!"
          : (S.winner === S.you ? 'You win!' : `${S.players[S.winner].name} wins!`);
        modal.append(
          h('h2', { text: headline }),
          h('table', { class: 'results' }, h('tbody', {}, rows)),
          h('div', { class: 'actions' },
            h('button', { class: 'btn', type: 'button', text: 'View board', onclick: () => api.close() }),
            h('a', { class: 'btn btn-primary', href: '/', text: 'New game' })),
        );
      });
    }

    // ---------- board construction ----------
    const boundsOf = () => (S && S.bounds) || config.bounds;
    const boundsChanged = (a, b) => !a || a.top !== b.top || a.bottom !== b.bottom || a.left !== b.left || a.right !== b.right;

    // (Re)build the grid for the current bounds. The server grows the board as tiles get
    // near an edge, so this runs again whenever S.bounds changes.
    function buildBoard() {
      const b = boundsOf();
      const prev = builtBounds;
      els.board.replaceChildren();
      cells = new Map();
      els.board.style.setProperty('--cols', String(b.right - b.left + 1));
      els.board.style.setProperty('--rows', String(b.bottom - b.top + 1));
      const [centerRow, centerCol] = config.center;
      for (let r = b.top; r <= b.bottom; r += 1) {
        for (let c = b.left; c <= b.right; c += 1) {
          const kind = premiumAt(r, c);
          const isCenter = r === centerRow && c === centerCol;
          const cell = h('div', {
            class: `cell${kind ? ` ${kind.toLowerCase()}` : ''}${isCenter ? ' center' : ''}`,
            role: 'gridcell',
            dataset: { row: String(r), col: String(c) },
          });
          cell.dataset.label = isCenter ? '★' : (kind || '');
          cell.dataset.sig = '';
          els.board.append(cell);
          cells.set(`${r},${c}`, cell);
        }
      }
      builtBounds = { ...b };
      builtMode = currentMode();
      if (prev) {
        // Growing at the top/left shifts everything down/right: keep the same squares in view.
        const sample = els.board.firstElementChild;
        const step = sample ? sample.offsetWidth + 3 : 0;
        els.boardScroll.scrollLeft += (prev.left - b.left) * step;
        els.boardScroll.scrollTop += (prev.top - b.top) * step;
      }
    }

    // `boost` is the letter multiplier shown on the tile: the one a tile on the board
    // earned (Wild keeps it for good) or the one of the square a tentative tile sits on.
    // `tint` colours boosted tiles (Wild mode) so everyone can see which were multiplied.
    function makeTile(letter, blank, extra = '', boost = 1, tint = false) {
      const children = [h('span', { class: 'l', text: letter || '' })];
      const mult = !blank && boost > 1 ? boost : 1;
      if (!blank) children.push(h('span', { class: 'v', text: String(tileValue(letter) * mult) }));
      const tinted = mult > 1 && tint;
      const boostClass = mult >= 4 ? 'boost-hi' : `boost-${mult}`;
      const cls = `tile${blank ? ' blank' : ''}${tinted ? ` boosted ${boostClass}` : ''}${extra ? ` ${extra}` : ''}`;
      if (tinted && mult >= 4) children.push(h('span', { class: 'm', text: `x${mult}` }));
      const tile = h('div', { class: cls }, children);
      if (tinted) tile.setAttribute('title', `Worth ${tileValue(letter) * mult} (x${mult} bonus kept)`);
      return tile;
    }

    // ---------- rendering ----------
    function render() {
      if (!S || !config) return;
      if (boundsChanged(builtBounds, boundsOf()) || builtMode !== currentMode()) {
        const first = !builtBounds;
        buildBoard();
        if (first && els.boardScroll.classList.contains('zoomed')) centerBoardOn(cells.get(`${config.center[0]},${config.center[1]}`));
      }
      // A picked-up board tile only stays selected while it is still mine to move.
      if (local.selectedBoard && !(canPlace() && local.pending.some(
        (p) => p.row === local.selectedBoard.row && p.col === local.selectedBoard.col))) {
        local.selectedBoard = null;
      }
      renderBanner();
      renderBoard();
      renderRack();
      renderPlayers();
      renderHistory();
      renderPreview();
      renderControls();
      renderTracker();
      els.bag.textContent = String(S.bag_count);
      renderSettingsButton();
      renderTimer();
      els.modeLabel.textContent = `${modeLabel(S.mode)} · ${lengthText(S.length)}${timerShort(S.timer)}`;
      els.share.hidden = S.status !== 'waiting';
      els.start.hidden = !S.can_start;
      els.start.textContent = `Start now with ${S.players.length} players`;
      els.start.disabled = busy;
      if (S.status === 'waiting') els.shareUrl.value = `${window.location.origin}/join/${roomCode}`;
      document.title = `${myTurn() ? '▶ ' : ''}Scrabble – ${roomCode}`;
      showGameOver();
      queueMinimap();
    }

    function renderSettingsButton() {
      const locked = S.status === 'finished' || S.settings_locked;
      els.settingsBtn.disabled = locked;
      els.settingsBtn.title = locked ? 'Settings can only be changed before the first turn is played' : '';
    }

    function openSettingsModal() {
      if (!S || S.settings_locked || S.status === 'finished') return;
      showModal((modal, api) => {
        const option = (value, text) => h('option', { value, text });
        const modeSel = h('select', { 'aria-label': 'Scoring' }, config.modes.map((m) => option(m, modeLabel(m))));
        const lengthSel = h('select', { 'aria-label': 'Length' },
          Object.keys(config.lengths).map((l) => option(l, lengthText(l))));
        const timerSel = h('select', { 'aria-label': 'Timer' },
          Object.keys(config.timers).map((t) => option(t, timerText(t))));
        const languages = config.languages || [config.default_language];
        const languageSel = h('select', { 'aria-label': 'Language' },
          languages.map((l) => option(l, LANGUAGE_NAME[l] || l)));
        const range = config.player_range || [2, 4];
        const playersSel = h('select', { 'aria-label': 'Players' });
        for (let n = range[0]; n <= range[1]; n += 1) {
          playersSel.append(option(String(n), `${n} players`));
        }
        playersSel.value = String(S.max_players || 2);
        const rack = config.rack_size || 7;
        const fits = (length, players) => players * rack <= config.lengths[length];
        // Lengths whose bag cannot give every player a full rack are greyed out; picking a bigger
        // player count raises the length to the shortest one that fits (the server does the same).
        const syncLengths = () => {
          const players = Number(playersSel.value);
          for (const opt of lengthSel.options) {
            opt.disabled = !fits(opt.value, players);
            opt.title = opt.disabled ? `Not enough tiles for ${players} players` : '';
          }
          if (!fits(lengthSel.value, players)) {
            const ordered = Object.keys(config.lengths).sort((a, b) => config.lengths[a] - config.lengths[b]);
            lengthSel.value = ordered.find((l) => fits(l, players)) || ordered[ordered.length - 1];
          }
        };
        const syncPlayers = () => {
          // Classic uses challenges, which only work one-on-one.
          if (modeSel.value === 'classic') playersSel.value = '2';
          playersSel.disabled = modeSel.value === 'classic';
          syncLengths();
        };
        playersSel.addEventListener('change', syncLengths);
        languageSel.value = S.language;
        modeSel.value = S.mode;
        lengthSel.value = S.length;
        timerSel.value = S.timer;
        const help = h('p', { class: 'hint' });
        const showHelp = () => { help.textContent = (MODE_INFO[modeSel.value] || {}).help || ''; };
        modeSel.addEventListener('change', () => { showHelp(); syncPlayers(); });
        showHelp();
        if (S.status === 'waiting') syncPlayers(); else syncLengths();
        const field = (label, el) => h('label', { class: 'field' }, h('span', { text: label }), el);
        const save = () => {
          const change = {};
          if (modeSel.value !== S.mode) change.mode = modeSel.value;
          if (lengthSel.value !== S.length) change.length = lengthSel.value;
          if (timerSel.value !== S.timer) change.timer = timerSel.value;
          if (languageSel.value !== S.language) change.language = languageSel.value;
          if (S.status === 'waiting' && Number(playersSel.value) !== (S.max_players || 2)) {
            change.max_players = Number(playersSel.value);
          }
          api.close();
          if (Object.keys(change).length) act('update_settings', change, () => toast('Game settings updated.'));
        };
        modal.append(
          h('h2', { text: 'Game Settings' }),
          h('p', { text: 'Anyone in the room can change these until the first turn is played.' }),
          field('Scoring', modeSel), help,
          ...(S.status === 'waiting' ? [field('Players', playersSel)] : []),
          field('Length', lengthSel),
          field('Timer', timerSel),
          ...(languages.length > 1 ? [field('Language', languageSel)] : []),
          h('div', { class: 'actions' },
            h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => api.close() }),
            h('button', { class: 'btn btn-primary', type: 'button', text: 'Save', onclick: save })),
        );
      });
    }

    function openInfoModal() {
      showModal((modal, api) => {
        const bullet = (strong, text) => h('li', {}, h('b', { text: strong }), text);
        modal.classList.add('modal-info');
        modal.append(
          h('h2', { text: 'Game Info' }),
          h('p', { text: '2 to 16 players take turns placing letters on a shared board to make words, crossword-style. In Wild the board starts at 27 by 19 squares and keeps growing as words reach its edges; Classic uses the standard fixed 15 by 15 board. High-value letters and special squares earn more points.' }),
          h('h3', { text: 'Setup' }),
          h('p', { text: 'Open Edit Game Settings to choose the length, scoring and timer for your game (before the first turn).' }),
          h('ul', {},
            bullet('Wild (default): ', 'there are no triple word squares (the corners are plain and the edge middles are triple letters). Letters affected by a bonus keep it permanently: a letter on a double/triple letter square, and every letter of a word that hit a double/triple word square. Multiplied letters are coloured in and keep their higher value when anyone reuses them, but letters added to the word later are not multiplied. A bingo (all 7 tiles) doubles the main word. Words are checked automatically as you place tiles. Up to 16 players (a longer game gives everyone a full rack).'),
            bullet('Classic: ', 'bonuses only count on the turn they are covered, and a bingo is a flat 50 points, as in standard Scrabble. Classic uses the traditional challenge system and is for two players.')),
          h('h3', { text: 'How to play' }),
          h('ol', {},
            h('li', { text: 'Place letters: use the tiles near the bottom to make words. Select a tile and then its destination, or drag it there. The number on each tile is what that letter scores on the square it is on.' }),
            h('li', { text: 'Plan ahead: while your opponent is playing you can already stage a word. It is checked and scored live, only you can see it, and it loads onto the board when your turn starts so you can review it and press Play word.' }),
            h('li', { text: 'Rearrange your rack by dragging tiles left or right. Only you see your rack and the tiles you have placed but not yet played.' }),
            h('li', { text: "Can't form a word? Swap tiles with the Swap button above your letters, or press Pass Turn under the timer." }),
            h('li', { text: 'Resign any time with the Resign button (after confirming). With two players your opponent wins; with more, your tiles go back into the bag and the others play on.' }),
            h('li', { text: 'The tile tracker lists every tile you have not seen: the bag plus your opponents’ racks. Once the bag is empty it shows your opponents’ exact tiles. Click a word in the move list to look it up in an online dictionary.' }),
            h('li', { text: 'Wild timer: it only reminds you. Anyone can pause or resume it, and once it reaches zero the host may skip the player on turn. Classic enforces the timer.' }),
            h('li', { text: 'Winning: the player with the most points at the end of the game wins.' })),
          h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', text: 'Got it', onclick: () => api.close() })),
        );
      });
    }

    function fmtClock(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000));
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    }

    function renderTimer() {
      const box = els.timer;
      if (!S) return;
      box.className = 'timer';
      if (S.status !== 'playing') {
        box.textContent = S.status === 'finished' ? 'Game over' : '';
        els.timerToggle.hidden = true;
        els.skipTime.hidden = true;
        return;
      }
      const wild = S.mode === 'wild';
      const hasTimer = S.timer && S.timer !== 'off' && (deadlineAt !== null || pausedLeft !== null);
      els.timerToggle.hidden = !(wild && hasTimer);
      els.skipTime.hidden = true;
      if (!hasTimer) { box.textContent = 'No timer'; box.classList.add('off'); return; }
      const paused = pausedLeft !== null;
      const left = paused ? pausedLeft : deadlineAt - Date.now();
      const over = wild && !paused && left <= 0;
      els.timerToggle.textContent = paused ? 'Resume timer' : 'Pause timer';
      if (paused) {
        box.textContent = `⏸ ${fmtClock(left)}`;
        box.classList.add('paused');
      } else if (over) {
        box.textContent = '⏱ 0:00 – time is up';
        box.classList.add('low');
        // Wild timers only remind: nothing happens automatically.  The host may skip the player,
        // and pausing the timer silences the reminder.
        els.skipTime.hidden = S.host !== S.you;
        if (myTurn() && Date.now() - lastBeep > 3000) { lastBeep = Date.now(); beep(); }
      } else {
        box.textContent = `⏱ ${fmtClock(left)}`;
        if (myTurn()) box.classList.add('mine');
        if (left <= 10000) box.classList.add('low');
      }
    }

    // A short reminder tone for an overrun turn (browsers may block it until the page was clicked).
    let audioCtx = null;
    function beep() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = audioCtx || new Ctx();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = 660;
        gain.gain.value = 0.05;
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.25);
      } catch (_) { /* sound is optional */ }
    }
    setInterval(renderTimer, 250);

    function renderBanner() {
      let text;
      let cls;
      const opp = opponent();
      if (S.status === 'waiting') {
        text = `Waiting for players to join… (${S.players.length}/${S.max_players || 2})`;
        cls = 'theirs';
      } else if (S.status === 'finished') {
        text = S.winner === 'tie' ? "Game over – it's a tie!"
          : (S.winner === S.you ? 'Game over – you win!' : `Game over – ${S.players[S.winner].name} wins!`);
        cls = 'over';
      } else if (S.players[S.you] && S.players[S.you].resigned) {
        text = 'You resigned. You can keep watching the game.';
        cls = 'theirs';
      } else if (S.awaiting_final) {
        if (myTurn()) { text = `${opp.name} played their last tile. Challenge it, or pass to accept.`; cls = 'alert'; }
        else { text = `You played your last tile. Waiting for ${opp.name} to challenge or accept…`; cls = 'theirs'; }
      } else if (myTurn()) {
        text = 'Your turn';
        cls = 'mine';
      } else {
        text = `${S.players[S.current].name}'s turn`;
        if (canStage()) text += ' · stage your next word';
        cls = 'theirs';
      }
      const offline = S.players.filter((p) => p.seat !== S.you && !p.connected);
      if (S.status === 'playing' && offline.length) {
        text += offline.length === 1 ? ` — ${offline[0].name} is offline` : ' — some players are offline';
      }
      els.banner.textContent = text;
      els.banner.className = `turn-banner ${cls}`;
    }

    function renderBoard() {
      const lastCells = new Set((S.last_move ? S.last_move.cells : []).map(([r, c]) => `${r},${c}`));
      const mine = new Map();   // my tentative tiles (my turn) or my staged tiles (off turn)
      // Unplayed tiles are private: the opponent's tentative tiles are never drawn.
      const staging = !canEdit() && canStage();
      if (canEdit() || staging) {
        for (const p of local.pending) {
          const isBlank = S.rack[p.rack_index] === '?';
          mine.set(`${p.row},${p.col}`, { letter: p.letter, blank: isBlank, boost: letterMult(p.row, p.col) });
        }
      }

      const oppSet = new Set(!canEdit() && Array.isArray(S.opp_pending) ? S.opp_pending.map(([r, c]) => `${r},${c}`) : []);
      const placing = canPlace() && (local.selected !== null || local.selectedBoard !== null);
      const sb = local.selectedBoard;
      for (let r = builtBounds.top; r <= builtBounds.bottom; r += 1) {
        for (let c = builtBounds.left; c <= builtBounds.right; c += 1) {
          const key = `${r},${c}`;
          const cell = cells.get(key);
          const placed = S.board[key];
          let sig;
          let kind = null;
          let info = null;
          let sel = false;
          if (placed) {
            kind = lastCells.has(key) ? 'last' : '';
            info = { letter: placed.l, blank: placed.b, boost: placed.m || 1 };
            sig = `b:${placed.l}:${placed.b ? 1 : 0}:${info.boost}:${kind}`;
          } else if (mine.has(key)) {
            kind = staging ? 'pending staged' : 'pending';
            info = mine.get(key);
            sel = !!sb && sb.row === r && sb.col === c;
            sig = `p${staging ? 's' : ''}:${S.mode}:${info.letter}:${info.blank ? 1 : 0}:${info.boost}:${sel ? 1 : 0}`;
          } else if (oppSet.has(key)) {
            sig = 'o';   // opponent is placing a tile here: outline only, no letter
          } else {
            sig = 'e';
          }
          cell.classList.toggle('can-drop', !info && placing);
          if (cell.dataset.sig === sig) continue;
          cell.dataset.sig = sig;
          cell.replaceChildren();
          if (sig === 'o') {
            cell.append(h('div', { class: 'tile opp-ghost', 'aria-label': 'Opponent is placing a tile here' }));
          } else if (info) {
            const tile = makeTile(info.letter, info.blank, sel ? `${kind} selected` : kind, info.boost || 1, S.mode === 'wild');
            if (kind.startsWith('pending')) {
              tile.setAttribute('title', (staging ? 'Staged for your next turn. ' : '')
                + 'Drag to move. Tap to pick it up, then tap a square (or the rack to take it back).');
            }
            cell.append(tile);
          } else if (cell.dataset.label) {
            cell.append(document.createTextNode(cell.dataset.label));
          }
        }
      }
    }

    // Server rack indices in my preferred display order. Letters keep their position across
    // turns; tiles I have not arranged yet (newly drawn) go at the end.
    function rackIndices() {
      const free = S.rack.map((_, i) => i);
      const order = [];
      for (const letter of local.rackOrder) {
        const at = free.findIndex((i) => S.rack[i] === letter);
        if (at !== -1) order.push(free.splice(at, 1)[0]);
      }
      order.push(...free);
      const next = order.map((i) => S.rack[i]);
      if (next.join('') !== local.rackOrder.join('')) { local.rackOrder = next; saveRackOrder(); }
      return order;
    }

    // Drop a rack tile at horizontal position x: it lands before the first visible tile whose centre is right of x.
    function reorderRack(index, x) {
      const placeable = canPlace();
      const used = new Set(local.pending.map((p) => p.rack_index));
      const order = rackIndices().filter((i) => i !== index);
      const visible = order.filter((i) => !(placeable && used.has(i)));
      let before = null;
      for (const i of visible) {
        const tile = els.rack.querySelector(`.tile[data-index="${i}"]`);
        if (!tile) continue;
        const box = tile.getBoundingClientRect();
        if (x < box.left + box.width / 2) { before = i; break; }
      }
      const at = before === null ? order.length : order.indexOf(before);
      order.splice(at, 0, index);
      local.rackOrder = order.map((i) => S.rack[i]);
      saveRackOrder();
      render();
    }

    function renderRack() {
      const used = new Set(local.pending.map((p) => p.rack_index));
      const placeable = canPlace();
      els.rack.replaceChildren();
      if (S.status === 'waiting') {
        els.rack.append(h('span', { class: 'rack-hint', text: 'Your rack appears when the game starts.' }));
        return;
      }
      rackIndices().forEach((index) => {
        const letter = S.rack[index];
        if (placeable && used.has(index)) return;
        const blank = letter === '?';
        const tile = makeTile(blank ? '' : letter, blank, local.selected === index && placeable ? 'selected' : '');
        tile.dataset.index = String(index);
        tile.setAttribute('role', 'button');
        tile.setAttribute('aria-label', blank ? 'Blank tile' : `Tile ${letter}`);
        if (blank) tile.querySelector('.l').textContent = '␣';
        els.rack.append(tile);
      });
      if (!els.rack.children.length) {
        els.rack.append(h('span', { class: 'rack-hint', text: S.status === 'finished' ? 'Game over.' : 'All tiles are on the board.' }));
      }
    }

    function renderPlayers() {
      els.players.replaceChildren();
      const total = Math.max(S.players.length, S.max_players || 2);
      els.players.classList.toggle('many', total > 4);  // compact two-column cards for big games
      for (const p of S.players) {
        const active = S.status === 'playing' && S.current === p.seat;
        const minis = h('span', { class: 'mini-tiles' });
        for (let i = 0; i < p.rack_count; i += 1) minis.append(h('i'));
        const card = h('div', { class: `player-card${active ? ' active' : ''}${p.resigned ? ' resigned' : ''}` },
          h('div', { class: 'name' },
            h('span', { class: `dot${p.connected ? ' on' : ''}`, title: p.connected ? 'Online' : 'Offline' }),
            h('span', { class: 'nm', text: p.name }),
            p.seat === S.you ? h('span', { class: 'you', text: 'you' }) : null,
            p.resigned ? h('span', { class: 'you', text: 'resigned' }) : null),
          h('div', { class: 'score', text: String(p.score) }),
          h('div', { class: 'racks' }, minis, `${p.rack_count} tile${p.rack_count === 1 ? '' : 's'}`));
        card.style.setProperty('--seat-hue', String(seatHue(p.seat)));
        if (S.skippable === p.seat) {
          // Offline for a while and holding everybody up: anyone else may pass for them.
          card.append(h('button', {
            class: 'btn btn-skip', type: 'button', text: 'Skip (offline)',
            title: `${p.name} has been offline for a while. Pass for them so the game can go on.`,
            onclick: () => act('skip_player', { seat: p.seat }, () => toast(`${p.name} was skipped.`)),
          }));
        }
        els.players.append(card);
      }
      for (let i = S.players.length; i < (S.max_players || 2); i += 1) {
        els.players.append(h('div', { class: 'player-card waiting' },
          h('div', { class: 'name' }, h('span', { class: 'dot' }), h('span', { class: 'nm', text: 'Waiting for player…' })),
          h('div', { class: 'score', text: '–' })));
      }
    }

    // Words of a play are links to an online dictionary (Wiktionary has every bundled language).
    function historyNodes(entry) {
      const text = entry.text;
      const words = entry.words || [];
      if (!words.length) return [text];
      const lang = (S && S.language) || 'en';
      const out = [];
      let cursor = 0;
      let search = text.indexOf(' played ');
      search = search < 0 ? 0 : search + 8;
      for (const word of words) {
        const at = text.indexOf(word, search);
        if (at < 0) continue;
        out.push(text.slice(cursor, at));
        out.push(h('a', {
          class: 'def-link', target: '_blank', rel: 'noopener noreferrer', title: `Look up ${word}`,
          href: `https://${lang}.wiktionary.org/wiki/${encodeURIComponent(word.toLowerCase())}`, text: word,
        }));
        cursor = at + word.length;
        search = cursor;
      }
      out.push(text.slice(cursor));
      return out;
    }

    function renderHistory() {
      els.history.replaceChildren();
      for (const entry of [...S.history].reverse()) {
        const seated = Number.isInteger(entry.seat) && entry.seat >= 0;
        const li = h('li', { class: `${entry.kind}${seated ? ' seat' : ''}` }, historyNodes(entry));
        if (seated) li.style.setProperty('--seat-hue', String(seatHue(entry.seat)));
        els.history.append(li);
      }
    }

    function renderPreview() {
      const box = els.preview;
      box.replaceChildren();
      if (!S || S.status === 'waiting') return;
      if (S.status === 'finished') return;
      const staging = !canEdit() && canStage();
      const lastPlay = () => {
        if (!S.last_move) return null;
        const who = S.players[S.last_move.seat].name;
        return h('span', { class: 'pv-muted', text: `Last play: ${S.last_move.words.join(', ')} for ${S.last_move.score} (${who})` });
      };
      if (!canEdit() && !staging) {
        const last = lastPlay();
        if (last) box.append(last);
        return;
      }
      // Why staged tiles changed (loaded on my turn / blocked by the last play).
      if (S.stage_note) box.append(h('div', { class: 'pv-note', text: S.stage_note }));
      if (local.selectedBoard) {
        box.append(h('span', { class: 'pv-muted', text: 'Tap a square to move this tile, or tap your rack to take it back.' }));
        return;
      }
      if (local.pending.length === 0) {
        if (staging) {
          box.append(h('span', { class: 'pv-muted', text: 'Stage your next word while you wait: tap a tile, then a square. Only you can see it.' }));
          const last = lastPlay();
          if (last) box.append(h('div', {}, last));
        } else {
          box.append(h('span', { class: 'pv-muted', text: 'Tap a tile, then tap a square. You can also drag tiles onto the board.' }));
        }
        return;
      }
      const pv = staging ? S.staged_preview : S.preview;
      if (local.inflight > 0 || !pv) {
        box.append(h('span', { class: 'pv-muted', text: 'Checking…' }));
        return;
      }
      if (staging) box.append(h('span', { class: 'pv-muted', text: 'Staged: ' }));
      if (pv.words.length === 0) {
        box.append(h('span', { class: 'pv-muted', text: pv.error || '' }));
        return;
      }
      const parts = [];
      pv.words.forEach((w, i) => {
        if (i) parts.push(' · ');
        const mark = w.valid === true ? '✓ ' : (w.valid === false ? '✗ ' : '');
        parts.push(h('span', { class: w.valid === false ? 'pv-bad' : (w.valid === true ? 'pv-good' : ''), text: `${mark}${w.word} ${w.score}` }));
      });
      if (pv.bingo) parts.push(h('span', { class: 'pv-total', text: ` BINGO +${pv.bingo_bonus !== undefined ? pv.bingo_bonus : config.bingo_bonus}` }));
      if (pv.total !== null && pv.total !== undefined) parts.push(h('span', { class: 'pv-total', text: ` = ${pv.total}` }));
      box.append(...parts);
      if (pv.error) box.append(h('div', { class: 'pv-bad', text: pv.error }));
    }

    function renderControls() {
      const edit = canEdit();
      const staging = !edit && canStage();
      const hasPending = local.pending.length > 0;
      const previewOk = !S.preview || S.preview.ok;
      els.submit.disabled = !(edit && hasPending && previewOk && local.inflight === 0 && !busy);
      els.submit.textContent = staging && hasPending ? 'Staged – plays on your turn' : 'Play word';
      els.submit.title = staging && hasPending ? 'Your staged word loads on your turn; then press Play word.' : '';
      els.recall.disabled = !((edit || staging) && hasPending);
      els.swap.disabled = !(edit && S.bag_count >= config.rack_size && !busy);
      els.shuffle.disabled = S.status === 'waiting' || S.rack.length < 2;
      els.swap.title = S.bag_count < config.rack_size ? 'Fewer than 7 tiles left in the bag' : '';
      els.pass.disabled = !(myTurn() && !busy);
      els.pass.textContent = S.awaiting_final ? 'Accept & end game' : 'Pass Turn';
      els.challenge.hidden = S.mode !== 'classic';
      els.challenge.disabled = !(S.can_challenge && !busy);
      const me = S.players[S.you];
      els.resign.hidden = !(S.status === 'playing' && me && !me.resigned);
      els.resign.disabled = busy;
    }

    // ---------- tile tracker: what has not been played and is not on my rack ----------
    function renderTracker() {
      const box = els.tracker;
      box.replaceChildren();
      const t = S.tiles;
      if (!t || S.status === 'waiting') { box.hidden = true; return; }
      box.hidden = false;
      const count = (label, value) => h('span', { class: 'tr-count' }, `${label} `, h('b', { text: String(value) }));
      box.append(h('div', { class: 'tr-counts' },
        count('Tile bag', S.bag_count), count('Vowels', t.vowels), count('Consonants', t.consonants),
        t.blanks ? count('Blanks', t.blanks) : null));
      const order = Object.keys(t.letters).filter((l) => l !== '?').sort((a, b) => a.localeCompare(b));
      const chips = h('div', { class: 'tr-letters' });
      for (const letter of order) {
        chips.append(h('span', { class: 'tr-chip', title: `${t.letters[letter]} unseen` }, letter, h('sub', { text: String(t.letters[letter]) })));
      }
      if (t.blanks) chips.append(h('span', { class: 'tr-chip', title: `${t.blanks} unseen` }, '␣', h('sub', { text: String(t.blanks) })));
      box.append(chips);
      box.append(h('div', { class: 'tr-note', text: S.bag_count === 0 && S.status === 'playing'
        ? 'The bag is empty: these are your opponents’ exact tiles.'
        : 'Unseen tiles: the bag plus your opponents’ racks.' }));
    }

    // ---------- server -> client ----------
    function serverPending() {
      if (!S || !isPlaying()) return [];
      // My turn: my tentative tiles. Otherwise: the word I have staged (private, has rack indices).
      return (S.current === S.you ? S.pending : (S.staged || []))
        .filter((p) => p.rack_index !== undefined)
        .map((p) => ({ rack_index: p.rack_index, row: p.row, col: p.col, letter: p.letter }));
    }

    function syncLocalFromServer() {
      if (local.inflight > 0) return;
      local.pending = serverPending();
      if (!canPlace() || (local.selected !== null && (local.selected >= S.rack.length
          || local.pending.some((p) => p.rack_index === local.selected)))) {
        local.selected = null;
      }
    }

    function syncDeadline() {
      const ms = S.turn_ms_left;
      if (ms === null || ms === undefined) { deadlineAt = null; pausedLeft = null; return; }
      if (S.timer_paused) { deadlineAt = null; pausedLeft = ms; } else { deadlineAt = Date.now() + ms; pausedLeft = null; }
    }

    function onState(msg) {
      config = msg.config;
      S = msg.state;
      version = msg.version;
      resyncPending = false;
      local.inflight = 0;
      local.selected = null;
      local.pending = serverPending();
      syncDeadline();
      render();
    }

    function onDiff(msg) {
      if (!S || msg.base !== version) { requestResync(); return; }
      const prevNote = S.stage_note;
      for (const [key, value] of Object.entries(msg.patch)) {
        if (key === 'board') {
          for (const cell of value.del) delete S.board[cell];
          Object.assign(S.board, value.set);
        } else {
          S[key] = value;
        }
      }
      version = msg.version;
      if ('turn_ms_left' in msg.patch || 'timer_paused' in msg.patch) syncDeadline();
      syncLocalFromServer();
      render();
      if (S.stage_note && S.stage_note !== prevNote) toast(S.stage_note);
    }

    function requestResync() {
      // Missed a diff (or never had a baseline): rejoin to get a fresh snapshot.
      if (resyncPending) return;
      resyncPending = true;
      doJoin();
    }

    // ---------- client -> server ----------
    function act(event, payload, onOk) {
      if (!socket || !socket.connected) { toast('Not connected to the server.', true); return; }
      if (busy) return;
      busy = true;
      renderControlsSafe();
      socket.timeout(ACK_TIMEOUT).emit(event, payload, (err, res) => {
        busy = false;
        if (err) toast('The server did not respond. Check your connection.', true);
        else if (!res || !res.ok) toast((res && res.error) || 'Something went wrong.', true);
        else if (onOk) onOk(res);
        syncLocalFromServer();
        render();
      });
    }

    function renderControlsSafe() { if (S && config) { renderControls(); renderSettingsButton(); } }

    function sendPlacements() {
      if (!socket || !socket.connected) { toast('Not connected to the server.', true); return; }
      local.inflight += 1;
      const placements = local.pending.map((p) => ({
        rack_index: p.rack_index, row: p.row, col: p.col, letter: p.letter,
      }));
      const event = canEdit() ? 'place_tiles' : 'stage_tiles';
      socket.timeout(ACK_TIMEOUT).emit(event, { placements }, (err, res) => {
        local.inflight = Math.max(0, local.inflight - 1);
        if (err) toast('The server did not respond. Check your connection.', true);
        else if (!res || !res.ok) toast((res && res.error) || 'Could not place that tile.', true);
        syncLocalFromServer();
        render();
      });
    }

    function doJoin() {
      if (!socket) return;
      const payload = { room: roomCode, token: session.token || undefined, name: session.name || '' };
      socket.timeout(ACK_TIMEOUT).emit('join', payload, (err, res) => {
        if (err) { setTimeout(doJoin, 1500); return; }
        if (!res || !res.ok) {
          resyncPending = false;
          if (res && res.code === 'no_room') {
            clearSession(roomCode);
            socket.disconnect();
            fatalModal('Game not found', 'This room no longer exists. The server may have restarted, or the game expired.');
          } else if (res && res.code === 'full') {
            socket.disconnect();
            fatalModal('Room is full', 'This game already has all of its players.');
          } else {
            toast((res && res.error) || 'Could not join the game.', true);
          }
          return;
        }
        session = { token: res.token, name: session.name, seat: res.seat };
        saveSession(roomCode, session);
      });
    }

    function startSocket() {
      // eslint-disable-next-line no-undef
      if (typeof io !== 'function') {
        setConn('bad', 'offline');
        fatalModal('Cannot load the game client', 'The Socket.IO library could not be loaded. Check your internet connection and reload.');
        return;
      }
      // eslint-disable-next-line no-undef
      socket = io({ reconnectionDelayMax: 5000 });
      socket.on('connect', () => { setConn('ok', 'online'); doJoin(); });
      socket.on('disconnect', () => {
        setConn('wait', 'reconnecting…');
        local.inflight = 0;
        busy = false;
      });
      socket.on('connect_error', () => setConn('wait', 'reconnecting…'));
      socket.on('state', onState);
      socket.on('state_diff', onDiff);
    }

    // ---------- local editing (rack <-> board) ----------
    function isFreeSquare(row, col, ignoreKey = null) {
      const key = `${row},${col}`;
      if (S.board[key]) return false;
      return !local.pending.some((p) => `${p.row},${p.col}` === key && key !== ignoreKey);
    }

    async function placeFromRack(index, row, col) {
      if (!canPlace() || !isFreeSquare(row, col)) return;
      let letter = S.rack[index];
      if (letter === '?') {
        letter = await pickLetter();
        if (!letter) return;
        if (!canPlace() || !isFreeSquare(row, col)) return; // things may have changed meanwhile
      }
      local.pending = local.pending.filter((p) => p.rack_index !== index);
      local.pending.push({ rack_index: index, row, col, letter });
      local.selected = null;
      sendPlacements();
      render();
    }

    function movePending(fromRow, fromCol, toRow, toCol) {
      const entry = local.pending.find((p) => p.row === fromRow && p.col === fromCol);
      if (!entry || !isFreeSquare(toRow, toCol, `${fromRow},${fromCol}`)) return;
      entry.row = toRow;
      entry.col = toCol;
      sendPlacements();
      render();
    }

    function removePending(row, col) {
      const before = local.pending.length;
      local.pending = local.pending.filter((p) => !(p.row === row && p.col === col));
      if (local.pending.length !== before) { sendPlacements(); render(); }
    }

    // ---------- pointer-based drag & drop (mouse and touch) ----------
    let press = null;
    let highlighted = null;
    let suppressClickUntil = 0;
    // Touch drags: ignore small finger wobble (so taps stay taps) and hold the tile above the
    // fingertip, so the finger never hides the square being aimed at. The drop lands where the
    // tile is shown, not under the finger.
    const TOUCH_SLOP = 12;
    const MOUSE_SLOP = 6;
    const TOUCH_LIFT = 56;
    const aimY = (y) => (press && press.touch ? y - TOUCH_LIFT : y);

    function targetAt(x, y) {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const cell = el.closest('.cell');
      if (cell) return { type: 'cell', row: Number(cell.dataset.row), col: Number(cell.dataset.col), el: cell };
      const rack = el.closest('#rack');
      if (rack) return { type: 'rack', el: rack };
      return null;
    }

    // Where a drag currently points. On touch the tile is held above the finger, so a rack drop
    // (reordering, or returning a tile) is also recognised when the finger itself is over the rack.
    function resolveTarget(x, y) {
      let target = targetAt(x, aimY(y));
      if (!target || target.type === 'rack') {
        const raw = targetAt(x, y);
        if (raw && raw.type === 'rack') target = raw;
      }
      return target;
    }

    function setHighlight(el) {
      if (highlighted === el) return;
      if (highlighted) highlighted.classList.remove('drop-ok');
      highlighted = el;
      if (highlighted) highlighted.classList.add('drop-ok');
    }

    function dropIsValid(source, target) {
      if (!target) return false;
      if (target.type === 'rack') return true; // board tile -> take back; rack tile -> reorder
      const ignore = source.type === 'board' ? `${source.row},${source.col}` : null;
      return isFreeSquare(target.row, target.col, ignore);
    }


    // ---------- hand letters dodge and wiggle when a dragged letter hovers close ----------
    // Only transform-type properties are touched (translate, rotate, scale compose in that order).
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const reactState = new WeakMap();
    let reactPoint = null;   // centre of the floating letter, or null when nothing is being dragged
    let reactRaf = 0;
    function reactFrame(now) {
      reactRaf = 0;
      const tiles = els.rack.querySelectorAll('.tile');
      let busy = reactPoint !== null;
      tiles.forEach((tile) => {
        if (press && press.el === tile) return;
        let st = reactState.get(tile);
        if (!st) { st = { tx: 0, ty: 0, p: 0, phase: Math.random() * Math.PI * 2 }; reactState.set(tile, st); }
        const size = tile.offsetWidth || 48;
        const R = size * 1.2;
        let targetP = 0;
        let dx = 0;
        let dy = 0;
        if (reactPoint) {
          const box = tile.getBoundingClientRect();   // includes the current offset, so remove it
          const cx = box.left + box.width / 2 - st.tx;
          const cy = box.top + box.height / 2 - st.ty;
          let vx = cx - reactPoint.x;
          let vy = cy - reactPoint.y;
          const d = Math.hypot(vx, vy);
          if (d < 0.001) { vx = 0; vy = -1; } else { vx /= d; vy /= d; }
          const k = Math.max(0, 1 - d / R);
          targetP = k * k * (3 - 2 * k);             // soft falloff
          dx = vx * targetP * R * 0.55;
          dy = vy * targetP * R * 0.55;
        }
        st.tx += (dx - st.tx) * 0.22;                // spring/lerp towards the target
        st.ty += (dy - st.ty) * 0.22;
        st.p += (targetP - st.p) * 0.22;             // amplitude ramps with proximity
        if (st.p < 0.003 && !reactPoint && Math.abs(st.tx) < 0.05 && Math.abs(st.ty) < 0.05) {
          st.tx = st.ty = st.p = 0;
          tile.style.translate = tile.style.rotate = tile.style.scale = '';
          return;
        }
        busy = true;
        const wave = Math.sin(now / 1000 * Math.PI * 2 * 8 + st.phase);   // 8 Hz
        const rot = reduceMotion ? 0 : st.p * 3 * wave;
        const pulse = reduceMotion ? 1 : 1 + st.p * 0.04 * (0.5 + 0.5 * wave);
        tile.style.translate = `${st.tx.toFixed(2)}px ${st.ty.toFixed(2)}px`;
        tile.style.rotate = `${rot.toFixed(2)}deg`;
        tile.style.scale = pulse.toFixed(4);
      });
      if (busy) reactRaf = requestAnimationFrame(reactFrame);
    }
    function reactTo(x, y) {
      reactPoint = { x, y };
      if (!reactRaf) reactRaf = requestAnimationFrame(reactFrame);
    }
    function reactClear() {
      reactPoint = null;
      for (const tile of els.rack.querySelectorAll('.tile')) {
        tile.style.translate = tile.style.rotate = tile.style.scale = '';
        reactState.delete(tile);
      }
    }

    function startPress(source, el, event) {
      if (!canPlace() || press) return;
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      press = {
        source, el, startX: event.clientX, startY: event.clientY, dragging: false, ghost: null,
        pointerId: event.pointerId, touch: event.pointerType !== 'mouse',
      };
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerCancel);
    }

    function onPointerMove(event) {
      if (!press || event.pointerId !== press.pointerId) return;
      const slop = press.touch ? TOUCH_SLOP : MOUSE_SLOP;
      if (!press.dragging && Math.hypot(event.clientX - press.startX, event.clientY - press.startY) > slop) {
        press.dragging = true;
        press.ghost = press.el.cloneNode(true);
        press.ghost.classList.remove('selected', 'pending', 'staged', 'ghost', 'last', 'boosted', 'boost-2', 'boost-3', 'boost-hi');
        for (const badge of press.ghost.querySelectorAll('.m')) badge.remove();
        const src = press.source;
        const entry = src.type === 'board' ? local.pending.find((q) => q.row === src.row && q.col === src.col) : null;
        const letter = src.type === 'rack' ? S.rack[src.index] : (entry ? entry.letter : '');
        const isBlank = src.type === 'rack' ? letter === '?' : !!entry && S.rack[entry.rack_index] === '?';
        press.baseValue = isBlank ? 0 : tileValue(letter);
        press.valueEl = press.ghost.querySelector('.v');
        if (press.valueEl) press.valueEl.textContent = String(press.baseValue);
        press.ghost.classList.add('drag-ghost');
        if (press.touch) press.ghost.classList.add('touch');
        document.body.append(press.ghost);
        press.el.classList.add('dragging');
      }
      if (press.dragging) {
        press.ghost.style.left = `${event.clientX}px`;
        press.ghost.style.top = `${aimY(event.clientY)}px`;
        reactTo(event.clientX, aimY(event.clientY));
        const target = resolveTarget(event.clientX, event.clientY);
        setHighlight(dropIsValid(press.source, target) ? target.el : null);
        if (press.valueEl) {
          const mult = target && target.type === 'cell' ? letterMult(target.row, target.col) : 1;
          press.valueEl.textContent = String(press.baseValue * mult);
        }
      }
    }

    function endPress() {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      reactClear();   // rest positions before any drop logic measures the rack
      if (press) {
        if (press.ghost) press.ghost.remove();
        press.el.classList.remove('dragging');
      }
      setHighlight(null);
      const finished = press;
      press = null;
      return finished;
    }

    function onPointerCancel() { endPress(); }

    function onPointerUp(event) {
      if (!press || event.pointerId !== press.pointerId) return;
      const target = press.dragging ? resolveTarget(event.clientX, event.clientY) : null;
      const p = endPress();
      // Swallow only the synthetic click that follows a tile press; a window any longer eats a
      // quick "tap tile, tap square" on a phone.
      suppressClickUntil = performance.now() + 120;
      if (!canPlace()) return;
      if (!p.dragging) { handleTap(p.source, p.touch); return; }
      if (!dropIsValid(p.source, target)) return;
      if (target.type === 'rack') {
        if (p.source.type === 'rack') reorderRack(p.source.index, event.clientX);
        else removePending(p.source.row, p.source.col);
      } else if (p.source.type === 'rack') {
        placeFromRack(p.source.index, target.row, target.col);
      } else {
        movePending(p.source.row, p.source.col, target.row, target.col);
      }
    }

    function handleTap(source, touch) {
      if (source.type === 'rack') {
        local.selected = local.selected === source.index ? null : source.index;
        local.selectedBoard = null;
        renderRack();
        renderBoard();
        renderPreview();
      } else if (touch) {
        // Fingers are imprecise: a tap only picks the tile up. Where it goes next is a second tap.
        const same = local.selectedBoard && local.selectedBoard.row === source.row && local.selectedBoard.col === source.col;
        local.selectedBoard = same ? null : { row: source.row, col: source.col };
        local.selected = null;
        renderRack();
        renderBoard();
        renderPreview();
      } else {
        removePending(source.row, source.col);
      }
    }

    els.rack.addEventListener('pointerdown', (event) => {
      const tile = event.target.closest('.tile');
      if (!tile || tile.dataset.index === undefined) return;
      startPress({ type: 'rack', index: Number(tile.dataset.index) }, tile, event);
    });

    els.board.addEventListener('pointerdown', (event) => {
      const tile = event.target.closest('.tile.pending');
      if (!tile) return;
      const cell = tile.closest('.cell');
      startPress({ type: 'board', row: Number(cell.dataset.row), col: Number(cell.dataset.col) }, tile, event);
    });

    // Tap a rack tile, then tap a square (the touch-friendly alternative to dragging).
    els.board.addEventListener('click', (event) => {
      if (performance.now() < suppressClickUntil) return;
      const cell = event.target.closest('.cell');
      if (!cell || !canPlace()) return;
      const row = Number(cell.dataset.row);
      const col = Number(cell.dataset.col);
      if (local.selectedBoard) {
        const from = local.selectedBoard;
        local.selectedBoard = null;
        movePending(from.row, from.col, row, col);
        render();
        return;
      }
      if (local.selected === null) return;
      placeFromRack(local.selected, row, col);
    });

    // With a board tile picked up, tapping the rack's empty area takes it back.
    els.rack.addEventListener('click', (event) => {
      if (event.target !== els.rack || !canPlace() || !local.selectedBoard) return;
      const from = local.selectedBoard;
      local.selectedBoard = null;
      removePending(from.row, from.col);
      render();
    });

    // No long-press context menu / image callout on tiles.
    for (const el of [els.rack, els.board]) {
      el.addEventListener('contextmenu', (event) => { if (event.target.closest('.tile')) event.preventDefault(); });
    }

    // ---------- zoom (small screens) ----------
    // The 15x15 board is ~21px per square on a 375px phone. Zoom gives 44px squares in a scrollable frame.
    function centerBoardOn(cell) {
      const box = els.boardScroll;
      if (!cell || box.scrollWidth <= box.clientWidth) return;
      const a = cell.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      box.scrollTo({
        left: box.scrollLeft + (a.left - b.left) + a.width / 2 - box.clientWidth / 2,
        top: box.scrollTop + (a.top - b.top) + a.height / 2 - box.clientHeight / 2,
      });
    }
    function setZoom(on, { center = true, persist = true } = {}) {
      els.boardScroll.classList.toggle('zoomed', on);
      els.zoom.setAttribute('aria-pressed', on ? 'true' : 'false');
      els.zoom.textContent = 'Zoom board';
      if (persist) store.set(ZOOM_KEY, on ? '1' : '0');
      queueMinimap();
      if (on && center && cells.size) {
        const target = local.pending[local.pending.length - 1];
        centerBoardOn(cells.get(target ? `${target.row},${target.col}` : `${config.center[0]},${config.center[1]}`));
      }
    }
    // Zoom factor 1x = 44px squares. Range 0.2x - 8x, eased towards a target on every frame.
    const ZBASE = 44;
    const ZMIN = 0.2;
    const ZMAX = 8;
    const MIN_CELL = ZBASE * ZMIN;
    const MAX_CELL = ZBASE * ZMAX;
    const clampCell = (px) => Math.max(MIN_CELL, Math.min(MAX_CELL, px));
    const currentCell = () => parseFloat(getComputedStyle(els.boardScroll).getPropertyValue('--zoom-cell')) || ZBASE;
    const isZoomed = () => els.boardScroll.classList.contains('zoomed');
    const fitCell = () => { const c = els.board.firstElementChild; return c ? c.offsetWidth : ZBASE; };

    let zCur = null;       // cell size currently applied (px)
    let zTarget = null;    // cell size we are easing towards
    let zAnchor = null;    // {x, y} relative to the board frame; this point stays put while zooming
    let zRaf = 0;
    let zSaveTimer = 0;
    let zImmediate = false;

    function writeCell(px) {
      const box = els.boardScroll;
      const a = zAnchor || { x: box.clientWidth / 2, y: box.clientHeight / 2 };
      const oldW = box.scrollWidth;
      const oldH = box.scrollHeight;
      box.style.setProperty('--zoom-cell', `${px.toFixed(3)}px`);
      // Measure the real size change (gaps and padding do not scale) so the anchor stays put.
      box.scrollLeft = (box.scrollLeft + a.x) * (box.scrollWidth / oldW) - a.x;
      box.scrollTop = (box.scrollTop + a.y) * (box.scrollHeight / oldH) - a.y;
    }
    function zoomFrame() {
      zRaf = 0;
      if (zTarget === null) return;
      if (zCur === null) zCur = currentCell();
      // Ease in log space so zooming in and out feel equally fast.
      const diff = Math.log(zTarget / zCur);
      zCur = (zImmediate || Math.abs(diff) < 0.002) ? zTarget : zCur * Math.exp(diff * 0.28);
      zImmediate = false;
      writeCell(zCur);
      syncZoomPopover();
      if (zCur !== zTarget) { zRaf = requestAnimationFrame(zoomFrame); return; }
      zTarget = null;
      updateMinimap();
      clearTimeout(zSaveTimer);
      zSaveTimer = setTimeout(() => store.set(ZOOM_CELL_KEY, String(Math.round(currentCell()))), 200);
    }
    // Ask for a new square size. `immediate` skips the easing (used by finger pinch, which already tracks the hand).
    function setCellSize(px, anchorX, anchorY, immediate = false) {
      if (!isZoomed()) {
        // Entering zoom from the fit view: start from the size the squares have right now.
        zCur = clampCell(fitCell());
        els.boardScroll.style.setProperty('--zoom-cell', `${zCur}px`);
        setZoom(true, { center: false });
      }
      zAnchor = anchorX === undefined ? null : { x: anchorX, y: anchorY };
      zTarget = clampCell(px);
      if (immediate) zImmediate = true;
      if (!zRaf) zRaf = requestAnimationFrame(zoomFrame);
    }
    const zoomNow = () => (zTarget !== null ? zTarget : (isZoomed() ? currentCell() : fitCell())) / ZBASE;

    // Ctrl/Cmd + wheel (and trackpad pinch, which browsers report as ctrl+wheel) zooms at the cursor.
    els.boardScroll.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;   // plain scrolling is left alone
      event.preventDefault();
      let dy = event.deltaY;
      if (event.deltaMode === 1) dy *= 16;                 // lines -> px
      else if (event.deltaMode === 2) dy *= window.innerHeight;  // pages -> px
      const box = els.boardScroll.getBoundingClientRect();
      setCellSize(zoomNow() * ZBASE * Math.exp(-dy * 0.0015), event.clientX - box.left, event.clientY - box.top);
    }, { passive: false });

    // ---------- zoom popover: a log-scale slider with a draggable ball ----------
    let zPop = null;
    function syncZoomPopover() {
      if (!zPop) return;
      const z = Math.max(ZMIN, Math.min(ZMAX, (zTarget !== null ? zCur || zTarget : (isZoomed() ? currentCell() : fitCell())) / ZBASE));
      const t = Math.log(z / ZMIN) / Math.log(ZMAX / ZMIN);
      zPop.ball.style.left = `${(t * 100).toFixed(2)}%`;
      zPop.label.textContent = `${z.toFixed(z < 1 ? 2 : 1)}×`;
    }
    function closeZoomPopover() {
      if (!zPop) return;
      document.removeEventListener('pointerdown', zPop.onOutside, true);
      document.removeEventListener('keydown', zPop.onKey, true);
      zPop.root.remove();
      zPop = null;
      els.zoom.setAttribute('aria-expanded', 'false');
    }
    function openZoomPopover() {
      if (zPop) { closeZoomPopover(); return; }
      const label = h('span', { class: 'zp-label' });
      const ball = h('div', { class: 'zp-ball', role: 'slider', tabindex: '0', 'aria-label': 'Board zoom',
        'aria-valuemin': String(ZMIN), 'aria-valuemax': String(ZMAX) }, [label]);
      const track = h('div', { class: 'zp-track' }, [ball]);
      const fit = h('button', { class: 'btn btn-small', type: 'button', text: 'Fit board' });
      const root = h('div', { class: 'zoom-pop', role: 'dialog', 'aria-label': 'Zoom' }, [
        h('div', { class: 'zp-ends' }, [h('span', { text: `${ZMIN}×` }), h('span', { text: `${ZMAX}×` })]),
        track, fit,
      ]);
      document.body.append(root);
      const r = els.zoom.getBoundingClientRect();
      const w = root.offsetWidth;
      root.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
      root.style.top = `${Math.min(window.innerHeight - root.offsetHeight - 8, r.bottom + 8)}px`;

      const toZoom = (clientX) => {
        const tr = track.getBoundingClientRect();
        const t = Math.max(0, Math.min(1, (clientX - tr.left) / tr.width));
        return ZMIN * Math.pow(ZMAX / ZMIN, t);
      };
      const feed = (z) => setCellSize(z * ZBASE);   // anchors on the middle of the visible board
      let dragging = false;
      ball.addEventListener('pointerdown', (e) => {
        dragging = true; ball.setPointerCapture(e.pointerId); ball.classList.add('drag'); e.preventDefault();
      });
      ball.addEventListener('pointermove', (e) => { if (dragging) feed(toZoom(e.clientX)); });
      const stop = () => { dragging = false; ball.classList.remove('drag'); };
      ball.addEventListener('pointerup', stop);
      ball.addEventListener('pointercancel', stop);
      track.addEventListener('pointerdown', (e) => { if (e.target === track) feed(toZoom(e.clientX)); });
      ball.addEventListener('keydown', (e) => {
        const k = { ArrowRight: 1.15, ArrowUp: 1.15, ArrowLeft: 1 / 1.15, ArrowDown: 1 / 1.15 }[e.key];
        if (k) { e.preventDefault(); feed(zoomNow() * k); }
      });
      fit.addEventListener('click', () => { zTarget = null; setZoom(false); closeZoomPopover(); });

      const onOutside = (e) => { if (!root.contains(e.target) && !els.zoom.contains(e.target)) closeZoomPopover(); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeZoomPopover(); els.zoom.focus(); } };
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
      zPop = { root, ball, label, onOutside, onKey };
      els.zoom.setAttribute('aria-expanded', 'true');
      syncZoomPopover();
    }
    els.zoom.addEventListener('click', openZoomPopover);

    const savedCell = Number(store.get(ZOOM_CELL_KEY));
    if (savedCell >= MIN_CELL && savedCell <= MAX_CELL) els.boardScroll.style.setProperty('--zoom-cell', `${savedCell}px`);

    // ---------- pan (mouse drag) and pinch zoom (two fingers) ----------
    // One-finger touch panning is the browser's own scrolling; the mouse gets drag-to-scroll on
    // empty board squares (dragging a tentative tile still moves the tile).
    let pan = null;
    els.boardScroll.addEventListener('pointerdown', (event) => {
      const box = els.boardScroll;
      if (event.pointerType !== 'mouse' || event.button !== 0 || press) return;
      if (event.target.closest('.tile.pending')) return;
      if (box.scrollWidth <= box.clientWidth && box.scrollHeight <= box.clientHeight) return;
      pan = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop, moved: false, id: event.pointerId };
    });
    document.addEventListener('pointermove', (event) => {
      if (!pan || event.pointerId !== pan.id) return;
      const dx = event.clientX - pan.x;
      const dy = event.clientY - pan.y;
      if (!pan.moved && Math.hypot(dx, dy) < 5) return;
      pan.moved = true;
      els.boardScroll.classList.add('panning');
      els.boardScroll.scrollLeft = pan.left - dx;
      els.boardScroll.scrollTop = pan.top - dy;
    });
    const endPan = () => {
      if (pan && pan.moved) suppressClickUntil = performance.now() + 150;  // a drag is not a tap on a square
      pan = null;
      els.boardScroll.classList.remove('panning');
    };
    document.addEventListener('pointerup', endPan);
    document.addEventListener('pointercancel', endPan);

    let pinch = null;
    const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    els.boardScroll.addEventListener('touchstart', (event) => {
      if (event.touches.length === 2 && !press) {
        pinch = { dist: touchDist(event.touches), cell: currentCell(), wasZoomed: els.boardScroll.classList.contains('zoomed') };
      }
    }, { passive: true });
    els.boardScroll.addEventListener('touchmove', (event) => {
      if (!pinch || event.touches.length !== 2) return;
      const scale = touchDist(event.touches) / pinch.dist;
      if (!pinch.wasZoomed) {
        if (scale > 1.2) { setZoom(true, { center: false }); pinch.wasZoomed = true; pinch.dist = touchDist(event.touches); }
        return;
      }
      const box = els.boardScroll.getBoundingClientRect();
      const mx = (event.touches[0].clientX + event.touches[1].clientX) / 2 - box.left;
      const my = (event.touches[0].clientY + event.touches[1].clientY) / 2 - box.top;
      if (Math.abs(scale - 1) > 0.01) setCellSize(pinch.cell * scale, mx, my, true);
    }, { passive: true });
    const endPinch = (event) => {
      if (pinch && event.touches.length < 2) {
        pinch = null;
        store.set(ZOOM_CELL_KEY, String(Math.round(currentCell())));
        updateMinimap();
      }
    };
    els.boardScroll.addEventListener('touchend', endPinch, { passive: true });
    els.boardScroll.addEventListener('touchcancel', endPinch, { passive: true });

    // ---------- minimap ----------
    // A small overview of the whole (possibly very large) board with the visible part outlined.
    // Tap or drag on it to jump there. Only shown while the board is zoomed and overflows its frame.
    let minimapQueued = false;
    function updateMinimap() {
      const box = els.boardScroll;
      const canvas = els.minimap;
      if (!S || !builtBounds) return;
      const overflow = box.classList.contains('zoomed')
        && (box.scrollWidth > box.clientWidth + 2 || box.scrollHeight > box.clientHeight + 2);
      canvas.hidden = !overflow;
      if (!overflow) return;
      const b = builtBounds;
      const cols = b.right - b.left + 1;
      const rows = b.bottom - b.top + 1;
      const px = Math.min(canvas.width / cols, canvas.height / rows);
      const ox = (canvas.width - cols * px) / 2;
      const oy = (canvas.height - rows * px) / 2;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(255, 243, 230, .94)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#f3d3b4';
      ctx.fillRect(ox, oy, cols * px, rows * px);
      const [cr, cc] = config.center;
      ctx.fillStyle = '#e1a14a';
      ctx.fillRect(ox + (cc - b.left) * px, oy + (cr - b.top) * px, Math.max(px, 2), Math.max(px, 2));
      ctx.fillStyle = '#6d3bc4';
      for (const key of Object.keys(S.board)) {
        const [r, c] = key.split(',').map(Number);
        ctx.fillRect(ox + (c - b.left) * px, oy + (r - b.top) * px, Math.max(px, 2), Math.max(px, 2));
      }
      ctx.fillStyle = '#e8590c';
      for (const p of local.pending) {
        ctx.fillRect(ox + (p.col - b.left) * px, oy + (p.row - b.top) * px, Math.max(px, 2), Math.max(px, 2));
      }
      ctx.strokeStyle = '#1b1b1b';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        ox + (box.scrollLeft / box.scrollWidth) * cols * px + 0.75,
        oy + (box.scrollTop / box.scrollHeight) * rows * px + 0.75,
        Math.min(1, box.clientWidth / box.scrollWidth) * cols * px - 1.5,
        Math.min(1, box.clientHeight / box.scrollHeight) * rows * px - 1.5,
      );
    }
    const queueMinimap = () => {
      if (minimapQueued) return;
      minimapQueued = true;
      requestAnimationFrame(() => { minimapQueued = false; updateMinimap(); });
    };
    els.boardScroll.addEventListener('scroll', queueMinimap, { passive: true });
    window.addEventListener('resize', queueMinimap);
    function minimapJump(event) {
      const box = els.boardScroll;
      const rect = els.minimap.getBoundingClientRect();
      const b = builtBounds;
      const cols = b.right - b.left + 1;
      const rows = b.bottom - b.top + 1;
      const px = Math.min(els.minimap.width / cols, els.minimap.height / rows);
      const scaleX = els.minimap.width / rect.width;
      const scaleY = els.minimap.height / rect.height;
      const x = ((event.clientX - rect.left) * scaleX - (els.minimap.width - cols * px) / 2) / (cols * px);
      const y = ((event.clientY - rect.top) * scaleY - (els.minimap.height - rows * px) / 2) / (rows * px);
      box.scrollLeft = Math.max(0, Math.min(1, x)) * box.scrollWidth - box.clientWidth / 2;
      box.scrollTop = Math.max(0, Math.min(1, y)) * box.scrollHeight - box.clientHeight / 2;
    }
    els.minimap.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      els.minimap.setPointerCapture(event.pointerId);
      minimapJump(event);
    });
    els.minimap.addEventListener('pointermove', (event) => {
      if (els.minimap.hasPointerCapture(event.pointerId)) minimapJump(event);
    });

    // ---------- buttons ----------
    els.submit.addEventListener('click', () => {
      act('submit_word', {}, (res) => {
        local.pending = [];
        local.selected = null;
        const extra = res.bingo ? ' BINGO!' : '';
        toast(`+${res.score} for ${res.words.join(', ')}.${extra}`);
      });
    });

    els.recall.addEventListener('click', () => {
      if (!canPlace() || local.pending.length === 0) return;
      local.pending = [];
      local.selected = null;
      sendPlacements();
      render();
    });

    els.swap.addEventListener('click', openSwapModal);

    els.shuffle.addEventListener('click', () => {
      if (!S || S.status === 'waiting' || S.rack.length < 2) return;
      const order = rackIndices();
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      local.rackOrder = order.map((i) => S.rack[i]);
      saveRackOrder();
      render();
    });

    els.settingsBtn.addEventListener('click', openSettingsModal);
    els.start.addEventListener('click', () => act('start_game', {}, () => toast('Game started.')));
    els.info.addEventListener('click', openInfoModal);

    els.pass.addEventListener('click', () => {
      if (!myTurn()) return;
      const question = S.awaiting_final ? 'Accept your opponent’s last play and end the game?' : 'Pass your turn?';
      if (!window.confirm(question)) return;
      act('pass', {}, () => { local.pending = []; local.selected = null; });
    });

    els.resign.addEventListener('click', () => {
      if (!S || S.status !== 'playing') return;
      const question = S.players.length === 2
        ? 'Resign the game? Your opponent wins.'
        : 'Resign the game? Your tiles go back into the bag and the others play on.';
      if (!window.confirm(question)) return;
      act('resign', {}, () => { local.pending = []; local.selected = null; toast('You resigned.'); });
    });

    els.timerToggle.addEventListener('click', () => {
      if (!S) return;
      act(S.timer_paused ? 'resume_timer' : 'pause_timer', {}, () => {});
    });

    els.skipTime.addEventListener('click', () => {
      if (!S || !isPlaying()) return;
      const name = S.players[S.current] ? S.players[S.current].name : 'this player';
      if (!window.confirm(`Skip ${name}'s turn?`)) return;
      act('skip_overtime', {}, () => toast('Turn skipped.'));
    });

    els.challenge.addEventListener('click', () => {
      if (!S || !S.can_challenge) return;
      if (!window.confirm('Challenge the last play? If every word is valid you lose your turn.')) return;
      act('challenge_skip', {}, (res) => {
        toast(res.success
          ? `Challenge won! ${res.invalid.join(', ')} not valid – the play was removed.`
          : 'Challenge failed – all words are valid. You lose your turn.');
      });
    });

    $('share-copy').addEventListener('click', async () => {
      const url = els.shareUrl.value;
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied.');
      } catch (_) {
        els.shareUrl.select();
        toast('Press Ctrl/Cmd+C to copy the link.');
      }
    });
    els.shareUrl.addEventListener('focus', () => els.shareUrl.select());

    // ---------- boot ----------
    // The 27x19 board is small on a phone, so start zoomed there unless the player chose otherwise.
    const zoomPref = store.get(ZOOM_KEY);
    if (zoomPref === '1') setZoom(true, { center: false });
    else if (zoomPref === null && window.innerWidth <= 700) setZoom(true, { center: false, persist: false });
    els.modeLabel.textContent = `${modeLabel(document.body.dataset.mode)} · ${LENGTH_LABEL[document.body.dataset.length] || ''}${timerShort(document.body.dataset.timer)}`;
    if (session.token) {
      startSocket(); // saved session token -> rejoin automatically
    } else {
      askName().then((name) => {
        session = { token: null, name };
        startSocket();
      });
    }
  }

  // ------------------------------------------------------------------
  if (document.body.dataset.page === 'game') initGame();
  else initIndex();
})();
