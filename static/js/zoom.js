(() => {
  'use strict';

  const { $, store } = window.App.util;
  const ZOOM_KEY = 'scrabble.zoom';
  const ZOOM_CELL_KEY = 'scrabble.zoomcell';
  const ZBASE = 44; // Base cell size in pixels for 1x zoom
  const ZMIN = 0.25; // Minimum board zoom scale limit
  const ZMAX = 8; // Maximum board zoom scale limit
  const MIN_CELL = ZBASE * ZMIN;
  const MAX_CELL = ZBASE * ZMAX;

  function initZoom(els, config, cellsRef, localRef, centerOfFunc, queueMinimapFunc) {
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
      queueMinimapFunc();
      if (on && center && cellsRef().size) {
        const target = localRef().pending[localRef().pending.length - 1];
        const centerCoords = centerOfFunc();
        centerBoardOn(cellsRef().get(target ? `${target.row},${target.col}` : `${centerCoords[0]},${centerCoords[1]}`));
      }
    }

    const clampCell = (px) => Math.max(MIN_CELL, Math.min(MAX_CELL, px));
    const currentCell = () => parseFloat(getComputedStyle(els.boardScroll).getPropertyValue('--zoom-cell')) || ZBASE;
    const isZoomed = () => els.boardScroll.classList.contains('zoomed');
    const fitCell = () => { const c = els.board.firstElementChild; return c ? c.offsetWidth : ZBASE; };

    let zCur = null;
    let zTarget = null;
    let zAnchor = null;
    let zRaf = 0;
    let zSaveTimer = 0;
    let zImmediate = false;

    function writeCell(px) {
      const box = els.boardScroll;
      const a = zAnchor || { x: box.clientWidth / 2, y: box.clientHeight / 2 };
      const oldW = box.scrollWidth;
      const oldH = box.scrollHeight;
      box.style.setProperty('--zoom-cell', `${px.toFixed(3)}px`);
      box.scrollLeft = (box.scrollLeft + a.x) * (box.scrollWidth / oldW) - a.x;
      box.scrollTop = (box.scrollTop + a.y) * (box.scrollHeight / oldH) - a.y;
    }

    function zoomFrame() {
      zRaf = 0;
      if (zTarget === null) return;
      if (zCur === null) zCur = currentCell();
      const diff = Math.log(zTarget / zCur);
      zCur = (zImmediate || Math.abs(diff) < 0.002) ? zTarget : zCur * Math.exp(diff * 0.28);
      zImmediate = false;
      writeCell(zCur);
      syncZoomPopover();
      if (zCur !== zTarget) { zRaf = requestAnimationFrame(zoomFrame); return; }
      zTarget = null;
      queueMinimapFunc();
      clearTimeout(zSaveTimer);
      zSaveTimer = setTimeout(() => store.set(ZOOM_CELL_KEY, String(Math.round(currentCell()))), 200);
    }

    function setCellSize(px, anchorX, anchorY, immediate = false) {
      if (!isZoomed()) {
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

    let wheelRaf = 0;
    let lastWheelEvent = null;
    els.boardScroll.addEventListener('wheel', (event) => {
      // passive: false because preventDefault is called to handle board zoom
      event.preventDefault();
      lastWheelEvent = event;
      if (!wheelRaf) {
        wheelRaf = requestAnimationFrame(() => {
          wheelRaf = 0;
          const e = lastWheelEvent;
          if (!e) return;
          let dy = e.deltaY;
          if (e.deltaMode === 1) dy *= 16;
          else if (e.deltaMode === 2) dy *= window.innerHeight;
          const box = els.boardScroll.getBoundingClientRect();
          setCellSize(zoomNow() * ZBASE * Math.exp(-dy * 0.0016), e.clientX - box.left, e.clientY - box.top);
        });
      }
    }, { passive: false });

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
      const label = window.App.util.h('span', { class: 'zp-label' });
      const ball = window.App.util.h('div', { class: 'zp-ball', role: 'slider', tabindex: '0', 'aria-label': 'Board zoom slider',
        'aria-valuemin': String(ZMIN), 'aria-valuemax': String(ZMAX) }, [label]);
      const track = window.App.util.h('div', { class: 'zp-track' }, [ball]);
      const fit = window.App.util.h('button', { class: 'btn btn-small', type: 'button', text: 'Fit board' });
      const root = window.App.util.h('div', { class: 'zoom-pop', role: 'dialog', 'aria-label': 'Zoom' }, [
        window.App.util.h('div', { class: 'zp-ends' }, [window.App.util.h('span', { text: `${ZMIN}×` }), window.App.util.h('span', { text: `${ZMAX}×` })]),
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
      const feed = (z) => setCellSize(z * ZBASE);
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

    let pan = null;
    let suppressClickUntil = 0;
    const PAN_CLICK_SUPPRESS_MS = 250;

    els.boardScroll.addEventListener('pointerdown', (event) => {
      const box = els.boardScroll;
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      if (event.target.closest('.tile.pending')) return;
      if (box.scrollWidth <= box.clientWidth && box.scrollHeight <= box.clientHeight) return;
      pan = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop, moved: false, id: event.pointerId };
    });

    let moveRaf = 0;
    let lastMoveEvent = null;
    document.addEventListener('pointermove', (event) => {
      if (!pan || event.pointerId !== pan.id) return;
      lastMoveEvent = event;
      if (!moveRaf) {
        moveRaf = requestAnimationFrame(() => {
          moveRaf = 0;
          const e = lastMoveEvent;
          if (!pan || !e || e.pointerId !== pan.id) return;
          const dx = e.clientX - pan.x;
          const dy = e.clientY - pan.y;
          if (!pan.moved && Math.hypot(dx, dy) < 5) return;
          if (!pan.moved) {
            try { els.boardScroll.setPointerCapture(pan.id); } catch (_) { /* ignore */ }
          }
          pan.moved = true;
          els.boardScroll.classList.add('panning');
          els.boardScroll.scrollLeft = pan.left - dx;
          els.boardScroll.scrollTop = pan.top - dy;
        });
      }
    });

    els.boardScroll.addEventListener('click', (event) => {
      if (performance.now() < suppressClickUntil) { event.stopPropagation(); event.preventDefault(); }
    }, true);

    const endPan = () => {
      if (pan && pan.moved) {
        suppressClickUntil = performance.now() + PAN_CLICK_SUPPRESS_MS;
        try { els.boardScroll.releasePointerCapture(pan.id); } catch (_) { /* ignore */ }
      }
      pan = null;
      els.boardScroll.classList.remove('panning');
    };
    document.addEventListener('pointerup', endPan);
    document.addEventListener('pointercancel', endPan);

    let pinch = null;
    const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    els.boardScroll.addEventListener('touchstart', (event) => {
      if (event.touches.length === 2) {
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
        queueMinimapFunc();
      }
    };
    els.boardScroll.addEventListener('touchend', endPinch, { passive: true });
    els.boardScroll.addEventListener('touchcancel', endPinch, { passive: true });

    const zoomPref = store.get(ZOOM_KEY);
    if (zoomPref === '1' || (zoomPref === null && window.innerWidth <= 700)) {
      setZoom(true, { center: false, persist: zoomPref !== null });
    }
  }

  window.App.zoom = { initZoom };
})();