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
  // テーマ：①トーク・②レース観戦は白（w）が既定（7/30 FB10）。
  // URLの &theme=a|b|c|w が最優先＝OBS側だけで即時に戻せる保険
  var THEMES = ["a", "b", "c", "w"];
  var theme = THEMES.indexOf(params.get("theme")) >= 0
    ? params.get("theme")
    : (SCENE === "talk" || SCENE === "race" ? "w" : "a");
  document.body.setAttribute("data-theme", theme);

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
    return allRaces().filter(function (r) { return r.startSec > now; }); // 発走したら即・次レースへ
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

  /* ---------- タイマー（右レール共通）＝場別締切カード
     現行配信の締切ボードを踏襲：場ごとに次レースの 発走／民間締切／公式締切 をMM:SSでカウントダウン。
     表示中の場のカードは赤ヘッダー。発走時刻を過ぎたら即・次レースへ自動送り。
     民間締切の信号機色：残5分＝緑→残3分＝黄→残1分＝赤（締切後も赤キープ）＋切替時にピピッ音。 ---------- */
  function nextByVenue() {
    var names = state.venues.map(function (v) { return v.name; });
    if (!names.length && timetable) {
      names = (timetable.venues || []).slice(0, 2).map(function (v) { return v.name; });
    }
    var now = nowSec();
    var races = allRaces();
    return names.map(function (name) {
      var next = null;
      races.forEach(function (r) {
        if (r.venue === name && r.startSec > now && !next) next = r;
      });
      return { venue: name, race: next };
    });
  }

  /* 警告音：Web Audio合成（素材ファイル不使用＝ライセンス管理外）。
     OBSでは5シーンのソースが常時動いているため、二重発音を避けて既定は②レースのソースだけが鳴らす。
     &sound=1でどのシーンでも有効化／&sound=0で無効化。
     色切替と音ズレしないよう、コンテキストは起動時に初期化しておく（鳴らす瞬間の初期化遅延をなくす）。 */
  var SOUND = params.get("sound") === "1" || (params.get("sound") !== "0" && SCENE === "race");
  var audioCtx = null;
  if (SOUND) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }
  function beep() {
    if (!SOUND) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      var t = audioCtx.currentTime;
      [0, 0.18].forEach(function (off) { // 短音2連＝ピピッ
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.type = "square";
        o.frequency.value = 1175;
        g.gain.setValueAtTime(0.0001, t + off);
        g.gain.exponentialRampToValueAtTime(0.18, t + off + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.13);
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start(t + off);
        o.stop(t + off + 0.15);
      });
    } catch (e) { /* 音を出せない環境では無音のまま */ }
  }

  var zoneRank = { "": 0, green: 1, yellow: 2, red: 3 };
  var zones = {}; // 場名 → 現在の信号機色（切替検知・発音用）
  function zoneOf(remain) {
    if (remain <= 60) return "red";     // 締切後もキープ
    if (remain <= 180) return "yellow";
    if (remain <= 300) return "green";
    return "";
  }
  function renderTimers() {
    var cards = nextByVenue();
    var now = nowSec();
    var offSec = (state.cfg.closeMin || 3) * 60;
    // 公式締切〜発走の間は「締切ました」CTAカードに切り替える（モードもキーに含めて跨いだ瞬間に再構築）
    var keys = cards.map(function (c) {
      var closed = c.race && now >= c.race.startSec - offSec;
      return c.venue + "|" + (c.race ? c.race.no : "-") + (closed ? "C" : "");
    }).join(",");
    if (keys !== timerRowKeys) {
      timerRowKeys = keys;
      var html = cards.map(function (c) {
        var closed = c.race && now >= c.race.startSec - offSec;
        var head = '<div class="vt-head">' + esc(c.venue) +
          (c.race ? '<span class="vt-r">' + c.race.no + "R</span>" : "") +
          (closed ? '<span class="vt-start-s">発走' + c.race.start + "</span>" : "") + "</div>";
        var body;
        if (!c.race) {
          body = '<div class="vt-rows"><div class="vt-done">' + (timetable ? "本日終了" : "時刻取得中…") + "</div></div>";
        } else if (closed) {
          body = '<div class="vt-rows vt-cta">' +
            '<div class="vt-cta-main">🔔 締切ました</div>' +
            '<div class="vt-cta-line">チャンネル登録</div>' +
            '<div class="vt-cta-line">グッドボタン</div>' +
            '<div class="vt-cta-line">お願いします!!</div>' +
            "</div>";
        } else {
          body = '<div class="vt-rows">' +
            '<div class="vt-row"><span>発走</span><b>' + c.race.start + "</b></div>" +
            '<div class="vt-row"><span>民間締切</span><b data-net="' + c.race.startSec + '"></b></div>' +
            '<div class="vt-row"><span>公式締切</span><b data-off="' + c.race.startSec + '"></b></div>' +
            "</div>";
        }
        return '<li class="vt-card" data-venue="' + esc(c.venue) + '">' + head + body + "</li>";
      }).join("");
      ["timer-talk", "timer-race"].forEach(function (id) {
        var el = $(id);
        if (!el) return;
        el.innerHTML = html;
        // 場数に応じてカードをコンパクト化（3〜4場＝モーニング→昼の並走帯）
        el.className = "timer-cards vt-n" + Math.max(2, Math.min(cards.length, 4));
      });
    }
    tickTimerCounts();
  }
  function setCount(el, remain) {
    if (remain <= 0) {
      el.textContent = "締切";
      el.classList.add("closed");
    } else {
      el.textContent = fmtCount(remain);
      el.classList.remove("closed");
    }
  }
  function tickTimerCounts() {
    var now = nowSec();
    var netSec = (state.cfg.netCloseMin || 5) * 60;
    var offSec = (state.cfg.closeMin || 3) * 60;
    document.querySelectorAll("[data-net]").forEach(function (el) {
      var remain = +el.getAttribute("data-net") - netSec - now;
      setCount(el, remain);
      // 民間締切ベースの信号機色をカードに反映＋色が上がった瞬間にピピッ
      var card = el.closest(".vt-card");
      if (!card) return;
      var venue = card.getAttribute("data-venue");
      var z = zoneOf(remain);
      card.classList.remove("zone-green", "zone-yellow", "zone-red");
      if (z) card.classList.add("zone-" + z);
      var prev = zones[venue];
      zones[venue] = z;
      if (prev !== undefined && zoneRank[z] > zoneRank[prev]) beep();
    });
    document.querySelectorAll("[data-off]").forEach(function (el) {
      setCount(el, +el.getAttribute("data-off") - offSec - now);
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

  /** メンバーカラー背景に対する文字色（明るい色＝黒・暗い色＝白） */
  function textOn(hex) {
    var m = /^#?([0-9a-fA-F]{6})$/.exec(hex || "");
    if (!m) return "#fff";
    var n = parseInt(m[1], 16);
    var yiq = ((n >> 16 & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
    return yiq >= 150 ? "#16181c" : "#fff";
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
      var rp = rc && key ? window.Derive.resolvePred(state, key, rc.id) : null;
      var okLines = rp ? rp.parsed.lines.filter(function (l) { return l.ok; }) : [];
      var memos = rp ? rp.parsed.memos : [];
      var ore = rp && rp.entry.oreTachi ? rp.entry.oreTachi : "";      // 俺たち目（無料公開1点・表示専用）
      var isNote = !!(rp && rp.entry.isNote);                          // note予想（勝負レース）

      // 予想帯＝①トーク（tband-）と②レース観戦（band-）で同一様式：
      // メンバーカラーのヘッダー（〇〇予想＋noteバッジ＋投資/回収の日次累計）＋俺たち目＋買い目チップ
      ["band-", "tband-"].forEach(function (bp) {
        var bandHead = $(bp + "head-" + slot);
        if (!bandHead) return;
        var bandName = $(bp + "name-" + slot);
        if (bandName) bandName.innerHTML = esc(name) + " 予想" +
          (isNote ? '<span class="note-badge">🔥 note予想（勝負レース）</span>' : "");
        var bandInv = $(bp + "inv-" + slot);
        if (bandInv) {
          var bt = rc ? (derived.totals[rc.id] || { invest: 0, refund: 0 }) : null;
          bandInv.textContent = bt ? "投資 " + fmtYen(bt.invest) + "　回収 " + fmtYen(bt.refund) : "";
        }
        if (color) {
          bandHead.style.background = color;
          bandHead.style.color = textOn(color);
          if (bandHead.parentElement) bandHead.parentElement.style.borderColor = color;
        }
        var band = $(bp + "pred-" + slot);
        if (band) band.innerHTML =
          (ore ? '<div class="ore-row"><span class="ore-label">俺たち目</span>' + lineChips(ore) + "</div>" : "") +
          okLines.map(function (l) { return '<div class="pred-line chips">' + lineChips(l.raw) + "</div>"; }).join("") +
          (memos.length ? '<div class="buy-meta">' + esc(memos.join("　")) + "</div>" : "") +
          (rp && rp.points ? '<div class="buy-meta">合計 ' + rp.points + "点" +
            (rp.invest > 0 ? "　投資 " + fmtYen(rp.invest) : "") + "</div>" : "");
      });
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
    var key = window.Derive.raceKey(v.name, rNo);
    var scores = narabiAuto[key] ? narabiAuto[key].scores || {} : {};
    // 競走得点の1位＝赤・2位＝青（同点は同色）
    var scoreVals = [];
    race.racers.forEach(function (p) {
      var sv = parseFloat(scores[String(p.no)]);
      if (!isNaN(sv) && scoreVals.indexOf(sv) < 0) scoreVals.push(sv);
    });
    scoreVals.sort(function (a, b) { return b - a; });
    var top1 = scoreVals[0], top2 = scoreVals[1];
    el.innerHTML = race.racers.map(function (p) {
      // keirin.jp経路は期別の代わりに脚質（逃/追/両）が来る
      var sub = [p.pref, p.term ? p.term + "期" : (p.kyaku || "")].filter(Boolean).join("・");
      var sc = scores[String(p.no)] || "";
      var sv = parseFloat(sc);
      var scls = "sl-score" + (sv === top1 ? " top1" : sv === top2 ? " top2" : "");
      return '<li class="slist-row"><i class="car c' + p.no + '">' + p.no + "</i>" +
        '<span class="sl-name">' + esc(p.name) + '</span><span class="sl-sub">' + esc(sub) + "</span>" +
        (sc ? '<span class="' + scls + '">' + esc(sc) + "</span>" : "") + "</li>";
    }).join("");
    renderNarabi(v, rNo);
  }

  /** ライン（並び予想）＋競走得点＝Kドリームスから自動取得。並びは手入力があれば優先（修正用） */
  var narabiAuto = {}; // raceKey → { val, scores, pending }
  function joCodeOf(venueName) {
    var jo = null;
    if (timetable) {
      (timetable.venues || []).forEach(function (tv) { if (tv.name === venueName) jo = tv.joCode; });
    }
    return jo;
  }
  function hasRaceInfo(e) {
    return e && (e.val || (e.scores && Object.keys(e.scores).length > 0));
  }
  function ensureNarabi(v, rNo, key) {
    if (narabiAuto[key]) return;
    var jo = joCodeOf(v.name);
    if (!jo) return; // 時刻表の取得待ち
    narabiAuto[key] = { val: "", scores: {}, pending: true };
    window.Sync.fetchNarabi(jo, rNo).then(function (info) {
      narabiAuto[key] = { val: info.narabi, scores: info.scores };
      if (hasRaceInfo(narabiAuto[key])) renderStartList();
    }).catch(function () { delete narabiAuto[key]; }); // 失敗時は次の描画で再試行
  }
  function renderNarabi(v, rNo) {
    var nb = $("narabi-talk");
    if (!nb) return;
    var key = v && rNo ? window.Derive.raceKey(v.name, rNo) : null;
    var manual = key ? ((state.narabi || {})[key] || "") : "";
    // keirin.jp経路では時刻表に並び・戦型（三分戦等）が同梱されている
    var ttNarabi = "";
    var lineType = "";
    if (v && rNo && timetable) {
      (timetable.venues || []).forEach(function (tv) {
        if (tv.name !== v.name) return;
        (tv.races || []).forEach(function (r) {
          if (r.no !== +rNo) return;
          if (r.narabi) ttNarabi = r.narabi;
          if (r.lineType) lineType = r.lineType;
        });
      });
    }
    var auto = key && narabiAuto[key] ? narabiAuto[key].val : "";
    if (key && !narabiAuto[key]) ensureNarabi(v, rNo, key); // 得点＋並びの保険はエンドポイントから
    var groups = window.Keirin.normalize(manual || ttNarabi || auto).split(/[^0-9]+/).filter(Boolean);
    if (!groups.length) { nb.classList.add("hidden"); return; }
    nb.classList.remove("hidden");
    nb.innerHTML = '<span class="nb-label">ライン</span>' +
      (lineType ? '<span class="nb-type">' + esc(lineType) + "</span>" : "") +
      '<span class="nb-arrow">←</span>' +
      groups.map(function (g) {
        return '<span class="nb-group">' + g.split("").map(function (n) {
          return '<i class="car c' + n + '">' + n + "</i>";
        }).join("") + "</span>";
      }).join('<span class="nb-dot">・</span>');
  }

  /* ②レース観戦：場名/Rバーは廃止（7/29 FB4＝映像は別ウィンドウのキャプチャで
     コンソールの場情報と実映像がズレうるため）。シーン固有の描画はタイマーカードと予想帯のみ */

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

  /* ---------- 的中演出（結果入力で的中が出たら当たった配信者のワイプに表示） ----------
     状態更新のたびに的中リストを前回と比較し、増えた的中だけ発火（リロード時は再生しない）。 */
  var seenHits = null; // null＝初回未初期化
  var HIT_FX_MS = 12000;
  function checkNewHits() {
    var ids = {};
    derived.hits.forEach(function (h) { ids[h.id] = h; });
    if (seenHits === null) { seenHits = ids; return; }
    Object.keys(ids).forEach(function (id) {
      if (seenHits[id]) return;
      var h = ids[id];
      state.racers.forEach(function (rc, idx) {
        if (rc.name === h.racerName) fireHitFx(idx === 0 ? "a" : "b", h);
      });
    });
    seenHits = ids;
  }
  function fireHitFx(slot, hit) {
    ["np-talk-", "np-race-", "np-result-", "np-ad-"].forEach(function (p) {
      var el = $(p + slot);
      if (!el) return;
      var cam = el.closest(".cam");
      if (!cam) return;
      var old = cam.querySelector(".hit-fx-badge");
      if (old) old.parentNode.removeChild(old);
      var badge = document.createElement("div");
      badge.className = "hit-fx-badge" + (hit.manche ? " manche" : "");
      badge.textContent = hit.manche
        ? "💥 万車的中！" + (hit.mult ? " " + hit.mult + "倍" : "")
        : "🎯 的中！" + (hit.type ? " " + hit.type : "") + (hit.mult ? " " + hit.mult + "倍" : "");
      cam.appendChild(badge);
      cam.classList.add("hit-fx");
      setTimeout(function () {
        if (badge.parentNode) badge.parentNode.removeChild(badge);
        if (!cam.querySelector(".hit-fx-badge")) cam.classList.remove("hit-fx");
      }, HIT_FX_MS);
    });
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
    checkNewHits();
  }

  function renderAll() {
    renderVenueTabs();
    renderPreds();
    renderStartList();
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
      // 未発表で空だったライン/得点は10分ごとに再試行（GAS側にも10分のネガティブキャッシュあり）
      Object.keys(narabiAuto).forEach(function (k) {
        if (!narabiAuto[k].pending && !hasRaceInfo(narabiAuto[k])) delete narabiAuto[k];
      });
      renderTimers();
      renderBrb();
      renderStartList();
    }).catch(function () { /* 次回again */ });
  }
  loadTimetable();
  setInterval(loadTimetable, (window.APP_CONFIG.TT_POLL_MS || 600000));

  setInterval(function () {
    tickClock();
    renderTimers();     // カードセット変化時のみDOM再構築
    tickBrb();
  }, 250);              // 0.25秒刻み＝信号機色の切替と音のズレを知覚できない範囲に抑える

  tickClock();
  renderAll();
  requestAnimationFrame(buildBackdrop);
})();
