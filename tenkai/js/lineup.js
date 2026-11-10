/* ===========================================================
   lineup.js — 並びテキストのパース＋スタートの初期隊列  v2

   入力例： 1-3-5 / 2-7 / 4-6-9
            １－３－５　２－７　４－６－９   （全角でも可）
            135 27 469                      （区切りなしでも可）

   パースは v1 と同じ。配置だけ (d, lane) で作る（要件定義_v2 §6.8）：
     先頭ラインの先頭をスタート位置（誘導員の1車身後ろ）に置き、後方へ1.05車身間隔、
     ライン間は＋0.7車身、全員 内レーン。並び予想の左端のラインが前受け。
     v1の「ラインごとに縦位置を段違いにする」は廃止＝コース上では段違いが併走の意味になる
   =========================================================== */

var Lineup = (function () {

  /** 全角→半角の正規化 */
  function normalize(text) {
    if (!text) return '';
    return String(text)
      .replace(/[０-９]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
      })
      .replace(/[①-⑨]/g, function (ch) {
        return String(ch.charCodeAt(0) - 0x2460 + 1);
      })
      .replace(/／/g, '/')
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/　/g, ' ')
      .trim();
  }

  /* ---------- 競り（11/10 Naoto「もう競っている状態で置くのが自然」） ----------
     並びの文字にカッコ＝競り。例「1(52)3 47 6」＝5 と 2 が 1 の後ろを競る。
     カッコの中の順は keirin.jp の構造版（GAS の lines）と同じ＝最後がその位置の持ち主（内）・前が競りに行く側（外）。
     盤面の持ち方：
       lines ＝今までどおり車番の配列（持ち主・競りに行く側の順で続けて入れる。例 [1,2,5,3]）
       seri  ＝競りの組の配列（カッコの中の順。例 [[5,2]]）
     置き方（layout）＝組の全員を同じ前後位置に。持ち主が内・競りに行く側が1つ外。
     ?seri=0（CONFIG.SERI=false）で止める＝カッコは読み飛ばして今までどおり一列 */

  /** 競りの組 → { 車番: { g:組の番号, lane:置くレーン } }。持ち主（組の最後）が内（-1）・その前が中（0）・さらに前が外（1） */
  function seriSlots(seri) {
    var map = {};
    (seri || []).forEach(function (g, gi) {
      if (!g || g.length < 2) return;
      g.forEach(function (no, i) { map[no] = { g: gi, lane: Math.min(1, -1 + (g.length - 1 - i)) }; });
    });
    return map;
  }

  /** ライン（車番の配列）と競りの組 → 並びの文字（カッコ付き）。例 [[1,2,5,3],[4,7]]＋[[5,2]] → 「1(52)3 47」 */
  function text(lines, seri) {
    var slots = seriSlots(seri);
    return (lines || []).map(function (line) {
      var out = '', j = 0;
      while (j < line.length) {
        var s = slots[line[j]], k = j + 1;
        if (s) while (k < line.length && slots[line[k]] && slots[line[k]].g === s.g) k++;
        if (s && k - j >= 2) {
          /* 続けて並んでいる同じ組＝カッコの中は構造版の順（競りに行く側が先） */
          var inLine = line.slice(j, k);
          out += '(' + seri[s.g].filter(function (no) { return inLine.indexOf(no) !== -1; }).join('') + ')';
          j = k;
        } else { out += line[j]; j++; }
      }
      return out;
    }).join(' ');
  }

  /** GAS の構造版の並び（[ライン][位置][車番]・同じ位置に2人以上＝競り）→ 並びの文字（カッコ付き） */
  function fromStruct(struct) {
    return (struct || []).map(function (line) {
      return (line || []).map(function (pos) {
        var p = (pos || []).map(function (n) { return String(+n); });
        return p.length > 1 ? '(' + p.join('') + ')' : (p[0] || '');
      }).join('');
    }).filter(function (s) { return s.length; }).join(' ');
  }

  /**
   * 並びテキストをラインの配列に分解する
   * @param {string} text
   * @param {number[]|null} cars 出走している車番。null なら1〜9を無条件で受ける
   * @returns {{lines:number[][], ignored:number[], missing:number[]}}
   */
  function parse(text, cars) {
    var norm = normalize(text);
    var groups = norm.split(/[\/\s,、|]+/).filter(function (s) { return s.length > 0; });

    var allowed = null;
    if (cars && cars.length) {
      allowed = {};
      cars.forEach(function (n) { allowed[n] = true; });
    }

    var seen = {};
    var lines = [];
    var ignored = [];
    var seri = [];

    groups.forEach(function (g) {
      var line = [];
      var paren = null;   // カッコの中の車番（競りの組）。カッコの外では null
      function take(d) {
        var no = parseInt(d, 10);
        if (allowed && !allowed[no]) { ignored.push(no); return null; }
        if (seen[no]) { ignored.push(no); return null; }
        seen[no] = true;
        return no;
      }
      function closeParen() {
        if (!paren) return;
        if (paren.length >= 2 && CONFIG.SERI) {
          /* ラインには 持ち主（最後）→ 競りに行く側（内に近い順）で入れる */
          paren.slice().reverse().forEach(function (no) { line.push(no); });
          seri.push(paren);
        } else {
          paren.forEach(function (no) { line.push(no); });
        }
        paren = null;
      }
      g.split('').forEach(function (ch) {
        if (ch === '(') { closeParen(); paren = []; return; }
        if (ch === ')') { closeParen(); return; }
        if (!/[1-9]/.test(ch)) return;
        var no = take(ch);
        if (no === null) return;
        if (paren) paren.push(no); else line.push(no);
      });
      closeParen();
      if (line.length) lines.push(line);
    });

    /* 並びに出てこなかった車番は「盤面に出さない」（v1と同じ）。missing は報告用 */
    var missing = [];
    if (allowed) {
      cars.forEach(function (no) { if (!seen[no]) missing.push(no); });
    }

    return { lines: lines, ignored: ignored, missing: missing, seri: seri };
  }

  /**
   * ライン配列 → 各車の { d, lane }（スタートの隊列）
   * @param {number[][]} lines
   * @param {number} [headD] 先頭の周回位置（省略時＝スタート）
   * @param {number[][]} [seri] 競りの組（省略時＝いまの盤面の State.data.seri）。
   *        同じ組の選手がライン内で続けて並んでいるときだけ、同じ前後位置に横並びで置く（持ち主が内）
   */
  function layout(lines, headD, seri) {
    var L = CONFIG.LAYOUT, CAR = CONFIG.CAR;
    var d = (typeof headD === 'number' && isFinite(headD)) ? headD : CONFIG.PHASES[0].d;
    var positions = {};
    if (seri === undefined) { try { seri = State.data.seri; } catch (e) { seri = null; } }
    var slots = CONFIG.SERI ? seriSlots(seri) : {};
    /* ライン内の間隔＝1.05車身、ライン間＝1.05＋0.7車身 */
    var first = true;
    lines.forEach(function (line, i) {
      line.forEach(function (no, j) {
        var s = slots[no], prev = j > 0 ? slots[line[j - 1]] : null;
        if (s && prev && prev.g === s.g) {
          /* 競り＝前の選手（同じ組）と同じ前後位置・1つ外のレーン */
          positions[no] = { d: d, lane: s.lane };
          return;
        }
        if (!first) d += L.gapInLine * CAR + (j === 0 ? L.gapBetween * CAR : 0);
        first = false;
        /* 組の先頭（ふつうは持ち主＝内）。相手が続いていなければ普通の一列と同じ */
        var next = j + 1 < line.length ? slots[line[j + 1]] : null;
        positions[no] = { d: d, lane: (s && next && next.g === s.g) ? s.lane : -1 };
      });
    });
    return positions;
  }

  /**
   * スタートの升目（9/27 Naoto）＝車番順に 内・中・外 の3人ずつ、前から列にする
   *   1列目：1(内) 2(中) 3(外) ／ 2列目：4 5 6 ／ 3列目：7 8 9
   * 欠車があれば詰める（出ている車番の順で数える）
   * @param {number[]} cars 盤面に出す車番
   * @param {number} [headD] 1列目の周回位置（省略時＝スタート）
   */
  function grid(cars, headD) {
    var L = CONFIG.LAYOUT;
    var d0 = (typeof headD === 'number' && isFinite(headD)) ? headD : CONFIG.PHASES[0].d;
    var positions = {};
    (cars || []).slice().sort(function (a, b) { return a - b; }).forEach(function (no, i) {
      positions[no] = {
        d: d0 + Math.floor(i / L.gridRows) * L.gridGap * CONFIG.CAR,
        lane: -1 + (i % L.gridRows)
      };
    });
    return positions;
  }

  return {
    normalize: normalize,
    parse: parse,
    layout: layout,
    grid: grid,
    text: text,
    fromStruct: fromStruct,
    seriSlots: seriSlots,

    /** パース＋配置をまとめて実行 */
    apply: function (text, cars) {
      var parsed = parse(text, cars);
      return {
        positions: layout(parsed.lines, undefined, parsed.seri),
        lines: parsed.lines,
        seri: parsed.seri,
        ignored: parsed.ignored,
        missing: parsed.missing
      };
    }
  };
})();
