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
    const local = { pending: [], selected: null, inflight: 0 };

    const els = {
      board: $('board'), rack: $('rack'), preview: $('preview'), banner: $('turn-banner'),
      players: $('players'), history: $('history'), bag: $('bag-count'), conn: $('conn'),
      toast: $('toast'), share: $('share'), shareUrl: $('share-url'), modalRoot: $('modal-root'),
      submit: $('btn-submit'), recall: $('btn-recall'), swap: $('btn-swap'),
      pass: $('btn-pass'), challenge: $('btn-challenge'), modeLabel: $('mode-label'),
      settings: $('settings'), setMode: $('set-mode'), setLength: $('set-length'), modeHelp: $('mode-help'),
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
    const modeLabel = (mode) => (MODE_INFO[mode] ? MODE_INFO[mode].label : mode);
    const lengthText = (length) => {
      const tiles = config && config.lengths ? config.lengths[length] : null;
      return `${LENGTH_LABEL[length] || length}${tiles ? ` (${tiles} tiles)` : ''}`;
    };

    // ---------- derived state ----------
    const isPlaying = () => !!S && S.status === 'playing';
    const myTurn = () => isPlaying() && S.current === S.you;
    const canEdit = () => myTurn() && !S.awaiting_final;
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

    // `boost` is the permanent letter multiplier a tile earned in Wild mode (1 = none).
    function makeTile(letter, blank, extra = '', boost = 1) {
      const children = [h('span', { class: 'l', text: letter || '' })];
      const boosted = !blank && boost > 1;
      if (!blank) children.push(h('span', { class: 'v', text: String(tileValue(letter) * (boosted ? boost : 1)) }));
      const cls = `tile${blank ? ' blank' : ''}${boosted ? ` boosted boost-${boost}` : ''}${extra ? ` ${extra}` : ''}`;
      const tile = h('div', { class: cls }, children);
      if (boosted) tile.setAttribute('title', `Worth ${tileValue(letter) * boost} (x${boost} letter bonus kept)`);
      return tile;
    }

    // ---------- rendering ----------
    function render() {
      if (!S || !config) return;
      if (!cells.length) buildBoard();
      renderBanner();
      renderBoard();
      renderRack();
      renderPlayers();
      renderHistory();
      renderPreview();
      renderControls();
      els.bag.textContent = String(S.bag_count);
      renderSettings();
      els.modeLabel.textContent = `${modeLabel(S.mode)} · ${lengthText(S.length)}`;
      els.share.hidden = S.status !== 'waiting';
      if (S.status === 'waiting') els.shareUrl.value = `${window.location.origin}/join/${roomCode}`;
      document.title = `${myTurn() ? '▶ ' : ''}Scrabble – ${roomCode}`;
      showGameOver();
    }

    function renderSettings() {
      const open = S.status !== 'finished' && !S.settings_locked;
      els.settings.hidden = !open;
      if (!open) return;
      if (!els.setMode.options.length) {
        for (const mode of config.modes) els.setMode.append(h('option', { value: mode, text: modeLabel(mode) }));
        for (const length of Object.keys(config.lengths)) {
          els.setLength.append(h('option', { value: length, text: lengthText(length) }));
        }
      }
      els.setMode.value = S.mode;
      els.setLength.value = S.length;
      els.setMode.disabled = busy;
      els.setLength.disabled = busy;
      els.modeHelp.textContent = (MODE_INFO[S.mode] || {}).help || '';
    }

    function changeSettings(change) {
      if (!S || S.settings_locked) return;
      act('update_settings', change, () => toast('Game settings updated.'));
    }

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
        cls = 'theirs';
      }
      if (S.status === 'playing' && opp && !opp.connected) text += ' — opponent is offline';
      els.banner.textContent = text;
      els.banner.className = `turn-banner ${cls}`;
    }

    function renderBoard() {
      const lastCells = new Set((S.last_move ? S.last_move.cells : []).map(([r, c]) => `${r},${c}`));
      const mine = new Map();   // my tentative tiles (only while it is my turn to edit)
      const theirs = new Map(); // opponent's tentative tiles, shown as ghosts
      if (canEdit()) {
        for (const p of local.pending) {
          const isBlank = S.rack[p.rack_index] === '?';
          mine.set(`${p.row},${p.col}`, { letter: p.letter, blank: isBlank });
        }
      } else if (isPlaying()) {
        for (const p of S.pending) theirs.set(`${p.row},${p.col}`, { letter: p.letter, blank: p.blank });
      }

      const placing = canEdit() && local.selected !== null;
      for (let r = 0; r < BOARD_SIZE; r += 1) {
        for (let c = 0; c < BOARD_SIZE; c += 1) {
          const key = `${r},${c}`;
          const cell = cells[r][c];
          const placed = S.board[key];
          let sig;
          let kind = null;
          let info = null;
          if (placed) {
            kind = lastCells.has(key) ? 'last' : '';
            info = { letter: placed.l, blank: placed.b, boost: placed.m || 1 };
            sig = `b:${placed.l}:${placed.b ? 1 : 0}:${info.boost}:${kind}`;
          } else if (mine.has(key)) {
            kind = 'pending';
            info = mine.get(key);
            sig = `p:${info.letter}:${info.blank ? 1 : 0}`;
          } else if (theirs.has(key)) {
            kind = 'ghost';
            info = theirs.get(key);
            sig = `g:${info.letter}:${info.blank ? 1 : 0}`;
          } else {
            sig = 'e';
          }
          cell.classList.toggle('can-drop', !info && placing);
          if (cell.dataset.sig === sig) continue;
          cell.dataset.sig = sig;
          cell.replaceChildren();
          if (info) {
            const tile = makeTile(info.letter, info.blank, kind, info.boost || 1);
            if (kind === 'pending') {
              tile.setAttribute('title', 'Drag to move, tap to return to your rack');
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
      els.rack.replaceChildren();
      if (S.status === 'waiting') {
        els.rack.append(h('span', { class: 'rack-hint', text: 'Your rack appears when the game starts.' }));
        return;
      }
      S.rack.forEach((letter, index) => {
        if (canEdit() && used.has(index)) return;
        const blank = letter === '?';
        const tile = makeTile(blank ? '' : letter, blank, local.selected === index && canEdit() ? 'selected' : '');
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
      if (!canEdit()) {
        if (S.last_move) {
          const who = S.players[S.last_move.seat].name;
          box.append(h('span', { class: 'pv-muted', text: `Last play: ${S.last_move.words.join(', ')} for ${S.last_move.score} (${who})` }));
        }
        return;
      }
      if (local.pending.length === 0) {
        box.append(h('span', { class: 'pv-muted', text: 'Drag tiles onto the board, or tap a tile and then a square.' }));
        return;
      }
      if (local.inflight > 0 || !S.preview) {
        box.append(h('span', { class: 'pv-muted', text: 'Checking…' }));
        return;
      }
      const pv = S.preview;
      if (pv.words.length === 0) {
        box.append(h('span', { class: 'pv-muted', text: pv.error || '' }));
        return;
      }
      const parts = [];
      pv.words.forEach((w, i) => {
        if (i) parts.push(' · ');
        parts.push(h('span', { class: w.valid === false ? 'pv-bad' : '', text: `${w.word} ${w.score}` }));
      });
      if (pv.bingo) parts.push(h('span', { class: 'pv-total', text: ` BINGO +${config.bingo_bonus}` }));
      if (pv.total !== null && pv.total !== undefined) parts.push(h('span', { class: 'pv-total', text: ` = ${pv.total}` }));
      box.append(...parts);
      if (pv.error) box.append(h('div', { class: 'pv-bad', text: pv.error }));
    }

    function renderControls() {
      const edit = canEdit();
      const hasPending = local.pending.length > 0;
      const previewOk = !S.preview || S.preview.ok;
      els.submit.disabled = !(edit && hasPending && previewOk && local.inflight === 0 && !busy);
      els.recall.disabled = !(edit && hasPending);
      els.swap.disabled = !(edit && S.bag_count >= config.rack_size && !busy);
      els.swap.title = S.bag_count < config.rack_size ? 'Fewer than 7 tiles left in the bag' : '';
      els.pass.disabled = !(myTurn() && !busy);
      els.pass.textContent = S.awaiting_final ? 'Accept & end game' : 'Pass';
      els.challenge.hidden = S.mode !== 'classic';
      els.challenge.disabled = !(S.can_challenge && !busy);
    }

    // ---------- server -> client ----------
    function serverPending() {
      if (!S || !(isPlaying() && S.current === S.you)) return [];
      return S.pending
        .filter((p) => p.rack_index !== undefined)
        .map((p) => ({ rack_index: p.rack_index, row: p.row, col: p.col, letter: p.letter }));
    }

    function syncLocalFromServer() {
      if (local.inflight > 0) return;
      local.pending = serverPending();
      if (!canEdit() || (local.selected !== null && (local.selected >= S.rack.length
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
      render();
    }

    function onDiff(msg) {
      if (!S || msg.base !== version) { requestResync(); return; }
      for (const [key, value] of Object.entries(msg.patch)) {
        if (key === 'board') {
          for (const cell of value.del) delete S.board[cell];
          Object.assign(S.board, value.set);
        } else {
          S[key] = value;
        }
      }
      version = msg.version;
      syncLocalFromServer();
      render();
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

    function renderControlsSafe() { if (S && config) { renderControls(); renderSettings(); } }

    function sendPlacements() {
      if (!socket || !socket.connected) { toast('Not connected to the server.', true); return; }
      local.inflight += 1;
      const placements = local.pending.map((p) => ({
        rack_index: p.rack_index, row: p.row, col: p.col, letter: p.letter,
      }));
      socket.timeout(ACK_TIMEOUT).emit('place_tiles', { placements }, (err, res) => {
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
      if (!canEdit() || !isFreeSquare(row, col)) return;
      let letter = S.rack[index];
      if (letter === '?') {
        letter = await pickLetter();
        if (!letter) return;
        if (!canEdit() || !isFreeSquare(row, col)) return; // things may have changed meanwhile
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
      if (!canEdit() || press) return;
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      press = { source, el, startX: event.clientX, startY: event.clientY, dragging: false, ghost: null, pointerId: event.pointerId };
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerCancel);
    }

    function onPointerMove(event) {
      if (!press || event.pointerId !== press.pointerId) return;
      if (!press.dragging && Math.hypot(event.clientX - press.startX, event.clientY - press.startY) > 6) {
        press.dragging = true;
        press.ghost = press.el.cloneNode(true);
        press.ghost.classList.remove('selected', 'pending', 'ghost', 'last');
        press.ghost.classList.add('drag-ghost');
        document.body.append(press.ghost);
        press.el.classList.add('dragging');
      }
      if (press.dragging) {
        press.ghost.style.left = `${event.clientX}px`;
        press.ghost.style.top = `${event.clientY}px`;
        const target = targetAt(event.clientX, event.clientY);
        setHighlight(dropIsValid(press.source, target) ? target.el : null);
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
      const target = press.dragging ? targetAt(event.clientX, event.clientY) : null;
      const p = endPress();
      suppressClickUntil = performance.now() + 350; // swallow the click that follows a tile press
      if (!canEdit()) return;
      if (!p.dragging) { handleTap(p.source); return; }
      if (!dropIsValid(p.source, target)) return;
      if (target.type === 'rack') {
        removePending(p.source.row, p.source.col);
      } else if (p.source.type === 'rack') {
        placeFromRack(p.source.index, target.row, target.col);
      } else {
        movePending(p.source.row, p.source.col, target.row, target.col);
      }
    }

    function handleTap(source) {
      if (source.type === 'rack') {
        local.selected = local.selected === source.index ? null : source.index;
        renderRack();
        renderBoard();
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
      if (!cell || !canEdit() || local.selected === null) return;
      placeFromRack(local.selected, Number(cell.dataset.row), Number(cell.dataset.col));
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
      if (!canEdit() || local.pending.length === 0) return;
      local.pending = [];
      local.selected = null;
      sendPlacements();
      render();
    });

    els.swap.addEventListener('click', openSwapModal);

    els.setMode.addEventListener('change', () => changeSettings({ mode: els.setMode.value }));
    els.setLength.addEventListener('change', () => changeSettings({ length: els.setLength.value }));

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
    els.modeLabel.textContent = `${modeLabel(document.body.dataset.mode)} · ${LENGTH_LABEL[document.body.dataset.length] || ''}`;
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
