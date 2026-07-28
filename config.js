/* config.js — 接続設定（デプロイ時にGASのURLを反映する） */
window.APP_CONFIG = {
  GAS_URL: "https://script.google.com/macros/s/AKfycbw7I6ejxz4sy4RMXxc_2mhSxjzHaBrXwExv33_znFRvVfPjVsQSlVsJbh_fcnJ4lNkDVA/exec",
  POLL_MS: 5000,        // オーバーレイの状態ポーリング間隔
  TT_POLL_MS: 600000,   // タイムテーブル再取得間隔（10分）
};
