/* overlay.js — オーバーレイ描画エンジン
   URLパラメータ:
     ?scene=talk|race|result|brb|ad … このソースが描画するシーン（OBSのシーンごとに1ソース）
     ?theme=a|b|c                  … 配色
     ?debug=1                      … 透過穴の代わりにプレースホルダ表示＋同期状態バッジ
     ?wm=0                         … ヘッダー帯のCTC透かしを非表示（既定＝表示・8/6反転。CTC承認NGなら&wm=0で消す）
   データ: GAS状態（5秒ポーリング＋BroadcastChannel即時反映）＋タイムテーブル（10分毎） */

(function () {
  var params = new URLSearchParams(location.search);
  var SCENES = ["talk", "race", "result", "brb", "ad"];
  var SCENE = SCENES.indexOf(params.get("scene")) >= 0 ? params.get("scene") : "talk";
  var DEBUG = params.get("debug") === "1";

  document.body.className = "scene-" + SCENE + (DEBUG ? " debug" : "") +
    (params.get("wm") === "0" ? "" : " wm-on"); // CTC透かし＝既定ON（8/6）・&wm=0で非表示
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
        esc(v.name) + (rNo ? "<small>" + rNo + "R</small>" : "") + gradeBadge(v.name) + "</button>";
    }).join("");
  }

  function tickClock() {
    var now = new Date();
    var days = ["日", "月", "火", "水", "木", "金", "土"];
    var d = now.getFullYear() + "/" + (now.getMonth() + 1) + "/" + now.getDate() + "（" + days[now.getDay()] + "）";
    var t = pad2(now.getHours()) + ":" + pad2(now.getMinutes()); // 秒は出さない（8/5 FB）
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
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // 無音キープアライブ＝出力ストリームを開きっぱなしにする（初音の出力遅延・suspend復帰遅延の対策・8/6 FB6）
      var kaG = audioCtx.createGain(); kaG.gain.value = 0;
      var kaO = audioCtx.createOscillator(); kaO.frequency.value = 40;
      kaO.connect(kaG); kaG.connect(audioCtx.destination); kaO.start();
      setInterval(function () { if (audioCtx.state === "suspended") audioCtx.resume(); }, 1000);
    } catch (e) {}
  }
  function beepAt(atTime) {
    if (!SOUND) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      var t = Math.max(atTime || 0, audioCtx.currentTime);
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
  /* 色切替と音のズレ対策（8/6 FB6）：境界の実時刻にサンプル精度で事前予約する。
     キー＝「民間締切の絶対秒|境界秒」＝レースごと・境界ごとに1回だけ（即時フォールバックとの二重鳴り防止） */
  var beepDone = {};
  function scheduleBeep(key, delaySec) {
    if (beepDone[key]) return;
    beepDone[key] = true;
    beepAt(audioCtx ? audioCtx.currentTime + Math.max(0, delaySec) : 0);
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
          (c.race ? '<span class="vt-r">' + c.race.no + "R</span>" : "") + "</div>";
        var body;
        if (!c.race) {
          body = '<div class="vt-rows"><div class="vt-done">' + (timetable ? "本日終了" : "時刻取得中…") + "</div></div>";
        } else if (closed) {
          // 発走時刻はヘッダーの小さい表示をやめ、CTA本文に大きく出す（8/6 FB10）
          body = '<div class="vt-rows vt-cta">' +
            '<div class="vt-cta-main">🔔 締切ました</div>' +
            '<div class="vt-cta-start">発走 ' + c.race.start + "</div>" +
            '<div class="vt-cta-line"><span class="vt-nb">チャンネル登録</span>・<span class="vt-nb">グッドボタン</span></div>' +
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
      var tgt = +el.getAttribute("data-net") - netSec; // 民間締切の絶対秒
      var remain = tgt - now;
      setCount(el, remain);
      // 民間締切ベースの信号機色をカードに反映＋色が上がる瞬間にピピッ。
      // 色・音とも小数秒で判定（旧＝秒切り捨てで色が最大1秒先行し音が後追いだった・8/6 FB6）
      var card = el.closest(".vt-card");
      if (!card) return;
      var venue = card.getAttribute("data-venue");
      // ⚠️時刻基準はnowSec()と同じ「0時からの経過秒」（エポック秒を使うと全カード赤の事故＝8/6実発生）
      var dd = new Date();
      var nowF = dd.getHours() * 3600 + dd.getMinutes() * 60 + dd.getSeconds() + dd.getMilliseconds() / 1000;
      var remainF = tgt - nowF;
      var z = zoneOf(remainF);
      card.classList.remove("zone-green", "zone-yellow", "zone-red");
      if (z) card.classList.add("zone-" + z);
      // 音＝2.5秒以内に来る境界をWeb Audioへ事前予約（tick間隔の量子化ズレなし）
      [300, 180, 60].forEach(function (b) {
        var d = remainF - b;
        if (d > 0 && d <= 2.5) scheduleBeep(tgt + "|" + b, d);
      });
      var prev = zones[venue];
      zones[venue] = z;
      if (prev !== undefined && zoneRank[z] > zoneRank[prev]) {
        // 予約が間に合わなかった時だけの即時フォールバック（予約済みならbeepDoneで抑止される）
        scheduleBeep(tgt + "|" + ({ green: 300, yellow: 180, red: 60 }[z] || 0), 0);
      }
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

  /* 席割り：racers[].seat（"a"=席1左／"b"=席2右）優先・seatの無い旧データはインデックス順 */
  function seatMap() {
    var m = { a: null, b: null };
    (state.racers || []).forEach(function (rc, i) {
      var s = (rc.seat === "a" || rc.seat === "b") ? rc.seat : (i === 0 ? "a" : "b");
      if (!m[s]) m[s] = rc;
    });
    return m;
  }

  function keyLabel(k) { return k ? String(k).replace("|", " ") + "R" : ""; }

  /** グレードバッジ（8/6 FB36）：場のグレード文字列からGP/GⅠ〜GⅢを検出（F級は非表示）。
      GP=金・GⅠ=赤・GⅡ=青・GⅢ=緑。サイズは.72em＝置き場所の文字サイズに追従 */
  function gradeBadge(venueName) {
    var g = String((state.grade || {})[venueName] || "")
      .replace(/Ⅰ/g, "1").replace(/Ⅱ/g, "2").replace(/Ⅲ/g, "3").toUpperCase();
    var cls = /GP|グランプリ/.test(g) ? "gp" : /G\s*1/.test(g) ? "g1" : /G\s*2/.test(g) ? "g2" : /G\s*3/.test(g) ? "g3" : null;
    if (!cls) return "";
    return '<span class="grade-badge ' + cls + '">' + { gp: "GP", g1: "GⅠ", g2: "GⅡ", g3: "GⅢ" }[cls] + "</span>";
  }

  /** レースキー→発走秒（0時起点）。※note予想の締切連動公開（FB22〜24）は不具合のためFB39で撤去
      ＝note予想も保存即表示。ラベルの🔥note予想表記は存続 */
  function raceStartSecOf(key) {
    if (!key || !timetable) return null;
    var parts = String(key).split("|");
    var sec = null;
    (timetable.venues || []).forEach(function (tv) {
      if (tv.name !== parts[0]) return;
      (tv.races || []).forEach(function (r) {
        if (r.no === +parts[1]) { var s = timeToSec(r.start); if (s !== null) sec = s; }
      });
    });
    return sec;
  }

  /** 1配信者×1レースの買い目ブロック（俺たち目・買い目行・メモ・合計）。small=2レース表示用の縮小チップ。
      noMeta=true＝合計/投資行を出さない（②は右下の固定枠band-metaに分離・8/6 FB57） */
  function raceBuyHtml(rc, k, small, noMeta) {
    var rp = rc && k ? window.Derive.resolvePred(state, k, rc.id) : null;
    var okLines = rp ? rp.parsed.lines.filter(function (l) { return l.ok && !l.allDup; }) : [];
    var memos = rp ? rp.parsed.memos : [];
    var ore = rp && rp.entry.oreTachi ? rp.entry.oreTachi : "";
    // 合計・投資の行：買い目が無くても投資額が入っていれば表示する（メモだけの運用対応・8/6）
    var metaLine = "";
    if (!noMeta && rp && (rp.points || rp.invest > 0)) {
      // 合計と投資はパーツ化：トーク・②メインは1行（gapで従来どおり）・サブは縦2行（8/6 FB15）
      metaLine = '<div class="buy-meta">' +
        (rp.points ? '<span class="bm-part">合計 ' + rp.points + "点</span>" : "") +
        (rp.invest > 0 ? '<span class="bm-part">投資 ' + fmtYen(rp.invest) + "</span>" : "") +
        "</div>";
    }
    return (ore ? '<div class="ore-row"><span class="ore-label">俺たち目</span>' + lineChips(ore, small) + "</div>" : "") +
      okLines.map(function (l) { return '<div class="pred-line chips">' + lineChips(l.disp || l.raw, small) + "</div>"; }).join("") +
      (memos.length ? '<div class="buy-meta">' + esc(memos.join("　")) + "</div>" : "") +
      metaLine;
  }

  /** 予想帯ヘッダーのはみ出し防止（8/6 FB）：投資/回収の金額とnoteバッジを段階的に縮小して1行に収める */
  function fitBandHead(headEl) {
    var inv = headEl.querySelector(".band-inv");
    var badge = headEl.querySelector(".note-badge");
    [inv, badge].forEach(function (el) { if (el) el.style.fontSize = ""; });
    var guard = 0;
    while (headEl.scrollWidth > headEl.clientWidth + 1 && guard < 8) {
      var shrunk = false;
      [inv, badge].forEach(function (el) {
        if (!el) return;
        var cur = parseFloat(getComputedStyle(el).fontSize);
        if (cur > 11) { el.style.fontSize = (cur - 2) + "px"; shrunk = true; }
      });
      if (!shrunk) break;
      guard++;
    }
  }

  /** 買い目行のはみ出し自動縮小（8/6）：折り返す代わりに、枠幅に収まる倍率へスケールする */
  function fitPredLines(scope) {
    if (!scope) return;
    scope.querySelectorAll(".pred-line.chips").forEach(function (el) {
      el.style.transform = "";
      var parent = el.parentElement;
      if (!parent) return;
      var cs = getComputedStyle(parent);
      var avail = parent.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      var w = el.scrollWidth;
      if (w > avail && avail > 0) {
        el.style.transform = "scale(" + Math.max(0.4, avail / w) + ")";
        el.style.transformOrigin = "left center";
      }
    });
  }

  /** トーク帯の再フィット一括（8/6 FB32）：描画直後は高さ確定前に測って縮小が発動しないことがある
      （見切れ残り事故2件の恒久対策）→renderPreds直後のrAF/300ms再測定＋毎秒の巡回で自己修復する */
  function fitTalkBands() {
    ["tband-pred-a", "tband-pred-b"].forEach(function (id) {
      var band = $(id);
      if (band) { fitPredLines(band); fitRaceCols(band); }
    });
  }

  /** ②サブ予想の行フィット（8/6 FB14）：買い目・俺たち目・合計行を折り返さず幅ぴったりに縮める */
  function fitSubRows(scope) {
    if (!scope) return;
    var cs = getComputedStyle(scope);
    var avail = scope.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    scope.querySelectorAll(".pred-line, .ore-row, .buy-meta, .race-col-head").forEach(function (el) {
      el.style.transform = "";
      var w = el.scrollWidth;
      if (avail > 0 && w > avail + 1) {
        el.style.transform = "scale(" + Math.max(0.4, avail / w) + ")";
        el.style.transformOrigin = "left center";
      }
    });
  }

  /** ②予想帯の必要サイズ測定（8/6 FB27）：⚠️column-wrapのflexはscrollWidth/Heightがあふれを報告しない
      ことがある（3列切れの実バグ）→子要素の実右端・下端座標で測る */
  function bandNeed(band) {
    var br = band.getBoundingClientRect();
    var cs = getComputedStyle(band);
    var padR = parseFloat(cs.paddingRight) || 0;
    var padB = parseFloat(cs.paddingBottom) || 0;
    var maxRight = br.left, maxBottom = br.top;
    for (var i = 0; i < band.children.length; i++) {
      var r = band.children[i].getBoundingClientRect();
      if (r.right > maxRight) maxRight = r.right;
      if (r.bottom > maxBottom) maxBottom = r.bottom;
    }
    return { need: maxRight - br.left, avail: br.width - padR,
             needH: maxBottom - br.top, availH: br.height - padB };
  }

  /** ②予想帯の横あふれ自動縮小（8/6 FB12）：サイズ段階を落としても収まらない時の最終手段 */
  function fitRaceBand(band) {
    if (!band) return;
    band.style.transform = "";
    if (band.clientWidth <= 0) return;
    var m = bandNeed(band);
    if (m.need > m.avail + 1) {
      band.style.transform = "scale(" + Math.max(0.35, m.avail / m.need) + ")";
      band.style.transformOrigin = "left top";
    }
  }

  /** ②予想帯のサイズ段階フィット一式（8/6 FB37）：常に特大→大→標準の順で試し「入る最大サイズ」を採用
      （行数からの決め打ちを廃止＝縦横を使い切る）。標準でもあふれる時だけ全体縮小。冪等＝毎秒巡回可。
      FB38：収まった後の余白は、折返し計算に影響しないtransform拡大で枠いっぱいまで使う（上限1.6倍） */
  function fitRaceBandFull(band) {
    var sizes = ["buy-xl", "buy-lg", ""];
    var fitted = false;
    for (var si = 0; si < sizes.length; si++) {
      band.classList.remove("buy-xl", "buy-lg");
      if (sizes[si]) band.classList.add(sizes[si]);
      fitPredLines(band);
      band.style.transform = "";
      var bm = bandNeed(band);
      if (bm.need <= bm.avail + 1) { fitted = true; break; }
    }
    if (!fitted) { fitRaceBand(band); }
    else {
      var m = bandNeed(band);
      var up = Math.min(m.avail / Math.max(1, m.need), m.availH / Math.max(1, m.needH));
      if (up > 1.02) {
        band.style.transform = "scale(" + Math.min(1.6, up).toFixed(3) + ")";
        band.style.transformOrigin = "left top";
      }
    }
    // 最終検証（8/6 FB50）：拡大縮小の適用後、実際の描画位置がパネル外に出ていないかを直接確認し、
    // はみ出しが消えるまで段階的に縮める＝測定と実描画の食い違いがどんな原因でも結果を保証する
    var cur = parseFloat((String(band.style.transform).match(/scale\(([\d.]+)\)/) || [])[1]) || 1;
    for (var guard = 0; guard < 8 && bandSticksOut(band); guard++) {
      cur = Math.max(0.35, cur * 0.9);
      band.style.transform = "scale(" + cur.toFixed(3) + ")";
      band.style.transformOrigin = "left top";
      if (cur <= 0.35) break;
    }
  }
  /** 帯の子要素が親パネルの外に描画されていないか（transform込みの実座標で判定・8/6 FB50） */
  function bandSticksOut(band) {
    var host = band.parentElement ? band.parentElement.getBoundingClientRect() : null;
    if (!host || host.width <= 0) return false;
    for (var i = 0; i < band.children.length; i++) {
      var r = band.children[i].getBoundingClientRect();
      if (r.right > host.right + 1 || r.bottom > host.bottom + 1) return true;
    }
    return false;
  }
  function fitRaceBands() {
    ["band-pred-a", "band-pred-b"].forEach(function (id) {
      var band = $(id);
      if (band && band.clientWidth > 0) fitRbScale(band);
    });
  }

  /** ②買い目の自前パッキング（8/6 FB51→FB58で厳密化）：行順を保った連続分割（最大5列）を総当たりし、
      「枠からはみ出さない・1行は折り返さない」の制約下で最も大きく拡大できる割り方を厳密に選ぶ。
      高さは全列とも帯の底まで使い（旧・全列一律の下48px予約は廃止）、右下固定の合計/投資とは
      列ごとの実座標で衝突判定＝右下に届く列だけが避ける。場Rラベル・メモ行には列幅の決定権を
      持たせない（チップ行より幅広なら行側を列幅へ縮小）。renderPredsのたびに再構成する */
  function packRaceBand(band) {
    var rows = Array.prototype.slice.call(band.children);
    if (!rows.length) return;
    var cs = getComputedStyle(band);
    var padL = parseFloat(cs.paddingLeft) || 0, padT = parseFloat(cs.paddingTop) || 0;
    var availW = band.clientWidth - padL - (parseFloat(cs.paddingRight) || 0);
    var availH = band.clientHeight - padT - (parseFloat(cs.paddingBottom) || 0);
    if (availW <= 0 || availH <= 0) return;
    // 測定は本番と同じ入れ物（rb-col）で行う＝親コンテナのalign-items差で行幅が狂わない
    var flow = document.createElement("div");
    flow.className = "rb-flow";
    var mcol = document.createElement("div");
    mcol.className = "rb-col";
    rows.forEach(function (el) { el.style.width = ""; el.style.transform = ""; mcol.appendChild(el); });
    flow.appendChild(mcol);
    band.innerHTML = "";
    band.appendChild(flow);
    var hs = rows.map(function (el) { return el.offsetHeight; });
    var ws = rows.map(function (el) { return el.offsetWidth; });
    // チップ行（俺たち目・買い目）だけが列幅を決める
    var hard = rows.map(function (el) {
      return el.classList.contains("ore-row") || el.classList.contains("pred-line");
    });
    var hasPred = false;
    hard.forEach(function (v) { if (v) hasPred = true; });
    var ROWGAP = 5, COLGAP = 40, MARGIN = 6; // gapはCSSの.rb-col/.rb-flowと一致させること
    var CAP = hasPred ? 3.0 : 1.5;           // ラベルだけの帯は控えめに留める
    // 右下固定の合計/投資：表示中なら帯コンテンツ原点からの左端・上端（renderPredsが先にmetaを確定させる前提）
    var metaL = Infinity, metaT = Infinity;
    var meta = band.parentElement ? band.parentElement.querySelector(".band-meta") : null;
    if (meta && !meta.classList.contains("hidden")) {
      var br = band.getBoundingClientRect(), mr = meta.getBoundingClientRect();
      if (mr.width > 0) { metaL = mr.left - br.left - padL - MARGIN; metaT = mr.top - br.top - padT - MARGIN; }
    }
    function colWidth(idx) {
      var w = 0, wAny = 0;
      idx.forEach(function (i) { if (ws[i] > wAny) wAny = ws[i]; if (hard[i] && ws[i] > w) w = ws[i]; });
      return w || wAny; // チップ行のない列（ラベルだけ等）は行の実幅
    }
    function evalCols(cols) {
      var k = CAP, sumW = COLGAP * (cols.length - 1), x = 0, i, j;
      var cw = [], ch = [];
      for (i = 0; i < cols.length; i++) {
        cw[i] = colWidth(cols[i]);
        var s = 0;
        for (j = 0; j < cols[i].length; j++) s += hs[cols[i][j]];
        ch[i] = s + ROWGAP * (cols[i].length - 1);
        sumW += cw[i];
      }
      if (sumW > 0) k = Math.min(k, availW / sumW);
      for (i = 0; i < cols.length; i++) {
        if (ch[i] > 0) k = Math.min(k, availH / ch[i]);
        var right = x + cw[i];
        // 合計/投資とは「横で手前に収まる」か「縦で上に収まる」のどちらかを満たせば重ならない
        if (right > 0 && ch[i] > 0) k = Math.min(k, Math.max(metaL / right, metaT / ch[i]));
        x = right + COLGAP;
      }
      return k;
    }
    var best = null;
    var maxCols = Math.min(5, rows.length);
    (function rec(start, cols) {
      for (var end = start + 1; end <= rows.length; end++) {
        var idx = [];
        for (var i = start; i < end; i++) idx.push(i);
        cols.push(idx);
        if (end === rows.length) {
          var k = evalCols(cols);
          if (!best || k > best.k) best = { k: k, cols: cols.map(function (c) { return c.slice(); }) };
        } else if (cols.length < maxCols) {
          rec(end, cols);
        }
        cols.pop();
      }
    })(0, []);
    // 診断フック（body.debug系と同趣旨・通常は不発）：パッキングの入力と採用解を記録
    if (window.__RB_DEBUG) window.__RB_DEBUG.push({ availW: availW, availH: availH, metaL: metaL, metaT: metaT,
      hs: hs, ws: ws, hard: hard, bestK: best.k, cols: best.cols });
    best.cols.forEach(function (idx) {
      var col = document.createElement("div");
      col.className = "rb-col";
      var cw = colWidth(idx);
      idx.forEach(function (i) {
        // ラベル・メモ行がチップ行より幅広なら列幅に縮めて格納（列を太らせない）
        if (!hard[i] && ws[i] > cw + 1) {
          rows[i].style.width = cw + "px";
          rows[i].style.transform = "scale(" + Math.max(0.4, cw / ws[i]).toFixed(3) + ")";
          rows[i].style.transformOrigin = "left center";
        }
        col.appendChild(rows[i]);
      });
      flow.appendChild(col);
    });
    flow.removeChild(mcol);
    var k2 = Math.max(0.35, best.k * 0.97); // 3%マージン（丸め・フォント描画ゆらぎの吸収）
    if (k2 < 0.995 || k2 > 1.02) {
      flow.style.transform = "scale(" + k2.toFixed(3) + ")";
      flow.style.transformOrigin = "left top";
    }
    fitRbScale(band); // 実描画ベースの最終検証（はみ出し・合計/投資への重なりが残れば縮める）
  }

  /** パッキング後の実描画検証（8/6 FB51→FB58）：パネル外へのはみ出しと、右下固定の合計/投資への
      列の重なりを実座標で検査し、残っていれば収まる倍率へ補正（縮小のみ）。毎秒巡回でも実行 */
  function fitRbScale(band) {
    var flow = band.querySelector(".rb-flow");
    if (!flow || !band.parentElement) return;
    var host = band.parentElement.getBoundingClientRect();
    if (host.width <= 0) return;
    var fr = flow.getBoundingClientRect();
    var overW = fr.right - (host.right - 8);
    var overH = fr.bottom - (host.bottom - 4);
    var meta = band.parentElement.querySelector(".band-meta");
    if (meta && !meta.classList.contains("hidden")) {
      var mr = meta.getBoundingClientRect();
      if (mr.width > 0) {
        for (var i = 0; i < flow.children.length; i++) {
          var cr = flow.children[i].getBoundingClientRect();
          if (cr.right > mr.left + 2 && cr.bottom > mr.top + 2) {
            overH = Math.max(overH, cr.bottom - mr.top);
          }
        }
      }
    }
    if (overW <= 1 && overH <= 1) return;
    var cur = parseFloat((String(flow.style.transform).match(/scale\(([\d.]+)\)/) || [])[1]) || 1;
    var fixW = overW > 1 ? (fr.width - overW) / fr.width : 1;
    var fixH = overH > 1 ? (fr.height - overH) / fr.height : 1;
    var k = Math.max(0.35, cur * Math.min(fixW, fixH));
    flow.style.transform = "scale(" + k.toFixed(3) + ")";
    flow.style.transformOrigin = "left top";
  }

  /** 1列ぶんの箱フィット（8/6 FB9→FB41で双方向化）：はみ出しは縮小（下限0.35）・余白は改行なしの
      まま拡大（上限1.6倍・レースラベルだけの空列は拡大しない）。子要素の実座標で測る
      （⚠️scrollWidth/Heightはflexであふれを報告しないことがある＝FB27/28実バグ） */
  function fitColBox(col) {
    col.style.transform = "";
    var cr = col.getBoundingClientRect();
    if (cr.height <= 0) return;
    var cs = getComputedStyle(col);
    var padR = parseFloat(cs.paddingRight) || 0;
    var padB = parseFloat(cs.paddingBottom) || 0;
    var maxRight = cr.left, maxBottom = cr.top;
    for (var i = 0; i < col.children.length; i++) {
      var r = col.children[i].getBoundingClientRect();
      if (r.right > maxRight) maxRight = r.right;
      if (r.bottom > maxBottom) maxBottom = r.bottom;
    }
    var needW = maxRight - cr.left, needH = maxBottom - cr.top;
    if (needW <= 0 || needH <= 0) return;
    var k = Math.min((cr.width - padR) / needW, (cr.height - padB) / needH);
    if (k < 1) {
      col.style.transform = "scale(" + Math.max(0.35, k).toFixed(3) + ")";
    } else if (k > 1.02 && col.children.length > 1) {
      col.style.transform = "scale(" + Math.min(1.6, k).toFixed(3) + ")";
    }
    if (col.style.transform) col.style.transformOrigin = "left top";
  }
  function fitRaceCols(scope) {
    if (!scope) return;
    var cols = scope.querySelectorAll(".race-col");
    if (cols.length) {
      for (var i = 0; i < cols.length; i++) fitColBox(cols[i]);
    } else {
      fitColBox(scope); // 1場表示＝帯そのものを1つの箱として扱う
    }
  }

  /** 予想ブロックの表示行数（3場の自動配置用・8/6 FB33）＝俺たち目＋有効買い目＋メモ＋合計 */
  function predRowCount(rc, k) {
    var rp = rc && k ? window.Derive.resolvePred(state, k, rc.id) : null;
    if (!rp) return 0;
    var lines = rp.parsed.lines.filter(function (l) { return l.ok && !l.allDup; }).length;
    return (rp.entry.oreTachi ? 1 : 0) + lines + (rp.parsed.memos.length ? 1 : 0) +
      ((rp.points || rp.invest > 0) ? 1 : 0);
  }

  /** 2レース表示の列見出し（場名R＋そのレースがnote予想なら🔥note予想） */
  function raceColHead(rc, k) {
    var p = rc && k ? window.Derive.resolvePred(state, k, rc.id) : null;
    return '<div class="race-col-head">' + esc(keyLabel(k)) +
      (k ? gradeBadge(String(k).split("|")[0]) : "") +
      (p && p.entry.isNote ? " 🔥note予想" : "") + "</div>";
  }

  function renderPreds() {
    var key = currentKey();
    var mainName = state.venues[state.activeVenue] ? state.venues[state.activeVenue].name : "";
    // トークの表示レース＝配信者ごとの固定リスト（8/6 FB3・state.talkRaces・最大3場）。
    // コンソールの操作用の場切替に引きずられない。旧データ（talkRaces無し）はメイン＋人別サブで互換
    function talkKeysOf(rc) {
      if (!rc) return key ? [key] : [];
      var names = (state.talkRaces || {})[rc.id];
      if (names && names.length) {
        return names.filter(function (n) {
          return state.venues.some(function (v) { return v.name === n; }) && state.currentRace[n];
        }).slice(0, 3).map(function (n) { return window.Derive.raceKey(n, state.currentRace[n]); });
      }
      var ks = key ? [key] : [];
      var subName = (state.subVenueBy || {})[rc.id] || state.subVenue;
      if (subName && subName !== mainName && state.currentRace[subName] &&
          state.venues.some(function (v) { return v.name === subName; })) {
        ks.push(window.Derive.raceKey(subName, state.currentRace[subName]));
      }
      return ks;
    }
    // 空席の畳み込み：カメラ穴は塞ぎ・予想帯は全幅化（CSSのbody.seat-*-off）。1人配信はどちらの席でも可
    var seats = seatMap();
    document.body.classList.toggle("seat-a-off", !seats.a);
    document.body.classList.toggle("seat-b-off", !seats.b);
    // ②サブ予想（8/6 FB13・FB17で配信者ごとに選択）：raceSubBy[配信者id]＝場名。旧raceSubVenueは互換読み
    var subVenueOf = function (rc) {
      if (!rc) return null;
      var vn = (state.raceSubBy || {})[rc.id] || state.raceSubVenue;
      return vn && state.venues.some(function (v) { return v.name === vn; }) ? vn : null;
    };
    document.body.classList.toggle("race-sub-on", !!(subVenueOf(seats.a) || subVenueOf(seats.b)));
    ["a", "b"].forEach(function (slot) {
      var rc = seats[slot];
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
      var isNote = !!(rp && rp.entry.isNote);  // note予想（勝負レース）＝ヘッダーバッジはメインレース基準
      var talkKeys = talkKeysOf(rc);           // この配信者のトーク表示レース（1〜3）

      // 予想帯＝①トーク（tband-）と②レース観戦（band-）で同一様式：
      // メンバーカラーのヘッダー（〇〇予想＋noteバッジ＋投資/回収の日次累計）＋俺たち目＋買い目チップ
      ["band-", "tband-"].forEach(function (bp) {
        var bandHead = $(bp + "head-" + slot);
        if (!bandHead) return;
        var bandName = $(bp + "name-" + slot);
        if (bandName) bandName.innerHTML = esc(name) + " 予想"; // note予想バッジは廃止（8/6 FB25・レースラベル側の🔥表記のみ残す）
        var bandInv = $(bp + "inv-" + slot);
        if (bandInv) {
          var bt = rc ? (derived.totals[rc.id] || { invest: 0, refund: 0 }) : null;
          bandInv.textContent = bt ? "投資 " + fmtYen(bt.invest) + "　回収 " + fmtYen(bt.refund) : "";
        }
        if (color) {
          bandHead.style.background = color;
          var btc = textOn(color);
          bandHead.style.color = btc;
          bandHead.classList.toggle("txt-edge", btc === "#fff"); // 白文字のみ黒フチ（8/6 FB19）
          if (bandHead.parentElement) bandHead.parentElement.style.borderColor = color;
        }
        fitBandHead(bandHead); // 名前＋バッジ＋投資/回収が1行に収まるよう自動縮小
        var band = $(bp + "pred-" + slot);
        if (!band) return;
        // ①トーク＝配信者ごとの表示レース1〜3場（8/6 FB3）。1場＝全面／2場＝左右分割／3場＝T字（上段1場目・下段2場）。
        // ②レース観戦は従来どおり操作中のメインレースのみ
        if (bp === "tband-") {
          if (talkKeys.length >= 3) {
            // 左＝フル高の大枠／右＝上下2段（8/6 FB26・Naotoスケッチ準拠）。
            // 大枠には行数最多のレースを自動配置（FB33・同数ならタップ順維持＝安定ソート）
            var tk = talkKeys.slice().sort(function (a, b) { return predRowCount(rc, b) - predRowCount(rc, a); });
            band.innerHTML =
              '<div class="race-t">' +
              '<div class="race-t-main race-col">' + raceColHead(rc, tk[0]) + raceBuyHtml(rc, tk[0], true) + "</div>" +
              '<div class="race-t-side">' +
              '<div class="race-col">' + raceColHead(rc, tk[1]) + raceBuyHtml(rc, tk[1], true) + "</div>" +
              '<div class="race-col">' + raceColHead(rc, tk[2]) + raceBuyHtml(rc, tk[2], true) + "</div>" +
              "</div></div>";
          } else if (talkKeys.length === 2) {
            band.innerHTML =
              '<div class="race-split">' +
              '<div class="race-col">' + raceColHead(rc, talkKeys[0]) + raceBuyHtml(rc, talkKeys[0], true) + "</div>" +
              '<div class="race-col">' + raceColHead(rc, talkKeys[1]) + raceBuyHtml(rc, talkKeys[1], true) + "</div>" +
              "</div>";
          } else {
            band.innerHTML = raceColHead(rc, talkKeys[0] || null) + raceBuyHtml(rc, talkKeys[0] || null, false);
          }
          fitPredLines(band); // 長い行は枠幅に合わせて自動縮小
          fitRaceCols(band);  // 買い目が多い列は縦にも自動縮小（見切れ防止・8/6 FB9）
        } else {
          // メイン帯にも「場名 R」ラベルを表示（サブ予想との区別・8/6 FB13）。
          // 合計/投資は右下の固定枠へ分離（8/6 FB57）。パッキングが実座標で衝突判定するため
          // metaを先に確定させてから買い目を組む（FB58・順序に意味あり）
          var bMeta = $("band-meta-" + slot);
          if (bMeta) {
            var rpm = rc && key ? window.Derive.resolvePred(state, key, rc.id) : null;
            var mt = rpm && (rpm.points || rpm.invest > 0)
              ? (rpm.points ? "合計 " + rpm.points + "点" : "") +
                (rpm.invest > 0 ? (rpm.points ? "　" : "") + "投資 " + fmtYen(rpm.invest) : "")
              : "";
            bMeta.textContent = mt;
            bMeta.classList.toggle("hidden", !mt);
          }
          band.classList.remove("buy-xl", "buy-lg");
          band.innerHTML = (key ? raceColHead(rc, key) : "") + raceBuyHtml(rc, key, false, true);
          packRaceBand(band); // 自前パッキング＋最適倍率（8/6 FB51→FB58で全分割総当たり化）
        }
      });

      // ②サブ予想帯（8/6 FB13・FB17）：配信者ごとの場＝raceSubBy。サブ未選択の配信者の枠は畳む
      var sHead = $("sband-head-" + slot);
      if (sHead) {
        var svn = subVenueOf(rc);
        var sPanel = sHead.parentElement;
        if (sPanel) sPanel.style.display = (rc && svn) ? "" : "none";
        var sName = $("sband-name-" + slot);
        if (sName) {
          sName.textContent = name ? name + " 予想（NEXT）" : "";
          // 幅にぴったり収まるフォントサイズを自動計算（8/6 FB34：縮小だけでなく拡大もして枠パンパンに・改行なし）
          sName.style.transform = "";
          sName.style.fontSize = "";
          var sAvail = sHead.clientWidth - 20; // ヘッダー左右padding分
          if (sAvail > 0 && sName.scrollWidth > 0) {
            var sBase = parseFloat(getComputedStyle(sName).fontSize) || 18;
            var sFs = Math.max(12, Math.min(34, sBase * sAvail / sName.scrollWidth));
            sName.style.fontSize = sFs.toFixed(1) + "px";
          }
        }
        if (color) {
          sHead.style.background = color;
          var stc = textOn(color);
          sHead.style.color = stc;
          sHead.classList.toggle("txt-edge", stc === "#fff"); // 白文字のみ黒フチ（8/6 FB19）
          if (sPanel) sPanel.style.borderColor = color;
        }
        var sBand = $("sband-pred-" + slot);
        if (sBand) {
          var sKey = svn && state.currentRace[svn] ? window.Derive.raceKey(svn, state.currentRace[svn]) : null;
          sBand.innerHTML = sKey ? raceColHead(rc, sKey) + raceBuyHtml(rc, sKey, false) : "";
          fitSubRows(sBand); // 買い目・合計とも折り返さず幅ぴったりに自動縮小（8/6 FB14）
        }
      }
    });
    // 描画直後の測定は不確実なことがある→次フレーム＋300ms後に再フィット（8/6 FB32）
    requestAnimationFrame(fitTalkBands);
    setTimeout(fitTalkBands, 300);
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
    fitSlist(); // ライン表示で高さが変わった後に9車の収まりを確認（8/6 FB30）
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
    fitNarabi(); // 収まらない時は行ごと縮小（8/6 FB44）
  }

  /** ライン行の幅フィット（8/6 FB44）：「ライン無し」の全バラ表示等で右端チップが切れる→行ごと縮小 */
  function fitNarabi() {
    var nb = $("narabi-talk");
    if (!nb || nb.classList.contains("hidden")) return;
    nb.style.transform = "";
    var nr = nb.getBoundingClientRect();
    if (nr.width <= 0) return;
    var padR = parseFloat(getComputedStyle(nb).paddingRight) || 0;
    var maxRight = nr.left;
    for (var i = 0; i < nb.children.length; i++) {
      var r = nb.children[i].getBoundingClientRect();
      if (r.right > maxRight) maxRight = r.right;
    }
    var need = maxRight - nr.left;
    var avail = nr.width - padR;
    if (need > avail + 1) {
      nb.style.transform = "scale(" + Math.max(0.5, avail / need).toFixed(3) + ")";
      nb.style.transformOrigin = "left center";
    }
  }

  /** 出走表の縦フィット（8/6 FB30）：ライン・note勝負を下に固定したまま、9車が入り切らない時は
      出走表リストだけを自動縮小（他の枠に干渉しない）。子要素の実下端で測る（scrollHeight不使用） */
  function fitSlist() {
    var el = $("slist-talk");
    if (!el) return;
    el.style.transform = "";
    var er = el.getBoundingClientRect();
    if (er.height <= 0) return;
    var maxBottom = er.top;
    for (var i = 0; i < el.children.length; i++) {
      var r = el.children[i].getBoundingClientRect();
      if (r.bottom > maxBottom) maxBottom = r.bottom;
    }
    var need = maxBottom - er.top;
    if (need > er.height + 1) {
      el.style.transform = "scale(" + Math.max(0.5, er.height / need) + ")";
      el.style.transformOrigin = "left top";
    }
  }

  /** 本日のキャンペーン応募人数（バナー・時計の左・8/6 FB21）：空＝非表示 */
  function renderCampaign() {
    var box = $("camp-box");
    if (!box) return;
    var n = state ? state.campaignCount : null;
    var show = n !== null && n !== undefined && n !== "" && !isNaN(+n);
    box.classList.toggle("hidden", !show);
    if (show) $("camp-num").textContent = (+n).toLocaleString() + "人";
  }

  /** 本日のnote勝負レース（①トーク・ラインの下・コンソール本日設定の入力を表示・8/6）
      1行＝1件・最大8行。5行以上はCSS側で段階縮小、長い行は枠幅に合わせて自動縮小 */
  function renderNoteRaces() {
    var el = $("note-races-talk");
    if (!el) return;
    var lines = (state && state.noteRaces ? String(state.noteRaces) : "")
      .split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 8);
    el.classList.toggle("hidden", !lines.length);
    el.classList.toggle("nr-many", lines.length >= 5 && lines.length <= 6);
    el.classList.toggle("nr-max", lines.length >= 7);
    if (!lines.length) { el.innerHTML = ""; fitSlist(); return; }
    el.innerHTML = '<div class="nr-head">🔥 note勝負</div>' +
      lines.map(function (l) { return '<div class="nr-line">' + esc(l) + "</div>"; }).join("");
    el.querySelectorAll(".nr-line").forEach(function (ln) {
      ln.style.transform = "";
      if (ln.clientWidth > 0 && ln.scrollWidth > ln.clientWidth + 1) {
        ln.style.transform = "scale(" + Math.max(0.55, ln.clientWidth / ln.scrollWidth) + ")";
        ln.style.transformOrigin = "left center";
      }
    });
    fitSlist(); // note勝負の行数で出走表の残り高さが変わるため再フィット（8/6 FB30）
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
        $("hit-sub").textContent = best.racerName +
          (best.type && best.type !== "3連単" ? " " + best.type : "") + " " + best.mult + "倍（無料公開）";
      } else {
        badge.classList.add("hidden");
      }
    }
    renderTicker();
  }

  function renderTicker() {
    var items = derived.hits.slice().reverse().map(function (h) { // 古い順に流す
      // 式別ラベルは3連単運用のため省略（俺たち目・例外買いのワイド等だけ残す・8/6 FB）
      var typeLabel = h.type && h.type !== "3連単" ? " " + esc(h.type) : "";
      var noteLabel = h.note ? " note" : ""; // note予想レースの的中は場Rの後ろにnote表記（8/6 FB53）
      if (h.manche && h.amount) {
        return '<span class="tick-manche">💥 万車速報：' + esc(h.racerName) + " " + esc(h.place) + noteLabel + typeLabel + " " + h.mult + "倍</span>";
      }
      return "<span>🎯 " + esc(h.racerName) + " " + esc(h.place) + noteLabel + typeLabel + " " + h.mult + "倍 的中</span>";
    }).join("");
    var copy = '<div class="tick-copy">' + items + "</div>";
    // ③結果と①トークの両方のティッカーに同じ内容を流す（的中ゼロでもバーは常時表示。②への追加は比率崩れのためFB31で撤回）
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
  var HIT_FX_MS = 20000; // 8/6 FB46：12秒→20秒に延長
  function checkNewHits() {
    var ids = {};
    derived.hits.forEach(function (h) { ids[h.id] = h; });
    if (seenHits === null) { seenHits = ids; return; }
    Object.keys(ids).forEach(function (id) {
      var h = ids[id];
      var prev = seenHits[id];
      // 既知の的中は原則スキップ。例外＝自動確定→手動確定への置き換わり（回収入力での上書き）は発火（8/6 FB47）
      if (prev && !(prev.resAuto && !h.resAuto)) return;
      // 自動確定由来は演出を出さない（8/6 FB47・手動の「結果を確定」の時だけ演出）＝記録だけ残す
      if (h.resAuto) return;
      var seats = seatMap();
      ["a", "b"].forEach(function (slot) {
        if (seats[slot] && seats[slot].name === h.racerName) fireHitFx(slot, h);
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
        : "🎯 的中！" + (hit.type && hit.type !== "3連単" ? " " + hit.type : "") + (hit.mult ? " " + hit.mult + "倍" : "");
      cam.appendChild(badge);
      cam.classList.add("hit-fx");
      if (hit.manche) cam.classList.add("hit-fx-manche"); // 万車＝赤の強パルス（8/6 FB46）
      setTimeout(function () {
        if (badge.parentNode) badge.parentNode.removeChild(badge);
        if (!cam.querySelector(".hit-fx-badge")) { cam.classList.remove("hit-fx"); cam.classList.remove("hit-fx-manche"); }
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
    renderNoteRaces();
    renderCampaign();
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
    }).catch(function () {
      setTimeout(loadTimetable, 15000); // 起動直後の取得失敗で10分空白にならないよう即リトライ
    });
  }
  loadTimetable();
  setInterval(loadTimetable, (window.APP_CONFIG.TT_POLL_MS || 600000));

  var fitTick = 0;
  setInterval(function () {
    tickClock();
    renderTimers();     // カードセット変化時のみDOM再構築
    tickBrb();
    if (++fitTick % 4 === 0) { fitTalkBands(); fitRaceBands(); fitNarabi(); } // 毎秒＝①②帯・ライン行の自己修復（8/6 FB32/37/44）
  }, 250);              // 0.25秒刻み＝信号機色の切替と音のズレを知覚できない範囲に抑える

  tickClock();
  renderAll();
  requestAnimationFrame(buildBackdrop);
})();
