/* console.js — 配信コンソール（OBSカスタムドック）
   操作は3つだけ：①予想を打つ ②投資額を打つ ③結果を入れる（§8）
   画面上の数字（点数・投資・回収・的中速報・結果パネル）はすべて自動計算。
   書込にはURLの ?key= が必要（初回入力後はlocalStorageに保持）。 */

(function () {
  var params = new URLSearchParams(location.search);
  var KEY = params.get("key") || localStorage.getItem("console_key") || "";
  if (params.get("key")) localStorage.setItem("console_key", params.get("key"));

  /* 保守用の項目を表示する（8/12 Naoto要望）。
     名簿・締切オフセットは配信者が触る場面が無く、画面を圧迫するだけなので既定で隠す。
     ⚠️隠すのはCSSだけで、入力欄はDOMに残したまま値も入れる。
     save() がこの欄を読み戻して state に書くので、要素を消すと保存のたびに
     名簿が空・締切が既定値で上書きされる（＝チームカラーが全部飛ぶ）。
     変更が要るときは URL に &admin=1 を付けて開く。 */
  if (params.get("admin") === "1") document.documentElement.classList.add("admin-on");

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
  var stateLoaded = false;  // GASから一度でも正しく読めたか。falseの間は保存を止める（空上書き防止）
  var timetable = null;
  var payoutRows = [];     // 結果入力中の払戻行（ローカル編集用）
  /* 回収は「枚数」で入れる（8/27 FB146・1枚＝100円）。金額は 払戻(100円あたり)×枚数 で自動計算。
     キー＝配信者id + "|" + 式別 + " " + 買い目（＝1レースで複数の的中買目があっても取り違えない）。
     ⚠️stateに保存するのは従来どおり回収「額」（results.refunds）＝derive/オーバーレイは無改修。
        枚数は再編集用に results.refundUnits へ併記する */
  var unitInputs = {};     // "配信者id|3連単 1-2-3" → 枚数
  var saveCount = 0;
  var savePending = false;
  var saveRunning = false;

  /* ---------- 保存（直列キュー・最終状態が必ず載る） ---------- */
  function save() {
    if (!KEY) { setSync("err", "書込キー未設定"); return; }
    /* まだ一度も読めていない＝手元のstateは仮の器。ここで保存すると本物を空で上書きする（8/12） */
    if (!stateLoaded) { setSync("err", "未接続のため保存しません（接続できるまでお待ちください）"); return; }
    /* ⚠️キューより前に流す（8/12）。オーバーレイ・展開ボードへの反映はGAS保存の完了を待たない。
       ここを下に置くと、前の保存がGAS待ちの間の操作が画面に出ず「切り替えたのに変わらない」になる */
    window.Sync.broadcastState(state);
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
  /* ⚠️8/27 FB138で「車数」セレクタ（手動上書き＝旧carsFix・旧effCars）を撤去（Naoto「自動でOK」）。
     以後は車数＝この自動判定のみ。上書きが必要な事態（keirin.jpの出走表が壊れている等）が
     起きたら、まずautoCarsの判定側を直す。旧stateにcarsFixが残っていても読まない＝無害 */

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
        // 見出しは②サブ予想と揃える（8/27 FB142・①→②の並びにしたのに①側だけ無名だったため）。
        // 「最大3場」は見出しに移したので行のラベルは名前だけ＝②と同じ形・狭いドックでの折返しも減る
        sr.innerHTML = '<div class="lbl">①トーク（画面に出す場）：配信者ごとに最大3場（押した順＝表示順）</div>' +
          state.racers.map(function (rc) {
            var list = state.talkRaces[rc.id] || [];
            return '<div class="row gap">' +
              '<span class="lbl inline">' + esc(rc.name) + '</span>' +
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
     ⚠️ONにしたらOBS側でカメラ1/2の移動が必要（セットアップ手順の「②サブ予想モード」参照）
     ⚠️8/27 FB137で「▶ 次Rへ」ボタンを撤去（Naoto「押すタイミングが分からない・不要」）。
        サブのR送りは本日設定「発走・②切替時に予想レースを自動で合わせる」（既定ON・Derive.alignToRace）
        が担う＝発走のたびにサブは次に発走する場・レースへ自動で移る。
        手で送りたい時は場ボタンでその場に切り替え→レースチップを押す（メインも動く点は従来どおり） */
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
          "</div>";
      }).join("");
    el.querySelectorAll(".vp").forEach(function (b) {
      b.addEventListener("click", function () {
        var rid = b.getAttribute("data-rid");
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
    /* 8/27 FB139（Naoto「放送に追従ボタンの意味が分かりづらい」）＝常設をやめ、固定中だけ出す。
       ⚠️このボタンは固定を解除する唯一の手段（他は「固定先の場が本日の場から外れた時」と再読み込みだけ）
       なので、無くすのではなく「固定した時だけ現れる」形にした。
       追従中は放送中の場に .live の印を付ける＝ボタンが消えても「今どこに書いているか」が分かるように */
    var liveVenue = activeVenueName();
    vr.innerHTML =
      (editVenue ? '<button class="vbtn unpin" data-v="" title="入力先の固定を外して放送に追従へ戻す">📌解除<small>放送に追従</small></button>' : "") +
      state.venues.map(function (v) {
        var rNo = (editVenue === v.name && editRace) ? editRace : state.currentRace[v.name];
        var isLive = !editVenue && v.name === liveVenue;
        return '<button class="vbtn' + (editVenue === v.name ? " active" : (isLive ? " live" : "")) + '" data-v="' + esc(v.name) + '"' +
          (isLive ? ' title="いま放送中の場＝追従中はここに書かれます"' : ' title="この場に入力先を固定する（放送の表示は変わりません）"') + '>' +
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

  /* note勝負レースに書いたレース＝note予想チェックの既定ON（8/10 FB117・Naoto依頼「デフォルトで
     入ってた方が配信者もありがたい」）。⚠️適用は「保存済みも下書きもない新規フォームの初期値」だけ：
     一度保存/操作した値は再評価しない。勝負レース一覧の終了自動間引き（FB114）は表示側だけで
     state.noteRacesは不変のため、レースが終わって一覧から消えても保存済みチェックは外れない */
  function isNoteRaceDefault(key, rc) {
    if (!key || !rc || !rc.name) return false;
    var parts = key.split("|");
    var venue = parts[0], rNo = String(+parts[1]);
    var lines = String(state.noteRaces || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      // 名前の照合は表記ゆれ込み（8/15 FB135・上部バナーと同じDeriveの判定を使う）＝
      // 「むねお／ムネオ」「ピータ／ピーター」どちらで書いても本人のレースとして拾う
      if (!window.Derive.nameHit(l, rc.name) || l.indexOf(venue) < 0) continue;
      var digits = (window.Derive.stripName(l, rc.name).split(venue).join(" ")
        .replace(/[０-９]/g, function (c) { return String("０１２３４５６７８９".indexOf(c)); })
        .match(/\d+/g)) || [];
      if (digits.indexOf(rNo) >= 0) return true;
    }
    return false;
  }

  /* 俺たち目が買目に入っていない保存の検知（8/10 FB118・Naoto案）：
     買目にないと的中しても回収額を入力できない（8/4「俺たち目＝金額計算外」の仕様）ため、
     保存時に【追加して保存】/【追加せず保存】を選ばせる。投資額の有無は見ない（Naoto指定）。
     判定＝買目をパースした全組合せ（BOX・流し・全の展開込み）に俺たち目（書いた順ストレート換算）が
     含まれるか。俺たち目が空・読めない行のときは対象外＝普通に保存 */
  function oreMissingInBuys(key, text, ore) {
    if (!ore || !String(ore).trim()) return null;
    var cars = autoCars(key);
    var op = window.Keirin.parsePrediction(window.Keirin.oreNormalize(ore), "3連単", cars);
    var oreL = op.lines && op.lines[0];
    if (!oreL || !oreL.ok || !oreL.combos.length) return null;
    var keyOf = function (type, c) {
      var cc = (type === "3連複" || type === "2車複" || type === "ワイド") ? c.slice().sort() : c;
      return type + "|" + cc.join("-");
    };
    var have = {};
    window.Keirin.parsePrediction(text, "3連単", cars).lines.forEach(function (l) {
      if (!l.ok || l.cut) return; // 切り目行は「買っている目」に数えない（8/10 FB122）
      l.combos.forEach(function (c) { have[keyOf(l.type, c)] = true; });
    });
    var missing = false;
    oreL.combos.forEach(function (c) { if (!have[keyOf(oreL.type, c)]) missing = true; });
    return missing ? window.Keirin.oreNormalize(ore) : null;
  }
  /** 確認バー＝ブラウザconfirmはボタン文言を変えられないためフォーム内のインラインUIで出す */
  function showOreGuard(form, oreLine, doSave) {
    var old = form.querySelector(".ore-guard");
    if (old) old.remove();
    var div = document.createElement("div");
    div.className = "ore-guard";
    div.innerHTML = "⚠ 俺たち目 <b>" + oreLine + "</b> が買目に入っていません。" +
      '<div class="row gap">' +
      '<button type="button" class="btn small og-add">追加して保存</button>' +
      '<button type="button" class="btn small og-skip">追加せず保存</button>' +
      "</div>";
    form.appendChild(div);
    div.querySelector(".og-add").addEventListener("click", function () { div.remove(); doSave(oreLine); });
    div.querySelector(".og-skip").addEventListener("click", function () { div.remove(); doSave(); });
  }

  function renderPredForms() {
    var key = predKey(); // 入力先＝放送に追従 or 固定（8/6 FB11）
    // 固定中は「どこに固定しているか」＋「放送は今どこか」を出す（8/27 FB139）。
    // 放送＝固定先が一致している間は括弧を出さない（同じ情報を2回言わない）
    var pinNote = "";
    if (editVenue) {
      var liveKey = currentKey();
      pinNote = "　📌固定中" + (liveKey && liveKey !== key ? "（放送は " + liveKey.replace("|", " ") + "R）" : "");
    }
    $("pred-target").textContent = (key ? key.replace("|", " ") + "R（" + autoCars(key) + "車）" : "（場・レース未選択）") + pinNote;
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
      var saved = race.byRacer && race.byRacer[rc.id]; // 保存済みエントリの有無＝note既定判定に使う（FB117）
      var p = saved || { text: "", defaultType: "3連単", unit: 100, investInput: null, oreTachi: "", isNote: false };
      var d = predDrafts[draftKey(key, rc.id)]; // 未保存の入力があればそれを表示（消さない）
      var vText = d ? d.text : p.text;
      var vInvest = d ? d.invest : (p.investInput || "");
      var vOre = d ? d.ore : (p.oreTachi || "");
      // note予想チェック＝下書き＞保存値＞（新規のみ）勝負レース照合の既定ON（8/10 FB117）
      var vNote = d ? d.note : (saved ? !!p.isNote : isNoteRaceDefault(key, rc));
      return '<div class="pred-form" data-racer="' + rc.id + '">' +
        '<h3><span class="' + (idx === 1 ? "alt" : "") + '">' + esc(rc.name) + "</span> の予想</h3>" +
        '<textarea class="inp pf-text" rows="3" placeholder="例）1=9-2357&#10;メモ行はそのまま画面に出ます">' + esc(vText) + "</textarea>" +
        '<div class="parse-info pf-info"></div>' +
        '<div class="pred-opts">' +
        // プレースホルダーは例だけ（8/27 FB140・Naoto指定）。「123」はoreNormalizeが1-2-3へ正規化＝1点
        '<label class="lbl inline">俺たち目 <input type="text" class="inp slim pf-ore" value="' + esc(vOre) + '" placeholder="（例　123）"></label>' +
        '<label class="lbl inline"><input type="checkbox" class="pf-note"' + (vNote ? " checked" : "") + '> note予想（勝負レース）</label>' +
        "</div>" +
        '<div class="pred-opts">' +
        // 式別は3連単固定（例外は買い目の行頭に「ワイド」等と書けば行単位で指定可）
        '<input type="hidden" class="pf-type" value="3連単">' +
        // 上下ボタンは1000円刻み（8/27 FB141・Naoto依頼）。⚠️stepはスピナーの刻みなので
        // 端数（例3500）を手打ちするのは従来どおり可（フォーム送信が無いのでstep不一致でも保存に影響しない）。
        // ⚠️回収・払戻は実額＝端数が当たり前なのでstepを付けない
        '<label class="lbl inline">投資額 <input type="number" step="1000" min="0" class="inp slim pf-invest" value="' + esc(String(vInvest)) + '" placeholder="実際に買った総額">円</label>' +
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
      // 保存本体（8/10 FB118で分離）：extraLine＝【追加して保存】で俺たち目を買目に足す1行
      var doSave = function (extraLine) {
        if (extraLine) {
          var ta = form.querySelector(".pf-text");
          ta.value = (ta.value.trim() ? ta.value.replace(/\s+$/, "") + "\n" : "") + extraLine;
        }
        var entry = ensurePredEntry(key, racerId);
        entry.text = form.querySelector(".pf-text").value;
        entry.defaultType = form.querySelector(".pf-type").value;
        entry.unit = 0; // 単価×点数方式は廃止（投資・回収とも実額入力）
        var inv = +form.querySelector(".pf-invest").value;
        entry.investInput = inv > 0 ? inv : null;
        entry.oreTachi = form.querySelector(".pf-ore").value.trim();
        entry.isNote = form.querySelector(".pf-note").checked;
        state.preds[key].cars = autoCars(key);
        delete predDrafts[draftKey(key, racerId)]; // 保存できたので下書きは破棄
        save();
        renderSettlePreview();
        updatePredInfo(form, key);                 // 「未保存」表示を消す
      };
      form.querySelector(".pf-save").addEventListener("click", function () {
        // 俺たち目が買目にない保存＝【追加して保存】/【追加せず保存】の確認バー（8/10 FB118）
        var oreLine = oreMissingInBuys(key, form.querySelector(".pf-text").value,
          form.querySelector(".pf-ore").value.trim());
        if (oreLine) { showOreGuard(form, oreLine, doSave); return; }
        doSave();
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
    var cars = autoCars(key); // 出走表の最大車番から自動判定（手動上書きは8/27 FB138で廃止）
    var type = form.querySelector(".pf-type").value;
    var parsed = window.Keirin.parsePrediction(form.querySelector(".pf-text").value, type, cars);
    form.querySelector(".pf-info").innerHTML = parsed.lines.map(function (l) {
      // 1行に切り目を2つ書いた疑い（8/11 FB134）＝黙って誤読される前に打った本人へ知らせる。
      // ブロックはしない（保存は通す）＝FB97「俺たち目の入れ忘れ」と同じ、気づかせるだけの通知
      var cutWarn = l.cutMulti
        ? '<div class="unit-warn">⚠ 切り目は1行に1つずつ（「切 1-2-3」と「切 4-5-6」の2行に分けてください。' +
          "1行に並べると別の目として読まれます）</div>" : "";
      if (!l.ok) return '<div class="pl-memo">' + esc(l.raw.trim()) + "　→ メモ行（点数外）</div>" + cutWarn;
      if (l.cut) return '<div class="pl-memo">' + esc(l.raw.trim()) + "　→ 切り目（買目から除外・的中判定外）</div>" + cutWarn;
      if (l.allDup) return '<div class="pl-memo">' + esc(l.raw.trim()) + "　→ 全部かぶり/切り目（0点・画面に出ません）</div>";
      var dispNote = l.disp && l.disp !== window.Keirin.normalize(l.raw).replace(/\s+/g, "")
        ? '　<span class="pl-memo">画面表示 ' + esc(l.disp) + "</span>" : "";
      var dupNote = l.dupCount ? '　<span class="pl-memo">かぶり/切り目' + l.dupCount + "点除外</span>" : "";
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
  /** 着順1本ぶん。同じ車番は捨てて先頭3つ */
  function parseOneOrder(text) {
    var raw = window.Keirin.normalize(text || "").replace(/[^0-9]/g, "");
    var order = [];
    for (var i = 0; i < raw.length && order.length < 3; i++) {
      var n = +raw[i];
      if (n >= 1 && n <= 9 && order.indexOf(n) < 0) order.push(n);
    }
    return order.length >= 2 ? order : null;
  }

  /* 同着モード（8/27 FB148）＝着順欄が2本になる。
     同着だと当たりの並びが2通り＝公式の3連単払戻も2本出るので、両方を的中・回収に載せる */
  var deadHeat = false;

  /** 着順（同着なら2本）。1本目が読めなければ null。戻り値は常に array-of-array */
  function parseOrdersInput() {
    var a = parseOneOrder($("res-order").value);
    if (!a) return null;
    var out = [a];
    if (deadHeat) {
      var b = parseOneOrder($("res-order2").value);
      if (b && b.join("-") !== a.join("-")) out.push(b);
    }
    return out;
  }

  /** 同着欄の開け閉め（見た目だけ・stateやプリセットには触らない） */
  function setDeadHeatUI(on) {
    deadHeat = !!on;
    $("deadheat-wrap").classList.toggle("hidden", !deadHeat);
    $("btn-deadheat").classList.toggle("on", deadHeat);
    $("btn-deadheat").textContent = deadHeat ? "⚖ 同着（解除）" : "⚖ 同着";
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
      // 確定済みが同着（orders 2本）なら同着欄を開いた状態で復元する（8/27 FB148）
      var ex = window.Keirin.normalizeOrders(
        existing.orders && existing.orders.length ? existing.orders : existing.order);
      $("res-order").value = (ex[0] || []).join("-");
      $("res-order2").value = ex.length > 1 ? ex[1].join("-") : "";
      setDeadHeatUI(ex.length > 1);
      payoutRows = (existing.payouts || []).map(function (p) {
        return { type: p.type, combo: p.combo.slice(), amount: p.amount };
      });
    } else {
      $("res-order").value = "";
      $("res-order2").value = "";
      setDeadHeatUI(false);
      payoutRows = [];
    }
    unitInputs = {}; // 回収枚数はレースごと（別レースの枚数を持ち越さない・8/27 FB146）
    syncPayoutPresets();
    renderResultHint();
  }

  /** 払戻は3連単のみ扱う（買い目が3連単運用のため・8/4）。例外形式は「行を追加」で手動追加 */
  function keepPayouts(payouts) {
    return (payouts || []).filter(function (p) { return p.type === "3連単"; });
  }

  /** 着順から標準の払戻行を用意（入力済み金額は保持）。
      同着なら着順2本ぶん＝3連単の行が2本出る（公式の払戻も2本ある・8/27 FB148） */
  function syncPayoutPresets() {
    var orders = parseOrdersInput();
    if (orders) {
      // プリセット行は3連単のみ（買い目が3連単運用のため・8/4）。他形式は「行を追加」か自動取得で入る
      var want = {};
      window.Keirin.standardCombos(orders).forEach(function (sc) {
        if (sc.type !== "3連単") return;
        var label = window.Keirin.comboLabel(sc.type, sc.combo);
        want[label] = true;
        var exists = payoutRows.some(function (p) {
          return p.type === sc.type && window.Keirin.comboLabel(p.type, p.combo) === label;
        });
        if (!exists) payoutRows.push({ type: sc.type, combo: sc.combo, amount: 0 });
      });
      // 着順を打ち直した・同着を解除した時に、前の並びの空行が残らないよう掃除する（8/27 FB148）。
      // ⚠️金額を入れた行は消さない＝打った数字を勝手に捨てない。他式別（手動追加）にも触らない
      payoutRows = payoutRows.filter(function (p) {
        if (p.type !== "3連単" || p.amount > 0) return true;
        return !!want[window.Keirin.comboLabel(p.type, p.combo)];
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
        '<span class="pr-unit">円</span>' + // 8/27 FB146＝単位を明示（上下ボタンはCSSで非表示）
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

  // 着順の手入力も「入力途中」として保護する（8/8 FB75。選手名・決まり手の欄は8/27 FB143で撤去）
  $("res-order").addEventListener("input", function () { markResDirty(); syncPayoutPresets(); });
  $("res-order2").addEventListener("input", function () { markResDirty(); syncPayoutPresets(); });

  /* 同着ボタン（8/27 FB148）。開くとき2本目が空なら「2着と3着を入れ替えた並び」を下書きする
     ＝2着同着（1着5・2着が2と3 → 5-2-3 と 5-3-2）ならそのまま使える。
     1着同着・3着同着は下書きを直して使う。⚠️下書きは当て推量なので、
     払戻欄に並ぶ2本のラベルが公式の払戻2本と一致しているかで必ず答え合わせすること */
  $("btn-deadheat").addEventListener("click", function () {
    setDeadHeatUI(!deadHeat);
    if (deadHeat) {
      if (!$("res-order2").value) {
        var a = parseOneOrder($("res-order").value);
        if (a && a.length === 3) $("res-order2").value = [a[0], a[2], a[1]].join("-");
      }
    } else {
      $("res-order2").value = "";
    }
    markResDirty();
    syncPayoutPresets();
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

  /** 回収枚数の入力キー（配信者×的中買目） */
  function unitKey(racerId, hit) { return racerId + "|" + hit.type + " " + hit.comboLabel; }

  /** その配信者の回収額＝Σ（払戻100円あたり × 枚数）。8/27 FB146で実額手入力から移行 */
  function refundOf(racerId, hits) {
    var sum = 0;
    (hits || []).forEach(function (h) {
      if (h.amount > 0) sum += h.amount * (unitInputs[unitKey(racerId, h)] || 0);
    });
    return sum;
  }

  /* 旧データ（枚数が無く回収額だけ入っている確定済みレース）を枚数に読み替える。
     ①確定時に併記した refundUnits があればそれ ②無ければ 回収額÷払戻 が割り切れる時だけ換算
     （割り切れない＝端数のある手入力は換算せず0枚＝確定時に「回収枚数が未入力」で止まる＝黙って0円にしない） */
  function seedUnitsFromSaved(key, racerId, hits) {
    var saved = key ? state.results[key] : null;
    if (!saved) return;
    var units = (saved.refundUnits || {})[racerId];
    var money = (saved.refunds || {})[racerId] || 0;
    var moneyHits = (hits || []).filter(function (h) { return h.amount > 0; });
    moneyHits.forEach(function (h) {
      var uk = unitKey(racerId, h);
      if (unitInputs[uk] !== undefined) return;
      var hk = h.type + " " + h.comboLabel;
      if (units && units[hk] != null) { unitInputs[uk] = units[hk]; return; }
      if (moneyHits.length === 1 && money > 0 && h.amount > 0 && money % h.amount === 0) unitInputs[uk] = money / h.amount;
    });
  }

  function renderSettlePreview() {
    var key = resultKey(); // 結果フォームと同じレースを見る（固定中はそのレース・FB96）
    var el = $("settle-preview");
    var orders = parseOrdersInput();
    if (!key || !orders) { el.innerHTML = '<span class="miss">着順を入力すると的中・回収のプレビューが出ます</span>'; return; }
    var payouts = payoutRows.filter(function (p) { return p.amount > 0; });
    // 同着は「何通りで判定しているか」を必ず見せる＝入れ間違いに気づけるように（8/27 FB148）
    var head = orders.length > 1
      ? '<div class="dh-badge">⚖ 同着：' + orders.map(function (o) { return esc(o.join("-")); }).join(" ／ ") +
        " の2通りで判定しています</div>"
      : "";
    el.innerHTML = head + state.racers.map(function (rc) {
      var rp = window.Derive.resolvePred(state, key, rc.id);
      var s = window.Keirin.settle(rp.parsed, 0, orders, payouts);
      var oreHtml = "";
      if (rp.entry.oreTachi) {
        var op = window.Keirin.parsePrediction(window.Keirin.oreNormalize(rp.entry.oreTachi), "3連単", (state.preds[key] || {}).cars || 9);
        var oh = window.Keirin.settle(op, 0, orders, payouts).hits;
        if (oh.length) {
          oreHtml = oh[0].amount
            ? ' <span class="hit">🎯 俺たち目 ' + oh[0].comboLabel + " " + oh[0].mult + "倍</span>"
            : ' <span class="manche">🎯 俺たち目 ' + oh[0].comboLabel + " 払戻未入力</span>";
        }
      }
      if (!rp.points && !oreHtml) return "<div>" + esc(rc.name) + "：予想なし</div>";
      if (!s.hits.length) return "<div>" + esc(rc.name) + '：<span class="miss">不的中</span>（投資 ' + fmtYen(rp.invest) + "）" + oreHtml + "</div>";
      seedUnitsFromSaved(key, rc.id, s.hits);
      var moneyHits = s.hits.filter(function (h) { return h.amount > 0; });
      // 的中買目ごとに「何枚買ったか」を入れてもらう（複数式別が当たった時も取り違えない）。
      // 通常＝的中1点なので「回収 [枚] 枚 ＝ ¥○○」の1行に収まる。金額はupdateRefundYen()が入れる
      var unitHtml = moneyHits.map(function (h) {
        var n = unitInputs[unitKey(rc.id, h)] || 0;
        return '<span class="sp-unit">' +
          (moneyHits.length > 1 ? esc(h.type + " " + h.comboLabel) + " " : "") + "回収 " +
          '<input type="number" min="0" step="1" class="inp sp-refund" data-pay="' + h.amount +
          '" data-uk="' + esc(unitKey(rc.id, h)) + '" value="' + (n > 0 ? n : "") + '" placeholder="枚数">枚' +
          '<b class="sp-yen"></b></span>';
      }).join("　");
      return '<div class="sp-racer">' + esc(rc.name) + "：" + s.hits.map(function (h) {
        if (!h.amount) return '<span class="manche">🎯 ' + h.type + " " + h.comboLabel + " 払戻未入力</span>";
        return '<span class="' + (h.manche ? "manche" : "hit") + '">🎯 ' + h.type + " " + h.comboLabel + " " + h.mult + "倍</span>";
      }).join(" ") + oreHtml + "　" + unitHtml + '<b class="sp-total"></b></div>';
    }).join("");
    el.querySelectorAll(".sp-refund").forEach(function (inp) {
      inp.addEventListener("input", function () {
        unitInputs[inp.getAttribute("data-uk")] = Math.max(0, Math.floor(+inp.value || 0));
        markResDirty();
        updateRefundYen(); // ⚠️ここで再描画しない＝打っている最中に入力欄が作り直されるとカーソルが飛ぶ（FB75）
      });
    });
    updateRefundYen();
  }

  /** 「＝ ¥○○」と合計だけを書き換える（入力欄には触らない＝フォーカス・カーソルを守る） */
  function updateRefundYen() {
    var el = $("settle-preview");
    if (!el) return;
    el.querySelectorAll(".sp-racer").forEach(function (row) {
      var total = 0, n = 0;
      row.querySelectorAll(".sp-unit").forEach(function (sp) {
        var inp = sp.querySelector(".sp-refund");
        var yen = sp.querySelector(".sp-yen");
        if (!inp || !yen) return;
        var pay = +inp.getAttribute("data-pay") || 0;
        var units = Math.max(0, Math.floor(+inp.value || 0));
        yen.textContent = (units > 0 && pay > 0) ? " ＝ " + fmtYen(pay * units) : "";
        total += pay * units;
        n++;
      });
      var tot = row.querySelector(".sp-total");
      if (tot) tot.textContent = (n > 1 && total > 0) ? "　計 " + fmtYen(total) : "";
    });
  }

  $("btn-settle").addEventListener("click", function () {
    var key = resultKey(); // フォームに出ているレースを確定する（固定中でも取り違えない・FB96）
    if (!key) return;
    var orders = parseOrdersInput(); // 同着なら2本（8/27 FB148）
    if (!orders) { $("settle-preview").innerHTML = '<span class="manche">着順が読めません（例：1-9-2）</span>'; return; }
    if (deadHeat && orders.length < 2) {
      $("settle-preview").innerHTML = '<span class="manche">⚖ 同着モードですが、もう一方の着順が読めません（例：5-3-2）　→ 解除するなら「同着（解除）」を押してください</span>';
      return;
    }
    // 的中しているのに払戻が未入力なら確定させない（0倍の的中速報が画面に載る事故防止）
    var validPayouts = payoutRows.filter(function (p) { return p.amount > 0; });
    var missing = [];
    var missingRefund = [];
    state.racers.forEach(function (rc) {
      var rp = window.Derive.resolvePred(state, key, rc.id);
      var s = window.Keirin.settle(rp.parsed, 0, orders, validPayouts);
      s.hits.forEach(function (h) {
        var label = h.type + " " + h.comboLabel;
        if (!h.amount && missing.indexOf(label) < 0) missing.push(label);
      });
      // 俺たち目の的中も払戻必須（0倍でティッカーに載る事故防止）
      if (rp.entry.oreTachi) {
        var op = window.Keirin.parsePrediction(window.Keirin.oreNormalize(rp.entry.oreTachi), "3連単", (state.preds[key] || {}).cars || 9);
        window.Keirin.settle(op, 0, orders, validPayouts).hits.forEach(function (h) {
          var label = h.type + " " + h.comboLabel + "（俺たち目）";
          if (!h.amount && missing.indexOf(label) < 0) missing.push(label);
        });
      }
      // 投資額が入っている予想が的中したのに回収枚数未入力→確定不可（回収¥0が画面に載る事故防止）
      if (s.hits.length && rp.invest > 0 && !(refundOf(rc.id, s.hits) > 0)) missingRefund.push(rc.name);
    });
    if (missing.length) {
      $("settle-preview").innerHTML = '<span class="manche">⚠ 的中買目の払戻が未入力：' + missing.map(esc).join(" / ") +
        "　→ 上の払戻欄に入力すると倍率を計算して確定できます</span>";
      return;
    }
    if (missingRefund.length) {
      renderSettlePreview();
      $("settle-preview").insertAdjacentHTML("beforeend",
        '<div class="manche">⚠ 回収枚数が未入力：' + missingRefund.map(esc).join(" / ") +
        "　→ 的中した買い目を何枚買ったかを入力してください（1枚＝100円）</div>");
      return;
    }
    // 回収額＝払戻×枚数の自動計算（8/27 FB146）。stateには従来どおり「額」を保存し、
    // 枚数は再編集用に refundUnits へ併記する（derive・オーバーレイは無改修のまま）
    var refunds = {}, refundUnits = {};
    state.racers.forEach(function (rc) {
      var rp = window.Derive.resolvePred(state, key, rc.id);
      var hits = window.Keirin.settle(rp.parsed, 0, orders, validPayouts).hits;
      var sum = refundOf(rc.id, hits);
      if (sum > 0) refunds[rc.id] = sum;
      hits.forEach(function (h) {
        var n = unitInputs[unitKey(rc.id, h)] || 0;
        if (h.amount > 0 && n > 0) {
          if (!refundUnits[rc.id]) refundUnits[rc.id] = {};
          refundUnits[rc.id][h.type + " " + h.comboLabel] = n;
        }
      });
    });
    // 選手名・決まり手はコンソールで入力しない（8/27 FB143）＝DOMではなく自動取得／既存stateから
    // 引き継ぐ（空で上書きすると的中演出が名前を失う）。判定はderive.jsの純関数
    var meta = window.Derive.carryResultMeta(autoResults[key], state.results[key], orders[0]);
    var rec = {
      order: orders[0], // 従来どおり1本＝表示・的中演出（選手リスペクト）はこれを見る
      names: meta.names,
      kimarite: meta.kimarite,
      payouts: payoutRows.filter(function (p) { return p.amount > 0; }),
      refunds: refunds,
      refundUnits: refundUnits,
      settledAt: new Date().toISOString(),
    };
    // 同着のときだけ着順2本を持つ（8/27 FB148）。旧データ・通常レースは order だけのまま＝読み手は無改修
    if (orders.length > 1) rec.orders = orders.map(function (o) { return o.slice(); });
    state.results[key] = rec;
    // ⚠️結果シーン（overlay.htmlのscene-result）は8/12の③レース展開新設で運用終了＝OBSに面が無い。
    // resultViewの更新はマークアップが残っているための保険（?scene=resultで直接開いた時だけ効く）
    state.resultView = key;
    resDirty = false;       // 確定できた＝以後はstateの値が正（8/8 FB75）
    save();
    renderHitAdmin();
    renderSettlePreview();
  });

  /* 結果ページの貼り付け解析（7/29〜の実験機能）は8/27 FB144で撤去（Naoto「いらない」）。
     結果はkeirin.jpからの自動取得が主経路になり、手入力も着順＋払戻だけで足りるため */

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
    unitInputs = {};
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
  var ALIGN_LEAD = 10;  // FB128＝②への自動切替は発走10秒前（オーバーレイのSWITCH_LEADと同値に保つ）

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
    if (lastManualNavSec >= just.startSec - ALIGN_LEAD) return; // 発走後＋②切替済みの先読み10秒間（FB128）に手で動かした＝手動優先（エッジが引き戻さない）
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
      var pays = keepPayouts(r.payouts);
      // 同着＝3連単の払戻が2本＝当たりの並びが2通り（8/27 FB148）。
      // ⚠️自動取得の着順は着位ごとに先頭1人しか入っていない（2着同着だと「5-2」で3着が欠ける＝
      //   3連単の的中が1件も出ない）ので、着順は払戻から組み直したものを正とする
      var ords = window.Keirin.ordersFromPayouts(pays);
      var base = ords.length ? ords[0] : r.order.slice();
      if (base.length < 2) return;
      // 選手名は着順と並びが一致するときだけ引き継ぐ（ズレたまま名前を付けない）。
      // 落ちた場合はオーバーレイ側が出走表から車番で引く＝表示は正しいまま
      var aligned = base.slice(0, r.order.length).join("-") === r.order.join("-");
      var rec = {
        order: base,
        names: aligned ? (r.names || []).slice() : [],
        kimarite: aligned ? (r.kimarite || []).slice() : [],
        payouts: pays.map(function (p) { return { type: p.type, combo: p.combo.slice(), amount: p.amount }; }),
        settledAt: new Date().toISOString(),
        auto: true,
      };
      if (ords.length > 1) rec.orders = ords.map(function (o) { return o.slice(); });
      state.results[key] = rec;
      addedKey = key;
    });
    if (addedKey) {
      state.resultView = addedKey; // 結果シーンは運用終了（8/12）＝マークアップ残置ぶんの保険
      save();
      renderAll();
    }
  }

  function applyAutoToForm(key) {
    var r = autoResults[key];
    if (!r) return;
    var pays = keepPayouts(r.payouts);
    // 同着なら3連単の払戻が2本＝当たりの並びが2通り（8/27 FB148）。同着欄を自動で開いて両方入れる
    var ords = window.Keirin.ordersFromPayouts(pays);
    $("res-order").value = (ords.length ? ords[0] : (r.order || [])).join("-");
    $("res-order2").value = ords.length > 1 ? ords[1].join("-") : "";
    setDeadHeatUI(ords.length > 1);
    // 選手名・決まり手はフォームに出さない（8/27 FB143）＝確定時にresultMeta()が自動取得から引き継ぐ
    payoutRows = pays.map(function (p) { return { type: p.type, combo: p.combo.slice(), amount: p.amount }; });
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
    var p3 = (r.payouts || []).filter(function (p) { return p.type === "3連単"; });
    // 3連単の払戻が2本＝同着（8/27 FB148）。着順は払戻から組み直して見せる
    // （自動取得の着順は同着だと3着が欠けるため、そのまま出すと「5-2」になって混乱する）
    var ords = window.Keirin.ordersFromPayouts(p3);
    var disp = (ords.length ? ords : [r.order || []]).map(function (o) { return o.join("-"); }).join(" ／ ");
    el.classList.remove("hidden");
    el.innerHTML = "⚡ 結果を自動取得済み：着順 " + esc(disp) +
      (p3.length ? "（3連単 " + p3.map(function (p) {
        return esc(window.Keirin.comboLabel(p.type, p.combo)) + " " + p.amount.toLocaleString("ja-JP") + "円";
      }).join(" ／ ") + "）" : "") +
      (ords.length > 1 ? ' <b class="dh-badge">⚖ 同着</b>' : "") +
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
    unitInputs = {};
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

  /* 起動時のstate読み込み。**失敗しても空のstateで確定させない**（8/12）。
     以前は失敗時に既定state（場もレースも空）を入れて描いていたため、
     そのまま何か操作すると**本物のstateを空で上書きしてしまう**危険があった
     （GASの転送先がときどき404を返すので、実際に起こりうる）。
     読めるまで5秒ごとに再試行し、それまでは保存を止める（stateLoaded）。 */
  function loadState() {
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
      stateLoaded = true;
      setSync("ok", "接続OK（rev " + (state.rev || 0) + "）");
      renderAll();
      pollResults();
    }).catch(function (e) {
      setSync("err", "GAS接続失敗: " + e.message + "　再試行中…（つながるまで保存しません）");
      // 画面が真っ白にならないよう仮の器だけ用意する。stateLoadedは立てない＝保存は止まったまま
      if (!state) { state = window.Derive.defaultState(todayStr()); renderAll(); }
      setTimeout(loadState, 5000);
    });
  }
  loadState();

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
