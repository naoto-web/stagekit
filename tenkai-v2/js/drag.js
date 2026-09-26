/* ===========================================================
   drag.js — ドラッグ操作（Pointer Events）  v2

   ポインタ座標を Track.project() でコース上の (d, lane) に戻す＝選手はコースから外れない。
   マウスをまっすぐ動かしても、アイコンはカーブに沿って滑る（要件定義_v2 §6.2）。

   離した瞬間のスナップ（§6.2）
     ・lane は 内/中/外 の3段に丸める
     ・同じレーンで「前の選手の真後ろ」から半車身以内なら、真後ろ（1.05車身）に吸い付く
     ・Shift を押しながら離すと吸い付かない（内外の丸めはする）
   ライン（連結バー）を掴むと全員が同じ Δd・Δlane で動く（§6.3）
   =========================================================== */

var Drag = (function () {

  var CAR = CONFIG.CAR;

  /** 盤面の選手のうち、no と同じレーンで前（d が小さい）にいる最寄りの選手の d */
  function aheadInLane(no, d, lane) {
    var best = null;
    var data = State.data;
    (data.cars || []).forEach(function (o) {
      if (o === no) return;
      var r = data.riders[o];
      if (!r || Math.round(r.lane) !== lane) return;
      if (r.d < d + 0.01 * CAR && (best === null || r.d > best)) best = r.d;
    });
    return best;
  }

  /** 1台を離したときの位置（内外を3段に丸め、真後ろに吸い付ける） */
  function snapRider(no, d, lane, noSnap) {
    var ln = Math.max(-1, Math.min(1, Math.round(lane)));
    if (noSnap) return { d: d, lane: ln };
    var front = aheadInLane(no, d, ln);
    if (front !== null) {
      var behind = front + CONFIG.LAYOUT.gapInLine * CAR;
      if (Math.abs(d - behind) < 0.5 * CAR) d = behind;
    }
    return { d: d, lane: ln };
  }

  /**
   * 選手1台のドラッグ
   * @param {SVGGElement} g
   * @param {number} no
   * @param {{onStart:Function, onMove:Function, onEnd:Function}} h
   */
  function enableRider(g, no, h) {
    var active = null;

    g.addEventListener('pointerdown', function (ev) {
      if (active) return;
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      var r = State.data.riders[no];
      if (!r) return;
      var p = Board.toBoard(ev.clientX, ev.clientY);
      var pr = Track.project(p.x, p.y, r.d);
      /* 掴んだ点と丸の中心のずれを保つ（丸の端を掴んでも中心へ跳ねない） */
      active = { id: ev.pointerId, offD: r.d - pr.d, offLane: r.lane - pr.lane, moved: false };
      g.classList.add('is-dragging');
      try { g.setPointerCapture(ev.pointerId); } catch (e) {}
      if (h.onStart) h.onStart(no);
      ev.preventDefault();
    });

    g.addEventListener('pointermove', function (ev) {
      if (!active || ev.pointerId !== active.id) return;
      var r = State.data.riders[no];
      var p = Board.toBoard(ev.clientX, ev.clientY);
      var pr = Track.project(p.x, p.y, r.d - active.offD);
      /* ドラッグ中の内外は連続で見せる（離した瞬間に3段へ） */
      State.moveRider(no, pr.d + active.offD, pr.lane + active.offLane);
      active.moved = true;
      if (h.onMove) h.onMove(no);
      ev.preventDefault();
    });

    function finish(ev) {
      if (!active || ev.pointerId !== active.id) return;
      var moved = active.moved;
      active = null;
      g.classList.remove('is-dragging');
      try { g.releasePointerCapture(ev.pointerId); } catch (e) {}
      var r = State.data.riders[no];
      if (moved && r) {
        var s = snapRider(no, r.d, r.lane, ev.shiftKey);
        State.moveRider(no, s.d, s.lane);
      }
      if (h.onEnd) h.onEnd(no, moved);
    }
    g.addEventListener('pointerup', finish);
    g.addEventListener('pointercancel', finish);
  }

  /**
   * ライン全員のドラッグ（連結バーの当たり判定）
   * @param {{nos:number[], hit:SVGElement}} item
   */
  function enableLine(item, h) {
    var active = null;

    item.hit.addEventListener('pointerdown', function (ev) {
      if (active) return;
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      var data = State.data;
      var start = {};
      var refD = null;
      item.nos.forEach(function (no) {
        var r = data.riders[no];
        if (!r) return;
        start[no] = { d: r.d, lane: r.lane };
        if (refD === null) refD = r.d;
      });
      var p = Board.toBoard(ev.clientX, ev.clientY);
      /* 基準＝ラインの先頭。掴んだ点の周回はその近くで選ぶ */
      var pr = Track.project(p.x, p.y, refD);
      active = { id: ev.pointerId, start: start, p0: pr, moved: false };
      item.hit.classList.add('is-dragging');
      try { item.hit.setPointerCapture(ev.pointerId); } catch (e) {}
      if (h.onStart) h.onStart(item.nos);
      ev.preventDefault();
    });

    function deltas(ev) {
      var p = Board.toBoard(ev.clientX, ev.clientY);
      var pr = Track.project(p.x, p.y, active.p0.d + (active.lastDD || 0));
      return { dd: pr.d - active.p0.d, dl: pr.lane - active.p0.lane };
    }

    item.hit.addEventListener('pointermove', function (ev) {
      if (!active || ev.pointerId !== active.id) return;
      var dl = deltas(ev);
      active.lastDD = dl.dd;
      active.lastDL = dl.dl;
      item.nos.forEach(function (no) {
        var s = active.start[no];
        if (s) State.moveRider(no, s.d + dl.dd, s.lane + dl.dl);
      });
      active.moved = true;
      if (h.onMove) h.onMove(item.nos);
      ev.preventDefault();
    });

    function finish(ev) {
      if (!active || ev.pointerId !== active.id) return;
      var a = active;
      active = null;
      item.hit.classList.remove('is-dragging');
      try { item.hit.releasePointerCapture(ev.pointerId); } catch (e) {}
      if (a.moved) {
        /* 内外はライン全員を同じ段数だけ動かす＝相対の段差（併走など）を崩さない */
        /* 段数は掴んだ点の連続の移動量から決める（選手側の値は±1で頭打ちになっているため使わない） */
        var dLane = Math.round(a.lastDL || 0);
        item.nos.forEach(function (no) {
          var s = a.start[no], r = State.data.riders[no];
          if (s && r) State.moveRider(no, r.d, Math.max(-1, Math.min(1, Math.round(s.lane) + dLane)));
        });
      }
      if (h.onEnd) h.onEnd(item.nos, a.moved);
    }
    item.hit.addEventListener('pointerup', finish);
    item.hit.addEventListener('pointercancel', finish);
  }

  return {
    enableRider: enableRider,
    enableLine: enableLine,
    snapRider: snapRider
  };
})();
