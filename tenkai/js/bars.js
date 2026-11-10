/* ===========================================================
   bars.js — ライン連結バー  v2

   ・ラインの先頭から最後尾まで、コースに沿って曲がる帯を丸の後ろに描く（要件定義_v2 §4.3）
     v1の「丸と丸を直線で結ぶ」だとオーバルのコーナーで内側を突っ切る
   ・太さはアイコン径の0.95倍＝併走する2本のバー（レーン間隔54px）が触れない
   ・当たり判定は見た目より太い透明の帯。丸のほうが手前なので、丸を掴めば1台・帯を掴めばライン全員
   ・1台だけ引き離しても所属は変わらず、帯がその位置まで伸びて追従する（v1と同じ）
   =========================================================== */

var Bars = (function () {

  var layer;
  var items = [];   // [{ nos:[..], vis:<polyline>, hit:<polyline> }]

  /** 表示対象のライン（出走していない車番を除き、2人以上残るものだけ） */
  function activeLines(d) {
    var cars = d.cars || [];
    var out = [];
    (d.lines || []).forEach(function (line) {
      var f = line.filter(function (no) { return cars.indexOf(no) !== -1; });
      if (f.length >= 2) out.push(f);
    });
    return out;
  }

  function extend(a, b, len) {
    var dx = a.x - b.x, dy = a.y - b.y;
    var dd = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: a.x + dx / dd * len, y: a.y + dy / dd * len };
  }

  /** ラインの点列（並び順＝前から）。端は丸の外まで少し伸ばす＝掴みしろ */
  function pointsFor(nos, view, ext) {
    var pts = [];
    for (var i = 0; i < nos.length - 1; i++) {
      var a = view[nos[i]], b = view[nos[i + 1]];
      if (!a || !b) continue;
      var seg = Track.pathBetween(a.d, a.lane, b.d, b.lane, 6);
      if (pts.length) seg.shift();
      pts = pts.concat(seg);
    }
    if (pts.length >= 2 && ext > 0) {
      pts[0] = extend(pts[0], pts[1], ext);
      var n = pts.length - 1;
      pts[n] = extend(pts[n], pts[n - 1], ext);
    }
    return pts.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
  }

  /** バーを通す選手。競りに行く側（持ち主の外に並ぶ選手）は通さない＝バーは持ち主の側を一列でつなぐ（11/10）。
      通さない選手も nos には残す＝帯を掴めばライン全員が動く */
  function pathNos(nos, seri) {
    var slots = (CONFIG.SERI && typeof Lineup !== 'undefined') ? Lineup.seriSlots(seri) : {};
    var out = nos.filter(function (no, j) {
      var s = slots[no];
      if (!s || s.lane === -1) return true;
      /* 同じ組の選手がライン内で隣にいるときだけ外す（組がばらけていれば普通の一列） */
      var a = j > 0 ? slots[nos[j - 1]] : null, b = j + 1 < nos.length ? slots[nos[j + 1]] : null;
      return !((a && a.g === s.g) || (b && b.g === s.g));
    });
    return out.length >= 2 ? out : nos;
  }

  function sync(d, view, px) {
    if (!items.length) return;
    items.forEach(function (it) {
      it.vis.setAttribute('points', pointsFor(it.path || it.nos, view, px * 0.26));
      it.hit.setAttribute('points', pointsFor(it.path || it.nos, view, px * 0.7));
      it.vis.style.strokeWidth = (px * 0.95) + 'px';
      /* 当たり判定＝アイコン径の1.8倍（丸の上下に18pxずつの掴みしろ）。
         隣のレーンのバーと重なる幅（1.8×46−54≈29px）は後に描いたほうが勝つ＝併走中だけの話なので許容 */
      it.hit.style.strokeWidth = (px * 1.8) + 'px';
    });
  }

  function rebuild(d) {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    items = [];
    if (d.showBars === 'off') return;
    activeLines(d).forEach(function (nos) {
      var vis = Icons.el('polyline', { 'class': 'line-bar' });
      var hit = Icons.el('polyline', { 'class': 'line-bar-hit' });
      layer.appendChild(vis);
      layer.appendChild(hit);
      var item = { nos: nos, path: pathNos(nos, d.seri), vis: vis, hit: hit };
      items.push(item);
      if (Bars.onCreate) Bars.onCreate(item);
    });
  }

  return {
    init: function (g) { layer = g; },
    rebuild: rebuild,
    sync: sync,
    onCreate: null   // main.js がドラッグを結線する
  };
})();
