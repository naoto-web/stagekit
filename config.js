/* config.js — 接続設定（デプロイ時にGASのURLを反映する）

   ?gas=<URL> を付けると、そのURLをバックエンドとして使う（検証環境用）。
   付いていなければ本番。コンソール・オーバーレイの両方に効く。
   例）console.html?gas=<テスト用GASのURL>&key=<テスト用キー>

   ⚠️ script.google.com のURLしか受け付けない。
      任意のホストを許すと、細工したリンクを踏んだときに
      コンソールの書き込みキーが外部へ送られてしまうため。 */
(function () {
  var PROD = "https://script.google.com/macros/s/AKfycbw7I6ejxz4sy4RMXxc_2mhSxjzHaBrXwExv33_znFRvVfPjVsQSlVsJbh_fcnJ4lNkDVA/exec";

  var override = "";
  try { override = new URLSearchParams(location.search).get("gas") || ""; } catch (e) { override = ""; }
  var ok = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(override);

  window.APP_CONFIG = {
    GAS_URL: ok ? override : PROD,
    IS_TEST_BACKEND: ok,   // テストバックエンドに繋いでいるか（画面に出す用）
    POLL_MS: 5000,         // オーバーレイの状態ポーリング間隔
    TT_POLL_MS: 600000,    // タイムテーブル再取得間隔（10分）
  };
})();
