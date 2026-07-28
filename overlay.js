/* overlay.js — オーバーレイ描画エンジン
   URLパラメータ:
     ?scene=talk|race|result|brb|ad … このソースが描画するシーン（OBSのシーンごとに1ソース）
     ?theme=a|b|c                  … 配色
     ?debug=1                      … 透過穴の代わりにプレースホルダ表示＋同期状態バッジ
   データ: GAS状態（5秒ポーリング＋BroadcastChannel即時反映）＋タイムテーブル（10分毎） */

(function () {
  var params = new URLSearchParams(location.search);
  var SCENES = ["talk", "race", "result", "brb", "ad"];
  var SCENE = SCENES.indexOf(params.get("scene")) >= 0 ? params.get("scene") : "talk";
  var DEBUG = params.get("debug") === "1";

  document.body.className = "scene-" + SCENE + (DEBUG ? " debug" : "");
  if (["a", "b", "c"].indexOf(params.get("theme")) >= 0) {
    document.body.setAttribute("data-theme", params.get("theme"));
  }

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtYen(n) { return "¥" + Math.round(n).toLocaleString("ja-JP"); }
  function pad2(n) { return ("0" + n).slice(-2); }
  function todayStr() {
    var d = new Date();
    return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  var state = window.Derive.defaultState(todayStr());
  var derived = window.Derive.day(state);
  var timetable = null;
  var syncPath = "-";
  var lastSyncAt = null;
  var timerRowKeys = ""; // タイマー行の再構築判定用

  /* ---------- 時刻ユーティリティ ---------- */
  function timeToSec(hhmm) {
    var p = String(hhmm || "").split(":");
    if (p.length < 2) return null;
    return (+p[0]) * 3600 + (+p[1]) * 60;
  }
  function secToHHMM(sec) {
    sec = ((sec % 86400) + 86400) % 86400;
    return Math.floor(sec / 3600) + ":" + pad2(Math.floor(sec / 60) % 60);
  }
  function nowSec() {
    var d = new Date();
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }
  function fmtCount(sec) {
    if (sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m >= 60) return Math.floor(m / 60) + ":" + pad2(m % 60) + ":" + pad2(s);
    return pad2(m) + ":" + pad2(s);
  }

  /* ---------- タイムテーブル ---------- */
  function allRaces() {
    if (!timetable || !timetable.venues) return [];
    var out = [];
    timetable.venues.forEach(function (v) {
      (v.races || []).forEach(function (r) {
        var sec = timeToSec(r.start);
        if (sec !== null) out.push({ venue: v.name, no: r.no, start: r.start, startSec: sec });
      });
    });
    out.sort(function (a, b) { return a.startSec - b.startSec; });
    return out;
  }
  function upcoming() {
    var now = nowSec();
    return allRaces().filter(function (r) { return r.startSec + 120 > now; });
  }
  function findRace(venueName, no) {
    var hit = null;
    allRaces().forEach(function (r) { if (r.venue === venueName && r.no === +no) hit = r; });
    return hit;
  }

  /* ---------- ヘッダー ---------- */
  function renderVenueTabs() {
    var el = $("vtabs");
    el.innerHTML = state.venues.map(function (v, i) {
      var rNo = state.currentRace[v.name];
      return '<button class="vtab' + (i === state.activeVenue ? " active" : "") + '">' +
        esc(v.name) + (rNo ? "<small>" + rNo + "R</small>" : "") + "</button>";
    }).join("");
  }

  function tickClock() {
    var now = new Date();
    var days = ["日", "月", "火", "水", "木", "金", "土"];
    var d = now.getFullYear() + "/" + (now.getMonth() + 1) + "/" + now.getDate() + "（" + days[now.getDay()] + "）";
    var t = pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + ":" + pad2(now.getSeconds());
    document.querySelectorAll("[data-clock-date]").forEach(function (el) { el.textContent = d; });
    document.querySelectorAll("[data-clock-time]").forEach(function (el) { el.textContent = t; });
  }

  /* ---------- タイマー（右レール共通） ---------- */
  function renderTimers() {
    var cfg = state.cfg;
    var rows = upcoming().slice(0, cfg.timerCount || 3);
    var keys = rows.map(function (r) { return r.venue + r.no; }).join(",");
    if (keys !== timerRowKeys) {
      timerRowKeys = keys;
      var html = rows.map(function (r, i) {
        var close = secToHHMM(r.startSec - (cfg.closeMin || 5) * 60);
        return '<li class="timer-row' + (i === 0 ? " active" : "") + '">' +
          '<span class="t-venue">' + esc(r.venue) + '</span><span class="t-race">' + r.no + 'R</span>' +
          '<span class="t-times">締切 ' + close + "<br>発走 " + r.start +
          (i === 0 ? '<span class="t-count" data-count="' + r.startSec + '"></span>' : "") +
          "</span></li>";
      }).join("");
      ["timer-talk", "timer-race"].forEach(function (id) {
        var el = $(id);
        if (el) el.innerHTML = html;
      });
    }
    tickTimerCounts();
  }
  function tickTimerCounts() {
    var now = nowSec();
    var closeMin = (state.cfg.closeMin || 5) * 60;
    document.querySelectorAll(".t-count").forEach(function (el) {
      var start = +el.getAttribute("data-count");
      var close = start - closeMin;
      if (now < close) el.textContent = "締切まで " + fmtCount(close - now);
      else if (now < start) el.textContent = "発走まで " + fmtCount(start - now);
      else el.textContent = "発走中";
    });
  }

  /* ---------- 予想・投資（①トーク／②バンド） ---------- */
  function currentKey() {
    var v = state.venues[state.activeVenue];
    if (!v) return null;
    var rNo = state.currentRace[v.name];
    if (!rNo) return null;
    return window.Derive.raceKey(v.name, rNo);
  }

  /** 買い目1行を車番色チップの並びとして描画する */
  function lineChips(raw, small) {
    return window.Keirin.displayTokens(raw).map(function (tk) {
      switch (tk.t) {
        case "car": return '<i class="car ' + (small ? "sm " : "") + "c" + tk.v + '">' + tk.v + "</i>";
        case "sep": return '<span class="pl-sep">' + (tk.v === "=" ? "=" : "−") + "</span>";
        case "label": return '<span class="pl-type">' + esc(tk.v) + "</span>";
        case "all": return '<span class="pl-all">全</span>';
        case "gap": return '<span class="pl-gap"></span>';
        default: return '<span class="pl-txt">' + esc(tk.v) + "</span>";
      }
    }).join("");
  }

  function renderPreds() {
    var key = currentKey();
    ["a", "b"].forEach(function (slot, idx) {
      var rc = state.racers[idx];
      var name = rc ? rc.name : "";
      var color = rc ? window.Derive.colorOf(rc.color) : "";
      ["np-talk-", "np-race-", "np-result-", "np-ad-"].forEach(function (p) {
        var el = $(p + slot);
        if (!el) return;
        el.textContent = name;
        // チームカラー：ネームプレートのアクセントとカメラ枠線
        var plate = el.parentElement;
        if (plate && plate.classList.contains("nameplate")) {
          plate.style.borderLeftColor = color;
          var dot = plate.querySelector(".np-dot");
          if (dot) dot.style.background = color;
        }
        var cam = el.closest(".cam");
        if (cam) cam.style.borderColor = color;
      });
      var head = $("pred-head-" + slot);
      if (head) head.textContent = name + " 予想";
      var bandHead = $("band-head-" + slot);
      if (bandHead) bandHead.textContent = name + " 予想";

      var rp = rc && key ? window.Derive.resolvePred(state, key, rc.id) : null;
      var okLines = rp ? rp.parsed.lines.filter(function (l) { return l.ok; }) : [];
      var memos = rp ? rp.parsed.memos : [];
      var linesHtml = okLines.map(function (l) {
        return '<div class="pred-line chips">' + lineChips(l.raw) + "</div>";
      }).join("");
      var metaParts = [];
      if (memos.length) metaParts.push(esc(memos.join("　")));
      if (rp && rp.points) metaParts.push("合計 " + rp.points + "点");
      var metaHtml = metaParts.length ? '<div class="pred-meta">' + metaParts.join("。") + "</div>" : "";

      var body = $("pred-" + slot);
      if (body) body.innerHTML = linesHtml + metaHtml;
      var band = $("band-pred-" + slot);
      if (band) band.innerHTML =
        okLines.map(function (l) { return '<div class="buy-line-row">' + lineChips(l.raw, true) + "</div>"; }).join("") +
        (rp && rp.points ? '<div class="buy-meta">合計 ' + rp.points + "点</div>" : "");

      // 投資/回収＝日次累計（§8）
      var inv = $("invest-" + slot);
      if (inv && rc) {
        var t = derived.totals[rc.id] || { invest: 0, refund: 0 };
        var rate = t.invest > 0 ? Math.round((t.refund / t.invest) * 100) : null;
        inv.innerHTML =
          '<div class="inv-row"><span class="inv-label">投資</span><span class="inv-num">' + fmtYen(t.invest) + "</span></div>" +
          '<div class="inv-row"><span class="inv-label">回収</span><span class="inv-num">' + fmtYen(t.refund) + "</span></div>" +
          '<div class="inv-rate2' + (rate !== null && rate >= 100 ? " plus" : "") + '">' +
          (rate === null ? "" : "回収率 " + rate + "%") + "</div>";
      }
    });
  }

  /* ---------- 出走表（①トーク右下・現在の場/レースに連動） ---------- */
  function renderStartList() {
    var el = $("slist-talk");
    if (!el) return;
    var v = state.venues[state.activeVenue];
    var rNo = v ? state.currentRace[v.name] : null;
    var race = null;
    if (v && rNo && timetable) {
      (timetable.venues || []).forEach(function (tv) {
        if (tv.name !== v.name) return;
        (tv.races || []).forEach(function (r) { if (r.no === +rNo) race = r; });
      });
    }
    $("slist-sub").textContent = v && rNo
      ? v.name + " " + rNo + "R" + (race && race.cls ? "　" + race.cls : "")
      : "";
    if (!race || !race.racers || !race.racers.length) {
      el.innerHTML = '<li class="slist-empty">出走表データ取得待ち</li>';
      return;
    }
    el.innerHTML = race.racers.map(function (p) {
      var sub = [p.pref, p.term ? p.term + "期" : ""].filter(Boolean).join("・");
      return '<li class="slist-row"><i class="car c' + p.no + '">' + p.no + "</i>" +
        '<span class="sl-name">' + esc(p.name) + '</span><span class="sl-sub">' + esc(sub) + "</span></li>";
    }).join("");
    renderNarabi(v, rNo);
  }

  /** 並び（ライン）＝コンソール入力の「135 27 46」を車番チップのグループ表示に */
  function renderNarabi(v, rNo) {
    var nb = $("narabi-talk");
    if (!nb) return;
    var txt = v && rNo ? ((state.narabi || {})[window.Derive.raceKey(v.name, rNo)] || "") : "";
    var groups = window.Keirin.normalize(txt).split(/[^0-9]+/).filter(Boolean);
    if (!groups.length) { nb.classList.add("hidden"); return; }
    nb.classList.remove("hidden");
    nb.innerHTML = '<span class="nb-label">並び</span>' + groups.map(function (g) {
      return '<span class="nb-group">' + g.split("").map(function (n) {
        return '<i class="car c' + n + '">' + n + "</i>";
      }).join("") + "</span>";
    }).join("");
  }

  /* ---------- ②レース観戦 ---------- */
  function renderRaceScene() {
    var v = state.venues[state.activeVenue];
    var rNo = v ? state.currentRace[v.name] : null;
    $("video-label").textContent = v && rNo ? v.name + " " + rNo + "R" : (v ? v.name : "");
    var gradeText = v ? (state.grade[v.name] || "") : "";
    $("vf-grade").textContent = gradeText;
    $("vf-grade").style.display = gradeText ? "" : "none"; // 空のバッジ枠を残さない
    var race = v && rNo ? findRace(v.name, rNo) : null;
    $("vf-start").textContent = race ? "発走 " + race.start : "";
    if (race) {
      var net = secToHHMM(race.startSec - (state.cfg.netCloseMin || 15) * 60);
      var close = secToHHMM(race.startSec - (state.cfg.closeMin || 5) * 60);
      $("vf-shime").textContent = "ネット投票締切 " + net + " ／ 公式締切 " + close;
      $("vf-count").setAttribute("data-start", race.startSec);
    } else {
      $("vf-shime").textContent = "";
      $("vf-count").removeAttribute("data-start");
      $("vf-count-label").textContent = "";
      $("vf-count").textContent = "";
    }
    tickRaceCount();
  }
  function tickRaceCount() {
    var el = $("vf-count");
    if (!el || !el.getAttribute("data-start")) return;
    var start = +el.getAttribute("data-start");
    var close = start - (state.cfg.closeMin || 5) * 60;
    var now = nowSec();
    if (now < close) { $("vf-count-label").textContent = "締切まで"; el.textContent = fmtCount(close - now); }
    else if (now < start) { $("vf-count-label").textContent = "発走まで"; el.textContent = fmtCount(start - now); }
    else { $("vf-count-label").textContent = ""; el.textContent = "発走中"; }
  }

  /* ---------- ③結果・的中 ---------- */
  function renderResultScene() {
    var chips = derived.chips;
    var viewKey = state.resultView;
    if (!viewKey || !state.results[viewKey]) viewKey = chips.length ? chips[chips.length - 1].key : null;

    $("race-chips-body").innerHTML = chips.map(function (c) {
      return '<span class="rchip' + (c.key === viewKey ? " active" : "") + '">' +
        (c.hit ? "🎯 " : "") + esc(c.label) + "</span>";
    }).join("");

    var badge = $("hit-badge");
    if (!viewKey) {
      $("result-title").textContent = "レース結果";
      $("result-rows").innerHTML = "";
      $("payout-grid").innerHTML = "";
      badge.classList.add("hidden");
    } else {
      var parts = viewKey.split("|");
      var r = state.results[viewKey];
      $("result-title").textContent = "レース結果　" + parts[0] + " " + parts[1] + "R";
      var posLabel = ["1着", "2着", "3着"];
      $("result-rows").innerHTML = (r.order || []).slice(0, 3).map(function (car, i) {
        var name = (r.names && r.names[i]) ? r.names[i] : car + "番車";
        var kim = (r.kimarite && r.kimarite[i]) ? r.kimarite[i] : "";
        return '<div class="result-row"><span class="pos">' + posLabel[i] + '</span><i class="car c' + car + '">' + car + "</i>" +
          '<span class="r-name">' + esc(name) + '</span><span class="r-kim">' + esc(kim) + "</span></div>";
      }).join("");
      $("payout-grid").innerHTML = (r.payouts || []).filter(function (p) { return p.amount > 0; })
        .slice(0, 8).map(function (p) {
          return "<div><span>" + esc(p.type) + " " + esc(window.Keirin.comboLabel(p.type, p.combo)) + "</span><b>" + fmtYen(p.amount) + "</b></div>";
        }).join("");

      // 的中バッジ：表示中レースの最高倍率の的中
      var raceLabel = parts[0] + parts[1] + "R";
      var best = null;
      derived.hits.forEach(function (h) {
        if (h.place === raceLabel && (!best || h.mult > best.mult)) best = h;
      });
      if (best) {
        badge.classList.remove("hidden");
        $("hit-main").textContent = "🎯 予想的中！";
        $("hit-sub").textContent = best.racerName + " " + best.type + " " + best.mult + "倍（無料公開）";
      } else {
        badge.classList.add("hidden");
      }
    }
    renderTicker();
  }

  function renderTicker() {
    var items = derived.hits.slice().reverse().map(function (h) { // 古い順に流す
      if (h.manche && h.amount) {
        return '<span class="tick-manche">💥 万車速報：' + esc(h.place) + " " + esc(h.type) + " " + fmtYen(h.amount) + "</span>";
      }
      return "<span>🎯 " + esc(h.racerName) + " " + esc(h.place) + " " + esc(h.type) + " " + h.mult + "倍 的中</span>";
    }).join("");
    var copy = '<div class="tick-copy">' + items + "</div>";
    // ③結果と①トークの両方のティッカーに同じ内容を流す（的中ゼロでもバーは常時表示）
    [["ticker", "ticker-result"], ["ticker-talk-wrap", "ticker-talk"]].forEach(function (pair) {
      var wrap = $(pair[0]);
      var el = $(pair[1]);
      if (!wrap || !el) return;
      wrap.classList.remove("hidden");
      if (!derived.hits.length) {
        el.classList.add("static");
        el.innerHTML = "<span>🎯 的中速報｜本日の的中はここに流れます</span>";
        return;
      }
      el.classList.remove("static");
      el.innerHTML = copy + copy; // 同一コピー2つ＋半幅移動で継ぎ目なしループ
    });
  }

  /* ---------- ④待機 ---------- */
  function renderBrb() {
    $("brb-msg").textContent = state.brbMsg || "まもなく再開します";
    var rows = upcoming().slice(0, 3);
    var next = rows[0];
    $("brb-next").innerHTML = next
      ? "NEXT&nbsp;" + esc(next.venue) + " " + next.no + 'R<span class="brb-count" data-count="' + next.startSec + '"></span>'
      : "本日の全レース終了";
    $("brb-list").innerHTML = rows.map(function (r) {
      return "<li><span>" + r.start + "</span>" + esc(r.venue) + " " + r.no + "R</li>";
    }).join("");
    tickBrb();
  }
  function tickBrb() {
    var el = document.querySelector(".brb-count[data-count]");
    if (!el) return;
    var start = +el.getAttribute("data-count");
    var now = nowSec();
    el.textContent = now < start
      ? "発走 " + secToHHMM(start) + "（あと " + fmtCount(start - now) + "）"
      : "発走 " + secToHHMM(start);
  }

  /* ---------- ⑤広告 ---------- */
  function renderAd() {
    var ad = state.ad || {};
    $("ad-title").textContent = ad.title || "";
    $("ad-list").innerHTML = (ad.lines || []).map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("");
    var prog = $("ad-progress");
    if (ad.showProgress && ad.max > 0) {
      prog.classList.remove("hidden");
      $("ad-goal").textContent = ad.goalLabel || "応募状況";
      $("ad-bar-fill").style.width = Math.min(100, Math.round((ad.cur / ad.max) * 100)) + "%";
      var unit = ad.unit || "";
      $("ad-nums").textContent = "現在 " + ad.cur + unit + " ／ 目標 " + ad.max + unit;
    } else {
      prog.classList.add("hidden");
    }
  }

  /* ---------- 背景（透過穴つき） ---------- */
  function buildBackdrop() {
    var svg = $("backdrop");
    var cs = getComputedStyle(document.body);
    var bg1 = cs.getPropertyValue("--bg1").trim();
    var bg2 = cs.getPropertyValue("--bg2").trim();
    var holes = [];
    if (!DEBUG) {
      var stageRect = $("stage").getBoundingClientRect();
      document.querySelectorAll("#scene-" + SCENE + " [data-hole]").forEach(function (el) {
        var r = el.getBoundingClientRect();
        holes.push({
          x: r.left - stageRect.left, y: r.top - stageRect.top,
          w: r.width, h: r.height,
        });
      });
    }
    var d = "M0 0H1920V1080H0Z" + holes.map(function (h) {
      return "M" + h.x + " " + h.y + "h" + h.w + "v" + h.h + "h-" + h.w + "Z";
    }).join("");
    svg.innerHTML =
      '<defs><radialGradient id="bgGrad" cx="30%" cy="20%" r="80%">' +
      '<stop offset="0%" stop-color="' + bg2 + '"/><stop offset="100%" stop-color="' + bg1 + '"/>' +
      "</radialGradient></defs>" +
      '<path d="' + d + '" fill="url(#bgGrad)" fill-rule="evenodd"/>';
  }

  /* ---------- 状態反映 ---------- */
  function applyState(s, path) {
    if (!s) return;
    if (s.rev && s.rev === state.rev) return;
    var base = window.Derive.defaultState(todayStr());
    var merged = Object.assign({}, base, s);
    merged.cfg = Object.assign({}, base.cfg, s.cfg || {});
    merged.ad = Object.assign({}, base.ad, s.ad || {});
    state = window.Derive.normalizeState(merged);
    derived = window.Derive.day(state);
    syncPath = path;
    lastSyncAt = new Date();
    renderAll();
  }

  function renderAll() {
    renderVenueTabs();
    renderPreds();
    renderStartList();
    renderRaceScene();
    renderResultScene();
    renderBrb();
    renderAd();
    renderTimers();
    renderDbg();
  }

  function renderDbg() {
    if (!DEBUG) return;
    $("dbg").textContent = "scene:" + SCENE + "｜rev " + state.rev +
      "｜経路 " + syncPath + "｜BC " + (window.Sync.bcAlive ? "alive" : "-") +
      (lastSyncAt ? "｜" + pad2(lastSyncAt.getHours()) + ":" + pad2(lastSyncAt.getMinutes()) + ":" + pad2(lastSyncAt.getSeconds()) : "");
  }

  /* ---------- 起動 ---------- */
  window.Sync.initChannel(function (msg) {
    if (msg.type === "state") applyState(msg.state, "BC");
    renderDbg();
  });
  window.Sync.startPolling(function (s) { applyState(s, "poll"); });

  function loadTimetable() {
    window.Sync.fetchTimetable(0).then(function (t) {
      timetable = t;
      timerRowKeys = ""; // 行再構築
      renderTimers();
      renderRaceScene();
      renderBrb();
      renderStartList();
    }).catch(function () { /* 次回again */ });
  }
  loadTimetable();
  setInterval(loadTimetable, (window.APP_CONFIG.TT_POLL_MS || 600000));

  setInterval(function () {
    tickClock();
    renderTimers();     // 行セット変化時のみDOM再構築
    tickRaceCount();
    tickBrb();
  }, 1000);

  tickClock();
  renderAll();
  requestAnimationFrame(buildBackdrop);
})();
