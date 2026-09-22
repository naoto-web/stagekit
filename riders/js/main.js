/* ===========================================================
   main.js — 起動・タブ切替・接続確認
   =========================================================== */

(function () {

  // ── 出力ビューはここで分岐して、操作用のコードを一切動かさない ──
  if (CONFIG.IS_OUTPUT) {
    OUTPUT.start();
    return;
  }

  /* ── 背景の色（黒／白）＝2026-09-23 Naoto「一応見て、すぐ元に戻せるように」──
     🔑**ここより上（IS_OUTPUT の return）で出力ビューは抜けている**＝配信画面には一切かからない。
     🔑DOMContentLoaded を待たずにここで当てる（main.js は body の末尾で読まれる）。
        待つと黒い画面が一瞬見えてから白に変わる。 */
  applyTheme(readTheme());

  function readTheme() {
    try { return localStorage.getItem(CONFIG.LS_PREFIX + 'theme') || 'dark'; } catch (e) { return 'dark'; }
  }
  function applyTheme(t) {
    var light = (t === 'light');
    document.body.dataset.theme = light ? 'light' : 'dark';
    var b = document.getElementById('theme-btn');
    if (b) b.textContent = light ? '● 黒背景に戻す' : '○ 白背景にする';
  }
  function bindTheme() {
    var b = document.getElementById('theme-btn');
    if (!b) return;
    applyTheme(readTheme());                   // ボタンの文言をいまの状態に合わせる
    b.addEventListener('click', function () {
      var next = (document.body.dataset.theme === 'light') ? 'dark' : 'light';
      applyTheme(next);
      try { localStorage.setItem(CONFIG.LS_PREFIX + 'theme', next); } catch (e) { /* プライベートモード等 */ }
    });
  }

  // ── 操作ビュー ──
  document.addEventListener('DOMContentLoaded', function () {
    bindTheme();
    bindTabs();
    LIST.bind();
    TODAY.bind();
    checkConn();

    // 書きかけは自動保存されるが、間に合っていないときだけ止める
    window.addEventListener('beforeunload', function (e) {
      if (!DETAIL.isDirty()) return;
      DETAIL.flush();
      e.preventDefault();
      e.returnValue = '';
    });
    // タブを離れる・画面を切り替えるときにも書きかけを流し込む
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') DETAIL.flush();
    });
  });

  function bindTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.toggle('is-on', x === t); });
        var want = t.dataset.tab;
        document.getElementById('app').dataset.tab = want;   // 出走表のとき左を広げる（CSS）
        document.getElementById('pane-list').classList.toggle('is-hidden', want !== 'list');
        document.getElementById('pane-today').classList.toggle('is-hidden', want !== 'today');
        if (want === 'today') TODAY.ensure();
      });
    });
  }

  function checkConn() {
    var n = document.getElementById('conn');
    if (!CONFIG.KEY) {
      n.dataset.ok = 'ng';
      n.textContent = 'APIキーがありません（URLに ?k=… を付けて開く）';
      return;
    }
    API.ping().then(function (j) {
      if (!j || !j.ok) throw new Error('ng');
      n.dataset.ok = 'ok';
      n.textContent = CONFIG.IS_TEST_BACKEND ? '【テスト接続】' : '接続OK';
      // 役割別の集計（1.4MB）は起動時に裏で取っておく＝最初の1人目を開くときに待たせない
      API.stats();
      return LIST.load(document.getElementById('kyuhan-sel').value, true);
    }).catch(function () {
      n.dataset.ok = 'ng';
      n.textContent = 'バックエンドに繋がりません';
    });
  }
})();
