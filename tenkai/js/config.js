/* ===========================================================
   config.js — 定数（枠色・レイアウト・既定値）
   =========================================================== */

var CONFIG = (function () {

  var PROD_GAS = 'https://script.google.com/macros/s/AKfycbw7I6ejxz4sy4RMXxc_2mhSxjzHaBrXwExv33_znFRvVfPjVsQSlVsJbh_fcnJ4lNkDVA/exec';
  var override = '';
  try { override = new URLSearchParams(location.search).get('gas') || ''; } catch (e) { override = ''; }
  var GAS_OK = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(override);
  var GAS_URL = GAS_OK ? override : PROD_GAS;

  /* 競輪の選手服の色（競技規則由来の業界標準）
     1白 2黒 3赤 4青 5黄 6緑 7橙 8桃 9紫
     bg = 円の色 / fg = 車番の文字色 / ring = 縁取り */
  var COLORS = {
    1: { name: '白', bg: '#ffffff', fg: '#141414', ring: 'rgba(0,0,0,.55)' },
    2: { name: '黒', bg: '#1c1c1c', fg: '#ffffff', ring: 'rgba(255,255,255,.7)' },
    3: { name: '赤', bg: '#e02b2b', fg: '#ffffff', ring: 'rgba(255,255,255,.7)' },
    4: { name: '青', bg: '#1668cc', fg: '#ffffff', ring: 'rgba(255,255,255,.7)' },
    5: { name: '黄', bg: '#f7df1c', fg: '#141414', ring: 'rgba(0,0,0,.5)' },
    6: { name: '緑', bg: '#12a150', fg: '#ffffff', ring: 'rgba(255,255,255,.7)' },
    7: { name: '橙', bg: '#f5851f', fg: '#141414', ring: 'rgba(0,0,0,.5)' },
    8: { name: '桃', bg: '#f288b4', fg: '#141414', ring: 'rgba(0,0,0,.5)' },
    9: { name: '紫', bg: '#8455c9', fg: '#ffffff', ring: 'rgba(255,255,255,.7)' }
  };

  return {
    COLORS: COLORS,

    MAX_CAR: 9,

    /* アイコン径 / ステージ幅 の比率 */
    ICON_RATIO_MIN: 0.035,
    ICON_RATIO_MAX: 0.140,
    ICON_RATIO_DEFAULT: 0.050,   // 8/12 Naoto指定（③の穴 960×572 に9車が余裕をもって入る大きさ）

    /* ステージ内でアイコン中心が動ける範囲（正規化座標）
       maxY はインフィールドに落ちない位置で止める */
    BOUNDS: { minX: 0.03, maxX: 0.97, minY: 0.12, maxY: 0.72 },

    /* 自動配置のパラメータ */
    LAYOUT: {
      headX: 0.91,      // 先頭の x（進行方向 right のとき）。ライン帯の端が枠で切れない位置
      tailX: 0.05,      // 最後方の下限 x
      gapInLine: 0.076, // 同一ライン内の間隔
      gapBetween: 0.055,// ライン間の追加間隔
      /* ライン番号ごとの縦位置。
         走行ライン（外帯線〜内圏線の間）に寄せて、ラインごとに軽く段違いにする。
         段差を大きくすると「隊列」ではなく「4段の行列」に見えてしまう */
      lineY: [0.63, 0.57, 0.51, 0.66, 0.60, 0.54]
    },

    /** アイコン径(px)。基準はステージ幅だが、16:9より横長になったときは
        高さ基準に切り替える。そうしないと横長画面でアイコンだけ巨大になる。
        main.js と bars.js が同じ値を使う必要があるのでここに置く */
    iconPx: function (w, h, ratio) {
      return Math.min(w, h * 16 / 9) * ratio;
    },

    STORAGE_KEY: 'keirin-tenkai-board-v1',

    /* 配信（コンソール）のレースに追従する間隔。
       通知（BroadcastChannel）が届いていないときの値＝乗り遅れないよう短く取る */
    FOLLOW_MS: 5000,

    /* 通知が届いているときの間隔。GASは保険でしかないので大きく空ける。
       GASの実行枠はGoogleアカウント単位で全オーバーレイと共用＝叩きすぎると
       コンソールの保存が失敗しやすくなる（2026-08-12に実際に発生） */
    FOLLOW_MS_BC: 30000,

    /* 出走表・並び予想・配信中レースの取得先。
       OKL配信システム（stagekit）のGASバックエンドをそのまま読ませてもらっている。
       読み取り専用（action=timetable / action=narabi / action=state）。

       ?gas=<URL> でバックエンドを差し替えられる（stagekitのconfig.jsと同じ仕組み・同じ書式）。
       テスト用コンソールで動作確認するときは、ドックのURLにも同じ ?gas= を付ける。
       付けないと本番を見にいくので「テストで場を変えても盤面が追従しない」ことになる。

       ⚠️script.google.com のURLしか受け付けない（任意ホストを許すと細工リンクの踏み台になる）。
         このボードは読み取り専用で書き込みキーを持たないが、stagekit側と規則を揃えておく */
    GAS_URL: GAS_URL,

    /** テスト用バックエンドに繋いでいるか。取り違えが一番怖いので画面に出す */
    IS_TEST_BACKEND: GAS_OK
  };
})();
