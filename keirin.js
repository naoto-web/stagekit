/* keirin.js — 買目記法パーサー・点数計算・的中判定・払戻計算（共有ロジック）
   コンソール・オーバーレイ両方から読み込む。ブラウザ＝window.Keirin / Node＝module.exports（テスト用）

   対応記法（配信者のメモ帳の打ち方をそのまま受ける）:
     1-9-2357        … 3連単フォーメーション（3番手は集合）
     1 - 9 - 2 3 5 7 … 同上（空白区切りOK）
     1=9-2357        … 1着2着折り返し
     3-7 折り返し     … 2車単の裏表（「折返し」「裏」「ウラ」も可）
     1=2=3 / 123BOX  … ボックス
     3連複 1-2-9     … 行頭・行中の式別キーワードで型指定
     1-9-全          … 全流し（車数ぶん展開・デフォルト9車）
   パースできない行はメモ行（コメント）として扱い、点数に入れない。 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Keirin = factory();
})(typeof self !== "undefined" ? self : this, function () {

  var TYPES = ["3連単", "3連複", "2車単", "2車複", "ワイド"];
  var ORDERED = { "3連単": true, "2車単": true };
  var TYPE_SIZE = { "3連単": 3, "3連複": 3, "2車単": 2, "2車複": 2, "ワイド": 2 };

  /* ---------- 正規化 ---------- */
  function normalize(text) {
    var s = String(text || "");
    // 全角→半角（数字・英字・記号・空白）
    s = s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    });
    s = s.replace(/[ー−‐―－→>]/g, "-").replace(/[＝]/g, "=").replace(/[．，、,\.]/g, " ");
    s = s.replace(/[（(].*?[）)]/g, function (m) { return " " + m.slice(1, -1) + " "; }); // 括弧は外して中身残す
    s = s.replace(/[　\t]+/g, " ").trim();
    return s;
  }

  /* 式別キーワード検出（行から取り除いて返す） */
  function extractType(s) {
    var map = [
      [/3連単|三連単|サンレンタン/i, "3連単"],
      [/3連複|三連複|サンレンプク/i, "3連複"],
      [/2車単|二車単|車単/i, "2車単"],
      [/2車複|二車複|車複/i, "2車複"],
      [/ワイド|ﾜｲﾄﾞ/i, "ワイド"],
    ];
    for (var i = 0; i < map.length; i++) {
      if (map[i][0].test(s)) return { type: map[i][1], rest: s.replace(map[i][0], " ").trim() };
    }
    return { type: null, rest: s };
  }

  /* ---------- 行パース ---------- */
  /**
   * @param {string} raw 1行の生テキスト
   * @param {string} defaultType 式別未指定時の型（省略時 3連単）
   * @param {number} carCount 車数（全流し展開用・省略時9）
   * @return {ok:boolean, memo?:string, type?:string, combos?:number[][], points?:number, raw:string}
   */
  function parseLine(raw, defaultType, carCount) {
    var out = { raw: String(raw || "") };
    var s = normalize(raw);
    if (!s) return fail(out, "");

    var ex = extractType(s);
    s = ex.rest;

    var mirror = false; // 「折り返し」等 → 2部構成の裏表
    if (/折り?返し|折返|ウラ|裏|ﾏﾙﾁ|マルチ/.test(s)) {
      mirror = true;
      s = s.replace(/折り?返し|折返|ウラ|裏|ﾏﾙﾁ|マルチ/g, " ").trim();
    }
    var box = false;
    if (/BOX|ボックス|ﾎﾞｯｸｽ/i.test(s)) {
      box = true;
      s = s.replace(/BOX|ボックス|ﾎﾞｯｸｽ/gi, " ").trim();
    }

    // 数字・区切り以外が残る行はメモ行
    if (!/^[0-9全=\- ]+$/.test(s) || !/[0-9]/.test(s)) return fail(out, ex.type);

    var cars = carCount === 7 ? 7 : 9;

    // セグメント分解： "-" 区切り。 "=" は隣接セグメントの入替可マーク
    // 例 "1=9-2357" → segs [{set:[1]},{set:[9]},{set:[2,3,5,7]}], swap[0]=true
    var segs = [];
    var swaps = [];
    var parts = s.split("-");
    for (var i = 0; i < parts.length; i++) {
      var sub = parts[i].split("=");
      for (var j = 0; j < sub.length; j++) {
        var set = digitsOf(sub[j], cars);
        if (set === null) return fail(out, ex.type);
        if (set.length) {
          segs.push(set);
          // "=" の直後要素なら、直前セグメントとの入替可
          swaps.push(j > 0);
        }
      }
    }
    if (!segs.length) return fail(out, ex.type);

    // BOXキーワード or 全セグメント"=" つなぎ（1=2=3）→ ボックス
    if (box || (segs.length >= 2 && swaps.slice(1).every(Boolean))) {
      var pool = uniq(flatten(segs));
      return finish(out, ex.type || defaultType || "3連単", boxCombos(pool, ex.type || defaultType || "3連単"), pool);
    }

    // セグメント1つだけ（"123" 等）→ ボックス扱い
    if (segs.length === 1) {
      if (segs[0].length < 2) return fail(out, ex.type);
      return finish(out, ex.type || defaultType || "3連単", boxCombos(segs[0], ex.type || defaultType || "3連単"), segs[0]);
    }

    // 型決定：明示 > セグメント数（3つ→3連単系 / 2つ→2車単系のdefault側）
    var type = ex.type;
    if (!type) {
      var d = defaultType || "3連単";
      if (segs.length >= 3) type = TYPE_SIZE[d] === 3 ? d : "3連単";
      else type = TYPE_SIZE[d] === 2 ? d : "2車単";
    }
    var size = TYPE_SIZE[type];
    if (segs.length < size) {
      // 2セグメントで3連単指定などは不成立→メモ行
      return fail(out, ex.type);
    }
    segs = segs.slice(0, size);
    swaps = swaps.slice(0, size);

    // mirror（折り返し）＝先頭2セグメント入替可として扱う
    if (mirror) swaps[1] = true;

    var combos = formationCombos(segs, swaps);
    return finish(out, type, combos);
  }

  function fail(out, type) {
    out.ok = false;
    out.memo = out.raw.trim();
    if (type) out.type = type;
    return out;
  }
  /* 表示用の正規化：組合せ集合から列ごとの車番集合を作り直す
     （例）1-2-321 → 1-2-3（来ようのない数字を落とす）／12-21-3 → 12-12-3（列内は昇順） */
  function dispOf(combos) {
    if (!combos.length) return "";
    var sets = [];
    for (var i = 0; i < combos[0].length; i++) {
      var s = [];
      combos.forEach(function (c) { if (s.indexOf(c[i]) < 0) s.push(c[i]); });
      s.sort();
      sets.push(s.join(""));
    }
    return sets.join("-");
  }

  function finish(out, type, combos, boxPool) {
    // 順不同型は組合せをソート・重複排除
    if (!ORDERED[type]) {
      var seen = {};
      combos = combos.map(function (c) { return c.slice().sort(); }).filter(function (c) {
        var k = c.join("-");
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      });
    } else {
      var seen2 = {};
      combos = combos.filter(function (c) {
        var k = c.join("-");
        if (seen2[k]) return false;
        seen2[k] = true;
        return true;
      });
    }
    out.ok = combos.length > 0;
    if (!out.ok) { out.memo = out.raw.trim(); return out; }
    out.type = type;
    out.combos = combos;
    out.points = combos.length;
    out.disp = boxPool ? uniq(boxPool).slice().sort().join("") + " BOX" : dispOf(combos);
    return out;
  }

  function digitsOf(str, cars) {
    var t = str.replace(/ /g, "");
    if (!t) return [];
    if (t === "全") {
      var all = [];
      for (var i = 1; i <= cars; i++) all.push(i);
      return all;
    }
    if (!/^[0-9]+$/.test(t)) return null;
    var set = [];
    for (var j = 0; j < t.length; j++) {
      var n = +t[j];
      if (n < 1 || n > 9) return null; // 0や10以上は競輪の車番でない→メモ行
      if (set.indexOf(n) < 0) set.push(n);
    }
    return set;
  }

  function flatten(a) { return a.reduce(function (x, y) { return x.concat(y); }, []); }
  function uniq(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

  /* フォーメーション展開（同一車の重複使用を除外）。swaps[i]=true なら seg[i-1]とseg[i]は順不同 */
  function formationCombos(segs, swaps) {
    var results = [];
    (function rec(idx, cur) {
      if (idx === segs.length) { results.push(cur.slice()); return; }
      segs[idx].forEach(function (n) {
        if (cur.indexOf(n) >= 0) return;
        cur.push(n);
        rec(idx + 1, cur);
        cur.pop();
      });
    })(0, []);
    // swap展開：隣接入替可ペアごとに、入替版も追加
    for (var i = 1; i < swaps.length; i++) {
      if (!swaps[i]) continue;
      var extra = results.map(function (c) {
        var d = c.slice();
        var tmp = d[i - 1]; d[i - 1] = d[i]; d[i] = tmp;
        return d;
      });
      results = results.concat(extra);
    }
    return results;
  }

  /* ボックス：型に応じて順列 or 組合せ */
  function boxCombos(pool, type) {
    var size = TYPE_SIZE[type] || 3;
    var res = [];
    (function rec(cur) {
      if (cur.length === size) { res.push(cur.slice()); return; }
      pool.forEach(function (n) {
        if (cur.indexOf(n) >= 0) return;
        cur.push(n);
        rec(cur);
        cur.pop();
      });
    })([]);
    return res;
  }

  /* ---------- 予想テキスト全体のパース ---------- */
  /**
   * @param {string} text 複数行の生テキスト
   * @return {lines:[], memos:[], points:number}
   */
  function parsePrediction(text, defaultType, carCount) {
    var lines = String(text || "").split(/\r?\n/);
    var out = { lines: [], memos: [], points: 0 };
    var seen = {}; // 行またぎの「かぶり目」除外（先に書いた行が優先・点数/的中/表示すべてから除外）
    lines.forEach(function (raw) {
      if (!raw.trim()) return;
      var p = parseLine(raw, defaultType, carCount);
      if (p.ok) {
        var kept = p.combos.filter(function (c) {
          var k = p.type + "|" + normalizedComboKey(p.type, c);
          if (seen[k]) return false;
          seen[k] = true;
          return true;
        });
        p.dupCount = p.combos.length - kept.length;
        if (p.dupCount) {
          p.combos = kept;
          p.points = kept.length;
          if (kept.length) p.disp = dispOf(kept); // かぶった目を表示からも消す
          else { p.allDup = true; p.disp = ""; }  // 行ごと全部かぶり→画面に出さない
        }
      }
      out.lines.push(p);
      if (p.ok) out.points += p.points;
      else out.memos.push(p.memo);
    });
    return out;
  }

  /* ---------- 的中判定 ---------- */
  /** order=[1着,2着,3着]の車番。該当する的中組合せの配列を返す（ワイドは複数あり得る） */
  function hitCombos(parsedLine, order) {
    if (!parsedLine.ok) return [];
    var f = order[0], s = order[1], t = order[2];
    var hits = [];
    parsedLine.combos.forEach(function (c) {
      var hit = false;
      switch (parsedLine.type) {
        case "3連単": hit = c[0] === f && c[1] === s && c[2] === t; break;
        case "3連複": hit = sameSet(c, [f, s, t]); break;
        case "2車単": hit = c[0] === f && c[1] === s; break;
        case "2車複": hit = sameSet(c, [f, s]); break;
        case "ワイド":
          hit = sameSet(c, [f, s]) || sameSet(c, [f, t]) || sameSet(c, [s, t]);
          break;
      }
      if (hit) hits.push(c);
    });
    return hits;
  }
  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    var x = a.slice().sort().join("-");
    var y = b.slice().sort().join("-");
    return x === y;
  }

  /* ---------- 精算 ----------
     payouts: [{type, combo:[..], amount}]  amount=100円あたり払戻金額
     prediction: parsePredictionの結果 + unit（1点あたりの金額）
     return: { hits:[{type, combo, amount, mult, refund}], refund, invest } */
  function settle(prediction, unit, order, payouts) {
    var res = { hits: [], refund: 0, invest: prediction.points * (unit || 0) };
    if (!order || order.length < 2) return res;
    prediction.lines.forEach(function (line) {
      if (!line.ok) return;
      hitCombos(line, order).forEach(function (combo) {
        var pay = findPayout(payouts, line.type, combo);
        var amount = pay ? pay.amount : 0;
        var refund = amount * (unit || 0) / 100;
        res.hits.push({
          type: line.type,
          combo: combo,
          comboLabel: comboLabel(line.type, combo),
          amount: amount,
          mult: amount ? Math.round(amount / 10) / 10 : 0, // 倍率（小数1桁）
          manche: amount >= 10000,
          refund: refund,
        });
        res.refund += refund;
      });
    });
    return res;
  }

  function findPayout(payouts, type, combo) {
    var key = normalizedComboKey(type, combo);
    var found = null;
    (payouts || []).forEach(function (p) {
      if (p.type !== type) return;
      if (normalizedComboKey(p.type, p.combo) === key) found = p;
    });
    return found;
  }
  function normalizedComboKey(type, combo) {
    var c = ORDERED[type] ? combo : combo.slice().sort();
    return c.join("-");
  }
  function comboLabel(type, combo) {
    var c = ORDERED[type] ? combo : combo.slice().sort();
    return c.join("-");
  }

  /* 着順から標準4式別の該当組合せ（払戻入力のプリセット用） */
  function standardCombos(order) {
    var f = order[0], s = order[1], t = order[2];
    var rows = [];
    if (f && s && t) {
      rows.push({ type: "3連単", combo: [f, s, t] });
      rows.push({ type: "3連複", combo: [f, s, t].slice().sort() });
    }
    if (f && s) rows.push({ type: "2車単", combo: [f, s] });
    if (f && s) rows.push({ type: "ワイド", combo: [f, s].slice().sort() });
    if (f && t) rows.push({ type: "ワイド", combo: [f, t].slice().sort() });
    if (s && t) rows.push({ type: "ワイド", combo: [s, t].slice().sort() });
    return rows;
  }

  /* ---------- 表示用トークン化 ----------
     買い目行を「車番チップ＋区切り記号」で描画するための構造化。
     入力された記法をそのまま保つ（意味解釈はしない）。式別キーワードはラベルとして分離。 */
  function displayTokens(raw) {
    var s = normalize(raw);
    var ex = extractType(s);
    var tokens = [];
    if (ex.type) tokens.push({ t: "label", v: ex.type });
    var buf = "";
    var flush = function () {
      if (buf.trim()) tokens.push({ t: "txt", v: buf.trim() });
      buf = "";
    };
    ex.rest.split("").forEach(function (c) {
      if (/[1-9]/.test(c)) { flush(); tokens.push({ t: "car", v: +c }); }
      else if (c === "-") { flush(); tokens.push({ t: "sep", v: "-" }); }
      else if (c === "=") { flush(); tokens.push({ t: "sep", v: "=" }); }
      else if (c === "全") { flush(); tokens.push({ t: "all" }); }
      else if (c === " ") { flush(); tokens.push({ t: "gap" }); }
      else buf += c;
    });
    flush();
    return tokens;
  }

  return {
    TYPES: TYPES,
    normalize: normalize,
    parseLine: parseLine,
    parsePrediction: parsePrediction,
    hitCombos: hitCombos,
    settle: settle,
    standardCombos: standardCombos,
    comboLabel: comboLabel,
    displayTokens: displayTokens,
  };
});
