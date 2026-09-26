/* ===========================================================
   config.js — 定数（枠色・コースの寸法・局面・既定値）  v2＝バンク1周（オーバル）

   座標の考え方（要件定義_v2 §3）
     盤面は 960×572 の仮想座標で描く（③の穴と同じ大きさ）。SVGの viewBox で
     ドックでも出力でも同じ絵になる（縦横比は保ったまま拡大縮小）。
     選手の位置は「周回位置 d（ゴールまで残り何周）」と「内外 lane（-1内/0中/+1外）」で持つ。
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

  /* コースの寸法（仮想座標 960×572・モック v2案/モック.html と同じ値）
     直線2本＋半円2つ。左回り。ホーム直線が下、バックが上 */
  var TRACK = {
    W: 960, H: 572,
    CX: 480, CY: 290,
    RC: 186,          // センターラインの半径（中レーン）
    LSTR: 390,        // 直線の長さ
    LANE: 54,         // レーン間隔（内・中・外）
    HALF: 81,         // 路面の帯幅（センターから内外へ）
    GOAL_OFF: 150,    // ゴール線＝ホーム直線の右端（1角）から何px手前か。40→150（9/27）＝決着で1着が1車身ずつ離れて入線しても直線の上に収まる
    OUTER_LINE: -27,  // 外帯線（赤）＝内レーンと中レーンのあいだ
    INNER_LINE: -78   // 内圏線（白）＝路面の内縁
  };
  /* 距離の基準＝内レーン（半径 RC−LANE＝132px）。
     ⚠️中レーンで測ると、隊列が通る内レーンではコーナーで間隔が 132/186 に縮み、丸どうしが重なる
       （9/27の撮影で2角の隊列が重なっていた）。内レーン基準なら1車身＝56pxがどこでも保たれ、
       中・外レーンはコーナーで広がる方向（重ならない） */
  TRACK.RREF = TRACK.RC - TRACK.LANE;
  var LAP = 2 * TRACK.LSTR + 2 * Math.PI * TRACK.RREF;   // 1周の長さ（内レーン・px）

  /* 1車身（px）。自動配置の間隔・ホイール1ノッチの量の単位 */
  var CAR_PX = 56;
  var CAR = CAR_PX / LAP;   // 周単位

  /* 局面（要件定義_v2 §5）。d＝そのとき先頭がいる周回位置
     バック・4角は「場所」で決めてから d に換算する（ゴール線がホーム直線の端にあるため0.5周≠バック中央） */
  var P_C = TRACK.GOAL_OFF + Math.PI * TRACK.RREF;         // バック直線の始まり（2角の出口）
  var P_D = P_C + TRACK.LSTR;                               // バック直線の終わり（3角の入口）
  var PHASES = [
    { key: 'start',   label: 'スタート',   d: 3.0 },
    { key: 'red',     label: '赤板',       d: 2.0 },
    { key: 'bell',    label: '打鐘',       d: 1.5 },
    { key: 'home',    label: '最終ホーム', d: 1.0 },
    { key: 'back',    label: '最終バック', d: 1 - (P_C + TRACK.LSTR / 2) / LAP },
    { key: 'corner4', label: '4角',        d: 1 - (P_D + Math.PI * TRACK.RREF / 2) / LAP },
    /* 最終ストレート（9/27 Naoto）＝4角を抜けてホーム直線に入ったところ。ここで差し・突き抜け・ズブズブを押すと3着までゴールする */
    { key: 'straight', label: '最終ストレート', d: 1 - (P_D + Math.PI * TRACK.RREF) / LAP },
    { key: 'goal',    label: 'ゴール',     d: 0 }
  ];

  return {
    COLORS: COLORS,
    MAX_CAR: 9,

    TRACK: TRACK,
    LAP: LAP,
    CAR: CAR,
    PHASES: PHASES,
    BELL_D: 1.5,        // 誘導員が退避する位置（先頭がここを過ぎたら消える）
    D_MAX: 3.6,         // 周回位置の上限（スタート隊列の最後尾が入る値）
    D_MIN: -0.25,       // 下限＝ゴール線の先。決着で3人がゴール線を完全に越えるところまで走るため（9/27 Naoto）。ホイール・局面ボタンは今までどおりゴール線で止まる

    /* アイコン径 / 盤面の幅（960）。v2はレーン間隔54pxに収まる範囲に絞る */
    ICON_RATIO_MIN: 0.040,
    ICON_RATIO_MAX: 0.056,
    ICON_RATIO_DEFAULT: 0.048,   // 46px＝モックと同じ
    iconPx: function (ratio) { return TRACK.W * ratio; },

    /* 自動配置（要件定義_v2 §6.8）：同一ライン1.05車身・ライン間＋0.7車身・全員内 */
    LAYOUT: { gapInLine: 1.05, gapBetween: 0.7,
      /* スタートの升目（9/27 Naoto）：車番順に内→外へ3人ずつ、前から列にする（1-2-3／4-5-6／7-8-9）。
         列の前後は2車身＝真ん中のレーンの苗字チップを丸の後ろに出す場所（5文字の名前まで入る） */
      gridGap: 2.0, gridRows: 3,
      /* 決着の着差（車身）。0.35は着順が分かりづらかった（9/27 Naoto）→1車身 */
      finishGap: 1.0 },

    /* ホイール1ノッチ＝0.5車身 */
    WHEEL_STEP: 0.5 * CAR,

    /* 局面ボタンのアニメの長さ＝ baseMs ＋ 動く距離（周）× msPerLap、上限 maxMs。
       遠いジャンプも今いる位置から1周以内で動く（周回数は裏で合わせる）。半周で約2.4秒、上限2.6秒。
       旧値（350＋1200/周・上限1.1秒）は「速い」（9/27 Naoto）→ ゆっくりに。速さの調整はここだけ触ればよい */
    ANIM: { baseMs: 900, msPerLap: 3000, maxMs: 2600,
      /* スタート⇔赤板などの隊形の組み替え（升目⇔一列）は別の長さ。2.6秒は「早い」（9/27 Naoto）→5秒 */
      reformMs: 5000,
      /* 動詞ボタン（まくり・差し…）の動きの長さ。押切だけは距離が長いので1.5倍 */
      verbMs: 2600,
      /* 決着（最終ストレートでの差し・突き抜け・ズブズブ／3連単の入力）でゴールまで走り切る長さ */
      finishMs: 3800 },

    /* 取り消しの最大手数 */
    UNDO_MAX: 30,

    /* v1（keirin-tenkai-board-v1）は読まない＝座標系が違うものを混ぜない */
    STORAGE_KEY: 'keirin-tenkai-board-v2',

    FOLLOW_MS: 5000,
    FOLLOW_MS_BC: 30000,

    /* ?gas=<URL> でバックエンドを差し替えられる（stagekitのconfig.jsと同じ仕組み）。
       ⚠️script.google.com のURLしか受け付けない */
    GAS_URL: GAS_URL,
    IS_TEST_BACKEND: GAS_OK
  };
})();
