/* autoupdate.js — オーバーレイの遠隔自動更新（要件§12・8/27）
   公開のたびに version.json の版番号が変わる。このファイルは60秒ごとにそれを見て、
   自分が古くなったら「安全なタイミングで」自分のページを読み直す。

   モード（scriptタグの data-au 属性で宣言）:
     reload      … 自動リロード対象（overlay.html）
     output-only … ?view=output のときだけ reload、それ以外は不活性（tenkai/index.html）
     banner      … リロードは絶対にしない。新版の通知バナーを出すだけ（console.html）

   安全機構（要件§12.4）:
     - 表示中のページは自動リロードしない（非表示になって10秒静まってから）
     - ナビゲート前に移動先を実GETし、新版の刻印が本文にあることを確認（未反映・ネット断ならしない）
     - 同一版への試行は2回まで＋リロード間隔は最短120秒（ループガード）
     - version.json の pause:true で全ページ即・不活性（遠隔キルスイッチ）
     - URLに &au=0 でソース単位で不活性（OBS側だけで外せる保険）
     - force:true（公開.ps1 -Force）は表示中でもリロード。ただし演出終了（window.__fxUntil）は待つ

   ⚠️ 下の AU_BUILD のプレースホルダは公開.ps1が公開時にアップロードblobへ実版番号を刻印する（要件§12.2）。
      未刻印＝ローカル・検証ハーネスでは何もしない（完全に不活性）。
      ⚠️ 引用符付きのプレースホルダ表記をコメントに書かないこと（刻印は全置換＝コメントまで版番号に化ける。
         逆にテスト側でJSのreplaceを文字列指定で使うと最初の1個しか置換されず未刻印のままになる罠・8/27実測）。
   検証用パラメータ（⚠️&debug=1と併用時のみ有効＝本番URLへのコピペ事故対策）:
     &aufast=1（初回2秒・周期5秒） &auvis=hidden（常に非表示扱い） */

(function () {
  "use strict";
  var AU_BUILD = "20260902-155926";

  var params;
  try { params = new URLSearchParams(location.search); } catch (e) { return; }

  // ---- 不活性条件（1つでも該当したら何もしないで終わる） ----
  if (AU_BUILD.indexOf("__") === 0) return;            // 未刻印＝ローカル/ハーネス
  if (location.protocol === "file:") return;
  if (params.get("au") === "0") return;                // ソース単位の保険

  var script = document.currentScript;
  if (!script) {                                        // 念のためのフォールバック
    var list = document.querySelectorAll('script[src*="autoupdate"]');
    script = list.length ? list[list.length - 1] : null;
  }
  if (!script) return;
  var MODE = script.getAttribute("data-au") || "";
  if (MODE === "output-only") {
    if (params.get("view") !== "output") return;        // tenkaiの操作ドックは対象外
    MODE = "reload";
  }
  if (MODE !== "reload" && MODE !== "banner") return;

  // version.json の場所＝このスクリプトの隣（tenkai/ 配下のページからも正しく解決される）
  var VER_URL = script.src.replace(/[^\/]*$/, "").replace(/\?.*$/, "") + "version.json";

  var DEBUG = params.get("debug") === "1";
  // 検証用は&debug=1必須（8/27レビュー指摘：テストURLのコピペ事故で本番が常時hidden扱い＝
  // 表示中リロードの恒久事故装置になるのを防ぐ。本番運用は「debugを外す」規律と整合）
  var FAST = DEBUG && params.get("aufast") === "1";
  var TESTVIS = DEBUG ? (params.get("auvis") || "") : "";
  var FIRST_MS = FAST ? 2000 : 15000;
  var TICK_MS = FAST ? 5000 : 60000;
  var SETTLE_MS = FAST ? 2000 : 10000;                  // 非表示になってからの沈静化待ち
  var MIN_GAP_MS = 120000;                              // リロード間隔の下限
  var MAX_TRY = 2;                                      // 同一版への試行上限
  var FX_WAIT_MAX = 20;                                 // force時の演出待ち上限（3秒×20＝最大60秒）

  var remote = null;      // 最後に見たversion.json（{v, force, pause}）
  var busy = false;       // リロード手続きの多重起動防止
  var armed = false;      // visibilitychange待ちを二重に張らない

  function log(m) { try { console.log("[autoupdate] " + m); } catch (e) {} }
  function ss(k, v) {     // sessionStorage（使えない環境では黙って素通り＝試行制限なしでも他のガードが効く）
    try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (e) { return null; }
  }
  function ssRemove(re) {
    try {
      var kill = [];
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (re.test(k)) kill.push(k);
      }
      kill.forEach(function (k) { sessionStorage.removeItem(k); });
    } catch (e) {}
  }
  function isHidden() { return TESTVIS === "hidden" || document.visibilityState === "hidden"; }
  function fxBusy() { return (window.__fxUntil || 0) > Date.now(); }

  function get(url, cb) {  // XHR＝タイムアウト付きGET。cb(status, text)／失敗は cb(0, "")
    try {
      var x = new XMLHttpRequest();
      x.open("GET", url, true);
      x.timeout = 10000;
      x.onload = function () { cb(x.status, x.responseText || ""); };
      x.onerror = x.ontimeout = x.onabort = function () { cb(0, ""); };
      x.send();
    } catch (e) { cb(0, ""); }
  }

  // ---- デバッグバッジ（&debug=1のときだけ） ----
  var badge = null;
  function setBadge(t) {
    if (!DEBUG) return;
    if (!badge) {
      badge = document.createElement("div");
      badge.style.cssText = "position:fixed;top:4px;right:4px;z-index:99999;font:11px/1.4 monospace;" +
        "background:rgba(0,0,0,.7);color:#8f8;padding:2px 6px;border-radius:4px;pointer-events:none;";
      (document.body || document.documentElement).appendChild(badge);
    }
    badge.textContent = "AU " + AU_BUILD + " " + t;
  }

  // ---- 移動先URL（今のパラメータを全部保ったまま v だけ差し替える） ----
  function targetUrl(v) {
    var p;
    try { p = new URLSearchParams(location.search); } catch (e) { return null; }
    p.set("v", v);
    return location.pathname + "?" + p.toString() + (location.hash || "");
  }

  // ---- バナーモード（console）＝リロードせず知らせるだけ ----
  function showBanner(v) {
    if (ss("au_dismiss") === v) return;
    var el = document.getElementById("au-banner");
    if (el) { el.setAttribute("data-v", v); return; }
    el = document.createElement("div");
    el.id = "au-banner";
    el.setAttribute("data-v", v);
    el.style.cssText = "position:fixed;left:50%;bottom:8px;transform:translateX(-50%);z-index:99998;" +
      "background:#1a3a5c;color:#fff;font:12px/1.6 sans-serif;padding:6px 12px;border-radius:6px;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.4);display:flex;gap:10px;align-items:center;";
    var span = document.createElement("span");
    span.textContent = "🔄 画面の新しい版があります — 手すきの時に右クリック→「再読み込み」（ブラウザならF5）";
    var x = document.createElement("button");
    x.textContent = "✕";
    x.style.cssText = "background:none;border:none;color:#9cf;cursor:pointer;font-size:13px;padding:0;";
    x.onclick = function () { ss("au_dismiss", el.getAttribute("data-v")); el.parentNode.removeChild(el); };
    el.appendChild(span);
    el.appendChild(x);
    (document.body || document.documentElement).appendChild(el);
  }
  function hideBanner() {
    var el = document.getElementById("au-banner");
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // ---- リロード手続き：沈静化待ち → プローブ → ナビゲート ----
  function attempt(v, force) {
    if (busy) return;
    busy = true;
    setBadge("→" + v + (force ? " force" : ""));

    var fxTries = 0;
    function settle() {
      // 沈静化待ち：非表示のまま SETTLE_MS 経過してから。force時は表示中でも演出終了だけ待つ
      if (!force && !isHidden()) { busy = false; arm(); return; } // 待つ間に表に出た＝仕切り直し
      if (force && fxBusy() && fxTries < FX_WAIT_MAX) { fxTries++; setTimeout(settle, 3000); return; }
      probe();
    }
    function probe() {
      if (remote && remote.v !== v) { busy = false; return; }     // 待つ間にさらに新しい版が出た＝次tickで仕切り直し
      var url = targetUrl(v);
      if (!url) { busy = false; return; }
      get(url, function (status, text) {
        // ⚠️XHR往復（最大10秒）の間に状況が変わりうる＝ナビゲート直前の再チェック（8/27レビュー指摘）。
        //   シーンを戻された・pauseが配られた・さらに新版が出た、のどれでも移動しない。
        //   ガード（試行上限・間隔）もここで再確認＝visibilitychange経由の経路にも同じ網がかかる
        if (remote && (remote.v !== v || remote.pause)) { busy = false; return; }
        if (!force && !isHidden()) { busy = false; arm(); return; }   // 表に戻っていた＝仕切り直し
        var tried = parseInt(ss("au_try_" + v) || "0", 10);
        var lastNav = parseInt(ss("au_last") || "0", 10);
        if (tried >= MAX_TRY || Date.now() - lastNav < MIN_GAP_MS) { busy = false; return; }
        // 内容プローブ：移動先の本文に新版の刻印（?v=新版 のアセット参照）が入っているか。
        // 未反映（Pages配信前・エッジ古い）やネット断では絶対に移動しない＝旧コードのまま動き続ける
        if (status !== 200 || text.indexOf("?v=" + v) === -1) {
          log("プローブ不成立（status=" + status + "）＝移動しない。次の周回へ");
          setBadge("probe-ng " + v);
          busy = false;
          return;
        }
        ss("au_try_" + v, String(tried + 1));
        ss("au_last", String(Date.now()));
        log("リロード実行 " + AU_BUILD + " → " + v + "（試行" + (tried + 1) + "）");
        location.replace(url);
      });
    }
    setTimeout(settle, force ? 1000 : SETTLE_MS);
  }

  // 表示中に新版が来たとき：非表示になる瞬間を待ち受ける（1本だけ張る）
  function arm() {
    if (armed) return;
    armed = true;
    document.addEventListener("visibilitychange", function onVis() {
      if (!isHidden()) return;
      document.removeEventListener("visibilitychange", onVis);
      armed = false;
      if (remote && remote.v !== AU_BUILD && !remote.pause) attempt(remote.v, false);
    });
  }

  // ---- 毎分の監視 ----
  function tick() {
    get(VER_URL + "?aucb=" + Date.now(), function (status, text) {
      if (status !== 200) { setBadge("ver-ng"); return; }
      var j = null;
      try { j = JSON.parse(text); } catch (e) {}
      if (!j || typeof j.v !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(j.v)) { setBadge("ver-bad"); return; }
      remote = { v: j.v, force: !!j.force, pause: !!j.pause };

      if (remote.pause) { setBadge("pause"); return; }            // 遠隔キルスイッチ
      if (remote.v === AU_BUILD) {                                 // 最新＝後片付けだけ
        ssRemove(/^au_(try_|dismiss)/);
        hideBanner();
        setBadge("ok");
        return;
      }

      if (MODE === "banner") { showBanner(remote.v); setBadge("banner " + remote.v); return; }

      // ---- reloadモードのガード ----
      var tries = parseInt(ss("au_try_" + remote.v) || "0", 10);
      if (tries >= MAX_TRY) { setBadge("give-up " + remote.v); return; }   // 同一版に2回失敗＝諦めて旧版で動き続ける
      var last = parseInt(ss("au_last") || "0", 10);
      if (Date.now() - last < MIN_GAP_MS) { setBadge("cooldown"); return; }

      if (isHidden() || remote.force) attempt(remote.v, remote.force);
      else { setBadge("wait-hidden " + remote.v); arm(); }
    });
  }

  setTimeout(function () { tick(); setInterval(tick, TICK_MS); }, FIRST_MS);
  log("監視開始 build=" + AU_BUILD + " mode=" + MODE);
})();
