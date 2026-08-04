/* sync.js — GASとの状態同期＋BroadcastChannel高速経路（コンソール・オーバーレイ共有）
   経路は2段構え：
   ① BroadcastChannel（同一オリジン・OBS内でドック⇔ブラウザソースが通れば即時反映）
   ② GASポーリング（確実な経路・5秒間隔）
   ①はOBSのプロセス分離で通らない可能性があるため（issue #6202）、②が常に土台。 */

(function () {
  var cfg = window.APP_CONFIG || {};
  var BC_NAME = "live-sync-v1";

  var Sync = {
    channel: null,
    lastRev: 0,
    bcAlive: false, // BroadcastChannelで受信実績があるか（B2テストの観測点）

    /* ---------- BroadcastChannel ---------- */
    initChannel: function (onMessage) {
      if (typeof BroadcastChannel === "undefined") return null;
      try {
        this.channel = new BroadcastChannel(BC_NAME);
        var self = this;
        this.channel.onmessage = function (ev) {
          var msg = ev.data || {};
          if (msg.type === "state" || msg.type === "pong" || msg.type === "ping") self.bcAlive = true;
          if (msg.type === "ping" && self.channel) self.channel.postMessage({ type: "pong" });
          if (onMessage) onMessage(msg);
        };
      } catch (e) { this.channel = null; }
      return this.channel;
    },
    broadcast: function (msg) {
      if (this.channel) { try { this.channel.postMessage(msg); } catch (e) {} }
    },

    /* ---------- GAS読み取り ---------- */
    fetchState: function () {
      return fetch(cfg.GAS_URL + "?action=state", { redirect: "follow" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || "state fetch failed");
          return j.state; // 未初期化ならnull
        });
    },
    fetchTimetable: function (day, refresh) {
      var url = cfg.GAS_URL + "?action=timetable&day=" + (day ? 1 : 0) + (refresh ? "&refresh=1" : "");
      return fetch(url, { redirect: "follow" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || "timetable fetch failed");
          return j.timetable;
        });
    },
    /** 確定済みレース結果の自動取得。[{no, order, names, kimarite, payouts}] */
    fetchResults: function (jo) {
      var url = cfg.GAS_URL + "?action=results&jo=" + encodeURIComponent(jo);
      return fetch(url, { redirect: "follow" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || "results fetch failed");
          return j.results || [];
        });
    },
    /** 並び予想（ライン）＋競走得点の自動取得。{narabi:'147 26 35', scores:{車番:'111.72'}} */
    fetchNarabi: function (jo, race) {
      var url = cfg.GAS_URL + "?action=narabi&jo=" + encodeURIComponent(jo) + "&race=" + (+race || 0);
      return fetch(url, { redirect: "follow" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || "narabi fetch failed");
          return { narabi: j.narabi || "", scores: j.scores || {} };
        });
    },

    /* ---------- GAS書き込み（コンソール専用・keyが要る） ----------
       Content-Type: text/plain でプリフライトを回避（GASはOPTIONSに応答しないため） */
    post: function (body) {
      return fetch(cfg.GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(body),
        redirect: "follow",
      }).then(function (r) { return r.json(); });
    },
    saveState: function (key, state) {
      var self = this;
      return this.post({ key: key, action: "setState", state: state }).then(function (j) {
        if (!j.ok) throw new Error(j.error || "save failed");
        state.rev = j.rev;
        self.lastRev = j.rev;
        self.broadcast({ type: "state", state: state }); // 高速経路（通れば即時反映）
        return j.rev;
      });
    },

    /* ---------- オーバーレイ用ポーリング ---------- */
    startPolling: function (onState, onError) {
      var self = this;
      var tick = function () {
        self.fetchState().then(function (state) {
          if (state && state.rev !== self.lastRev) {
            self.lastRev = state.rev;
            onState(state, "poll");
          }
          if (onError) onError(null);
        }).catch(function (e) { if (onError) onError(e); });
      };
      tick();
      return setInterval(tick, cfg.POLL_MS || 5000);
    },
  };

  window.Sync = Sync;
})();
