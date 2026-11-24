/* Scrabble client: plain DOM + Socket.IO. The server is the source of truth;
 * this file only renders what it is told and sends intents.
 *
 * Page 1 (index.html):  create a game / join by code / rejoin banner.
 * Page 2 (game.html):   board, rack, drag & drop, live state, game settings.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Small helpers from App.util
  // ------------------------------------------------------------------
  const { $, h, store } = window.App.util;

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
  // Game page
  // ------------------------------------------------------------------
  function initGame() {
    const roomCode = document.body.dataset.room;
    const ACK_TIMEOUT = 8000;
    const BEEP_COOLDOWN_MS = 3000; // Minimum interval between timer overrun alert beeps
    const TIMER_INTERVAL_MS = 250; // Interval for updating turn timer displays
    const TOUCH_SLOP = 12; // Pixel movement threshold for touch drag detection
    const MOUSE_SLOP = 6; // Pixel movement threshold for mouse drag detection
    const TOUCH_LIFT = 56; // Vertical offset for held tiles during touch drag
    const CLICK_SUPPRESS_MS = 120; // Time window to ignore synthetic clicks after a drag/pan
    const PAN_CLICK_SUPPRESS_MS = 250; // Time window to suppress clicks after panning the board
    const ZBASE = 44; // Base cell size in pixels for 1x zoom
    const ZMIN = 0.25; // Minimum board zoom scale limit
    const ZMAX = 8; // Maximum board zoom scale limit
    const MIN_CELL = ZBASE * ZMIN;
    const MAX_CELL = ZBASE * ZMAX;

    let socket = null;
    let config = null;       // static board config from the server (premiums, tile values)
    let S = null;            // latest server view for this player
    let reviewIdx = null;    // turn history: null = live, else index into S.plays shown on the board
    let reviewPlays = 0;
    let bannerPlays = null;  // plays seen so far; null until the first state, so rejoining shows no banner
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
      players: $('players'), history: $('history'), conn: $('conn'),
      toast: $('toast'), share: $('share'), shareUrl: $('share-url'), modalRoot: $('modal-root'),
      submit: $('btn-submit'), recall: $('btn-recall'), swap: $('btn-swap'),
      pass: $('btn-pass'), challenge: $('btn-challenge'),
      resign: $('btn-resign'), timerToggle: $('btn-timer-toggle'), skipTime: $('btn-skip-time'), tracker: $('tracker'), modeLabel: $('mode-label'),
      settingsBtn: $('btn-settings'), cogBtn: $('btn-cog'), info: $('btn-info'), timer: $('timer'),
      boardScroll: $('board-scroll'), zoom: $('btn-zoom'), start: $('btn-start'),
      shuffle: $('btn-shuffle'), minimap: $('minimap'),
      settingsOverlay: $('settings-overlay'), closeSettings: $('btn-close-settings'),
    };
    let cells = new Map();   // "row,col" -> element (absolute board coordinates, may be negative)
    let builtBounds = null;  // bounds the current DOM grid was built for
    let builtMode = null;    // scoring mode the grid's premium squares were drawn for
    let boardCursor = null;  // {row, col} for keyboard board navigation

    // Display text for the game settings (the server owns the actual rules).
    const MODE_INFO = {
      wild: {
        label: 'Wild',
        help: 'Letters hit by a bonus keep it for the rest of the game (letters added to them later are not multiplied). A bingo doubles the main word.',
      },
      classic: {
        label: 'Classic',
        help: 'Traditional scoring: premium squares only count on the turn they are covered and a bingo is a flat 50. A bingo is a flat 50.',
      },
    };
    const LANGUAGE_NAME = { en: 'English', fi: 'Suomi', fr: 'Français', es: 'Español', sv: 'Svenska' };
    const timerText = (key) => window.App.util.timerText(config, key);
    const lengthText = (key) => window.App.util.lengthText(key);
    const timerShort = (key) => (key && key !== 'off' ? ` · ${key} turns` : '');
    // The premium pattern repeats every `premium_period` squares, so the board can grow forever.
    const mod = (n, m) => ((n % m) + m) % m;
    // Wild has its own layout (no triple word squares); Classic is the standard Scrabble board.
    const currentMode = () => (S && S.mode) || document.body.dataset.mode;
    const premiumAt = (row, col) => {
      const wild = currentMode() === 'wild' && config.wild_premiums;
      const period = wild ? (config.wild_period || 24) : (config.premium_period || 14);
      const layout = wild ? config.wild_premiums : config.premiums;
      return layout[`${mod(row, period)},${mod(col, period)}`];
    };
    // Start square for the current mode (Wild matrix centre or classic star).
    const centerOf = () => (currentMode() === 'wild' && config.wild_center) || config.center;
    const letterMult = (row, col) => ({ DL: 2, TL: 3 }[premiumAt(row, col)] || 1);
    let deadlineAt = null;   // local time (ms) at which the current turn's clock runs out
    let pausedLeft = null;   // ms left on a paused (Wild) timer, else null
    let lastBeep = 0;
    const modeLabel = (mode) => (MODE_INFO[mode] ? MODE_INFO[mode].label : mode);

    // ---------- derived state ----------
    const isPlaying = () => !!S && S.status === 'playing';
    const myTurn = () => isPlaying() && S.current === S.you;
    const canEdit = () => myTurn() && !S.awaiting_final;
    // Off-turn players can stage (prepare) a word; it is private and loads into the real
    // tentative placement when their turn starts. Both modes share the same placing UI.
    const canStage = () => isPlaying() && !myTurn() && S.rack.length > 0 && !(S.players[S.you] && S.players[S.you].resigned);
    const canPlace = () => (canEdit() || canStage()) && reviewIdx === null;
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
      els.toast.setAttribute('role', isError ? 'alert' : 'status');
      if (!isError) els.toast.setAttribute('aria-live', 'polite');
      els.toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { els.toast.hidden = true; }, isError ? 5000 : 3500);
    }
    function setConn(kind, text) {
      els.conn.className = `conn conn-${kind}`;
      els.conn.textContent = text;
    }

    // ---------- modals ----------
    function showModal(build, { dismissible = true, onClose = null, opener = document.activeElement } = {}) {
      const backdrop = h('div', { class: 'modal-backdrop' });
      const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
      backdrop.append(modal);
      let removeTrap = null;
      const api = {
        modal,
        close() {
          if (removeTrap) removeTrap();
          document.removeEventListener('keydown', onKey);
          backdrop.remove();
          if (opener && typeof opener.focus === 'function') {
            try { opener.focus(); } catch (_) {}
          }
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
      if (window.App.util && window.App.util.trapFocus) {
        removeTrap = window.App.util.trapFocus(modal, dismissible ? () => api.close() : null);
      } else {
        const focusable = modal.querySelector('input, button');
        if (focusable) focusable.focus();
      }
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

    // (Re)build or update the grid for the current bounds. The server grows the board as tiles get
    // near an edge, updating cells via cells.get(key) reference map without full teardown when possible.
    function buildBoard() {
      const b = boundsOf();
      const prev = builtBounds;
      const modeChanged = builtMode !== currentMode();
      const boundsDiff = boundsChanged(prev, b);

      if (!prev || boundsDiff || modeChanged || cells.size === 0) {
        els.board.replaceChildren();
        cells = new Map();
        els.board.style.setProperty('--cols', String(b.right - b.left + 1));
        els.board.style.setProperty('--rows', String(b.bottom - b.top + 1));
        const [centerRow, centerCol] = centerOf();
        const fragment = document.createDocumentFragment();
        for (let r = b.top; r <= b.bottom; r += 1) {
          for (let c = b.left; c <= b.right; c += 1) {
            const kind = premiumAt(r, c);
            const isCenter = r === centerRow && c === centerCol;
            const cell = h('div', {
              class: `cell${kind ? ` ${kind.toLowerCase()}` : ''}${isCenter ? ' center' : ''}`,
              role: 'gridcell',
              dataset: { row: String(r), col: String(c) },
            });
            cell.dataset.label = isCenter ? '★' : ({ DL: '2L', TL: '3L', DW: '2W', TW: '3W' }[kind] || '');
            cell.dataset.sig = '';
            fragment.append(cell);
            cells.set(`${r},${c}`, cell);
          }
        }
        els.board.append(fragment);
        builtBounds = { ...b };
        builtMode = currentMode();
        if (prev && boundsDiff) {
          const sample = els.board.firstElementChild;
          const step = sample ? sample.offsetWidth + 3 : 0;
          els.boardScroll.scrollLeft += (prev.left - b.left) * step;
          els.boardScroll.scrollTop += (prev.top - b.top) * step;
        }
        return;
      }

      // If bounds and mode are unchanged, we do not need to rebuild the DOM structure at all.
    }

    // `boost` is the letter multiplier shown on the tile: the one a tile on the board
    // earned (Wild keeps it for good) or the one of the square a tentative tile sits on.
    // `tint` colours boosted tiles (Wild mode) so everyone can see which were multiplied.
    function makeTile(letter, blank, extra = '', boost = 1, tint = false, row = null, col = null) {
      const children = [h('span', { class: 'l', text: letter || '' })];
      const val = !blank ? tileValue(letter) * (!blank && boost > 1 ? boost : 1) : 0;
      if (!blank) children.push(h('span', { class: 'v', text: String(val) }));
      const tinted = !blank && boost > 1 && tint;
      const boostClass = !blank && boost >= 4 ? 'boost-hi' : `boost-${!blank && boost > 1 ? boost : 1}`;
      const cls = `tile${blank ? ' blank' : ''}${tinted ? ` boosted ${boostClass}` : ''}${extra ? ` ${extra}` : ''}`;
      if (tinted && !blank && boost >= 4) children.push(h('span', { class: 'm', text: `x${boost}` }));
      const tile = h('div', { class: cls }, children);
      if (tinted) tile.setAttribute('title', `Worth ${val} (x${boost} bonus kept)`);
      if (row !== null && col !== null && !blank && letter) {
        tile.setAttribute('aria-label', `Letter ${letter}, ${val} point${val === 1 ? '' : 's'}, row ${row}, column ${col}`);
      } else if (row !== null && col !== null && blank) {
        tile.setAttribute('aria-label', `Blank tile, row ${row}, column ${col}`);
      }
      return tile;
    }

    // ---------- post-game victory screen ----------
    function renderVictory() {
      if (window.App.victory && window.App.victory.renderVictory) {
        window.App.victory.renderVictory(S, act, (letter, blank, extra, boost, tint) => makeTile(letter, blank, extra, boost, tint));
      }
    }

    // ---------- diff-based rendering optimizations ----------
    let lastRenderStateSig = null;

    function render() {
      renderVictory();
      if (!S || !config) return;
      
      const b = boundsOf();
      const currentBoundsSig = `${b.top},${b.bottom},${b.left},${b.right}`;
      const modeSig = currentMode();
      
      if (boundsChanged(builtBounds, b) || builtMode !== modeSig) {
        const first = !builtBounds;
        buildBoard();
        if (first && els.boardScroll.classList.contains('zoomed')) centerBoardOn(cells.get(`${centerOf()[0]},${centerOf()[1]}`));
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
      
      if (window.App.bag) window.App.bag.renderBagUi(S);
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
      const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
      const check = S.auto_check !== undefined ? S.auto_check : S.mode === 'wild';
      set('set-language', LANGUAGE_NAME[S.language] || S.language || '');
      set('set-check', check ? 'On (automatic word check)' : 'Off (no automatic validation)');
      set('set-timer', timerText(S.timer));
      set('set-length', lengthText(S.length));
      const lock = $('settings-lock');
      if (lock) lock.hidden = !locked;
      const note = $('settings-note');
      if (note) note.textContent = locked
        ? 'Settings are locked because the first turn has been played. Restart the game to change them.'
        : 'Anyone in the room can change these until the first turn is played.';
      const group = $('game-settings');
      if (group) group.classList.toggle('is-locked', !!locked);
      const restart = $('btn-restart');
      if (restart) restart.disabled = S.status === 'waiting';
    }

    function confirmRestart() {
      if (!S || S.status === 'waiting') return;
      showModal((modal, api) => {
        modal.append(
          h('h2', { text: 'Restart game?' }),
          h('p', { text: 'The board is cleared, all scores and timers are reset and every rack is dealt again from a fresh bag. Players stay in the room.' }),
          h('div', { class: 'actions' },
            h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => api.close() }),
            h('button', { class: 'btn btn-primary', type: 'button', text: 'Restart', onclick: () => {
              api.close();
              act('restart_game', {}, () => toast('Game restarted.'));
            } })),
        );
      });
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
        const autoCheckChk = h('input', { type: 'checkbox', checked: S.auto_check !== undefined ? S.auto_check : (S.mode === 'wild') });
        const languages = config.languages || [config.default_language];
        const languageSel = h('select', { 'aria-label': 'Language' },
          languages.map((l) => option(l, LANGUAGE_NAME[l] || l)));
        const help = h('p', { class: 'hint' });
        const showHelp = () => { help.textContent = (MODE_INFO[modeSel.value] || {}).help || ''; };
        const rack = config.rack_size || 7;
        const fits = (length, players) => players * rack <= config.lengths[length];
        const syncLengths = () => {
          const players = Number(S.max_players || 2);
          for (const opt of lengthSel.options) {
            opt.disabled = !fits(opt.value, players);
            opt.title = opt.disabled ? `Not enough tiles for ${players} players` : '';
          }
          if (!fits(lengthSel.value, players)) {
            const ordered = Object.keys(config.lengths).sort((a, b) => config.lengths[a] - config.lengths[b]);
            lengthSel.value = ordered.find((l) => fits(l, players)) || ordered[ordered.length - 1];
          }
        };
        const initAndSyncSettings = () => {
          languageSel.value = S.language;
          modeSel.value = S.mode;
          lengthSel.value = S.length;
          timerSel.value = S.timer;
          showHelp();
          syncLengths();
        };
        const distChk = h('input', { type: 'checkbox', checked: S.show_distribution !== false });
        const distField = h('label', { class: 'field-row' }, distChk, h('span', { text: ' Show tile distribution in the tile bag' }));
        const autoCheckField = h('label', { class: 'field-row' }, autoCheckChk, h('span', { text: ' Automatic word check (off = players can challenge)' }));
        const autoCheckRow = h('div', { class: 'field' }, autoCheckField);
        // Switching mode moves the checkbox to that mode's default (Wild on, Classic off) unless it was changed by hand.
        let checkTouched = false;
        autoCheckChk.addEventListener('change', () => { checkTouched = true; });
        modeSel.addEventListener('change', () => {
          if (!checkTouched) autoCheckChk.checked = modeSel.value === 'wild' ? true : false;
          showHelp(); syncLengths();
        });
        initAndSyncSettings();
        const field = (label, el) => h('label', { class: 'field' }, h('span', { text: label }), el);
        const save = () => {
          const change = {};
          if (modeSel.value !== S.mode) change.mode = modeSel.value;
          if (lengthSel.value !== S.length) change.length = lengthSel.value;
          if (timerSel.value !== S.timer) change.timer = timerSel.value;
          if (languageSel.value !== S.language) change.language = languageSel.value;
          if (autoCheckChk.checked !== (S.auto_check !== undefined ? S.auto_check : S.mode === 'wild')) {
            change.auto_check = autoCheckChk.checked;
          } else if (change.mode && S.auto_check !== undefined && checkTouched) {
            change.auto_check = autoCheckChk.checked;
          }
          if (distChk.checked !== (S.show_distribution !== false)) change.show_distribution = distChk.checked;
          api.close();
          if (Object.keys(change).length) act('update_settings', change, () => toast('Game settings updated.'));
        };
        modal.append(
          h('h2', { text: 'Game Settings' }),
          h('p', { text: 'Anyone in the room can change these until the first turn is played.' }),
          field('Scoring', modeSel), help,
          autoCheckRow, h('div', { class: 'field' }, distField),
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
          h('p', { text: '2 to 16 players take turns placing letters on a shared board to make words, crossword-style. In Wild the board starts at 25 by 25 squares and keeps growing as words reach its edges; Classic uses the standard fixed 15 by 15 board. High-value letters and special squares earn more points.' }),
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
        if (myTurn() && Date.now() - lastBeep > BEEP_COOLDOWN_MS) { lastBeep = Date.now(); beep(); }
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
    setInterval(renderTimer, TIMER_INTERVAL_MS);

    function renderBanner() {
      let text;
      let cls;
      const opp = opponent();
      if (S.status === 'waiting') {
        els.banner.textContent = '';
        els.banner.className = 'turn-banner ll-turn';
        return;
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
      els.banner.className = `turn-banner ll-turn ${cls}`;
      const tn = $('turn-number');
      if (tn) tn.textContent = `Turn ${(S.history ? S.history.filter((e) => e.kind !== 'system').length : 0) + 1}`;
      const bub = $('bottom-sheet-status-text');
      if (bub && S.status !== 'waiting') bub.textContent = myTurn() ? "It's your turn!" : text;
    }

    // ---------- turn history arrows: step the board back through the plays ----------
    const reviewing = () => reviewIdx !== null;
    function reviewCells() {   // squares to hide: tiles from plays after the one being viewed
      const hidden = new Set();
      if (!reviewing()) return hidden;
      for (const p of S.plays.slice(reviewIdx + 1)) for (const [r, c] of p.cells) hidden.add(`${r},${c}`);
      return hidden;
    }
    function stepReview(dir) {
      const n = (S.plays || []).length;
      if (!n) return;
      if (reviewIdx === null) { if (dir < 0) reviewIdx = n - 1; else return; }
      else {
        reviewIdx += dir;
        if (reviewIdx >= n) reviewIdx = null;          // forward from the latest turn = back to live
        else if (reviewIdx < 0) reviewIdx = 0;
      }
      local.selected = null; local.selectedBoard = null;
      render();
    }
    function showPlayBanner(play) {
      const old = document.querySelector('.play-banner');
      if (old) old.remove();
      const el = h('div', { class: 'play-banner', role: 'status', 'aria-live': 'polite' },
        h('div', { class: 'play-banner-word', text: play.words.join(' · ') }),
        h('div', { class: 'play-banner-score', text: `+${play.score} point${play.score === 1 ? '' : 's'}` }));
      el.addEventListener('animationend', () => el.remove());
      document.body.append(el);
    }
    function renderReview() {
      const n = (S.plays || []).length;
      if (bannerPlays !== null && n > bannerPlays && !document.hidden) showPlayBanner(S.plays[n - 1]);
      bannerPlays = n;
      if (n !== reviewPlays) { reviewPlays = n; reviewIdx = null; }   // a new play (or take-back) returns to live
      const box = $('turn-review');
      const prev = $('turn-prev'), next = $('turn-next');
      if (prev) prev.disabled = !n || reviewIdx === 0;
      if (next) next.disabled = !reviewing();
      if (!box) return;
      box.hidden = !reviewing();
      if (!reviewing()) return;
      const p = S.plays[reviewIdx];
      box.replaceChildren(h('b', { text: p.words.join(', ') }), h('span', { text: ` +${p.score} points · ${p.name} (play ${reviewIdx + 1} of ${n})` }));
    }
    if ($('turn-prev')) $('turn-prev').addEventListener('click', () => stepReview(-1));
    if ($('turn-next')) $('turn-next').addEventListener('click', () => stepReview(1));

    function renderBoard() {
      renderReview();
      const hiddenCells = reviewCells();
      const reviewLast = reviewing() ? new Set(S.plays[reviewIdx].cells.map(([r, c]) => `${r},${c}`)) : null;
      const lastCells = reviewLast || new Set((S.last_move ? S.last_move.cells : []).map(([r, c]) => `${r},${c}`));
      const mine = new Map();   // my tentative tiles (my turn) or my staged tiles (off turn)
      // Unplayed tiles are private: the opponent's tentative tiles are never drawn.
      const staging = !canEdit() && canStage();
      if ((canEdit() || staging) && !reviewing()) {
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
          const placed = hiddenCells.has(key) ? undefined : S.board[key];
          const isCursor = boardCursor && boardCursor.row === r && boardCursor.col === c;
          let sig;
          let kind = null;
          let info = null;
          let sel = false;
          if (placed) {
            kind = lastCells.has(key) ? 'last' : '';
            info = { letter: placed.l, blank: placed.b, boost: placed.m || 1 };
            sig = `b:${placed.l}:${placed.b ? 1 : 0}:${info.boost}:${kind}:${isCursor ? 1 : 0}`;
          } else if (mine.has(key)) {
            kind = staging ? 'pending staged' : 'pending';
            info = mine.get(key);
            sel = !!sb && sb.row === r && sb.col === c;
            sig = `p${staging ? 's' : ''}:${S.mode}:${info.letter}:${info.blank ? 1 : 0}:${info.boost}:${sel ? 1 : 0}:${isCursor ? 1 : 0}`;
          } else if (oppSet.has(key)) {
            sig = `o:${isCursor ? 1 : 0}`;   // opponent is placing a tile here: outline only, no letter
          } else {
            sig = `e:${isCursor ? 1 : 0}`;
          }
          cell.classList.toggle('can-drop', !info && placing);
          cell.classList.toggle('board-cursor', isCursor);
          if (cell.dataset.sig === sig) continue;
          cell.dataset.sig = sig;
          cell.replaceChildren();
          if (sig.startsWith('o')) {
            cell.append(h('div', { class: 'tile opp-ghost', 'aria-label': 'Opponent is placing a tile here' }));
          } else if (info) {
            const tile = makeTile(info.letter, info.blank, sel ? `${kind} selected` : kind, info.boost || 1, S.mode === 'wild', r, c);
            if (kind.startsWith('pending')) {
              tile.setAttribute('title', (staging ? 'Staged for your next turn. ' : '')
                + 'Drag to move. Tap to pick it up, then tap a square (or the rack to take it back).');
            }
            cell.append(tile);
          } else if (cell.dataset.label) {
            const labelSpan = h('span', { class: 'cell-label', text: cell.dataset.label });
            cell.append(labelSpan);
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
      const totalActive = S.players.length;
      const showPlaceholder = S.status === 'waiting' && totalActive < (S.max_players || 2);
      const totalSlots = totalActive + (showPlaceholder ? 1 : 0);
      els.players.classList.toggle('many', totalSlots > 4);

      let overlayPanel = document.querySelector('.ll-players');
      const toggleBtn = document.getElementById('btn-toggle-players');
      if (toggleBtn && overlayPanel && !toggleBtn._wired) {
        toggleBtn._wired = true;
        toggleBtn.addEventListener('click', () => {
          overlayPanel.classList.toggle('collapsed');
          const isCollapsed = overlayPanel.classList.contains('collapsed');
          toggleBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
          toggleBtn.textContent = isCollapsed ? `▼ Players (${totalActive})` : '▲ Hide';
        });
      }
      if (toggleBtn && overlayPanel) {
        const isCollapsed = overlayPanel.classList.contains('collapsed');
        toggleBtn.textContent = isCollapsed ? `▼ Players (${totalActive})` : '▲ Hide';
      }

      // DOM Node Recycling: update existing player cards or create/remove as needed
      const existingCards = Array.from(els.players.children);
      
      // Update or create active player cards
      S.players.forEach((p, index) => {
        const active = S.status === 'playing' && S.current === p.seat;
        let card = existingCards[index];
        
        if (!card || card.classList.contains('waiting') !== false && !card.dataset.playerSeat) {
          card = h('div', { class: 'player-card' });
          card.dataset.playerSeat = String(p.seat);
          if (existingCards[index]) {
            els.players.replaceChild(card, existingCards[index]);
          } else {
            els.players.append(card);
          }
        }
        
        card.className = `player-card${active ? ' active' : ''}${p.resigned ? ' resigned' : ''}`;
        card.style.setProperty('--seat-hue', String(seatHue(p.seat)));
        card.dataset.playerSeat = String(p.seat);

        // Update name part
        let nameEl = card.querySelector('.name');
        if (!nameEl) {
          nameEl = h('div', { class: 'name' },
            h('span', { class: `dot${p.connected ? ' on' : ''}`, title: p.connected ? 'Online' : 'Offline' }),
            h('span', { class: 'nm', text: p.name }),
            p.seat === S.you ? h('span', { class: 'you', text: 'you' }) : null,
            p.resigned ? h('span', { class: 'you', text: 'resigned' }) : null
          );
          card.prepend(nameEl);
        } else {
          const dot = nameEl.querySelector('.dot');
          if (dot) dot.className = `dot${p.connected ? ' on' : ''}`;
          const nm = nameEl.querySelector('.nm');
          if (nm) nm.textContent = p.name;
          let youSpan = nameEl.querySelector('.you');
          if (p.seat === S.you && !youSpan) {
            nameEl.append(h('span', { class: 'you', text: 'you' }));
          } else if (p.seat !== S.you && youSpan && youSpan.textContent === 'you') {
            youSpan.remove();
          }
        }

        // Update score
        let scoreEl = card.querySelector('.score');
        if (!scoreEl) {
          scoreEl = h('div', { class: 'score', text: String(p.score) });
          card.append(scoreEl);
        } else {
          scoreEl.textContent = String(p.score);
        }

        // Update racks & mini tiles
        let racksEl = card.querySelector('.racks');
        const minis = h('span', { class: 'mini-tiles' });
        for (let i = 0; i < p.rack_count; i += 1) minis.append(h('i'));
        if (!racksEl) {
          racksEl = h('div', { class: 'racks' }, minis, `${p.rack_count} tile${p.rack_count === 1 ? '' : 's'}`);
          card.append(racksEl);
        } else {
          racksEl.replaceChildren(minis, `${p.rack_count} tile${p.rack_count === 1 ? '' : 's'}`);
        }

        // Update skippable button
        let skipBtn = card.querySelector('.btn-skip');
        if (S.skippable === p.seat) {
          if (!skipBtn) {
            skipBtn = h('button', {
              class: 'btn btn-skip', type: 'button', text: 'Skip (offline)',
              title: `${p.name} has been offline for a while. Pass for them so the game can go on.`,
              onclick: () => act('skip_player', { seat: p.seat }, () => toast(`${p.name} was skipped.`)),
            });
            card.append(skipBtn);
          }
        } else if (skipBtn) {
          skipBtn.remove();
        }
      });

      // Handle single placeholder slot if waiting
      let placeholderEl = existingCards[S.players.length];
      if (showPlaceholder) {
        if (!placeholderEl || !placeholderEl.classList.contains('waiting')) {
          placeholderEl = h('div', { class: 'player-card waiting' },
            h('div', { class: 'name' }, h('span', { class: 'dot' }), h('span', { class: 'nm', text: 'Waiting for player…' })),
            h('div', { class: 'score', text: '–' }));
          placeholderEl.dataset.placeholder = 'true';
          if (els.players.children[S.players.length]) {
            els.players.replaceChild(placeholderEl, els.players.children[S.players.length]);
          } else {
            els.players.append(placeholderEl);
          }
        }
      }

      // Trim excess child nodes beyond active + placeholder
      while (els.players.children.length > totalSlots) {
        els.players.lastElementChild.remove();
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
        const mark = w.valid === true ? '✓ [Valid] ' : (w.valid === false ? '✗ [Invalid] ' : '• [Checking] ');
        const icon = w.valid === true ? '✅ ' : (w.valid === false ? '⚠️ ' : 'ℹ️ ');
        parts.push(h('span', { class: w.valid === false ? 'pv-bad' : (w.valid === true ? 'pv-good' : ''), text: `${icon}${mark}${w.word} ${w.score}` }));
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
      const waiting = S && S.status === 'waiting';

      // Toggle visibility/minimized state based on game start status
      const actionControlsEl = document.querySelector('.mobile-action-controls');
      const bottomSheet = document.querySelector('.ll-bottom');
      const statusTextEl = document.getElementById('bottom-sheet-status-text');
      if (waiting) {
        if (actionControlsEl) actionControlsEl.style.display = 'none';
        if (bottomSheet) bottomSheet.classList.add('game-not-started');
        const menuEl = $('unified-drawer-secondary-section');
        if (menuEl && !menuEl._auto) { menuEl._auto = true; menuEl.hidden = false; }
        
        document.body.classList.remove('game-active');
      } else {
        if (actionControlsEl) actionControlsEl.style.display = '';
        if (bottomSheet) bottomSheet.classList.remove('game-not-started');
        
        document.body.classList.add('game-active');
      }

      const submitDisabled = !(edit && hasPending && previewOk && local.inflight === 0 && !busy);
      const recallDisabled = !((edit || staging) && hasPending);
      const swapDisabled = !(edit && S.bag_count >= config.rack_size && !busy);
      const passDisabled = !(myTurn() && !busy);
      const shuffleDisabled = waiting || S.rack.length < 2;
      const challengeDisabled = !(S.can_challenge && !busy);
      const resignDisabled = busy;

      els.submit.disabled = submitDisabled;
      els.submit.classList.toggle('btn-ghost', submitDisabled);
      els.submit.textContent = staging && hasPending ? 'Staged' : 'Play';
      els.submit.title = staging && hasPending ? 'Your staged word loads on your turn; then press Play word.' : '';

      els.recall.disabled = recallDisabled;
      els.recall.classList.toggle('btn-ghost', recallDisabled);

      els.swap.disabled = swapDisabled;
      els.swap.classList.toggle('btn-ghost', swapDisabled);
      els.swap.title = S.bag_count < config.rack_size ? 'Fewer than 7 tiles left in the bag' : '';

      els.pass.disabled = passDisabled;
      els.pass.classList.toggle('btn-ghost', passDisabled);
      els.pass.textContent = S.awaiting_final ? 'Accept & end game' : 'Pass Turn';

      els.shuffle.disabled = shuffleDisabled;
      els.shuffle.classList.toggle('btn-ghost', shuffleDisabled);

      els.challenge.hidden = S.rules !== 'challenge';
      els.challenge.disabled = challengeDisabled;
      els.challenge.classList.toggle('btn-ghost', challengeDisabled);

      const me = S.players[S.you];
      els.resign.hidden = !(S.status === 'playing' && me && !me.resigned);
      els.resign.disabled = resignDisabled;
      els.resign.classList.toggle('btn-ghost', resignDisabled);
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
      const hadLast = S && S.final_round != null;
      S = msg.state;
      if (!hadLast && S.final_round != null && S.status === 'playing') toast('Last turn triggered! Every other player gets one final turn.');
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
      suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
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

    if (window.App.zoom && window.App.zoom.initZoom) {
      window.App.zoom.initZoom(els, config, () => cells, () => local, centerOf, queueMinimap);
    }

    // ---------- keyboard play navigation ----------
    document.addEventListener('keydown', async (event) => {
      if (!S || S.status !== 'playing') return;
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;

      const placeable = canPlace();
      const indices = placeable ? rackIndices().filter((i) => !local.pending.some((p) => p.rack_index === i)) : [];

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (indices.length === 0) return;
        event.preventDefault();
        let curIdx = local.selected !== null ? indices.indexOf(local.selected) : -1;
        if (event.key === 'ArrowLeft') {
          curIdx = curIdx <= 0 ? indices.length - 1 : curIdx - 1;
        } else {
          curIdx = curIdx < 0 || curIdx >= indices.length - 1 ? 0 : curIdx + 1;
        }
        local.selected = indices[curIdx];
        local.selectedBoard = null;
        renderRack();
        renderBoard();
        renderPreview();
        return;
      }

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (!builtBounds) return;
        event.preventDefault();
        if (!boardCursor) {
          const [cr, cc] = centerOf();
          boardCursor = { row: cr, col: cc };
        } else {
          let dr = 0, dc = 0;
          if (event.key === 'ArrowUp') dr = -1;
          if (event.key === 'ArrowDown') dr = 1;
          if (event.key === 'ArrowLeft') dc = -1;
          if (event.key === 'ArrowRight') dc = 1;
          boardCursor.row += dr;
          boardCursor.col += dc;
        }
        renderBoard();
        const cell = cells.get(`${boardCursor.row},${boardCursor.col}`);
        if (cell) cell.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        return;
      }

      if (event.key === 'Enter') {
        if (!placeable) return;
        event.preventDefault();
        if (!boardCursor) {
          const [cr, cc] = centerOf();
          boardCursor = { row: cr, col: cc };
        }
        const r = boardCursor.row;
        const c = boardCursor.col;

        // If there's a tentative tile on boardCursor, pick it up or remove it
        const existingPending = local.pending.find((p) => p.row === r && p.col === c);
        if (existingPending) {
          local.selected = existingPending.rack_index;
          removePending(r, c);
          render();
          return;
        }

        // If a rack tile is selected, place it at boardCursor
        if (local.selected !== null) {
          await placeFromRack(local.selected, r, c);
        }
      }
    });

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
      const [cr, cc] = centerOf();
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
    if ($('btn-restart')) $('btn-restart').addEventListener('click', confirmRestart);
    if (els.cogBtn) {
      els.cogBtn.addEventListener('click', () => {
        const secondarySec = $('unified-drawer-secondary-section');
        const bottomSheet = document.querySelector('.ll-bottom');
        if (secondarySec && bottomSheet) {
          bottomSheet.classList.remove('collapsed-drawer');
          const toggleBtn = $('btn-toggle-drawer');
          if (toggleBtn) {
            toggleBtn.setAttribute('aria-expanded', 'true');
            toggleBtn.textContent = '▲ Hide Drawer';
          }
          secondarySec.hidden = !secondarySec.hidden;
          const trackerEl = $('tracker');
          if (trackerEl && !secondarySec.hidden) {
            trackerEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        } else if (els.settingsOverlay) {
          els.settingsOverlay.hidden = false;
        } else {
          openSettingsModal();
        }
      });
    }
    const drawerStatsToggle = $('btn-drawer-tracker-toggle');
    if (drawerStatsToggle) {
      drawerStatsToggle.addEventListener('click', () => {
        const secondarySec = $('unified-drawer-secondary-section');
        if (secondarySec) {
          secondarySec.hidden = !secondarySec.hidden;
          if (!secondarySec.hidden) {
            const trackerEl = $('tracker');
            if (trackerEl) trackerEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
      });
    }
    const drawerToggleBtn = $('btn-toggle-drawer');
    const bottomSheetEl = document.querySelector('.ll-bottom');
    if (drawerToggleBtn && bottomSheetEl) {
      if (!drawerToggleBtn.hasAttribute('aria-label')) {
        drawerToggleBtn.setAttribute('aria-label', 'Toggle drawer');
      }
      drawerToggleBtn.addEventListener('click', () => {
        bottomSheetEl.classList.toggle('collapsed-drawer');
        const isCollapsed = bottomSheetEl.classList.contains('collapsed-drawer');
        drawerToggleBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
        drawerToggleBtn.textContent = isCollapsed ? '▼ Show Drawer' : '▲ Hide Drawer';
      });
    }
    if (els.closeSettings && els.settingsOverlay) {
      els.closeSettings.addEventListener('click', () => {
        els.settingsOverlay.hidden = true;
      });
      els.settingsOverlay.addEventListener('pointerdown', (e) => {
        if (e.target === els.settingsOverlay) els.settingsOverlay.hidden = true;
      });
    }
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

    if (window.App.bag) window.App.bag.initBag(() => S);

    // ---------- boot ----------
    // The 25x25 board is small on a phone, so start zoomed there on mobile viewports (<= 700px) unless saved otherwise.
    const zoomPref = store.get(ZOOM_KEY);
    if (zoomPref === '1' || (zoomPref === null && window.innerWidth <= 700)) {
      setZoom(true, { center: false, persist: zoomPref !== null });
    }
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
})();

// Fixed viewport: never let the page itself scroll or browser-zoom with the wheel.
document.addEventListener('wheel', (e) => { if (e.ctrlKey || !e.target.closest('.ll-menu, .ll-players-body, .modal')) e.preventDefault(); }, { passive: false });
