/* ===========================================================
   racetype.js — レース種別（予選／準決勝／決勝／一般…）の正規化
   ===========================================================
   🔑集計側（選手DB案件/実装/build_stats.js・Node）と画面側（detail.js・ブラウザ）の
     **両方がこの1本を読む**。正規化がずれると「出走表の種別」と「集計の種別」が
     噛み合わなくなるので、判定はここ以外に書かない。

   keirin.jp の `cls` は「Ａ級チ予選」「Ｓ級準々Ｂ」のように級班や開催の接頭辞が付く。
   直近4ヶ月で90種類あったが、Yが見たい軸は7つ（Naoto指定 9/23＋実データで選抜を追加）。

   ⚠️チャレンジ戦（A級3班）には特選・初特選が無い。代わりに「選抜」がある
     （A3・直近4ヶ月＝予選636／一般525／選抜311／準決302／決勝121レース）。

   判定の順序が大事（前のものほど優先）：
     初特選 → 特選 → 準決勝(準) → 決勝(決) → 予選(予) → 選抜 → 一般(般) → その他
     例：「Ａ級特予選」は特別予選＝予選／「Ｓ級準々Ｂ」＝準決勝／「Ｌ級ガ決Ａ」＝決勝 */
(function (root) {
  'use strict';

  /** 表示の順（Naotoの並び＋選抜）。集計側もこの順で出す */
  var RACE_TYPES = ['一般', '特選', '初特選', '選抜', '予選', '準決勝', '決勝', 'その他'];

  function raceTypeOf(cls) {
    var s = String(cls || '');
    if (!s) return 'その他';
    if (s.indexOf('初特選') >= 0) return '初特選';
    if (s.indexOf('特選') >= 0) return '特選';
    if (s.indexOf('準') >= 0) return '準決勝';     // 準決・準々・「Ｌ級東ガ準」（末尾が準）も拾う
    if (s.indexOf('決') >= 0) return '決勝';
    if (s.indexOf('予') >= 0) return '予選';
    if (s.indexOf('選抜') >= 0) return '選抜';
    if (s.indexOf('般') >= 0) return '一般';
    return 'その他';
  }

  var api = { raceTypeOf: raceTypeOf, RACE_TYPES: RACE_TYPES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node（build_stats.js）
  else root.RACETYPE = api;                                                     // ブラウザ
})(typeof globalThis !== 'undefined' ? globalThis : this);
