/* ===========================================================
   bars.js — ライン連結バー

   ・各ラインの選手を1本の線で繋いで描く（＝そのラインが目で分かる）
   ・その線をドラッグすると、ラインごとまとめて動く
   ・丸そのものをドラッグすれば従来どおり1台だけ動く
     （丸のほうが上に重なっているので、掴み分けは自然にできる）

   線は「今の座標」を結ぶので、1台だけ外に持ち出せば線も追従して折れる。
   =========================================================== */

var Bars = (function () {

  var SVGNS = 'http://www.w3.org/2000/svg';

  var svgEl, stageEl, refresh;
  var items = [];   // [{ nos:[..], vis:<polyline>, hit:<polyline> }]

  /** 表示対象のライン（出走していない車番を除き、2人以上残るものだけ） */
  function activeLines() {
    var cars = State.data.cars || [];
    var out = [];
    (State.data.lines || []).forEach(function (line) {
      var f = line.filter(function (no) { return cars.indexOf(no) !== -1; });
      if (f.length >= 2) out.push(f);
    });
    return out;
  }

  /** a を b から遠ざかる向きに len だけ伸ばした点 */
  function extend(a, b, len) {
    var dx = a[0] - b[0], dy = a[1] - b[1];
    var d = Math.sqrt(dx * dx + dy * dy) || 1;
    return [a[0] + dx / d * len, a[1] + dy / d * len];
  }

  /** 今の座標から polyline の points 属性を作る（SVGはピクセル座標で持つ）
      両端は丸の外まで少し伸ばす。伸ばさないと端の掴みしろがなくなる */
  function pointsFor(nos, extLen) {
    var w = stageEl.clientWidth, h = stageEl.clientHeight;
    var pts = [];
    nos.forEach(function (no) {
      var r = State.data.riders[no];
      if (r) pts.push([r.x * w, r.y * h]);
    });

    if (pts.length >= 2 && extLen > 0) {
      /* 端の伸ばしは元の点を壊さないよう新しい配列要素に入れ替える */
      pts[0] = extend(pts[0], pts[1], extLen);
      var n = pts.length - 1;
      pts[n] = extend(pts[n], pts[n - 1], extLen);
    }

    return pts.map(function (p) {
      return p[0].toFixed(1) + ',' + p[1].toFixed(1);
    }).join(' ');
  }

  /** 座標・太さだけ更新する（ドラッグ中に毎フレーム呼ぶ） */
  function sync() {
    if (!items.length) return;

    var iconPx = CONFIG.iconPx(stageEl.clientWidth, stageEl.clientHeight, State.data.iconRatio);

    var visW = Math.max(8, iconPx * 1.46);   // 丸より太い＝はみ出した縁が掴みしろになる
    /* 当たり判定は見た目よりさらに広く取る。
       丸の間隔とアイコン径がほぼ同じなので、「丸と丸の間」はほとんど空かない。
       実際の掴みしろは丸の上下に出る帯なので、そこを厚くしないと単体を掴んでしまう。
       丸は常に手前（z-index）にあるので、広げても単体ドラッグが潰れることはない。 */
    var hitW = Math.max(8, iconPx * 2.60);
    /* 両端の伸ばし量。当たり判定側だけ長くして、
       ライン先頭・最後尾に掴みやすいタブを作る（見た目は伸ばしすぎない） */
    var visExt = iconPx * 0.26;
    var hitExt = iconPx * 0.70;

    items.forEach(function (it) {
      it.vis.setAttribute('points', pointsFor(it.nos, visExt));
      it.hit.setAttribute('points', pointsFor(it.nos, hitExt));
      it.vis.style.strokeWidth = visW + 'px';
      it.hit.style.strokeWidth = hitW + 'px';
    });
  }

  /** ラインごとのドラッグ */
  function enableDrag(item) {
    var active = null;

    item.hit.addEventListener('pointerdown', function (ev) {
      if (active) return;
      var rect = stageEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      /* ライン全員が枠内に収まる範囲まで移動量を制限する */
      var B = CONFIG.BOUNDS;
      var start = {};
      var dxLo = -Infinity, dxHi = Infinity, dyLo = -Infinity, dyHi = Infinity;

      item.nos.forEach(function (no) {
        var r = State.data.riders[no];
        if (!r) return;
        start[no] = { x: r.x, y: r.y };
        dxLo = Math.max(dxLo, B.minX - r.x);
        dxHi = Math.min(dxHi, B.maxX - r.x);
        dyLo = Math.max(dyLo, B.minY - r.y);
        dyHi = Math.min(dyHi, B.maxY - r.y);
      });

      active = {
        id: ev.pointerId,
        cx: ev.clientX, cy: ev.clientY,
        rect: rect, start: start,
        dxLo: dxLo, dxHi: dxHi, dyLo: dyLo, dyHi: dyHi
      };

      item.hit.classList.add('is-dragging');
      try { item.hit.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.preventDefault();
    });

    item.hit.addEventListener('pointermove', function (ev) {
      if (!active || ev.pointerId !== active.id) return;

      var dx = State.clamp((ev.clientX - active.cx) / active.rect.width, active.dxLo, active.dxHi);
      var dy = State.clamp((ev.clientY - active.cy) / active.rect.height, active.dyLo, active.dyHi);

      item.nos.forEach(function (no) {
        var s = active.start[no];
        if (s) State.moveRider(no, s.x + dx, s.y + dy);
      });

      if (refresh) refresh(item.nos);
      sync();
      ev.preventDefault();
    });

    function finish(ev) {
      if (!active || ev.pointerId !== active.id) return;
      active = null;
      item.hit.classList.remove('is-dragging');
      try { item.hit.releasePointerCapture(ev.pointerId); } catch (e) {}
      State.save();
    }

    item.hit.addEventListener('pointerup', finish);
    item.hit.addEventListener('pointercancel', finish);
  }

  /** ラインの構成が変わったら作り直す */
  function rebuild() {
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
    items = [];

    if (State.data.showBars === 'off') return;

    activeLines().forEach(function (nos) {
      var vis = document.createElementNS(SVGNS, 'polyline');
      vis.setAttribute('class', 'line-bar');

      var hit = document.createElementNS(SVGNS, 'polyline');
      hit.setAttribute('class', 'line-bar-hit');

      svgEl.appendChild(vis);
      svgEl.appendChild(hit);

      var item = { nos: nos, vis: vis, hit: hit };
      items.push(item);
      enableDrag(item);
    });

    sync();
  }

  return {
    init: function (stage, svg, refreshFn) {
      stageEl = stage;
      svgEl = svg;
      refresh = refreshFn;
    },
    rebuild: rebuild,
    sync: sync
  };
})();
