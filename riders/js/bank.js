/* ===========================================================
   bank.js — バンクの「軽い／重い」の分類（§43・2026-09-24 えーすさんの要望③④）
   ===========================================================
   🔑集計側（選手DB案件/実装/build_stats.js・Node）と画面側（detail.js・ブラウザ）の
     **両方がこの1本を読む**（racetype.js と同じ形）。分類がずれると
     「集計した軽い」と「画面に出る軽い」が食い違うので、判定はここ以外に書かない。

   🔴**周長（333/400/500m）はここに持たない。** レースDB（`race.bank_lap`）から取って
      `stats.json` に書き、画面はそれを読む。理由＝周長は事実なので出どころは1つでよく、
      ここに書き写すと**二重管理になって必ずずれる**（実際にえーすさんの表は
      「小倉は333m」と誤っていた。小倉は400mのドーム）。
      ここが持つのは**人が決めた分類だけ**＝データから導けないものだけを置く。

   ── 分類の出どころ（えーすさん・2026-09-24・Y経由で受領）──
     軽い … 小倉・前橋・伊東・小田原・岸和田・名古屋・福井・青森・弥彦・久留米・京王閣・大宮・宇都宮
     重い … 和歌山・小松島・高知・立川※・豊橋※・別府※（※印は冬場はとくに重い）
     理由 … 小倉／前橋は屋内ドームで風の影響が無い。和歌山・小松島・立川は風が強い。雨でも重くなる。
     上記以外 … 「天候次第で分からない」とのこと ⇒ **その他**（分類しないことも情報なので消さない）

   🔴**季節・天候ではこの分類を動かさない。** ※印の3場は「冬場はとくに重い」だけで、
      分類そのものは通年で固定する。理由＝
        ①既定の集計期間（直近4ヶ月）は5〜9月で、そもそも冬が窓に入らない
        ②天候まで見ると「同じ場なのに日によって区分が変わる」＝Yが数字を追えなくなる
      ⇒ 画面には分類の出どころを添えて、判断はYに残す。

   ⚠️実データで測った母数（直近4ヶ月・2,417人）＝軽い21,351走／重い10,365走／その他35,776走。
     1人あたりの中央値は 軽い9走・重い3走・その他15走で、**重いバンクは2割の選手が0走**。
     全体の3着内率は 軽42.1%／重41.9%／その他42.5% ＝**全体では差がほとんど無い**。
     つまりこの軸は「全体の傾向」ではなく**個人の癖**を見るためのもの。 */
(function (root) {
  'use strict';

  var LIGHT = ['小倉', '前橋', '伊東', '小田原', '岸和田', '名古屋', '福井',
               '青森', '弥彦', '久留米', '京王閣', '大宮', '宇都宮'];
  var HEAVY = ['和歌山', '小松島', '高知', '立川', '豊橋', '別府'];

  /** 区分の並び（画面の行の順）。「その他」は分類が無いことを表す正規の区分＝必ず出す。 */
  var WEIGHTS = [
    { key: 'light', label: '軽い' },
    { key: 'heavy', label: '重い' },
    { key: 'other', label: 'その他' }
  ];

  var W = {};
  LIGHT.forEach(function (v) { W[v] = 'light'; });
  HEAVY.forEach(function (v) { W[v] = 'heavy'; });

  /** 場名の表記ゆれを吸収する。DBは「小松島」、keirin.jpの開催一覧も「小松島」だが、
      「小松島競輪場」のような書き方が来ても同じものとして扱う。 */
  function normalize(venue) {
    return String(venue == null ? '' : venue).replace(/競輪場?$/, '').replace(/[\s　]+/g, '');
  }

  /** 'light' / 'heavy' / 'other'。未知の場は 'other'（黙って軽い・重いに倒さない）。 */
  function weightOf(venue) { return W[normalize(venue)] || 'other'; }

  /** 区分のラベル（'light' → '軽い'）。 */
  function weightLabel(key) {
    for (var i = 0; i < WEIGHTS.length; i++) if (WEIGHTS[i].key === key) return WEIGHTS[i].label;
    return 'その他';
  }

  /** えーすさんの表に載っている場か（＝'other' が「分類されていない」ためのものか確かめる用）。 */
  function isClassified(venue) { return !!W[normalize(venue)]; }

  var api = {
    WEIGHTS: WEIGHTS, LIGHT: LIGHT, HEAVY: HEAVY,
    normalize: normalize, weightOf: weightOf, weightLabel: weightLabel, isClassified: isClassified
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node（build_stats.js）
  else root.BANK = api;                                                        // ブラウザ
})(typeof globalThis !== 'undefined' ? globalThis : this);
