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

    createBtn.addEventListener('click', async () => {
      createBtn.disabled = true;
      createError.hidden = true;
      try {
        const res = await fetch('/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
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
    const BOARD_SIZE = 15;
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
    const local = { pending: [], selected: null, selectedBoard: null, inflight: 0 };

    const els = {
      board: $('board'), rack: $('rack'), preview: $('preview'), banner: $('turn-banner'),
      players: $('players'), history: $('history'), bag: $('bag-count'), conn: $('conn'),
      toast: $('toast'), share: $('share'), shareUrl: $('share-url'), modalRoot: $('modal-root'),
      submit: $('btn-submit'), recall: $('btn-recall'), swap: $('btn-swap'),
      pass: $('btn-pass'), challenge: $('btn-challenge'), modeLabel: $('mode-label'),
      settingsBtn: $('btn-settings'), info: $('btn-info'), timer: $('timer'),
      boardScroll: $('board-scroll'), zoom: $('btn-zoom'),
    };
    let cells = [];          // cells[row][col] -> element

    // Display text for the game settings (the server owns the actual rules).
    const MODE_INFO = {
      wild: {
        label: 'Wild',
        help: 'Words are checked automatically. A tile placed on a double or triple letter square keeps that bonus for the rest of the game.',
      },
      classic: {
        label: 'Classic',
        help: 'Traditional scoring: premium squares only count when the tile is placed. Any play is accepted and your opponent may challenge it.',
      },
    };
    const LENGTH_LABEL = { short: 'Short', medium: 'Medium', full: 'Full' };
    const timerText = (key) => {
      const secs = config && config.timers ? config.timers[key] : 0;
      if (!secs) return 'No timer';
      return secs < 120 ? `${secs} seconds per turn` : `${secs / 60} minutes per turn`;
    };
    const timerShort = (key) => (key && key !== 'off' ? ` · ${key} turns` : '');
    const letterMult = (row, col) => ({ DL: 2, TL: 3 }[config.premiums[`${row},${col}`]] || 1);
    let deadlineAt = null;   // local time (ms) at which the current turn's clock runs out
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
    const canStage = () => isPlaying() && !myTurn() && S.rack.length > 0;
    const canPlace = () => canEdit() || canStage();
    const opponent = () => (S ? S.players.find((p) => p.seat !== S.you) || null : null);
    const tileValue = (letter) => (config && config.values[letter]) || 0;

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
          for (let code = 65; code <= 90; code += 1) {
            const letter = String.fromCharCode(code);
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
        S.rack.forEach((letter, index) => {
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
    function buildBoard() {
      els.board.replaceChildren();
      cells = [];
      const [centerRow, centerCol] = config.center;
      for (let r = 0; r < BOARD_SIZE; r += 1) {
        const row = [];
        for (let c = 0; c < BOARD_SIZE; c += 1) {
          const kind = config.premiums[`${r},${c}`];
          const isCenter = r === centerRow && c === centerCol;
          const cell = h('div', {
            class: `cell${kind ? ` ${kind.toLowerCase()}` : ''}${isCenter ? ' center' : ''}`,
            role: 'gridcell',
            dataset: { row: String(r), col: String(c) },
          });
          cell.dataset.label = isCenter ? '★' : (kind || '');
          cell.dataset.sig = '';
          els.board.append(cell);
          row.push(cell);
        }
        cells.push(row);
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
      const cls = `tile${blank ? ' blank' : ''}${tinted ? ` boosted boost-${mult}` : ''}${extra ? ` ${extra}` : ''}`;
      const tile = h('div', { class: cls }, children);
      if (tinted) tile.setAttribute('title', `Worth ${tileValue(letter) * mult} (x${mult} letter bonus)`);
      return tile;
    }

    // ---------- rendering ----------
    function render() {
      if (!S || !config) return;
      if (!cells.length) {
        buildBoard();
        if (els.boardScroll.classList.contains('zoomed')) centerBoardOn(cells[config.center[0]][config.center[1]]);
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
      els.bag.textContent = String(S.bag_count);
      renderSettingsButton();
      renderTimer();
      els.modeLabel.textContent = `${modeLabel(S.mode)} · ${lengthText(S.length)}${timerShort(S.timer)}`;
      els.share.hidden = S.status !== 'waiting';
      if (S.status === 'waiting') els.shareUrl.value = `${window.location.origin}/join/${roomCode}`;
      document.title = `${myTurn() ? '▶ ' : ''}Scrabble – ${roomCode}`;
      showGameOver();
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
        modeSel.value = S.mode;
        lengthSel.value = S.length;
        timerSel.value = S.timer;
        const help = h('p', { class: 'hint' });
        const showHelp = () => { help.textContent = (MODE_INFO[modeSel.value] || {}).help || ''; };
        modeSel.addEventListener('change', showHelp);
        showHelp();
        const field = (label, el) => h('label', { class: 'field' }, h('span', { text: label }), el);
        const save = () => {
          const change = {};
          if (modeSel.value !== S.mode) change.mode = modeSel.value;
          if (lengthSel.value !== S.length) change.length = lengthSel.value;
          if (timerSel.value !== S.timer) change.timer = timerSel.value;
          api.close();
          if (Object.keys(change).length) act('update_settings', change, () => toast('Game settings updated.'));
        };
        modal.append(
          h('h2', { text: 'Game Settings' }),
          h('p', { text: 'Either player can change these until the first turn is played.' }),
          field('Scoring', modeSel), help,
          field('Length', lengthSel),
          field('Timer', timerSel),
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
          h('p', { text: 'Players take turns placing letters on a shared board to make words, crossword-style. High-value letters and special squares earn more points.' }),
          h('h3', { text: 'Setup' }),
          h('p', { text: 'Open Edit Game Settings to choose the length, scoring and timer for your game (before the first turn).' }),
          h('ul', {},
            bullet('Wild (default): ', 'when a letter is multiplied, it keeps its improved score. Multiplied letters are coloured in, so they can be reused by anyone later. Wild mode checks words automatically and tells you whether a word is valid as you place tiles.'),
            bullet('Classic: ', 'each letter has a point value in its lower right. When you play a word, you score all the letters used. Put letters on multiplier squares for higher scores. Classic uses the traditional challenge system.')),
          h('h3', { text: 'How to play' }),
          h('ol', {},
            h('li', { text: 'Place letters: use the tiles near the bottom to make words. Select a tile and then its destination, or drag it there. The number on each tile is what that letter scores on the square it is on.' }),
            h('li', { text: 'Plan ahead: while your opponent is playing you can already stage a word. It is checked and scored live, only you can see it, and it loads onto the board when your turn starts so you can review it and press Play word.' }),
            h('li', { text: "Can't form a word? Swap tiles with the Swap button above your letters, or press Pass Turn under the timer." }),
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
      if (S.status !== 'playing') { box.textContent = S.status === 'finished' ? 'Game over' : ''; return; }
      if (!S.timer || S.timer === 'off' || deadlineAt === null) { box.textContent = 'No timer'; box.classList.add('off'); return; }
      const left = deadlineAt - Date.now();
      box.textContent = `⏱ ${fmtClock(left)}`;
      if (myTurn()) box.classList.add('mine');
      if (left <= 10000) box.classList.add('low');
    }
    setInterval(renderTimer, 250);

    function renderBanner() {
      let text;
      let cls;
      const opp = opponent();
      if (S.status === 'waiting') {
        text = 'Waiting for your opponent to join…';
        cls = 'theirs';
      } else if (S.status === 'finished') {
        text = S.winner === 'tie' ? "Game over – it's a tie!"
          : (S.winner === S.you ? 'Game over – you win!' : `Game over – ${S.players[S.winner].name} wins!`);
        cls = 'over';
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
      if (S.status === 'playing' && opp && !opp.connected) text += ' — opponent is offline';
      els.banner.textContent = text;
      els.banner.className = `turn-banner ${cls}`;
    }

    function renderBoard() {
      const lastCells = new Set((S.last_move ? S.last_move.cells : []).map(([r, c]) => `${r},${c}`));
      const mine = new Map();   // my tentative tiles (my turn) or my staged tiles (off turn)
      const theirs = new Map(); // opponent's tentative tiles, shown as ghosts
      const staging = !canEdit() && canStage();
      if (canEdit() || staging) {
        for (const p of local.pending) {
          const isBlank = S.rack[p.rack_index] === '?';
          mine.set(`${p.row},${p.col}`, { letter: p.letter, blank: isBlank, boost: letterMult(p.row, p.col) });
        }
      }
      // A staged tile of mine wins a square the opponent is only hovering over (checked first below).
      if (!canEdit() && isPlaying()) {
        for (const p of S.pending) theirs.set(`${p.row},${p.col}`, { letter: p.letter, blank: p.blank, boost: letterMult(p.row, p.col) });
      }

      const placing = canPlace() && (local.selected !== null || local.selectedBoard !== null);
      const sb = local.selectedBoard;
      for (let r = 0; r < BOARD_SIZE; r += 1) {
        for (let c = 0; c < BOARD_SIZE; c += 1) {
          const key = `${r},${c}`;
          const cell = cells[r][c];
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
          } else if (theirs.has(key)) {
            kind = 'ghost';
            info = theirs.get(key);
            sig = `g:${S.mode}:${info.letter}:${info.blank ? 1 : 0}:${info.boost}`;
          } else {
            sig = 'e';
          }
          cell.classList.toggle('can-drop', !info && placing);
          if (cell.dataset.sig === sig) continue;
          cell.dataset.sig = sig;
          cell.replaceChildren();
          if (info) {
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

    function renderRack() {
      const used = new Set(local.pending.map((p) => p.rack_index));
      const placeable = canPlace();
      els.rack.replaceChildren();
      if (S.status === 'waiting') {
        els.rack.append(h('span', { class: 'rack-hint', text: 'Your rack appears when the game starts.' }));
        return;
      }
      S.rack.forEach((letter, index) => {
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
      for (const p of S.players) {
        const active = S.status === 'playing' && S.current === p.seat;
        const minis = h('span', { class: 'mini-tiles' });
        for (let i = 0; i < p.rack_count; i += 1) minis.append(h('i'));
        els.players.append(h('div', { class: `player-card${active ? ' active' : ''}` },
          h('div', { class: 'name' },
            h('span', { class: `dot${p.connected ? ' on' : ''}`, title: p.connected ? 'Online' : 'Offline' }),
            h('span', { class: 'nm', text: p.name }),
            p.seat === S.you ? h('span', { class: 'you', text: 'you' }) : null),
          h('div', { class: 'score', text: String(p.score) }),
          h('div', { class: 'racks' }, minis, `${p.rack_count} tile${p.rack_count === 1 ? '' : 's'}`)));
      }
      if (S.players.length < 2) {
        els.players.append(h('div', { class: 'player-card' },
          h('div', { class: 'name' }, h('span', { class: 'dot' }), h('span', { class: 'nm', text: 'Waiting for opponent…' })),
          h('div', { class: 'score', text: '–' })));
      }
    }

    function renderHistory() {
      els.history.replaceChildren();
      for (const entry of [...S.history].reverse()) {
        const seatClass = entry.seat === 0 || entry.seat === 1 ? ` s${entry.seat}` : '';
        els.history.append(h('li', { class: `${entry.kind}${seatClass}`, text: entry.text }));
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
      if (pv.bingo) parts.push(h('span', { class: 'pv-total', text: ` BINGO +${config.bingo_bonus}` }));
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
      els.swap.title = S.bag_count < config.rack_size ? 'Fewer than 7 tiles left in the bag' : '';
      els.pass.disabled = !(myTurn() && !busy);
      els.pass.textContent = S.awaiting_final ? 'Accept & end game' : 'Pass Turn';
      els.challenge.hidden = S.mode !== 'classic';
      els.challenge.disabled = !(S.can_challenge && !busy);
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

    function onState(msg) {
      config = msg.config;
      S = msg.state;
      version = msg.version;
      resyncPending = false;
      local.inflight = 0;
      local.selected = null;
      local.pending = serverPending();
      deadlineAt = S.turn_ms_left === null || S.turn_ms_left === undefined ? null : Date.now() + S.turn_ms_left;
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
      if ('turn_ms_left' in msg.patch) {
        deadlineAt = S.turn_ms_left === null ? null : Date.now() + S.turn_ms_left;
      }
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
            fatalModal('Room is full', 'Two players are already in this game.');
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

    function setHighlight(el) {
      if (highlighted === el) return;
      if (highlighted) highlighted.classList.remove('drop-ok');
      highlighted = el;
      if (highlighted) highlighted.classList.add('drop-ok');
    }

    function dropIsValid(source, target) {
      if (!target) return false;
      if (target.type === 'rack') return source.type === 'board';
      const ignore = source.type === 'board' ? `${source.row},${source.col}` : null;
      return isFreeSquare(target.row, target.col, ignore);
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
        press.ghost.classList.remove('selected', 'pending', 'staged', 'ghost', 'last', 'boosted', 'boost-2', 'boost-3');
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
        const target = targetAt(event.clientX, aimY(event.clientY));
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
      const target = press.dragging ? targetAt(event.clientX, aimY(event.clientY)) : null;
      const p = endPress();
      // Swallow only the synthetic click that follows a tile press; a window any longer eats a
      // quick "tap tile, tap square" on a phone.
      suppressClickUntil = performance.now() + 120;
      if (!canPlace()) return;
      if (!p.dragging) { handleTap(p.source, p.touch); return; }
      if (!dropIsValid(p.source, target)) return;
      if (target.type === 'rack') {
        removePending(p.source.row, p.source.col);
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
      box.scrollTo({
        left: cell.offsetLeft + cell.offsetWidth / 2 - box.clientWidth / 2,
        top: cell.offsetTop + cell.offsetHeight / 2 - box.clientHeight / 2,
      });
    }
    function setZoom(on, { center = true } = {}) {
      els.boardScroll.classList.toggle('zoomed', on);
      els.zoom.setAttribute('aria-pressed', on ? 'true' : 'false');
      els.zoom.textContent = on ? 'Fit board' : 'Zoom board';
      store.set(ZOOM_KEY, on ? '1' : '0');
      if (on && center && cells.length) {
        const target = local.pending[local.pending.length - 1];
        centerBoardOn(target ? cells[target.row][target.col] : cells[config.center[0]][config.center[1]]);
      }
    }
    els.zoom.addEventListener('click', () => setZoom(!els.boardScroll.classList.contains('zoomed')));

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

    els.settingsBtn.addEventListener('click', openSettingsModal);
    els.info.addEventListener('click', openInfoModal);

    els.pass.addEventListener('click', () => {
      if (!myTurn()) return;
      const question = S.awaiting_final ? 'Accept your opponent’s last play and end the game?' : 'Pass your turn?';
      if (!window.confirm(question)) return;
      act('pass', {}, () => { local.pending = []; local.selected = null; });
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
    if (store.get(ZOOM_KEY) === '1') setZoom(true, { center: false });
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
