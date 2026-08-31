/* overlay.js — オーバーレイ描画エンジン
   URLパラメータ:
     ?scene=talk|race|tenkai|result|brb|ad … このソースが描画するシーン（OBSのシーンごとに1ソース）
     ?theme=a|b|c                  … 配色
     ?debug=1                      … 透過穴の代わりにプレースホルダ表示＋同期状態バッジ
     ?wm=0                         … ヘッダー帯のCTC透かしを非表示（既定＝表示・8/6反転。CTC承認NGなら&wm=0で消す）
     ?fx=<演出キー>                 … 的中演出の抽選をやめて指定の演出を出す（検証用・本番URLには付けない）
                                      rain|yakumono|adjust|slot|sumo|pray|tea|samba|peye|thanks|auto
                                      ⚠️テスト接続（?gas=）も**本番と同じ抽選**（8/29〜・旧＝thanks固定8/25）
   データ: GAS状態（5秒ポーリング＋BroadcastChannel即時反映）＋タイムテーブル（10分毎） */

(function () {
  var params = new URLSearchParams(location.search);
  // tenkai＝③レース展開（8/12追加）。中央は透過穴で、展開ボードを別ソースとして下に敷く
  var SCENES = ["talk", "race", "tenkai", "result", "brb", "ad"];
  var SCENE = SCENES.indexOf(params.get("scene")) >= 0 ? params.get("scene") : "talk";
  var DEBUG = params.get("debug") === "1";
  /* ②レース観戦の中央ライン＋メンバーカラー枠の太線化（8/13 Naoto案）。
     2026-08-13にテスト検証を経て本番既定ONへ昇格。
     ロールバック＝ソースURLに &v2=0（旧レイアウトへ即復帰・デプロイ不要）。
     &ln=0 … 車番チップの下の苗字だけ消す（ラインと枠はそのまま） */
  var V2 = params.get("v2") !== "0";
  /* ②サブ予想枠を常時確保するか（8/28・§10項86）。既定ON（8/30〜恒久）。
     ONだと枠を畳まず、ワイプ穴を常に362pxへ固定する＝カメラが362幅でも544幅でも空白が出ない
     （544幅なら左182pxが枠の下に隠れるだけ・画角はNaoto確認済み）。
     ⚠️OFFで丸かぶり判定や場消滅で枠が畳まれると、カメラが362幅のとき左182pxが空白になる。
     ⚠️経緯＝8/27夜の空白事故→8/28に既定ONで根治→カメラを544幅へ直したのを受け8/29に既定OFFへ
        →8/30夜の本番でまた空白（メイン小倉×サブ小倉の丸かぶりで枠が畳まれ、カメラは362幅に
        戻されていた）。カメラの変換はシフトのたびに触られうることが2度実証されたので、
        レイアウトをOBS側の手動座標に依存させない既定ONへ恒久的に倒した。
     ロールバック＝ソースURLに &subfix=0（デプロイ不要・ただし福岡の操作が要る）。 */
  var SUB_FIXED = params.get("subfix") !== "0";
  /* 苗字は既定ON（8/13 Naoto判断）。出すにはヘッダー行を82pxまで広げる必要があり、
     その差分（約30px）は買い目エリアから借りている＝トレードオフを承知のうえでの選択。
     レース映像に重ねる案は映像利用の条件で不可・予想帯208pxは伸ばせないため他に置き場がない。
     &ln=0 で苗字なし（買い目が元の高さに戻る）へ即ロールバックできる */
  var LINE_NAMES = params.get("ln") !== "0";

  document.body.className = "scene-" + SCENE + (DEBUG ? " debug" : "") +
    (V2 ? " v2" + (LINE_NAMES ? " ln-name" : "") : "") +
    (params.get("wm") === "0" ? "" : " wm-on"); // CTC透かし＝既定ON（8/6）・&wm=0で非表示
  // テーマ：①トーク・②レース観戦は白（w）が既定（7/30 FB10）。
  // URLの &theme=a|b|c|w が最優先＝OBS側だけで即時に戻せる保険
  var THEMES = ["a", "b", "c", "w"];
  var theme = THEMES.indexOf(params.get("theme")) >= 0
    ? params.get("theme")
    : (SCENE === "talk" || SCENE === "race" || SCENE === "tenkai" ? "w" : "a");
  document.body.setAttribute("data-theme", theme);

  /* テスト用バックエンドに繋いでいるときは、画面に赤い「TEST」を出す（8/12）。
     ねらいは2つ：
       ①テストのデータを本番配信に出してしまう事故を防ぐ（見れば分かる）
       ②③の出走表とボードで別のバックエンドを掴んでいるとき、どちらがテストかすぐ分かる
         （?gas= の付け忘れで「出走表は8R・展開図は6R」というズレが実際に起きた）
     ⚠️本番（?gas=なし）では何も出ないので、通常運用の見た目は一切変わらない */
  if (window.APP_CONFIG && window.APP_CONFIG.IS_TEST_BACKEND) {
    document.addEventListener("DOMContentLoaded", function () {
      var b = document.createElement("div");
      b.className = "test-badge";
      b.textContent = "TEST";
      document.body.appendChild(b);
    });
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
  // &mocknow=HH:MM＝時刻を固定する検証ハーネス用パラメータ（8/10 FB113＝終了判定の絵作り用。実運用では付けない）
  var MOCK_NOW = (function () {
    var m = params.get("mocknow"); if (!m) return null;
    var p = m.split(":"); return (+p[0] || 0) * 3600 + (+p[1] || 0) * 60;
  })();
  function nowSec() {
    if (MOCK_NOW !== null) return MOCK_NOW;
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

  /* ---------- ③レース展開の対象レース（8/12・設計変更／要件§11.8改） ----------
     **コンソールが唯一の親**。③の出走表・ライン・予想帯は①トーク・②レース観戦とまったく同じ
     「操作中の場＋そのレース」を見る＝③だけのための特別な配線は無い。

     経緯：当初は展開ボードのドックを親にしていたが、ドック→③の伝送が実機で成立しなかった
     （BroadcastChannelは変化の瞬間しか流れず、localStorage共有もOBSでは効かなかった）。
     中央の展開図とのズレは、**ボード側をコンソールに追従させる**ことで解決した
     （tenkai の「配信に追従」・既定ON）。＝親は1つ、ボードもオーバーレイもそれを見る、
     という形になり、両者のあいだの通信そのものが不要になった。 */

  /* ---------- ヘッダー：本日のnote勝負（旧・場タブ）（8/9 FB99） ----------
     場タブはタイマーカード・予想帯の場名Rラベルと情報が重複するため廃止し、
     note販売の訴求（本日のnote勝負レース）に置き換えた。ヘッダーは全シーン共通なので、
     ②レース観戦にも1か所の変更で乗る（①出走表下の旧note勝負欄はFB99で廃止＝ヘッダーに一本化）。
     行内に本日の開催場名を見つけたらグレードバッジ（GI赤等）を自動付与。
     保険＝ソースURLに &vtabs=1 で旧・場タブ表示へ即復帰（デプロイ不要） */
  var SHOW_VTABS = params.get("vtabs") === "1";
  /** 場のグレード文字列：手入力/自動プリセット（state.grade）→時刻表（未選択の場も拾える）の順 */
  function gradeOfVenue(name) {
    var g = (state.grade || {})[name];
    if (!g && timetable) {
      (timetable.venues || []).forEach(function (tv) { if (tv.name === name && tv.grade) g = tv.grade; });
    }
    return g || "";
  }
  /* note勝負の終了判定（8/10 FB113・Naoto仕様）＝「同じ場の次のレースの発走時刻が来たら終了」
     （例：佐世保7・8Rの8Rは、佐世保9Rの発走時刻が来た時点で終了→表示から個々に消す）。
     時刻表に次のレースがない（＝その場の最終レース）は消さない。時刻は0時起点秒（鉄則） */
  var nhBoundary = null; // 次に表示が変わる発走時刻（0時起点秒）。跨いだら毎秒ループが再描画
  function nextRaceStartSec(venueName, no) {
    if (!timetable || !timetable.venues) return null;
    var next = null;
    timetable.venues.forEach(function (tv) {
      if (tv.name !== venueName) return;
      (tv.races || []).forEach(function (r) {
        if (+r.no > no && (!next || +r.no < +next.no)) next = r; // 番号が次に大きいレース＝欠番でもOK
      });
    });
    return next ? timeToSec(next.start) : null;
  }
  function renderVenueTabs() {
    var el = $("vtabs");
    if (!el) return;
    if (SHOW_VTABS) { // 旧・場タブ（ロールバック用にそのまま残置）
      el.className = "venue-tabs";
      el.innerHTML = state.venues.map(function (v, i) {
        var rNo = state.currentRace[v.name];
        return '<button class="vtab' + (i === state.activeVenue ? " active" : "") + '">' +
          esc(v.name) + (rNo ? "<small>" + rNo + "R</small>" : "") + gradeBadge(v.name) + "</button>";
      }).join("");
      return;
    }
    var lines = (state && state.noteRaces ? String(state.noteRaces) : "")
      .split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 8);
    el.className = "venue-tabs note-head"; // 件数クラスは終了レースの間引き後に確定（8/10 FB113）
    nhBoundary = null;
    if (!lines.length) { el.innerHTML = ""; return; }
    // 場名の照合リスト（8/9 FB104＝表示順の基準も兼ねる）：選択中の場→時刻表の場の順＝
    // タイマーカードと同じ並び。照合は長い名前から（部分一致の誤マッチ防止）
    var venueOrder = [];
    (state.venues || []).forEach(function (v) { if (venueOrder.indexOf(v.name) < 0) venueOrder.push(v.name); });
    if (timetable) (timetable.venues || []).forEach(function (tv) { if (venueOrder.indexOf(tv.name) < 0) venueOrder.push(tv.name); });
    var sorted = venueOrder.slice().sort(function (a, b) { return b.length - a.length; });
    // 配信者ごとに1枠へグループ化（8/9 FB101「配信者は配信者で1つの枠に・視聴者に見やすく」）：
    // 行から名簿（state.roster）の名前を検出し、同じ配信者の行を1つの枠にまとめる。
    // 枠線＝メンバーカラー＝画面全体の「色＝人」の視覚言語と統一（視聴者は色だけで誰のか分かる）。
    // 名前が検出できない行は独立の枠でそのまま表示（自由入力は壊さない）
    // 名前の照合は表記ゆれを無視（8/15 FB135）＝「むねお」でも「ムネオ」でも、「ピータ」でも「ピーター」でも本人。
    // 判定はDerive側（コンソールのnote予想チェック既定ONと同じ関数）に集約＝ルールが2か所に割れないように
    var roster = (state.roster || []).filter(function (r) { return r && r.name; });
    var groups = [], byName = {};
    lines.forEach(function (l, seq) {
      var hit = window.Derive.matchRacer(l, roster);
      var key = hit ? hit.name : "|" + groups.length; // 名前なし行＝独立枠（まとめない）
      var g = byName[key];
      if (!g) { g = { racer: hit, items: [] }; byName[key] = g; groups.push(g); }
      // 行から名前を除いた残り＝レース表記（残った区切り記号・余分な空白を掃除）。
      // 除去も表記ゆれ込み＝書かれた通りの「ピータ」を取り除ける
      var rest = hit ? window.Derive.stripName(l, hit.name) : l;
      rest = rest.replace(/^[\s:：、・/／|｜-]+/, "").replace(/[\s、・/／|｜-]+$/, "").replace(/\s+/g, " ").trim();
      if (!rest) return;
      /* ── 複数場の1行対応（8/10 FB125・Naoto「前橋と四日市が別で表示されれば」）：
         「前橋3・四日市6レース」のように**すべての場に自分の番号が続く**行だけ、場ごとの行に分割する。
         番号の付かない場が混じる行（「前橋四日市３・６」）は、3・6がどちらの場のものか機械では決められず、
         位置で割り当てると存在しない商品（前橋3R）を捏造表示してしまう＝従来どおり原文のまま（8/10実事故の教訓）。
         分割後は各場が独立に整形＋終了間引きの対象＝ナイター場とミッドナイト場の同居行でも終わった場から消える */
      var segs = null;
      (function () {
        var found = [], pos = 0;
        while (pos < rest.length) {           // 場名の出現を左から拾う（長い名前優先＝部分一致の誤マッチ防止）
          var hitV = null;
          for (var si = 0; si < sorted.length; si++) {
            if (rest.slice(pos, pos + sorted[si].length) === sorted[si]) { hitV = sorted[si]; break; }
          }
          if (hitV) { found.push({ v: hitV, at: pos }); pos += hitV.length; }
          else pos++;
        }
        var names = {};
        found.forEach(function (f) { names[f.v] = 1; });
        if (found.length < 2 || Object.keys(names).length < 2) return;         // 異なる場が2つ以上の行だけ対象
        if (!/^[\s:：、・/／|｜-]*$/.test(rest.slice(0, found[0].at))) return; // 場の前にメモ文＝原文のまま
        var out = [];
        for (var fi = 0; fi < found.length; fi++) {
          var end = fi + 1 < found.length ? found[fi + 1].at : rest.length;
          var seg = rest.slice(found[fi].at + found[fi].v.length, end);
          var segHalf = seg.replace(/[０-９]/g, function (c) { return String("０１２３４５６７８９".indexOf(c)); })
            .split("レース").join(" ");       // 「〜レース」表記対応（FB124と同じ）
          if (!(/^[\s0-9rRｒＲ・.．,，、\-〜~]*$/.test(segHalf) && /\d/.test(segHalf))) return; // 番号なしの場あり＝分割しない
          out.push({ v: found[fi].v, nums: segHalf.match(/\d+/g) || [] });
        }
        segs = out;
      })();
      if (segs) {
        segs.forEach(function (sg) {
          var maxNo = 0;
          sg.nums.forEach(function (n) { if (+n > maxNo) maxNo = +n; });
          var b = nextRaceStartSec(sg.v, maxNo);
          if (b !== null) {
            if (nowSec() >= b) return;          // この場のぶんだけ終了＝非表示
            if (nhBoundary === null || b < nhBoundary) nhBoundary = b;
          }
          g.items.push({
            t: sg.v + " " + sg.nums.map(function (n) {
              return n.replace(/\d/g, function (d) { return "０１２３４５６７８９".charAt(+d); }); // 8/11 FB129＝2桁も全角
            }).join("・") + "R",
            v: sg.v, seq: seq
          });
        });
        return;                                 // 分割済み＝以降の単場処理はしない
      }
      var venue = null;
      for (var vi = 0; vi < sorted.length; vi++) {
        if (rest.indexOf(sorted[vi]) >= 0) { venue = sorted[vi]; break; }
      }
      // 表記の正規化＋終了商品の間引き（8/10 FB113→FB114修正）：場が特定でき、残りが
      // 数字とR・区切りだけの行は「場名␣番号R」に整形（半角スペース／番号は全角＝
      // 8/11 FB129で2桁も全角化・旧FB113の「2桁は半角」はNaoto依頼で撤回）。
      // FB124＝「川崎５・９レース」の「レース」表記も整形・間引きの対象に（現場の実書式が
      // 「レース」で、ホワイトリスト外＝両機能とも眠っていた8/10実測への対応。判定前に除去する。
      // 「前橋四日市３・６レース」のような場2つ混じり・メモ混じりは従来どおり原文のまま＝安全側）
      // ⚠️終了判定は行（＝note商品）単位（FB114・Naoto「7・8Rで1つのnoteとして販売＝1商品」）：
      // 行内の最終レース（最大番号）の次のレースが発走したら行ごと消す。番号単位では消さない。
      // 自由文（場不明・メモ入り）は原文のまま＝入力を壊さない
      var t = rest;
      if (venue) {
        var tail = rest.split(venue).join(" ");
        var half = tail.replace(/[０-９]/g, function (c) { return String("０１２３４５６７８９".indexOf(c)); })
          .split("レース").join(" "); // 「〜レース」表記をR相当として扱う（8/10 FB124）
        if (/^[\s0-9rRｒＲ・.．,，、\-〜~]*$/.test(half) && /\d/.test(half)) {
          var nums = half.match(/\d+/g) || [];
          var maxNo = 0;
          nums.forEach(function (n) { if (+n > maxNo) maxNo = +n; });
          var b = nextRaceStartSec(venue, maxNo); // 最終レースの次＝商品終了の合図（時刻表に次がなければ消さない）
          if (b !== null) {
            if (nowSec() >= b) return;            // 商品まるごと終了＝行ごと非表示
            if (nhBoundary === null || b < nhBoundary) nhBoundary = b;
          }
          t = venue + " " + nums.map(function (n) {
            return n.replace(/\d/g, function (d) { return "０１２３４５６７８９".charAt(+d); }); // 8/11 FB129＝2桁も全角
          }).join("・") + "R";
        }
      }
      g.items.push({ t: t, v: venue, seq: seq });
    });
    // 枠内の並び＝場の順で自動ソート（8/9 FB104・Naoto指定）＝タイマーカードと同じ順。
    // 場が読めない行は末尾（同順位は書いた順の安定ソート）
    groups.forEach(function (g) {
      g.items.sort(function (a, b) {
        var ra = a.v ? venueOrder.indexOf(a.v) : 999;
        var rb = b.v ? venueOrder.indexOf(b.v) : 999;
        return ra - rb || a.seq - b.seq;
      });
    });
    // 枠（配信者）の並び＝席1が左・席2が右（8/9 FB105・Naoto指定）＝カメラ・予想帯と同じ並び。
    // 席についていない名前・名前なし枠はその後ろ（入力の初登場順のまま）
    var seats = seatMap();
    groups.forEach(function (g, gi) {
      g.rank = g.racer && seats.a && g.racer.name === seats.a.name ? 0
        : g.racer && seats.b && g.racer.name === seats.b.name ? 1 : 2;
      g.gi = gi;
    });
    groups.sort(function (a, b) { return a.rank - b.rank || a.gi - b.gi; });
    // 間引き後の実件数で表示クラスを確定（8/10 FB113）＝レースが減るたび文字サイズ段も自動で戻る
    groups = groups.filter(function (g) { return g.items.length; });
    var visCount = 0;
    groups.forEach(function (g) { visCount += g.items.length; });
    if (!visCount) { el.innerHTML = ""; return; } // 全部終了＝丸ごと非表示
    el.className = "venue-tabs note-head nh-n" + Math.min(visCount, 8);
    // 枠内は場ごとに縦積み・最大2行×列送り（8/9 FB102→FB104「Max2行にして2列に」）＝
    // 3場以上でも文字サイズを落とさず右の列へ流す（CSSグリッドの2行縦流し）。
    // 全員が1行ずつの日＝枠を縦積み（配信者1の下に配信者2・8/9 FB107）＝2行分の高さを有効活用
    var maxItems = 0;
    groups.forEach(function (g) { if (g.items.length > maxItems) maxItems = g.items.length; });
    if (maxItems === 1 && groups.length >= 2) el.classList.add("nh-stack");
    // 表示行数（8/10 FB110→FB111）＝3件まで1列縦積み・4件だけ2行×2列（Naoto指定）・5件〜は3行×列送り。
    // nh-rows3（字サイズ縮小＋ラベル3行組み）は「実際に3行表示される枠がある日」だけ付ける
    // （4件=2行表示なのでmaxItems基準だと不要な縮小がかかる＝FB111で表示行数基準へ変更）
    var rowsOf = function (n) { return n === 4 ? 2 : Math.min(n, 3); };
    var maxRows = 0;
    groups.forEach(function (g) { var r = rowsOf(g.items.length); if (r > maxRows) maxRows = r; });
    if (maxRows >= 3) el.classList.add("nh-rows3");
    // 金チップ（8/10 FB112）＝どれかの枠が3件以上の日は常に3行組み20px（nh-l3）。
    // 4+4の日（表示は2行×2列）も3+3と同じ大きさのチップに＝Naoto指示。2件以下の日は2行組み24pxのまま
    var lab3 = maxItems >= 3;
    if (lab3) el.classList.add("nh-l3");
    el.innerHTML = '<span class="nh-label">' +
      (lab3 ? "本日の<br>note<br>勝負レース" : "本日のnote<br>勝負レース") + "</span>" +
      '<span class="nh-groups">' +
      groups.map(function (g) {
        var col = g.racer ? window.Derive.colorOf(g.racer.color) : "";
        // 名前チップも予想帯ヘッダーと同じ白の太字＋黒フチで統一（8/15 FB136・Naoto指定）＝
        // 明色メンバー（黄）だけ黒文字になる旧仕様（textOn）を全画面で廃止
        var name = g.racer
          ? '<span class="nh-name txt-edge"' + (col ? ' style="background:' + col + ';color:#fff"' : "") + ">" +
            esc(g.racer.name) + "</span>"
          : "";
        var items = g.items.map(function (it) {
          // グレードバッジ＝8/10 FB111で廃止（Naoto指示・タイマーカードの〇R右バッジは存続）
          return '<span class="nh-item">' + esc(it.t) + "</span>";
        }).join("");
        return '<span class="nh-group"' + (col ? ' style="border-color:' + col + '"' : "") + ">" + name +
          '<span class="nh-items' + (g.items.length === 4 ? " nh-r2" : "") + '">' + items + "</span></span>";
      }).join("") + "</span>";
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
     発音担当＝「いま表示されているソース」（8/7 FB60）。旧＝②固定は、①表示中に非表示の②が
     OBSに裏画面扱い（タイマー間引き＋音声バッファ遅延）され音が実測9秒遅れた。OBSはソースの
     表示/非表示をPage Visibilityで通知してくるため、タイマーを持つ①②が自分の表示中だけ鳴らせば
     見ている画面の色切替と同一ソース発音＝ズレゼロ・二重発音もなし。
     タイマーの無い⑤等の表示中は無音（8/7 Naoto了承）。
     ⚠️③レース展開は8/12 Step3で②と同じタイマーを持ったので発音対象に含める（8/15 追加）。
        当初の「タイマーの無い③」という前提が変わったのに、この行だけ8/7のまま取り残されていた
        ＝③表示中は色だけ変わって無音になっていた（Naoto指摘で発覚）。
        表示中の1ソースだけが鳴らす設計（audible）は不変なので、③を足しても二重発音は起きない。
     &sound=0＝完全無効／&sound=1＝表示状態に関わらず発音（旧挙動・検証用）。
     色切替と音ズレしないよう、コンテキストは起動時に初期化しておく（鳴らす瞬間の初期化遅延をなくす）。 */
  var SOUND_FORCE = params.get("sound") === "1";
  var SOUND = SOUND_FORCE || (params.get("sound") !== "0" &&
    (SCENE === "race" || SCENE === "talk" || SCENE === "tenkai"));
  function audible() { return SOUND && (SOUND_FORCE || document.visibilityState === "visible"); }
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
    if (!audible()) return;
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
     キー＝「日付|民間締切の絶対秒|境界秒」＝レースごと・境界ごとに1回だけ（即時フォールバックとの二重鳴り防止）。
     ⚠️日付を前置するのは、締切の絶対秒が「0時からの経過秒」で日付を持たないため（8/15 追加）。
        ミッドナイトは毎日ほぼ同じ20分グリッド＝前日と発走時刻が一致した瞬間にキーが衝突し、
        OBSソースを開きっぱなしにしていると「もう鳴らした」扱いで永久に無音になっていた。
        autoSwitched（FB71）・narabiAuto（8/8）と同じ日跨ぎ事故で、ここだけ対策が漏れていた。
        呼び出し側ではなくこの中で足す＝予約と即時フォールバックの両方に一度で効く。 */
  var beepDone = {};
  function scheduleBeep(key, delaySec) {
    if (!audible()) return; // 非表示中は「鳴らした扱い」にもしない（表示切替直後の境界はフォールバックが拾える）
    var k = todayStr() + "|" + key;
    if (beepDone[k]) return;
    beepDone[k] = true;
    beepAt(audioCtx ? audioCtx.currentTime + Math.max(0, delaySec) : 0);
  }

  /* ---------- 発走時刻の自動シーン切替（8/9 FB95・8/11 FB128で発走10秒前に前倒し） ----------
     トーク中の切替忘れ対策：レースの発走10秒前になったらOBSのシーンを②レース観戦へ自動で切り替える。
     （当初は発走ちょうど＝視聴者から「レース映像切り替わってないよ？」の心配コメントが出たため前倒し。
       判定時刻に先読み秒を足すだけ＝共用のjustStartedRaceは不変・遅れ拾いの後端120秒も維持）
     実行者＝「いま表示されているソース」（FB60と同じPage Visibility判定）＝①トーク・③レース展開・（旧）③結果。
       ④待機は対象外＝無人でレース映像だけが流れる区間を作らない（§2-3の審査設計を壊さない）。
       ⑤広告も対象外＝案件の表示義務がある画面を自動で中断しない。②自身は切替不要。
     ⚠️**③レース展開は8/12に追加**。発走直前の隊列解説にいちばん使う画面＝①と同じ「出しっぱなし」事故が
       起きる場所なので、①と同じ扱いにする。発走から120秒を過ぎて開いた③は対象外なので、
       レース後に展開を振り返る使い方は引っ張られない。
     window.obsstudio.setCurrentScene は、OBS側でこのソースの「ページの権限」を
     「OBSへの高度なアクセス」にしたときだけ効く（未設定なら何も起きない＝安全側・手順書参照）。
     ON/OFF＝コンソール本日設定「発走時刻に②レース観戦へ自動切替」（既定ON）。
     切替先は②で始まるシーン名を自動検出（&racescene=名前 で上書き可＝OBS側だけの保険）。
     発火は1レース1回（キーはFB71の教訓で日付込み）。発走から2分以内なら遅れて表示されたソース
     （⑤広告からの復帰・OBS再起動直後）でも切り替える＝「出しっぱなし」を拾う */
  var AUTOSW = SCENE === "talk" || SCENE === "tenkai" || SCENE === "result";
  var SWITCH_LEAD = 10;  // 発走の何秒前に切り替えるか（8/11 FB128・0で発走ちょうどの旧動作。コンソール側ALIGN_LEADと同値に保つ）
  var SWITCH_WIN = 120;  // 発走からこの秒数まで＝そのレースが映像に映っているとみなし切替してよい
  var autoSwitched = {}; // 日付|場|R → 済
  var obsCtrlLevel = null; // OBSページ権限（デバッグ表示用。4以上＝切替可）
  if (window.obsstudio && window.obsstudio.getControlLevel) {
    try { window.obsstudio.getControlLevel(function (l) { obsCtrlLevel = l; }); } catch (e) {}
  }
  function autoSceneTick() {
    if (!AUTOSW || !window.obsstudio || typeof window.obsstudio.setCurrentScene !== "function") return;
    if (!state || !timetable || !state.venues.length) return;
    if (state.cfg.autoScene === false) return;
    if (document.visibilityState !== "visible") return; // 表示中のソースだけが切り替える（FB60）
    var names = {};
    state.venues.forEach(function (v) { names[v.name] = true; });
    var just = window.Derive.justStartedRace(
      allRaces().filter(function (r) { return names[r.venue]; }),
      nowSec() + SWITCH_LEAD, SWITCH_LEAD + SWITCH_WIN);
    if (!just) return;
    var k = todayStr() + "|" + just.venue + "|" + just.no;
    if (autoSwitched[k]) return;
    autoSwitched[k] = true;
    switchToRaceScene();
  }
  /* 切替先のシーンは**実機から名前を検出**する（頭の丸数字→キーワード→固定名の順）。
     ⚠️FB95（②へ）とFB149（①へ）で同じ手口なので**1つの表と1つの関数**にしてある。
        写して2本持つと、片方だけ直したときに「②は追従するのに①はしない」が起きる。
       param…OBS側だけで上書きしたいとき用のURLパラメータ（シーン名を大きく変えた場合の保険） */
  var SCENE_TARGETS = {
    race: { param: "racescene", head: "②", word: "レース", name: "②レース観戦" },
    talk: { param: "talkscene", head: "①", word: "トーク", name: "①トーク" }
  };
  function switchToScene(kind) {
    var t = SCENE_TARGETS[kind];
    var go = function (name) { try { window.obsstudio.setCurrentScene(name); } catch (e) {} };
    var fixed = params.get(t.param);
    if (fixed) return go(fixed);
    try { // シーン名は改名に備えて実機から検出（頭の丸数字→キーワードを含む→固定名の順）
      window.obsstudio.getScenes(function (list) {
        var target = null;
        (list || []).forEach(function (n) { if (!target && n.charAt(0) === t.head) target = n; });
        (list || []).forEach(function (n) { if (!target && n.indexOf(t.word) >= 0) target = n; });
        go(target || t.name);
      });
    } catch (e) { go(t.name); }
  }
  function switchToRaceScene() { switchToScene("race"); }

  /* ---------- 的中演出はトーク画面で見せる（8/29 FB149・Naoto依頼） ----------
     「的中演出はトークの大きいワイプで見てほしい」＝**②レース観戦・③レース展開を映している
     ときに的中演出が出たら、OBSのシーンを①トークへ自動で切り替える**。FB95（発走10秒前に②へ）
     のちょうど裏返しで、仕組み・注意点も同じ：
       実行者＝「いま表示されているソース」（Page Visibility・FB60）＝②③（旧③結果）だけ。
         ①自身は切替不要。**⑤広告・④待機は対象外**＝案件の表示義務がある画面／無人区間を
         自動で中断しない（FB95と同じ判断・§2-3の審査設計）。
       権限＝OBS側でそのソースの「ページの権限」が「OBSへの高度なアクセス」のときだけ効く。
         ⚠️**FB95では①と③にだけ設定してあれば足りていたが、これは②のソースにも要る**
         （②を映しているときに切り替えるのは②のページ自身だから）。未設定なら何も起きない＝安全側。
       トリガ＝`fireHitFx`＝**的中演出が出る瞬間そのもの**。だから「結果を確定した瞬間」と
         自動的に一致する（FB47＝自動確定由来では演出が出ない、も自動的に引き継ぐ）。
         リロード後に過去の的中で切り替わることもない（既存のseenHitsが再発火を止めている）。
       発火は**1レース1回**（FB95と同じ考え方）＝同じレースを2人が当てても1回。
         手で②へ戻した直後に、同じレースの遅れて来た的中で引き戻されない。
     ON/OFF＝FB95と同じ `state.cfg.autoScene`（既定ON・コンソールでは非表示＝常時ON）。
       OBS側だけで止めたいときは①②③のURLに `&hitscene=0`（緊急用の逃げ道）。 */
  var HITSW = SCENE === "race" || SCENE === "tenkai" || SCENE === "result";
  var HITSW_OFF = params.get("hitscene") === "0";
  var hitSwitched = {};   // 日付|場|R → 済（キーは日付込み＝FB71の教訓）
  function hitSceneSwitch(hit) {
    if (!HITSW || HITSW_OFF) return;
    if (!window.obsstudio || typeof window.obsstudio.setCurrentScene !== "function") return;
    if (state && state.cfg && state.cfg.autoScene === false) return;
    if (document.visibilityState !== "visible") return; // 表示中のソースだけが切り替える（FB60）
    // 的中IDは 場|R|配信者|式別|買い目（derive.jsのhitId）＝頭2つがレース。
    // 手動追加（manual-0等）はその文字列ごとキーにする＝レース単位に畳めないが二重発火は防げる
    var k = todayStr() + "|" + String((hit && hit.id) || "?").split("|").slice(0, 2).join("|");
    if (hitSwitched[k]) return;
    hitSwitched[k] = true;
    switchToScene("talk");
  }
  /* ②が表示された瞬間をコンソールへ通知（FB96＝予想レースの自動追従のトリガー）。
     OBS内のソースだけが送る＝通常ブラウザで閲覧しているだけのタブが盤面を動かさないように */
  if (SCENE === "race" && window.obsstudio) {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        window.Sync.broadcast({ type: "sceneShown", scene: "race" });
      }
    });
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
    // グレードもキーに含める＝場タブ廃止（FB99）でバッジがここへ移設・後着のグレードでも再構築される
    var keys = cards.map(function (c) {
      var closed = c.race && now >= c.race.startSec - offSec;
      return c.venue + "|" + (c.race ? c.race.no : "-") + (closed ? "C" : "") + "|" + gradeOfVenue(c.venue);
    }).join(",");
    if (keys !== timerRowKeys) {
      timerRowKeys = keys;
      var html = cards.map(function (c) {
        var closed = c.race && now >= c.race.startSec - offSec;
        // グレードバッジ＝「〇R」の右（8/9 FB100・Naoto指定。FB99の場名横から移動）
        // 3〜4場でも表示する（8/11 FB126・松山GⅠ実戦でNaoto指摘）：カード幅に収めるため
        // 長い場名（3場=4字〜・4場=3字〜）はvh-tightで頭ごと一段縮小＝「いわき平＋GⅠ」でも折り返さない
        var gb = gradeBadge(c.venue);
        var tight = gb && cards.length >= 3 && c.venue.length >= (cards.length >= 4 ? 3 : 4);
        var head = '<div class="vt-head' + (tight ? " vh-tight" : "") + '">' + esc(c.venue) +
          (c.race ? '<span class="vt-r">' + c.race.no + "R</span>" : "") + gb + "</div>";
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
      // ③レース展開も②と同じタイマー（8/12 Step3）＝右レールは②と同一構造
      ["timer-talk", "timer-race", "timer-tk"].forEach(function (id) {
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

  /** メンバーカラー背景に対する文字色（明るい色＝黒・暗い色＝白）。
      ⚠️8/15 FB136で全表示（予想帯ヘッダー・note勝負の名前チップ）が「白＋黒フチ固定」になり、
      現在の呼び出し元はゼロ。色を増やしたときの判定用に関数だけ残してある */
  function textOn(hex) {
    var m = /^#?([0-9a-fA-F]{6})$/.exec(hex || "");
    if (!m) return "#fff";
    var n = parseInt(m[1], 16);
    var yiq = ((n >> 16 & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
    return yiq >= 150 ? "#16181c" : "#fff";
  }

  /** 買い目1行を車番色チップの並びとして描画する */
  /** hlCombo（8/10 FB119）＝的中した組合せ [1,2,4]。渡された行では該当車番チップに hit-glow を付ける。
      ポジション厳密照合は「-」区切りの素直な並びのときだけ（1-23-45で1-2-4なら1・2・4だけ光る）。
      ＝（折返し）・BOX・区切りなしは順序が入れ替わり得るので「組合せに含まれる車番」を光らせる。
      「全」チップは行が的中していれば光らせる（当たり車番がその裏に居るため）
      ⚠️8/27 FB148＝**組合せは複数渡せる**（[[5,2,3],[5,3,2]] の形）。同着で1行が2つの目に当たったとき、
        片方しか光らないと「両方持っているのに1つしか光らない」になる＝どちらかに当たる車番を全部光らせる */
  function lineChips(raw, small, hlCombo) {
    var toks = window.Keirin.displayTokens(raw);
    // 単一の [5,2,3] でも複数の [[5,2,3],[5,3,2]] でも受ける
    var hls = !hlCombo || !hlCombo.length ? null
      : (Array.isArray(hlCombo[0]) ? hlCombo.filter(function (c) { return c && c.length; }) : [hlCombo]);
    if (hls && !hls.length) hls = null;
    var strict = false;
    if (hls) {
      var seps = toks.filter(function (t) { return t.t === "sep"; });
      strict = seps.length > 0 &&
        seps.every(function (t) { return t.v === "-"; }) &&
        !toks.some(function (t) { return t.t === "box"; });
    }
    var pos = 0;
    return toks.map(function (tk) {
      switch (tk.t) {
        case "car": {
          var glow = !!hls && hls.some(function (c) {
            return strict ? c[pos] === tk.v : c.indexOf(tk.v) >= 0;
          });
          return '<i class="car ' + (small ? "sm " : "") + "c" + tk.v + (glow ? " hit-glow" : "") + '">' + tk.v + "</i>";
        }
        case "sep": pos++; return '<span class="pl-sep">' + (tk.v === "=" ? "=" : "−") + "</span>";
        case "label": return '<span class="pl-type">' + esc(tk.v) + "</span>";
        case "all": return '<span class="pl-all' + (small ? " sm" : "") + (hls ? " hit-glow" : "") + '">全</span>';
        case "box": return '<span class="pl-box' + (small ? " sm" : "") + '">BOX</span>';
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
    // 8/9 FB99：state.gradeに無い場（コンソール未選択）も時刻表のグレードで拾う
    var g = String(gradeOfVenue(venueName))
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
      noMeta=true＝合計/投資行を出さない（②は右下の固定枠band-metaに分離・8/6 FB57）
      keepAll=true＝「全」を展開せず元の記法のまま描く（8/8 FB70→FB74→FB77で①②の全帯に適用）。
        通常は展開後の実車番（dispOf＝来ようのない番号を落とした正確な集合）を出すが、
        「24-1-全」が11チップに膨らんで幅を食い、自動縮小で小さくなってしまう
        （NEXT枠は幅182pxで判読不能・メイン帯も帯全体の倍率を引き下げる）。
        FB77で①トークにも展開＝同じ買い目が①と②で違う見た目になるのを解消した。
        ⚠️かぶり目が削られた行（dupCount>0）は元記法と実際の点数がズレるので対象外＝展開表示のまま */
  function raceBuyHtml(rc, k, small, noMeta, keepAll) {
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
    // 的中買目の車番強調（8/10 FB119）＝このレース×この配信者に有効な的中があれば、
    // 該当する行（式別＋組合せ一致）にだけ当たり組合せを渡してチップを光らせる
    // ⚠️8/27 FB148＝的中は同時に複数立ち得る（同着で並びが2通り／複数式別）。
    // 「最初の1件だけ」を光らせると、両方持っていても片方しか光らない
    var glows = rc && k ? glowsFor(k, rc.id) : [];
    var oreGlow = [];
    glows.forEach(function (g) { if (g.type === "俺たち目") oreGlow.push(g.combo); });
    return (ore ? '<div class="ore-row"><span class="ore-label">俺たち目</span>' + lineChips(ore, small, oreGlow) + "</div>" : "") +
      okLines.map(function (l) {
        // 切り目行（8/10 FB122・C案）＝グレー帯＋「切り目」バッジ（幅不足の行はfitCutLabelsが「切」へ短縮）。
        // チップは通常色のまま・的中強調の対象外（そもそも的中しない）
        if (l.cut) {
          return '<div class="pred-line chips cut-line"><span class="pl-cut' + (small ? " sm" : "") + '">切り目</span>' +
            lineChips(/全/.test(l.rawRest || "") ? l.rawRest : (l.disp || l.rawRest || l.raw), small) + "</div>";
        }
        var g = [];
        glows.forEach(function (gl) {
          // 俺たち目の的中＝FB53の重複排除でhitsは俺たち目名義だけになるが、同じ目を持つ
          // 買目行も同じように光らせる（8/11 FB127・Naoto「普通の買目の方も同じように強調して」）
          if (gl.type !== l.type && gl.type !== "俺たち目") return;
          l.combos.forEach(function (c) {
            if (window.Keirin.comboLabel(l.type, c) === gl.comboLabel) g.push(gl.combo);
          });
        });
        var src = (keepAll && !l.dupCount && /全/.test(l.raw)) ? l.raw : (l.disp || l.raw);
        return '<div class="pred-line chips">' + lineChips(src, small, g) + "</div>";
      }).join("") +
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

  /** 切り目バッジの文言フィット（8/10 FB122・Naoto「基本は切り目・横が長すぎるときは切」）＝
      行が枠幅に入らない時だけ「切」へ短縮してから、残りは既存の縮小フィットに任せる */
  function fitCutLabels(scope) {
    if (!scope) return;
    scope.querySelectorAll(".pred-line.cut-line .pl-cut").forEach(function (b) {
      if (b.textContent !== "切り目") b.textContent = "切り目";
      var line = b.closest(".pred-line");
      var parent = line && line.parentElement;
      if (!parent) return;
      var cs = getComputedStyle(parent);
      var avail = parent.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      if (avail > 0 && line.scrollWidth > avail) b.textContent = "切";
    });
  }

  /** 買い目行のはみ出し自動縮小（8/6）：折り返す代わりに、枠幅に収まる倍率へスケールする */
  function fitPredLines(scope) {
    if (!scope) return;
    fitCutLabels(scope); // 先にバッジ文言を確定させてから幅を測る（FB122）
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
    fitCutLabels(scope); // ②サブ＝幅182pxで最タイト＝「切」への短縮を先に確定（FB122）
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
    // ③レース展開の帯（kband-）も②と同じパッキングなので同じ自己修復に乗せる（8/12 Step3）
    ["band-pred-a", "band-pred-b", "kband-pred-a", "kband-pred-b"].forEach(function (id) {
      var band = $(id);
      if (!band || band.clientWidth <= 0) return;
      // 非表示中にrenderPredsされた帯はパック未実施のまま残る（旧48px予約も廃止済み）→表示復帰を検知して自己修復
      if (band.firstChild && !band.querySelector(".rb-flow")) { packRaceBand(band); return; }
      fitRbScale(band);
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
        // ラベル・メモ行がチップ行より幅広なら列幅に縮めて格納（列を太らせない）。
        // ⚠️下限フロア禁止＝比率そのままで縮める（フロアがあると視覚幅が列幅を超えて隣列/合計枠へ
        // インクが滲出し、transform由来のためどの検査にも映らない＝FB58レビューで実証済み）
        if (!hard[i] && ws[i] > cw + 1) {
          rows[i].style.width = cw + "px";
          rows[i].style.transform = "scale(" + (cw / ws[i]).toFixed(3) + ")";
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
    var fixW = overW > 1 ? (fr.width - overW) / fr.width : 1;
    var fixH = overH > 1 ? (fr.height - overH) / fr.height : 1;
    // 合計/投資への列の重なり：列ごとに「横で手前に収まる」「縦で上に収まる」の緩い方の必要倍率を
    // 実座標から厳密に出し、一発で解消する倍率へ補正（過小補正の段階縮小が映るのを防ぐ・FB58レビュー反映）
    var fixM = 1;
    var meta = band.parentElement.querySelector(".band-meta");
    if (meta && !meta.classList.contains("hidden")) {
      var mr = meta.getBoundingClientRect();
      if (mr.width > 0) {
        for (var i = 0; i < flow.children.length; i++) {
          var cr = flow.children[i].getBoundingClientRect();
          if (cr.right > mr.left + 2 && cr.bottom > mr.top + 2) {
            var fh = (mr.left - fr.left) / Math.max(1, cr.right - fr.left);
            var fv = (mr.top - fr.top) / Math.max(1, cr.bottom - fr.top);
            var f = Math.max(fh, fv);
            if (f < fixM) fixM = f;
          }
        }
      }
    }
    if (fixW >= 1 && fixH >= 1 && fixM >= 0.999) return;
    var cur = parseFloat((String(flow.style.transform).match(/scale\(([\d.]+)\)/) || [])[1]) || 1;
    var k = Math.max(0.35, cur * Math.min(fixW, Math.min(fixH, fixM)));
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
      // ⚠️1場表示は帯そのものにscaleを掛ける（下のelse）＝2〜3場へ切り替えた時に帯の拡大が残留し、
      // 中身全体が1.6倍で描かれ右列が見切れる実バグ（8/7 FB61・えーすnote＋和歌山で実発生）→必ず解除
      scope.style.transform = "";
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

  /** 2レース表示の列見出し（場名R＋そのレースがnote予想なら🔥note予想）。
      🔥note予想はひと塊で改行（語中でちぎれない・入らない時は塊ごと2行目へ＝8/7 FB63）。
      split=true（②用・8/7 FB64）＝note表記を常に2行目へ＝ラベル幅が半分になり、
      「ラベルは列幅まで縮小」ルール下でも約2倍の大きさで表示できる（チップの列幅計算には無影響） */
  function raceColHead(rc, k, split) {
    var p = rc && k ? window.Derive.resolvePred(state, k, rc.id) : null;
    var note = p && p.entry.isNote;
    return '<div class="race-col-head">' + esc(keyLabel(k)) +
      (k ? gradeBadge(String(k).split("|")[0]) : "") +
      (note ? (split ? '<br><span class="note-tag">🔥note予想</span>' : ' <span class="note-tag">🔥note予想</span>') : "") +
      "</div>";
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
      // メインと同じ場＝丸かぶり → 「なし」と同じ扱いにして枠ごと畳む（8/28 Naoto指定）。
      // currentRaceは場単位なので「場が同じ＝レースも必ず同じ」＝場名の比較だけで判定できる。
      // 1場運用に落ちた日（もう一方が本日終了で場リストから外れる）に必ず起きる
      if (vn && vn === mainName) return null;
      return vn && state.venues.some(function (v) { return v.name === vn; }) ? vn : null;
    };
    // 枠の有無はレイアウト＝OBSのカメラ座標と噛み合う幾何なので、SUB_FIXED中は選択状態で切り替えない。
    // （旧＝サブ場が1人でも有効なら枠を出す。この連動が8/27夜の空白事故の直接原因・§10項86）
    document.body.classList.toggle("race-sub-on",
      SUB_FIXED || !!(subVenueOf(seats.a) || subVenueOf(seats.b)));
    ["a", "b"].forEach(function (slot) {
      var rc = seats[slot];
      var name = rc ? rc.name : "";
      var color = rc ? window.Derive.colorOf(rc.color) : "";
      ["np-talk-", "np-race-", "np-result-", "np-ad-", "np-tk-"].forEach(function (p) {
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

      // 予想帯＝①トーク（tband-）・②レース観戦（band-）・③レース展開（kband-）で同一様式：
      // メンバーカラーのヘッダー（〇〇予想＋noteバッジ＋投資/回収の日次累計）＋俺たち目＋買い目チップ
      // ③は②とまったく同じレース（操作中のレース）を見る＝専用の配線は持たない（8/12設計変更）
      ["band-", "tband-", "kband-"].forEach(function (bp) {
        var bandHead = $(bp + "head-" + slot);
        if (!bandHead) return;
        var bandName = $(bp + "name-" + slot);
        // note予想バッジは廃止（8/6 FB25・レースラベル側の🔥表記のみ残す）。
        // 空席は文言ごと出さない＝③は席を畳まないので「名前の無い『予想』」が画面に残るため（8/12）
        if (bandName) bandName.innerHTML = name ? esc(name) + " 予想" : "";
        var bandInv = $(bp + "inv-" + slot);
        if (bandInv) {
          var bt = rc ? (derived.totals[rc.id] || { invest: 0, refund: 0 }) : null;
          // 回収未入力の的中を抱えている間は金額でなく「集計中」（8/8）＝
          // ティッカーが的中を流しているのに回収¥0、という食い違いを見せない
          bandInv.textContent = bt
            ? "投資 " + fmtYen(bt.invest) + "　回収 " + (bt.pending ? "集計中" : fmtYen(bt.refund))
            : "";
        }
        if (color) {
          bandHead.style.background = color;
          // 予想帯の「〇〇 予想」は色に関係なく白の太字＋黒フチで統一（8/15 FB136・Naoto指定）。
          // 旧＝明色（黄）だけ黒文字（textOn）＝ムネオの帯だけ見え方が違っていた
          bandHead.style.color = "#fff";
          bandHead.classList.add("txt-edge");
          if (bandHead.parentElement) bandHead.parentElement.style.borderColor = color;
        } else {
          // 空席になったら前の配信者の色を消す（8/12）。起動時の既定stateには配信者が2人入っている
          // ので、1人配信の実stateが届いた後も席bに初期メンバーの色が残り続けていた。
          // ①②は空席パネルがdisplay:noneなので見えなかったが、③は席を畳まないので露出する。
          // ネームプレート・カメラ枠は無条件代入で""が入る＝あちらは元から消えている
          bandHead.style.background = "";
          bandHead.style.color = "";
          bandHead.classList.remove("txt-edge");
          if (bandHead.parentElement) bandHead.parentElement.style.borderColor = "";
        }
        fitBandHead(bandHead); // 名前＋バッジ＋投資/回収が1行に収まるよう自動縮小
        var band = $(bp + "pred-" + slot);
        if (!band) return;
        // ①トーク＝配信者ごとの表示レース1〜3場（8/6 FB3）。1場＝全面／2場＝左右分割／3場＝T字（上段1場目・下段2場）。
        // ②レース観戦は従来どおり操作中のメインレースのみ
        if (bp === "tband-") {
          // 第5引数keepAll=true＝①トークも「全」を展開せず元記法で描く（8/8 FB77で②に合わせた）。
          // 第4引数noMetaはfalse固定＝①は合計/投資を帯の中にインラインで出す仕様のまま
          if (talkKeys.length >= 3) {
            // 左＝フル高の大枠／右＝上下2段（8/6 FB26・Naotoスケッチ準拠）。
            // 大枠には行数最多のレースを自動配置（FB33・同数ならタップ順維持＝安定ソート）
            var tk = talkKeys.slice().sort(function (a, b) { return predRowCount(rc, b) - predRowCount(rc, a); });
            band.innerHTML =
              '<div class="race-t">' +
              '<div class="race-t-main race-col">' + raceColHead(rc, tk[0]) + raceBuyHtml(rc, tk[0], true, false, true) + "</div>" +
              '<div class="race-t-side">' +
              '<div class="race-col">' + raceColHead(rc, tk[1]) + raceBuyHtml(rc, tk[1], true, false, true) + "</div>" +
              '<div class="race-col">' + raceColHead(rc, tk[2]) + raceBuyHtml(rc, tk[2], true, false, true) + "</div>" +
              "</div></div>";
          } else if (talkKeys.length === 2) {
            band.innerHTML =
              '<div class="race-split">' +
              '<div class="race-col">' + raceColHead(rc, talkKeys[0]) + raceBuyHtml(rc, talkKeys[0], true, false, true) + "</div>" +
              '<div class="race-col">' + raceColHead(rc, talkKeys[1]) + raceBuyHtml(rc, talkKeys[1], true, false, true) + "</div>" +
              "</div>";
          } else {
            band.innerHTML = raceColHead(rc, talkKeys[0] || null) + raceBuyHtml(rc, talkKeys[0] || null, false, false, true);
          }
          fitPredLines(band); // 長い行は枠幅に合わせて自動縮小
          fitRaceCols(band);  // 買い目が多い列は縦にも自動縮小（見切れ防止・8/6 FB9）
        } else {
          // メイン帯にも「場名 R」ラベルを表示（サブ予想との区別・8/6 FB13）。
          // 合計/投資は右下の固定枠へ分離（8/6 FB57）。パッキングが実座標で衝突判定するため
          // metaを先に確定させてから買い目を組む（FB58・順序に意味あり）
          var bMeta = $(bp + "meta-" + slot);
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
          // 第5引数keepAll=true＝②メイン帯も「全」を展開せず元記法で描く（8/8 FB74）。
          // 空席は中身ごと空にする＝③は席を畳まないので、誰もいない枠にレースラベルだけ
          // 残ると「予想を出し忘れている」ように見える（8/12）
          band.innerHTML = !rc ? ""
            : (key ? raceColHead(rc, key, true) : "") + raceBuyHtml(rc, key, false, true, true);
          packRaceBand(band); // 自前パッキング＋最適倍率（8/6 FB51→FB58で全分割総当たり化）
        }
      });

      // ②サブ予想帯（8/6 FB13・FB17）：配信者ごとの場＝raceSubBy。サブ未選択の配信者の枠は畳む
      var sHead = $("sband-head-" + slot);
      if (sHead) {
        var svn = subVenueOf(rc);
        var sPanel = sHead.parentElement;
        // SUB_FIXED中は席に人が居れば枠ごと出す（サブ場が未選択・無効でもヘッダーだけ残す）。
        // 畳むと182pxの列が素通しになり、その下のカメラ／背景が覗く（＝空白に見える）
        if (sPanel) sPanel.style.display = (rc && (svn || SUB_FIXED)) ? "" : "none";
        var sName = $("sband-name-" + slot);
        if (sName) {
          // 「予想（NEXT）」は添え字（.sub-sfx＝0.62em）に分離＝同サイズで並べると
          // 名前が9文字分に引きずられて頭打ちになるため（8/13 FB「文字が小さい」）
          // 括弧は半角＝全角（）は1文字ぶんの幅を取るため、半角にするだけで全体が約1割詰まり、
          // 自動フィットのぶん名前が大きくなる（8/13 FB）
          sName.innerHTML = name ? esc(name) + '<span class="sub-sfx">予想(NEXT)</span>' : "";
          // 幅にぴったり収まるフォントサイズを自動計算（8/6 FB34：縮小だけでなく拡大もして枠パンパンに・改行なし）
          sName.style.transform = "";
          sName.style.fontSize = "";
          var sAvail = sHead.clientWidth - 14; // ヘッダー左右padding分（8/13に10→7へ変更）
          if (sAvail > 0 && sName.scrollWidth > 0) {
            var sBase = parseFloat(getComputedStyle(sName).fontSize) || 18;
            var sFs = Math.max(12, Math.min(34, sBase * sAvail / sName.scrollWidth));
            sName.style.fontSize = sFs.toFixed(1) + "px";
          }
        }
        if (color) {
          sHead.style.background = color;
          sHead.style.color = "#fff"; // メイン帯と同じ白＋黒フチで統一（8/15 FB136）
          sHead.classList.add("txt-edge");
          if (sPanel) sPanel.style.borderColor = color;
        }
        var sBand = $("sband-pred-" + slot);
        if (sBand) {
          var sKey = svn && state.currentRace[svn] ? window.Derive.raceKey(svn, state.currentRace[svn]) : null;
          // 第5引数keepAll=true＝NEXT枠だけ「全」を展開せず元記法で描く（8/8 FB70）
          sBand.innerHTML = sKey ? raceColHead(rc, sKey) + raceBuyHtml(rc, sKey, false, false, true) : "";
          fitSubRows(sBand); // 買い目・合計とも折り返さず幅ぴったりに自動縮小（8/6 FB14）
        }
      }
    });
    // 描画直後の測定は不確実なことがある→次フレーム＋300ms後に再フィット（8/6 FB32）
    requestAnimationFrame(fitTalkBands);
    setTimeout(fitTalkBands, 300);
  }

  /* ---------- 出走表（①トーク右下／③レース展開の左） ----------
     ①＝コンソールの操作中レース／③＝展開ボードのドックが選んだレース（§11.8）。
     描画は完全に同じなので、対象のid3点と場・レースだけ差し替えて共用する */
  var SL_TALK = { list: "slist-talk", sub: "slist-sub", narabi: "narabi-talk" };
  var SL_TK = { list: "slist-tk", sub: "slist-sub-tk", narabi: "narabi-tk" };

  function renderStartList() {
    var v = state.venues[state.activeVenue];
    var vName = v ? v.name : "";
    var rNo = v ? state.currentRace[v.name] : null;
    renderStartListInto(SL_TALK, vName, rNo);
    // ③は①とまったく同じレースを描く（8/12設計変更）。中央の展開図はボード側が
    // 同じコンソールに追従するので揃う＝ここに専用の分岐は要らない
    if (SCENE === "tenkai") renderStartListInto(SL_TK, vName, rNo);
    // ②は出走表を出す場所が無いので、ラインだけを予想帯ヘッダーの中央へ差し込む（8/13 v2）。
    // 戦型（三分戦等）は出さない＝Naoto「二分戦とかの情報はいらない」
    if (SCENE === "race" && V2) {
      renderNarabi(vName, rNo, "narabi-race", { names: LINE_NAMES, noType: true, race: true });
      fitRaceLine();
    }
  }

  function renderStartListInto(ids, vName, rNo) {
    var el = $(ids.list);
    if (!el) return;
    var race = null;
    if (vName && rNo && timetable) {
      (timetable.venues || []).forEach(function (tv) {
        if (tv.name !== vName) return;
        (tv.races || []).forEach(function (r) { if (r.no === +rNo) race = r; });
      });
    }
    // 金帯＝場名Rを主役に拡大（8/10 FB115・Naoto「どの出走表を出してるかはめっちゃ大事」）
    // ＝場名R（大）とクラス（小）を別スパンに分離。サイズはCSS .sl-vr / .sl-cls
    var subEl = $(ids.sub);
    if (subEl) {
      if (vName && rNo) {
        subEl.innerHTML = '<b class="sl-vr">' + esc(vName) + " " + rNo + "R</b>" +
          (race && race.cls ? '<span class="sl-cls">' + esc(race.cls) + "</span>" : "");
      } else {
        subEl.textContent = "";
      }
    }
    if (!race || !race.racers || !race.racers.length) {
      el.innerHTML = '<li class="slist-empty">出走表データ取得待ち</li>';
      // 前のレースのライン行を残さない（別レースの並びが出たままになるのを防ぐ）
      var nb0 = $(ids.narabi);
      if (nb0) nb0.classList.add("hidden");
      return;
    }
    var key = window.Derive.raceKey(vName, rNo);
    var scores = narabiAuto[key] ? narabiAuto[key].scores || {} : {};
    var ages = narabiAuto[key] ? narabiAuto[key].ages || {} : {}; // 年齢＝得点と同じkeirin.jp JSJ002由来（8/15）
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
      // 年齢＝選手名の右に半角の(36)（8/15）。名前と同じspanの中＝行のgapを挟まずぴったり続ける
      var age = String(ages[String(p.no)] || "").replace(/[^0-9]/g, "");
      return '<li class="slist-row"><i class="car c' + p.no + '">' + p.no + "</i>" +
        '<span class="sl-name">' + esc(p.name) +
        (age ? '<span class="sl-age">(' + age + ")</span>" : "") +
        '</span><span class="sl-sub">' + esc(sub) + "</span>" +
        (sc ? '<span class="' + scls + '">' + esc(sc) + "</span>" : "") + "</li>";
    }).join("");
    renderNarabi(vName, rNo, ids.narabi);
    fitSlist(ids.list); // ライン表示で高さが変わった後に9車の収まりを確認（8/6 FB30）
  }

  /** ライン（並び予想）＋競走得点＋年齢＝GAS経由でkeirin.jpから自動取得。並びは手入力があれば優先（修正用） */
  var narabiAuto = {}; // raceKey → { val, scores, ages, pending, at }
  var narabiDate = ""; // narabiAutoに入っている値の取得日（yyyyMMdd）＝日跨ぎ検知用
  function joCodeOf(venueName) {
    var jo = null;
    if (timetable) {
      (timetable.venues || []).forEach(function (tv) { if (tv.name === venueName) jo = tv.joCode; });
    }
    return jo;
  }
  function hasRaceInfo(e) {
    return e && (e.val || (e.scores && Object.keys(e.scores).length > 0) ||
      (e.ages && Object.keys(e.ages).length > 0));
  }
  function ensureNarabi(vName, rNo, key) {
    if (narabiAuto[key]) return;
    var jo = joCodeOf(vName);
    if (!jo) return; // 時刻表の取得待ち
    narabiAuto[key] = { val: "", scores: {}, ages: {}, pending: true };
    window.Sync.fetchNarabi(jo, rNo).then(function (info) {
      narabiAuto[key] = { val: info.narabi, scores: info.scores, ages: info.ages, at: Date.now() };
      if (hasRaceInfo(narabiAuto[key])) renderStartList();
    }).catch(function () { delete narabiAuto[key]; }); // 失敗時は次の描画で再試行
  }
  /** 車番→フルネーム（出走表から）。時刻表の出走表は「阪本 正和」形式。
      選手リスペクト演出（8/25）の名前の主経路：本番運用は結果の自動取得を待たず
      着順＋払戻だけ手入力で確定する＝state.resultsのnamesはほぼ空。
      しかも手入力済みレースは後からのスクレイプで上書きしない（console.js「手入力済みは触らない」）
      ＝結果側から名前が来ることは期待できない。着順の車番→出走表で引くのが実態に合う */
  function fullNameOf(vName, rNo, no) {
    var out = "";
    if (!timetable || !vName || !rNo) return out;
    (timetable.venues || []).forEach(function (tv) {
      if (tv.name !== vName) return;
      (tv.races || []).forEach(function (r) {
        if (r.no !== +rNo) return;
        (r.racers || []).forEach(function (p) {
          if (+p.no === +no) out = String(p.name || "").trim();
        });
      });
    });
    return out;
  }
  /** 車番→苗字（②中央ライン用）＝フルネームの最初の空白まで */
  function surnameOf(vName, rNo, no) {
    return fullNameOf(vName, rNo, no).split(/[\s　]+/)[0];
  }
  /* opts.names＝車番チップの下に苗字を出す／opts.noType＝戦型（三分戦等）を出さない。
     どちらも②の中央ライン専用。①③は従来どおり（引数なし＝挙動不変） */
  function renderNarabi(vName, rNo, nbId, opts) {
    var nb = $(nbId);
    if (!nb) return;
    var o = opts || {};
    var key = vName && rNo ? window.Derive.raceKey(vName, rNo) : null;
    var manual = key ? ((state.narabi || {})[key] || "") : "";
    // keirin.jp経路では時刻表に並び・戦型（三分戦等）が同梱されている
    var ttNarabi = "";
    var lineType = "";
    if (vName && rNo && timetable) {
      (timetable.venues || []).forEach(function (tv) {
        if (tv.name !== vName) return;
        (tv.races || []).forEach(function (r) {
          if (r.no !== +rNo) return;
          if (r.narabi) ttNarabi = r.narabi;
          if (r.lineType) lineType = r.lineType;
        });
      });
    }
    var auto = key && narabiAuto[key] ? narabiAuto[key].val : "";
    if (key && !narabiAuto[key]) ensureNarabi(vName, rNo, key); // 得点＋並びの保険はエンドポイントから
    var groups = window.Keirin.normalize(manual || ttNarabi || auto).split(/[^0-9]+/).filter(Boolean);
    if (!groups.length) { nb.classList.add("hidden"); return; }
    nb.classList.remove("hidden");
    // 「ライン」の見出し文字＝8/10 FB115で削除（Naoto「いらないかも」・そのぶんチップを大きく）
    nb.innerHTML = ((lineType && !o.noType) ? '<span class="nb-type">' + esc(lineType) + "</span>" : "") +
      // 場名＋R＝②は場名バーを置いていない（7/29 FB4）ので、ラインの左に添えて「どのレースの並びか」を示す
      // 場名とRは2段組み＝1行だと「西武園 11R」で240px近く食い、そのぶん苗字が縮小される。
      // 縦は枠を広げた分の余りがあるので、高さを使って幅を節約する（8/13 FB）
      (o.race ? '<span class="nb-race"><b>' + esc(vName) + "</b><b>" + esc(String(rNo)) + "R</b></span>" : "") +
      '<span class="nb-arrow">←</span>' +
      groups.map(function (g) {
        return '<span class="nb-group">' + g.split("").map(function (n) {
          var chip = '<i class="car c' + n + '">' + n + "</i>";
          if (!o.names) return chip;
          // 苗字が取れない選手（時刻表が旧経路等）はチップだけ＝高さが揃うよう空要素は残す
          return '<span class="nb-cell">' + chip +
            '<b class="nb-nm">' + esc(surnameOf(vName, rNo, n)) + "</b></span>";
        }).join("") + "</span>";
      }).join('<span class="nb-dot">・</span>');
    fitNarabi(nbId); // 収まらない時は行ごと縮小（8/6 FB44）
  }

  /* ②中央ラインの位置決め（8/13 v2）＝左右の「〇〇 予想」の実測位置の隙間へ差し込む。
     配信者名の長さで空きが変わるので、CSSの固定値ではなく毎回測る。
     入り切らないぶんは fitNarabi（行ごと縮小・FB44）が最後に吸収する */
  function fitRaceLine() {
    var box = $("rb-line");
    if (!box) return;
    var inner = $("narabi-race");
    var band = document.querySelector("#scene-race .race-band");
    var na = $("band-name-a"), nbB = $("band-name-b");
    // ライン未発表・並び不明の日は枠ごと出さない（空の窓だけが残るのを防ぐ）
    if (!inner || inner.classList.contains("hidden") || !band || !na || !nbB) {
      box.classList.add("hidden");
      return;
    }
    var br = band.getBoundingClientRect();
    var ar = na.getBoundingClientRect(), brr = nbB.getBoundingClientRect();
    var PAD = 10; // 配信者名とラインの間に空ける余白（8/13 FB「もっと横に広げてOK」で22→10）
    var left = Math.max(0, ar.right - br.left + PAD);
    var right = Math.min(br.width, brr.left - br.left - PAD);
    var w = right - left;
    if (w < 140) { box.classList.add("hidden"); return; } // 名前が長すぎて隙間が無い日は諦める
    box.classList.remove("hidden");
    box.style.left = Math.round(left) + "px";
    box.style.width = Math.round(w) + "px";
    /* 高さ＝ヘッダー行の実寸にぴったり合わせる（8/13 Naoto指定）。
       ⚠️ここでヘッダーを広げてはいけない＝予想帯208pxの中で買い目エリアが痩せるため。
       与えられた高さの中でチップ・苗字を最大化する（固定pxで決め打ちすると「入らない→枠を広げる」
       という買い目を削る方向に流れる）。苗字なしのときは高さを全部チップに回す */
    var head = $("band-head-a");
    var hr = head ? head.getBoundingClientRect() : null;
    if (hr && hr.height > 0) {
      /* 上端は「帯の見た目の上端」＝予想パネルの枠線の外側に合わせる（8/13 FB）。
         枠線はメンバーカラーで塗られていて帯の一部に見えるため、ヘッダー本体の上端
         （＝枠線6pxの内側）に合わせると、その6pxが色の帯として上に残ってズレて見える。
         高さ＝帯の上端からヘッダー行の下端まで＝買い目エリアには一切かからない */
      // 下端はヘッダー帯の下辺から1px上げる（8/13 FB）＝帯の色が下に1本残って窓が締まって見える。
      // 上端は詰め切っているので、そのぶん枠の高さが1px短くなる
      var h = hr.bottom - br.top - 1;
      box.style.top = "0px";
      box.style.height = Math.round(h) + "px";
      var inner = h - 10;                   // padding 3×2＋border 2×2
      var nm = 0, chip;
      if (LINE_NAMES) {
        nm = Math.max(12, Math.min(26, Math.round(inner * 0.37)));
        chip = Math.max(16, Math.round(inner - nm - 1));
      } else {
        chip = Math.max(16, Math.round(inner));
      }
      box.style.setProperty("--rbchip", chip + "px");
      box.style.setProperty("--rbnm", nm + "px");
      // 場名Rは1行（8/13 FB「縦より横に余裕があるから1行で大きく」）＝内寸の62%まで使う
      box.style.setProperty("--rbrace", Math.round(inner * 0.62) + "px");
    }
    fitNarabi("narabi-race"); // 幅が確定してから縮小判定（先に測ると常に0幅になる）
  }

  /** ライン行の幅フィット（8/6 FB44）：「ライン無し」の全バラ表示等で右端チップが切れる→行ごと縮小 */
  function fitNarabi(nbId) {
    var nb = $(nbId);
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
  function fitSlist(listId) {
    var el = $(listId);
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

  /* 本日のnote勝負レース＝①出走表下の欄は廃止し、ヘッダー（旧・場タブ位置）へ一本化（8/9 FB99）。
     #note-races-talk はHTML側の初期クラスhiddenのまま触らない（検証ハーネスの写しと同期を保つため要素は残置） */

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
      var posLabel = thxPosLabels(r); // 同着なら「1着・2着・2着」等（8/27 FB148）
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
  /* 演出を出した的中ID（8/26 演出2連続再生の根治）。GAS応答の遅延・順序逆転でstateが一瞬
     古い内容に巻き戻ると、seenHitsも巻き戻り、次の新鮮なstateで同じ的中が「新規」や
     「auto→手動の置き換わり」に見えて演出が再発火していた（8/26朝 高知2R・スロット2連続で実測。
     再発火は抽選も引き直す＝スロット→リスペクトの異種2連続も同根）。
     このページの寿命内は「的中1件＝演出1回」をここで確定させる。
     リロード後の再生はseenHits初回初期化が抑止する従来のまま。
     fxlabは発火ごとにレース番号を進める＝IDが毎回変わるので連打に影響なし */
  var firedFx = {};
  var HIT_FX_MS = 35000; // 8/6 FB46：12秒→20秒→8/7 FB62：27秒→8/10 FB121：35秒に延長（バッジ・買目チップ強調共通）

  /* 的中買目の車番強調（8/10 FB119・Naoto依頼「当たった買目の車番だけ強調」）＝
     予想帯（①トーク・②メイン/サブ共通＝raceBuyHtml）の該当行で、当たり組合せの車番チップに
     hit-glow（金リング＋パルス）を付ける。発火条件は演出と同一（手動確定のみ）・
     持続もワイプ的中演出と同じHIT_FX_MS＝期限切れは0.25秒ループが掃除して再描画 */
  var hitGlows = []; // {key, racerId, type, comboLabel, combo:[..], until}
  function addHitGlow(h) {
    var p = String(h.id).split("|"); // id＝場|R|配信者|式別|組合せ（hitId）
    if (p.length < 5) return;
    var combo = String(h.comboLabel).split("-").map(Number).filter(Boolean);
    if (!combo.length) return;
    hitGlows.push({ key: p[0] + "|" + p[1], racerId: p[2], type: h.type,
      comboLabel: h.comboLabel, combo: combo, until: Date.now() + HIT_FX_MS });
  }
  function glowsFor(key, racerId) {
    var now = Date.now();
    return hitGlows.filter(function (g) { return g.until > now && g.key === key && g.racerId === racerId; });
  }
  function sweepHitGlows() { // 期限切れ＝配列から外して帯を通常表示へ戻す
    if (!hitGlows.length) return;
    var now = Date.now();
    var alive = hitGlows.filter(function (g) { return g.until > now; });
    if (alive.length !== hitGlows.length) { hitGlows = alive; renderPreds(); }
  }
  /** 同時に立った複数の的中を1回の発火にまとめる（8/27 FB148）。
      同着（並びが2通り）や複数式別では、同じ人の的中が同じタイミングで2件以上立つ。
      ⚠️1件ずつfireHitFxすると**演出が同時に2つ走り、バッジは後勝ちで片方の倍率しか残らない**。
      代表＝いちばん高い倍率（演出の抽選・スロットの出目・バッジの見出しはこれを使う）。
      倍率は全部バッジに並べる。万車・noteはどれか1件でも該当すれば立てる＝大きい方のニュースを優先。
      買目チップの強調はまとめない＝的中1件ごとに付ける（両方の並びが光る） */
  function mergeHits(list) {
    if (list.length === 1) return list[0];
    var sorted = list.slice().sort(function (a, b) { return (b.mult || 0) - (a.mult || 0); });
    var top = sorted[0];
    var merged = {};
    Object.keys(top).forEach(function (k) { merged[k] = top[k]; });
    merged.mults = sorted.map(function (h) { return h.mult; }).filter(function (m) { return m > 0; });
    merged.manche = sorted.some(function (h) { return h.manche; });
    merged.note = sorted.some(function (h) { return h.note; });
    // 式別が混ざったら式別ラベルは出さない（片方だけ出すと嘘になる）。type自体は代表のまま
    // ＝演出側（スロットの出目など）が見るのは代表の的中なので整合する
    merged.mixedType = !sorted.every(function (h) { return h.type === top.type; });
    // 3連単が2件以上＝同着（通常レースで3連単の当たりは1通りしかない）
    merged.deadHeat = !merged.mixedType && top.type === "3連単" && sorted.length > 1;
    return merged;
  }

  /** ダブル的中（8/28）＝この回のパスで**席aと席bが同じレースを的中させたか**。
      成立したらペア表（PAIR_FX）を引いて共演演出のキーを返す。出なければ ""。
      ⚠️「同じレース」に限る理由＝結果を確定した瞬間、そのレースの全員分の的中が同じ1回の
        パスで同時に立つ（derive.jsのhitsは結果×買い目から毎回まとめて計算される）。
        だから発火**前**に「2人揃ったか」を判定できる＝先に出た演出を後から上書きせずに済む。
      ⚠️別レース同士・手動追加の的中・結果確定後に相方の買い目を入れた場合は別パスになる＝
        ダブル不成立（いつもどおり個人演出）。ここは割り切り（8/28 Naoto了承）
      ⚠️席に座っている2人だけが対象＝画面に映っていない人とのハイタッチは出さない */
  function pairFxFor(seats, fresh) {
    if (!seats.a || !seats.b) return "";
    var ka = memberKey(seats.a), kb = memberKey(seats.b);
    if (!ka || !kb || ka === kb) return "";
    var eff = pairEffectOf(ka, kb);
    if (!eff) return "";
    var byRace = {};
    for (var i = 0; i < fresh.length; i++) {
      var p = String(fresh[i].id).split("|");       // id＝場|R|配信者|式別|組合せ
      if (p.length < 5) continue;                   // 手動追加（manual-N）はレースが特定できない
      var rk = p[0] + "|" + p[1];
      if (!byRace[rk]) byRace[rk] = {};
      if (fresh[i].racerName === seats.a.name) byRace[rk].a = true;
      if (fresh[i].racerName === seats.b.name) byRace[rk].b = true;
      if (byRace[rk].a && byRace[rk].b) return eff;
    }
    return "";
  }

  function checkNewHits() {
    var ids = {};
    var glowAdded = false; // FB119：この呼び出しで買目強調が追加されたか
    derived.hits.forEach(function (h) { ids[h.id] = h; });
    if (seenHits === null) { seenHits = ids; return; }
    var groups = {}, groupOrder = []; // 「同じレース×同じ人」の同時的中をまとめる（8/27 FB148）
    var fresh = [];                   // この回の新規的中（ダブル判定に使う・8/28）
    Object.keys(ids).forEach(function (id) {
      var h = ids[id];
      var prev = seenHits[id];
      // 既知の的中は原則スキップ。例外＝自動確定→手動確定への置き換わり（回収入力での上書き）は発火（8/6 FB47）
      if (prev && !(prev.resAuto && !h.resAuto)) return;
      // 自動確定由来は演出を出さない（8/6 FB47・手動の「結果を確定」の時だけ演出）＝記録だけ残す
      if (h.resAuto) return;
      if (firedFx[id]) return; // 同じ的中で二度は鳴らさない（8/26根治・firedFxのコメント参照）
      firedFx[id] = true;
      addHitGlow(h); // 予想帯の的中買目チップ強調（8/10 FB119・演出と同条件・同尺）
      glowAdded = true;
      fresh.push(h);
      var gk = h.place + "|" + h.racerName;
      if (!groups[gk]) { groups[gk] = []; groupOrder.push(gk); }
      groups[gk].push(h);
    });
    var seats = seatMap();
    // ダブル成立なら2人とも共演演出に差し替える（個人演出・結果発表は出さない・8/28）
    var pairFx = pairFxFor(seats, fresh);
    groupOrder.forEach(function (gk) {
      var h = mergeHits(groups[gk]);
      ["a", "b"].forEach(function (slot) {
        if (seats[slot] && seats[slot].name === h.racerName) fireHitFx(slot, h, seats[slot], pairFx);
      });
    });
    seenHits = ids;
    // 帯はcheckNewHitsより先（renderAll内）に描画済みのため、強調が追加された時だけ描き直す（FB119）
    if (glowAdded) renderPreds();
  }

  /* ══════════ 配信者ごとの個人演出（8/8 FB73＝テーブル化） ══════════
     方針：コードにも公開リポジトリにも人名を出さない（8/7 FB65から継続）。すべて「色キー」で表現する。
     しくみ：的中演出の3つの面に必ず m-<色キー> が付く
             ・アイコン走行の箱 → .hit-rain.m-orange
             ・ワイプ枠         → .cam.hit-fx.m-orange
             ・的中バッジ       → .hit-fx-badge.m-orange
       → 見た目だけの個人演出は overlay.css にセレクタを足すだけで足りる（JS変更不要）。
     MEMBER_FXは「JSでしか変えられない量」と「名前を付けて使い回す効果クラス」を書く場所：
             fx     …付与するクラス（複数メンバーで使い回せる効果に名前を付ける）
             count  …走るアイコンの体数（既定80）
             size   …[最小px, 最大px]（既定[80,180]・奥のレーンほど小さい）
             dur    …1体の走破秒[最小,最大]（既定[2.2,3.2]）
             rainMs …走行の長さ＝バッジが出るまでの時間ms（既定4500）
             effect / effects …❌8/27に廃止＝**どの演出をどの確率で出すかは下の MEMBER_RATES が正本**。
                      MEMBER_FXは見た目の量だけを持つ（確率は書かない＝二重管理を作らない）
     追加手順：①MEMBER_RATESに演出と%を書く ②見た目の量が要るならこの表にも色キーの行を足す
               ③必要ならoverlay.cssに見た目を書く ④`node 検証ハーネス/fxdisttest.js` を通す
               ⑤検証ハーネス raintest.html?key=<色キー> で撮って確認
                 （動きを見る演出は 検証ハーネス/fxlab.html を実ブラウザで開く） */
  var COLOR_KEY = { "青": "blue", "緑": "green", "オレンジ": "orange", "橙": "orange",
    "赤": "red", "ピンク": "pink", "桃": "pink", "黄": "yellow", "黄色": "yellow" };
  var MEMBER_FX = {
    // ⚠️確率はここに書かない（下のMEMBER_RATESが正本）。ここは「アイコン走行の見た目の量」だけ
    orange: { fx: ["dust-xl"] },  // 白いモクモクの砂埃（8/8 FB72）＝走行が出たときの見た目
    blue:   {},                   // 専用演出のみ（走行なし）＝見た目の量は不要
    pink:   {},
    green:  {},
    yellow: {},
    red:    {}
    // 例）purple: { fx: ["dust-xl"], count: 120, size: [90, 200], dur: [1.8, 2.6], rainMs: 5200 }
  };
  var RAIN_DEFAULT = { count: 80, size: [80, 180], dur: [2.2, 3.2], rainMs: 4500 };

  /* ══════════ 演出の出現確率テーブル（8/27・確率の唯一の正本） ══════════
     「誰のどの演出を何%で出すか」を**そのまま数字で書く場所**。計算で作らない＝
     指示（例「40%40%20%にして」）とこの表を見比べるだけで、仕様どおりかを目で確認できる。
     ⚠️確率を変える・演出を足すときは**この表だけ**を触る。抽選の仕組み（weightedPick）は触らない。
       経緯＝8/26、20%を作るために抽選の計算方式ごと作り替えて事故った（場によって結果発表が
       ほぼ0%/ほぼ100%になり、欠陥ビルドが本番配信に流出）。仕組みを固定して表だけ動かす形に
       作り替えたのがこの表＝「%指定のたびに仕組みを触る」構造そのものを無くすのが目的。
     書き方＝色キー: { 演出キー: %, … } で**合計100**（0.5等の小数も可・分解能0.01%）。
       演出キー＝rain（既定のアイコン走行）／yakumono＝役物合体／slot＝スロット／sumo＝相撲
                 ／pray＝念仏／pray_ng＝念仏の眼鏡なし（8/31・絵違いだけ＝尺と動きはprayと共通）
                 ／tea＝お茶／nicha＝ニチャー／samba＝サンバ／dance＝ダンス
                 ／adjust＝アジャスト／peye＝ピーターズ・アイ／thanks＝選手リスペクト（結果発表・全員共通）
     ⚠️合計100でない／演出名のタイプミスは起動時の自己検査（auditRates）で警告＋テストがFAILする */
  /* ⚠️🚴選手リスペクト（thanks）は**8/29から全色0%＝いったん封印中**（Naoto指示・「みんなの反応が微妙だった」）。
       演出そのものは消していない＝`?fx=thanks`・テスト接続（?gas=）では今までどおり出る。抽選から外しただけ。
       行を0%で残してあるのは「封印中」だと表を見て分かるようにするため（0%は必ず抽選から外れる＝weightedPickのw>0）。
       戻すとき＝各色の thanks を20に戻し、その分を個人演出から引く（下の等分ルールで合計100を維持）。
     個人演出の等分ルール（8/26）＝thanksを除いた残りを演出の数で等分（端数0.01%だけ調整して合計100）。 */
  var MEMBER_RATES = {
    orange: { rain: 33.34, tea: 33.33, nicha: 33.33, thanks: 0 }, // 走行／お茶（FB90）／ニチャー（8/29）
    blue:   { yakumono: 50, adjust: 50, thanks: 0 },  // 役物合体（FB82）／アジャスト（FB130）
    pink:   { slot: 100, thanks: 0 },                 // スロット（FB83）
    green:  { sumo: 50, peye: 50, thanks: 0 },        // 相撲（FB86）／ピーターズ・アイ（8/25）
    yellow: { pray: 50, pray_ng: 50, thanks: 0 },     // 念仏＝眼鏡あり/なし50%ずつ（FB88→8/31 Naoto指示）
    red:    { samba: 50, dance: 50, thanks: 0 }       // サンバ（FB121）／ダンス（8/25）
    // 例）purple: { rain: 50, slot: 30, thanks: 20 }
  };

  /* ══════════ ダブル的中の共演演出（8/28 Naoto案・新しい軸） ══════════
     ここまでの演出は全部「**誰が**当てたか」で決まる。この表はもう一つの軸＝
     「**2人が同じレースを当てたか**」で決まる演出を持つ。成立したら個人演出も結果発表も出さず、
     両方のワイプに**同じ絵**が同期して出る（＝2画面で1つの出来事が起きているように見せる）。
     成立条件＝**同じレース**を席aと席bの両方が的中（→ pairFxFor）。
       同じレースなら「結果を確定」1回で両方の的中が同時に立つので、押しズレは起きない。
     ⚠️**ペアの一覧表は持たない**（8/28改訂）。ハイタッチは1色ずつの部品（歩行＋ポーズ）から
       実行時に合成するので、**素材がある色どうしなら全部の組み合わせで成立する**＝
       HT_CHARSに色を1行足すだけで、その色を含む組み合わせが全部増える。
       （ペアごとにキメ絵を用意する方式だと、色が増えるたびに組み合わせの数＝2乗で絵が要った） */
  function pairEffectOf(ka, kb) {
    if (HT_CHARS[ka] && HT_CHARS[kb]) return "hitouch";
    return "";   // 別のペア演出を足すときはここに条件を並べる
  }
  /* ⚠️ラボ用の公開（window.__HT_COLORS）は **HT_CHARS の宣言の直後** に置いてある。
     ここに書いてはいけない：varは巻き上げられるので**この時点では中身がundefined**で、
     `window.__HT_COLORS = HT_CHARS` が空になる（8/28に実際にやって、fxlabで相方のワイプが
     空のままになった）。関数の中で参照するぶんには呼び出し時に解決されるので問題ない。 */

  /* 役物合体の尺（8/8 FB82）。倍率kを掛けるのは「焦らし」の2つ（寄る・震える）だけ。
     ⚠️合体の一撃(CSS .fx-piece.lock の0.13秒)には掛けない：
        伸ばすと叩きつけでなくスーッと寄るだけになり迫力が消える（Naoto実見でk=3に決定）
     HOLD＝合体後の余韻。8/8は1100で「間延びする」判定だったが、8/11 FB132で2400へ延長＝
        フチが消えるまでピカピカし続けるようになり「見せっぱなし」でなくなったため（Naoto依頼） */
  var YAK_K = 3;
  var YAK_BASE = { IN: 50, FLY: 1400, SHAKE: 700, GLOW_LAG: 180, HOLD: 2400, FADE: 450 };
  function yakTimes() {
    var t = { IN: YAK_BASE.IN, FLY: YAK_BASE.FLY * YAK_K, SHAKE_LEN: YAK_BASE.SHAKE * YAK_K };
    t.SHAKE = t.IN + t.FLY;                 // 震え始め
    t.LOCK  = t.SHAKE + t.SHAKE_LEN;        // ガシャーン！
    t.GLOW  = t.LOCK + YAK_BASE.GLOW_LAG;   // 後光
    t.END   = t.GLOW + YAK_BASE.HOLD;       // 退場開始＝ここでバッジにバトンを渡す
    t.GONE  = t.END + YAK_BASE.FADE;
    return t;
  }

  /* スロットの尺（8/8 FB83・8/9 FB84でレバー追加・8/10 FB122でキャラ入場・8/10 FB123で右入場＋溜め。ピンクメンバー専用）。
     流れ＝①筐体が出る（リール静止）②キャラが右からぴょんぴょん入場③到着＝一拍止まる→しゃがんで溜める
           ④バッと手上げポーズに切替＝その手がレバーの玉を掴む→レバーが下りる⑤引き切った瞬間に回り出す⑥左から順に停まる⑦ピカピカ
       WAIT   …筐体が出てからキャラが跳ね始めるまでの間ms（筐体を見せる間）
       HOP    …キャラの入場ms（右画面外→定位置）／HOPSTEP…1跳ねms（HOP÷HOPSTEPは整数に＝着地で終わる）
       PAUSE  …到着してからしゃがみ始めるまでの間ms（①のまま静止＝「ちょっとだけ止まる」）
       TAME   …しゃがんで溜めているms（切れた瞬間にバッと立つ＝手上げ②＋レバー）
       LEVER  …レバーを引き下ろすのにかかるms（引き切った瞬間＝回転開始）
       SPIN1  …回り出してから1つ目のリールが停まるまでのms
       GAP    …2つ目までの間隔ms／GROW…3つ目はその何倍焦らすか（試作の700ms刻みは
                「2つ目・3つ目が早すぎる」＝Naoto指摘。溜めを作るのはこの2つの数字）
       DECEL  …各リールが減速に使う時間ms（この間だけ速度が落ちる＝クルクル→スーッ→ドン）
       CELL_MS…等速で回っているときの1コマあたりms（小さいほど速く回る）
     ⚠️ENDがバッジまでの時間（fireHitFxがrainMsとして使う）。伸ばすと演出全体が長くなる
        （バッジの表示時間 HIT_FX_MS=27秒 は別枠でその後ろに乗る。FB122のHOP＋FB123の溜めで計+2.1秒＝バッジ約11.8秒） */
  var SLOT_BASE = { WAIT: 380, HOP: 1280, HOPSTEP: 320, PAUSE: 420, TAME: 380,
    LEVER: 340, SPIN1: 2000, GAP: 1900, GROW: 1.28, DECEL: 1400,
    PIKA_LAG: 140, HOLD: 2500, FADE: 500, CELL_MS: 60 }; // HOLD＝揃ってキラキラを見せる時間（8/9 FB85で+1秒）
  var SLOT_LOOP = 9; // 1周＝車番1〜9の9コマ（当たり目は1周に必ず1回だけ出る）
  /* キャラ入場（8/10 FB122）＝「拳＝レバーの玉」の位置合わせ用の実測定数（fx_slotchar_make.pyが出力。
     ⚠️絵を差し替えたらスクリプトを再実行して3つとも貼り直す） */
  var SCHAR_AR = 681 / 800; // fx_slotchar1..2.png の実寸比（横/縦）
  var SCHAR_FX = 0.683;     // ②の拳（ナックル）中心x＝画像幅に対する比率（⚠️絵は左右反転して使う＝実効は 1-SCHAR_FX）
  var SCHAR_FY = 0.408;     // ②の拳（ナックル）中心y＝画像高に対する比率
  var SCHAR_DY = 0.30;      // キャラの立ち位置を筐体の底からさらに下げる量（cell単位・8/10 FB123「もうちょっと下」。
                            //   下げたぶん拳は玉より下にずれるが完全一致は不要＝Naoto了承済み）
  function slotTimes(n) {
    n = n || 3;
    var t = { HOPIN: SLOT_BASE.WAIT };                    // キャラが跳ね始める
    t.ARRIVE = SLOT_BASE.WAIT + SLOT_BASE.HOP;            // 到着＝跳ね停止（①のまま一拍おく）
    t.TAME = t.ARRIVE + SLOT_BASE.PAUSE;                  // しゃがんで溜め始める
    t.PULL = t.TAME + SLOT_BASE.TAME;                     // バッと立つ＝手上げ②切替＋レバーを引き始める
    t.SPIN = t.PULL + SLOT_BASE.LEVER;                    // 引き切った＝回転開始（レバーはバネで戻る）
    t.STOPS = [t.SPIN + SLOT_BASE.SPIN1];
    for (var i = 1; i < n; i++) {
      t.STOPS.push(Math.round(t.STOPS[i - 1] + SLOT_BASE.GAP * Math.pow(SLOT_BASE.GROW, i - 1)));
    }
    t.PIKA = t.STOPS[n - 1] + SLOT_BASE.PIKA_LAG; // 全部揃ってから光り出す
    t.END  = t.PIKA + SLOT_BASE.HOLD;             // 退場開始＝ここでバッジにバトンを渡す
    t.GONE = t.END + SLOT_BASE.FADE;
    return t;
  }
  /* 相撲の尺（8/9 FB86・8/9 FB87で15体化。緑メンバー専用）
       COUNT     …何体で来るか（8/9 FB87でNaoto指定＝15体）
       STAGGER   …1体ずつずらす間隔ms（先頭から最後尾まで STAGGER×(COUNT-1)）
       CHARGE    …1体が奥から出て通り過ぎ切るまでのms（74%地点が「手前まで来た」瞬間）
       DODON_LAG …最後の1体が抜けてから文字が出るまでの間ms
       DODON2    …「どどん」の2発目までのms
       HOLD      …文字を見せる時間ms／FADE…退場ms
     ⚠️ENDがバッジまでの時間（fireHitFxがrainMsとして使う） */
  var SUMO_BASE = { COUNT: 15, STAGGER: 70, CHARGE: 3200,
    DODON_LAG: 220, DODON2: 300, HOLD: 3600, FADE: 450 };
  var SUMO_AR = 681 / 1000; // fx_sumo.png の実寸比（横/縦）＝絵を差し替えたらここも直す
  function sumoTimes() {
    var t = {};
    t.LAST   = SUMO_BASE.STAGGER * (SUMO_BASE.COUNT - 1) + SUMO_BASE.CHARGE; // 最後の1体が抜け切る
    t.BOOM   = t.LAST - 140;                                // 白フラッシュ＋揺れ＝群れが抜ける直前
    t.DODON  = t.LAST + SUMO_BASE.DODON_LAG;
    t.DODON2 = t.DODON + SUMO_BASE.DODON2;
    t.END    = t.DODON2 + SUMO_BASE.HOLD;                   // 退場開始＝ここでバッジにバトンを渡す
    t.GONE   = t.END + SUMO_BASE.FADE;
    return t;
  }

  /* 念仏の尺（8/9 FB88・黄メンバー専用）
       IN     …ふわっと出るまでのms（この間は合掌したまま）
       CALM   …静かに祈っている時間ms（呼吸でわずかに上下）
       SHAKE  …プルプルが4段階で増していく時間ms＝同時に顔へ寄る時間でもある
       SQUEEZE…見開く直前に「ぎゅっ」と溜める時間ms（この分だけOPENより手前で始まる）
       HALO   …見開いてから後光が回り出すまでの間ms
       HOLD   …見開いたあとの余韻ms／FADE…退場ms
     ⚠️ENDがバッジまでの時間（fireHitFxがrainMsとして使う）＝伸ばすと演出全体が長くなる */
  var PRAY_BASE = { IN: 60, CALM: 2200, SHAKE: 2300, SQUEEZE: 200, HALO: 120, HOLD: 1300, FADE: 450 };
  var PRAY_AR = 661 / 1000; // fx_pray.png の実寸比（横/縦）＝絵を差し替えたらここも直す
  var PRAY_ZOOM = 2.4;      // 見開く瞬間の寄り倍率（顔が枠いっぱいになる）
  function prayTimes() {
    var t = { IN: PRAY_BASE.IN };
    t.SHAKE = t.IN + PRAY_BASE.CALM;                              // 震え始め＝寄り始め
    t.S2 = t.SHAKE + Math.round(PRAY_BASE.SHAKE * 0.28);
    t.S3 = t.SHAKE + Math.round(PRAY_BASE.SHAKE * 0.54);
    t.S4 = t.SHAKE + Math.round(PRAY_BASE.SHAKE * 0.78);
    t.OPEN = t.SHAKE + PRAY_BASE.SHAKE;                           // カッ！＝見開く＋目がピカッ
    t.SQUEEZE = t.OPEN - PRAY_BASE.SQUEEZE;
    t.HALO = t.OPEN + PRAY_BASE.HALO;
    t.END  = t.OPEN + PRAY_BASE.HOLD;                             // 退場開始＝ここでバッジにバトンを渡す
    t.GONE = t.END + PRAY_BASE.FADE;
    return t;
  }

  /* お茶の尺（8/9 FB90・橙メンバーの2つ目の演出）
       WALK   …画面右からてくてく歩いて中央に着くまでのms
       STEP   …歩行2コマの切替間隔ms（小さいほど小刻み＝速足に見える）
       SETTLE …止まってから湯呑みを掲げるまでの間ms（一拍おく）
       RAISE  …掲げる動きのms
       BEAM_LAG…掲げてから湯呑みが光る（キラッ＋一筋の光）までのms（8/9 FB91）
       CAP_LAG …掲げてから「マテニチャー」が出はじめるまでのms／CAP_IN…じわっと出る時間ms
       HOLD   …文字を見せる時間ms／FADE…退場ms
     ⚠️ENDがバッジまでの時間（fireHitFxがrainMsとして使う）
     ⚠️WALKとSTEPは連動させる：歩く速さだけ変えると足の回転が合わず「滑って」見える
        （8/9 FB91で歩きをゆっくりに＝2.6→3.4秒／コマ切替も190→250msへ同率で延ばした） */
  var TEA_BASE = { WALK: 3400, STEP: 250, SETTLE: 260, RAISE: 420,
    BEAM_LAG: 180, CAP_LAG: 700, CAP_IN: 800, HOLD: 2400, FADE: 450 };
  var TEA_AR = 442 / 800; // fx_tea_*.png の実寸比（横/縦）＝絵を差し替えたらここも直す
  var TEA_CAP = "マテニチャー";
  function teaTimes() {
    var t = { STOP: TEA_BASE.WALK };                 // 中央で止まる
    t.RAISE = t.STOP + TEA_BASE.SETTLE;              // 掲げ始め
    t.BEAM  = t.RAISE + TEA_BASE.BEAM_LAG;           // 湯呑みがピカッ＋一筋の光
    t.CAP   = t.RAISE + TEA_BASE.CAP_LAG;            // 文字がじわっと出はじめる
    t.END   = t.CAP + TEA_BASE.CAP_IN + TEA_BASE.HOLD; // 退場開始＝ここでバッジにバトンを渡す
    t.GONE  = t.END + TEA_BASE.FADE;
    return t;
  }
  /* ⚠️CSSの .fx-tea-run { bottom: 6% } と対の値（足元のライン＝ワイプ高に対する比）。
     ニチャーのズーム原点をpxで計算するのに要る＝片方だけ直すと寄る先が顔からずれる */
  var TEA_BOTTOM = 0.06;

  /* ══════════ ニチャーの尺（8/29 Naoto案・橙メンバーの3つ目の演出） ══════════
     お茶（FB90）の派生。**中央に着くまでは完全にお茶と同じ**（同じ歩行2コマ・同じ尺を共有＝
     TEA_BASE.WALK/STEP/SETTLEをそのまま使う。Naoto指定「歩いてくるまでは一緒」）。
     そこから先が違う＝湯呑みを掲げずに、**立ち姿がニチャー顔に入れ替わり**、「ニチャ～」が
     じわっと出て、**顔がどんどんズームアップ**していく。
       MORPH_LAG …中央で一拍おいてから入れ替わりが始まるまでms（＝お茶が掲げ始めるのと同じ間）
       MORPH  …じわっと入れ替わる時間ms（クロスフェード）
       ZOOM_LAG…入れ替わってからカメラが寄り始めるまでms（ニチャー顔を一度見せる間）
       CAP_LAG…入れ替わりから「ニチャ～」が出はじめるまでms／CAP_IN…じわっと出る時間ms
       HOLD   …文字を見せる時間ms／FADE…退場ms
     ⚠️ズームの長さは定数で持たない＝**END−ZOOM**（退場の瞬間まで寄り続ける＝「どんどん」の担保）。
     ⚠️ENDがバッジまでの時間（fireHitFxがrainMsとして使う）＝7560ms＝**お茶と同じ**。
        意図的に揃えてある（同じ橙の人の演出で前奏の長さが変わらない） */
  var NICHA_BASE = { MORPH: 420, ZOOM_LAG: 240, CAP_LAG: 700, CAP_IN: 800, HOLD: 2400, FADE: 450 };
  /* 素材の実測値（⚠️**素材加工/fx_nicha_make.py が出力したものを丸ごと貼る**・手で書き換えない。
     絵を差し替えたら再実行して貼り直す）
       NICHA_AR …fx_nicha.png の実寸比（横/縦）
       NICHA_FX/FY …顔の中心（幅・高さに対する比）＝**ズームの原点**。目は閉じ絵なので
                    白目基準（peye方式）は使えず、上半身の肌の重心で測っている＝鼻〜口元に落ちる
       NICHA_SX …衣装（橙）の重心x＝**お茶の立ち姿と横位置を合わせる目印**。
                  ⚠️アルファの中央は使わない：湯呑み・やかんに引っ張られる
       TEA_SX   …同じ測り方をした fx_tea_stand.png 側の値（お茶の枠は4コマの合併なので
                  絵の中心と枠の中心が一致しない＝この2つを突き合わせて初めて重なる） */
  var NICHA_AR = 613 / 1300;
  var NICHA_FX = 0.5077, NICHA_FY = 0.2704;
  var NICHA_SX = 0.5238, TEA_SX = 0.5814;
  var NICHA_ZOOM = 3.6;    // 最終倍率＝顔が枠の高さの9割になる寄り（実測で決めた値）
  var NICHA_AIM_Y = 0.45;  // 寄り切ったとき顔の中心を置くワイプ内の高さ（比）
  var NICHA_CAP = "ニチャ～";
  function nichaTimes() {
    var t = { STOP: TEA_BASE.WALK };                    // 中央で止まる（ここまでお茶と同一）
    t.MORPH = t.STOP + TEA_BASE.SETTLE;                 // じわっと入れ替わり始め
    t.ZOOM  = t.MORPH + NICHA_BASE.ZOOM_LAG;            // 顔へ寄り始める
    t.CAP   = t.MORPH + NICHA_BASE.CAP_LAG;             // 文字がじわっと出はじめる
    t.END   = t.CAP + NICHA_BASE.CAP_IN + NICHA_BASE.HOLD; // 退場開始＝ここでバッジにバトンを渡す
    t.GONE  = t.END + NICHA_BASE.FADE;
    return t;
  }

  /* ══════════ ハイタッチの尺（8/28・ダブル的中＝橙×緑の共演） ══════════
     流れ＝①左右の画面外から2人がてくてく歩いてくる ②中央手前で止まって一拍おく
           ③パチン！＝白閃光＋衝撃波＋揺れの瞬間に**キメ絵へ差し替え** ④「W的中！！」⑤退場
       WALK   …画面外から止まる位置までのms（お茶と同じテンポ感＝Naoto指定「てくてく歩き」）
       STRIDE …1コマで背丈の何倍進むか＝**コマ送り間隔はここから逆算する**（spawnHitouchのstepMs）。
              ⚠️お茶FB91の教訓「歩く速さだけ変えると足の回転が合わず滑って見える」への答え。
                お茶は距離も間隔も固定値だったが、この演出は歩く距離がワイプ幅で変わる
                （①752px／②544px）ので、間隔を固定にすると狭い②で必ず滑る。実測値＝お茶の
                歩き（1コマ34px／背丈330px）から 0.104
       STEP_MIN/MAX …逆算した間隔の上下限ms（極端なワイプ比でパラパラ/ヌルヌルになるのを防ぐ）
       SETTLE …止まってから手を合わせるまでの間ms（一拍おく＝「せーの」の溜め）
       CAP_LAG…パチンから「W的中！！」が出はじめるまでms／CAP_IN…出る時間ms
       HOLD   …文字を見せる時間ms／FADE…退場ms
     ⚠️ENDがバッジまでの時間（fireHitFxがrainMsとして使う）＝約6.9秒。
        歩き→キメの差し替えは**閃光の下で行う**（8/28設計）。素材の縮尺は実測定数で合わせて
        あるが完全一致ではないので、閃光が消えてから切り替えると乗り換えが見える */
  var HT_BASE = { WALK: 4200, STRIDE: 0.104, STEP_MIN: 180, STEP_MAX: 620, SETTLE: 300,
    CAP_LAG: 620, CAP_IN: 700, HOLD: 2400, FADE: 450 };
  /* ⚠️大きさの基準は「背丈」ではなく**手の高さ**（8/28・合成方式への作り替えで変更）。
     絵によって腕を上げる高さが違うので、背丈を揃えると**手が合わない**。手を揃えると
     別の絵から来た2人に数%の身長差が出るが、そちらのほうが自然（＝身長差のある2人に見える）。
     0.469＝4色の平均の背丈がワイプ高の約76%になる値（実測の pHY から逆算）。
     ⚠️素材加工/fx_hitouch_make.py の検算画像も同じ数字を使っている＝変えたら両方直す */
  var HT_HANDH = 0.469; // 手を合わせる高さ＝足元のラインから上へ・ワイプ高に対する比
  var HT_BOTTOM = 0.96; // 足元のライン＝ワイプ高に対する比（1.0で下端）
  var HT_CAP_Y = 0.74;  // キメ文字の高さ＝ワイプ高に対する比
  /* 文字の大きさ＝ワイプ高に対する比（幅に収まらなければ自動で縮む）。
     8/29 Naoto「もっと大きく」で 0.17→0.26。またぎのときは**それぞれのワイプの中央**に置くので
     （境目に寄せていた頃と違い）幅に余裕があり、この大きさでも収まる */
  var HT_CAP_H = 0.26;
  /* ══════════ 色ごとの素材の実測値（8/28・合成方式） ══════════
     ⚠️**素材加工/fx_hitouch_make.py が出力したものを丸ごと貼る**（手で書き換えない）。
       絵を差し替えたら再実行して貼り直す。1つでも古いとパチンの瞬間にキャラが瞬間移動する。
     w*＝歩行素材／p*＝ハイタッチのポーズ素材
       AR   …横/縦
       SX   …衣装色の重心x（幅に対する比）＝歩き→ポーズで体を横に動かさないための目印
       pHX/pHY …手の接点（幅・高さに対する比）。**ここを相手の手と重ねる**
       Face …その絵がどちらを向いているか（"r"＝右向き／"l"＝左向き）。
              左に立つ人は右向きが要る＝違えば実行時に左右反転する
     ⚠️**この表に色を1行足すと、その色を含む組み合わせが全部増える**（ペアの表は持たない）。
       CSSにも3行（w1/w2/ポーズの画像指定）を足すこと＝overlay.cssの .ht-img.c-〇〇 の並び */
  var HT_CHARS = {
    orange: { wAR: 0.5990, wSX: 0.5350, wFace: "r",
              pAR: 0.6720, pSX: 0.4981, pHX: 0.9982, pHY: 0.3645, pFace: "r" },
    green:  { wAR: 0.5320, wSX: 0.4483, wFace: "l",
              pAR: 0.6960, pSX: 0.5055, pHX: 0.0000, pHY: 0.3718, pFace: "l" },
    blue:   { wAR: 0.5920, wSX: 0.4483, wFace: "l",
              pAR: 0.6600, pSX: 0.4809, pHX: 0.0000, pHY: 0.4038, pFace: "l" },
    pink:   { wAR: 0.5730, wSX: 0.5182, wFace: "l",
              pAR: 0.6590, pSX: 0.4579, pHX: 0.9982, pHY: 0.3890, pFace: "r" },
    yellow: { wAR: 0.5860, wSX: 0.5028, wFace: "l",
              pAR: 0.6950, pSX: 0.4367, pHX: 0.9983, pHY: 0.3938, pFace: "r" },
    red:    { wAR: 0.5980, wSX: 0.5252, wFace: "l",
              pAR: 0.6600, pSX: 0.5263, pHX: 0.0000, pHY: 0.3952, pFace: "l" }
  };
  /* 検証ハーネス（fxlab）専用の窓口＝ラボが「ペアになれる色」を知るため。
     ⚠️**必ずHT_CHARSの宣言より後に置く**（varの巻き上げでundefinedが入る・8/28に踏んだ）。
       これが空だとラボは的中を1人ぶんしか作れず、**またぎ表示で片方のワイプが空になる**。
       本番の動作には一切関与しない（__clearHitFx と同じ立ち位置） */
  window.__HT_COLORS = HT_CHARS;
  /* キメ文字（8/28 Naoto指定→同日改定）。
     ⚠️またぎ表示では**境目の線が文字を割る**（初版は「W的中！！」を境目の真上に1本置いたので
       「中」の真ん中を枠線が通った＝Naoto指摘）。**意味の切れ目で2枚に分け、線を挟んで並べる**＝
       左のワイプに「ダブル」／右のワイプに「的中！！」。単独表示（②③④）はつなげて1本で出す。
     ⚠️左右は**席順に関係なく固定**（文字は左から読むので反転させない）。
       キメ文字は .ht-world の外に置いてある＝左右反転の対象にならない */
  var HT_CAP = "ダブル的中！！";                     // 単独表示（1つのワイプに2人）
  var HT_CAP_L = "ダブル", HT_CAP_R = "的中！！";    // またぎ表示＝左のワイプ／右のワイプ
  function htTimes() {
    var t = { STOP: HT_BASE.WALK };                    // 2人が止まる
    t.CLAP = t.STOP + HT_BASE.SETTLE;                  // パチン！＝閃光・衝撃波・揺れ・キメ絵へ差し替え
    t.CAP  = t.CLAP + HT_BASE.CAP_LAG;                 // 文字が出はじめる
    t.END  = t.CAP + HT_BASE.CAP_IN + HT_BASE.HOLD;    // 退場開始＝ここでバッジにバトンを渡す
    t.GONE = t.END + HT_BASE.FADE;
    return t;
  }

  /* サンバの尺（8/10 FB121・赤メンバー専用＝ラボsambatest.htmlの本番移植）
       ENTER…中央にドン！と登場するms（この間はコマ送り開始前）
       DANCE…サンバ（3コマ送り＋紙吹雪＋♪）のms
       KIME …キメ（腕組み①コマ固定＋ズーム＋フラッシュ＋後光＋「〇〇的中！！」）のms
              （8/10 Naoto FBで1400→2600＝文字をもうちょい長く見せる）
       OUT  …退場フェードms／BEAT…1拍ms（コマ送りは1拍の半分刻み・①→②→③→②）
     ⚠️ENDがバッジまでの時間（fireHitFxがrainMsとして使う）＝約8.4秒 */
  var SAMBA_BASE = { ENTER: 500, DANCE: 5300, KIME: 2600, OUT: 600, BEAT: 500 };
  var SAMBA_AR = 1047 / 1000; // fx_samba1..3.png の実寸比（横/縦）＝絵を差し替えたらここも直す
  function sambaTimes() {
    var t = { ENTER: SAMBA_BASE.ENTER };
    t.KIME = SAMBA_BASE.ENTER + SAMBA_BASE.DANCE; // キメ開始（文字・フラッシュ・後光）
    t.END  = t.KIME + SAMBA_BASE.KIME;            // 退場開始＝ここでバッジにバトンを渡す
    t.GONE = t.END + SAMBA_BASE.OUT;
    return t;
  }

  /* ダンスの尺（8/25 Naoto依頼・赤メンバーの2つ目＝本人がクロール腕回しで踊る）
     流れ＝①腕回しループ（12コマ＝クロールの交互回し・手のひらが進行方向・クロスステップ）を
           LOOPS周 ②タメ→振り上げ→伸び上がり（3コマ）③キメ＝天指しポーズで静止
           （ズーム＋フラッシュ＋後光はサンバのキメと同型）
       STEP …ループ1コマms（12コマ×STEP＝1周1.2秒）／LOOPS…何周回すか
       FSTEP…フィニッシュ3コマ（タメ・振り上げ・伸び上がり）の1コマms
       HOLD …キメを見せる時間ms／FADE…退場ms
     ⚠️ENDがバッジまでの時間（fireHitFxがrainMsとして使う）＝約6.1秒
     ✅8/25 Naoto承認で本番投入済み（確率はMEMBER_RATES.red＝samba50/dance50・thanksは8/29に0%＝封印中） */
  var DANCE_BASE = { STEP: 100, LOOPS: 3, FSTEP: 170, HOLD: 2000, FADE: 450 };
  var DANCE_AR = 446 / 500; // fx_dance.png の1コマ実寸比（横/縦）＝絵を差し替えたら素材加工/fx_dance_make.pyの出力で更新
  var DANCE_LOOP_N = 12;    // 4×4シートの0..11＝腕回しループ／12タメ／13振り上げ／14伸び上がり／15キメ
  function danceTimes() {
    var t = { FIN: DANCE_BASE.STEP * DANCE_LOOP_N * DANCE_BASE.LOOPS }; // ループを回り切った時刻
    t.POSE = t.FIN + DANCE_BASE.FSTEP * 3;   // キメ（天指し）が出る時刻
    t.END  = t.POSE + DANCE_BASE.HOLD;       // 退場開始＝ここでバッジにバトンを渡す
    t.GONE = t.END + DANCE_BASE.FADE;
    return t;
  }

  /* アジャストの尺（8/11 FB130・青メンバーの2つ目の演出＝Naoto案）
       流れ＝①「アジャ・・」が右から左へ流れる（最初は少なく→どんどん多く）②一通り流れたら
             本人が右からてくてく歩いてきて中央で止まる③一拍→しゃがんで溜める
             ④バッ！とダブルバイセップス＝「アジャストー！！」がドン
       RAIN   …「アジャ・・」を湧かせ続ける時間ms（湧いた文字はこの後FLYぶん流れて消える）
       AJA_N  …「アジャ・・」の総数／FLY_MIN/MAX…1枚が流れ切るms（個体差のランダム幅）
       RAINGAP…湧き終わりから歩き出しまでの間ms（流れの残りをはかせる＝「一通り流れた後」）
       WALK   …右画面外→中央までのms／STEP…歩き2コマの切替間隔ms（⚠️WALKと同率で動かす＝お茶の教訓）
       PAUSE  …中央到着（直立①）から溜めまでの一拍ms／TAME…しゃがみ溜めms
       HOLD   …キメ（④＋文字）を見せる時間ms／FADE…退場ms
     ⚠️ENDがバッジまでの時間（fireHitFxがrainMsとして使う）＝約10.3秒 */
  var ADJ_BASE = { RAIN: 3000, AJA_N: 26, FLY_MIN: 1400, FLY_MAX: 2200, RAINGAP: 800,
    WALK: 3000, STEP: 260, PAUSE: 450, TAME: 420, HOLD: 2600, FADE: 500 };
  var ADJ_AR = 693 / 1000; // fx_adj1..4.png の実寸比（横/縦）＝絵を差し替えたら素材加工/fx_adjust_make.pyを再実行
  var ADJ_KIME = "アジャストー！！";
  function adjTimes() {
    var t = { WALKIN: ADJ_BASE.RAIN + ADJ_BASE.RAINGAP };  // 歩き出し
    t.STOP = t.WALKIN + ADJ_BASE.WALK;                     // 中央到着＝直立①で一拍
    t.TAME = t.STOP + ADJ_BASE.PAUSE;                      // しゃがんで溜め始める
    t.POSE = t.TAME + ADJ_BASE.TAME;                       // バッ！＝ダブルバイセップス④＋「アジャストー！！」
    t.END  = t.POSE + ADJ_BASE.HOLD;                       // 退場開始＝ここでバッジにバトンを渡す
    t.GONE = t.END + ADJ_BASE.FADE;
    return t;
  }

  /* ピーターズ・アイの尺（8/25 Naoto案・緑メンバーの2つ目の演出）
       由来＝ピーターの口癖「これはピーターズ・アイだと、、1-2-3だな！」（接戦の着順を見抜く目）。
       流れ＝①ニコニコ(f1)登場②暗転＝シルエットで顔に寄る③閃光が左→右へピカーン＋集中線＋揺れ
             ④「ピーターズ・アイ発動！！」⑤「これは、、、」（覗き込む溜め）⑥白フラッシュ明転＝キリッ(f2)
             ⑦的中目を車番チップで「[1][2][3]だ！！」。文言は一つずつ＝次が出たら前は消える（Naoto FB）。
       IN…①がふわっと出るms／CALM…いつもの顔で見せる間／DARK…暗転にかかるms
       TENSE…暗闇の溜めms（⚠️DARKと合わせた1.6秒＝overlay.cssの.fx-peye-zoomの寄り所要と連動＝変えたら両方直す）
       TITLE_LAG…閃光→「発動！！」の間／TITLE_HOLD…発動を見せる間（切れたら「これは、、、」へ）
       MUT_HOLD…「これは、、、」で覗き込む間／COMBO_LAG…明転→車番バッジの間
       HOLD…キメを見せる間／FADE…退場ms
     ⚠️ENDがバッジまでの時間（fireHitFxがrainMsとして使う）＝約8.35秒（相撲8.3s・サンバ8.4sと同じ帯）
     ラボ原型＝検証ハーネス/peyetest.html（自己完結写し）。素材＝素材加工/fx_peye_make.py
     ⚠️「目だけ明るく」案は8/25実見→Naoto判断で撤回済み＝再提案しない */
  var PEYE_BASE = { IN: 500, CALM: 800, DARK: 700, TENSE: 900, TITLE_LAG: 200,
    TITLE_HOLD: 1300, MUT_HOLD: 1400, COMBO_LAG: 350, HOLD: 2200, FADE: 450 };
  var PEYE_AR = 688 / 1000;  // fx_peye1..2.png の実寸比（fx_peye_make.pyが出力・絵を差し替えたら再実行して貼り直す）
  var PEYE_EYE = { y: 0.4084, xc: 0.4193 }; // 目のライン／左右の目の中点（同上＝白目重心の実測。集中線・寄り・閃光の中心）
  /* 集中線を実寸で持つ上限px（8/30）。超えたぶんはCSSのscale（--lsc）で伸ばす＝spawnPeyeのコメント参照。
     ⚠️本番のワイプは①1,955px／②1,414pxで**どちらもこの下**＝本番の見た目は一切変わらない。
       下げると全画面のマスク輪郭が甘くなり、上げると塗り面積が二乗で増える（2,200²×2枚＝9.7MP） */
  var PEYE_LINES_MAX = 2200;
  /* 軽量版（fxLite＝大きい箱）でのさらに小さい上限。全画面(1920)なら本来4,992px角＝a・b2枚で49.8MP
     ＝画面24枚ぶんを塗る。1,400pxまで落とすと2枚で3.9MP＝**約1/13**。
     ⚠️本番は fxLite が立たないので常に PEYE_LINES_MAX(2200) 側＝今までと同一。
     ⚠️MAXより小さいこと自体をhosttestが見ている（逆転させると軽量版のほうが重くなる） */
  var PEYE_LINES_LITE = 1400;
  function peyeTimes() {
    var t = { DK: PEYE_BASE.IN + PEYE_BASE.CALM };        // 暗転開始＝寄り開始
    t.GLINT = t.DK + PEYE_BASE.DARK + PEYE_BASE.TENSE;    // 閃光ピカーン＋集中線＋揺れ
    t.TITLE = t.GLINT + PEYE_BASE.TITLE_LAG;              // 「ピーターズ・アイ発動！！」
    t.MUT = t.TITLE + PEYE_BASE.TITLE_HOLD;               // 「これは、、、」じわっ（＝発動消える）
    t.REVEAL = t.MUT + PEYE_BASE.MUT_HOLD;                // 白フラッシュ＝明転・キリッに切替（＝これは消える）
    t.COMBO = t.REVEAL + PEYE_BASE.COMBO_LAG;             // 車番チップ[1][2][3]＋「だ！！」
    t.END = t.COMBO + PEYE_BASE.HOLD;                     // 退場開始＝バッジにバトンを渡す
    t.GONE = t.END + PEYE_BASE.FADE;
    return t;
  }

  /** 的中の組合せ（comboLabel "1-3-5"）→ リールに出す車番配列。
      手動追加の的中はcomboLabelを持たない＝数字を作り話にしないため空配列を返す（呼び出し側で走行に落とす） */
  function slotCombo(hit) {
    var out = [];
    String((hit && hit.comboLabel) || "").split("-").forEach(function (tk) {
      var n = parseInt(tk, 10);
      if (n >= 1 && n <= 9) out.push(n);
    });
    return (out.length >= 2 && out.length <= 3) ? out : [];
  }

  ["blue", "green", "orange", "red", "pink", "yellow"].forEach(function (k) {
    var im = new Image(); im.src = "ic_" + k + ".png"; // 先読み＝初回的中でアイコンが欠けない
  });
  (function () { var im = new Image(); im.src = "fx_coin.png"; })(); // 役物のコインも先読み（8/8 FB82）
  (function () { var im = new Image(); im.src = "fx_sumo.png"; })(); // 相撲も先読み（8/9 FB86）
  ["fx_tea_w1.png", "fx_tea_w2.png", "fx_tea_stand.png", "fx_tea_up.png"].forEach(function (f) {
    var im = new Image(); im.src = f;   // お茶は4コマ（8/9 FB90）＝歩き出しでコマ落ちしないよう先読み
  });
  (function () { var im = new Image(); im.src = "fx_nicha.png"; })(); // ニチャー（8/29・橙の3つ目）＝
  // ⚠️先読み必須：入れ替えはクロスフェード＝読み込みが遅れると「立ち姿が消えて空白」の瞬間ができる
  ["fx_adj1.png", "fx_adj2.png", "fx_adj3.png", "fx_adj4.png"].forEach(function (f) {
    var im = new Image(); im.src = f;   // アジャストも4コマ（8/11 FB130）＝同じく先読み
  });
  ["fx_peye1.png", "fx_peye2.png"].forEach(function (f) {
    var im = new Image(); im.src = f;   // ピーターズ・アイは2コマ（8/25）＝明転の切替でコマ落ちしないよう先読み
  });
  ["fx_pray.png", "fx_pray_shut.png",
   "fx_pray_ng.png", "fx_pray_shut_ng.png"].forEach(function (f) {   // 念仏は2枚重ね（8/9 FB88）＋眼鏡なし版（8/31）
    var im = new Image(); im.src = f;                                // ⚠️閉じ目が遅れて乗ると開き目で始まる
  });
  ["fx_samba1.png", "fx_samba2.png", "fx_samba3.png"].forEach(function (f) {
    var im = new Image(); im.src = f;  // サンバは3コマ（8/10 FB121）＝初回的中でコマ落ちしないよう先読み
  });
  ["fx_slotchar1.png", "fx_slotchar2.png"].forEach(function (f) {
    var im = new Image(); im.src = f;  // スロットのキャラ2ポーズ（8/10 FB122）＝入場でコマ落ちしないよう先読み
  });
  /** メンバーカラー→色キー（未登録の色は個人演出なし＝アイコンも雨も出ない従来動作） */
  function memberKey(rc) { return rc && COLOR_KEY[rc.color] ? COLOR_KEY[rc.color] : ""; }
  /* ══════════ 大きい箱のときだけ落とす「軽量版」の判定（8/30）══════════
     演出を全画面に出す試作（§出し先）で、アイコン走行とピーターズ・アイが実測でカクついた。
     真因は要素数ではなく**塗る面積**＝箱が6.5倍になれば、体数を増やさなくても
     1体が2.55倍になるので総ピクセルは6.5倍のまま。そこで面積で効く部品を落とす：
       ・per要素のフィルタ（drop-shadow／blur）＝要素ごとに別パスが走る
       ・砂埃の雲＝1.5em×1.05emをscale2.2まで育てる＝いちばん塗る部品
       ・集中線のテクスチャ＝下の PEYE_LINES_LITE でさらに小さく持つ

     ⚠️閾値は**本番のワイプがどれも絶対に届かない**値にしてある（本番最大＝①トーク752×423＝318,096px。
       ②544×404＝219,776／④480×270＝129,600／⑤560×315＝176,400）。
       つまり本番の**ワイプ**の見た目は変わらない＝hosttest.js が4種すべてを検算している。
       全画面ホスト（＝万車の前奏・8/30に本番機能へ昇格）では**意図して**掛かる＝そのための軽量版。
     ⚠️ここを下げると本番のワイプにも掛かる（＝影が消える・砂埃が半分になる）。下げるなら必ずNaotoに確認。 */
  var FX_LITE_AREA = 600000;
  function fxLite(cam) {
    return (cam.clientWidth || 0) * (cam.clientHeight || 0) > FX_LITE_AREA;
  }

  /* 大きい箱（fx-proto-host）に出すときの拡大率＝ホスト面積÷そのシーンのワイプ面積の**平方根**
     （線形比）。走行の1体をこれで伸ばすと、体数80のまま見た目の密度が変わらない（「大きさで追従」・
     8/30決定）。ワイプに出すときは必ず1＝本番のワイプの見た目は不変。
     ラボ（fxlab）は __FX_SCALE で明示上書きできる（spawnRain側が先に見る・「そのまま」比較用） */
  function fxScale(cam) {
    if (!cam.classList || !cam.classList.contains("fx-proto-host")) return 1;
    var wipe = document.querySelector("#scene-" + SCENE + " .cam");
    var a = wipe ? wipe.clientWidth * wipe.clientHeight : 0;
    var m = (cam.clientWidth || 0) * (cam.clientHeight || 0);
    return a > 0 && m > 0 ? Math.sqrt(m / a) : 1;
  }

  function fxConf(key) {
    var c = MEMBER_FX[key] || {};
    return { fx: c.fx || [], count: c.count || RAIN_DEFAULT.count, size: c.size || RAIN_DEFAULT.size,
      dur: c.dur || RAIN_DEFAULT.dur, rainMs: c.rainMs || RAIN_DEFAULT.rainMs };
  }

  /* 的中者アイコンの走行（8/7 FB65→FB67で真横化）：バッジの前にその人のアイコンが右→左へ流れる前奏。
     アイコンは色キー→中立ファイル名で解決（的中者との一致は色キーで構造保証） */
  function spawnRain(cam, key) {
    var old = cam.querySelector(".hit-rain");
    if (old) old.parentNode.removeChild(old);
    var conf = fxConf(key);
    var box = document.createElement("div");
    var lite = fxLite(cam);
    box.className = ["hit-rain", "m-" + key].concat(conf.fx).join(" ") + (lite ? " lite" : "");
    var w = cam.clientWidth || 400, h = cam.clientHeight || 400;
    /* 箱を広げたときの1体の大きさ＝「大きさで追従」（8/30決定・fxScaleのコメント参照）。
       ラボ（fxlab）だけが __FX_SCALE で明示上書き（「そのまま」との見比べ用）。
       本番＝ワイプなら fxScale が1を返す＝従来どおり／万車の全画面ホストなら線形比で伸びる。
       ⚠️体数を面積比ぶん増やす案（80→521体）は8/30に実測でカクついて**廃止**（Naoto判断）。
         なお「大きさで追従なら軽い」わけではない＝**塗る面積は結局6.5倍のまま**（体数を減らしても
         1体が大きくなる）。効いているのはフィルタと雲の塗りなので、そこは lite が落とす。 */
    var scale = window.__FX_SCALE || fxScale(cam);
    // FB66：既定は数80・1体2.2〜3.2秒・群れ全体で約4.5秒（中央ゆっくりのS字＝CSS側）
    // FB67：右→左の真横走行＋砂埃。laneT＝奥行き（下のレーンほど大きく手前・前面に）
    for (var i = 0; i < conf.count; i++) {
      var run = document.createElement("span");
      run.className = "hit-runner";
      var laneT = Math.random();
      // 手前ほど大きい（砂埃は親のfont-size基準のemなので、この1か所を倍率で伸ばせば全部ついてくる）
      var size = Math.round((conf.size[0] + laneT * (conf.size[1] - conf.size[0])) * scale);
      run.style.top = Math.round(h * 0.06 + laneT * h * 0.60) + "px";
      run.style.left = "100%";
      run.style.fontSize = size + "px"; // 砂埃のサイズをキャラに連動させる基準（em）
      run.style.zIndex = String(1 + Math.round(laneT * 5));
      run.style.setProperty("--dx", -(w + 700) + "px");
      run.style.setProperty("--dur", (conf.dur[0] + Math.random() * (conf.dur[1] - conf.dur[0])).toFixed(2) + "s");
      run.style.setProperty("--dly", (Math.random() * 2.2).toFixed(2) + "s");
      var im = document.createElement("img");
      im.className = "hit-rain-ic";
      im.src = "ic_" + key + ".png";
      im.style.height = size + "px";
      run.appendChild(im);
      var d1 = document.createElement("i"); d1.className = "dust";
      run.appendChild(d1);
      // 砂埃の2枚目は lite では出さない＝**塗り面積のいちばん大きい部品**（雲は1.5em×1.05emを
      // scale2.2まで育てる＝1枚で1体ぶんの数倍）。大きい箱では1枚でも見た目の密度は足りる
      if (!lite) {
        var d2 = document.createElement("i"); d2.className = "dust d2";
        run.appendChild(d2);
      }
      box.appendChild(run);
    }
    cam.appendChild(box);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, conf.rainMs + 1200);
  }

  /* 役物合体（8/8 FB82・青メンバー専用）：コイン1枚を4象限に割り、四隅から寄せて合体させる。
     この演出のメンバーはアイコン走行を出さない（fireHitFx側で分岐）＝二重演出にしない */
  function spawnYakumono(cam, key) {
    var old = cam.querySelector(".fx-yak");
    if (old) old.parentNode.removeChild(old);
    var T = yakTimes();
    // コイン全体の大きさ＝枠に収まる範囲で縦横比を保つ（カケラ1枚はその半分）。
    // ⚠️四隅に散らした状態でも枠内に収まることが上限（合体後の大きさだけで決めると散開時に見切れる）
    var AR = 448 / 404; // fx_coin.png の実寸比
    var maxW = cam.clientWidth * .52, maxH = cam.clientHeight * .62;
    var fullW = Math.min(maxW, maxH * AR);
    var pw = Math.round(fullW / 2), ph = Math.round(fullW / AR / 2);
    var box = document.createElement("div");
    box.className = ["fx-yak", "m-" + key].join(" ");
    box.style.setProperty("--pw", pw + "px");
    box.style.setProperty("--ph", ph + "px");
    box.style.setProperty("--fly", (T.FLY / 1000) + "s");

    var W = cam.clientWidth || 400, H = cam.clientHeight || 400, GAP = .30;
    var defs = [ // 出発点＝枠外の四隅／待機位置＝合体位置から外へ少し離す
      { cls: "tl", ox: -W * .75, oy: -H * .85, rot: "-22deg", gx: -pw * GAP, gy: -ph * GAP },
      { cls: "tr", ox:  W * .75, oy: -H * .85, rot:  "20deg", gx:  pw * GAP, gy: -ph * GAP },
      { cls: "bl", ox: -W * .75, oy:  H * .85, rot:  "18deg", gx: -pw * GAP, gy:  ph * GAP },
      { cls: "br", ox:  W * .75, oy:  H * .85, rot: "-24deg", gx:  pw * GAP, gy:  ph * GAP },
    ];
    var pieces = defs.map(function (d) {
      var el = document.createElement("div");
      el.className = "fx-piece " + d.cls;
      el.style.setProperty("--ox", Math.round(d.ox) + "px");
      el.style.setProperty("--oy", Math.round(d.oy) + "px");
      el.style.setProperty("--rot", d.rot);
      el.style.setProperty("--gx", Math.round(d.gx) + "px");
      el.style.setProperty("--gy", Math.round(d.gy) + "px");
      box.appendChild(el);
      return el;
    });
    // fx-rimlight＝合体の瞬間のフチ光（8/11 FB131・Naoto「フチがもっとピカっと」）。
    // カケラの背後（haloの上）に置く＝白シルエット本体はコインに隠れ、はみ出したフチと後光だけが見える
    ["fx-halo", "fx-rimlight", "fx-boom", "fx-ring", "fx-ring r2"].forEach(function (c) {
      var e = document.createElement("div"); e.className = c;
      if (c === "fx-halo" || c === "fx-rimlight") box.insertBefore(e, pieces[0]); else box.appendChild(e);
    });
    cam.appendChild(box);

    setTimeout(function () { pieces.forEach(function (p) { p.classList.add("in"); }); }, T.IN);
    setTimeout(function () { pieces.forEach(function (p) { p.classList.add("shake"); }); }, T.SHAKE);
    setTimeout(function () {
      pieces.forEach(function (p) { p.classList.remove("shake"); p.classList.add("lock"); });
      box.classList.add("boom");
    }, T.LOCK);
    setTimeout(function () { box.classList.remove("boom"); box.classList.add("glow"); }, T.GLOW);
    setTimeout(function () { box.classList.add("out"); }, T.END);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, T.GONE);
  }

  /* スロット（8/8 FB83・ピンクメンバー専用）：当たり目の車番を1つずつリールに割り当て、
     左から順に「クルクル→減速→ドン」で停める。全部揃ったら箱ごとピカピカ光ってバッジへ。
     このメンバーはアイコン走行を出さない（fireHitFx側で分岐）＝二重演出にしない。
     ⚠️寸法はここでpx計算して固定する＝回っている間と停まった後で見た目が変わらない
       （幅autoのflex縮みに任せると、✨の出入りやコマ数でリール幅が動く。試作版の違和感の正体） */
  function spawnSlot(cam, key, hit, combo) {
    var old = cam.querySelector(".fx-slot");
    if (old) old.parentNode.removeChild(old);
    var oldC = cam.querySelector(".fx-schar");
    if (oldC) oldC.parentNode.removeChild(oldC);
    var n = combo.length;
    var T = slotTimes(n);
    var cw = cam.clientWidth || 400, ch = cam.clientHeight || 300;
    var RAD = Math.PI / 180;
    // 箱幅＝cell*n ＋ すき間(cell*.14)*(n-1) ＋ 内余白(cell*.18)*2
    var wUnit = n + 0.14 * (n - 1) + 0.36;
    /* キャラの幾何（8/10 FB122・8/10 FB123で右側へ移設）＝すべて「拳＝レバーの玉」から逆算する：
         レバーは右側面（既定＝静止−10°で筐体側へ傾く）→玉の静止位置(knob)を計算
         →キャラは「②の拳（絵を左右反転して使う＝x比率 1-SCHAR_FX）が玉に重なる」大きさに置き、
         立ち位置はそこから SCHAR_DY だけ下げる（FB123・拳と玉の完全一致は不要＝Naoto了承）。
       キャラの胴体は筐体の右に立ち、腕側は筐体の背面(z順で下)に隠れる＝リールの出目は隠れない */
    var boxHu = 1.36;                                                  // 箱高（cell単位・cell+pad×2）
    var knobYu = 0.54 * boxHu - Math.cos(10 * RAD) * 0.75 - 0.036;     // 玉中心y（箱上端基準・少し上に出る）
    var knobXu = 0.15 - Math.sin(10 * RAD) * 0.75;                     // 玉中心x（箱右端基準・ほぼ右上角）
    var fxm = 1 - SCHAR_FX;                                            // 反転後の拳x比率（画像左端基準）
    var charHu = (boxHu - knobYu) / (1 - SCHAR_FY);                    // 拳の高さ＝玉・足元＝箱の底（下げる前）
    var charWu = charHu * SCHAR_AR;
    var overUnit = knobXu + SCHAR_FX * charWu;                         // 筐体右への張り出し幅（cell単位）
    var cell = Math.floor(Math.min((cw * 0.88) / (wUnit + overUnit), (ch * 0.80) / (charHu + SCHAR_DY)));
    if (cell < 24) cell = 24;
    var gap = Math.round(cell * 0.14), pad = Math.round(cell * 0.18);
    var box = document.createElement("div");
    box.className = ["fx-slot", "m-" + key].join(" ") + (hit && hit.manche ? " manche" : "");
    box.style.setProperty("--cell", cell + "px");
    box.style.setProperty("--gap", gap + "px");
    box.style.setProperty("--pad", pad + "px");
    box.style.setProperty("--lvms", (SLOT_BASE.LEVER / 1000) + "s");
    var bw = cell * n + gap * (n - 1) + pad * 2;
    var bh = cell + pad * 2;
    box.style.width = bw + "px";
    // キャラの張り出しぶん筐体を左へ寄せる＝「キャラ＋筐体」で見た目の中心を取る（FB122・FB123で右→左に反転）
    var over = Math.round(overUnit * cell);
    box.style.marginLeft = -Math.round(over / 2) + "px";
    ["s1", "s2", "s3", "s4"].forEach(function (c) { // ✨は絶対配置＝レイアウトに参加しない
      var sp = document.createElement("span");
      sp.className = "fx-spark " + c; sp.textContent = "✨";
      box.appendChild(sp);
    });
    var base = document.createElement("div"); base.className = "fx-lever-base";
    var lever = document.createElement("div"); lever.className = "fx-lever";
    lever.innerHTML = '<i class="fx-rod"></i><i class="fx-knob"></i>';
    box.appendChild(base); box.appendChild(lever);
    var reels = combo.map(function (num) { return buildSlotReel(box, num, cell); });
    cam.appendChild(box);
    // キャラ本体（camに絶対配置・z＝筐体より下＝重なった腕側は筐体の裏に隠れる）
    var charH = Math.round((bh - knobYu * cell) / (1 - SCHAR_FY));
    var charW = Math.round(charH * SCHAR_AR);
    var boxAbsL = Math.round((cw - bw) / 2 - over / 2);
    var boxAbsT = Math.round((ch - bh) / 2);
    var charAbsL = Math.round(boxAbsL + bw + knobXu * cell - fxm * charW);
    var charAbsT = Math.round(boxAbsT + bh - charH + SCHAR_DY * cell);         // FB123＝立ち位置を下げる
    var schar = document.createElement("div");
    schar.className = "fx-schar";
    schar.style.left = charAbsL + "px";
    schar.style.top = charAbsT + "px";
    schar.style.width = charW + "px";
    schar.style.height = charH + "px";
    schar.style.setProperty("--hx", (cw - charAbsL + 30) + "px");              // 右画面外からの距離
    schar.style.setProperty("--hop", (SLOT_BASE.HOP / 1000) + "s");
    schar.style.setProperty("--hopstep", (SLOT_BASE.HOPSTEP / 1000) + "s");
    schar.style.setProperty("--hopd", (SLOT_BASE.WAIT / 1000) + "s");          // 筐体を見せる間だけ待つ
    schar.style.setProperty("--tame", (SLOT_BASE.TAME / 1000) + "s");          // しゃがみ込みの尺
    schar.innerHTML = '<div class="fx-schar-run"><div class="fx-schar-body">' +
      '<i class="fx-schar-img p1 on"></i><i class="fx-schar-img p2"></i></div></div>';
    cam.appendChild(schar);
    runSlotReels(reels, T, cell);
    setTimeout(function () {  // 到着＝ぴょんぴょん停止（①のまま一拍おく）
      schar.classList.add("arrive");
    }, T.ARRIVE);
    setTimeout(function () {  // しゃがんで溜める
      schar.classList.add("tame");
    }, T.TAME);
    setTimeout(function () {  // バッと立ち上がる＝手上げ②へ切替・その手でレバーを引く
      schar.classList.remove("tame");
      schar.classList.add("up");
      var i1 = schar.querySelector(".p1"), i2 = schar.querySelector(".p2");
      if (i1) i1.classList.remove("on");
      if (i2) i2.classList.add("on");
      lever.classList.add("pull");
    }, T.PULL);
    setTimeout(function () { lever.classList.remove("pull"); lever.classList.add("back"); }, T.SPIN);
    setTimeout(function () { box.classList.add("pika"); }, T.PIKA);
    setTimeout(function () { box.classList.add("out"); schar.classList.add("out"); }, T.END);
    setTimeout(function () {
      if (box.parentNode) box.parentNode.removeChild(box);
      if (schar.parentNode) schar.parentNode.removeChild(schar);
    }, T.GONE);
  }
  /** リール1本＝1〜9をシャッフルした9コマを2周ぶん並べたもの（2周ぶん描くと継ぎ目なくループできる） */
  function buildSlotReel(box, target, cell) {
    var el = document.createElement("div"); el.className = "fx-reel";
    var strip = document.createElement("div"); strip.className = "fx-strip";
    var seq = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    for (var i = seq.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)), tmp = seq[i]; seq[i] = seq[j]; seq[j] = tmp;
    }
    for (var k = 0; k < seq.length * 2; k++) {
      var num = seq[k % seq.length];
      var c = document.createElement("div"); c.className = "fx-cell";
      c.innerHTML = '<i class="car c' + num + '">' + num + "</i>";
      strip.appendChild(c);
    }
    el.appendChild(strip);
    var fl = document.createElement("div"); fl.className = "fx-flash"; el.appendChild(fl);
    box.appendChild(el);
    return { el: el, strip: strip, target: seq.indexOf(target) * cell };
  }
  /** 回転の駆動（requestAnimationFrame 1本で3リールぶん）。
      前半＝等速（クルクル）／後半DECEL＝easeOutQuadで減速し、当たり目にピタリで着地。
      位置は「1周ぶんで折り返す」剰余で持つので、何秒回してもコマは尽きない。
      ⚠️減速の距離distは「1周ぶんの端数＋必要なら1周」＝等速の速さと減速開始の速さが極端にズレない値を選ぶ
        （でないと減速の頭で急に速くなったり失速したりして見える）
      ⚠️位置は「経過時刻から毎回計算し直す」＝コマ送りの積み上げにしない。
         OBSの裏に回ったソースやヘッドレスではrAFが1枚も来ないことがあり（実測で確認）、
         積み上げ方式だと回転が途中で凍って当たり目に着かない。
         同じ理由で「ドン」と最終位置の固定はsetTimeout側で必ず打つ＝rAFはあくまで滑らかさの担当 */
  function runSlotReels(reels, T, cell) {
    var loopH = SLOT_LOOP * cell;
    var v = cell / SLOT_BASE.CELL_MS;          // 等速の速さ（px/ms）
    var ideal = v * SLOT_BASE.DECEL / 2;       // easeOutQuadで速度が繋がる理想の減速距離
    var nowMs = function () {
      return (window.performance && performance.now) ? performance.now() : Date.now();
    };
    reels.forEach(function (r, i) {
      r.stopAt = T.STOPS[i] - T.SPIN;  // 「回り出してから」の相対ms（レバーを引く間は止まっている）
      r.decelAt = Math.max(0, r.stopAt - SLOT_BASE.DECEL);
      r.decelLen = r.stopAt - r.decelAt;
      r.base = v * r.decelAt;
      var need = ((r.target - r.base) % loopH + loopH) % loopH; // 当たり目まであと何px
      r.dist = need + loopH * Math.max(0, Math.round((ideal - need) / loopH));
      r.done = false;
    });
    var last = reels[reels.length - 1].stopAt;
    var t0 = nowMs() + T.SPIN;         // 回転開始の時刻
    function place(r, t) {
      var off;
      if (t < r.decelAt) off = v * t;
      else if (t < r.stopAt) {
        var p = (t - r.decelAt) / r.decelLen;
        off = r.base + r.dist * (1 - (1 - p) * (1 - p)); // easeOutQuad
      } else {
        off = r.base + r.dist;                           // ＝当たり目（剰余で一致する）
      }
      r.strip.style.transform = "translateY(-" + (off % loopH).toFixed(1) + "px)";
    }
    reels.forEach(function (r) {
      place(r, 0); // レバーを引き終わるまでは止まったまま見せる
      setTimeout(function () { // ドン！＝停止の跳ね＋白フラッシュ。位置もここで確実に当たり目へ
        r.done = true;
        place(r, r.stopAt);
        r.el.classList.add("don");
      }, T.SPIN + r.stopAt);
    });
    function frame() {
      var t = nowMs() - t0;
      if (t >= 0) reels.forEach(function (r) { if (!r.done) place(r, t); });
      if (t < last + 40 && document.body.contains(reels[0].el)) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* 相撲（8/9 FB86・緑メンバー専用）：奥から張り手で迫る→カメラを通り過ぎる→「ごっちゃんです！！」がどどん！
     このメンバーはアイコン走行を出さない（fireHitFx側で分岐）＝二重演出にしない */
  function spawnSumo(cam, key, hit) {
    var old = cam.querySelector(".fx-sumo");
    if (old) old.parentNode.removeChild(old);
    var T = sumoTimes();
    var cw = cam.clientWidth || 400, ch = cam.clientHeight || 300;
    var lite = fxLite(cam);   // 全画面ホスト＝通過倍率とテクスチャを抑える（overlay.cssの.fx-sumo.lite参照）
    // 手前まで来たとき（scale 1）＝枠の縦を少しはみ出す大きさ＝「デカい」印象を作る
    var sh = Math.round(ch * 1.12), sw = Math.round(sh * SUMO_AR);
    var box = document.createElement("div");
    box.className = ["fx-sumo", "m-" + key].join(" ") + (lite ? " lite" : "");
    box.style.setProperty("--sw", sw + "px");
    box.style.setProperty("--sh", sh + "px");
    /* どどんの集中線＝peyeの集中線と同じ理屈でテクスチャに上限（liteのみ・全画面だと3072px角
       ＝9.4MPをdodonの瞬間に初描画していた）。maskで内側が抜けたドーナツなので、
       多少小さくても文字の後光としての役は変わらない */
    var burst = Math.round(Math.max(cw, ch) * 1.6);
    if (lite) burst = Math.min(burst, 2200);
    box.style.setProperty("--burst", burst + "px");
    /* 群れ（8/9 FB87）：先頭は中央・ど真ん中を通す。以降は左右交互に振り分けて
       だんだん外側＆小さめ（＝奥のレーン）にする。横位置はscaleの内側で効くので
       奥では中央の一点に集まり、近づくにつれて扇状に広がる */
    for (var i = 0; i < SUMO_BASE.COUNT; i++) {
      var run = document.createElement("div");
      run.className = "fx-sumo-run" + (i === 0 ? " lead charge" : " charge");
      var lane = Math.ceil(i / 2);                                   // 0,1,1,2,2,3,3…＝中央からの遠さ
      var side = (i % 2) ? 1 : -1;
      var s = i === 0 ? 1.06 : Math.max(0.5, 1.02 - lane * 0.075 + (Math.random() - .5) * .08);
      var dx = side * (lane * cw * 0.30 + (Math.random() - .5) * cw * 0.10) / s; // 手前での実距離をsで割り戻す
      var dy = (Math.random() - .5) * ch * 0.22 / s;
      run.style.setProperty("--s", s.toFixed(3));
      run.style.setProperty("--dx", Math.round(dx) + "px");
      run.style.setProperty("--dy", Math.round(dy) + "px");
      run.style.setProperty("--t", (SUMO_BASE.CHARGE / 1000) + "s");
      run.style.setProperty("--d", (i * SUMO_BASE.STAGGER / 1000) + "s");
      run.style.setProperty("--slap", (0.38 + Math.random() * 0.12).toFixed(2) + "s"); // 張り手の速さを個体差に
      run.style.zIndex = String(1 + Math.round(s * 10));             // 大きい＝手前
      // 張り手の白い衝撃は手前の数体だけ（15体ぶん光らせるとチカチカしすぎ＆重い）
      run.innerHTML = '<i class="fx-sumo-img"></i>' +
        (s >= 0.9 ? '<i class="fx-slap s-l"></i><i class="fx-slap s-r"></i>' : "");
      box.appendChild(run);
    }
    var flash = document.createElement("div"); flash.className = "fx-sumo-flash";
    var burst = document.createElement("div"); burst.className = "fx-gotchan-burst";
    var text = document.createElement("div"); text.className = "fx-gotchan";
    text.innerHTML = "<span>ごっちゃんです！！</span>";
    box.appendChild(flash); box.appendChild(burst); box.appendChild(text);
    cam.appendChild(box);
    fitGotchan(text.firstChild, cw);

    setTimeout(function () { box.classList.add("boom"); }, T.BOOM);
    // 揺れは最後まで見せてから外す（途中で外すと揺れが切れて跳ねる）。文字とは別要素なので重なってよい
    setTimeout(function () { box.classList.remove("boom"); }, T.BOOM + 420);
    setTimeout(function () { box.classList.add("dodon"); }, T.DODON);
    setTimeout(function () { box.classList.add("dodon2"); }, T.DODON2);
    setTimeout(function () { box.classList.add("out"); }, T.END);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, T.GONE);
  }
  /** 「ごっちゃんです！！」の字を枠いっぱいに（はみ出す時だけ段階縮小＝的中バッジと同じ手法）。
      ⚠️2発目で1.22倍まで膨らむので、その分を見込んだ幅で判定する */
  function fitGotchan(span, camW) {
    var avail = camW * 0.94 / 1.24;
    if (avail <= 0) return;
    var fs = Math.round(camW * 0.115);
    span.style.fontSize = fs + "px";
    var guard = 0;
    while (span.scrollWidth > avail && fs > 14 && guard < 40) {
      fs -= 2; span.style.fontSize = fs + "px"; guard++;
    }
    span.parentNode.style.setProperty("--gfs", fs + "px");
  }

  /* 念仏（8/9 FB88・黄メンバー専用）：合掌して祈る→プルプル震えが増していく（同時に顔へ寄る）→
     カッと見開いて目がピカッ＋金の後光。このメンバーはアイコン走行を出さない（fireHitFx側で分岐）。
     ⚠️見開きは「閉じ目レイヤー(fx_pray_shut.png)を消す」だけ＝元絵の開き目がそのまま出る。
        絵を差し替えているわけではないので、2枚がズレる余地が構造的にない */
  /* ⚠️ng=true（8/31）＝眼鏡なしバージョン（pray_ng）。ニチャー（spawnTeaのvariant）と同じ
       「同じ関数の分岐」方式＝絵の差し替え（CSSの .fx-pray.ng）だけで、尺・動き・目の閃光は共通。
       素材＝fx_pray_ng.png / fx_pray_shut_ng.png（作り方＝素材加工/fx_pray_ng_make.py・
       目の座標は現行絵と1%未満の一致＝--eye-*系のCSS変数を共有できる） */
  function spawnPray(cam, key, ng) {
    var old = cam.querySelector(".fx-pray");
    if (old) old.parentNode.removeChild(old);
    var T = prayTimes();
    var ch = cam.clientHeight || 300;
    // 全身が枠に収まる大きさで登場し、寄りで顔が枠いっぱいになる
    var ph = Math.round(ch * 0.92), pw = Math.round(ph * PRAY_AR);
    var box = document.createElement("div");
    box.className = ["fx-pray", "m-" + key].concat(ng ? ["ng"] : []).join(" ");
    box.style.setProperty("--pw", pw + "px");
    box.style.setProperty("--ph", ph + "px");
    box.style.setProperty("--z", String(PRAY_ZOOM));
    box.style.setProperty("--zdur", (PRAY_BASE.SHAKE / 1000) + "s"); // 震えている間ずっと寄り続ける
    box.innerHTML =
      '<div class="fx-pray-run in">' +
        '<i class="fx-pray-halo"></i><i class="fx-pray-aura"></i>' +
        '<div class="fx-pray-body pray"><div class="fx-pray-pose">' +
          '<i class="fx-pray-art"></i><i class="fx-pray-lid"></i>' +
          '<i class="fx-pray-beam e-l"></i><i class="fx-pray-beam e-r"></i>' +
          '<i class="fx-pray-eye e-l"></i><i class="fx-pray-eye e-r"></i>' +
          // 白い核＝広がる輪が消えたあとも目に残る光（8/9 FB89）
          '<i class="fx-pray-eye core e-l"></i><i class="fx-pray-eye core e-r"></i>' +
        '</div></div>' +
      '</div><div class="fx-pray-flash"></div>';
    cam.appendChild(box);
    var run = box.querySelector(".fx-pray-run");
    var body = box.querySelector(".fx-pray-body");
    // 震えの段階＝bodyのクラスを差し替えるだけ（キーフレームは1本・変数だけ読み直される）。
    // 箱にも同じ段階を付ける＝気（オーラ）の濃さがCSS側で連動する
    function stage(n) {
      body.className = "fx-pray-body shake s" + n;
      box.classList.remove("s1", "s2", "s3", "s4");
      box.classList.add("s" + n);
    }
    setTimeout(function () { stage(1); run.classList.add("zoom"); }, T.SHAKE);
    setTimeout(function () { stage(2); }, T.S2);
    setTimeout(function () { stage(3); }, T.S3);
    setTimeout(function () { stage(4); }, T.S4);
    // 溜めに入ったら震えを完全停止（8/9 FB89・Naoto指示「光る瞬間は震えなし」）。
    // shakeを外し still で90msかけて中心へ収める（--a/--r を読むので s4 は残す）
    setTimeout(function () {
      body.className = "fx-pray-body s4 still";
      box.classList.add("squeeze");
    }, T.SQUEEZE);
    setTimeout(function () { box.classList.add("open"); }, T.OPEN);
    setTimeout(function () { box.classList.add("halo"); }, T.HALO);
    setTimeout(function () { box.classList.add("out"); }, T.END);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, T.GONE);
  }

  /* お茶（8/9 FB90・橙メンバーの2つ目）：画面右からてくてく歩いてきて、中央で止まり、湯呑みを掲げる。
     歩行は足違いの2コマ（w1/w2）をsteps(1)で交互に出す本物のコマ送り。
     ⚠️4コマは共通の枠で切り出してあるので、重ねても体がズレない（素材の作り方が肝＝要件定義 §10 FB89） */
  /* ⚠️variant="nicha"（8/29）＝**同じ関数の分岐**にしてある（別関数に写さない）。
       Naoto指定「中央まで歩いてくるところは一緒」＝歩きのDOM・尺・素材を共有していれば
       お茶側を直したときにニチャーが置いていかれることが構造的に起きない。
       分かれるのは中央に着いたあとだけ＝お茶は掲げる（raised/beam）／ニチャーは
       立ち姿をニチャー顔へ入れ替えて（nicha）顔へ寄る。 */
  function spawnTea(cam, key, variant) {
    var old = cam.querySelector(".fx-tea");
    if (old) old.parentNode.removeChild(old);
    var nicha = variant === "nicha";
    var T = nicha ? nichaTimes() : teaTimes();
    var cw = cam.clientWidth || 400, ch = cam.clientHeight || 300;
    var th = Math.round(ch * 0.78), tw = Math.round(th * TEA_AR);
    var box = document.createElement("div");
    box.className = ["fx-tea", "m-" + key].concat(nicha ? ["v-nicha"] : []).join(" ");
    box.style.setProperty("--tw", tw + "px");
    box.style.setProperty("--th", th + "px");
    box.style.setProperty("--walk", (TEA_BASE.WALK / 1000) + "s");
    box.style.setProperty("--step", (TEA_BASE.STEP / 1000) + "s");
    box.style.setProperty("--capin", (nicha ? NICHA_BASE.CAP_IN : TEA_BASE.CAP_IN) / 1000 + "s");
    // 出発点＝枠の外（右）。中央までの距離＝枠の半分＋体の半分
    box.style.setProperty("--x0", Math.round(cw / 2 + tw / 2) + "px");
    box.innerHTML =
      '<div class="fx-tea-run">' +
        '<div class="fx-tea-body">' +
          '<i class="fx-tea-img w1"></i><i class="fx-tea-img w2"></i>' +
          '<i class="fx-tea-img stand"></i><i class="fx-tea-img up"></i>' +
          '<i class="fx-tea-steam s1"></i><i class="fx-tea-steam s2"></i><i class="fx-tea-steam s3"></i>' +
          '<span class="fx-tea-spark p1">✨</span><span class="fx-tea-spark p2">✨</span>' +
          '<span class="fx-tea-spark p3">✨</span>' +
          '<i class="fx-tea-beam bl"></i><i class="fx-tea-beam br"></i><i class="fx-tea-glint"></i>' +
        "</div>" +
        '<i class="fx-tea-dust d1"></i><i class="fx-tea-dust d2"></i>' +
        (nicha ? '<i class="fx-nicha-img"></i>' : "") +
      "</div>" +
      '<div class="fx-tea-cap"><span></span></div>';
    box.querySelector(".fx-tea-cap span").textContent = nicha ? NICHA_CAP : TEA_CAP;
    if (nicha) setNichaVars(box, cw, ch, tw, th, T);
    cam.appendChild(box);
    fitTeaCap(box.querySelector(".fx-tea-cap span"), cw);

    box.classList.add("walking");
    setTimeout(function () { box.classList.remove("walking"); box.classList.add("standing"); }, T.STOP);
    if (nicha) {
      // standingは付けたまま＝下の立ち姿をCSSがフェードアウトさせ、上のニチャー顔が
      // 同じ時間でフェードインする（＝クロスフェード）。
      // ⚠️ここでstandingを外すと下の絵が先に消えて「一瞬いなくなる」
      setTimeout(function () { box.classList.add("nicha"); }, T.MORPH);
    } else {
      setTimeout(function () { box.classList.remove("standing"); box.classList.add("raised"); }, T.RAISE);
      setTimeout(function () { box.classList.add("beam"); }, T.BEAM);
    }
    setTimeout(function () { box.classList.add("capin"); }, T.CAP);
    setTimeout(function () { box.classList.add("out"); }, T.END);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, T.GONE);
  }

  /** ニチャーの絵の置き方とズームをCSS変数で渡す（8/29）。
      ⚠️**座標をCSSに直書きしない**＝ワイプの寸法で全部変わる（①752×423／②544×404）。
      ・置き方＝背丈はお茶の立ち姿と同じ（NICHA_HKに相当する係数は1.0＝定数を置いていない）、
        横は**衣装の重心どうし**を合わせる。2枚は同じ構図の別表情版なので、これで顔だけが変わる
      ・ズーム＝原点は顔の中心。倍率は等比で刻む（3.6^t）＝寄る速さが一定に見える。
        translateは「顔をワイプの中央へ寄せる量」＝**px**で渡す
        （transformは translate→scale の順に書く＝scaleが先に効くのでtranslateは拡大されない） */
  function setNichaVars(box, cw, ch, tw, th, T) {
    var nh = th, nw = Math.round(nh * NICHA_AR);
    var nl = Math.round(tw * TEA_SX - nw * NICHA_SX);
    box.style.setProperty("--nw", nw + "px");
    box.style.setProperty("--nh", nh + "px");
    box.style.setProperty("--nl", nl + "px");
    box.style.setProperty("--nox", (NICHA_FX * 100).toFixed(2) + "%");
    box.style.setProperty("--noy", (NICHA_FY * 100).toFixed(2) + "%");
    box.style.setProperty("--morph", (NICHA_BASE.MORPH / 1000) + "s");
    box.style.setProperty("--zoomlag", (NICHA_BASE.ZOOM_LAG / 1000) + "s");
    box.style.setProperty("--zoom", ((T.END - T.ZOOM) / 1000) + "s");
    // 顔の中心が今どこにあるか（ワイプ座標・px）
    var faceX = (cw - tw) / 2 + nl + nw * NICHA_FX;
    var faceY = ch * (1 - TEA_BOTTOM) - nh * (1 - NICHA_FY);
    box.style.setProperty("--zx", Math.round(cw / 2 - faceX) + "px");
    box.style.setProperty("--zy", Math.round(ch * NICHA_AIM_Y - faceY) + "px");
    box.style.setProperty("--zs", String(NICHA_ZOOM));
    for (var i = 1; i <= 3; i++) {                       // 等比の中間点（25/50/75%）
      box.style.setProperty("--zs" + i, Math.pow(NICHA_ZOOM, i / 4).toFixed(4));
    }
  }

  /** 「マテニチャー」を枠いっぱいに（はみ出す時だけ段階縮小＝的中バッジと同じ手法・8/9 FB91） */
  function fitTeaCap(span, camW) {
    var avail = camW * 0.94;
    if (avail <= 0) return;
    var fs = Math.round(camW * 0.115);
    span.style.fontSize = fs + "px";
    var guard = 0;
    while (span.scrollWidth > avail && fs > 14 && guard < 40) {
      fs -= 2; span.style.fontSize = fs + "px"; guard++;
    }
    span.parentNode.style.setProperty("--cfs", fs + "px");
  }

  /** キメ文字のフィット。⚠️お茶（fitTeaCap）と違い**大きさはワイプの高さ基準**にする＝
      またぎ表示では2枚のワイプに分かれて出るので、幅基準だと左右で字の大きさが変わる。
      ⚠️texts＝**同時に画面へ出る文字を全部渡す**（またぎなら「ダブル」と「的中！！」の両方）。
        いちばん長いものに合わせて縮める＝2枚のワイプで**必ず同じ大きさ**になる＝並べて1本に見える。
      幅は「はみ出したら縮める」側でだけ効かせる（的中バッジ・お茶と同じ段階縮小） */
  function fitHtCap(span, availW, camH, texts) {
    var fs = Math.round(camH * HT_CAP_H);
    var keep = span.textContent;
    var avail = availW * 0.94, guard = 0;
    span.style.fontSize = fs + "px";
    while (avail > 0 && fs > 14 && guard < 40) {
      var over = false;
      for (var i = 0; i < texts.length; i++) {
        span.textContent = texts[i];
        if (span.scrollWidth > avail) { over = true; break; }
      }
      if (!over) break;
      fs -= 2; span.style.fontSize = fs + "px"; guard++;
    }
    span.textContent = keep;
    span.parentNode.style.setProperty("--cfs", fs + "px");
  }

  /* ══════════ ハイタッチ（8/28・ダブル的中＝橙×緑の共演） ══════════
     他の演出と決定的に違う点＝**個人ではなくペアに紐づく**（PAIR_FX参照）。
     両方のワイプに同じ絵を出すので、2画面で1つの出来事が起きているように見える。

     ⚠️設計の肝＝「歩き（2体バラバラの素材）」から「キメ（2体が1枚に描かれた素材）」への差し替え。
       素材ごとに元の描かれ方（スケール・立ち位置）が違うので、fx_hitouch_make.py が出した
       実測比（HT_*）で**歩き終わりの位置と大きさをキメ絵の中の立ち位置に合わせて**おく。
       そのうえで**差し替えは白閃光の下で行う**＝残る微差は閃光が隠す（二重の保険）。
     ⚠️歩く距離はワイプの幅で決まる（①752px／②544px）ため、コマ送り間隔を固定にすると
       狭い②で足が滑る。**間隔は距離から逆算**（HT_BASE.STRIDE＝1コマあたり背丈の何倍進むか）。
       ⚠️尺そのもの（WALK等のms）は固定＝①②が必ず同時に進む（「同期して出る」の担保）。
         ここを距離依存にすると2つのワイプでパチンの瞬間がズレる */
  function spawnHitouch(cam) {
    var old = cam.querySelector(".fx-ht");
    if (old) old.parentNode.removeChild(old);
    var T = htTimes();
    var gen = fxGen;
    var rawW = cam.clientWidth, rawH = cam.clientHeight;   // ⚠️非表示シーンでは0（下の判定で使う）
    var cw = rawW || 400, ch = rawH || 300;

    /* ══ 相方のワイプを探して「またぎ」にできるか判定（8/28 Naoto要望「境目でハイタッチ」） ══
       **①トークだけワイプが横並び**（752×423が隙間ゼロで2枚）＝境目でハイタッチできる。
       **②レース観戦・③レース展開・④広告は縦積み**＝横向きの歩きでは境目に届かないので、
       従来どおり「1つのワイプの中に2人」で出す（またぎと単独の2モードを自動で切り替える）。
       ⚠️判定は実測（getBoundingClientRect）＝**CSSのレイアウトを変えても自動で追従する**。
         ここにシーン名や寸法を直書きしない（書くとレイアウト変更時に黙って崩れる）。 */
    var sibs = cam.parentNode ? cam.parentNode.querySelectorAll(".cam") : [];
    var partner = null;
    for (var si = 0; si < sibs.length; si++) if (sibs[si] !== cam) { partner = sibs[si]; break; }
    var straddle = false, partnerRight = false, pw = 0;
    /* ⚠️`.scene { display:none }` ＝**表示中でないシーンのワイプは寸法が全部0**になる。
       0どうしを比べると「上端も高さも同じ・辺も接している」が全部成立して**縦積みのシーンまで
       またぎと誤判定する**（＝各ワイプに1人しか映らない絵になる）。実寸が取れたときだけ判定する。
       ⚠️本番では **OBSのソースごとに別ページ（?scene=…で固定）** なので、見えているシーンは
         必ず実寸が取れる＝この保険が働くのは裏で回っている非表示シーンだけ。 */
    if (partner && rawW && rawH) {
      var meR = cam.getBoundingClientRect(), prR = partner.getBoundingClientRect();
      // 横並び＝上端と高さが揃っていて、どちらかの辺どうしが接している（枠線ぶんの隙間は許容）
      var sameRow = prR.width > 0 && prR.height > 0 &&
        Math.abs(meR.top - prR.top) < 4 && Math.abs(meR.height - prR.height) < 4;
      if (sameRow && Math.abs(prR.left - meR.right) < 8) { straddle = true; partnerRight = true; }
      else if (sameRow && Math.abs(meR.left - prR.right) < 8) { straddle = true; }
      if (straddle) pw = partner.clientWidth || cw;
    }

    /* ══ 誰と誰か＝**席順そのまま**（左のワイプ＝席a・右のワイプ＝席b） ══
       合成方式では**どちらの色でも左右どちらにも立てる**（向きが合わなければ絵を反転する）ので、
       「絵に合わせて人を入れ替える」必要がない＝席順に素直に従える（8/28の作り替えで解消）。
       ⚠️?fx=hitouch で無理やり出したときなど、素材の無い色が席にいたら表の先頭2色で代用する */
    var seats = seatMap();
    var ka = memberKey(seats.a), kb = memberKey(seats.b);
    if (!HT_CHARS[ka] || !HT_CHARS[kb] || ka === kb) {
      var ks = Object.keys(HT_CHARS);
      ka = ks[0]; kb = ks[1];
    }

    var baseY = Math.round(ch * HT_BOTTOM);          // 足元のライン（2人ともここに立つ）
    var handY = Math.round(baseY - ch * HT_HANDH);   // 手を合わせる高さ（2人ともここで合わせる）
    /* 「世界」＝2枚のワイプをつないだ座標（原点＝自分のワイプの左上）。
       またぎのときは**両方のワイプが同じ世界を描き**、はみ出しはワイプのoverflow:hiddenが切る＝
       2枚の絵が境目でぴたりと繋がる（各ワイプは自分の担当キャラだけが見える結果になる）。 */
    var worldL = straddle ? (partnerRight ? 0 : -pw) : 0;
    var worldR = straddle ? (partnerRight ? cw + pw : cw) : cw;
    var bx = straddle ? (partnerRight ? cw : 0) : cw / 2;   // ハイタッチが起きるx（境目／単独なら中央）

    /* 1人ぶんの寸法と位置を組む。
       ・ポーズ＝**手の高さで正規化**（手から足元までの比で割る）＝どの絵でも手が同じ高さに来る
       ・歩き  ＝**胴の高さをポーズに合わせる**＝パチンで体の大きさが変わらない
       ・横位置＝ポーズは手を境目に、歩きはポーズの衣装色重心に合わせる＝差し替えで横に動かない
       ・向き  ＝必要な向きと違う絵は左右反転（反転すると比率 x は 1-x になる） */
    function layout(key, isLeft) {
      var C = HT_CHARS[key], need = isLeft ? "r" : "l";
      var pFlip = C.pFace !== need, wFlip = C.wFace !== need;
      var ph = (baseY - handY) / (1 - C.pHY), pw2 = ph * C.pAR;
      var pHX = pFlip ? (1 - C.pHX) : C.pHX;
      var pLeft = bx - pHX * pw2;
      /* 歩きの背丈＝ポーズと同じ（8/29 Naoto「赤が歩いてくるとき大きい」で変更）。
         ⚠️どちらの素材も**頭のてっぺんから足元まで**で切ってあるので、枠の高さ＝背丈。
           以前は胴（衣装色）の高さを合わせていたが、衣装色の採れ方が絵ごとに微妙に違い
           （赤は6%ぶん歩きが大きくなっていた）、パチンで体の大きさが変わって見えた。
         ⚠️前提＝ポーズで**上げた手が頭より上に出ていない**こと（現素材はすべて眉〜目の高さ）。
           手が頭を越える絵を足したら、その絵だけ枠が伸びるのでここに補正が要る */
      var wh = ph, ww = wh * C.wAR;
      var wLeft = (pLeft + (pFlip ? (1 - C.pSX) : C.pSX) * pw2) - (wFlip ? (1 - C.wSX) : C.wSX) * ww;
      var from = isLeft ? (worldL - ww - 8) : (worldR + 8);   // 出発点＝世界の外側
      return { key: key, pFlip: pFlip, wFlip: wFlip,
        pw: Math.round(pw2), ph: Math.round(ph), pl: Math.round(pLeft), pt: Math.round(baseY - ph),
        ww: Math.round(ww), wh: Math.round(wh), wl: Math.round(wLeft), wt: Math.round(baseY - wh),
        x0: Math.round(from - wLeft), dist: Math.abs(wLeft - from) };
    }
    var A = layout(ka, true), B = layout(kb, false);

    /* コマ送り間隔＝歩く距離から逆算（滑り防止）。⚠️極端なワイプ比でも破綻しないよう上下限で挟む。
       ⚠️またぎ（歩く距離700px級）と単独（250px級）で距離が3倍違う＝同じ間隔にすると必ず片方が滑る。
         上下限を広めに取って**どちらも足が地面と合う**ようにしてある（単独側はゆっくり歩きになる） */
    function stepMs(dist, h) {
      return Math.round(Math.min(HT_BASE.STEP_MAX, Math.max(HT_BASE.STEP_MIN,
        HT_BASE.WALK * HT_BASE.STRIDE * h / Math.max(1, dist))));
    }
    // ✋手が触れる点＝閃光・衝撃波・キラッの中心。リングは最も遠い角まで届けば画面を抜け切る
    var tx = bx, ty = handY;
    function far(x, y) { return Math.sqrt(x * x + y * y); }
    var reach = Math.max(far(tx, ty), far(cw - tx, ty), far(tx, ch - ty), far(cw - tx, ch - ty));
    /* キメ文字＝またぎなら**それぞれのワイプの中央**に1語ずつ（8/29 Naoto指示）。
       ⚠️8/28は境目を挟んで寄せていたが、字を大きくすると境目付近が窮屈になるため中央へ。
         左のワイプに「ダブル」・右のワイプに「的中！！」＝2枚並べて1つのフレーズに読める */
    var capText = straddle ? (partnerRight ? HT_CAP_L : HT_CAP_R) : HT_CAP;
    var capAll  = straddle ? [HT_CAP_L, HT_CAP_R] : [HT_CAP];   // 大きさは長いほうに合わせる

    var box = document.createElement("div");
    box.className = "fx-ht" + (straddle ? " straddle" : "");
    var v = {
      "--a-ww": A.ww + "px", "--a-wh": A.wh + "px", "--a-wl": A.wl + "px", "--a-wt": A.wt + "px",
      "--a-x0": A.x0 + "px", "--a-step": (stepMs(A.dist, A.wh) / 1000) + "s",
      "--a-pw": A.pw + "px", "--a-ph": A.ph + "px", "--a-pl": A.pl + "px", "--a-pt": A.pt + "px",
      "--a-wf": A.wFlip ? "-1" : "1", "--a-pf": A.pFlip ? "-1" : "1",
      "--b-ww": B.ww + "px", "--b-wh": B.wh + "px", "--b-wl": B.wl + "px", "--b-wt": B.wt + "px",
      "--b-x0": B.x0 + "px", "--b-step": (stepMs(B.dist, B.wh) / 1000) + "s",
      "--b-pw": B.pw + "px", "--b-ph": B.ph + "px", "--b-pl": B.pl + "px", "--b-pt": B.pt + "px",
      "--b-wf": B.wFlip ? "-1" : "1", "--b-pf": B.pFlip ? "-1" : "1",
      "--walk": (HT_BASE.WALK / 1000) + "s", "--capin": (HT_BASE.CAP_IN / 1000) + "s",
      "--tx": Math.round(tx) + "px", "--ty": Math.round(ty) + "px",
      "--ring": Math.round(reach * 2.1) + "px",
      "--spark": Math.round(ch * 0.16) + "px",           // パチンのキラッの大きさ
      // キメ文字＝またぎでも単独でも**自分のワイプの中央**に置く（8/29）
      "--cap-x": Math.round(cw / 2) + "px",
      "--cap-y": Math.round(ch * HT_CAP_Y) + "px",
      "--cap-tx": "-50%", "--cap-o": "50% 50%"
    };
    Object.keys(v).forEach(function (k) { box.style.setProperty(k, v[k]); });
    /* ⚠️絵のURLは**CSS側**に持つ（`.ht-img.c-<色>`）＝相対URLがCSSの位置で解決される。
       JSで背景画像を入れると、ページの位置で解決されて検証ハーネスから404になる（既存の教訓） */
    function walkHtml(slot, key) {
      return '<div class="ht-run ' + slot + '"><div class="ht-body"><div class="ht-flip">' +
        '<i class="ht-img w1 c-' + key + '"></i><i class="ht-img w2 c-' + key + '"></i>' +
        "</div></div></div>";
    }
    box.innerHTML =
      '<div class="ht-stage"><div class="ht-world">' +
        walkHtml("a", A.key) + walkHtml("b", B.key) +
        '<div class="ht-pw a"><i class="ht-pose c-' + A.key + '"></i></div>' +
        '<div class="ht-pw b"><i class="ht-pose c-' + B.key + '"></i></div>' +
      "</div></div>" +
      '<i class="ht-ring"></i><i class="ht-spark"><b></b></i><i class="ht-flash"></i>' +
      '<div class="ht-cap"><span></span></div>';
    box.querySelector(".ht-cap span").textContent = capText;
    cam.appendChild(box);
    // 文字の大きさはワイプの高さ基準。⚠️使える幅は**自分のワイプの中だけ**（またぎでも世界の幅ではない）
    fitHtCap(box.querySelector(".ht-cap span"), cw, ch, capAll);

    box.classList.add("walking");
    setTimeout(function () {
      if (gen !== fxGen || !box.parentNode) return;
      box.classList.remove("walking");                  // 止まる＝コマ送りを切ってw1で固定
      box.classList.add("standing");
    }, T.STOP);
    setTimeout(function () {
      if (gen !== fxGen || !box.parentNode) return;
      box.classList.remove("standing");
      box.classList.add("clap");                        // パチン！＝閃光の下でキメ絵へ差し替え
    }, T.CLAP);
    setTimeout(function () { if (gen === fxGen) box.classList.add("capin"); }, T.CAP);
    setTimeout(function () { if (gen === fxGen) box.classList.add("out"); }, T.END);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, T.GONE);
  }

  /* アジャスト（8/11 FB130・青メンバーの2つ目＝Naoto案）：「アジャ・・」が右から左へ流れる
     （まばら→どんどん密に）→一通り流れたら本人が右からてくてく歩いて中央で止まる→一拍→
     しゃがんで溜める→バッ！とダブルバイセップス＝「アジャストー！！」がドン。
     役物合体との抽選（effects・8/9 FB90の仕組み）。このメンバーはアイコン走行を出さない。
     ⚠️歩き・コマ送りの作りはお茶（FB90）と同型＝2階建てtransform（run=移動／body=歩調・溜め・キメ） */
  function spawnAdjust(cam, key) {
    var old = cam.querySelector(".fx-adj");
    if (old) old.parentNode.removeChild(old);
    var T = adjTimes();
    var cw = cam.clientWidth || 400, ch = cam.clientHeight || 300;
    var ah = Math.round(ch * 0.86), aw = Math.round(ah * ADJ_AR);
    var box = document.createElement("div");
    box.className = ["fx-adj", "m-" + key].join(" ");
    box.style.setProperty("--aw", aw + "px");
    box.style.setProperty("--ah", ah + "px");
    box.style.setProperty("--walk", (ADJ_BASE.WALK / 1000) + "s");
    box.style.setProperty("--step", (ADJ_BASE.STEP / 1000) + "s");
    box.style.setProperty("--tame", (ADJ_BASE.TAME / 1000) + "s");
    box.style.setProperty("--x0", Math.round(cw / 2 + aw / 2) + "px"); // 出発点＝枠の外（右）
    box.innerHTML =
      '<div class="fx-adj-run"><div class="fx-adj-body">' +
        '<i class="fx-adj-img w1"></i><i class="fx-adj-img w2"></i>' +
        '<i class="fx-adj-img stand"></i><i class="fx-adj-img pose"></i>' +
      "</div></div>" +
      '<i class="fx-adj-flash"></i>' +
      '<div class="fx-adj-kime"><span></span></div>';
    box.querySelector(".fx-adj-kime span").textContent = ADJ_KIME;
    cam.appendChild(box);
    fitSambaKime(box.querySelector(".fx-adj-kime span"), cw, ch); // キメ文字のフィット＝サンバと同手法（枠高20%基準）
    // 「アジャ・・」の湧き時刻＝√カーブ（序盤はまばら・終盤ほど密）＋ゆらぎ。流し切りはCSSのadjFly
    for (var i = 0; i < ADJ_BASE.AJA_N; i++) {
      var at = Math.round(ADJ_BASE.RAIN * Math.sqrt((i + 0.5) / ADJ_BASE.AJA_N) + Math.random() * 240 - 120);
      setTimeout(function () {
        if (!box.parentNode) return; // 退場後は湧かせない
        var s = document.createElement("span");
        s.className = "fx-adj-aja";
        s.textContent = "アジャ・・";
        var fs = Math.round(ch * (0.07 + Math.random() * 0.09)); // 大小ランダム
        s.style.fontSize = fs + "px";
        s.style.top = Math.round(Math.random() * Math.max(1, ch - fs * 1.4)) + "px";
        s.style.left = cw + "px";
        s.style.setProperty("--fly",
          ((ADJ_BASE.FLY_MIN + Math.random() * (ADJ_BASE.FLY_MAX - ADJ_BASE.FLY_MIN)) / 1000).toFixed(2) + "s");
        s.style.setProperty("--dx", -(cw + fs * 6) + "px");  // 枠幅＋文字ぶん＝流れ切る距離
        s.style.setProperty("--tilt", (Math.random() * 10 - 5).toFixed(1) + "deg");
        box.appendChild(s);
        s.addEventListener("animationend", function () { this.remove(); });
      }, Math.max(0, at));
    }
    setTimeout(function () { box.classList.add("walking"); }, T.WALKIN);
    setTimeout(function () {  // 中央到着＝歩き停止・直立①で一拍
      box.classList.remove("walking"); box.classList.add("standing");
    }, T.STOP);
    setTimeout(function () { box.classList.add("tame"); }, T.TAME);  // しゃがんで溜める
    setTimeout(function () {  // バッ！＝ダブルバイセップス④＋フラッシュ＋「アジャストー！！」
      box.classList.remove("tame"); box.classList.add("posed");
    }, T.POSE);
    setTimeout(function () { box.classList.add("out"); }, T.END);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, T.GONE);
  }

  /* サンバ（8/10 FB121・赤メンバー専用）：周りの4人がサンバで盛り上げ、本人は腕組みでキメ。
     ラボ（検証ハーネス/sambatest.html）で詰めた試作の本番移植＝3コマ送り（①→②→③→②・1拍の半分刻み）
     ＋紙吹雪＋♪ → キメ（①腕組みコマ固定・ズーム・フラッシュ・回る後光・「〇〇的中！！」）→ 退場。
     ⚠️キメ文字は名簿の名前から組む（rc.name＋"的中！！"）＝人名をコードに書かない方針の維持・
        色の割当を変えても名前が自動で追従する（ラボの直書き「カズ的中！！」は本番では組み立て式）
     ⚠️コマ送り・紙吹雪はsetInterval駆動＋box.isConnectedで自己停止＝rAFが来ない環境（OBSの
        裏画面）でも凍らず、除去後のリークもない（FB83「rAFが1枚も来ないケース」の教訓と同系） */
  var SAMBA_CF = ["#ffd23e", "#ff5fa2", "#35d07f", "#48b7ff", "#ff9430", "#c66bff", "#fff"];
  function spawnSamba(cam, key, name) {
    var old = cam.querySelector(".fx-samba");
    if (old) old.parentNode.removeChild(old);
    var T = sambaTimes();
    var cw = cam.clientWidth || 400, ch = cam.clientHeight || 300;
    var sh = Math.round(ch * 0.96), sw = Math.round(sh * SAMBA_AR);
    var box = document.createElement("div");
    box.className = ["fx-samba", "m-" + key].join(" ");
    box.style.setProperty("--sw", sw + "px");
    box.style.setProperty("--sh", sh + "px");
    box.style.setProperty("--beat", (SAMBA_BASE.BEAT / 1000) + "s");
    box.innerHTML =
      '<div class="fx-samba-run"><div class="fx-samba-body"><div class="fx-samba-stack">' +
        '<i class="fx-samba-img f1 on"></i><i class="fx-samba-img f2"></i><i class="fx-samba-img f3"></i>' +
      "</div></div></div>" +
      '<div class="fx-samba-kime"><span></span></div>';
    var span = box.querySelector(".fx-samba-kime span");
    span.textContent = (name || "") + "的中！！";
    cam.appendChild(box);
    fitSambaKime(span, cw, ch);

    // コマ送り＝①→②→③→②を1拍の半分刻み（ラボのSEQと同じ）
    var imgs = box.querySelectorAll(".fx-samba-img");
    var SEQ = [0, 1, 2, 1], step = 0;
    var flip = setInterval(function () {
      if (!box.isConnected) { clearInterval(flip); return; }
      step = (step + 1) % SEQ.length;
      for (var i = 0; i < imgs.length; i++) imgs[i].classList.toggle("on", i === SEQ[step]);
    }, SAMBA_BASE.BEAT / 2);
    // 紙吹雪＋♪＝登場の途中から降りはじめ、キメで一斉60枚に切替
    var conf = null;
    setTimeout(function () {
      if (!box.isConnected) return;
      conf = setInterval(function () {
        if (!box.isConnected) { clearInterval(conf); return; }
        sambaConfetti(box, ch, 4, false);
        if (Math.random() < .45) sambaNote(box);
      }, 170);
    }, Math.round(SAMBA_BASE.ENTER * 0.6));

    setTimeout(function () {  // キメ＝コマ送りを止めて①（腕組み）に固定
      clearInterval(flip);
      if (conf) clearInterval(conf);
      if (!box.isConnected) return;
      for (var i = 0; i < imgs.length; i++) imgs[i].classList.toggle("on", i === 0);
      box.classList.add("kime");
      sambaConfetti(box, ch, 60, true);
    }, T.KIME);
    setTimeout(function () { box.classList.add("out"); }, T.END);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, T.GONE);
  }
  function sambaConfetti(box, ch, n, fast) {
    for (var i = 0; i < n; i++) {
      var p = document.createElement("span");
      p.className = "fx-samba-cf";
      p.style.left = (Math.random() * 100) + "%";
      p.style.setProperty("--c", SAMBA_CF[Math.floor(Math.random() * SAMBA_CF.length)]);
      p.style.setProperty("--d", (fast ? (1.1 + Math.random() * .8) : (1.8 + Math.random() * 1.4)) + "s");
      p.style.setProperty("--fall", Math.round(ch * 1.15) + "px");
      p.style.setProperty("--sx", Math.round((Math.random() - .5) * ch * .5) + "px");
      p.style.setProperty("--rot", Math.round(360 + Math.random() * 540) + "deg");
      box.appendChild(p);
      p.addEventListener("animationend", function () { this.remove(); });
    }
  }
  function sambaNote(box) {
    var s = document.createElement("span");
    s.className = "fx-samba-note";
    s.textContent = Math.random() < .5 ? "♪" : "♫";
    s.style.left = (8 + Math.random() * 84) + "%";
    box.appendChild(s);
    s.addEventListener("animationend", function () { this.remove(); });
  }
  /** キメ文字を枠に収める（名前の長さに追従・fitTeaCapと同じ手法）。
      基本＝枠高の20%（8/10 Naoto FB「文字大き目」＝.155→.20）・収まらない時だけ段階縮小 */
  function fitSambaKime(span, camW, camH) {
    var avail = camW * 0.94;
    if (avail <= 0) return;
    var fs = Math.round(camH * 0.20);
    span.style.fontSize = fs + "px";
    var guard = 0;
    while (span.scrollWidth > avail && fs > 14 && guard < 40) {
      fs -= 2; span.style.fontSize = fs + "px"; guard++;
    }
  }

  /* ピーターズ・アイ（8/25 Naoto案・緑メンバーの2つ目）：段取りはPEYE_BASEのコメント参照。
     的中目はピンクのスロットと同じ slotCombo(hit)＝comboLabel から取る（8/25 Naoto要件）。
     無い的中（手動追加）は数字を作り話にせず「見えた！！」に差し替え＝スロットと違い走行へは落とさない
     （8/25 Naoto承認済み）。
     ⚠️閃光・グリントは -char の外（-eyefx）＝シルエット化のbrightness(.13)を浴びせない
       （ラボで閃光が「全然見えない」事故になった要注意点） */
  function spawnPeye(cam, key, hit) {
    var old = cam.querySelector(".fx-peye");
    if (old) old.parentNode.removeChild(old);
    var T = peyeTimes();
    var cw = cam.clientWidth || 400, ch = cam.clientHeight || 300;
    var ph = Math.round(ch * 0.92), pw = Math.round(ph * PEYE_AR);
    // 目のcam座標＝暗転幕のグラデ中心・集中線の放射中心・寄りの原点の3役
    var left = (cw - pw) / 2, top = ch - Math.round(ch * 0.02) - ph;
    var ex = left + pw * PEYE_EYE.xc, ey = top + ph * PEYE_EYE.y;
    var combo = slotCombo(hit);
    var lite = fxLite(cam);   // 大きい箱＝塗りで効く部品を落とす（fxLiteのコメント参照）
    var box = document.createElement("div");
    box.className = ["fx-peye", "m-" + key].join(" ") + (lite ? " lite" : "");
    box.style.setProperty("--pw", pw + "px");
    box.style.setProperty("--ph", ph + "px");
    box.style.setProperty("--eyy", Math.round(ph * PEYE_EYE.y) + "px");
    box.style.setProperty("--ex", ex.toFixed(1) + "px");
    box.style.setProperty("--ey", ey.toFixed(1) + "px");
    /* 集中線の一辺（ラボの260vmaxのpx版）。⚠️実寸で持つのは PEYE_LINES_MAX まで＝それ以上は
       テクスチャを頭打ちにして、足りない分は transform: scale（--lsc）で伸ばす。
       **放射線は中心から拡大しても線の見た目が変わらない**（線が中心を通る＝拡大しても線幅の比が同じ）
       ので、実寸を捨てても絵はほぼ同じ。マスクの輪郭だけが倍率ぶん甘くなる。
       8/30＝全画面の試作でカクついた実測から入れた。1枚 max(cw,ch)×2.6 角を**a・bの2枚**持つので、
       ワイプ(752)なら1,955px角＝7.6MPだが、全画面(1920)だと4,992px角＝**49.8MP＝画面24枚ぶん**になり、
       しかも `.fx-peye.lit` で線の色（--lc/--lc2）が変わる＝その全面が塗り直される。
       ⚠️本番のワイプは①752→1,955／②544→1,414＝どちらも上限に触らない＝`--lsc`は1.0＝**今までと同一**。 */
    var lwant = Math.round(Math.max(cw, ch) * 2.6);
    var lsz = Math.min(lwant, lite ? PEYE_LINES_LITE : PEYE_LINES_MAX);
    box.style.setProperty("--lsz", lsz + "px");
    box.style.setProperty("--lsc", (lwant / lsz).toFixed(4));   // CSSのscaleに掛かる（既定1）
    // 文字サイズ＝高さ基準とし、幅が狭いワイプ（544×404）では幅基準で頭打ち＝はみ出し防止
    box.style.setProperty("--mfs", Math.round(Math.min(ch * 0.16, cw * 0.09)) + "px");   // これは、、、
    box.style.setProperty("--tfs", Math.round(Math.min(ch * 0.18, cw * 0.104)) + "px");  // 発動1行目（2行目は1.45倍）
    box.style.setProperty("--bfs", Math.round(Math.min(ch * 0.24, cw * 0.14)) + "px");   // 車番チップの一辺
    var comboHtml = combo.length
      ? combo.map(function (n) {
          return '<i class="car c' + n + ' fx-peye-car">' + n + "</i>";
        }).join("") + '<span class="fx-peye-da">だ！！</span>'
      : '<span class="fx-peye-da solo">見えた！！</span>';
    box.innerHTML =
      '<div class="fx-peye-shake">' +
        '<div class="fx-peye-dark"></div>' +
        '<i class="fx-peye-lines a"></i><i class="fx-peye-lines b"></i>' +
        '<div class="fx-peye-zoom">' +
          '<div class="fx-peye-char"><i class="fx-peye-img f1"></i><i class="fx-peye-img f2"></i></div>' +
          '<div class="fx-peye-eyefx">' +
            '<i class="fx-peye-beam"></i><i class="fx-peye-glint e-l"></i><i class="fx-peye-glint e-r"></i>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="fx-peye-mutter"><span>これは、、、</span></div>' +
      '<div class="fx-peye-title"><div class="fx-peye-title-in">' +
        '<span class="l1">ピーターズ・アイ</span><span class="l2">発動！！</span>' +
      '</div></div>' +
      '<div class="fx-peye-combo"><span class="fx-peye-combo-in">' + comboHtml + '</span></div>' +
      '<div class="fx-peye-flash"></div>';
    cam.appendChild(box);
    setTimeout(function () { box.classList.add("dk"); }, T.DK);
    setTimeout(function () { box.classList.add("burst", "shake"); }, T.GLINT);
    setTimeout(function () { box.classList.remove("shake"); }, T.GLINT + 400);
    setTimeout(function () { box.classList.add("title"); }, T.TITLE);
    setTimeout(function () { box.classList.add("mut"); }, T.MUT);      // 発動消える＋「これは、、、」
    setTimeout(function () { box.classList.remove("dk"); box.classList.add("lit"); }, T.REVEAL);
    setTimeout(function () { box.classList.add("combo", "shake"); }, T.COMBO);
    setTimeout(function () { box.classList.remove("shake"); }, T.COMBO + 400);
    setTimeout(function () { box.classList.add("out"); }, T.END);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, T.GONE);
  }

  /* ダンス（8/25 Naoto依頼・赤メンバーの2つ目）：クロールの腕回し（右腕と左腕が反対位相・
     手のひらが進行方向）＋クロスステップのループ→タメ→振り上げ→天指しでキメ。
     素材＝web/fx_dance.png（4×4シート16コマ・素材加工/fx_dance_make.py が生成）。
     コマ送り＝background-positionの差し替えをsetInterval駆動＋box.isConnectedで自己停止
     （rAFが来ないOBSの裏画面でも凍らない＝サンバFB121と同系）。 */
  function spawnDance(cam, key) {
    var old = cam.querySelector(".fx-dance");
    if (old) old.parentNode.removeChild(old);
    var T = danceTimes();
    var ch = cam.clientHeight || 300;
    var dh = Math.round(ch * 0.96), dw = Math.round(dh * DANCE_AR);
    var box = document.createElement("div");
    box.className = ["fx-dance", "m-" + key].join(" ");
    box.style.setProperty("--dw", dw + "px");
    box.style.setProperty("--dh", dh + "px");
    // 前後ステップバウンス＝足が入れ替わる周期（6コマ）で1往復。コマ送りと同じSTEPから導出＝速度を変えてもズレない
    box.style.setProperty("--dstep", (DANCE_BASE.STEP * 6 / 1000) + "s");
    box.innerHTML = '<div class="fx-dance-run"><div class="fx-dance-body"><i class="fx-dance-img"></i></div></div>';
    cam.appendChild(box);
    var img = box.querySelector(".fx-dance-img");
    function setFrame(i) {   // 4×4シート＝背景位置は 0 / 33.33 / 66.67 / 100 %
      img.style.backgroundPosition =
        ((i % 4) * 100 / 3) + "% " + (Math.floor(i / 4) * 100 / 3) + "%";
    }
    setFrame(0);
    var step = 0;
    var flip = setInterval(function () {          // ループ＝0..11を回し続ける
      if (!box.isConnected) { clearInterval(flip); return; }
      step = (step + 1) % DANCE_LOOP_N;
      setFrame(step);
    }, DANCE_BASE.STEP);
    [0, 1, 2].forEach(function (k) {              // フィニッシュ＝タメ→振り上げ→伸び上がり
      setTimeout(function () {
        if (k === 0) clearInterval(flip);
        if (!box.isConnected) return;
        if (k === 0) box.classList.add("fin");    // ループ終了＝前後バウンスも停止
        setFrame(DANCE_LOOP_N + k);
      }, T.FIN + DANCE_BASE.FSTEP * k);
    });
    setTimeout(function () {                      // キメ＝天指し＋ズーム＋フラッシュ＋後光
      if (!box.isConnected) return;
      setFrame(15);
      box.classList.add("kime");
    }, T.POSE);
    setTimeout(function () { box.classList.add("out"); }, T.END);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, T.GONE);
  }

  /** その的中で出す専用演出を決める。effects（配列）があれば抽選＝1人で複数の演出を持てる（8/9 FB90）。
      ⚠️抽選は「的中IDのハッシュ」で決める（8/26 FB付・乱数廃止）。
        OBSの①トーク・②レース観戦・③は別ページで、非表示中も裏でそれぞれ発火している。
        Math.random()だとソースごとに別の演出を引き、シーン切替で演出が変わって見える（8/26 Naoto報告）。
        同じ的中IDなら全ソースが同じ計算＝どのシーンに切り替えても同じ絵になる。 */
  /* ?fx=<演出キー> … 抽選をやめて指定の演出を必ず出す（検証用。本番のソースURLには付けない）。
       rain＝アイコン走行／yakumono／adjust／slot／sumo／pray／tea／nicha／samba／dance／peye
       ／hitouch＝ダブル的中の共演（⚠️本来は2人揃わないと出ない＝これで単独確認できる）
     window.__FX_FORCE … 同じことをリロードなしでやるためのフック（fxlabの「演出」選択が使う）。
       本番では未定義＝この行は素通り。⚠️絵柄は演出ごとに固定なので、その演出を持たない色を
       選んだ状態で強制すると「絵は別人・枠の色は選んだ人」という組み合わせになる（ラボ用途では想定内） */
  var FX_FORCE = params.get("fx") || "";
  /* ⚠️テスト接続（?gas=）の既定は**本番と同じ抽選**（8/29 Naoto指示）。
     旧＝thanks固定（8/25「テストなんだから必ず出るように」）。**8/29に結果発表を封印（0%）した時点で、
     テストだけ「本番では二度と出ない演出」を見せる状態になった**＝直したものを確認したり
     人に触ってもらったりする場面で、本番と違う絵を見てOKと判断してしまう。
     どのみち演出は必ず何か出る（rainも演出）ので「必ず出る」目的は抽選のままでも満たされる。
     テストで狙った演出を見たい時＝`?fx=<キー>`（従来どおり最優先）か、検証ハーネス/fxlab.html */
  function fxHash(s) { // 的中ID→抽選値。全ソースで同じ値になることだけが役目（暗号用途ではない）
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    // ⚠️仕上げ混ぜ（murmur3のfmix32）＝必須。これが無いと上位ビットの混ざりが弱く、
    //   [0,1)正規化の帯判定で似たID（同じ場名・同じ長さ）が同じ帯に固まり、
    //   「結果発表20%」が場によってほぼ0%/偏出になる（8/26実測＝高知84IDでthanks0回）
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }
  /* ⚠️今だけの固定枠（8/26 Naoto指示「また指示したら元に戻す」）＝
       色キーを書くと、その人の的中は必ずこの演出（個人演出の抽選もMEMBER_RATESも効かない）。
       ?fx=強制（検証用）とダブル的中の共演だけはこれより優先。恒久機能ではなく一時運用のスイッチ。
     ✅8/29 Naoto指示で**空に戻した**（8/26からの「赤＝ダンス100%」を解除）＝赤も表どおり samba/dance 50/50。
       また使うとき＝ { red: "dance" } のように書いて再publish（戻し忘れは fxdisttest が毎回先頭で知らせる） */
  var FX_PIN = {}; // 固定なし＝通常運用（全色 MEMBER_RATES の抽選どおり）

  /* ══════════ 確率テーブルから1つ引く仕組み（8/27） ══════════
     ⚠️ここは**仕組み**＝確率を変えるときに触る場所ではない（触るのはMEMBER_RATESの数字だけ）。
     ・引き方＝ハッシュの**下の桁**（% RATE_SCALE）で整数の当たり枠に落とす。
       ⚠️8/26の事故は上の桁（[0,1)正規化して帯で切る方式）を使ったのが原因＝上の桁は
         似たID（同じ場名）でほとんど動かず場ごとに偏る。下の桁はR番号・買い目で激しく動く＝
         一昨日から実績のある側。fxHashの仕上げ混ぜ（fmix32）と合わせて二重の保険。
     ・10000枠のうち「40%なら4000枠」と**数えて割り当てる**＝配分は統計でなく算数で合う。
     ・同じ的中IDなら常に同じ結果＝OBS全ソース・全シーンで同じ演出（8/26の決定性はここが担保）。
       ⚠️キーの並び順が引く結果を決める＝表の行を並べ替えると出る演出が変わる（確率は不変） */
  var RATE_SCALE = 10000; // 確率の分解能＝0.01%
  function weightedPick(id, rates) {
    var keys = Object.keys(rates), total = 0, i, w;
    for (i = 0; i < keys.length; i++) { w = rates[keys[i]]; if (w > 0) total += w; }
    if (!total) return "";
    var r = fxHash(String(id)) % RATE_SCALE, acc = 0;
    for (i = 0; i < keys.length; i++) {
      w = rates[keys[i]];
      acc += (w > 0 ? w : 0) / total * RATE_SCALE;
      if (r < acc) return keys[i] === "rain" ? "" : keys[i];
    }
    var last = keys[keys.length - 1];         // 端数の保険＝合計が100でない表でも必ず1つ返す
    return last === "rain" ? "" : last;
  }
  /* 表の自己検査（8/27）＝合計100か・演出名のタイプミスがないか。
     ⚠️OBSではコンソールが見えない＝これは補助。本当の関門は公開前の fxdisttest.js */
  /* ⚠️ここに hitouch（ダブル的中の共演）は**入れない**。あれは2人揃って初めて成立する演出で、
     MEMBER_RATESに書いても「1人の的中で出る」ようにはならない（正しい置き場はPAIR_FX）。
     入れないでおくと、間違ってこの表に書いたときに未知の演出名として警告が出る＝安全弁 */
  var FX_KNOWN = { rain: 1, yakumono: 1, slot: 1, sumo: 1, pray: 1, pray_ng: 1, tea: 1, nicha: 1,
    samba: 1, dance: 1, adjust: 1, peye: 1, thanks: 1 };
  function auditRates() {
    Object.keys(MEMBER_RATES).forEach(function (k) {
      var rates = MEMBER_RATES[k], sum = 0;
      Object.keys(rates).forEach(function (e) {
        sum += rates[e];
        if (!FX_KNOWN[e]) console.warn("[FX] 未知の演出名 " + k + "." + e + "（タイプミス？）");
      });
      if (Math.abs(sum - 100) > 0.01) console.warn("[FX] " + k + " の合計が " + sum + "%（100にすること）");
    });
  }
  auditRates();

  function pickEffect(key, hit, pairFx) {
    var force = window.__FX_FORCE || FX_FORCE;
    if (force && force !== "auto") return force === "rain" ? "" : force;
    /* ダブル的中の共演演出（8/28）＝**一時固定（FX_PIN）より優先**。
       理由＝ダブルは滅多に出ない特別枠なのに、戻し忘れた固定が生きていると黙って消える。
       「今だけ○○固定」の期間にたまたまダブルが出たら、そっちを見せたい（Naoto確認済み） */
    if (pairFx) return pairFx;
    if (FX_PIN[key]) return FX_PIN[key]; // 今だけの固定枠（上のFX_PIN参照・戻し忘れ注意）
    var rates = MEMBER_RATES[key];
    if (!rates) return "";               // 表に無い色＝名簿外＝既定のアイコン走行（従来動作）
    // IDが取れない経路（保険）だけ乱数。通常の的中は必ずid付き（derive.jsのhits）
    return weightedPick((hit && hit.id) ? hit.id : ("x" + Math.random()), rates);
  }

  /* ══════════ 選手リスペクト演出 "thanks"（8/23 Naoto案） ══════════
     「結果発表！！／3着 ○○選手！／2着 ○○選手！／1着 ○○選手！／おめざいます！！」をワイプの中に1枚ずつ出す。
     ⚠️8/25＝表彰台＋チビキャラ版を実装したが同日取りやめ（台に目が行って名前に注目が行かない懸念）。
       着順チップ＋車番チップ方式へ戻し、代わりに先頭の「結果発表！！」と🚴を追加した。
     ねらい＝的中演出が配信者だけを映すものになっているので、走った選手を出す面を1枚足す。
     （YouTube収益化の「独自の付加価値」・C社への説明材料としても使える）

     ⚠️8/23にNaoto指示で「映像中央の独立パネル」から**他と同じ枠の演出**へ作り直した。
       ・出る場所＝cam（ワイプ）の中。尺の流儀も他と同じ＝ENDで的中バッジにバトンを渡す
       ・違いは絵柄が特定の人に紐づかないこと＝誰の的中でも出せる「全員共通」の演出
       ・寸法は①(752×423)と②(544×404)で変わるので、文字は --thx-h（＝ワイプの高さ）基準で組む
     ✅8/25 本番の抽選に投入済み。✅8/26 配分＝全員20%（40/40/20・80/20）
       →✅8/27 確率はMEMBER_RATESに各色20%と明記（表方式・変えるならその数字だけ）
     ⚠️最後の札は8/25に「的中！！」→「おめざいます！！」へ変更（Naoto指定）。
       **誤字ではない**＝「おめでとうございます」に直さないこと。
       （副次効果＝hit-mainバッジ／ティッカー／サンバのキメ文字「的中」との文言重複も解消）
     ⚠️落車・失格のガードは入れていない（8/23判断）。1〜3着しか出さないので落車選手の名前は
       そもそも出ず、失格・降着はJSJ018の確定値に反映済みのため

     ⚠️8/23 Naoto指示で「1枚ずつ・バン！バン！バン！」に作り直した（一覧で並べるのをやめた）。
       **単独の札**が入れ替わる＝1枚しか出さないぶん字を大きく取れる＝544pxのワイプでも読める。
       切り替えのたびに叩きつけの閃光＋画面の揺れが入る。

     ══ 発表順＝**1着→2着→3着**（8/25夜 Naoto指示→8/26テスト確認で確定） ══
       ・競輪の実況・場内発表と同じ順を優先（視聴者の耳に馴染んだ順）。
         各着の扱い（色・回転・煽り）は**着順に紐づけたまま**＝1着は先頭でも金・ロングリーチ
       ・⚠️経緯＝8/23には逆の「3着→2着→1着」（表彰式型・弱→強のステップアップ）を
         いったん採用していた＝「盛り上がりなら321」という対立軸ごとNaoto判断で123に確定。
         変えるとき＝THX_STEPSの3行を丸ごと並べ替える（tier等の値は行に付けたまま動かす）
       ・色は **青→緑→金**＝期待度の階段。説明なしで伝わる唯一の共通言語
       ・溜めは **1着だけ長い**＝ロングリーチ。均等なテンポは緊張を生まない
       ・回転は 2→3→4回転。1着だけ「止まりかけてもう1回転」の煽り付き（擬似連・スベリ）
       ・最後の「的中！！」は **回転なし**（8/23 Naoto指示）＝大きく迫って一撃で止まる
     ⚠️煽りは必ず昇格で終わらせる（落とさない）。この演出は的中確定後にしか出ないので、
       パチンコ流の「煽って外す」を持ち込むと視聴者に「ハズレるかも」と誤読される
     ⚠️派手さは最後の「的中！！」に寄せ、選手の札は"格上げ"止まりにする。
       選手を役物のように振り回すとリスペクトの趣旨と衝突する

     THX_STEPS＝選手3枚の設計（配列の順＝出る順）
       idx  …r.order の添字（0＝1着）。⚠️ここを並べ替えるだけで順番が変わる
       tier …色の段（1:青 2:緑 3:金）→ CSSの .t1/.t2/.t3
       spin …回転量deg。⚠️360の倍数にすること（半端だと傾いたまま止まる）
       hold …その札を見せているms（次の札に変わるまで）。⚠️lag+bangより十分長く保つ
       bang …名前の登場アニメのms（--thx-bang でCSSへ渡す）
       lag  …着順チップが出てから名前が飛び込むまでのms（--thx-lag）。
              「3着は…（誰だ）…○○選手！」の読み順を作る溜め。⚠️0にすると同時に出て煽りにならない
       don  …叩きつけの瞬間が bang のどこか（0〜1）。揺れを鳴らすタイミング（実際は lag+bang*don）。
              ⚠️overlay.css の thxBang=68% / thxBangTease=82% / thxKimeIn=22% と対応。
                片方だけ動かすとズレる
       shk  …揺れの強さ倍率（--shk）／tease…止まりかけてもう1回転する */
  var THX_STEPS = [
    { idx: 0, tier: 3, spin: 1440, hold: 3200, bang: 1350, lag: 500, don: 0.82, shk: 1.7, tease: true },
    { idx: 1, tier: 2, spin: 1080, hold: 2100, bang: 950,  lag: 450, don: 0.68, shk: 1.1 },
    { idx: 2, tier: 1, spin: 720,  hold: 2800, bang: 950,  lag: 450, don: 0.68, shk: 0.8 }
  ];
  /* ⚠️最後の札（現在は3着）のholdが「おめざいます！！」までの間＝8/26 Naoto指示で1900→2800
     （123順にした際、最後の札が1着hold3200→3着hold1900になりキメまでが駆け足になっていた） */
  /* 最後の「的中！！」。spinなし＝回転しない・前置きも無いのでlagなし。
     色は既存バッジの区分（通常/note/万車）に接続 */
  var THX_KIME_STEP = { hold: 3000, bang: 750, lag: 0, don: 0.22, shk: 2.0 };
  /* 先頭の「結果発表！！」（8/25 Naoto指示）＝的中！！と同じ登場（thxKimeIn＝回転なしの一撃）。
     何が始まるのかを1枚で宣言してから1着に入る */
  var THX_INTRO = "結果発表！！";
  var THX_INTRO_STEP = { hold: 1400, bang: 750, lag: 0, don: 0.22, shk: 1.2 };
  var THX_FADE = 520;   // 退場ms
  /* ⚠️ENDがバッジまでの時間（fireHitFxがrainMsとして使う）＝1400+3200+2100+2800+3000＝約12.5秒
     （最長だったアジャスト10.3秒を超える。長いと感じたら INTRO と KIME の hold から削る） */
  var THX_KIME = "おめざいます！！";   // 8/25 Naoto指定。⚠️誤字ではない＝この表記のまま（直さない）
  var THX_SFX  = "選手！";     // 名前の後ろに付ける敬称＋感嘆
  /* 表示は1パターンに確定（8/25 Naoto実機確認）＝着順＋🚴＋車番＋フルネーム（均等）。
     旧・切替（?thxv＝名前だけ/決まり手・?thxn＝姓大名小/姓だけ）は撤去した＝
     URLパラメータの既定値で意図しないパターンが出る事故（テストで姓大が出た件）の根治 */
  /* thanks（結果発表）は全色共通の演出＝絵柄が人に紐づかないので誰の的中でも出せる（8/23）。
     ✅8/25 Naoto承認で本番投入（8/26＝各色20%指定→8/27に表方式へ）。
     ⛔8/29 Naoto指示で**全色0%＝封印中**（視聴者の反応が微妙だった）。
        止め方＝MEMBER_RATESのthanksを0にし、その分を個人演出へ等分で振った（合計100は維持）。
        **コードは生かしたまま**＝`?fx=thanks`・テスト接続（?gas=）では今までどおり出せる（見た目の作り込みは無駄にならない）。
        戻すとき＝MEMBER_RATESの数字だけを戻す（20に戻し、個人演出から同じだけ引く） */
  /** その札の前置き（着順チップ）→名前までの溜め。
      ⚠️CSSに渡す --thx-lag と揺れのタイミング計算の両方でこれを使う（片方だけだとズレる） */
  function thxLagOf(st) { return st.lag || 0; }

  function thxTimes() {
    var kime = THX_INTRO_STEP.hold;   // 結果発表！！＋選手3枚を見せ切ったところ＝「的中！！」が出る時刻
    for (var i = 0; i < THX_STEPS.length; i++) kime += THX_STEPS[i].hold;
    return { KIME: kime, END: kime + THX_KIME_STEP.hold,
      GONE: kime + THX_KIME_STEP.hold + THX_FADE };
  }

  /** 的中したレースの1〜3着を返す（揃わなければnull）。
      ⚠️結果のnamesはあれば使うが**期待しない**（8/25 Naoto指摘＝実運用は自動取得を待たず
        着順＋払戻だけの手入力で確定する→namesは空のまま・後からのスクレイプでも上書きされない）。
        名前は出走表（fullNameOf）から着順の車番で引くのが主経路。それも引けなければ「〇番車」＝
        選手名を作り話にしない。誤表示はリスペクトの真逆になるため */
  function thxResult(hit) {
    var p = String(hit && hit.id).split("|");      // id＝場|R|配信者|式別|組合せ
    if (p.length < 5) return null;
    var r = state.results[p[0] + "|" + p[1]];
    if (!r || !r.order || r.order.length < 3) return null;  // 2車単だけの結果などでは出さない
    return r;
  }

  /** 着順札のラベル（8/27 FB148）。同着＝結果に orders（並び2通り）があるとき、
      同着になった着位は同じ数字を2枚出す（2着同着なら「1着・2着・2着」＝そのレースに3着は存在しない）。
      判定＝2本の並びのどこが入れ替わっているか。
      ⚠️3着同着（1着5・2着2・3着が3と4）は札が3枚しかなく同着の相手を出す枠が無い＝ラベルは通常のまま
        （出るのは orders[0] 側の1人）。ここを変えるなら札を4枚にする設計変更が要る */
  function thxPosLabels(r) {
    var base = ["1着", "2着", "3着"];
    var os = r && r.orders;
    if (!os || os.length < 2 || !os[0] || !os[1]) return base;
    var a = os[0], b = os[1];
    if (a.length < 3 || b.length < 3) return base;
    if (a[0] !== b[0] && a[1] !== b[1] && a[2] === b[2]) return ["1着", "1着", "3着"]; // 1着同着
    if (a[0] === b[0] && a[1] !== b[1] && a[2] !== b[2]) return ["1着", "2着", "2着"]; // 2着同着
    return base;
  }

  function spawnThanks(cam, key, hit) {
    var old = cam.querySelector(".fx-thx");
    if (old) old.parentNode.removeChild(old);
    var r = thxResult(hit);
    if (!r) return;
    var T = thxTimes();
    var idp = String(hit.id).split("|");   // id＝場|R|配信者|式別|組合せ → 出走表を引く鍵

    /* 札は5枚（結果発表！！・3着・2着・1着・おめざいます！！）。全部DOMに置いて .on を付け替えて1枚ずつ見せる。
       ⚠️display:none で隠さない：幅が測れなくなって fitThxNames が効かない
       尺と回転は札ごとに違うので、インライン style で各札に持たせる
       （あとから付けると .on を足した瞬間のアニメに間に合わないことがある） */
    var posLabel = thxPosLabels(r); // 同着なら「1着・2着・2着」等（8/27 FB148）
    // 先頭＝結果発表！！（8/25）。class kime＝的中！！と同じ登場（回転なしの一撃）を使い回す。
    // k-* は付けない＝色は基本の金のまま（虹・黄金は本物の的中！！だけの格）
    var cards = ['<div class="thx-card kime" style="--thx-bang:' + THX_INTRO_STEP.bang + 'ms">' +
      '<div class="thx-kime">' + esc(THX_INTRO) + '</div></div>'];
    THX_STEPS.forEach(function (st) {
      var car = r.order[st.idx];
      // 名前の優先順（8/25）：結果に入っていれば最優先（自動取得済み・手で直した場合）
      // →出走表から車番で引く（★実運用の主経路＝手入力確定はnamesが空のため）→「○番車」
      var nm = (r.names && r.names[st.idx]) || fullNameOf(idp[0], idp[1], car) || (car + "番車");
      // 並び＝着順→🚴→車番（8/25）。名前＝フルネーム均等（8/25確定・切替なし）
      cards.push('<div class="thx-card t' + st.tier + (st.tease ? " tease" : "") +
        '" style="--thx-bang:' + st.bang + 'ms;--thx-spin:' + st.spin + 'deg;--thx-lag:' +
        thxLagOf(st) + 'ms">' +
        '<div class="thx-head"><span class="thx-pos">' + posLabel[st.idx] + '</span>' +
        '<span class="thx-bike">🚴</span>' +
        '<i class="thx-car c' + car + '">' + car + '</i></div>' +
        '<div class="thx-name">' + esc(nm) + '<span class="sfx">' + THX_SFX + '</span></div></div>');
    });
    // 的中！！＝回転なし。色は既存バッジと同じ区分（万車＝虹／note＝黄金／通常＝金）
    cards.push('<div class="thx-card kime ' +
      (hit.manche ? "k-manche" : (hit.note ? "k-note" : "k-normal")) +
      '" style="--thx-bang:' + THX_KIME_STEP.bang + 'ms">' +
      '<div class="thx-kime">' + esc(THX_KIME) + '</div></div>');

    var box = document.createElement("div");
    box.className = "fx-thx" + (key ? " m-" + key : "");
    // 文字はワイプの高さ基準で組む＝①(752×423)でも②(544×404)でも同じ見え方になる
    box.style.setProperty("--thx-h", (cam.clientHeight || 400) + "px");
    box.innerHTML = '<div class="thx-stage">' + cards.join("") + '</div>';
    cam.appendChild(box);
    fitThxNames(box, cam);

    var stage = box.querySelector(".thx-stage");
    var els = box.querySelectorAll(".thx-card");
    var plan = [THX_INTRO_STEP].concat(THX_STEPS, [THX_KIME_STEP]);
    var gen = fxGen;
    var at = 0;
    plan.forEach(function (st, n) {
      var showAt = at;
      at += st.hold;
      setTimeout(function () {
        if (gen !== fxGen || !box.parentNode) return;
        stage.style.setProperty("--shk", st.shk);
        for (var j = 0; j < els.length; j++) els[j].classList.toggle("on", j === n);
        // 揺れは「クルクル」の途中ではなく着弾（ドン！）の瞬間に鳴らす＝閃光と同時。
        // ⚠️着順チップの前置き（lag）ぶん後ろにずれる＝CSSに渡している値と必ず揃える（thxLagOf）
        setTimeout(function () {
          if (gen !== fxGen || !box.parentNode) return;
          // 毎回鳴らし直す＝クラスを外して強制リフローしてから付け直す
          stage.classList.remove("shake");
          void stage.offsetWidth;
          stage.classList.add("shake");
        }, thxLagOf(st) + Math.round(st.bang * st.don));
      }, showAt);
    });
    setTimeout(function () { if (gen === fxGen) box.classList.add("out"); }, T.END);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, T.GONE);
  }

  /** はみ出す時だけ縮める（的中バッジの fitHitBadge と同じ流儀）。
      8/25に名前を「結果発表！！」と同格（.24h）へ拡大したので、②の544px幅では長い名前が
      普通にあふれる＝この縮小が常用の前提になった。
      ・名前3枚＝札ごとに字の大きさが変わるとチカチカするので、1枚でもあふれたら3枚まとめて縮める
      ・kime札（結果発表！！／おめざいます！！）＝文言が違い同時に見えないので1枚ずつ縮める
        （「おめざいます！！」8字は②では確実にあふれる＝ここが吸収する） */
  function fitThxNames(box, cam) {
    if (!cam.clientWidth) return;
    var names = box.querySelectorAll(".thx-name");
    for (var step = 0; names.length && step < 6; step++) {
      var over = false;
      for (var i = 0; i < names.length; i++) {
        if (names[i].scrollWidth > names[i].clientWidth + 1) { over = true; break; }
      }
      if (!over) break;
      var next = Math.round((parseFloat(getComputedStyle(names[0]).fontSize) || 30) * 0.9);
      for (var j = 0; j < names.length; j++) names[j].style.fontSize = next + "px";
    }
    var kimes = box.querySelectorAll(".thx-kime");
    for (var k = 0; k < kimes.length; k++) {
      for (var s = 0; s < 6 && kimes[k].scrollWidth > kimes[k].clientWidth + 1; s++) {
        var f = Math.round((parseFloat(getComputedStyle(kimes[k]).fontSize) || 40) * 0.9);
        kimes[k].style.fontSize = f + "px";
      }
    }
  }

  /* ══════════ 演出の掃除（8/23 Naoto依頼「次の演出を押したら前のは消える」）══════════
     ⚠️本番の fireHitFx からは呼ばない。理由2つ：
       ①fireHitFx は slot a/b それぞれで呼ばれる＝中で呼ぶと片方がもう片方を消す
       ②本番では別々の配信者が別レースを同時に的中させることがあり、
         後の的中が前の演出を消す挙動は望ましくない
     fxGen＝世代番号。掃除のたびに繰り上げ、掃除前に予約された setTimeout は
     自分の世代と違えば何もしない（止められないタイマーの空振り対策） */
  var fxGen = 0;
  var FX_ROOTS = ".hit-rain, .fx-yak, .fx-slot, .fx-schar, .fx-sumo, .fx-pray, .fx-tea," +
    " .fx-adj, .fx-samba, .fx-peye, .fx-thx, .fx-ht, .hit-fx-badge, .fx-proto-host";
  function clearHitFx() {
    fxGen++;
    var nodes = document.querySelectorAll(FX_ROOTS);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
    var cams = document.querySelectorAll(".cam");
    // 掃除対象＝2つの表の色キーの合併（片方にしか無い色でも m-<色> を残さない・8/27）
    var keys = Object.keys(MEMBER_FX).concat(Object.keys(MEMBER_RATES));
    for (var j = 0; j < cams.length; j++) {
      cams[j].classList.remove("hit-fx", "hit-fx-note", "hit-fx-manche");
      for (var k = 0; k < keys.length; k++) cams[j].classList.remove("m-" + keys[k]);
    }
    // 予想帯の買目強調も一緒に落とす。強調が無いときは描き直さない
    // （＝stateが来る前に叩かれても renderPreds に入らないようにする保険）
    if (hitGlows.length) { hitGlows = []; renderPreds(); }
  }
  window.__clearHitFx = clearHitFx;   // 検証ハーネス（fxlab）から叩く

  /* ══════════ 演出の出し先（8/30・試作→万車の本番機能に昇格）══════════
     バッジ・枠パルス＝**常にワイプ**（fxWipes）。前奏（走行・専用演出）だけが出し先を選べる：
       本番＝**万車的中のとき全画面ホスト**（fxStageHost・8/30 Naoto決定「前奏だけ全画面」＝
             放送画面を長く覆わない。35秒残るバッジ・虹パルスは従来どおりワイプ側）
       ラボ＝window.__FX_HOST で任意に上書き（fxlabだけが立てる・""＝ワイプを明示）
     ⚠️undefined と "" を区別する＝undefined「ラボ外（＝本番）」／""「ラボがワイプを指定」。
       truthy判定に書き換えると、ラボで万車×ワイプの見比べができなくなる。 */
  function fxWipes(slot) {
    var out = [];
    // ③レース展開でも発火させる（8/12・③結果・的中シーンを消したため。要件§11.2）
    ["np-talk-", "np-race-", "np-result-", "np-ad-", "np-tk-"].forEach(function (p) {
      var el = $(p + slot);
      if (!el) return;
      var cam = el.closest(".cam");
      if (cam) out.push(cam);
    });
    return out;
  }

  /* 万車＝全画面の対象シーン。**⑤広告・④待機は除外＝FB149と同じ判断**
     （案件表示義務のある画面を覆わない・無人画面の挙動を変えない）→従来どおりワイプへ。
     **②レース観戦も除外（8/30夜・本番初出動の実測でNaotoが発見）**＝福岡の実OBSでは
     「レース映像」ソースがオーバーレイより**上**に積まれている（設計JSONは「映像が下・穴から
     見せる」だが、映像ウィンドウの位置合わせは映像が見えないとできない＝上に置くのが運用上の
     必然で、実機はそうなっていた）。ブラウザソースの中のz-indexでは**他のOBSソースの上には
     絶対に出られない**＝役物がレース映像の裏に隠れた（21:41実見・全画面演出すべてに共通の構造）。
     ②はワイプ演出に落とす。FB149の自動切替（的中の瞬間に②→①トーク）が効けば全画面は①で出る
     ＝**②ソースの「ページの権限」設定（福岡の残タスク）がその前提**。
     ⚠️raceをここへ戻すのは、福岡の②でオーバーレイが最上段になったのを実機で確認してから。
     &fsfx=0 ＝OBS側だけで止める緊急の逃げ道（&hitscene=0 と同型・コンソール設定は作らない） */
  var FSFX_OFF = params.get("fsfx") === "0";
  var FSFX_SCENES = { talk: 1, result: 1, tenkai: 1 };
  function fxStageHost(hit) {
    var mode = window.__FX_HOST !== undefined
      ? window.__FX_HOST
      : (hit && hit.manche && !FSFX_OFF && FSFX_SCENES[SCENE] ? "full" : "");
    return mode ? protoHost(mode) : null;
  }

  /* ステージ直下に「大きなワイプ」を1枚作り、そこへ**本番と同じ spawn 系**を撃たせる。
     演出はどれも cam.clientWidth/clientHeight から寸法を逆算しているので、箱を大きくすれば
     絵も文字も**引き伸ばしではなくネイティブに大きく**なる（transform拡大ではない＝ボケない）。
       full … 1920×1080（全画面）＝**本番の万車はこれ**
     ⚠️8/30に「帯（1920×756・ヘッダーと下段を残す案）」も並べて見比べたが、Naoto確認の結果
       **全画面で問題なし→帯は不要**と判断して削除した。**復活させない**（hosttestが行数を固定）。
     ⚠️箱を**全幅**にしてあるのは、横に歩いて入る演出（走行・お茶・相撲・サンバ）が
       `.cam`のoverflow:hiddenで切られるため。中央寄せの狭い箱だと、キャラが画面の途中から
       湧いて出たように見えて、案そのものより先に違和感が立つ。
     箱には class="cam" を付ける＝バッジのフィット等が本番と同じ経路で走る。 */
  var PROTO_SIZES = { full: [1920, 1080] };
  function protoHost(mode) {
    var sz = PROTO_SIZES[mode];
    var stage = $("stage");
    if (!sz || !stage) return null;
    var el = document.getElementById("fx-proto-host");
    if (!el) {
      el = document.createElement("div");
      el.id = "fx-proto-host";
      el.className = "cam fx-proto-host";   // camクラス＝枠パルス等を本番と同じCSSで受ける
      stage.appendChild(el);
    }
    el.style.width = sz[0] + "px";
    el.style.height = sz[1] + "px";
    el.style.left = Math.round((1920 - sz[0]) / 2) + "px";
    el.style.top = Math.round((1080 - sz[1]) / 2) + "px";
    return el;
  }

  function fireHitFx(slot, hit, rc, pairFx) {
    hitSceneSwitch(hit);   // 的中演出はトークの大きいワイプで見せる（8/29 FB149）
    var key = memberKey(rc);
    // ⚠️pairFxは色キーが無い人には立たない（pairFxForが両者の色キーを要求する）＝keyなしでも安全
    var eff = pickEffect(key, hit, pairFx);
    var gen = fxGen;
    // スロットは当たり目の数字そのものを見せる演出。車番が取れない的中（手動追加）では
    // 数字を作り話にせず、既定のアイコン走行に落とす
    var combo = eff === "slot" ? slotCombo(hit) : [];
    if (eff === "slot" && !combo.length) eff = "";
    // 選手リスペクトは結果の1〜3着が要る。揃わない的中では既定のアイコン走行に落とす
    if (eff === "thanks" && !thxResult(hit)) eff = "";
    // バッジまでの待ち時間＝その人の前奏の長さ。専用演出は退場開始と同時に出す（消えきるのを待たない）
    var rainMs = eff === "yakumono" ? yakTimes().END
      : eff === "slot" ? slotTimes(combo.length).END
      : eff === "sumo" ? sumoTimes().END
      : eff === "pray" ? prayTimes().END
      : eff === "tea" ? teaTimes().END
      : eff === "nicha" ? nichaTimes().END
      : eff === "samba" ? sambaTimes().END
      : eff === "dance" ? danceTimes().END
      : eff === "adjust" ? adjTimes().END
      : eff === "peye" ? peyeTimes().END
      : eff === "thanks" ? thxTimes().END
      : eff === "hitouch" ? htTimes().END
      : (key ? fxConf(key).rainMs : 0);
    // 遠隔自動更新（autoupdate.js・要件§12）への「演出中」通知＝force時はこの時刻まで待つ。
    // rainMs＝バッジが出るまで／HIT_FX_MS＝バッジ・買目強調の持続
    window.__fxUntil = Math.max(window.__fxUntil || 0, Date.now() + rainMs + HIT_FX_MS);
    var wipes = fxWipes(slot);
    var stage = fxStageHost(hit);
    /* バッジ・枠パルス＝**常にワイプ**（8/30 Naoto決定「前奏だけ全画面」＝35秒残るのはこちら側
       だけ。全画面ホストには前奏が終わったあと何も残らない） */
    wipes.forEach(function (cam) {
      cam.classList.add("hit-fx");
      if (key) cam.classList.add("m-" + key);             // 個人演出のフック（8/8 FB73）
      if (hit.note) cam.classList.add("hit-fx-note");     // note＝黄金の強パルス（8/7 FB59）
      if (hit.manche) cam.classList.add("hit-fx-manche"); // 万車＝レインボーパルス（8/7 FB59・旧赤）
      // 掃除（clearHitFx）が挟まったらバッジは出さない＝消したのに後から出る事故を防ぐ
      setTimeout(function () { if (gen === fxGen) showHitBadge(cam, hit, key); }, rainMs);
    });
    /* 前奏＝アイコンの走行（8/7 FB65）／専用演出のメンバーは走行を出さない
       （役物FB82・スロットFB83・相撲FB86・念仏FB88）。
       万車＝全画面ホスト**1枚だけ**に出す（5シーンぶん撒かない・fxStageHostのコメント参照） */
    (stage ? [stage] : wipes).forEach(function (cam) {
      if (eff === "yakumono") spawnYakumono(cam, key);
      else if (eff === "slot") spawnSlot(cam, key, hit, combo);
      else if (eff === "sumo") spawnSumo(cam, key, hit);
      else if (eff === "pray" || eff === "pray_ng") spawnPray(cam, key, eff === "pray_ng");
      else if (eff === "tea") spawnTea(cam, key);
      else if (eff === "nicha") spawnTea(cam, key, "nicha");  // ニチャー（8/29・お茶の派生＝歩きは共通）
      else if (eff === "samba") spawnSamba(cam, key, rc && rc.name);
      else if (eff === "dance") spawnDance(cam, key);   // ダンス（8/25・赤の2つ目）
      else if (eff === "adjust") spawnAdjust(cam, key);
      else if (eff === "peye") spawnPeye(cam, key, hit);       // ピーターズ・アイ（8/25・的中目はスロットと同源）
      else if (eff === "thanks") spawnThanks(cam, key, hit);   // 全員共通（8/23）
      else if (eff === "hitouch") spawnHitouch(cam);           // ダブル的中の共演＝ペア表（8/28）
      else if (key) spawnRain(cam, key);
    });
  }
  function showHitBadge(cam, hit, key) {
    var old = cam.querySelector(".hit-fx-badge");
    if (old) old.parentNode.removeChild(old);
    var badge = document.createElement("div");
    badge.className = "hit-fx-badge" + (hit.manche ? " manche" : "") + (hit.note ? " note" : "") +
      (key ? " m-" + key : "");
    // 式別が混ざった同時的中ではラベルを出さない（片方だけ出すと嘘になる・8/27 FB148）
    var typeLabel = (!hit.mixedType && hit.type && hit.type !== "3連単") ? " " + hit.type : "";
    // 同時に複数当たったら倍率を全部並べる（同着で両方の並びを持っていた時など・8/27 FB148）。
    // 高い方が先＝見出しになる
    var mults = (hit.mults && hit.mults.length ? hit.mults : [hit.mult]).filter(Boolean);
    var multLabel = mults.length ? " " + mults.map(function (m) { return m + "倍"; }).join("＋") : "";
    // 万車＝レインボー・note＝黄金（8/7 FB59）。万車×noteは虹背景＋noteラベルで両立
    badge.textContent = hit.manche
      ? "🌈 万車的中！" + (hit.note ? " note" : "") + multLabel
      : (hit.note ? "🔥 note的中！" : hit.deadHeat ? "🎯 同着ダブル的中！" : "🎯 的中！") + typeLabel + multLabel;
    cam.appendChild(badge);
    fitHitBadge(badge, cam); // ワイプ幅いっぱいの最大サイズ（はみ出す時だけ段階縮小・8/7 FB59）
    setTimeout(function () {
      if (badge.parentNode) badge.parentNode.removeChild(badge);
      if (!cam.querySelector(".hit-fx-badge")) {
        cam.classList.remove("hit-fx"); cam.classList.remove("hit-fx-manche"); cam.classList.remove("hit-fx-note");
        if (key) cam.classList.remove("m-" + key); // 個人演出のフックも一緒に外す（8/8 FB73）
      }
    }, HIT_FX_MS);
  }

  /** 的中バッジの自動フィット（8/7 FB59）：基本サイズ＝ワイプ幅いっぱい・実テキストが収まらない時だけ
      font-sizeを段階縮小（transformはバウンスのアニメが専有しているためサイズはフォントで合わせる） */
  function fitHitBadge(badge, cam) {
    var avail = cam.clientWidth - 20;
    if (avail <= 0) return;
    var fs = parseFloat(getComputedStyle(badge).fontSize) || 40;
    var guard = 0;
    while (badge.scrollWidth > avail && fs > 16 && guard < 14) {
      fs -= 2;
      badge.style.fontSize = fs + "px";
      guard++;
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
  /* maxSeenRev＝適用済みの最大rev（8/26 演出2連続再生の根治）。
     従来の「今のstate.revと同一なら捨てる」だけでは古いrevを弾けず、遅れて届いた
     古いポーリング応答（GASの302→404リトライ等で応答が追い越されることがある）が
     適用されて状態が数秒だけ巻き戻り、的中演出の再発火の引き金になっていた。
     ・楽観BC（revなし）は常に適用＝コンソールの最新の意図
     ・巻き戻り2000以上だけはバックエンド初期化とみなして受け入れる
       （revの進みは1日600前後＝遅延応答がそこまで古いことはあり得ない） */
  var maxSeenRev = 0;
  function applyState(s, path) {
    if (!s) return;
    if (s.rev) {
      var back = maxSeenRev - s.rev;
      if (back >= 0 && back < 2000) return; // 同一・古いrevの遅延応答は適用しない
      maxSeenRev = s.rev;
    }
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
    renderCampaign();
    renderResultScene();
    renderBrb();
    renderAd();
    renderTimers();
    renderDbg();
  }

  function renderDbg() {
    if (!DEBUG) return;
    // 今どのレースを描いているか＝①②③とも同じ（操作中のレース）
    var cv = state.venues[state.activeVenue];
    var tk = cv ? "｜" + cv.name + " " + (state.currentRace[cv.name] || "?") + "R" : "";
    $("dbg").textContent = "scene:" + SCENE + tk + "｜rev " + state.rev +
      "｜経路 " + syncPath + "｜BC " + (window.Sync.bcAlive ? "alive" : "-") +
      // OBS権限＝自動シーン切替（FB95）の可否確認用。4以上＝setCurrentScene可
      (window.obsstudio ? "｜OBS権限 " + (obsCtrlLevel === null ? "?" : obsCtrlLevel + (obsCtrlLevel >= 4 ? "(切替可)" : "(切替不可・要設定)")) : "") +
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
      // 日跨ぎで得点・ラインを全破棄。raceKeyは「場|R」で日付を持たないため、OBSソースを
      // 開きっぱなしにすると前日の同じ場・同じRの値が残り続ける（8/8・視聴者指摘で発覚）
      if (t && t.date && t.date !== narabiDate) {
        narabiAuto = {};
        narabiDate = t.date;
      }
      var now = Date.now();
      Object.keys(narabiAuto).forEach(function (k) {
        var e = narabiAuto[k];
        if (e.pending) return;
        // 未発表で空だったものは10分ごとに再試行（GAS側にも10分のネガティブキャッシュあり）／
        // 取得済みも60分で捨てて取り直す（欠場・補充で出走表が入れ替わるため）
        if (!hasRaceInfo(e) || (e.at && now - e.at > 3600000)) delete narabiAuto[k];
      });
      renderTimers();
      renderBrb();
      renderStartList();
      renderVenueTabs(); // note勝負の終了判定は時刻表基準（8/10 FB113）＝時刻表が届いたら即再評価
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
    autoSceneTick();    // 発走時刻の自動シーン切替（8/9 FB95・表示中ソースのみ実行）
    // 毎秒＝①②③帯・ライン行の自己修復（8/6 FB32/37/44・8/12で③を追加）
    if (++fitTick % 4 === 0) {
      fitTalkBands(); fitRaceBands();
      fitNarabi(SL_TALK.narabi); fitNarabi(SL_TK.narabi);
    }
    if (nhBoundary !== null && nowSec() >= nhBoundary) renderVenueTabs(); // note勝負＝終了レースを個々に消す（8/10 FB113）
    sweepHitGlows();    // 的中買目チップ強調の期限切れ掃除（8/10 FB119・27秒で通常表示へ）
  }, 250);              // 0.25秒刻み＝信号機色の切替と音のズレを知覚できない範囲に抑える

  tickClock();
  renderAll();
  requestAnimationFrame(buildBackdrop);
})();
