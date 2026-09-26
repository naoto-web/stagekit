/* ===========================================================
   anim.js — 動きのアニメ  v2（要件定義_v2 §7）

   2種類ある
   ① Anim.to()      ＝ドック側。局面ボタンなどで「目標の隊列」へ滑らかに動かす。
                       途中経過をそのまま State に書いて出力へ流す＝ドックと出力で同じ動き
                       遠いジャンプは周回数だけ裏で合わせ、見た目は今の位置から1周以内で動かす
                       （戻すときは逆走・進むときは前へ）
   ② Anim.Smoother  ＝出力側。届いた状態（約30fps）へ毎フレーム追いつく＝カクつかない。
                       大きく飛んだとき（0.2周超）は追わずに瞬間移動（①のワープをそのまま見せる）
   =========================================================== */

var Anim = (function () {

  var raf = (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame.bind(window)
    : function (f) { return setTimeout(function () { f(Date.now()); }, 16); };
  var caf = (typeof cancelAnimationFrame === 'function')
    ? cancelAnimationFrame.bind(window)
    : clearTimeout;

  var cur = null;   // 実行中のアニメ { id, done }

  function isHidden() {
    try { return typeof document !== 'undefined' && document.hidden === true; } catch (e) { return false; }
  }

  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  function stop() {
    if (!cur) return;
    caf(cur.id);
    var done = cur.done;
    cur = null;
    if (done) done(false);
  }

  /**
   * 目標の隊列へ動かす（ドック側）
   * @param {Object} target  { no: {d, lane} }
   * @param {{ms?:number, onFrame:Function, onDone?:Function}} o
   */
  function to(target, o) {
    stop();
    var data = State.data;
    var from = {}, maxAbs = 0, sign = 1;
    Object.keys(target).forEach(function (no) {
      var r = data.riders[no];
      if (!r) return;
      from[no] = { d: r.d, lane: r.lane };
      var dd = target[no].d - r.d;
      if (Math.abs(dd) > maxAbs) { maxAbs = Math.abs(dd); sign = dd < 0 ? -1 : 1; }
    });

    /* 今いる位置から動かす（9/27 Naoto「スタート・赤板を押すとどこかへ移動してしまう」）。
       旧＝遠いジャンプは「目的地の半周手前へワープ」→見た目が飛んでいた。
       新＝コース上の見た目は1周ごとに同じなので、**周回数だけ裏で合わせる（見た目は動かない）**。
         戻す（d が増える）＝今の位置からコースを逆走して1周未満で戻る
         進む（d が減る）  ＝今の位置から前へ。ちょうど整数周なら1周回って同じ場所へ */
    /* 基準の移動量＝先頭どうしの差（o.dd）。隊形が変わる（升目⇔一列）ときは選手ごとに移動量が違うので、
       周回合わせは先頭の差で決め、各選手はそこからの差を同じ時間で埋める */
    var dd0 = (o && typeof o.dd === 'number') ? o.dd : sign * maxAbs, v;
    if (dd0 > 0) {
      v = dd0 % 1;
      if (v < 1e-6 || 1 - v < 1e-6) v = 0;            // 同じ場所＝動かさない
      /* 隊形が変わる（一列→升目）ときはちょうど整数周でも1周逆走させる＝走りながら位置が入れ替わる絵にする */
      if (v === 0 && o && o.lapIfWhole && dd0 >= 0.98) v = 1;
    } else {
      v = -((-dd0) % 1);
      if (-v < 0.02 || 1 + v < 1e-6) v = (-dd0 >= 0.98) ? -1 : v;   // ちょうど整数周＝1周回る
    }
    var shift = dd0 - v;                               // 整数周（見た目は変わらない）
    Object.keys(from).forEach(function (no) {
      from[no] = { d: from[no].d + shift, lane: from[no].lane };
    });
    /* 実際に動く最大量（隊形の変化ぶんも含む） */
    maxAbs = 0;
    Object.keys(from).forEach(function (no) {
      maxAbs = Math.max(maxAbs, Math.abs(target[no].d - from[no].d), Math.abs(target[no].lane - from[no].lane) * 0.05);
    });
    if (maxAbs < 1e-6) {
      Object.keys(from).forEach(function (no) { State.moveRider(+no, target[no].d, target[no].lane); });
      if (o && o.onFrame) o.onFrame(true);
      if (o && o.onDone) o.onDone(true);
      return;
    }
    /* 速さは config.js の ANIM（9/27 Naoto「速いのでもっとゆっくり」→半周で約2.4秒） */
    var A = CONFIG.ANIM;
    var ms = (o && o.ms) || Math.round(Math.min(A.maxMs, A.baseMs + maxAbs * A.msPerLap));
    /* ドックが隠れている（別タブ等）ときは rAF が止まる＝途中の隊列のまま出力に残る。
       rAF を待たずにその場で目標へ置く */
    if (isHidden()) {
      Object.keys(from).forEach(function (no) { State.moveRider(+no, target[no].d, target[no].lane); });
      if (o && o.onFrame) o.onFrame(true);
      if (o && o.onDone) o.onDone(true);
      return;
    }
    var t0 = null;
    var me = { id: 0, done: o && o.onDone };
    cur = me;

    function frame(ts) {
      if (cur !== me) return;
      if (t0 === null) t0 = ts;
      var t = Math.min(1, (ts - t0) / ms);
      var k = ease(t);
      /* bump＝追い抜く選手を途中だけ外へふくらませる量（升目⇔一列の位置取りで丸が重ならないように）。
         内外は位置の動き（k）より少し早めに寄せ切る＝最後の直線ではもう目標のレーンにいる */
      var kl = ease(Math.min(1, t * 1.15)), bump = (o && o.bump) || {};
      Object.keys(from).forEach(function (no) {
        var a = from[no], b = target[no];
        if (t >= 1) { State.moveRider(+no, b.d, b.lane); return; }   // 終点は目標ぴったり（小数の誤差を残さない）
        var ln = a.lane + (b.lane - a.lane) * kl + (bump[no] || 0) * Math.sin(Math.PI * Math.min(1, t * 1.15));
        State.moveRider(+no, a.d + (b.d - a.d) * k, ln);
      });
      if (o && o.onFrame) o.onFrame(t >= 1);
      if (t < 1) { me.id = raf(frame); return; }
      cur = null;
      if (me.done) me.done(true);
    }
    me.id = raf(frame);
  }

  /* ---- 通り道の計画（動き出す前に1回だけ・9/27） ----
     升目⇔一列では「下がる選手が先に下がって場所を空け、そのあと上がる選手が通る」ような
     途中で何度かレーンを変える動きが要る（3レーンしかないので、1本の通り道では必ずすれ違う）。
     ・通り道＝レーンの経由地5つ（内/中/外）×前後の入れ替えのタイミング（中心5通り×長さ2通り）＝2,430通り
       レーンは 始点（元のレーン）→経由地5つ→終点（目標のレーン）をなめらかにつなぐ
     ・1人ずつ「すでに決まった選手と近すぎる量＋好み（レーン替えが少ない・前へ上がる選手は外）」が
       最小の通り道を選ぶ。選ぶ順番を4通り試し、合計がいちばん小さい計画を採る */

  var S = 56, K = 5, NEED = 48;
  var LAPPX = CONFIG.LAP, LANEPX = CONFIG.TRACK.LANE;
  function smooth(a, b, t) { var x = Math.max(0, Math.min(1, (t - a) / (b - a))); return x * x * (3 - 2 * x); }
  function laneAt(s, op, t) {
    /* 経由地の時刻＝20%〜80%を等分（最初の経由地が早いと横移動が急になり、同じ列の選手を横切った）。
       始点 t=0 は元のレーン、終点 t=1 は目標のレーン */
    var ts = [0], ls = [s.laneA];
    for (var k = 0; k < K; k++) { ts.push(0.2 + 0.6 * k / (K - 1)); ls.push(op.ls[k]); }
    ts.push(1); ls.push(s.laneB);
    for (var q = 0; q < ts.length - 1; q++) {
      if (t <= ts[q + 1]) return ls[q] + (ls[q + 1] - ls[q]) * smooth(ts[q], ts[q + 1], t);
    }
    return s.laneB;
  }
  function relAt(s, op, t) {
    var a = Math.max(0.03, op.c - op.w / 2), b = Math.min(0.95, op.c + op.w / 2);
    return s.relA + (s.relB - s.relA) * smooth(a, b, t);
  }


  /** 計画本体。R＝{ no: {relA, relB, laneA, laneB, move, pref} } → { ops:{no:op}, overlap } */
  function planPaths(R, nos) {
    var CAR = CONFIG.CAR;
    /* 通り道の候補（全員共通の型） */
    var OPTS = [];
    var CS = [0.5, 0.4, 0.6, 0.3, 0.7], WS = [0.5, 0.3];
    for (var m = 0; m < Math.pow(3, K); m++) {
      var ls = [], x = m;
      for (var k2 = 0; k2 < K; k2++) { ls.push((x % 3) - 1); x = Math.floor(x / 3); }
      CS.forEach(function (cc) { WS.forEach(function (ww) { OPTS.push({ ls: ls, c: cc, w: ww }); }); });
    }
    /* 候補ごとの途中の位置（サンプル S-1 コマ）。選手ごとに始点・終点が違うので選手×候補で持つ */
    function track(no, op) {
      var s = R[no], arr = new Float64Array((S - 1) * 2);
      for (var k3 = 1; k3 < S; k3++) {
        var t = k3 / S;
        arr[(k3 - 1) * 2] = relAt(s, op, t) * LAPPX;
        arr[(k3 - 1) * 2 + 1] = laneAt(s, op, t) * LANEPX;
      }
      return arr;
    }
    function prefCost(no, op) {
      var s = R[no], cst = 0, prev = s.laneA;
      for (var k4 = 0; k4 < K; k4++) {
        cst += Math.abs(op.ls[k4] - s.pref) * 3;
        if (op.ls[k4] !== prev) cst += 5;
        prev = op.ls[k4];
      }
      if (prev !== s.laneB) cst += 2;
      return cst + Math.abs(op.c - 0.5) * 20 + (op.w === 0.5 ? 0 : 3);
    }
    function overlap(a, b) {
      var sum = 0;
      for (var k5 = 0; k5 < a.length; k5 += 2) {
        var dx = a[k5] - b[k5], dy = a[k5 + 1] - b[k5 + 1];
        var dsq = dx * dx + dy * dy;
        if (dsq < NEED * NEED) { var dd = NEED - Math.sqrt(dsq); sum += dd * dd; }
      }
      return sum;
    }
    /* 選手ごとの全候補の軌跡を先に作る */
    var TR = {};
    nos.forEach(function (no) { TR[no] = OPTS.map(function (op) { return track(no, op); }); });
    var PC = {};
    nos.forEach(function (no) { PC[no] = OPTS.map(function (op) { return prefCost(no, op); }); });

    function planWith(orderNos) {
      var fixed = [], pick = {}, sum = 0;
      orderNos.forEach(function (no) {
        var bestI = 0, bestC = Infinity;
        for (var i = 0; i < OPTS.length; i++) {
          var cst = PC[no][i];
          if (cst >= bestC) continue;
          for (var f = 0; f < fixed.length && cst < bestC; f++) cst += overlap(TR[no][i], fixed[f]) * 10;
          if (cst < bestC) { bestC = cst; bestI = i; }
        }
        pick[no] = bestI; fixed.push(TR[no][bestI]); sum += bestC;
      });
      return { pick: pick, cost: sum };
    }
    var byMove = nos.slice().sort(function (a, b) { return Math.abs(R[a].move) - Math.abs(R[b].move); });
    var orders = [
      byMove,                                   // 動きの小さい選手から（内を守る選手が先）
      byMove.slice().reverse(),                 // 動きの大きい選手から
      nos.slice().sort(function (a, b) { return R[a].relB - R[b].relB; }),   // 目標の前から
      nos.slice().sort(function (a, b) { return R[b].relB - R[a].relB; })    // 目標の後ろから
    ];
    var plan = null;
    orders.forEach(function (od) { var p = planWith(od); if (!plan || p.cost < plan.cost) plan = p; });

    /* 手直し：ほかの全員を固定して1人ずつ通り道を引き直す（先に決めた人が後の人を詰ませるのを解く）。
       重なりが無くなるか、改善が止まるまで最大6周 */
    function overlapOf(no, i, pick) {
      var sum = 0;
      nos.forEach(function (o2) { if (o2 !== no) sum += overlap(TR[no][i], TR[o2][pick[o2]]); });
      return sum;
    }
    function totalOverlap(pick) {
      var sum = 0;
      for (var a = 0; a < nos.length; a++) for (var b = a + 1; b < nos.length; b++) sum += overlap(TR[nos[a]][pick[nos[a]]], TR[nos[b]][pick[nos[b]]]);
      return sum;
    }
    var pick = plan.pick;
    for (var round = 0; round < 6 && totalOverlap(pick) > 0; round++) {
      var changed = false;
      nos.forEach(function (no) {
        var curI = pick[no], curC = PC[no][curI] + overlapOf(no, curI, pick) * 10;
        for (var i = 0; i < OPTS.length; i++) {
          if (i === curI || PC[no][i] >= curC) continue;
          var cst = PC[no][i] + overlapOf(no, i, pick) * 10;
          if (cst < curC - 1e-9) { curC = cst; curI = i; }
        }
        if (curI !== pick[no]) { pick[no] = curI; changed = true; }
      });
      if (!changed) break;
    }
    /* 焼きなまし：2人以上が同時に道を変えないと解けない形（9番が最後尾→先頭、3番が先頭→最後尾 など）を探す。
       ランダムに1人の道を変え、悪くなる変更もはじめは少し受け入れる。決まった乱数で毎回同じ答えになる */
    if (totalOverlap(pick) > 0) {
      var seed = 20260927;
      var rnd = function (n) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
      var costOf = function (no, i, pk) { return PC[no][i] + overlapOf(no, i, pk) * 10; };
      var cur2 = {}; nos.forEach(function (no) { cur2[no] = pick[no]; });
      var best2 = {}; nos.forEach(function (no) { best2[no] = pick[no]; });
      var bestOv = totalOverlap(pick), ITER = 90000;
      for (var it = 0; it < ITER; it++) {
        var temp = 3000 * Math.pow(0.0005, it / ITER);
        var no2 = nos[rnd(nos.length)], was = cur2[no2], cand = rnd(OPTS.length);
        if (cand === was) continue;
        var dlt = costOf(no2, cand, cur2) - costOf(no2, was, cur2);
        if (dlt < 0 || Math.exp(-dlt / temp) > rnd(100000) / 100000) {
          cur2[no2] = cand;
          if (dlt < 0 && it % 50 === 0) {
            var ov = totalOverlap(cur2);
            if (ov < bestOv) { bestOv = ov; nos.forEach(function (n) { best2[n] = cur2[n]; }); if (ov === 0) break; }
          }
        }
      }
      var ovEnd = totalOverlap(cur2);
      if (ovEnd < bestOv) { bestOv = ovEnd; nos.forEach(function (n) { best2[n] = cur2[n]; }); }
      if (bestOv < totalOverlap(pick)) pick = best2;
    }
    nos.forEach(function (no) { R[no].op = OPTS[pick[no]]; });
    var bestCost = totalOverlap(pick);
    var ops = {};
    nos.forEach(function (no) { ops[no] = R[no].op; });
    return { ops: ops, overlap: bestCost };
  }

  /* 計画の覚え書き（同じ組み替えは計算し直さない・逆向きは同じ道を逆再生） */
  var planCache = {};
  function r4(x) { return Math.round(x * 1e4) / 1e4; }
  function planKey(R, nos, swap) {
    return nos.slice().sort().map(function (no) {
      var s = R[no];
      return swap ? [no, r4(s.relB), s.laneB, r4(s.relA), s.laneA].join(',') : [no, r4(s.relA), s.laneA, r4(s.relB), s.laneB].join(',');
    }).join(';');
  }
  function buildR(fromPos, toPos, nos) {
    var CAR = CONFIG.CAR, leadFrom = null, leadTo = null;
    nos.forEach(function (no) {
      if (leadFrom === null || fromPos[no].d < leadFrom) leadFrom = fromPos[no].d;
      if (leadTo === null || toPos[no].d < leadTo) leadTo = toPos[no].d;
    });
    var R = {};
    nos.forEach(function (no) {
      var relA = fromPos[no].d - leadFrom, relB = toPos[no].d - leadTo, move = relA - relB;
      R[no] = { relA: relA, relB: relB, laneA: fromPos[no].lane, laneB: toPos[no].lane, move: move,
                pref: move > 0.5 * CAR ? 1 : (move < -0.5 * CAR ? 0 : toPos[no].lane) };
    });
    return R;
  }
  /** 計画を用意する（覚え書きにあればそれ・逆向きがあれば逆再生・無ければ計算）。
      返り値の各選手 s に op と rev（逆再生か）が付く */
  function getPlan(R, nos) {
    var key = planKey(R, nos, false);
    if (planCache[key]) { nos.forEach(function (no) { R[no].op = planCache[key].ops[no]; R[no].rev = false; }); return planCache[key]; }
    var rkey = planKey(R, nos, true);
    if (planCache[rkey]) {
      nos.forEach(function (no) {
        var s = R[no];
        R[no] = { relA: s.relB, relB: s.relA, laneA: s.laneB, laneB: s.laneA, op: planCache[rkey].ops[no], rev: true };
      });
      return planCache[rkey];
    }
    var p = planPaths(R, nos);
    planCache[key] = p;
    nos.forEach(function (no) { R[no].rev = false; });
    return p;
  }
  /** 先に計算しておく（レースを読み込んだ直後など・main.js から呼ぶ）。fromPos/toPos は { no:{d,lane} } */
  function prepare(fromPos, toPos) {
    var nos = Object.keys(toPos).filter(function (no) { return !!fromPos[no]; });
    if (nos.length < 2) return null;
    var R = buildR(fromPos, toPos, nos);
    return getPlan(R, nos);
  }
  /**
   * 隊形の組み替え（升目⇔一列）を「走りながらの位置取り」として動かす（9/27 Naoto）
   * ・先頭の進み（1周など）はふつうのアニメと同じ。各選手は先頭からの距離（rel）を中盤（10〜85%）で入れ替える
   * ・通るレーン（内/中/外）と入れ替えのタイミングを、動き出す前に全員まとめて計画する（下の「通り道の計画」）。
   *   前へ上がる選手は外・下がる選手は真ん中を好むが、重なりが少なくなるほうを優先する
   * ・フレームごとの早い者勝ちで選ぶ方式は、移動中の選手を見落として重なった（9/27の検査で最小13px）
   * 旧＝全員を同時に線形で動かしていたので、追い抜く選手と下がる選手が同じレーンで重なった（撮影で発見）
   * @param {Object} target { no: {d, lane} }
   * @param {{dd:number, lapIfWhole?:boolean, onFrame:Function, onDone?:Function}} o
   */
  function reform(target, o) {
    stop();
    var data = State.data, CAR = CONFIG.CAR;
    var nos = Object.keys(target).filter(function (no) { return !!data.riders[no]; });
    if (!nos.length) return;

    var leadFrom = null, leadTo = null;
    nos.forEach(function (no) {
      var r = data.riders[no];
      if (leadFrom === null || r.d < leadFrom) leadFrom = r.d;
      if (leadTo === null || target[no].d < leadTo) leadTo = target[no].d;
    });

    /* 先頭の進み＝to() と同じ周回合わせ */
    var dd0 = (typeof o.dd === 'number') ? o.dd : (leadTo - leadFrom), v;
    if (dd0 > 0) { v = dd0 % 1; if (v < 1e-6 || 1 - v < 1e-6) v = 0; if (v === 0 && o.lapIfWhole && dd0 >= 0.98) v = 1; }
    else { v = -((-dd0) % 1); if (-v < 0.02 || 1 + v < 1e-6) v = (-dd0 >= 0.98) ? -1 : v; }
    var headA = leadTo - v, headB = leadTo;

    var cur0 = {};
    nos.forEach(function (no) { cur0[no] = { d: data.riders[no].d, lane: data.riders[no].lane }; });
    var R = buildR(cur0, target, nos);
    var plan = getPlan(R, nos);
    var bestCost = plan.overlap;
    /* 逆再生のときは t を 1−t にして同じ道をたどる */
    function posAt(s, t) { var tt = s.rev ? 1 - t : t; return { rel: relAt(s, s.op, tt), lane: laneAt(s, s.op, tt) }; }
    /* 組み替えは位置取りを見せたいので、ふつうの局面アニメとは別の長さ（config.js の ANIM.reformMs） */
    var ms = o.ms || CONFIG.ANIM.reformMs;
    if (isHidden()) {
      nos.forEach(function (no) { State.moveRider(+no, target[no].d, target[no].lane); });
      if (o.onFrame) o.onFrame(true);
      if (o.onDone) o.onDone(true);
      return;
    }

    var t0 = null;
    var me = { id: 0, done: o.onDone };
    cur = me;

    function frame(ts) {
      if (cur !== me) return;
      if (t0 === null) t0 = ts;
      var t = Math.min(1, (ts - t0) / ms);
      if (t >= 1) {
        nos.forEach(function (no) { State.moveRider(+no, target[no].d, target[no].lane); });  
        if (o.onFrame) o.onFrame(true);
        cur = null;
        if (me.done) me.done(true);
        return;
      }
      var head = headA + (headB - headA) * ease(t);
      nos.forEach(function (no) {
        var p = posAt(R[no], t);
        State.moveRider(+no, head + p.rel, p.lane);
      });
      if (o.onFrame) o.onFrame(false);
      me.id = raf(frame);
    }
    me.id = raf(frame);
    return { overlap: bestCost };
  }
  /**
   * 通り道（キーフレーム）をなぞる（動詞ボタン用・v2.1）
   * @param {Object} paths { no: [{t:0,d,lane}, ..., {t:1,d,lane}] }  t は 0〜1
   * @param {{ms?:number, onFrame:Function, onDone?:Function}} o
   */
  function path(paths, o) {
    stop();
    var nos = Object.keys(paths);
    var ms = (o && o.ms) || CONFIG.ANIM.verbMs;
    function at(ks, t) {
      for (var i = 0; i < ks.length - 1; i++) {
        var a = ks[i], b = ks[i + 1];
        if (t <= b.t) {
          var x = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
          var e = x * x * (3 - 2 * x);
          return { d: a.d + (b.d - a.d) * e, lane: a.lane + (b.lane - a.lane) * e };
        }
      }
      var z = ks[ks.length - 1];
      return { d: z.d, lane: z.lane };
    }
    function finish() {
      nos.forEach(function (no) { var z = paths[no][paths[no].length - 1]; State.moveRider(+no, z.d, z.lane); });
      if (o && o.onFrame) o.onFrame(true);
      if (o && o.onDone) o.onDone(true);
    }
    if (isHidden()) { finish(); return; }
    var t0 = null, me = { id: 0, done: o && o.onDone };
    cur = me;
    function frame(ts) {
      if (cur !== me) return;
      if (t0 === null) t0 = ts;
      var t = Math.min(1, (ts - t0) / ms);
      if (t >= 1) { cur = null; finish(); return; }
      nos.forEach(function (no) { var p = at(paths[no], t); State.moveRider(+no, p.d, p.lane); });
      if (o && o.onFrame) o.onFrame(false);
      me.id = raf(frame);
    }
    me.id = raf(frame);
  }

  /** 出力側：届いた状態へ毎フレーム追いつく表示用の写し */
  function Smoother(onFrame) {
    this.view = {};
    this.target = null;
    this.onFrame = onFrame;
    this.last = 0;
    this.running = false;
  }
  Smoother.prototype.setTarget = function (riders) {
    this.target = riders;
    var self = this;
    Object.keys(riders).forEach(function (no) {
      if (!self.view[no]) self.view[no] = { d: riders[no].d, lane: riders[no].lane };
    });
    /* 画面が隠れているときは requestAnimationFrame が止まる＝追いつかないまま古い絵が残る。
       そのときは追わずに最終位置を即座に描く（9/27の検査で、裏に回ったタブの絵が赤板のまま止まった） */
    if (isHidden()) {
      this.jump(riders);
      this.onFrame(this.view);
      return;
    }
    if (!this.running) {
      this.running = true;
      this.last = 0;
      var step = function (ts) {
        if (!self.tick(ts)) { self.running = false; return; }
        raf(step);
      };
      raf(step);
    }
  };
  /** @returns {boolean} まだ動いているか */
  Smoother.prototype.tick = function (ts) {
    var dt = this.last ? Math.min(100, ts - this.last) : 16;
    this.last = ts;
    var k = 1 - Math.exp(-dt / 55);   // 約120msで追いつく
    var moving = false, self = this, T = this.target;
    Object.keys(T).forEach(function (no) {
      var v = self.view[no], t = T[no];
      if (Math.abs(t.d - v.d) > 0.2) { v.d = t.d; v.lane = t.lane; return; }   // ワープはそのまま見せる
      v.d += (t.d - v.d) * k;
      v.lane += (t.lane - v.lane) * k;
      if (Math.abs(t.d - v.d) > 1e-5 || Math.abs(t.lane - v.lane) > 1e-4) moving = true;
      else { v.d = t.d; v.lane = t.lane; }
    });
    this.onFrame(this.view);
    return moving;
  };
  /** 構造が変わった（レース替わり等）ときは追わずに合わせる */
  Smoother.prototype.jump = function (riders) {
    var self = this;
    this.view = {};
    Object.keys(riders).forEach(function (no) { self.view[no] = { d: riders[no].d, lane: riders[no].lane }; });
    this.target = riders;
  };

  return {
    to: to,
    reform: reform,
    path: path,
    prepare: prepare,
    stop: stop,
    busy: function () { return !!cur; },
    Smoother: Smoother
  };
})();
