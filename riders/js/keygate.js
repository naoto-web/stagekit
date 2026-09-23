/* ===========================================================
   keygate.js — APIキーを画面から入れてもらう（要件§39）
   ===========================================================
   🔴**なぜ要るか**（2026-09-23夜・YのiPhone実機で発覚）
      iPhoneのホーム画面アプリは
        ① manifest の `start_url`（"./"）で起動する ＝ **追加したときの `?k=` が落ちる**
        ② Safari とは **localStorage が別** ＝ Safariで覚えたキーがアプリには届かない
      ⇒ 取扱説明書どおり「`?k=` を付けたまま追加」しても、アプリからは**必ず**キー無しで開く。
      （旧コメント「iPhoneは start_url を見ない」は誤りだった）

   🔑**`start_url` を消す直し方は採らない**＝`start_url` はChromeのインストール要件なので、
      消すとAndroidが「アプリをインストール」を出さなくなる（Naotoの端末が壊れる）。
      ⇒ **URLに頼らずキーを入れられる道を1本足す**。これならOSの挙動に関係なく直る。

   🔑**LINEのURLをまるごと貼ってもよい**＝`?k=` から後ろだけを切り出すのはYに酷。
      生のキーだけ貼られた場合も受ける。
   ⚠️**出力ビュー（OBS）では絶対に出さない**＝配信画面に入力欄が出る事故を防ぐ。
      呼び出しは main.js の操作ビュー側だけ（出力ビューはその手前で return している）。
*/

var KEYGATE = (function () {

  /** 貼られた文字からキーを取り出す。URLでも生のキーでも受ける。
      🔑`?k=` も `#k=` も `&k=` も拾う（LINEやメモ経由で形が変わることがある）。
      ⚠️取れなければ空文字を返す＝呼び出し側でエラーを出す。 */
  function extract(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    var m = s.match(/[?#&]k=([^&#\s]+)/);            // URLごと貼られた
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }
    if (/^[A-Za-z0-9_-]{8,}$/.test(s)) return s;     // キーだけ貼られた
    return '';
  }

  function gate() { return document.getElementById('keygate'); }

  /** 画面を出す。`msg` を渡すと赤字で理由を添える。
      ⚠️入力欄は**消さない**＝打ち直しのとき貼り直しになるため。 */
  function show(msg) {
    var g = gate();
    if (!g) return;
    var e = document.getElementById('kg-err');
    if (e) { e.textContent = msg || ''; e.hidden = !msg; }
    g.hidden = false;
  }

  function hide() {
    var g = gate();
    if (g) g.hidden = true;
  }

  /** キーを保存したあとの開き直し。
      🔑URLに残った `k=` は**消してから**開き直す＝あとで「入れ直す」を押したときに、
         URLに残った古いキーが黙って復活するのを防ぐ（config.js はURLを優先して覚える）。
      ⚠️`URL` が使えない古い端末では素直に読み込み直すだけにする。 */
  function reloadClean() {
    try {
      var u = new URL(location.href);
      u.searchParams.delete('k');
      location.replace(u.toString());
      return;
    } catch (e) { /* 下の reload へ */ }
    location.reload();
  }

  function save() {
    var i = document.getElementById('kg-inp');
    var key = extract(i && i.value);
    if (!key) {
      show('読み取れませんでした。LINEのURLを、はじめから終わりまで全部貼ってください。');
      return;
    }
    try {
      localStorage.setItem(CONFIG.KEY_LS, key);
    } catch (e) {
      // プライベートブラウズ・サイトデータの拒否
      show('この端末に保存できません。プライベートブラウズを切って、もう一度お試しください。');
      return;
    }
    reloadClean();
  }

  function bind() {
    var b = document.getElementById('kg-go');
    if (b) b.addEventListener('click', save);
    var i = document.getElementById('kg-inp');
    if (i) {
      i.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); save(); }
      });
    }
  }

  return { show: show, hide: hide, bind: bind, extract: extract };
})();
