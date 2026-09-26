/* ===========================================================
   icons.js — 選手アイコン（SVG）  v2

   ★差し替え点★（v1と同じ思想）
   外に見せるのは create / setName / place / setSize だけ。
   ここだけ書き換えれば、シルエット版などへ差し替えられる。

   v2は盤面全体を1枚のSVG（viewBox 960×572）で描くので、アイコンもSVGの <g>。
   苗字チップは「空いている側」へ出す（要件定義_v2 §4.3）：
     内レーンの選手 → インフィールド側 ／ 中・外レーンの選手 → 外側
   チップ幅（§4.3・9/27確定）：3文字まで＝余白6px／4文字＝余白3px（文字は縮めない）／5文字以上＝文字11px
   =========================================================== */

var Icons = (function () {

  var NS = 'http://www.w3.org/2000/svg';
  var FONT = '"Yu Gothic UI","Meiryo","Segoe UI",system-ui,sans-serif';

  function el(name, attrs, text) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  /** 車番 no のアイコン（<g>）。中身：当たり判定・丸・車番・苗字チップ */
  function create(no) {
    var c = CONFIG.COLORS[no];
    var g = el('g', { 'class': 'rider', 'data-no': String(no) });

    var chip = el('g', { 'class': 'rider-chip' });
    chip.appendChild(el('rect', { 'class': 'chip-bg', rx: 4, ry: 4, fill: 'rgba(14,17,22,.74)' }));
    chip.appendChild(el('text', { 'class': 'chip-text', fill: '#fff', 'font-weight': 700,
      'font-family': FONT, 'text-anchor': 'middle', 'dominant-baseline': 'central' }));

    var hit = el('circle', { 'class': 'rider-hit', r: 30, fill: 'transparent' });
    var body = el('circle', { 'class': 'rider-body', r: 23, fill: c.bg, stroke: c.ring, 'stroke-width': 2.5 });
    var num = el('text', { 'class': 'rider-num', fill: c.fg, 'font-weight': 800, 'font-family': FONT,
      'text-anchor': 'middle', 'dominant-baseline': 'central' }, String(no));

    g.appendChild(chip);
    g.appendChild(hit);
    g.appendChild(body);
    g.appendChild(num);
    return g;
  }

  /** 誘導員のアイコン。選手と見分けがつくよう、灰色の丸に「誘」 */
  function createPacer() {
    var g = el('g', { 'class': 'pacer' });
    var chip = el('g', { 'class': 'rider-chip' });
    chip.appendChild(el('rect', { 'class': 'chip-bg', rx: 4, ry: 4, fill: 'rgba(14,17,22,.74)' }));
    chip.appendChild(el('text', { 'class': 'chip-text', fill: '#ffd166', 'font-weight': 700,
      'font-family': FONT, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, '誘導員'));
    g.appendChild(chip);
    g.appendChild(el('circle', { 'class': 'rider-body', r: 23, fill: '#454b57', stroke: '#ffd166', 'stroke-width': 2.5 }));
    g.appendChild(el('text', { 'class': 'rider-num', fill: '#ffd166', 'font-weight': 800, 'font-family': FONT,
      'text-anchor': 'middle', 'dominant-baseline': 'central' }, '誘'));
    g.__name = '誘導員';
    return g;
  }

  /** アイコン径（px・仮想座標）を反映する */
  function setSize(g, px) {
    var r = px / 2;
    var body = g.querySelector('.rider-body');
    var hit = g.querySelector('.rider-hit');
    var num = g.querySelector('.rider-num');
    if (body) body.setAttribute('r', r);
    /* 当たり判定は丸とほぼ同じ大きさに留める。1.3倍にすると隊列の丸どうし（間隔59px）の判定が
       つながって連結バーを完全に覆い、ラインを掴めなくなった（v1で踏んだのと同じ罠・9/27の検査で再発） */
    if (hit) hit.setAttribute('r', r * 1.05);
    if (num) {
      num.setAttribute('font-size', (px * (g.classList.contains('pacer') ? 0.46 : 0.56)).toFixed(1));
      num.setAttribute('y', (px * 0.03).toFixed(1));
    }
    g.__px = px;
    layoutChip(g);
  }

  /** 苗字チップの大きさを文字数で決める（§4.3） */
  function layoutChip(g) {
    var chip = g.querySelector('.rider-chip');
    if (!chip) return;
    var text = chip.querySelector('.chip-text');
    var bg = chip.querySelector('.chip-bg');
    var s = g.__name || '';
    var n = Array.from(s).length;
    chip.style.display = n ? '' : 'none';
    if (!n) return;
    var fs = (n >= 5) ? 11 : 13;
    var pad = (n >= 4) ? 3 : 6;
    var w = n * fs + pad * 2, h = 18;
    text.setAttribute('font-size', fs);
    bg.setAttribute('x', -w / 2); bg.setAttribute('y', -h / 2);
    bg.setAttribute('width', w); bg.setAttribute('height', h);
  }

  /** 苗字を差し込む。空文字ならチップは消える */
  function setName(g, name) {
    g.__name = name || '';
    var text = g.querySelector('.rider-chip .chip-text');
    if (text) text.textContent = g.__name;
    layoutChip(g);
  }

  /**
   * コース上の位置へ置く
   * @param {{x,y}} pt   丸の中心（仮想座標）
   * @param {{x,y}} out  外向きの単位ベクトル
   * @param {number} lane 内外（チップを出す側を決める）
   */
  function place(g, pt, out, lane) {
    g.setAttribute('transform', 'translate(' + pt.x.toFixed(1) + ',' + pt.y.toFixed(1) + ')');
    var chip = g.querySelector('.rider-chip');
    if (!chip) return;
    var px = g.__px || 46;
    /* 内レーン（-0.5未満）はインフィールド側、それ以外は外側。距離＝丸の半径＋チップの半分の高さ＋少し */
    var side = (lane < -0.5) ? -1 : 1;
    var dist = px / 2 + 12;
    chip.setAttribute('transform', 'translate(' + (out.x * side * dist).toFixed(1) + ',' + (out.y * side * dist).toFixed(1) + ')');
  }

  return {
    create: create,
    createPacer: createPacer,
    setSize: setSize,
    setName: setName,
    place: place,
    el: el,
    FONT: FONT
  };
})();
