/* ===========================================================
   main.js — 起動・タブ切替・接続確認・スマホの画面の行き来
   =========================================================== */

/* ══════════ スマホ（1カラム）の画面の行き来＝要件§35 ══════════
   PCは2カラムで「左で選んで右で見る」。狭い画面では「さがす」「選手」の2画面を行き来する。
   🔑`data-m` は**幅に関係なく常に付ける**（CSSの @media の中でだけ使う）
      ＝PCで選手を開いたままウィンドウを狭めても、いま見ているものがそのまま出る。
   🔑**履歴を積むのは狭いときだけ**＝PCで「戻る」がページを離れられなくなるのを防ぐ。
   🔑Androidの戻る（ジェスチャ・ボタン）とiOSのスワイプバックは popstate として届く
      ＝PWAで「戻る」がアプリごと閉じてしまうのを防ぐために、詳細を開いたら1つ積む。
   ⚠️出力ビュー（OBS）では作らない＝画面遷移も履歴も一切触らせない。 */
var MOBILE = (window.CONFIG && CONFIG.IS_OUTPUT) ? null : (function () {

  var MQ = window.matchMedia('(max-width: 700px)');
  var pushed = false;                 // 履歴を1つ積んでいるか（二重に積まない）

  function isNarrow() { return MQ.matches; }
  function app() { return document.getElementById('app'); }

  function toDetail() {
    var a = app();
    if (!a || a.dataset.m === 'detail') return;   // すでに詳細＝積み直さない
    a.dataset.m = 'detail';
    if (!isNarrow()) return;
    try { history.pushState({ riders: 'detail' }, ''); pushed = true; } catch (e) { /* 履歴が使えない環境 */ }
    window.scrollTo(0, 0);            // 前の選手を見ていた位置に居ると、名前が画面の外にある
  }

  function toList() {
    var a = app();
    if (a) a.dataset.m = 'list';
  }

  /** 画面の「← もどる」。履歴を積んでいれば戻す（popstate 経由で toList される）
      ＝画面のボタンとブラウザの戻るで、同じ道を通す。 */
  function back() {
    if (pushed) { pushed = false; history.back(); return; }
    toList();
  }

  /** 幅の境目をまたいだとき（回転・ウィンドウの拡げ縮め）に呼ぶ。
      ⚠️iOS Safari 13以前は addEventListener を持たないので addListener も見る。 */
  function onChange(fn) {
    if (MQ.addEventListener) MQ.addEventListener('change', fn);
    else if (MQ.addListener) MQ.addListener(fn);
  }

  window.addEventListener('popstate', function () { pushed = false; toList(); });

  return { isNarrow: isNarrow, toDetail: toDetail, toList: toList, back: back, onChange: onChange };
})();

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
    if (!b) return;
    // スマホは上のバーに文言が入らないので印だけにする（§35）。押す先はホバーの説明に残す
    var narrow = !!(MOBILE && MOBILE.isNarrow());
    b.textContent = narrow ? (light ? '●' : '○') : (light ? '● 黒背景に戻す' : '○ 白背景にする');
    b.title = light ? '黒背景に戻す' : '白背景にする';
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
    bindMobile();
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
        // スマホはタブが「さがす画面」の中身なので、詳細を見ているときに押したら一覧へ戻す
        if (MOBILE) MOBILE.toList();
        backLabel();
      });
    });
    backLabel();
  }

  /** スマホの戻りバーと、幅の境目をまたいだときの作り直し（§35） */
  function bindMobile() {
    if (!MOBILE) return;
    var b = document.getElementById('m-back');
    if (b) b.addEventListener('click', function () { MOBILE.back(); });
    MOBILE.onChange(function () {
      applyTheme(readTheme());     // ボタンの文言（○ ⇄ ○ 白背景にする）
      // 🔑出走表は幅で列数が変わる（成績10列を出すか出さないか）＝作り直さないと見出しと明細がずれる。
      //   ⚠️詳細は作り直さない＝書きかけのメモが消えるため。次に開いた選手から新しい形になる。
      if (window.TODAY && TODAY.redraw) TODAY.redraw();
    });
  }

  /** 戻りバーの文言を「どこへ戻るか」に合わせる（bindTabs から呼ぶ） */
  function backLabel() {
    var b = document.getElementById('m-back');
    if (!b) return;
    var tab = document.getElementById('app').dataset.tab;
    b.textContent = (tab === 'today') ? '← 出走表へ' : '← 一覧へ';
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
