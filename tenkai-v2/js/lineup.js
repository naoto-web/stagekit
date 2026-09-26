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
      .replace(/　/g, ' ')
      .trim();
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

    groups.forEach(function (g) {
      var digits = g.match(/[1-9]/g) || [];
      var line = [];
      digits.forEach(function (d) {
        var no = parseInt(d, 10);
        if (allowed && !allowed[no]) { ignored.push(no); return; }
        if (seen[no]) { ignored.push(no); return; }
        seen[no] = true;
        line.push(no);
      });
      if (line.length) lines.push(line);
    });

    /* 並びに出てこなかった車番は「盤面に出さない」（v1と同じ）。missing は報告用 */
    var missing = [];
    if (allowed) {
      cars.forEach(function (no) { if (!seen[no]) missing.push(no); });
    }

    return { lines: lines, ignored: ignored, missing: missing };
  }

  /**
   * ライン配列 → 各車の { d, lane }（スタートの隊列）
   * @param {number[][]} lines
   * @param {number} [headD] 先頭の周回位置（省略時＝スタート）
   */
  function layout(lines, headD) {
    var L = CONFIG.LAYOUT, CAR = CONFIG.CAR;
    var d = (typeof headD === 'number' && isFinite(headD)) ? headD : CONFIG.PHASES[0].d;
    var positions = {};
    /* ライン内の間隔＝1.05車身、ライン間＝1.05＋0.7車身 */
    var first = true;
    lines.forEach(function (line, i) {
      line.forEach(function (no, j) {
        if (!first) d += L.gapInLine * CAR + (j === 0 ? L.gapBetween * CAR : 0);
        first = false;
        positions[no] = { d: d, lane: -1 };
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

    /** パース＋配置をまとめて実行 */
    apply: function (text, cars) {
      var parsed = parse(text, cars);
      return {
        positions: layout(parsed.lines),
        lines: parsed.lines,
        ignored: parsed.ignored,
        missing: parsed.missing
      };
    }
  };
})();
