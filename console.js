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
  var refundInputs = {};   // 配信者id→回収額（手入力・確定時にresults.refundsへ保存）
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
  /** 車数の自動判定：出走表の最大車番で7車/9車を決める（欠場があっても車番は詰まらないため件数でなく最大値）。
      タイムテーブル未着・出走表なしは9車扱い */
  function autoCars(key) {
    if (!key) return 9;
    var parts = key.split("|");
    var race = venueRaces(parts[0]).filter(function (r) { return r.no === +parts[1]; })[0];
    if (!race || !race.racers || !race.racers.length) return 9;
    var maxNo = 0;
    // 旧実装①7車/9車の二択で6車を7車に丸め（FB43）②keirin.jpは空枠・欠場スロットを返すことがあり
    // 実車番最大だと9に化ける（FB45＝名古屋6R実バグ）→名前入りスロットのみ数える
    race.racers.forEach(function (p) {
      var nm = p && p.name ? String(p.name).replace(/\s+/g, "") : "";
      if (!nm || /欠/.test(nm)) return;
      if (+p.no > maxNo) maxNo = +p.no;
    });
    return maxNo >= 2 ? maxNo : 9;
  }
  /** 実効車数＝手動上書き（carsFix）＞自動判定（8/6 FB45） */
  function effCars(key) {
    var p = key ? state.preds[key] : null;
    return (p && p.carsFix) ? p.carsFix : autoCars(key);
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

  /* トークの表示場リスト（8/6 FB3・state.talkRaces = {配信者id: [場名,…]} 最大3場・並び順＝表示順）。
     コンソールの操作用の場切替（activeVenue）とは独立＝入力のために場を替えても配信画面は変わらない。
     場構成が変わったら無効な場を除去し、空なら先頭2場を既定にする */
  function ensureTalkRaces() {
    if (!state) return;
    if (!state.talkRaces || typeof state.talkRaces !== "object") state.talkRaces = {};
    var names = (state.venues || []).map(function (v) { return v.name; });
    (state.racers || []).forEach(function (rc) {
      var list = (state.talkRaces[rc.id] || []).filter(function (n) { return names.indexOf(n) >= 0; });
      if (!list.length) list = names.slice(0, 2);
      state.talkRaces[rc.id] = list.slice(0, 3);
    });
  }

  function renderVenueRow() {
    // 表示中データの日付（8/6追加）。今日以外のデータなら赤字で警告
    var dateEl = $("race-date");
    if (dateEl && state && state.date && state.date.length === 8) {
      var dy = +state.date.slice(0, 4), dm = +state.date.slice(4, 6), dd = +state.date.slice(6, 8);
      var dows = ["日", "月", "火", "水", "木", "金", "土"];
      var isToday = state.date === todayStr();
      dateEl.textContent = dm + "/" + dd + "（" + dows[new Date(dy, dm - 1, dd).getDay()] + "）のデータ" +
        (isToday ? "" : "　⚠今日の日付ではありません");
      dateEl.style.color = isToday ? "" : "#ffb3b3";
    }
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
        manualNav(true); // 手動の場切替＝結果フォームの固定解除＋自動追従に手動優先を通知（FB96）
        save();
        renderAll();
      });
    });

    // トークの表示場（8/6 FB3）：配信者ごとに最大3場をトグル選択（押した順＝表示順・1番目が上段）。
    // 操作用の場切替とは独立＝どの場に切り替えて入力しても配信画面の買い目は変わらない
    var sr = $("sub-row");
    if (sr) {
      ensureTalkRaces();
      if (!state.venues.length || !state.racers.length) {
        sr.innerHTML = "";
      } else {
        sr.innerHTML = state.racers.map(function (rc) {
          var list = state.talkRaces[rc.id] || [];
          return '<div class="row gap">' +
            '<span class="lbl inline">' + esc(rc.name) + ' の表示（最大3場）</span>' +
            state.venues.map(function (v) {
              var idx = list.indexOf(v.name);
              var rNo = state.currentRace[v.name];
              return '<button class="vp' + (idx >= 0 ? " sel" : "") + '" data-rid="' + esc(rc.id) + '" data-v="' + esc(v.name) + '">' +
                (idx >= 0 ? (idx + 1) + "." : "") + esc(v.name) + (rNo ? " " + rNo + "R" : "") + "</button>";
            }).join("") +
            "</div>";
        }).join("");
        sr.querySelectorAll(".vp").forEach(function (b) {
          b.addEventListener("click", function () {
            var rid = b.getAttribute("data-rid");
            var vn = b.getAttribute("data-v");
            var list = (state.talkRaces[rid] || []).slice();
            var i = list.indexOf(vn);
            if (i >= 0) {
              if (list.length > 1) list.splice(i, 1); // 最低1場は残す
            } else {
              if (list.length >= 3) list.shift(); // 4つ目は一番古いのを外す
              list.push(vn);
            }
            state.talkRaces[rid] = list;
            manualNav(); // 手動の表示場変更（FB96）
            save();
            renderAll();
          });
        });
      }
    }
  }

  /* ②サブ予想の場（8/6 FB13→FB17で配信者ごとに選択）：レース観戦のワイプ左＝NEXT枠。
     raceSubBy[配信者id]＝場名。全員「なし」＝OFF＝従来レイアウト。
     ⚠️ONにしたらOBS側でカメラ1/2の移動が必要（セットアップ手順の「②サブ予想モード」参照） */
  function renderRaceSubRow() {
    var el = $("race-sub-row");
    if (!el) return;
    if (!state.raceSubBy || typeof state.raceSubBy !== "object") state.raceSubBy = {};
    // 旧・共通1場（raceSubVenue）からの移行：全員に同じ場を入れて旧フィールドは空に
    if (state.raceSubVenue) {
      (state.racers || []).forEach(function (rc) {
        if (!state.raceSubBy[rc.id]) state.raceSubBy[rc.id] = state.raceSubVenue;
      });
      state.raceSubVenue = null;
    }
    if (!state.venues.length || !state.racers.length) { el.innerHTML = ""; return; }
    var names = state.venues.map(function (v) { return v.name; });
    el.innerHTML = '<div class="lbl">②サブ予想（ワイプ左のNEXT枠）：配信者ごとに場を選択</div>' +
      state.racers.map(function (rc) {
        var cur = state.raceSubBy[rc.id];
        if (cur && names.indexOf(cur) < 0) cur = null;
        return '<div class="row gap">' +
          '<span class="lbl inline">' + esc(rc.name) + '</span>' +
          '<button class="vp' + (!cur ? " sel" : "") + '" data-rid="' + esc(rc.id) + '" data-v="">なし</button>' +
          state.venues.map(function (v) {
            var rNo = state.currentRace[v.name];
            return '<button class="vp' + (cur === v.name ? " sel" : "") + '" data-rid="' + esc(rc.id) + '" data-v="' + esc(v.name) + '">' +
              esc(v.name) + (rNo ? " " + rNo + "R" : "") + "</button>";
          }).join("") +
          // R送り＝メイン（放送）を切り替えずにその場を次レースへ
          (cur ? '<button class="vp" data-rid="' + esc(rc.id) + '" data-nextsub="1">▶ 次Rへ</button>' : "") +
          "</div>";
      }).join("");
    el.querySelectorAll(".vp").forEach(function (b) {
      b.addEventListener("click", function () {
        var rid = b.getAttribute("data-rid");
        if (b.getAttribute("data-nextsub")) {
          var vn = state.raceSubBy[rid];
          var next = vn ? nextRaceOf(vn) : null;
          if (next) { state.currentRace[vn] = next.no; manualNav(); save(); renderAll(); }
          return;
        }
        var v = b.getAttribute("data-v") || null;
        if (v) state.raceSubBy[rid] = v; else delete state.raceSubBy[rid];
        manualNav(); // 手動のサブ変更＝発走直後の自動追従に上書きさせない（FB96）
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
    if (!races.length) {
      el.innerHTML = '<div class="hint">タイムテーブル取得中…（自動で再試行します。急ぐ時は「接続・診断」→再取得）</div>';
      return;
    }
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
        manualNav(true); // 手動のレース切替＝結果フォームの固定解除＋手動優先を通知（FB96）
        save();
        renderAll();
      });
    });
  }

  $("btn-narabi-save").addEventListener("click", function () {
    var key = predKey(); // 並びの手修正も入力先に追従（8/6 FB11）
    if (!key) return;
    if (!state.narabi) state.narabi = {};
    state.narabi[key] = $("narabi-input").value.trim();
    save();
  });

  // 出しっぱなし警告バー：タップで次レースへ切替（旧「次のレースへ」ボタンの代替）
  $("stale-warn").addEventListener("click", function () {
    var name = activeVenueName();
    if (!name) return;
    var next = nextRaceOf(name);
    if (next) {
      state.currentRace[name] = next.no;
      manualNav(true); // 手動のレース送り（FB96）
      save();
      renderAll();
    }
  });

  /* ---------- 予想の入力先（8/6 FB11：放送用の場・レース切替と分離） ----------
     editVenue=null＝放送に追従（従来どおり）。場を選ぶと入力先だけ固定＝上部の場・レースを
     切り替えても（＝②レース観戦の表示が変わっても）予想フォームの対象は動かない。
     コンソール内だけのローカル状態＝GASにも配信画面にも影響しない */
  var editVenue = null, editRace = null;
  function predKey() {
    if (editVenue && !state.venues.some(function (v) { return v.name === editVenue; })) { editVenue = null; editRace = null; }
    if (!editVenue) return currentKey();
    var rNo = editRace || state.currentRace[editVenue];
    return rNo ? window.Derive.raceKey(editVenue, rNo) : null;
  }
  function renderPredTarget() {
    var vr = $("pred-venue-row"), rg = $("pred-race-chips");
    if (!vr || !rg) return;
    if (!state.venues.length) { vr.innerHTML = ""; rg.innerHTML = ""; return; }
    vr.innerHTML = '<button class="vbtn' + (!editVenue ? " active" : "") + '" data-v="">放送に追従</button>' +
      state.venues.map(function (v) {
        var rNo = (editVenue === v.name && editRace) ? editRace : state.currentRace[v.name];
        return '<button class="vbtn' + (editVenue === v.name ? " active" : "") + '" data-v="' + esc(v.name) + '">' +
          esc(v.name) + "<small>" + (rNo ? rNo + "R" : "-") + "</small></button>";
      }).join("");
    vr.querySelectorAll(".vbtn").forEach(function (b) {
      b.addEventListener("click", function () {
        editVenue = b.getAttribute("data-v") || null;
        editRace = null;
        renderPredTarget();
        renderPredForms();
      });
    });
    if (!editVenue) { rg.innerHTML = ""; return; }
    var curNo = editRace || state.currentRace[editVenue];
    rg.innerHTML = venueRaces(editVenue).map(function (r) {
      return '<button class="rc' + (curNo === r.no ? " cur" : "") + '" data-no="' + r.no + '">' + r.no + "R<small>" + r.start + "</small></button>";
    }).join("");
    rg.querySelectorAll(".rc").forEach(function (b) {
      b.addEventListener("click", function () {
        editRace = +b.getAttribute("data-no");
        renderPredTarget();
        renderPredForms();
      });
    });
  }

  /* ---------- 予想入力 ---------- */
  function ensurePredEntry(key, racerId) {
    if (!state.preds[key]) state.preds[key] = { cars: 9, byRacer: {} };
    if (!state.preds[key].byRacer[racerId]) {
      state.preds[key].byRacer[racerId] = { text: "", defaultType: "3連単", unit: 100, investInput: null, oreTachi: "", isNote: false };
    }
    return state.preds[key].byRacer[racerId];
  }

  /* 入力途中の下書き保持（8/8 FB75）
     #pred-formsはstateから作り直すため、席替え・場切替・設定保存など別の操作をした瞬間に
     未保存の買い目が消えていた。入力のたびにdraftへ退避し、描画時はdraftを優先して復元する。
     draftはコンソールのメモリ内だけ＝サーバーには送らない（打ちかけが放送に出ることはない）。
     「この予想を保存」で破棄＝以後はstateの値が正。 */
  var predDrafts = {}; // key + " " + racerId → { text, invest, ore, note }
  function draftKey(key, racerId) { return key + " " + racerId; }

  function renderPredForms() {
    var key = predKey(); // 入力先＝放送に追従 or 固定（8/6 FB11）
    $("pred-target").textContent = (key ? key.replace("|", " ") + "R（" + effCars(key) + "車）" : "（場・レース未選択）") +
      (editVenue ? "　📌入力先を固定中" : "");
    $("pred-cars").value = (key && state.preds[key] && state.preds[key].carsFix) ? String(state.preds[key].carsFix) : "";
    $("narabi-input").value = key ? ((state.narabi || {})[key] || "") : "";
    var wrap = $("pred-forms");
    if (!key) { wrap.innerHTML = ""; return; }
    var race = state.preds[key] || { cars: 9 };

    // 打っている最中の再描画でカーソルが飛ばないよう、フォーカス位置と選択範囲を退避
    var ae = document.activeElement;
    var focus = null;
    if (ae && wrap.contains(ae)) {
      var af = ae.closest ? ae.closest(".pred-form") : null;
      focus = {
        racer: af ? af.getAttribute("data-racer") : null,
        cls: (String(ae.className).match(/pf-[a-z]+/) || [])[0],
        s: ae.selectionStart, e: ae.selectionEnd
      };
    }

    wrap.innerHTML = state.racers.map(function (rc, idx) {
      var p = (race.byRacer && race.byRacer[rc.id]) || { text: "", defaultType: "3連単", unit: 100, investInput: null, oreTachi: "", isNote: false };
      var d = predDrafts[draftKey(key, rc.id)]; // 未保存の入力があればそれを表示（消さない）
      var vText = d ? d.text : p.text;
      var vInvest = d ? d.invest : (p.investInput || "");
      var vOre = d ? d.ore : (p.oreTachi || "");
      var vNote = d ? d.note : !!p.isNote;
      return '<div class="pred-form" data-racer="' + rc.id + '">' +
        '<h3><span class="' + (idx === 1 ? "alt" : "") + '">' + esc(rc.name) + "</span> の予想</h3>" +
        '<textarea class="inp pf-text" rows="3" placeholder="例）1=9-2357&#10;メモ行はそのまま画面に出ます">' + esc(vText) + "</textarea>" +
        '<div class="parse-info pf-info"></div>' +
        '<div class="pred-opts">' +
        '<label class="lbl inline">俺たち目 <input type="text" class="inp slim pf-ore" value="' + esc(vOre) + '" placeholder="無料公開の1点（例 1-2-3）"></label>' +
        '<label class="lbl inline"><input type="checkbox" class="pf-note"' + (vNote ? " checked" : "") + '> note予想（勝負レース）</label>' +
        "</div>" +
        '<div class="pred-opts">' +
        // 式別は3連単固定（例外は買い目の行頭に「ワイド」等と書けば行単位で指定可）
        '<input type="hidden" class="pf-type" value="3連単">' +
        '<label class="lbl inline">投資額 <input type="number" class="inp slim pf-invest" value="' + esc(String(vInvest)) + '" placeholder="実際に買った総額">円</label>' +
        "</div>" +
        '<div class="parse-total pf-total"></div>' +
        '<button class="btn small pf-save">この予想を保存</button>' +
        "</div>";
    }).join("");

    wrap.querySelectorAll(".pred-form").forEach(function (form) {
      var racerId = form.getAttribute("data-racer");
      var stash = function () { // 1文字打つごとに下書きへ退避＝以後どんな再描画が来ても残る
        predDrafts[draftKey(key, racerId)] = {
          text: form.querySelector(".pf-text").value,
          invest: form.querySelector(".pf-invest").value,
          ore: form.querySelector(".pf-ore").value,
          note: form.querySelector(".pf-note").checked
        };
      };
      var update = function () { stash(); updatePredInfo(form, key); };
      ["pf-text", "pf-invest", "pf-ore"].forEach(function (cls) {
        form.querySelector("." + cls).addEventListener("input", update);
      });
      form.querySelector(".pf-note").addEventListener("change", update);
      form.querySelector(".pf-save").addEventListener("click", function () {
        var entry = ensurePredEntry(key, racerId);
        entry.text = form.querySelector(".pf-text").value;
        entry.defaultType = form.querySelector(".pf-type").value;
        entry.unit = 0; // 単価×点数方式は廃止（投資・回収とも実額入力）
        var inv = +form.querySelector(".pf-invest").value;
        entry.investInput = inv > 0 ? inv : null;
        entry.oreTachi = form.querySelector(".pf-ore").value.trim();
        entry.isNote = form.querySelector(".pf-note").checked;
        state.preds[key].cars = effCars(key);
        delete predDrafts[draftKey(key, racerId)]; // 保存できたので下書きは破棄
        save();
        renderSettlePreview();
        updatePredInfo(form, key);                 // 「未保存」表示を消す
      });
      update();
    });

    if (focus && focus.racer && focus.cls) { // カーソルを元の欄・元の位置へ戻す
      var back = wrap.querySelector('.pred-form[data-racer="' + focus.racer + '"] .' + focus.cls);
      if (back) {
        back.focus();
        if (focus.s !== null && focus.s !== undefined && back.setSelectionRange) {
          try { back.setSelectionRange(focus.s, focus.e); } catch (e) {}
        }
      }
    }
  }

  function updatePredInfo(form, key) {
    var cars = effCars(key); // 手動上書きがあれば優先（8/6 FB45）
    var type = form.querySelector(".pf-type").value;
    var parsed = window.Keirin.parsePrediction(form.querySelector(".pf-text").value, type, cars);
    form.querySelector(".pf-info").innerHTML = parsed.lines.map(function (l) {
      if (!l.ok) return '<div class="pl-memo">' + esc(l.raw.trim()) + "　→ メモ行（点数外）</div>";
      if (l.allDup) return '<div class="pl-memo">' + esc(l.raw.trim()) + "　→ 全部かぶり目（0点・画面に出ません）</div>";
      var dispNote = l.disp && l.disp !== window.Keirin.normalize(l.raw).replace(/\s+/g, "")
        ? '　<span class="pl-memo">画面表示 ' + esc(l.disp) + "</span>" : "";
      var dupNote = l.dupCount ? '　<span class="pl-memo">かぶり' + l.dupCount + "点除外</span>" : "";
      return '<div class="pl-ok">' + esc(l.raw.trim()) + "　→ " + esc(l.type) + " <b>" + l.points + "点</b>" + dupNote + dispNote + "</div>";
    }).join("");
    var investInput = +form.querySelector(".pf-invest").value || 0;
    var html = "合計 " + parsed.points + "点　投資 " + fmtYen(investInput);
    if (parsed.points > 0 && !investInput) {
      html += '<div class="unit-warn">⚠ 投資額が未入力（画面の投資・回収の累計に乗りません）</div>';
    }
    // 保存済みの値と違う＝まだ放送に出ていない（8/8 FB75・打ったのに出ていない事故防止）
    var racerId = form.getAttribute("data-racer");
    var saved = ((state.preds[key] || {}).byRacer || {})[racerId] || {};
    var dirty = form.querySelector(".pf-text").value !== (saved.text || "") ||
      (form.querySelector(".pf-invest").value || "") !== (saved.investInput ? String(saved.investInput) : "") ||
      form.querySelector(".pf-ore").value.trim() !== (saved.oreTachi || "") ||
      form.querySelector(".pf-note").checked !== !!saved.isNote;
    if (dirty) {
      html += '<div class="draft-warn">✏️ 未保存（「この予想を保存」を押すまで画面に出ません・入力は消えません）</div>';
    }
    // 俺たち目の入れ忘れ通知（8/9 FB97）：「買い目だけ先に保存して見せる→後から俺たち目」は
    // 正規の運用なのでブロックしない。保存済みの買い目があるのに俺たち目欄が空の間だけ知らせる
    // （欄に打ち始めたら消える＝入力の邪魔をしない）
    if (!form.querySelector(".pf-ore").value.trim() && (saved.text || "").trim()) {
      html += '<div class="unit-warn">⚠ 「俺たち目」が入力されていません（買い目だけの表示はOK・レースまでに入力→保存）</div>';
    }
    form.querySelector(".pf-total").innerHTML = html;
    form.classList.toggle("dirty", dirty);
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

  /* 結果入力も買い目と同じ事故が起きる（8/8 FB75）：着順・払戻を打っている途中に別操作で
     renderAllが走ると、下のstate反映でフォームが上書きされて消える。
     同じレースを表示したままで未確定の手入力があるときは、上書きをしない。 */
  var resDirty = false;
  var resKeyShown = null;
  function markResDirty() { resDirty = true; }
  /* 結果フォームの対象レース（8/9 FB96対応＝FB75の延長）：
     入力途中（resDirty）の間は表示中のレース（resKeyShown）に固定＝自動追従（発走・②切替）で
     currentKeyが動いても、打ちかけの着順・払戻・回収を巻き込まない。
     手動のレース移動（場ボタン・レースチップ等）は manualNav(true) で固定を解除＝従来どおり仕切り直し */
  function resultKey() { return (resDirty && resKeyShown) ? resKeyShown : currentKey(); }

  function renderResultForm() {
    var key = resultKey(); // 入力途中は表示中のレースに固定（自動追従で巻き戻さない・FB96）
    $("result-target").textContent = (key ? key.replace("|", " ") + "R" : "（場・レース未選択）") +
      (resDirty && key !== currentKey() ? "　📌入力途中のため固定中（レースを選ぶと切替）" : "");
    if (key !== resKeyShown) { resDirty = false; resKeyShown = key; } // レースが変わったら仕切り直し
    else if (resDirty) {                                             // 入力途中＝触らずに帰る
      renderPayoutRows();
      renderSettlePreview();
      renderResultHint();
      return;
    }
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
    refundInputs = {};
    if (existing && existing.refunds) {
      Object.keys(existing.refunds).forEach(function (pid) { refundInputs[pid] = existing.refunds[pid]; });
    }
    syncPayoutPresets();
    renderResultHint();
  }

  /** 払戻は3連単のみ扱う（買い目が3連単運用のため・8/4）。例外形式は「行を追加」で手動追加 */
  function keepPayouts(payouts) {
    return (payouts || []).filter(function (p) { return p.type === "3連単"; });
  }

  /** 着順から標準の払戻行を用意（入力済み金額は保持） */
  function syncPayoutPresets() {
    var order = parseOrderInput();
    if (order && order.length >= 2) {
      // プリセット行は3連単のみ（買い目が3連単運用のため・8/4）。他形式は「行を追加」か自動取得で入る
      window.Keirin.standardCombos(order).filter(function (sc) { return sc.type === "3連単"; }).forEach(function (sc) {
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
        markResDirty();
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

  // 着順・選手名・決まり手の手入力も「入力途中」として保護する（8/8 FB75）
  $("res-order").addEventListener("input", function () { markResDirty(); syncPayoutPresets(); });
  ["res-name-1", "res-name-2", "res-name-3", "res-kim-1", "res-kim-2"].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener("input", markResDirty);
  });

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
    var key = resultKey(); // 結果フォームと同じレースを見る（固定中はそのレース・FB96）
    var el = $("settle-preview");
    var order = parseOrderInput();
    if (!key || !order) { el.innerHTML = '<span class="miss">着順を入力すると的中・回収のプレビューが出ます</span>'; return; }
    var payouts = payoutRows.filter(function (p) { return p.amount > 0; });
    el.innerHTML = state.racers.map(function (rc) {
      var rp = window.Derive.resolvePred(state, key, rc.id);
      var s = window.Keirin.settle(rp.parsed, 0, order, payouts);
      var oreHtml = "";
      if (rp.entry.oreTachi) {
        var op = window.Keirin.parsePrediction(window.Keirin.oreNormalize(rp.entry.oreTachi), "3連単", (state.preds[key] || {}).cars || 9);
        var oh = window.Keirin.settle(op, 0, order, payouts).hits;
        if (oh.length) {
          oreHtml = oh[0].amount
            ? ' <span class="hit">🎯 俺たち目 ' + oh[0].comboLabel + " " + oh[0].mult + "倍</span>"
            : ' <span class="manche">🎯 俺たち目 ' + oh[0].comboLabel + " 払戻未入力</span>";
        }
      }
      if (!rp.points && !oreHtml) return "<div>" + esc(rc.name) + "：予想なし</div>";
      if (!s.hits.length) return "<div>" + esc(rc.name) + '：<span class="miss">不的中</span>（投資 ' + fmtYen(rp.invest) + "）" + oreHtml + "</div>";
      var refund = refundInputs[rc.id];
      return "<div>" + esc(rc.name) + "：" + s.hits.map(function (h) {
        if (!h.amount) return '<span class="manche">🎯 ' + h.type + " " + h.comboLabel + " 払戻未入力</span>";
        return '<span class="' + (h.manche ? "manche" : "hit") + '">🎯 ' + h.type + " " + h.comboLabel + " " + h.mult + "倍</span>";
      }).join(" ") + oreHtml +
        '　回収 <input type="number" class="inp sp-refund" data-racer="' + esc(rc.id) + '" value="' + (refund > 0 ? refund : "") + '" placeholder="実額">円</div>';
    }).join("");
    el.querySelectorAll(".sp-refund").forEach(function (inp) {
      inp.addEventListener("input", function () {
        refundInputs[inp.getAttribute("data-racer")] = +inp.value || 0;
        markResDirty();
      });
    });
  }

  $("btn-settle").addEventListener("click", function () {
    var key = resultKey(); // フォームに出ているレースを確定する（固定中でも取り違えない・FB96）
    if (!key) return;
    var order = parseOrderInput();
    if (!order) { $("settle-preview").innerHTML = '<span class="manche">着順が読めません（例：1-9-2）</span>'; return; }
    // 的中しているのに払戻が未入力なら確定させない（0倍の的中速報が画面に載る事故防止）
    var validPayouts = payoutRows.filter(function (p) { return p.amount > 0; });
    var missing = [];
    var missingRefund = [];
    state.racers.forEach(function (rc) {
      var rp = window.Derive.resolvePred(state, key, rc.id);
      var s = window.Keirin.settle(rp.parsed, 0, order, validPayouts);
      s.hits.forEach(function (h) {
        var label = h.type + " " + h.comboLabel;
        if (!h.amount && missing.indexOf(label) < 0) missing.push(label);
      });
      // 俺たち目の的中も払戻必須（0倍でティッカーに載る事故防止）
      if (rp.entry.oreTachi) {
        var op = window.Keirin.parsePrediction(window.Keirin.oreNormalize(rp.entry.oreTachi), "3連単", (state.preds[key] || {}).cars || 9);
        window.Keirin.settle(op, 0, order, validPayouts).hits.forEach(function (h) {
          var label = h.type + " " + h.comboLabel + "（俺たち目）";
          if (!h.amount && missing.indexOf(label) < 0) missing.push(label);
        });
      }
      // 投資額が入っている予想が的中したのに回収額未入力→確定不可（回収¥0が画面に載る事故防止）
      if (s.hits.length && rp.invest > 0 && !(refundInputs[rc.id] > 0)) missingRefund.push(rc.name);
    });
    if (missing.length) {
      $("settle-preview").innerHTML = '<span class="manche">⚠ 的中買目の払戻が未入力：' + missing.map(esc).join(" / ") +
        "　→ 上の払戻欄に入力すると倍率を計算して確定できます</span>";
      return;
    }
    if (missingRefund.length) {
      renderSettlePreview();
      $("settle-preview").insertAdjacentHTML("beforeend",
        '<div class="manche">⚠ 回収額が未入力：' + missingRefund.map(esc).join(" / ") +
        "　→ 投票サイトの的中金額をそのまま入力してください</div>");
      return;
    }
    var refunds = {};
    Object.keys(refundInputs).forEach(function (pid) {
      if (refundInputs[pid] > 0) refunds[pid] = refundInputs[pid];
    });
    state.results[key] = {
      order: order,
      names: [$("res-name-1").value.trim(), $("res-name-2").value.trim(), $("res-name-3").value.trim()],
      kimarite: [$("res-kim-1").value.trim(), $("res-kim-2").value.trim(), ""],
      payouts: payoutRows.filter(function (p) { return p.amount > 0; }),
      refunds: refunds,
      settledAt: new Date().toISOString(),
    };
    state.resultView = key; // ③結果シーンに即反映
    resDirty = false;       // 確定できた＝以後はstateの値が正（8/8 FB75）
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
    if (filled.length) markResDirty(); // 貼り付けで入った値も確定前＝再描画で消させない（8/8 FB75）
    renderPayoutRows();
    renderSettlePreview();
    $("paste-hint").textContent = filled.length
      ? "転記: " + filled.join(" / ") + "　※内容を確認してから確定してください"
      : "読み取れる形式が見つかりませんでした（手入力してください）";
  });

  /* ---------- 的中速報管理 ---------- */
  function renderHitAdmin() {
    var derived = window.Derive.day(state);
    var cnt = $("hit-count");
    if (cnt) cnt.textContent = derived.hits.length ? "本日 " + derived.hits.length + "件" : "";
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
        else { if (selected.length >= 4) selected.shift(); selected.push(n); } // 最大4場（モーニング→昼の並走帯対応）
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
    var noneOpt = '<option value="">（なし・空席）</option>';
    $("racer-1").innerHTML = noneOpt + opts;
    $("racer-2").innerHTML = noneOpt + opts;
    var bySeat = { a: "", b: "" };
    (state.racers || []).forEach(function (r, i) {
      var s = (r.seat === "a" || r.seat === "b") ? r.seat : (i === 0 ? "a" : "b");
      if (!bySeat[s]) bySeat[s] = r.name;
    });
    $("racer-1").value = bySeat.a;
    $("racer-2").value = bySeat.b;
    $("roster").value = state.roster.map(function (r) {
      return r.name + (r.color ? " " + r.color : "");
    }).join("\n");
    $("cfg-close").value = state.cfg.closeMin;
    $("cfg-netclose").value = state.cfg.netCloseMin;
    $("cfg-autoresults").checked = !!state.cfg.autoResults;
    $("cfg-autoscene").checked = state.cfg.autoScene !== false; // 発走時刻の自動シーン切替（8/9 FB95・既定ON）
    $("cfg-autoalign").checked = state.cfg.autoAlign !== false; // 予想レースの自動追従（8/9 FB96・既定ON）
    $("note-races").value = state.noteRaces || "";
    $("campaign-count").value = (state.campaignCount === null || state.campaignCount === undefined) ? "" : state.campaignCount;
  }

  function saveSettings() {
    state.roster = $("roster").value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean)
      .map(function (line) {
        var parts = line.split(/\s+/);
        return { name: parts[0], color: parts.slice(1).join(" ") };
      });
    var colorFor = function (name) {
      var m = state.roster.filter(function (r) { return r.name === name; })[0];
      return m ? m.color : "";
    };
    // 席1(a)＝左カメラ／席2(b)＝右カメラ。空＝空席（1人配信はどちらの席でも可）。
    // IDは人ベース（＝名前）：席替え・シフト交代しても実績が付け替わらない。同名の重複選択は席1優先
    var picks = [{ name: $("racer-1").value, seat: "a" }, { name: $("racer-2").value, seat: "b" }];
    state.racers = [];
    picks.forEach(function (p) {
      if (!p.name) return;
      if (state.racers.some(function (r) { return r.name === p.name; })) return;
      state.racers.push({ id: p.name, name: p.name, color: colorFor(p.name), seat: p.seat });
    });
    document.querySelectorAll(".grade-inp").forEach(function (inp) {
      state.grade[inp.getAttribute("data-n")] = inp.value.trim();
    });
    state.cfg.closeMin = +$("cfg-close").value || 3;
    state.cfg.netCloseMin = +$("cfg-netclose").value || 5;
    state.cfg.autoResults = $("cfg-autoresults").checked;
    state.cfg.autoScene = $("cfg-autoscene").checked; // 8/9 FB95
    state.cfg.autoAlign = $("cfg-autoalign").checked; // 8/9 FB96
    state.noteRaces = $("note-races").value.split(/\r?\n/)
      .map(function (s) { return s.trim(); }).filter(Boolean).join("\n");
    state.campaignCount = $("campaign-count").value === "" ? null : +$("campaign-count").value;
    ensureTalkRaces(); // 場の構成が変わったら表示場リストを整える
    save();
    renderAll();
  }
  // 車数の手動上書き（8/6 FB45）：選んだ瞬間に保存＝「全」の展開・点数が即その車数基準になる
  $("pred-cars").addEventListener("change", function () {
    var key = predKey();
    if (!key) return;
    if (!state.preds[key]) state.preds[key] = { cars: 9, byRacer: {} };
    state.preds[key].carsFix = +$("pred-cars").value || null;
    state.preds[key].cars = effCars(key);
    save();
    renderPredForms();
  });

  $("btn-save-settings").addEventListener("click", saveSettings);
  // 席替え：席1⇄席2を入れ替えて即保存（座り位置の変更に1タップで追従）
  $("btn-seat-swap").addEventListener("click", function () {
    var a = $("racer-1").value;
    $("racer-1").value = $("racer-2").value;
    $("racer-2").value = a;
    saveSettings();
  });
  /* 席替えのクイックボタン（8/8 FB74）：本日設定を開かずに1タップで入替＋確定。
     本日設定のフォームは読まない＝編集途中の未保存項目を巻き込んで保存しないため。
     席は a(左カメラ)⇄b(右カメラ) の入替のみ＝もう一度押せば元に戻る（1人配信は席の移動になる） */
  $("btn-seat-swap-quick").addEventListener("click", function () {
    var btn = this;
    if (!(state.racers || []).length) { // 誰も選ばれていない＝入れ替える席がない
      btn.textContent = "本日設定で配信者を選択";
      setTimeout(function () { btn.textContent = "⇄ 席替え"; }, 2000);
      return;
    }
    (state.racers || []).forEach(function (r, i) {
      var s = (r.seat === "a" || r.seat === "b") ? r.seat : (i === 0 ? "a" : "b");
      r.seat = (s === "a") ? "b" : "a";
    });
    save();
    renderAll();
    btn.classList.add("done");
    btn.textContent = "⇄ 入替えました";
    setTimeout(function () { btn.classList.remove("done"); btn.textContent = "⇄ 席替え"; }, 2000);
  });

  /* キャンペーン応募人数のクイック増減（8/9 FB98）：配信中に応募が入るたび更新する運用のため、
     本日設定を開かず「場・レース」カード見出しの＋1/−1で1タップ確定（席替えクイックFB74と同じ
     即時保存・本日設定フォームは読まない）。現在人数も隣に常時表示。
     バナーの表示ON/OFF（空欄化）は従来どおり本日設定側で行う（−1は0で止まる＝非表示にはならない） */
  function campCount() {
    if (!state) return null;
    var v = state.campaignCount;
    return (v === null || v === undefined || v === "") ? null : +v;
  }
  function renderCampQuick() {
    var el = $("camp-quick-num");
    if (!el || !state) return;
    var n = campCount();
    el.textContent = "応募 " + (n === null ? "—" : n.toLocaleString("ja-JP") + "人");
  }
  function campQuickAdd(d) {
    if (!state) return;
    var cur = campCount();
    if (cur === null) {
      if (d < 0) return; // バナー非表示中の−1は何もしない（＋1で「1人」から表示開始）
      cur = 0;
    }
    state.campaignCount = Math.max(0, cur + d);
    save();
    renderAll();
  }
  $("btn-camp-plus").addEventListener("click", function () { campQuickAdd(1); });
  $("btn-camp-minus").addEventListener("click", function () { campQuickAdd(-1); });

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
    // 前日の自動取得キャッシュを破棄（残すと自動確定が前日の結果を新しい日に書き戻す・8/6修正）
    autoResults = {};
    payoutRows = [];
    refundInputs = {};
    predDrafts = {};   // 前日の書きかけを持ち越さない（8/8 FB75）
    resDirty = false;
    resKeyShown = null;
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
        warn.textContent = "⚠ " + name + rNo + "R は発走済み → タップで " + next.no + "R（" + next.start + "）へ切替";
        warn.classList.remove("hidden");
      } else {
        warn.classList.add("hidden");
      }
    } else {
      warn.classList.add("hidden");
    }

    // 俺たち目の入れ忘れ警告バー（8/9 FB97）：次のレースが発走10分前を切っても、
    // 買い目だけ保存されて俺たち目が空のままの配信者がいたら上部バーで知らせる。
    // 保存・表示は一切ブロックしない（買い目先出しの運用が正）。タップで入力先を
    // そのレースに固定（📌）して予想入力へジャンプ＝1タップで書ける
    var ow = $("ore-warn");
    if (ow) {
      var oreMiss = [];
      if (best && best.startSec - now <= 600 && now < best.startSec) {
        var obr = (state.preds[window.Derive.raceKey(best.name, best.no)] || {}).byRacer || {};
        (state.racers || []).forEach(function (rc) {
          var p = obr[rc.id];
          if (p && (p.text || "").trim() && !(p.oreTachi || "").trim()) oreMiss.push(rc.name);
        });
      }
      if (oreMiss.length) {
        ow.textContent = "⚠ 俺たち目が未入力：" + best.name + best.no + "R（" + oreMiss.join("・") + "）→ タップで予想入力へ";
        ow.classList.remove("hidden");
        ow.onclick = function () {
          editVenue = best.name;
          editRace = best.no;
          var card = $("pred-forms").closest("details");
          if (card) card.open = true;
          renderPredTarget();
          renderPredForms();
          $("pred-forms").scrollIntoView({ behavior: "smooth" });
        };
      } else {
        ow.classList.add("hidden");
        ow.onclick = null;
      }
    }
  }

  /* ---------- 発走・②切替に合わせた予想レースの自動追従（8/9 FB96） ----------
     目的：②レース観戦に切り替わった瞬間の「メイン予想・サブ予想・映像のレースがバラバラ」を根治。
     トリガー2系統：
       ①発走時刻（毎秒エッジ検知・1レース1回）＝FB95の自動シーン切替と同じ瞬間に盤面も合う
       ②オーバーレイ②が表示された瞬間（BC通知）＝手動でシーンを切り替えた場合も合う
     合わせ方＝メイン：映像に映っているはずのレース／サブ：その次に発走するレース
       （別の場のときだけ・サブONの配信者のみ。1場運用ではサブは触らない＝derive.alignToRace参照）。
     自動で合わせた後の手動変更は自由＝次のトリガーまで上書きしない。
     発走後すでに手動で盤面を触っていた場合も手動優先（そのレースぶんの発走トリガーは譲る）。
     ON/OFF＝本日設定「発走・②切替時に予想レースを自動で合わせる」（既定ON） */
  var alignDone = {};        // 日付|場|R → 発走トリガー済み（FB71の教訓＝日付をキーに含める）
  var lastManualNavSec = -1; // 場・レース・サブを手で切り替えた時刻（0時からの秒）
  var ALIGN_WIN = 60;   // 発走エッジの有効幅（ドックが裏に回りタイマーが間引かれても拾える幅）
  var ALIGN_LIVE = 240; // ②切替時、発走からこの秒数まではそのレースが映像に映っているとみなす

  function manualNav(resetResult) {
    lastManualNavSec = nowSec();
    if (resetResult) resDirty = false; // 手動のレース移動＝結果フォームの固定も解除（仕切り直し）
  }
  function selectedRaces() {
    var out = [];
    ((state && state.venues) || []).forEach(function (v) {
      venueRaces(v.name).forEach(function (r) {
        var s = timeToSec(r.start);
        if (s !== null) out.push({ venue: v.name, no: r.no, startSec: s });
      });
    });
    return out;
  }
  function alignBoard(race) {
    if (!state || state.cfg.autoAlign === false || state.date !== todayStr()) return;
    if (window.Derive.alignToRace(state, selectedRaces(), race)) {
      save();
      renderAll();
    }
  }
  function autoAlignTick() {
    if (!state || !timetable || !state.venues.length) return;
    if (state.cfg.autoAlign === false || state.date !== todayStr()) return;
    var just = window.Derive.justStartedRace(selectedRaces(), nowSec(), ALIGN_WIN);
    if (!just) return;
    var k = todayStr() + "|" + just.venue + "|" + just.no;
    if (alignDone[k]) return;
    alignDone[k] = true;
    if (lastManualNavSec >= just.startSec) return; // 発走後すでに手で動かした＝手動優先
    alignBoard(just);
  }

  /* ---------- 結果の自動取得（keirin.jp JSJ018・60秒ポーリング） ----------
     取得結果はいったんautoResultsに保持し、
     ・自動確定OFF（既定）＝結果入力フォームに「⚡取得済み→反映」ボタンを出す（確定は人が1タップ）
     ・自動確定ON＝未確定レースへ即時反映→§8の的中判定〜演出まで人手ゼロ */
  var autoResults = {}; // raceKey → {no, order, names, kimarite, payouts}

  function joCodeOfName(name) {
    var jo = null;
    if (timetable) {
      (timetable.venues || []).forEach(function (tv) { if (tv.name === name) jo = tv.joCode; });
    }
    return jo;
  }

  /* 未発走レースに付いた自動確定の結果を除去する自己修復（8/6）。
     日付境界（深夜〜朝）はkeirin.jpの「本日の結果」がまだ前日の内容を返すため、混入が起きうる。
     手入力の結果は対象外。日跨ぎ運用（state.dateが前日のまま）は誤爆防止のためスキップ */
  function purgeGhostResults() {
    if (!state || !timetable || state.date !== todayStr()) return;
    var changed = false;
    Object.keys(state.results || {}).forEach(function (key) {
      var r = state.results[key];
      if (!r || !r.auto) return;
      var parts = key.split("|");
      var races = venueRaces(parts[0]).filter(function (x) { return x.no === +parts[1]; });
      var s = races.length ? timeToSec(races[0].start) : null;
      if (s !== null && nowSec() < s + 120) { delete state.results[key]; changed = true; }
    });
    if (changed) { save(); renderAll(); }
  }

  function pollResults(force) {
    if (!state || !timetable || !state.venues.length) return Promise.resolve();
    purgeGhostResults();
    return Promise.all(state.venues.map(function (v) {
      var jo = joCodeOfName(v.name);
      if (!jo) return null;
      return window.Sync.fetchResults(jo, force).then(function (list) {
        (list || []).forEach(function (r) {
          // 発走前のレースに「結果」が来たら捨てる（前日データの混入・8/6）。日跨ぎ運用時は従来通り
          if (state.date === todayStr()) {
            var races = venueRaces(v.name).filter(function (x) { return x.no === r.no; });
            var s = races.length ? timeToSec(races[0].start) : null;
            if (s !== null && nowSec() < s + 120) return;
          }
          autoResults[window.Derive.raceKey(v.name, r.no)] = r;
        });
        applyAutoResults();
        renderResultHint();
      }).catch(function () { /* 次回ポーリングで再試行 */ });
    }));
  }

  $("btn-res-refresh").addEventListener("click", function () {
    var hint = $("res-refresh-hint");
    hint.textContent = "取得中…";
    pollResults(true).then(function () {
      var key = resultKey();
      var got = key && (autoResults[key] || (state.results && state.results[key]));
      hint.textContent = got ? "" : "公式の結果がまだ出ていません（確定し次第、自動で反映されます）";
    });
  });

  function applyAutoResults() {
    if (!state || !state.cfg || !state.cfg.autoResults) return;
    var addedKey = null;
    Object.keys(autoResults).forEach(function (key) {
      if (state.results[key]) return; // 手入力済み・確定済みは触らない
      var r = autoResults[key];
      if (!r.order || r.order.length < 2 || !r.payouts || !r.payouts.length) return;
      state.results[key] = {
        order: r.order.slice(),
        names: (r.names || []).slice(),
        kimarite: (r.kimarite || []).slice(),
        payouts: keepPayouts(r.payouts).map(function (p) { return { type: p.type, combo: p.combo.slice(), amount: p.amount }; }),
        settledAt: new Date().toISOString(),
        auto: true,
      };
      addedKey = key;
    });
    if (addedKey) {
      state.resultView = addedKey; // ③結果シーンに最新レースを表示
      save();
      renderAll();
    }
  }

  function applyAutoToForm(key) {
    var r = autoResults[key];
    if (!r) return;
    $("res-order").value = r.order.join("-");
    for (var i = 0; i < 3; i++) $("res-name-" + (i + 1)).value = (r.names && r.names[i]) || "";
    $("res-kim-1").value = (r.kimarite && r.kimarite[0]) || "";
    $("res-kim-2").value = (r.kimarite && r.kimarite[1]) || "";
    payoutRows = keepPayouts(r.payouts).map(function (p) { return { type: p.type, combo: p.combo.slice(), amount: p.amount }; });
    markResDirty();      // プリフィルも「確定前の入力」＝再描画で消させない（8/8 FB75）
    syncPayoutPresets(); // 標準行の補完＋的中プレビュー再計算
  }

  function renderResultHint() {
    var el = $("auto-result-hint");
    if (!el) return;
    var key = resultKey(); // 結果フォームと同じレースの⚡を出す（固定中はそのレース・FB96）
    var r = key ? autoResults[key] : null;
    if (!r || (state.results && state.results[key])) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    var p3 = (r.payouts || []).filter(function (p) { return p.type === "3連単"; })[0];
    el.classList.remove("hidden");
    el.innerHTML = "⚡ 結果を自動取得済み：着順 " + r.order.join("-") +
      (p3 ? "（3連単 " + p3.amount.toLocaleString("ja-JP") + "円）" : "") +
      '　<button class="btn small" id="btn-auto-fill">フォームに反映</button>';
    var btn = $("btn-auto-fill");
    if (btn) btn.addEventListener("click", function () { applyAutoToForm(key); });
  }

  setInterval(pollResults, 60000);

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
  // 本日のデータをリセット（8/6）：日付はそのまま、予想・結果・的中だけ全消去。
  // 「新しい日を開始」は日付が変わった時しか出ないため、当日中のテストデータ掃除用に常設
  var dayResetArmed = false;
  $("btn-day-reset").addEventListener("click", function () {
    if (!dayResetArmed) {
      dayResetArmed = true;
      $("btn-day-reset").textContent = "本当にリセット（予想・結果・的中を全消去）";
      $("btn-day-reset").classList.add("confirm");
      setTimeout(function () { // 10秒で解除（誤爆防止）
        dayResetArmed = false;
        $("btn-day-reset").textContent = "本日のデータをリセット";
        $("btn-day-reset").classList.remove("confirm");
      }, 10000);
      return;
    }
    state.preds = {};
    state.results = {};
    state.hitsManual = [];
    state.hitsHidden = [];
    state.resultView = null;
    state.narabi = {};
    autoResults = {};
    payoutRows = [];
    refundInputs = {};
    dayResetArmed = false;
    $("btn-day-reset").textContent = "本日のデータをリセット";
    $("btn-day-reset").classList.remove("confirm");
    save();
    renderAll();
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

  /* 回収未入力の的中を横断チェック（結果の自動確定は回収を知らないため）。
     警告バーのタップで該当レースへジャンプ→回収を入れて再確定してもらう */
  function checkRefundGaps() {
    var el = $("refund-warn");
    if (!el || !state) return;
    var gap = null;
    Object.keys(state.results || {}).forEach(function (key) {
      if (gap) return;
      var s = window.Derive.settleRace(state, key);
      if (!s) return;
      Object.keys(s.byRacer).forEach(function (pid) {
        var r = s.byRacer[pid];
        if (!gap && r.hits.length && r.invest > 0 && !r.refund) gap = { key: key, pid: pid };
      });
    });
    if (!gap) { el.classList.add("hidden"); el.textContent = ""; el.onclick = null; return; }
    var parts = gap.key.split("|");
    el.textContent = "⚠ 回収額が未入力の的中：" + parts[0] + parts[1] + "R（" + gap.pid + "）→ タップでこのレースを開く";
    el.classList.remove("hidden");
    el.onclick = function () {
      var idx = -1;
      state.venues.forEach(function (v, i) { if (v.name === parts[0]) idx = i; });
      if (idx < 0) return;
      state.activeVenue = idx;
      state.currentRace[parts[0]] = +parts[1];
      manualNav(true); // 回収入力のための手動ジャンプ（FB96）
      save();
      renderAll();
    };
  }

  /* ---------- 描画一括 ---------- */
  function renderAll() {
    renderVenueRow();
    renderCampQuick();
    renderRaceChips();
    renderRaceSubRow();
    renderPredTarget();
    renderPredForms();
    renderResultForm();
    renderHitAdmin();
    renderSettings();
    renderAssets();
    renderDiag();
    checkNewDay();
    checkRefundGaps();
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

  window.Sync.initChannel(function (msg) { // pong受信でbcAliveが立つ
    // ②レース観戦が表示された瞬間（オーバーレイからのBC通知・8/9 FB96）＝
    // タイマー基準の「映像に映っているはずのレース」へ盤面を合わせる。
    // 直前45秒以内に手動で盤面を触っていたら手動優先（特別なレースを出したまま切り替えられる）
    if (msg && msg.type === "sceneShown" && msg.scene === "race") {
      if (lastManualNavSec >= 0 && nowSec() - lastManualNavSec < 45) return;
      alignBoard(window.Derive.videoRaceAt(selectedRaces(), nowSec(), ALIGN_LIVE));
    }
  });

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
    pollResults();
  }).catch(function (e) {
    setSync("err", "GAS接続失敗: " + e.message);
    state = window.Derive.defaultState(todayStr());
    renderAll();
  });

  /* タイムテーブル：失敗したら15秒後に自動リトライ＋10分ごとに定期再取得。
     （旧実装は起動時1回きり・失敗すると無言でチップが空のままになるバグがあった） */
  function loadTimetable() {
    window.Sync.fetchTimetable(0).then(function (t) {
      timetable = t;
      renderAll();
      pollResults();
    }).catch(function () {
      setTimeout(loadTimetable, 15000);
    });
  }
  loadTimetable();
  setInterval(loadTimetable, window.APP_CONFIG.TT_POLL_MS || 600000);

  setInterval(function () { tickStatus(); autoAlignTick(); }, 1000); // 自動追従は毎秒エッジ検知（8/9 FB96）
})();
