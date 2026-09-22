/* ===========================================================
   config.js — 接続先・定数・APIキーの持ち方
   ===========================================================
   🔑このアプリは読み取りにもAPIキーが要る（観察ログが内部限定のため）。
      初回だけ URL に ?k=<キー> を付けて開く → localStorage に覚える →
      2回目からは素のURLでよい。OBSのブラウザソースは ?k= を付けたまま登録する。
*/

var CONFIG = (function () {

  var PROD_GAS = 'https://script.google.com/macros/s/AKfycbzG20o4yYfeKuqRyHuwNka9jCZk6Y1PmDD6LDWIqwCM4QZO8BNV8esIEW_0Niy6XqEClg/exec';

  var params;
  try { params = new URLSearchParams(location.search); } catch (e) { params = { get: function () { return null; } }; }

  /* バックエンドの差し替え（テスト用）。
     ⚠️script.google.com のURLしか受け付けない（任意ホストを許すと細工リンクの踏み台になる） */
  var override = params.get('gas') || '';
  var GAS_OK = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(override);
  var GAS_URL = GAS_OK ? override : PROD_GAS;

  /* APIキー：URLで渡されたら覚える。localStorageは riders: 接頭辞で展開ボードと混ぜない */
  var KEY_LS = 'riders:key';
  var key = params.get('k') || '';
  try {
    if (key) localStorage.setItem(KEY_LS, key);
    else key = localStorage.getItem(KEY_LS) || '';
  } catch (e) { /* プライベートモード等 */ }

  /* 出力ビュー判定。?view=output が正（autoupdate.js の output-only と揃える）。
     要件定義の ?view=card も同じ意味として受ける */
  var view = params.get('view') || '';
  var IS_OUTPUT = (view === 'output' || view === 'card');

  /* 競輪の選手服の色（競技規則由来の業界標準）＝展開ボードと同じ値 */
  var COLORS = {
    1: { bg: '#ffffff', fg: '#141414' },
    2: { bg: '#1c1c1c', fg: '#ffffff' },
    3: { bg: '#e02b2b', fg: '#ffffff' },
    4: { bg: '#1668cc', fg: '#ffffff' },
    5: { bg: '#f7df1c', fg: '#141414' },
    6: { bg: '#12a150', fg: '#ffffff' },
    7: { bg: '#f5851f', fg: '#141414' },
    8: { bg: '#f288b4', fg: '#141414' },
    9: { bg: '#8455c9', fg: '#ffffff' }
  };

  /* 役割の6区分（要件§2-4）。キーはGAS側の ROLES と一致させること */
  var ROLES = [
    { key: 'head', label: '先頭', hint: '前回り。ラインの先頭を走るとき' },
    { key: 'bante', label: '番手', hint: 'ラインの2番目' },
    { key: 'third', label: '3番手', hint: 'ラインの3番目' },
    { key: 'fourth', label: '4番手以降', hint: '7車立てではめったに起きない' },
    { key: 'solo', label: '単騎', hint: 'ラインに入らない' },
    { key: 'seri', label: '競り', hint: '番手を争う形' }
  ];

  /* 追走能力の5段階（要件§3.3） */
  var FOLLOW_LEVELS = [
    { v: '5', label: '◎ とても上手い' },
    { v: '4', label: '○ 上手い' },
    { v: '3', label: '△ ふつう' },
    { v: '2', label: '▲ 苦しい' },
    { v: '1', label: '× 離れる' }
  ];

  return {
    GAS_URL: GAS_URL,
    IS_TEST_BACKEND: GAS_OK,
    KEY: key,
    KEY_LS: KEY_LS,
    IS_OUTPUT: IS_OUTPUT,
    PARAMS: params,
    COLORS: COLORS,
    ROLES: ROLES,
    FOLLOW_LEVELS: FOLLOW_LEVELS,
    /* 自前集計（役割別の実績）の置き場所。Naoto PCの定時タスクが作る静的ファイル。
       🔴公開リポジトリに載るので、ここへ本人コメントや手書きを入れないこと */
    STATS_URL: 'data/stats.json',
    LS_PREFIX: 'riders:'
  };
})();
