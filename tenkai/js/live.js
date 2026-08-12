/* ===========================================================
   live.js — 操作画面（ドック）→ 出力画面（ブラウザソース）の実時間同期

   ねらい：OBSのカスタムブラウザドックと、ブラウザソースの間で
           BroadcastChannel が通るかを実機で確かめること。
           通れば C案（操作をOBS内に常設）が成立する。

   ・?view=output を付けた側が「出力」。付けない側が「操作」
   ・同一オリジンであることが条件（どちらも naoto-web.github.io/tenkai/）
   ・操作側は2秒ごとにpingを打ち、出力側がpongを返す。
     操作側の緑/赤インジケータはこの往復で決まる＝これがC案の可否判定そのもの

   BroadcastChannelが通らなかった場合の代替は obs-websocket の
   BroadcastCustomEvent 経由のリレー。そこはこのファイルを差し替えるだけで済むよう、
   外に見せるのは init / publish / isAlive の3つだけにしてある。
   =========================================================== */

var Live = (function () {

  /* ⚠️ここはバックエンド（?gas=）で名前を分けないこと。
     ドック↔出力の伝送は「盤面の絵」の話でGASとは無関係だし、
     出力ソース（?view=output）はGASを叩かないので ?gas= を付けない運用にしてある。
     名前を分けると、テスト用ドック（?gas=あり）と出力（?gas=なし）が別チャンネルになり
     盤面が映らなくなる。分けるのはコンソール側のチャンネルだけでよい */
  var CHANNEL = 'tenkai-live-v1';
  var PING_MS = 2000;    // 生存確認の間隔
  var DEAD_MS = 5000;    // これだけpongが来なければ切断とみなす
  var SEND_MS = 33;      // 位置の送信間隔（約30fps。ドラッグはこれで十分滑らか）

  var chan = null;
  var mode = 'control';  // 'control' | 'output'
  var handlers = {};
  var lastPong = 0;
  var lastSend = 0;
  var available = false;

  function now() { return Date.now(); }

  function post(msg) {
    if (!chan) return;
    try { chan.postMessage(msg); } catch (e) {}
  }

  function onMessage(ev) {
    var m = ev.data || {};

    if (mode === 'output') {
      if (m.type === 'ping') { post({ type: 'pong' }); return; }
      if (m.type === 'state' && handlers.onState) handlers.onState(m.data);
      return;
    }

    /* 操作側 */
    if (m.type === 'pong') { lastPong = now(); return; }
    if (m.type === 'want') {
      /* 聞き専の購読者（stagekitの③レース展開オーバーレイ）が「今の状態をください」と
         聞いてきた。このボードは render() のときしか状態を流さないので、
         ドックを開いたまま放置していると後から起動した購読者は永久に何も受け取れない。
         ⚠️lastPong は絶対に触らない＝これは出力ソースの生存判定であって、
            聞き専の購読者が居ることを「出力が生きている」と誤認させてはいけない */
      if (handlers.onWant) handlers.onWant();
      return;
    }
    if (m.type === 'hello') {
      /* 出力側が起動した。現状を即座に送って追いつかせる */
      lastPong = now();
      if (handlers.onHello) handlers.onHello();
    }
  }

  return {
    /** @returns {boolean} BroadcastChannel がこの環境で使えるか */
    init: function (viewMode, h) {
      mode = viewMode === 'output' ? 'output' : 'control';
      handlers = h || {};

      try {
        chan = new BroadcastChannel(CHANNEL);
        chan.onmessage = onMessage;
        available = true;
      } catch (e) {
        chan = null;
        available = false;
        return false;
      }

      if (mode === 'output') {
        post({ type: 'hello' });
      } else {
        setInterval(function () { post({ type: 'ping' }); }, PING_MS);
        post({ type: 'ping' });
      }
      return true;
    },

    available: function () { return available; },

    /** 出力側が生きているか（操作側でのみ意味がある） */
    isAlive: function () {
      return available && (now() - lastPong) < DEAD_MS;
    },

    /** 状態を出力側へ流す。ドラッグ中に毎フレーム呼ばれるので間引く */
    publish: function (data, force) {
      if (!chan || mode !== 'control') return;
      var t = now();
      if (!force && t - lastSend < SEND_MS) return;
      lastSend = t;
      post({ type: 'state', data: data });
    }
  };
})();
