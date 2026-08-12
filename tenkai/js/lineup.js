/* ===========================================================
   lineup.js — 並びテキストのパース＋自動配置

   入力例： 1-3-5 / 2-7 / 4-6-9
            １－３－５　２－７　４－６－９   （全角でも可）
            135 27 469                      （区切りなしでも可）

   考え方：ライン区切りだけ見て、ライン内は「出てきた数字の順」で読む。
           車番は1〜9の1桁なので、これで -, =, ・ 等どんな区切りでも通る。
   =========================================================== */

var Lineup = (function () {

  /** 全角→半角の正規化 */
  function normalize(text) {
    if (!text) return '';
    return String(text)
      /* 全角数字 → 半角 */
      .replace(/[０-９]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
      })
      /* 丸数字 ①〜⑨ → 1〜9 */
      .replace(/[①-⑨]/g, function (ch) {
        return String(ch.charCodeAt(0) - 0x2460 + 1);
      })
      /* 全角スラッシュ・全角スペース → 半角 */
      .replace(/／/g, '/')
      .replace(/　/g, ' ')
      .trim();
  }

  /**
   * 並びテキストをラインの配列に分解する
   * @param {string} text
   * @param {number[]|null} cars 出走している車番。null なら1〜9を無条件で受け、
   *                             「並びに出てこなかった車番の補完」も行わない
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
        if (allowed && !allowed[no]) { ignored.push(no); return; }  // 出走していない車番
        if (seen[no]) { ignored.push(no); return; }                 // 重複
        seen[no] = true;
        line.push(no);
      });
      if (line.length) lines.push(line);
    });

    /* 並びに出てこなかった車番は「盤面に出さない」。
       以前は最後方に単騎として足していたが、実使用で邪魔だったので廃止した。
       ＝並びに書かれた車番が、そのまま盤面に出る車番になる。
       missing は報告用に返すだけで、lines には足さない */
    var missing = [];
    if (allowed) {
      cars.forEach(function (no) { if (!seen[no]) missing.push(no); });
    }

    return { lines: lines, ignored: ignored, missing: missing };
  }

  /**
   * ライン配列 → 各車の正規化座標
   * 先頭ラインの先頭を最前に置き、後方へ等間隔。ライン間は余分に空ける。
   * @returns {Object} { 1:{x,y}, 2:{x,y}, ... }
   */
  function layout(lines, dir, iconRatio) {
    var L = CONFIG.LAYOUT;
    var positions = {};

    /* アイコンを大きくしたときに重ならないよう、間隔をアイコン径に連動させる */
    var r = (typeof iconRatio === 'number' && isFinite(iconRatio))
      ? iconRatio : CONFIG.ICON_RATIO_DEFAULT;
    var gapInLine  = Math.max(L.gapInLine,  r * 1.02);
    var gapBetween = Math.max(L.gapBetween, r * 0.70);

    /* 全部が単騎のレース（ガールズ等）は段違いにすると意味なくギザギザに見えるので、
       高さを揃えて一直線に並べる */
    var allSolo = lines.every(function (line) { return line.length === 1; });

    var cursor = L.headX;
    var minX = L.headX;

    lines.forEach(function (line, lineIdx) {
      var y = allSolo ? L.lineY[0] : L.lineY[lineIdx % L.lineY.length];
      line.forEach(function (no) {
        positions[no] = { x: cursor, y: y };
        if (cursor < minX) minX = cursor;
        cursor -= gapInLine;
      });
      cursor -= gapBetween;   // ラインの切れ目
    });

    /* 入り切らない場合は、先頭を固定したまま全体を横に圧縮する */
    if (minX < L.tailX) {
      var factor = (L.headX - L.tailX) / (L.headX - minX);
      for (var no in positions) {
        if (!Object.prototype.hasOwnProperty.call(positions, no)) continue;
        positions[no].x = L.headX - (L.headX - positions[no].x) * factor;
      }
    }

    /* 左が先頭のときは左右反転 */
    if (dir === 'left') {
      for (var n in positions) {
        if (!Object.prototype.hasOwnProperty.call(positions, n)) continue;
        positions[n].x = 1 - positions[n].x;
      }
    }

    return positions;
  }

  return {
    normalize: normalize,
    parse: parse,
    layout: layout,

    /** パース＋配置をまとめて実行 */
    apply: function (text, cars, dir, iconRatio) {
      var parsed = parse(text, cars);
      return {
        positions: layout(parsed.lines, dir, iconRatio),
        lines: parsed.lines,
        ignored: parsed.ignored,
        missing: parsed.missing
      };
    }
  };
})();
