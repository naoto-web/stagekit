/* ===========================================================
   board.js — 盤面の描画（1枚のSVG・viewBox 960×572）  v2

   ・バンク（オーバル）・地点名・ゴール線・打鐘の印は起動時に1回だけ描く
   ・見出し（場名 R・級班）と局面名はインフィールド中央（要件定義_v2 §4.1）
   ・選手・誘導員・連結バーは State.data を見て描く
   ・ドックと出力で同じ絵（§2-7）。縦横比は保ったまま窓に合わせて拡大縮小
   =========================================================== */

var Board = (function () {

  var T = CONFIG.TRACK;
  var G = Track.geom;
  var el = Icons.el;
  var FONT = Icons.FONT;

  var svg, wallRect, barsLayer, ridersLayer, titleMain, titleSub, phaseBg, phaseText;
  var riderEls = {};
  var pacerEl = null;

  /** 高さ 2r の角丸長方形＝直線2本＋半円2つ（コースの輪郭線） */
  function stadium(parent, r, attrs) {
    var a = { x: G.XL - r, y: T.CY - r, width: T.LSTR + 2 * r, height: 2 * r, rx: r, ry: r };
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) a[k] = attrs[k];
    var e = el('rect', a);
    parent.appendChild(e);
    return e;
  }

  function label(parent, x, y, text, size, color, weight) {
    var t = el('text', { x: x, y: y, fill: color || 'rgba(255,255,255,.62)', 'font-size': size || 14,
      'font-weight': weight || 700, 'font-family': FONT, 'text-anchor': 'middle' }, text);
    parent.appendChild(t);
    return t;
  }

  function buildTrack(g) {
    var defs = el('defs', {});
    var inf = el('linearGradient', { id: 'tk-inf', x1: 0, y1: 0, x2: 0, y2: 1 });
    inf.appendChild(el('stop', { offset: '0', 'stop-color': '#41503c' }));
    inf.appendChild(el('stop', { offset: '1', 'stop-color': '#35422f' }));
    defs.appendChild(inf);
    g.appendChild(defs);

    wallRect = el('rect', { x: 0, y: 0, width: T.W, height: T.H, fill: '#2b313a' });
    g.appendChild(wallRect);

    stadium(g, T.RC + T.HALF, { fill: '#7d858d' });                                         // 路面
    stadium(g, T.RC + T.HALF, { fill: 'none', stroke: '#cfd5da', 'stroke-width': 3 });      // 外縁
    stadium(g, T.RC + T.OUTER_LINE, { fill: 'none', stroke: '#d94a4a', 'stroke-width': 3 }); // 外帯線（赤）
    stadium(g, T.RC + T.INNER_LINE, { fill: 'none', stroke: '#f2f4f7', 'stroke-width': 3 }); // 内圏線（白）
    stadium(g, T.RC - T.HALF, { fill: 'url(#tk-inf)' });                                    // インフィールド

    /* ゴール線（白黒の破線） */
    var gx = G.XR - T.GOAL_OFF;
    var y0 = T.CY + T.RC - T.HALF, y1 = T.CY + T.RC + T.HALF;
    g.appendChild(el('line', { x1: gx, y1: y0, x2: gx, y2: y1, stroke: '#fff', 'stroke-width': 5 }));
    g.appendChild(el('line', { x1: gx, y1: y0, x2: gx, y2: y1, stroke: '#111', 'stroke-width': 5, 'stroke-dasharray': '7 7' }));

    /* 打鐘の印＝残り1周半の地点（路面に破線1本） */
    var bIn = Track.pointAt(CONFIG.BELL_D, -T.HALF / T.LANE), bOut = Track.pointAt(CONFIG.BELL_D, T.HALF / T.LANE);
    g.appendChild(el('line', { x1: bIn.x, y1: bIn.y, x2: bOut.x, y2: bOut.y,
      stroke: 'rgba(255,255,255,.55)', 'stroke-width': 2, 'stroke-dasharray': '6 5' }));

    /* 進行方向（左回り）＝路面の外寄りに矢印2つ */
    var cx = T.CX, by = T.CY + T.RC + 70, ty = T.CY - T.RC - 70;
    g.appendChild(el('polygon', { points: (cx - 10) + ',' + (by - 8) + ' ' + (cx + 12) + ',' + by + ' ' + (cx - 10) + ',' + (by + 8), fill: 'rgba(255,255,255,.45)' }));
    g.appendChild(el('polygon', { points: (cx + 10) + ',' + (ty - 8) + ' ' + (cx - 12) + ',' + ty + ' ' + (cx + 10) + ',' + (ty + 8), fill: 'rgba(255,255,255,.45)' }));

    /* 地点名（インフィールドの縁の少し内側＝苗字チップと重ならない位置） */
    var inTop = T.CY - T.RC + T.HALF, inBot = T.CY + T.RC - T.HALF;
    label(g, cx - 40, inBot - 30, 'ホーム');
    label(g, gx, inBot - 30, 'ゴール');
    label(g, cx + 40, inTop + 42, 'バック');
    label(g, bIn.x, inTop + 42, '🔔 打鐘');
    /* 角の名前は半円の中心寄り（半径約50px）。縁寄りだとコーナーを回る内レーンの苗字チップ（半径約97px）と被る */
    label(g, G.XR + 38, T.CY + 42, '1角');
    label(g, G.XR + 38, T.CY - 30, '2角');
    label(g, G.XL - 38, T.CY - 30, '3角');
    label(g, G.XL - 38, T.CY + 42, '4角');
  }

  function buildTitle(g) {
    titleMain = label(g, T.CX, T.CY - 16, '', 42, '#fff', 800);
    titleSub = label(g, T.CX, T.CY + 12, '', 17, 'rgba(255,255,255,.84)', 700);
    phaseBg = el('rect', { x: T.CX - 62, y: T.CY + 26, width: 124, height: 32, rx: 8, fill: '#3d8bfd' });
    g.appendChild(phaseBg);
    phaseText = label(g, T.CX, T.CY + 49, '', 19, '#fff', 800);
  }

  /** 先頭の位置 → 局面名。先頭が到達済みの局面のうち最後のもの（スタートを出た後〜赤板の前は「周回中」） */
  function phaseOf(leaderD) {
    if (leaderD === null) return null;
    var P = CONFIG.PHASES, eps = 0.004, cur = null;
    for (var i = 0; i < P.length; i++) {
      if (leaderD <= P[i].d + eps) cur = P[i];
    }
    if (!cur) return { key: 'start', label: 'スタート' };
    if (cur.key === 'start' && leaderD < P[0].d - eps) return { key: 'lap', label: '周回中' };
    return cur;
  }

  function init(stageEl) {
    svg = el('svg', { 'class': 'board', viewBox: '0 0 ' + T.W + ' ' + T.H,
      preserveAspectRatio: 'xMidYMid meet', xmlns: 'http://www.w3.org/2000/svg' });
    var gTrack = el('g', { 'class': 'layer-track' });
    var gTitle = el('g', { 'class': 'layer-title', 'pointer-events': 'none' });
    barsLayer = el('g', { 'class': 'layer-bars' });
    ridersLayer = el('g', { 'class': 'layer-riders' });
    svg.appendChild(gTrack);
    svg.appendChild(gTitle);
    svg.appendChild(barsLayer);
    svg.appendChild(ridersLayer);
    stageEl.appendChild(svg);

    buildTrack(gTrack);
    buildTitle(gTitle);

    pacerEl = Icons.createPacer();
    pacerEl.style.pointerEvents = 'none';
    ridersLayer.appendChild(pacerEl);

    for (var no = 1; no <= CONFIG.MAX_CAR; no++) {
      var g = Icons.create(no);
      ridersLayer.appendChild(g);
      riderEls[no] = g;
    }
    Bars.init(barsLayer);
    return svg;
  }

  /** クライアント座標 → 盤面の仮想座標 */
  function toBoard(clientX, clientY) {
    var ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    var pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    var p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  /** 苗字チップを出す側。内レーン＝インフィールド側／外レーン＝外側／真ん中＝空いている側、
      内外の両隣が埋まっていれば丸の後ろ（スタートの升目で真ん中の列の苗字が隠れた・9/27 Naoto） */
  function chipMode(no, r, cars, view) {
    if (r.lane < -0.5) return 'in';
    if (r.lane > 0.5) return 'out';
    var near = 0.9 * CONFIG.CAR, inner = false, outer = false;
    cars.forEach(function (o) {
      if (o === no) return;
      var q = view[o];
      if (Math.abs(q.d - r.d) >= near) return;
      if (q.lane < -0.5) inner = true;
      if (q.lane > 0.5) outer = true;
    });
    if (inner && outer) return 'back';
    return outer ? 'in' : 'out';
  }

  /** 進行方向の逆向きの単位ベクトル */
  function behind(dd) {
    var a = Track.pointAt(dd, 0), b = Track.pointAt(dd + 0.002, 0);
    var x = b.x - a.x, y = b.y - a.y, l = Math.sqrt(x * x + y * y) || 1;
    return { x: x / l, y: y / l };
  }

  /** 位置だけ更新（ドラッグ・アニメ中に毎フレーム呼ぶ） */
  function positions(d, view) {
    view = view || d.riders;
    var px = CONFIG.iconPx(d.iconRatio);
    var leader = null;
    var cars = (d.cars || []).filter(function (no) { return !!view[no]; });
    cars.forEach(function (no) { var r = view[no]; if (leader === null || r.d < leader) leader = r.d; });
    cars.forEach(function (no) {
      var r = view[no];
      Icons.place(riderEls[no], Track.pointAt(r.d, r.lane), Track.outward(r.d), r.lane,
                  chipMode(no, r, cars, view), behind(r.d));
    });

    /* 連結バーはスタートの升目では隠し、走り出してから赤板までに浮かび上がらせる（9/27）。
       升目の時点ではラインがまだ組まれていない＝バーを出すとジグザグに見える */
    /* 赤板（2.0）の直前だけで浮かび上がる。早く出すと、組み替えの途中でバーがジグザグに見えた（9/27） */
    var barOp = leader === null ? 1 : Math.max(0, Math.min(1, (2.2 - leader) / 0.2));
    /* 決着の表示中は消す：抜け出した選手までバーが斜めに伸びて帯のように残った（9/27） */
    if (d.finish && d.finish.length && leader !== null && leader < 1e-4) barOp = 0;
    barsLayer.style.opacity = String(barOp);
    barsLayer.style.display = barOp <= 0.001 ? 'none' : '';

    /* 誘導員：先頭の1車身前・内。先頭が打鐘の位置に近づくと外へ上がりながら薄くなって消える（§5） */
    /* ⚠️境目に余裕を持たせる：先頭がちょうど打鐘の位置（1.5）のときに小数の誤差で「まだ手前」と判定され、
       透明の誘導員が残らないように（9/27の検査で発見） */
    var bell = CONFIG.BELL_D + 1e-4, fade = 0.06;
    if (leader !== null && leader > bell) {
      var t = Math.min(1, (leader - bell) / fade);
      var lane = -1 + (1 - t) * 1.6;
      var pd = leader - CONFIG.CAR;
      pacerEl.style.display = '';
      pacerEl.style.opacity = String(t);
      Icons.setSize(pacerEl, px);
      Icons.place(pacerEl, Track.pointAt(pd, lane), Track.outward(pd), lane);
    } else {
      pacerEl.style.display = 'none';
    }

    var ph = phaseOf(leader);
    /* 決着（9/27）：先頭がゴール線にいて着順が入っていれば「決着 4-2-7」を金色で出す（視聴者にも見える） */
    var fin = (d.finish && d.finish.length && leader !== null && leader < 1e-4) ? d.finish : null;
    phaseBg.setAttribute('fill', fin ? '#c9a227' : '#3d8bfd');
    if (fin) ph = { key: 'goal', label: '決着 ' + fin.join('-') };
    phaseText.textContent = ph ? ph.label : '';
    var w = ph ? Math.max(124, Array.from(ph.label).length * 19 + 36) : 0;
    phaseBg.setAttribute('x', T.CX - w / 2);
    phaseBg.setAttribute('width', w);
    phaseBg.style.display = ph ? '' : 'none';

    Bars.sync(d, view, px);
    return ph;
  }

  /** 状態を丸ごと描く（構造が変わったとき） */
  function render(d, view) {
    var px = CONFIG.iconPx(d.iconRatio);
    for (var no = 1; no <= CONFIG.MAX_CAR; no++) {
      var g = riderEls[no];
      var visible = (d.cars.indexOf(no) !== -1);
      g.style.display = visible ? '' : 'none';
      if (!visible) continue;
      Icons.setSize(g, px);
      Icons.setName(g, d.showNames === 'off' ? '' : (d.names[no] || ''));
    }
    wallRect.setAttribute('fill', d.bg === 'green' ? '#00b140' : '#2b313a');
    titleMain.textContent = d.titleMain || '';
    titleSub.textContent = d.titleSub || '';
    Bars.rebuild(d);
    return positions(d, view);
  }

  /** 選択中の選手に金色のリング（v2.1・ドックだけ） */
  function setSelected(nos) {
    for (var no = 1; no <= CONFIG.MAX_CAR; no++) riderEls[no].classList.toggle('is-selected', (nos || []).indexOf(no) !== -1);
  }

  /** ドラッグ中の選手を最前面へ */
  function raise(no) {
    var g = riderEls[no];
    if (g && g.parentNode) g.parentNode.appendChild(g);
  }

  return {
    init: init,
    render: render,
    positions: positions,
    toBoard: toBoard,
    raise: raise,
    setSelected: setSelected,
    phaseOf: phaseOf,
    riderEl: function (no) { return riderEls[no]; },
    get svg() { return svg; }
  };
})();
