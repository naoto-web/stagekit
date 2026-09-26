/* ===========================================================
   verbs.js — 動詞ボタン（展開の台本）  v2.1（要件定義_v2 §6.5・9/27 Naoto確定＝6つ＋順番の入れ替え）
   9/27 追加＝カマシ・カマシ失敗・飛びつき・飛びつき失敗（打鐘〜最終ホームの主導権争い。成功は無印・失敗は「失敗」付き）

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
    var lanes = {};
    movers.forEach(function (no) { lanes[no] = 0; });
    return requeueLanes(order, head, lanes);
  }
  /** requeue の一般形：passLanes＝{車番: 追い抜きに使うレーン}。載っていない選手は内のまま前後だけ動く。
      上昇＝主語は外・あいだのラインは真ん中、のように追い抜く側どうしのレーンを分けて重ならないようにする */
  function requeueLanes(order, head, passLanes) {
    var fin = Lineup.layout(order, head), paths = {};
    if (pacerGone()) noRetreat(fin);
    cars().forEach(function (no) {
      var p = pos(no), f = fin[no] || { d: p.d, lane: p.lane };
      if (passLanes[no] != null) paths[no] = passPath(no, f, passLanes[no]);
      else paths[no] = [{ t: 0, d: p.d, lane: p.lane }, { t: 0.6, d: p.d + (f.d - p.d) * 0.6, lane: f.lane }, { t: 1, d: f.d, lane: f.lane }];
    });
    return paths;
  }

  /** 誘導員がもう退いているか（先頭が打鐘の位置を過ぎた）。board.js の出し入れと同じ境目 */
  function pacerGone() {
    var ln = leaderNo();
    return ln !== null && data().riders[ln].d <= CONFIG.BELL_D + 1e-4;
  }
  /** 誰も後ろ向きに進まないよう、行き先を全体に前へずらす（打鐘を過ぎた後の並べ替え用）。
      🐞9/27 Naoto「打鐘でカマシを入れると一瞬誘導員が出る」＝叩かれたラインが引く途中で先頭が打鐘の手前へ戻り、
      誘導員の出し入れ（先頭の位置で決まる）が反応した。全員が前へ進めば先頭は戻らない＝実際のレースとも同じ */
  function noRetreat(fin) {
    var s = 0;
    cars().forEach(function (no) { if (fin[no]) s = Math.max(s, fin[no].d - pos(no).d); });
    if (s > 0) Object.keys(fin).forEach(function (no) { fin[no].d -= s; });
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

  /** 上昇（押さえ）：選んだラインが外を上がって、先頭（前受け）ラインの前に入る。前受けは主語のすぐ後ろへ。全体＋1車身。
      ※9/27に一度「前受けは引いて最後尾へ」に変えたが、あいだのラインまで一緒に上がってくる絵になるため元に戻した（Naoto） */
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

  /** カマシ：打鐘〜ホーム。選んだラインが外を一気に上がって先頭に入る。叩かれたラインは引かずにすぐ後ろへ。
      上昇より速い（config.js の ANIM.kamashiMs）。全体＋2車身 */
  function kamashi(sel) {
    var L = lineOf(sel.nos[0]);
    var order = linesInOrder();
    var front = order[0];
    if (sameLine(front, L)) return { error: 'すでに先頭のラインです（カマシは後ろのラインを選んでください）' };
    var rest = order.filter(function (l) { return !sameLine(l, L) && !sameLine(l, front); });
    var lanes = {};
    L.forEach(function (no) { lanes[no] = 1; });
    var head = Math.max(0, headD(front) - 2 * CAR);
    return { paths: requeueLanes([L, front].concat(rest), head, lanes), ms: CONFIG.ANIM.kamashiMs,
             hint: 'カマシ：' + L.join('') + ' が一気に叩いて先頭へ、' + front.join('') + ' はその後ろ' };
  }

  /** カマシ失敗（旧名「突っ張り」）：選ぶのはカマシと同じく上がっていく側。真ん中のレーンを上がり、先頭ラインの番手の横で
      並んだところで突っ張られ、そのまま下がって最後尾の内へ。先頭ラインは先行を続ける。全体＋2車身 */
  function kamashiFail(sel) {
    var L = lineOf(sel.nos[0]);
    var order = linesInOrder();
    var front = order[0];
    if (sameLine(front, L)) return { error: 'すでに先頭のラインです（カマシ失敗は後ろのラインを選んでください）' };
    var newOrder = order.filter(function (l) { return !sameLine(l, L); }).concat([L]);
    var head = Math.max(0, headD(front) - 2 * CAR);
    var fin = Lineup.layout(newOrder, head), paths = {};
    if (pacerGone()) noRetreat(fin);
    cars().forEach(function (no) {
      var p = pos(no), f = fin[no] || { d: p.d, lane: p.lane };
      paths[no] = [{ t: 0, d: p.d, lane: p.lane }, { t: 1, d: f.d, lane: f.lane }];
    });
    /* 並ぶ相手＝先頭ラインの番手（単騎なら先頭）。t の時点での位置は、その選手の直線の通り道から求める */
    var mate = front[1] != null ? front[1] : front[0];
    var m0 = pos(mate).d, m1 = fin[mate].d;
    function mateAt(t) { return m0 + (m1 - m0) * t; }
    var gap = CONFIG.LAYOUT.gapInLine * CAR;
    L.forEach(function (no, i) {
      var p = pos(no), f = fin[no];
      paths[no] = [
        { t: 0, d: p.d, lane: p.lane },
        { t: 0.15, d: p.d + (mateAt(0.45) + i * gap - p.d) * 0.2, lane: 0 },
        { t: 0.45, d: mateAt(0.45) + i * gap, lane: 0 },   // 番手の横で並ぶ
        { t: 0.6, d: mateAt(0.6) + i * gap, lane: 0 },     // 突っ張られて並んだまま少し
        { t: 0.88, d: f.d - 0.3 * CAR, lane: 0 },          // 下がって最後尾へ
        { t: 1, d: f.d, lane: f.lane }
      ];
    });
    return { paths: paths, hint: 'カマシ失敗：' + front.join('') + ' に突っ張られて、' + L.join('') + ' は出切れず最後尾へ' };
  }

  /** 飛びつき（成功／失敗）の共通：主語と先頭ラインを決める。できなければ { error } */
  function tobiPrep(sel, name) {
    var no = sel.type === 'line' ? lineOf(sel.nos[0])[0] : sel.nos[0];
    var front = linesInOrder()[0];
    if (front.indexOf(no) !== -1) return { error: label(no) + ' は先頭のラインです（' + name + 'は後ろの選手を選んでください）' };
    if (front.length < 2) return { error: '先頭が単騎なので、飛びつく番手の位置がありません' };
    return { no: no, front: front, paths: basePaths(1) };
  }
  /** 直線の通り道の t の時点の d（basePaths の選手用） */
  function dAt(path, t) { return path[0].d + (path[path.length - 1].d - path[0].d) * t; }

  /** 飛びつき（成功）：選んだ選手が先頭ラインの番手を奪う。真ん中のレーンを上がって番手の横に並び、内へ入る。
      元の番手から後ろの全員（主語を除く）は1車身ずつ下がって場所を空ける（主語が内へ入る前に下がり終える＝重ならない）。
      先頭ラインの後ろだけ下げると、主語が遠くから来たときに先頭ラインの最後尾が次のラインに詰まって重なるため全員。全体＋1車身 */
  function tobitsuki(sel) {
    var r = tobiPrep(sel, '飛びつき');
    if (r.error) return r;
    var paths = r.paths, no = r.no, front = r.front, p = pos(no);
    var bf = finalOf(paths, front[1]);   // 番手の行き先＝主語が収まる場所
    var gap = CONFIG.LAYOUT.gapInLine * CAR;
    var bd = pos(front[1]).d;
    cars().filter(function (o) { return o !== no && pos(o).d >= bd - 1e-9; }).forEach(function (o) {
      var base = paths[o], f = finalOf(paths, o);
      paths[o] = [
        { t: 0, d: base[0].d, lane: base[0].lane },
        { t: 0.5, d: dAt(base, 0.5), lane: f.lane },
        { t: 0.8, d: f.d + gap, lane: f.lane },   // 主語が内へ入る前に1車身下がる
        { t: 1, d: f.d + gap, lane: f.lane }
      ];
    });
    paths[no] = [
      { t: 0, d: p.d, lane: p.lane },
      { t: 0.25, d: p.d + (bf.d - p.d) * 0.2, lane: 0 },
      { t: 0.6, d: bf.d, lane: 0 },       // 番手の横に並ぶ
      { t: 0.8, d: bf.d, lane: 0 },
      { t: 1, d: bf.d, lane: -1 }         // 内へ入って番手を奪う
    ];
    return { paths: paths, hint: '飛びつき：' + label(no) + ' が ' + label(front[0]) + ' の番手を奪いました' };
  }

  /** 飛びつき失敗：番手の横まで来て弾かれ、元の位置（全体と一緒に進んだ位置）へ戻る。全体＋1車身 */
  function tobitsukiFail(sel) {
    var r = tobiPrep(sel, '飛びつき失敗');
    if (r.error) return r;
    var paths = r.paths, no = r.no, front = r.front, p = pos(no);
    var mate = paths[front[1]], back = finalOf(paths, no);
    paths[no] = [
      { t: 0, d: p.d, lane: p.lane },
      { t: 0.15, d: p.d + (dAt(mate, 0.45) - p.d) * 0.2, lane: 0 },
      { t: 0.45, d: dAt(mate, 0.45), lane: 0 },   // 番手の横に並ぶ
      { t: 0.6, d: dAt(mate, 0.6), lane: 0 },     // 弾かれる
      { t: 0.88, d: back.d, lane: 0 },            // 元の位置へ下がる
      { t: 1, d: back.d, lane: p.lane }
    ];
    return { paths: paths, hint: '飛びつき失敗：' + label(no) + ' は ' + label(front[1]) + ' に弾かれて元の位置へ' };
  }

  /** まくり（成功・失敗）の共通：主語（ラインの先頭を選んだら後続も続く）・先頭・外のレーン */
  function makuriPrep(sel, adv) {
    var S = sel.type === 'line' ? lineOf(sel.nos[0]) : sel.nos.slice();
    if (sel.type === 'rider') {
      var L = lineOf(sel.nos[0]);
      if (L[0] === sel.nos[0]) S = L;   // ラインの先頭を選んだら後続も続く
    }
    var lead = leaderNo();
    if (S.indexOf(lead) !== -1) return { error: '先頭の選手・ラインはまくれません（後ろの選手を選んでください）' };
    var paths = basePaths(adv);
    var lf = finalOf(paths, lead);
    return { S: S, lead: lead, paths: paths, lf: lf, laneOut: Math.min(1, Math.max(0, lf.lane + 1)) };
  }

  /** まくり（成功＝まくり切る・9/27 Naoto）：外を上がって先頭を抜き去り、前に出て内へ入る。後続も付いてくる。全体＋2車身。
      旧＝先頭の横まで来て止まる（まくり切るか止められるかは手で決める必要があった） */
  function makuri(sel) {
    var r = makuriPrep(sel, 2);
    if (r.error) return r;
    var gap = CONFIG.LAYOUT.gapInLine * CAR, n = r.S.length;
    r.S.forEach(function (no, i) {
      /* 最後尾の主語が元の先頭の1.3車身前＝内へ入っても重ならない */
      var fin = { d: r.lf.d - (n - i) * gap - 0.25 * CAR, lane: -1 };
      r.paths[no] = passPath(no, fin, r.laneOut, 0.2, 0.82);
    });
    return { paths: r.paths, hint: 'まくり：' + r.S.join('') + ' が外から ' + label(r.lead) + ' をまくり切りました' };
  }

  /** まくり失敗（9/27 Naoto）：先頭ラインの番手にブロックされて引く。
      主語は外のレーンを上がり、番手の横まで来たところで番手が外へ振って止める→主語は元の位置（全体と一緒に進んだ位置）へ引く。
      番手はブロックの後、元の位置に戻る。先頭が単騎なら先頭が止める。全体＋1車身。
      カマシ失敗（突っ張られる）との違い＝止めるのが番手の横の動き（ブロック）で、主語は最後尾ではなく元の位置へ */
  function makuriFail(sel) {
    var r = makuriPrep(sel, 1);
    if (r.error) return r;
    var front = lineOf(r.lead);
    var blocker = front.length > 1 && r.S.indexOf(front[1]) === -1 ? front[1] : r.lead;
    var gap = CONFIG.LAYOUT.gapInLine * CAR;
    var bp = r.paths[blocker];
    function bAt(t) { return dAt(bp, t); }
    var bLane = pos(blocker).lane;
    var swing = Math.min(1, Math.round(bLane) + 1);          // 番手が振る先（1つ外）
    var sLane = Math.min(1, swing + 1);                      // 主語はさらに外＝番手と重ならない
    r.S.forEach(function (no, i) {
      var p = pos(no), back = finalOf(r.paths, no);
      r.paths[no] = [
        { t: 0, d: p.d, lane: p.lane },
        { t: 0.15, d: p.d + (bAt(0.45) + i * gap - p.d) * 0.2, lane: sLane },
        { t: 0.45, d: bAt(0.45) + i * gap, lane: sLane },   // 番手の横まで
        { t: 0.6, d: bAt(0.6) + i * gap, lane: sLane },     // ブロックされる
        { t: 0.88, d: back.d, lane: sLane },                // 引く
        { t: 1, d: back.d, lane: p.lane }                   // 元の位置へ
      ];
    });
    var bf = finalOf(r.paths, blocker);
    r.paths[blocker] = [
      { t: 0, d: bp[0].d, lane: bLane },
      { t: 0.35, d: bAt(0.35), lane: bLane },
      { t: 0.5, d: bAt(0.5), lane: swing },   // 外へ振って止める
      { t: 0.65, d: bAt(0.65), lane: swing },
      { t: 0.9, d: bAt(0.9), lane: bLane },   // 元の位置へ戻る
      { t: 1, d: bf.d, lane: bLane }
    ];
    return { paths: r.paths, hint: 'まくり失敗：' + label(blocker) + ' のブロックで ' + r.S.join('') + ' は止められて引きました' };
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

  /** ブロック：主語が外へ1レーン振り、外にいた相手をさらに外へ・後ろへ（止められた絵）。
      主語はブロックの後、元のレーンに戻る（9/27 Naoto）。旧＝外へ振ったまま止まっていた */
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
    paths[no] = [{ t: 0, d: me.d, lane: me.lane }, { t: 0.4, d: me.d + (myF.d - me.d) * 0.4, lane: myLane },
                 { t: 0.65, d: me.d + (myF.d - me.d) * 0.65, lane: myLane }, { t: 1, d: myF.d, lane: me.lane }];
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
    kamashi: { label: 'カマシ', fn: kamashi },
    kamashiFail: { label: 'カマシ失敗', fn: kamashiFail },
    tobitsuki: { label: '飛びつき', fn: tobitsuki },
    tobitsukiFail: { label: '飛びつき失敗', fn: tobitsukiFail },
    makuri: { label: 'まくり', fn: makuri },
    makuriFail: { label: 'まくり失敗', fn: makuriFail },
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
