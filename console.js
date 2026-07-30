/* console.js — 配信コンソール（OBSカスタムドック）
   操作は3つだけ：①予想を打つ ②投資額を打つ ③結果を入れる（§8）
   画面上の数字（点数・投資・回収・的中速報・結果パネル）はすべて自動計算。
   書込にはURLの ?key= が必要（初回入力後はlocalStorageに保持）。 */

(function () {
  var params = new URLSearchParams(location.search);
  var KEY = params.get("key") || localStorage.getItem("console_key") || "";
  if (params.get("key")) localStorage.setItem("console_key", params.get("key"));

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pad2(n) { return ("0" + n).slice(-2); }
  function todayStr() {
    var d = new Date();
    return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }
  function fmtYen(n) { return "¥" + Math.round(n).toLocaleString("ja-JP"); }
  function timeToSec(hhmm) {
    var p = String(hhmm || "").split(":");
    if (p.length < 2) return null;
    return (+p[0]) * 3600 + (+p[1]) * 60;
  }
  function nowSec() {
    var d = new Date();
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }
  function fmtCount(sec) {
    if (sec < 0) sec = 0;
    return pad2(Math.floor(sec / 60)) + ":" + pad2(sec % 60);
  }

  var state = null;
  var timetable = null;
  var payoutRows = [];     // 結果入力中の払戻行（ローカル編集用）
  var saveCount = 0;
  var savePending = false;
  var saveRunning = false;

  /* ---------- 保存（直列キュー・最終状態が必ず載る） ---------- */
  function save() {
    if (!KEY) { setSync("err", "書込キー未設定"); return; }
    if (saveRunning) { savePending = true; return; }
    saveRunning = true;
    setSync("", "保存中…");
    window.Sync.saveState(KEY, state).then(function (rev) {
      saveCount++;
      var d = new Date();
      setSync("ok", "保存済み " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()) + "（rev " + rev + "）");
    }).catch(function (e) {
      setSync("err", "保存失敗: " + e.message);
    }).then(function () {
      saveRunning = false;
      if (savePending) { savePending = false; save(); }
      renderDiag();
    });
  }
  function setSync(cls, text) {
    $("sync-dot").className = "sync-dot " + cls;
    $("sync-text").textContent = text;
  }

  /* ---------- タイムテーブル ---------- */
  function venueRaces(name) {
    if (!timetable) return [];
    var v = (timetable.venues || []).filter(function (x) { return x.name === name; })[0];
    return v ? v.races : [];
  }
  function nextRaceOf(name) {
    var now = nowSec();
    var rs = venueRaces(name).filter(function (r) {
      var s = timeToSec(r.start);
      return s !== null && s + 120 > now;
    });
    return rs.length ? rs[0] : null;
  }

  /* ---------- 場・レース ---------- */
  function activeVenueName() {
    var v = state.venues[state.activeVenue];
    return v ? v.name : null;
  }
  function currentKey() {
    var name = activeVenueName();
    if (!name) return null;
    var rNo = state.currentRace[name];
    return rNo ? window.Derive.raceKey(name, rNo) : null;
  }

  function renderVenueRow() {
    var el = $("venue-row");
    if (!state.venues.length) {
      el.innerHTML = '<div class="hint">「本日設定」で場を選んでください</div>';
      return;
    }
    el.innerHTML = state.venues.map(function (v, i) {
      var rNo = state.currentRace[v.name];
      return '<button class="vbtn' + (i === state.activeVenue ? " active" : "") + '" data-i="' + i + '">' +
        esc(v.name) + "<small>" + (rNo ? rNo + "R" : "-") + "　" + esc(state.grade[v.name] || "") + "</small></button>";
    }).join("");
    el.querySelectorAll(".vbtn").forEach(function (b) {
      b.addEventListener("click", function () {
        state.activeVenue = +b.getAttribute("data-i");
        save();
        renderAll();
      });
    });
  }

  function renderRaceChips() {
    var el = $("race-chips");
    var name = activeVenueName();
    if (!name) { el.innerHTML = ""; return; }
    var races = venueRaces(name);
    var next = nextRaceOf(name);
    var now = nowSec();
    el.innerHTML = races.map(function (r) {
      var s = timeToSec(r.start);
      var cls = "rc";
      if (state.currentRace[name] === r.no) cls += " cur";
      else if (next && next.no === r.no) cls += " next";
      if (s !== null && s + 120 <= now) cls += " done";
      return '<button class="' + cls + '" data-no="' + r.no + '">' + r.no + "R<small>" + r.start + "</small></button>";
    }).join("");
    el.querySelectorAll(".rc").forEach(function (b) {
      b.addEventListener("click", function () {
        state.currentRace[name] = +b.getAttribute("data-no");
        save();
        renderAll();
      });
    });
  }

  $("btn-narabi-save").addEventListener("click", function () {
    var key = currentKey();
    if (!key) return;
    if (!state.narabi) state.narabi = {};
    state.narabi[key] = $("narabi-input").value.trim();
    save();
  });

  $("btn-next-race").addEventListener("click", function () {
    var name = activeVenueName();
    if (!name) return;
    var next = nextRaceOf(name);
    if (next) {
      state.currentRace[name] = next.no;
      save();
      renderAll();
    }
  });

  /* ---------- 予想入力 ---------- */
  function ensurePredEntry(key, racerId) {
    if (!state.preds[key]) state.preds[key] = { cars: 9, byRacer: {} };
    if (!state.preds[key].byRacer[racerId]) {
      state.preds[key].byRacer[racerId] = { text: "", defaultType: "3連単", unit: 100, investInput: null, oreTachi: "", isNote: false };
    }
    return state.preds[key].byRacer[racerId];
  }

  function renderPredForms() {
    var key = currentKey();
    $("pred-target").textContent = key ? key.replace("|", " ") + "R" : "（場・レース未選択）";
    $("narabi-input").value = key ? ((state.narabi || {})[key] || "") : "";
    var wrap = $("pred-forms");
    if (!key) { wrap.innerHTML = ""; return; }
    var race = state.preds[key] || { cars: 9 };

    wrap.innerHTML = state.racers.map(function (rc, idx) {
      var p = (race.byRacer && race.byRacer[rc.id]) || { text: "", defaultType: "3連単", unit: 100, investInput: null, oreTachi: "", isNote: false };
      return '<div class="pred-form" data-racer="' + rc.id + '">' +
        '<h3><span class="' + (idx === 1 ? "alt" : "") + '">' + esc(rc.name) + "</span> の予想</h3>" +
        '<textarea class="inp pf-text" rows="3" placeholder="例）1=9-2357&#10;メモ行はそのまま画面に出ます">' + esc(p.text) + "</textarea>" +
        '<div class="parse-info pf-info"></div>' +
        '<div class="pred-opts">' +
        '<label class="lbl inline">俺たち目 <input type="text" class="inp slim pf-ore" value="' + esc(p.oreTachi || "") + '" placeholder="無料公開の1点（例 1-2-3）"></label>' +
        '<label class="lbl inline"><input type="checkbox" class="pf-note"' + (p.isNote ? " checked" : "") + '> note予想（勝負レース）</label>' +
        "</div>" +
        '<div class="pred-opts">' +
        '<label class="lbl inline">式別 <select class="inp tiny pf-type">' +
        window.Keirin.TYPES.map(function (t) { return "<option" + (t === p.defaultType ? " selected" : "") + ">" + t + "</option>"; }).join("") +
        "</select></label>" +
        '<label class="lbl inline">単価 <input type="number" class="inp tiny pf-unit" step="100" min="0" value="' + (p.unit || "") + '">円</label>' +
        '<label class="lbl inline">投資額 <input type="number" class="inp tiny pf-invest" value="' + (p.investInput || "") + '" placeholder="自動">円</label>' +
        "</div>" +
        '<div class="parse-total pf-total"></div>' +
        '<button class="btn small pf-save">この予想を保存</button>' +
        "</div>";
    }).join("") +
      '<div class="pred-opts"><label class="lbl inline">車数 <select class="inp tiny" id="pred-cars">' +
      '<option value="9"' + (race.cars !== 7 ? " selected" : "") + ">9車</option>" +
      '<option value="7"' + (race.cars === 7 ? " selected" : "") + ">7車</option>" +
      "</select></label></div>";

    wrap.querySelectorAll(".pred-form").forEach(function (form) {
      var racerId = form.getAttribute("data-racer");
      var update = function () { updatePredInfo(form, key); };
      ["pf-text", "pf-type", "pf-unit", "pf-invest"].forEach(function (cls) {
        form.querySelector("." + cls).addEventListener("input", update);
      });
      form.addEventListener("click", function (e) {
        var t = e.target;
        if (t.classList && t.classList.contains("snap-unit")) {
          form.querySelector(".pf-unit").value = t.getAttribute("data-u");
          form.querySelector(".pf-invest").value = "";
          updatePredInfo(form, key);
        }
      });
      form.querySelector(".pf-save").addEventListener("click", function () {
        var entry = ensurePredEntry(key, racerId);
        entry.text = form.querySelector(".pf-text").value;
        entry.defaultType = form.querySelector(".pf-type").value;
        entry.unit = +form.querySelector(".pf-unit").value || 0;
        var inv = +form.querySelector(".pf-invest").value;
        entry.investInput = inv > 0 ? inv : null;
        entry.oreTachi = form.querySelector(".pf-ore").value.trim();
        entry.isNote = form.querySelector(".pf-note").checked;
        state.preds[key].cars = +($("pred-cars").value) || 9;
        save();
        renderSettlePreview();
      });
      update();
    });
    var carsSel = $("pred-cars");
    if (carsSel) carsSel.addEventListener("change", function () {
      wrap.querySelectorAll(".pred-form").forEach(function (f) { updatePredInfo(f, key); });
    });
  }

  function updatePredInfo(form, key) {
    var cars = +($("pred-cars") ? $("pred-cars").value : 9) || 9;
    var type = form.querySelector(".pf-type").value;
    var parsed = window.Keirin.parsePrediction(form.querySelector(".pf-text").value, type, cars);
    form.querySelector(".pf-info").innerHTML = parsed.lines.map(function (l) {
      return l.ok
        ? '<div class="pl-ok">' + esc(l.raw.trim()) + "　→ " + esc(l.type) + " <b>" + l.points + "点</b></div>"
        : '<div class="pl-memo">' + esc(l.raw.trim()) + "　→ メモ行（点数外）</div>";
    }).join("");
    var unit = +form.querySelector(".pf-unit").value || 0;
    var investInput = +form.querySelector(".pf-invest").value || 0;
    var invest, unitExact;
    if (investInput > 0) {
      invest = investInput;
      unitExact = parsed.points ? investInput / parsed.points : 0;
    } else {
      invest = parsed.points * unit;
      unitExact = unit;
    }
    var unitShow = Math.round(unitExact);
    var html = "合計 " + parsed.points + "点 × " + unitShow.toLocaleString("ja-JP") + "円 ＝ " + fmtYen(invest);
    // 車券は100円単位。割り切れない単価は実買不可なので丸め候補を提示
    if (parsed.points > 0 && unitExact > 0 && unitExact % 100 !== 0) {
      var lo = Math.floor(unitExact / 100) * 100;
      var hi = lo + 100;
      html += '<div class="unit-warn">⚠ 1点' + unitShow + "円は車券で買えない額（100円単位）→ ";
      if (lo > 0) html += '<button class="btn small snap-unit" data-u="' + lo + '">' + lo + "円/点=" + fmtYen(lo * parsed.points) + "</button> ";
      html += '<button class="btn small snap-unit" data-u="' + hi + '">' + hi + "円/点=" + fmtYen(hi * parsed.points) + "</button></div>";
    }
    form.querySelector(".pf-total").innerHTML = html;
  }

  /* ---------- 結果入力 ---------- */
  function parseOrderInput() {
    var raw = window.Keirin.normalize($("res-order").value).replace(/[^0-9]/g, "");
    var order = [];
    for (var i = 0; i < raw.length && order.length < 3; i++) {
      var n = +raw[i];
      if (n >= 1 && n <= 9 && order.indexOf(n) < 0) order.push(n);
    }
    return order.length >= 2 ? order : null;
  }

  function renderResultForm() {
    var key = currentKey();
    $("result-target").textContent = key ? key.replace("|", " ") + "R" : "（場・レース未選択）";
    var existing = key ? state.results[key] : null;
    if (existing) {
      $("res-order").value = (existing.order || []).join("-");
      for (var i = 0; i < 3; i++) {
        $("res-name-" + (i + 1)).value = (existing.names && existing.names[i]) || "";
      }
      $("res-kim-1").value = (existing.kimarite && existing.kimarite[0]) || "";
      $("res-kim-2").value = (existing.kimarite && existing.kimarite[1]) || "";
      payoutRows = (existing.payouts || []).map(function (p) {
        return { type: p.type, combo: p.combo.slice(), amount: p.amount };
      });
    } else {
      $("res-order").value = "";
      ["res-name-1", "res-name-2", "res-name-3", "res-kim-1", "res-kim-2"].forEach(function (id) { $(id).value = ""; });
      payoutRows = [];
    }
    syncPayoutPresets();
  }

  /** 着順から標準の払戻行を用意（入力済み金額は保持） */
  function syncPayoutPresets() {
    var order = parseOrderInput();
    if (order && order.length >= 2) {
      window.Keirin.standardCombos(order).forEach(function (sc) {
        var exists = payoutRows.some(function (p) {
          return p.type === sc.type &&
            window.Keirin.comboLabel(p.type, p.combo) === window.Keirin.comboLabel(sc.type, sc.combo);
        });
        if (!exists) payoutRows.push({ type: sc.type, combo: sc.combo, amount: 0 });
      });
    }
    renderPayoutRows();
    renderSettlePreview();
  }

  function renderPayoutRows() {
    var el = $("payout-rows");
    el.innerHTML = payoutRows.map(function (p, i) {
      return '<div class="payout-row">' +
        '<span class="pr-label">' + esc(p.type) + " " + esc(window.Keirin.comboLabel(p.type, p.combo)) + "</span>" +
        '<input type="number" class="inp pr-amount" data-i="' + i + '" value="' + (p.amount || "") + '" placeholder="払戻">' +
        '<button class="pr-del" data-i="' + i + '">✕</button></div>';
    }).join("");
    el.querySelectorAll(".pr-amount").forEach(function (inp) {
      inp.addEventListener("input", function () {
        payoutRows[+inp.getAttribute("data-i")].amount = +inp.value || 0;
        renderSettlePreview();
      });
    });
    el.querySelectorAll(".pr-del").forEach(function (b) {
      b.addEventListener("click", function () {
        payoutRows.splice(+b.getAttribute("data-i"), 1);
        renderPayoutRows();
        renderSettlePreview();
      });
    });
  }

  $("res-order").addEventListener("input", syncPayoutPresets);

  $("btn-payout-add").addEventListener("click", function () {
    var type = $("payout-add-type").value;
    var comboRaw = window.Keirin.normalize($("payout-add-combo").value).replace(/[^0-9]/g, "");
    var combo = comboRaw.split("").map(Number).filter(function (n) { return n >= 1 && n <= 9; });
    if (combo.length < 2) return;
    payoutRows.push({ type: type, combo: combo.slice(0, 3), amount: 0 });
    $("payout-add-combo").value = "";
    renderPayoutRows();
  });

  function renderSettlePreview() {
    var key = currentKey();
    var el = $("settle-preview");
    var order = parseOrderInput();
    if (!key || !order) { el.innerHTML = '<span class="miss">着順を入力すると的中・回収のプレビューが出ます</span>'; return; }
    var payouts = payoutRows.filter(function (p) { return p.amount > 0; });
    el.innerHTML = state.racers.map(function (rc) {
      var rp = window.Derive.resolvePred(state, key, rc.id);
      var s = window.Keirin.settle(rp.parsed, rp.unit, order, payouts);
      if (!rp.points) return "<div>" + esc(rc.name) + "：予想なし</div>";
      if (!s.hits.length) return "<div>" + esc(rc.name) + '：<span class="miss">不的中</span>（投資 ' + fmtYen(s.invest) + "）</div>";
      return "<div>" + esc(rc.name) + "：" + s.hits.map(function (h) {
        if (!h.amount) return '<span class="manche">🎯 ' + h.type + " " + h.comboLabel + " 払戻未入力</span>";
        return '<span class="' + (h.manche ? "manche" : "hit") + '">🎯 ' + h.type + " " + h.comboLabel + " " + h.mult + "倍</span>";
      }).join(" ") + "　回収 " + fmtYen(s.refund) + "</div>";
    }).join("");
  }

  $("btn-settle").addEventListener("click", function () {
    var key = currentKey();
    if (!key) return;
    var order = parseOrderInput();
    if (!order) { $("settle-preview").innerHTML = '<span class="manche">着順が読めません（例：1-9-2）</span>'; return; }
    // 的中しているのに払戻が未入力なら確定させない（0倍の的中速報が画面に載る事故防止）
    var validPayouts = payoutRows.filter(function (p) { return p.amount > 0; });
    var missing = [];
    state.racers.forEach(function (rc) {
      var rp = window.Derive.resolvePred(state, key, rc.id);
      window.Keirin.settle(rp.parsed, rp.unit, order, validPayouts).hits.forEach(function (h) {
        var label = h.type + " " + h.comboLabel;
        if (!h.amount && missing.indexOf(label) < 0) missing.push(label);
      });
    });
    if (missing.length) {
      $("settle-preview").innerHTML = '<span class="manche">⚠ 的中買目の払戻が未入力：' + missing.map(esc).join(" / ") +
        "　→ 上の払戻欄に入力すると倍率・回収を自動計算して確定できます</span>";
      return;
    }
    state.results[key] = {
      order: order,
      names: [$("res-name-1").value.trim(), $("res-name-2").value.trim(), $("res-name-3").value.trim()],
      kimarite: [$("res-kim-1").value.trim(), $("res-kim-2").value.trim(), ""],
      payouts: payoutRows.filter(function (p) { return p.amount > 0; }),
      settledAt: new Date().toISOString(),
    };
    state.resultView = key; // ③結果シーンに即反映
    save();
    renderHitAdmin();
    renderSettlePreview();
  });

  /* ---------- 貼り付け解析（実験的） ---------- */
  $("btn-paste-parse").addEventListener("click", function () {
    var text = $("res-paste").value;
    var filled = [];
    // 払戻: 「3連単 1-9-2 3,540円」のような並びを拾う
    var payRe = /(3連単|三連単|3連複|三連複|2車単|二車単|2車複|二車複|ワイド)[^\d\n]{0,10}([1-9])[\s\-=－]+([1-9])(?:[\s\-=－]+([1-9]))?[^\d\n]{0,10}([\d,，]+)\s*円/g;
    var m;
    var typeNorm = { "三連単": "3連単", "三連複": "3連複", "二車単": "2車単", "二車複": "2車複" };
    while ((m = payRe.exec(text)) !== null) {
      var type = typeNorm[m[1]] || m[1];
      var combo = [m[2], m[3], m[4]].filter(Boolean).map(Number);
      var amount = +m[5].replace(/[,，]/g, "");
      var row = null;
      payoutRows.forEach(function (p) {
        if (p.type === type && window.Keirin.comboLabel(p.type, p.combo) === window.Keirin.comboLabel(type, combo)) row = p;
      });
      if (row) row.amount = amount;
      else payoutRows.push({ type: type, combo: combo, amount: amount });
      filled.push(type + " " + fmtYen(amount));
    }
    // 着順: 「1着 … 3」「2着 … 7」の車番＋任意の選手名
    var ordRe = /([1-3])\s*着[^\d\n]{0,6}([1-9])[\s]*([^\s\d,，、][^\d\n]{1,12})?/g;
    var order = [null, null, null];
    while ((m = ordRe.exec(text)) !== null) {
      var pos = +m[1] - 1;
      order[pos] = +m[2];
      if (m[3]) $("res-name-" + (pos + 1)).value = m[3].trim();
    }
    if (order[0] && order[1]) {
      $("res-order").value = order.filter(Boolean).join("-");
      filled.push("着順 " + order.filter(Boolean).join("-"));
      syncPayoutPresets();
    }
    renderPayoutRows();
    renderSettlePreview();
    $("paste-hint").textContent = filled.length
      ? "転記: " + filled.join(" / ") + "　※内容を確認してから確定してください"
      : "読み取れる形式が見つかりませんでした（手入力してください）";
  });

  /* ---------- 的中速報管理 ---------- */
  function renderHitAdmin() {
    var derived = window.Derive.day(state);
    $("hit-admin").innerHTML = derived.hits.map(function (h) {
      return '<li class="' + (h.manche ? "manche" : "") + '">' +
        '<span class="ha-name">' + esc(h.racerName) + "</span>" +
        "<span>" + esc(h.place) + " " + esc(h.type) + "</span>" +
        '<span class="ha-mult">' + h.mult + "倍</span>" +
        '<button class="ha-del" data-id="' + esc(h.id) + '" data-auto="' + (h.auto ? 1 : 0) + '">非表示</button></li>';
    }).join("") || '<li><span class="hint">本日の的中はまだありません</span></li>';
    $("hit-admin").querySelectorAll(".ha-del").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-id");
        if (b.getAttribute("data-auto") === "1") {
          if (state.hitsHidden.indexOf(id) < 0) state.hitsHidden.push(id);
        } else {
          var idx = +id.replace("manual-", "");
          state.hitsManual.splice(idx, 1);
        }
        save();
        renderHitAdmin();
      });
    });
    // 手動追加のセレクト
    $("hit-add-racer").innerHTML = state.racers.map(function (rc) {
      return "<option>" + esc(rc.name) + "</option>";
    }).join("");
  }

  $("btn-hit-add").addEventListener("click", function () {
    var mult = +$("hit-add-mult").value;
    var place = $("hit-add-place").value.trim();
    if (!place || !(mult > 0)) return;
    state.hitsManual.push({
      racerName: $("hit-add-racer").value,
      place: place,
      mult: mult,
      at: new Date().toISOString(),
    });
    $("hit-add-place").value = "";
    $("hit-add-mult").value = "";
    save();
    renderHitAdmin();
  });

  /* ---------- 本日設定 ---------- */
  function renderSettings() {
    var el = $("venue-pick");
    var names = timetable ? (timetable.venues || []).map(function (v) { return v.name; }) : [];
    var selected = state.venues.map(function (v) { return v.name; });
    el.innerHTML = names.length
      ? names.map(function (n) {
          return '<button class="vp' + (selected.indexOf(n) >= 0 ? " sel" : "") + '" data-n="' + esc(n) + '">' + esc(n) + "</button>";
        }).join("")
      : '<div class="hint">タイムテーブル読込中（または本日の開催なし）</div>';
    el.querySelectorAll(".vp").forEach(function (b) {
      b.addEventListener("click", function () {
        var n = b.getAttribute("data-n");
        var i = selected.indexOf(n);
        if (i >= 0) selected.splice(i, 1);
        else { if (selected.length >= 2) selected.shift(); selected.push(n); }
        state.venues = selected.map(function (x) { return { name: x }; });
        if (state.activeVenue >= state.venues.length) state.activeVenue = 0;
        state.venues.forEach(function (v) {
          if (!state.currentRace[v.name]) {
            var next = nextRaceOf(v.name);
            if (next) state.currentRace[v.name] = next.no;
          }
          // グレードはタイムテーブルの自動取得値をプリセット（手で上書き可）
          if (!state.grade[v.name]) {
            var tv = (timetable && timetable.venues || []).filter(function (x) { return x.name === v.name; })[0];
            if (tv && tv.grade) state.grade[v.name] = tv.grade;
          }
        });
        renderSettings();
      });
    });

    $("grade-inputs").innerHTML = state.venues.map(function (v, i) {
      return '<label class="lbl">' + esc(v.name) + ' のグレード表示</label>' +
        '<input type="text" class="inp grade-inp" data-n="' + esc(v.name) + '" value="' + esc(state.grade[v.name] || "") + '" placeholder="例）F1 ナイター">';
    }).join("");

    var opts = state.roster.map(function (r) { return "<option>" + esc(r.name) + "</option>"; }).join("");
    $("racer-1").innerHTML = opts;
    $("racer-2").innerHTML = opts;
    if (state.racers[0]) $("racer-1").value = state.racers[0].name;
    if (state.racers[1]) $("racer-2").value = state.racers[1].name;
    $("roster").value = state.roster.map(function (r) {
      return r.name + (r.color ? " " + r.color : "");
    }).join("\n");
    $("cfg-close").value = state.cfg.closeMin;
    $("cfg-netclose").value = state.cfg.netCloseMin;
  }

  $("btn-save-settings").addEventListener("click", function () {
    state.roster = $("roster").value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean)
      .map(function (line) {
        var parts = line.split(/\s+/);
        return { name: parts[0], color: parts.slice(1).join(" ") };
      });
    var colorFor = function (name) {
      var m = state.roster.filter(function (r) { return r.name === name; })[0];
      return m ? m.color : "";
    };
    state.racers = [
      { id: "r1", name: $("racer-1").value || "配信者1", color: colorFor($("racer-1").value) },
      { id: "r2", name: $("racer-2").value || "配信者2", color: colorFor($("racer-2").value) },
    ];
    document.querySelectorAll(".grade-inp").forEach(function (inp) {
      state.grade[inp.getAttribute("data-n")] = inp.value.trim();
    });
    state.cfg.closeMin = +$("cfg-close").value || 3;
    state.cfg.netCloseMin = +$("cfg-netclose").value || 5;
    save();
    renderAll();
  });

  /* ---------- 広告・待機 ---------- */
  function renderAssets() {
    $("ad-title").value = state.ad.title || "";
    $("ad-lines").value = (state.ad.lines || []).join("\n");
    $("ad-show-progress").checked = !!state.ad.showProgress;
    $("ad-goal").value = state.ad.goalLabel || "";
    $("ad-cur").value = state.ad.cur || "";
    $("ad-max").value = state.ad.max || "";
    $("ad-unit").value = state.ad.unit || "";
    $("brb-msg").value = state.brbMsg || "";
  }
  $("btn-save-assets").addEventListener("click", function () {
    state.ad = {
      title: $("ad-title").value.trim(),
      lines: $("ad-lines").value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean),
      showProgress: $("ad-show-progress").checked,
      goalLabel: $("ad-goal").value.trim() || "応募状況",
      cur: +$("ad-cur").value || 0,
      max: +$("ad-max").value || 0,
      unit: $("ad-unit").value.trim(),
    };
    state.brbMsg = $("brb-msg").value.trim() || "まもなく再開します";
    save();
  });

  /* ---------- 新しい日 ---------- */
  function checkNewDay() {
    var warn = $("newday-warn");
    if (state.date !== todayStr()) {
      warn.classList.remove("hidden");
      $("newday-text").textContent = "保存データは " +
        state.date.slice(4, 6) + "/" + state.date.slice(6, 8) + " のものです。";
    } else {
      warn.classList.add("hidden");
    }
  }
  var newdayArmed = false;
  $("btn-newday").addEventListener("click", function () {
    if (!newdayArmed) {
      newdayArmed = true;
      $("btn-newday").textContent = "本当に開始（前日の予想・結果はクリア）";
      $("btn-newday").classList.add("confirm");
      return;
    }
    var keep = { racers: state.racers, roster: state.roster, cfg: state.cfg, ad: state.ad, brbMsg: state.brbMsg };
    state = window.Derive.defaultState(todayStr());
    Object.assign(state, keep);
    newdayArmed = false;
    $("btn-newday").textContent = "新しい日を開始";
    $("btn-newday").classList.remove("confirm");
    save();
    renderAll();
  });

  /* ---------- ステータスバー・警告 ---------- */
  function tickStatus() {
    if (!state) return;
    var now = nowSec();
    // 追跡中の場から次レース（未選択なら全場から）
    var pool = state.venues.length ? state.venues.map(function (v) { return v.name; })
      : (timetable ? (timetable.venues || []).map(function (v) { return v.name; }) : []);
    var best = null;
    pool.forEach(function (name) {
      var r = nextRaceOf(name);
      if (r) {
        var s = timeToSec(r.start);
        if (!best || s < best.startSec) best = { name: name, no: r.no, startSec: s };
      }
    });
    if (best) {
      var close = best.startSec - (state.cfg.closeMin || 3) * 60;
      var label = now < close ? "締切まで " + fmtCount(close - now)
        : now < best.startSec ? "発走まで " + fmtCount(best.startSec - now) : "発走中";
      $("next-race").textContent = "▶ " + best.name + best.no + "R " + label;
    } else {
      $("next-race").textContent = "";
    }

    // 出しっぱなし警告：現在レースの発走から3分超過＆後続レースあり
    var warn = $("stale-warn");
    var name = activeVenueName();
    var rNo = name ? state.currentRace[name] : null;
    if (name && rNo) {
      var races = venueRaces(name).filter(function (r) { return r.no === rNo; });
      var s = races.length ? timeToSec(races[0].start) : null;
      var next = nextRaceOf(name);
      if (s !== null && now > s + 180 && next && next.no !== rNo) {
        warn.textContent = "⚠ " + name + rNo + "R は発走済み。次は " + next.no + "R（" + next.start + "）— 上の「次のレースへ」で切替";
        warn.classList.remove("hidden");
      } else {
        warn.classList.add("hidden");
      }
    } else {
      warn.classList.add("hidden");
    }
  }

  /* ---------- 診断 ---------- */
  function renderDiag() {
    $("diag-info").textContent =
      "GAS: " + (window.APP_CONFIG.GAS_URL || "").slice(0, 60) + "…　key: " + (KEY ? "設定済み" : "未設定") +
      "　保存回数: " + saveCount + "　rev: " + (state ? state.rev : "-");
  }
  $("btn-bc-test").addEventListener("click", function () {
    window.Sync.bcAlive = false;
    window.Sync.broadcast({ type: "ping" });
    $("diag-result").textContent = "ping送信…";
    setTimeout(function () {
      $("diag-result").textContent = window.Sync.bcAlive
        ? "✅ BC疎通OK：ドック⇔オーバーレイ直結（保存が即時反映）"
        : "BC応答なし → GASポーリング経路で動作（反映まで最大5〜7秒・問題なし）";
    }, 1200);
  });
  $("btn-tt-refresh").addEventListener("click", function () {
    $("diag-result").textContent = "タイムテーブル取得中…";
    window.Sync.fetchTimetable(0, true).then(function (t) {
      timetable = t;
      $("diag-result").textContent = "取得OK：" + (t.venues || []).length + "場（" + (t.fetchedAt || "") + "）";
      renderAll();
    }).catch(function (e) {
      $("diag-result").textContent = "取得失敗: " + e.message;
    });
  });

  /* ---------- 描画一括 ---------- */
  function renderAll() {
    renderVenueRow();
    renderRaceChips();
    renderPredForms();
    renderResultForm();
    renderHitAdmin();
    renderSettings();
    renderAssets();
    renderDiag();
    checkNewDay();
    tickStatus();
    // 初回（場未選択）は本日設定を自動で開く
    if (state && !state.venues.length) $("setup-card").open = true;
  }

  /* ---------- 起動 ---------- */
  if (!KEY) $("key-warn").classList.remove("hidden");
  $("btn-key-save").addEventListener("click", function () {
    var v = $("key-input").value.trim();
    if (!v) return;
    localStorage.setItem("console_key", v);
    location.reload();
  });

  window.Sync.initChannel(function () { /* pong受信でbcAliveが立つ */ });

  window.Sync.fetchState().then(function (s) {
    if (s) {
      var base = window.Derive.defaultState(todayStr());
      state = Object.assign({}, base, s);
      state.cfg = Object.assign({}, base.cfg, s.cfg || {});
      state.ad = Object.assign({}, base.ad, s.ad || {});
      window.Derive.normalizeState(state);
    } else {
      state = window.Derive.defaultState(todayStr());
    }
    setSync("ok", "接続OK（rev " + (state.rev || 0) + "）");
    renderAll();
  }).catch(function (e) {
    setSync("err", "GAS接続失敗: " + e.message);
    state = window.Derive.defaultState(todayStr());
    renderAll();
  });

  window.Sync.fetchTimetable(0).then(function (t) {
    timetable = t;
    renderAll();
  }).catch(function () { /* 診断から再取得可能 */ });

  setInterval(tickStatus, 1000);
})();
