/* ===========================================================
   drag.js — アイコンのドラッグ操作（Pointer Events / マウス・タッチ共通）
   =========================================================== */

var Drag = (function () {

  /**
   * @param {HTMLElement} stageEl   基準となるステージ（この矩形で正規化する）
   * @param {HTMLElement} el        ドラッグ対象のアイコン
   * @param {Object} handlers       { onMove(no,x,y), onEnd(no,x,y) }
   */
  function enable(stageEl, el, handlers) {
    var active = null;   // { pointerId, startClientX, startClientY, startX, startY, rect }

    el.addEventListener('pointerdown', function (ev) {
      if (active) return;
      if (ev.button !== undefined && ev.button !== 0 && ev.pointerType === 'mouse') return;

      var no = parseInt(el.dataset.no, 10);
      var rect = stageEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      active = {
        pointerId: ev.pointerId,
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        startX: parseFloat(el.dataset.x),
        startY: parseFloat(el.dataset.y),
        rect: rect,
        no: no
      };

      el.classList.add('is-dragging');
      try { el.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.preventDefault();
    });

    el.addEventListener('pointermove', function (ev) {
      if (!active || ev.pointerId !== active.pointerId) return;

      var dx = (ev.clientX - active.startClientX) / active.rect.width;
      var dy = (ev.clientY - active.startClientY) / active.rect.height;

      var x = State.clamp(active.startX + dx, CONFIG.BOUNDS.minX, CONFIG.BOUNDS.maxX);
      var y = State.clamp(active.startY + dy, CONFIG.BOUNDS.minY, CONFIG.BOUNDS.maxY);

      if (handlers.onMove) handlers.onMove(active.no, x, y);
      ev.preventDefault();
    });

    function finish(ev) {
      if (!active || ev.pointerId !== active.pointerId) return;
      var no = active.no;
      active = null;
      el.classList.remove('is-dragging');
      try { el.releasePointerCapture(ev.pointerId); } catch (e) {}
      if (handlers.onEnd) {
        handlers.onEnd(no, parseFloat(el.dataset.x), parseFloat(el.dataset.y));
      }
    }

    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
  }

  return { enable: enable };
})();
