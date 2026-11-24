(() => {
  'use strict';

  const { $, h } = window.App.util;
  let victoryHidden = false;
  let confetti = null;

  function avatar(name, cls = '') {
    let hue = 0;
    for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
    return h('span', { class: 'vic-avatar ' + cls, style: `background:hsl(${hue} 70% 62%)`, text: (name[0] || '?').toUpperCase() });
  }

  function wordTiles(word, makeTileFn) {
    return h('div', { class: 'vic-tiles' }, ...[...word].map((l) => h('span', { class: 'vic-tile' }, makeTileFn(l, false))));
  }

  function startConfetti(canvas) {
    if (confetti) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    const colors = ['#ff8f65', '#ffd05f', '#aef6ab', '#abe6ff', '#9b5de5', '#ff6f9c'];
    const size = () => { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; };
    size();
    const bits = Array.from({ length: 140 }, () => ({
      x: Math.random() * canvas.width, y: Math.random() * -canvas.height, w: 6 + Math.random() * 7, h: 4 + Math.random() * 6,
      vy: 1.2 + Math.random() * 2.2, vx: -0.8 + Math.random() * 1.6, r: Math.random() * 6, vr: -0.15 + Math.random() * 0.3,
      c: colors[Math.floor(Math.random() * colors.length)],
    }));
    confetti = { canvas, raf: 0 };
    const tick = () => {
      if (!canvas.isConnected) { confetti = null; return; }
      if (canvas.width !== canvas.clientWidth) size();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const b of bits) {
        b.x += b.vx; b.y += b.vy; b.r += b.vr;
        if (b.y > canvas.height) { b.y = -10; b.x = Math.random() * canvas.width; }
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
      }
      confetti.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopConfetti() { if (confetti) cancelAnimationFrame(confetti.raf); confetti = null; }

  let victoryTrapRemove = null;
  let victoryOpener = null;

  function renderVictory(S, actFn, makeTileFn) {
    const root = $('victory');
    const reopen = $('victory-reopen');
    if (!S || S.status !== 'finished') {
      if (victoryTrapRemove) { victoryTrapRemove(); victoryTrapRemove = null; }
      if (root) root.remove();
      if (reopen) reopen.remove();
      stopConfetti(); victoryHidden = false;
      return;
    }
    if (victoryHidden) {
      if (victoryTrapRemove) { victoryTrapRemove(); victoryTrapRemove = null; }
      if (root) root.hidden = true;
      stopConfetti();
      if (!reopen) document.body.append(h('button', { id: 'victory-reopen', class: 'vic-reopen', type: 'button', text: 'Results', onclick: () => { victoryOpener = document.activeElement; victoryHidden = false; renderVictory(S, actFn, makeTileFn); } }));
      return;
    }
    if (reopen) reopen.remove();
    const vsig = JSON.stringify([S.you, S.winner, (S.plays || []).length, S.players.map((p) => [p.name, p.score])]);
    if (root && !root.hidden && root.dataset.sig === vsig) return;
    const sorted = [...S.players].sort((a, b) => b.score - a.score || a.seat - b.seat);
    let rank = 0;
    let prev = null;
    const rows = sorted.map((p) => { if (p.score !== prev) { rank += 1; prev = p.score; } return { p, rank }; });
    const winners = rows.filter((r) => r.rank === 1).map((r) => r.p);
    const me = rows.find((r) => r.p.seat === S.you) || rows[0];
    const plays = S.plays || [];
    const top = plays.reduce((best, p) => (!best || p.score > best.score ? p : best), null);
    let longest = null;
    for (const p of plays) for (const w of p.words) {
      if (!longest || w.length > longest.word.length || (w.length === longest.word.length && p.score > longest.play.score)) longest = { word: w, play: p };
    }
    const crownEl = h('span', { class: 'vic-crown-wrap' },
      h('svg', { viewBox: '0 0 100 60', class: 'vic-crown', 'aria-hidden': 'true' },
        h('path', { d: 'M8 52 L2 12 L28 32 L50 4 L72 32 L98 12 L92 52 Z', fill: '#ffb02e', stroke: '#e8861a', 'stroke-width': '4', 'stroke-linejoin': 'round' }),
        h('circle', { cx: '2', cy: '12', r: '5', fill: '#ff6f43' }),
        h('circle', { cx: '50', cy: '4', r: '5', fill: '#ff6f43' }),
        h('circle', { cx: '98', cy: '12', r: '5', fill: '#ff6f43' })
      )
    );
    const stat = (label, entry, pts, word) => h('div', { class: 'vic-stat' },
      h('div', { class: 'vic-stat-head' }, avatar(entry.name, 'sm'),
        h('div', { class: 'vic-stat-who' }, h('b', { text: label }), h('span', { text: entry.name })),
        h('div', { class: 'vic-stat-pts' }, h('b', { text: String(pts) }), h('span', { text: 'pts' }))),
      wordTiles(word, makeTileFn));
    const closeVic = () => {
      victoryHidden = true;
      if (victoryTrapRemove) { victoryTrapRemove(); victoryTrapRemove = null; }
      renderVictory(S, actFn, makeTileFn);
      if (victoryOpener && typeof victoryOpener.focus === 'function') {
        try { victoryOpener.focus(); } catch (_) {}
      }
    };
    const board = h('div', { class: 'vic-col vic-board' },
      h('button', { class: 'vic-close', type: 'button', 'aria-label': 'Close results', text: '×', onclick: closeVic }),
      h('button', { class: 'vic-next', type: 'button', text: 'Start next game', onclick: () => actFn('new_game', {}) }));
    const lead = h('div', { class: 'vic-col vic-leaders' }, h('h2', { text: 'Players' }),
      ...rows.map(({ p, rank: rk }) => h('div', { class: 'vic-row' + (p.seat === S.you ? ' me' : '') },
        h('span', { class: 'vic-rank', text: String(rk) }), avatar(p.name, 'sm'),
        h('div', { class: 'vic-who' }, h('b', { text: p.name }), h('span', { text: `${p.score} Points` })))));
    const right = h('div', { class: 'vic-col vic-right' },
      h('div', { class: 'vic-winner' },
        h('div', { class: 'vic-win-avatar' }, crownEl, avatar(winners[0].name, 'lg')),
        h('div', { class: 'vic-win-text' }, h('h1', { text: winners.length > 1 ? 'Winners' : 'Winner' }),
          h('b', { text: winners.map((w) => w.name).join(' & ') }), h('span', { text: `${winners[0].score} Points` }))),
      top ? stat('Top turn', top, top.score, top.words[0]) : '',
      longest ? stat('Longest word', longest.play, longest.play.score, longest.word) : '',
      h('div', { class: 'vic-you' }, h('h3', { text: 'Your score' }),
        h('div', { class: 'vic-row' }, h('span', { class: 'vic-rank', text: String(me.rank) }), avatar(me.p.name, 'sm'),
          h('div', { class: 'vic-who' }, h('b', { text: me.p.name }), h('span', { text: `${me.p.score} points` })))));
    const canvas = h('canvas', { class: 'vic-confetti' });
    const next = h('button', { class: 'vic-next vic-next-mobile', type: 'button', text: 'Start next game', onclick: () => actFn('new_game', {}) });
    const fresh = h('div', { id: 'victory', class: 'victory', role: 'dialog', 'aria-modal': 'true' }, canvas, board, lead, right, next);
    fresh.dataset.sig = vsig;
    if (root) root.replaceWith(fresh); else document.body.append(fresh);
    stopConfetti();
    startConfetti(canvas);
    if (!root || root.hidden) victoryOpener = document.activeElement;
    if (victoryTrapRemove) victoryTrapRemove();
    if (window.App.util && window.App.util.trapFocus) {
      victoryTrapRemove = window.App.util.trapFocus(fresh, closeVic);
    }
  }

  window.App = window.App || {};
  window.App.victory = { renderVictory, stopConfetti };
})();
