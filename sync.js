/* sync.js — GASとの状態同期＋BroadcastChannel高速経路（コンソール・オーバーレイ共有）
   経路は2段構え：
   ① BroadcastChannel（同一オリジン・OBS内でドック⇔ブラウザソースが通れば即時反映）
   ② GASポーリング（確実な経路・5秒間隔）
   ①はOBSのプロセス分離で通らない可能性があるため（issue #6202）、②が常に土台。 */

(function () {
  var cfg = window.APP_CONFIG || {};
  /* ⚠️チャンネル名はバックエンドごとに分ける（8/12）。
     以前は本番・テストで同名だったため、**テストコンソールの保存通知が本番のオーバーレイにも届いていた**。
     通知は保存の前に投げる楽観送信なので、テストを操作すると本番画面が一瞬テストの内容に変わり、
     次のポーリング（最大5秒）まで戻らない＝配信中にテストを触れない状態だった。
     名前を分ければ、テストと本番は同じOBS内に同居しても互いに干渉しない。 */
  var BC_NAME = "live-sync-v1" + (cfg.IS_TEST_BACKEND ? "-test" : "");

  var SAVE_RETRY = 3;         // 保存のやり直し回数（0.6→1.2→1.8秒と間隔を空ける）
  var SAVE_BACKOFF_MS = 600;
  var READ_RETRY = 2;         // 読み取りのやり直し回数（0.5→1.0秒）
  var READ_BACKOFF_MS = 500;

  /* 読み取りのやり直し（8/12）。
     GASの `/exec` は302で script.googleusercontent.com へ飛ぶが、
     **この転送先がときどき404を返す**（実測：1段目は常に302で、2段目だけ失敗する）。
     Google側の一時的な不安定さなので、少し待って叩き直せば通る。
     ⚠️読み取りは何度やっても副作用が無いので、やり直して安全 */
  function getJson(url, attempt) {
    attempt = attempt || 0;
    return fetch(url, { redirect: "follow" }).then(asJson).catch(function (e) {
      if (attempt >= READ_RETRY) throw e;
      return new Promise(function (r) { setTimeout(r, READ_BACKOFF_MS * (attempt + 1)); })
        .then(function () { return getJson(url, attempt + 1); });
    });
  }

  /* GASは混雑・エラー・権限切れのとき、JSONではなく**HTMLのエラーページ**を返す。
     そのまま r.json() に渡すと「Unexpected token '<'」という中身の分からない例外になり、
     生HTMLの断片が画面に出てしまう（8/12・コンソールの保存失敗として実際に発生）。
     ここで1か所に集約し、短く意味の分かるエラーへ翻訳する。 */
  function asJson(r) {
    return r.text().then(function (t) {
      try { return JSON.parse(t); }
      catch (e) {
        var why = r.status === 401 || r.status === 403 ? "権限（再承認が要るかも）"
          : r.status >= 500 ? "GAS側のエラー"
          : "混雑かエラーページ";
        throw new Error("GASがJSONを返しませんでした（HTTP " + r.status + "・" + why + "）");
      }
    });
  }

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
      return getJson(cfg.GAS_URL + "?action=state")
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || "state fetch failed");
          return j.state; // 未初期化ならnull
        });
    },
    fetchTimetable: function (day, refresh) {
      var url = cfg.GAS_URL + "?action=timetable&day=" + (day ? 1 : 0) + (refresh ? "&refresh=1" : "");
      return getJson(url)
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || "timetable fetch failed");
          return j.timetable;
        });
    },
    /** 確定済みレース結果の自動取得。[{no, order, names, kimarite, payouts}] */
    fetchResults: function (jo, force) {
      var url = cfg.GAS_URL + "?action=results&jo=" + encodeURIComponent(jo) + (force ? "&force=1" : "");
      return getJson(url)
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || "results fetch failed");
          return j.results || [];
        });
    },
    /** 並び予想（ライン）＋競走得点の自動取得。{narabi:'147 26 35', scores:{車番:'111.72'}} */
    fetchNarabi: function (jo, race) {
      var url = cfg.GAS_URL + "?action=narabi&jo=" + encodeURIComponent(jo) + "&race=" + (+race || 0);
      return getJson(url)
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
      }).then(asJson);
    },
    /* GASは混雑時にHTMLのエラーページを返したり、ときどき落ちたりする（8/12・実測で本番が36秒や失敗）。
       1回失敗しただけで配信者の入力（予想・結果）が消えるのは配信事故なので、**自動で数回やり直す**。
       同じstateを2回書いてもrevが進むだけで害はない＝やり直して安全な操作。
       @param {number} [attempt] 内部用の試行回数 */
    /** 画面へ即座に流す（保存の完了を待たない・8/6の楽観送信をここへ独立させた）。
        revを外して送る＝受信側の「同一revはスキップ」ガードを通過させるため。

        ⚠️**保存のキューより前に呼ぶこと**（8/12）。以前は saveState の中にあったため、
          前の保存がGAS待ちで走っていると（実測で最大36秒）その間の操作は
          `savePending` に積まれるだけで**通知が出ず、出走表も展開ボードも動かなかった**。
          画面反映と保存は別物＝画面は待たせない。 */
    broadcastState: function (state) {
      var optimistic = Object.assign({}, state);
      delete optimistic.rev;
      this.broadcast({ type: "state", state: optimistic });
    },

    saveState: function (key, state, attempt) {
      var self = this;
      attempt = attempt || 0;
      return this.post({ key: key, action: "setState", state: state }).then(function (j) {
        if (!j.ok) throw new Error(j.error || "save failed");
        state.rev = j.rev;
        self.lastRev = j.rev;
        self.broadcast({ type: "state", state: state }); // rev確定版も送る
        return j.rev;
      }).catch(function (e) {
        // 鍵ちがい等の「やり直しても直らない失敗」は即座に諦める（無駄打ちで混雑を悪化させない）
        if (attempt >= SAVE_RETRY || /key|権限/i.test(e && e.message || "")) throw e;
        self.saveRetries++;
        return new Promise(function (r) { setTimeout(r, SAVE_BACKOFF_MS * (attempt + 1)); })
          .then(function () { return self.saveState(key, state, attempt + 1); });
      });
    },
    saveRetries: 0,   // やり直した回数（診断表示用）

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
