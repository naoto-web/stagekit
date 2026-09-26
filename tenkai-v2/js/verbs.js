/* ===========================================================
   verbs.js — 動詞ボタン（展開の台本）  v2.1（要件定義_v2 §6.5・9/27 Naoto確定＝6つ＋順番の入れ替え）

   各動詞は「主語（選んだ選手 or ライン）」と「相手（自動で決める）」から、
   各選手の通り道（キーフレーム {t, d, lane} の並び）を作って返すだけ。動かすのは Anim.path()。
     返り値：{ paths: { no: [{t,d,lane},...] }, hint: '…' } または { error: '…' }
   1車身＝CONFIG.CAR。数値は初期値で、実機で調整する。

   追い抜く選手は外（または空いている側）のレーンを通し、抜かれる側は内のまま＝丸が重ならない。
   =========================================================== */

var Verbs = (function () {

  var CAR = CONFIG.CAR;

  /* ---------- 盤面の読み取り ---------- */

  function data() { return State.data; }
  function pos(no) { var r = data().riders[no]; return { d: r.d, lane: r.lane }; }
  function cars() { return (data().cars || []).filter(function (no) { return !!data().riders[no]; }); }
  function byD(list) { return list.slice().sort(function (a, b) { return data().riders[a].d - data().riders[b].d; }); }
  function leaderNo() { var c = byD(cars()); return c.length ? c[0] : null; }

  /** no が属するライン（盤面に出ている選手だけ・並び順）。ラインが無ければ [no] */
  function lineOf(no) {
    var c = cars(), found = null;
    (data().lines || []).forEach(function (l) {
      if (l.indexOf(no) !== -1) found = l.filter(function (n) { return c.indexOf(n) !== -1; });
    });
    return found && found.length ? found : [no];
  }

  /** 盤面のライン（出ている選手だけ）を、いま前にいる順に並べる。ラインに無い選手は単騎扱い */
  function linesInOrder() {
    var c = cars(), seen = {}, out = [];
    (data().lines || []).forEach(function (l) {
      var f = l.filter(function (n) { return c.indexOf(n) !== -1; });
      if (f.length) { out.push(f); f.forEach(function (n) { seen[n] = true; }); }
    });
    c.forEach(function (n) { if (!seen[n]) out.push([n]); });
    out.sort(function (a, b) { return headD(a) - headD(b); });
    return out;
  }
  function headD(line) {
    var m = null;
    line.forEach(function (n) { var d = data().riders[n].d; if (m === null || d < m) m = d; });
    return m;
  }
  function sameLine(a, b) { return a.length === b.length && a.every(function (n, i) { return n === b[i]; }); }

  /* ---------- 通り道の組み立て ---------- */

  /** 全員の通り道の土台＝今の位置から、全体を adv 車身だけ進めた位置へまっすぐ（レーンそのまま） */
  function basePaths(adv) {
    var paths = {};
    cars().forEach(function (no) {
      var p = pos(no);
      paths[no] = [{ t: 0, d: p.d, lane: p.lane }, { t: 1, d: Math.max(0, p.d - adv * CAR), lane: p.lane }];
    });
    return paths;
  }
  function finalOf(paths, no) { return paths[no][paths[no].length - 1]; }

  /** 追い抜く選手の通り道：序盤で passLane へ出て、終盤に目標のレーンへ */
  function passPath(no, fin, passLane, tOut, tIn) {
    var p = pos(no);
    var pts = [{ t: 0, d: p.d, lane: p.lane }];
    var o = tOut == null ? 0.25 : tOut, i = tIn == null ? 0.8 : tIn;
    pts.push({ t: o, d: p.d + (fin.d - p.d) * 0.15, lane: passLane });
    pts.push({ t: i, d: p.d + (fin.d - p.d) * 0.9, lane: passLane });
    pts.push({ t: 1, d: fin.d, lane: fin.lane });
    return pts;
  }

  /** ラインを並べ直した一列（全員内）に移る通り道。前へ出るライン（movers）は真ん中のレーンを通る */
  function requeue(order, head, movers) {
    var fin = Lineup.layout(order, head), paths = {};
    cars().forEach(function (no) {
      var p = pos(no), f = fin[no] || { d: p.d, lane: p.lane };
      if (movers.indexOf(no) !== -1) paths[no] = passPath(no, f, 0);
      else paths[no] = [{ t: 0, d: p.d, lane: p.lane }, { t: 0.6, d: p.d + (f.d - p.d) * 0.6, lane: f.lane }, { t: 1, d: f.d, lane: f.lane }];
    });
    return paths;
  }

  function label(no) {
    var n = data().names[no];
    return '①②③④⑤⑥⑦⑧⑨'.charAt(no - 1) + (n ? ' ' + n : '');
  }

  /* ---------- 決着（9/27 Naoto）：最終ストレートの差し・突き抜け・ズブズブ／3連単の入力 ---------- */

  function straightD() {
    var d = null;
    CONFIG.PHASES.forEach(function (p) { if (p.key === 'straight') d = p.d; });
    return d;
  }
  /** 先頭が最終ストレート（4角を抜けた後〜ゴール前）にいるか */
  function atStraight() {
    var ln = leaderNo();
    if (ln === null) return false;
    var ld = data().riders[ln].d;
    return ld <= straightD() + 0.004 && ld > 1e-6;
  }

  /** 着順（上位3人）→ ゴールでの並び。
      上位3人は1車身ずつの差（config.js の LAYOUT.finishGap）。3着までゴール線を完全に越えたところで止める。
      上位3人は内外が重ならないよう、いまの内外の順に 内・中・外 へ振る。
      4着以下はいまの並び順のまま、1.6車身後ろから内に一列 */
  function finishTarget(top) {
    var c = cars();
    var t = top.filter(function (n) { return c.indexOf(n) !== -1; }).slice(0, 3);
    var byLane = t.slice().sort(function (a, b) {
      var ra = data().riders[a], rb = data().riders[b];
      return (ra.lane - rb.lane) || (ra.d - rb.d);
    });
    /* 3人ともゴール線を完全に越えるまで走る（9/27 Naoto）：3着の丸の後ろの縁がゴール線から約0.2車身先。
       1着はその0.7車身先、2着は0.35車身先。4着以下は1着からの間隔を今までどおり（1.6車身〜）＝ゴール線の手前に残る */
    var third = -(CONFIG.iconPx(data().iconRatio) / 2 + 0.2 * 56) / CONFIG.LAP;   // 丸の半径＋0.2車身（56px基準）ぶん先
    /* 着差＝1車身ずつ（9/27 Naoto「着順が分かりづらい」→旧0.35車身から広げた）。4着以下は3着から1.3車身後ろ〜 */
    var GAP = CONFIG.LAYOUT.finishGap;
    var win = third - (t.length - 1) * GAP * CAR;
    var target = {};
    t.forEach(function (no, i) {
      target[no] = { d: win + i * GAP * CAR, lane: [-1, 0, 1][byLane.indexOf(no)] };
    });
    var restHead = win + ((t.length - 1) * GAP + 1.3) * CAR;
    byD(c.filter(function (n) { return t.indexOf(n) === -1; })).forEach(function (no, j) {
      target[no] = { d: restHead + j * CONFIG.LAYOUT.gapInLine * CAR, lane: -1 };
    });
    return target;
  }

  /** 上位3人を埋める：指定の着順のあと、いまの並び順で次にいる選手から足す */
  function fillTop(first) {
    var out = first.filter(function (n, i, a) { return n != null && a.indexOf(n) === i; });
    byD(cars()).forEach(function (n) { if (out.length < 3 && out.indexOf(n) === -1) out.push(n); });
    return out.slice(0, 3);
  }

  /** 3連単の文字（例 4-2-7 / 427 / ４－２－７）→ 着順。出ていない車番・重複はエラー */
  function parseTrifecta(text) {
    var digits = (Lineup.normalize(text).match(/[1-9]/g) || []).map(Number);
    if (digits.length !== 3) return { error: '3連単は車番を3つ入れてください（例 4-2-7）' };
    if (digits[0] === digits[1] || digits[1] === digits[2] || digits[0] === digits[2]) return { error: '同じ車番が入っています（' + digits.join('-') + '）' };
    var c = cars(), miss = digits.filter(function (n) { return c.indexOf(n) === -1; });
    if (miss.length) return { error: miss.join('・') + ' 番は盤面に出ていません' };
    return { finish: digits };
  }
  /* ---------- 動詞 ---------- */

  /** 上昇：選んだラインが外を上がって、先頭（前受け）ラインの前に入る。前受けは引いて後ろへ。全体＋1車身 */
  function joushou(sel) {
    var L = lineOf(sel.nos[0]);
    var order = linesInOrder();
    var front = order[0];
    if (sameLine(front, L)) return { error: 'すでに先頭のラインです（上昇は後ろのラインを選んでください）' };
    var rest = order.filter(function (l) { return !sameLine(l, L) && !sameLine(l, front); });
    var newOrder = [L, front].concat(rest);
    var head = Math.max(0, headD(front) - 1 * CAR);
    return { paths: requeue(newOrder, head, L), hint: '上昇：' + L.join('') + ' が上がって、' + front.join('') + ' の前に入りました' };
  }

  /** まくり：選んだ選手（ラインの先頭ならライン全員）が外を上がって先頭の横まで。全体＋1車身 */
  function makuri(sel) {
    var S = sel.type === 'line' ? lineOf(sel.nos[0]) : sel.nos.slice();
    if (sel.type === 'rider') {
      var L = lineOf(sel.nos[0]);
      if (L[0] === sel.nos[0]) S = L;   // ラインの先頭を選んだら後続も続く
    }
    var lead = leaderNo();
    if (S.indexOf(lead) !== -1) return { error: '先頭の選手・ラインはまくれません（後ろの選手を選んでください）' };
    var paths = basePaths(1);
    var lf = finalOf(paths, lead);
    var laneOut = Math.min(1, Math.max(0, lf.lane + 1));
    S.forEach(function (no, i) {
      var fin = { d: lf.d + i * CONFIG.LAYOUT.gapInLine * CAR, lane: laneOut };
      paths[no] = passPath(no, fin, laneOut, 0.2, 0.95);
    });
    return { paths: paths, hint: 'まくり：' + S.join('') + ' が外から ' + label(lead) + ' の横まで上がりました' };
  }

  /** 差し／突き抜け共通：主語が相手の前へ（空いている側のレーンを通る）。全体＋2車身 */
  function passOver(no, target, name) {
    var paths = basePaths(2);
    var tf = finalOf(paths, target);
    var passLane = tf.lane < 1 ? Math.round(tf.lane) + 1 : 0;
    var fin = { d: Math.max(0, tf.d - 1.2 * CAR), lane: passLane };
    paths[no] = passPath(no, fin, passLane, 0.25, 0.9);
    return { paths: paths, hint: name + '：' + label(no) + ' が ' + label(target) + ' の前へ' };
  }

  /** 差し：すぐ前の選手を空いている側から交わす */
  function sashi(sel) {
    var no = sel.type === 'line' ? lineOf(sel.nos[0])[1] || sel.nos[0] : sel.nos[0];
    var me = data().riders[no], best = null;
    cars().forEach(function (o) {
      if (o === no) return;
      var r = data().riders[o];
      if (r.d < me.d - 1e-6 && (best === null || r.d > data().riders[best].d)) best = o;
    });
    if (best === null) return { error: label(no) + ' の前に選手がいません' };
    /* 最終ストレートなら、交わしてそのままゴール＝1着 主語・2着 交わされた選手（9/27） */
    if (atStraight()) return { finish: fillTop([no, best]), hint: '差し：' + label(no) + ' が ' + label(best) + ' を差して1着' };
    return passOver(no, best, '差し');
  }

  /** 突き抜け：番手が同じラインの先頭を交わす */
  function tsukinuke(sel) {
    var no = sel.type === 'line' ? lineOf(sel.nos[0])[1] : sel.nos[0];
    if (no == null) return { error: '単騎のラインです（突き抜けは番手の選手を選んでください）' };
    var L = lineOf(no);
    if (L[0] === no) return { error: label(no) + ' はラインの先頭です（突き抜けは番手の選手を選んでください）' };
    /* 最終ストレートなら 1着 番手・2着 ラインの先頭・3着 ラインの3番手（いなければ次の選手） */
    if (atStraight()) {
      var third = L.length > 2 ? L[L.indexOf(no) + 1] : null;
      return { finish: fillTop([no, L[0], third]), hint: '突き抜け：' + label(no) + ' が ' + label(L[0]) + ' を抜いて1着' };
    }
    return passOver(no, L[0], '突き抜け');
  }

  /** 押切：先頭がそのままゴールへ。主語だけ＋0.5車身（差が開いて逃げ切る絵） */
  function oshikiri(sel) {
    var no = sel.type === 'line' ? lineOf(sel.nos[0])[0] : sel.nos[0];
    var lead = leaderNo();
    if (no !== lead) return { error: '押切は先頭の選手で使います（いまの先頭は ' + label(lead) + '）' };
    var ld = data().riders[lead].d;
    if (ld > 1.0 + 1e-6) return { error: '押切は最終周回（最終ホーム以降）で使ってください' };
    var paths = {};
    cars().forEach(function (o) {
      var p = pos(o);
      var fd = o === lead ? 0 : Math.max(0.2 * CAR, p.d - ld + 0.5 * CAR);
      paths[o] = [{ t: 0, d: p.d, lane: p.lane }, { t: 1, d: fd, lane: p.lane }];
    });
    return { paths: paths, hint: '押切：' + label(lead) + ' がそのままゴールへ', long: true };
  }

  /** ブロック：主語が外へ1レーン振り、外にいた相手をさらに外へ・後ろへ（止められた絵） */
  function block(sel) {
    var no = sel.type === 'line' ? (lineOf(sel.nos[0])[1] || sel.nos[0]) : sel.nos[0];
    var me = data().riders[no], best = null, bestGap = null;
    cars().forEach(function (o) {
      if (o === no) return;
      var r = data().riders[o];
      var gap = r.d - me.d;   // ＋＝相手が後ろ
      if (r.lane > me.lane + 0.5 && gap > -0.6 * CAR && gap < 1.5 * CAR) {
        if (best === null || Math.abs(gap) < Math.abs(bestGap)) { best = o; bestGap = gap; }
      }
    });
    if (best === null) return { error: label(no) + ' の外（横〜少し後ろ）に選手がいません' };
    var paths = basePaths(0.5);
    var myF = finalOf(paths, no), tF = finalOf(paths, best);
    var myLane = Math.min(1, Math.round(me.lane) + 1);
    var tLane = Math.min(1, myLane + 1);
    paths[no] = [{ t: 0, d: me.d, lane: me.lane }, { t: 0.5, d: me.d + (myF.d - me.d) * 0.5, lane: myLane }, { t: 1, d: myF.d, lane: myLane }];
    var t0 = data().riders[best];
    var tFinD = Math.max(tF.d, myF.d) + 1.2 * CAR;
    paths[best] = [{ t: 0, d: t0.d, lane: t0.lane }, { t: 0.45, d: t0.d + (tFinD - t0.d) * 0.3, lane: tLane }, { t: 1, d: tFinD, lane: tLane }];
    return { paths: paths, hint: 'ブロック：' + label(no) + ' が外へ振って ' + label(best) + ' を止めました' };
  }

  /** 順番を前へ／後ろへ：選んだラインを隣のラインと入れ替える（一列に並べ直す） */
  function reorder(sel, dir) {
    var L = lineOf(sel.nos[0]);
    var order = linesInOrder();
    var i = -1;
    order.forEach(function (l, k) { if (sameLine(l, L)) i = k; });
    var j = i + (dir < 0 ? -1 : 1);
    if (i < 0) return { error: 'ラインが見つかりません' };
    if (j < 0) return { error: 'すでに先頭のラインです' };
    if (j >= order.length) return { error: 'すでに最後尾のラインです' };
    var newOrder = order.slice();
    newOrder[i] = order[j]; newOrder[j] = order[i];
    var movers = dir < 0 ? L : order[j];   // 前へ出る側が真ん中のレーンを通る
    var head = headD(order[0]);
    return { paths: requeue(newOrder, head, movers),
             hint: '順番を' + (dir < 0 ? '前へ' : '後ろへ') + '：' + newOrder.map(function (l) { return l.join(''); }).join(' ') };
  }

  var TABLE = {
    joushou: { label: '上昇', fn: joushou },
    makuri: { label: 'まくり', fn: makuri },
    sashi: { label: '差し', fn: sashi },
    tsukinuke: { label: '突き抜け', fn: tsukinuke },
    oshikiri: { label: '押切', fn: oshikiri },
    block: { label: 'ブロック', fn: block },
    /* ズブズブ＝ラインで決着（先頭・番手・3番手がそのままの順でゴール）。最終ストレートでだけ使える */
    zubu: { label: 'ズブズブ', fn: function (sel) {
      if (!atStraight()) return { error: 'ズブズブは最終ストレートで使ってください（局面ボタン「最終ストレート」）' };
      var L = lineOf(sel.nos[0]);
      return { finish: fillTop(L.slice(0, 3)), hint: 'ズブズブ：ライン ' + L.join('') + ' で決着' };
    } },
    up: { label: '順番を前へ', fn: function (s) { return reorder(s, -1); } },
    down: { label: '順番を後ろへ', fn: function (s) { return reorder(s, 1); } }
  };

  return {
    TABLE: TABLE,
    lineOf: lineOf,
    finishTarget: finishTarget,
    parseTrifecta: parseTrifecta,
    atStraight: atStraight,
    label: label,
    /** @param {string} key  @param {{type:'rider'|'line', nos:number[]}} sel */
    run: function (key, sel) {
      var v = TABLE[key];
      if (!v) return { error: '不明な動き' };
      if (!sel || !sel.nos || !sel.nos.length) return { error: '先に選手かラインをクリックして選んでください' };
      return v.fn(sel);
    }
  };
})();
