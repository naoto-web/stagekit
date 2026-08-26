/* derive.js — 状態からの派生データ計算（日次集計・的中リスト・精算）
   §8「予想＋投資額を入力→結果が入ったら全部自動更新」の計算部。
   コンソール・オーバーレイの双方が同じ計算を使う（二重実装しない）。keirin.jsに依存。 */

(function (root) {
  var K = root.Keirin;

  function raceKey(venue, r) { return venue + "|" + r; }

  /* ---------- 配信者名の表記ゆれ吸収（8/15 FB135） ----------
     コンソールのnote勝負メモは手打ちなので「むねお／ムネオ」「ピータ／ピーター」のように揺れる。
     ひらがな/カタカナ・長音（ー）の有無・小書き文字・区切り記号/空白の違いを無視して名簿と突き合わせる。
     ⚠️使うのは「同じ人か」の判定だけ。画面に出す表記は名簿（state.roster）の表記が正。 */
  var KANA_BIG = {
    "ァ": "ア", "ィ": "イ", "ゥ": "ウ", "ェ": "エ", "ォ": "オ",
    "ヵ": "カ", "ヶ": "ケ", "ッ": "ツ", "ャ": "ヤ", "ュ": "ユ", "ョ": "ヨ", "ヮ": "ワ",
  };
  /* 無視する文字＝長音記号（ー・半角ｰ）／各種ハイフン・波ダッシュ／中黒／空白（全角空白は\sに含まれる）。
     ⚠️半角ハイフンは必ず \- でエスケープする（生の「ｰ-‐」は文字クラスの範囲指定と解釈されて構文エラー） */
  var KANA_SKIP = /[ーｰ\-‐‑‒–—―〜～~・･\s]/;
  /** 1文字の正規化。""＝無視する文字 */
  function kanaChar(c) {
    if (KANA_SKIP.test(c)) return "";
    var code = c.charCodeAt(0);
    if (code >= 0x3041 && code <= 0x3096) c = String.fromCharCode(code + 0x60); // ひらがな→カタカナ
    return KANA_BIG[c] || c;
  }
  /** 正規化形＋「正規化後n文字目が元文字列の何文字目か」の対応表（末尾に番兵を1つ置く） */
  function kanaMap(s) {
    var str = String(s == null ? "" : s);
    var norm = "", idx = [];
    for (var i = 0; i < str.length; i++) {
      var c = kanaChar(str.charAt(i));
      if (!c) continue;
      norm += c;
      idx.push(i);
    }
    idx.push(str.length);
    return { norm: norm, idx: idx };
  }
  /** 表記ゆれを無視した同一判定用のキー（"ピーター"も"ピータ"も"ピタ"） */
  function nameKey(s) { return kanaMap(s).norm; }
  /** line の中の name（表記ゆれ可）の位置。元文字列上の [start, end) ／無ければ null */
  function nameHit(line, name) {
    var k = nameKey(name);
    if (!k) return null;
    var m = kanaMap(line);
    var at = m.norm.indexOf(k);
    if (at < 0) return null;
    return { start: m.idx[at], end: m.idx[at + k.length] };
  }
  /** 1行から名簿の配信者を1人特定する（長い名前優先＝部分一致の誤マッチ防止）。無ければ null */
  function matchRacer(line, roster) {
    var m = kanaMap(line);
    var list = (roster || []).filter(function (r) { return r && r.name && nameKey(r.name); })
      .sort(function (a, b) { return nameKey(b.name).length - nameKey(a.name).length; });
    for (var i = 0; i < list.length; i++) {
      if (m.norm.indexOf(nameKey(list[i].name)) >= 0) return list[i];
    }
    return null;
  }
  /** 1行から name（表記ゆれ可）を全部取り除いた残り＝レース表記の抽出用 */
  function stripName(line, name) {
    var s = String(line == null ? "" : line);
    for (var guard = 0; guard < 8; guard++) {
      var h = nameHit(s, name);
      if (!h) break;
      s = s.slice(0, h.start) + " " + s.slice(h.end);
    }
    return s;
  }

  /* ---------- 名簿表記の変更（8/15・ひらがな→カタカナ統一） ----------
     stateは「名前＝配信者ID」で予想・回収・的中がぶら下がっているため、単に名簿を書き換えるだけだと
     旧名義の実績が孤児になる（＝投資/回収が0に戻る）。読み込み時にキーごと付け替える。
     GAS上の保存データはコンソールが次に保存した時点で新表記に置き換わる（それまでは読むたびに変換）。 */
  var RENAME = { "むねお": "ムネオ" };
  function renameRacers(state) {
    var olds = Object.keys(RENAME);
    if (!olds.length) return state;
    var rn = function (v) { return RENAME[v] || v; };
    var mapKeys = function (obj) { // 配信者IDをキーに持つマップの付け替え
      if (!obj || typeof obj !== "object") return;
      olds.forEach(function (o) {
        if (!Object.prototype.hasOwnProperty.call(obj, o)) return;
        if (!Object.prototype.hasOwnProperty.call(obj, RENAME[o])) obj[RENAME[o]] = obj[o];
        delete obj[o];
      });
    };
    (state.roster || []).forEach(function (r) { if (r && r.name) r.name = rn(r.name); });
    (state.racers || []).forEach(function (r) {
      if (!r) return;
      if (r.name) r.name = rn(r.name);
      if (r.id) r.id = rn(r.id);
    });
    Object.keys(state.preds || {}).forEach(function (k) { mapKeys((state.preds[k] || {}).byRacer); });
    Object.keys(state.results || {}).forEach(function (k) { mapKeys((state.results[k] || {}).refunds); });
    mapKeys(state.talkRaces);
    mapKeys(state.raceSubBy);
    mapKeys(state.subVenueBy);
    (state.hitsManual || []).forEach(function (h) { if (h && h.racerName) h.racerName = rn(h.racerName); });
    // 非表示にした的中のID（場|R|配信者|種別|組）も付け替える＝消した的中が改名で復活しないように
    state.hitsHidden = (state.hitsHidden || []).map(function (id) {
      var p = String(id).split("|");
      if (p.length >= 3) p[2] = rn(p[2]);
      return p.join("|");
    });
    return state;
  }

  /* チームカラー：名簿の色は日本語（またはhex）で保存し、表示時にhexへ変換 */
  var COLOR_MAP = {
    "青": "#3b82f6", "緑": "#22c55e", "オレンジ": "#f97316", "橙": "#f97316",
    "赤": "#ef4444", "ピンク": "#ec4899", "桃": "#ec4899",
    "黄": "#eab308", "黄色": "#eab308", "紫": "#8b5cf6", "水色": "#38bdf8",
  };
  function colorOf(word) {
    if (!word) return "";
    return COLOR_MAP[word] || (/^#[0-9a-fA-F]{3,8}$/.test(word) ? word : "");
  }

  function defaultState(dateStr) {
    return {
      rev: 0,
      date: dateStr,
      // 配信者IDは「人ベース（＝名前）」。枠ベース（r1/r2）だとシフト交代で
      // 前半配信者の投資/回収/的中が後半の名前に付け替わってしまうため（7/30修正）
      racers: [
        { id: "しょーた", name: "しょーた", color: "青" },
        { id: "ピーター", name: "ピーター", color: "緑" },
      ],
      roster: [
        { name: "しょーた", color: "青" },
        { name: "ピーター", color: "緑" },
        { name: "えーす", color: "オレンジ" },
        { name: "カズ", color: "赤" },
        { name: "もとき", color: "ピンク" },
        { name: "ムネオ", color: "黄色" }, // 8/15にひらがな「むねお」から変更（旧表記はrenameRacersで吸収）
      ],
      venues: [],
      activeVenue: 0,
      raceSubVenue: null, // 旧・共通サブ場（8/6 FB17でraceSubByへ移行・互換読みのため残置）
      raceSubBy: {},      // ②サブ予想の場（配信者idごと・8/6 FB17）。空＝OFF＝従来レイアウト
      currentRace: {},
      grade: {},
      narabi: {},
      preds: {},
      results: {},
      resultView: null,
      hitsManual: [],
      hitsHidden: [],
      ad: { title: "", lines: [], goalLabel: "応募状況", cur: 0, max: 0, showProgress: false },
      brbMsg: "まもなく再開します",
      noteRaces: "", // 本日のnote勝負レース（①トーク出走表下に表示・空欄で非表示・8/6追加）
      campaignCount: null, // 本日のキャンペーン応募人数（バナー時計左・空＝非表示・8/6 FB21）
      // 公式＝発走−3分・民間＝発走−5分（7/29 Naoto指定）。
      // autoScene＝発走時刻に②レース観戦へ自動切替（8/9 FB95）／autoAlign＝予想レースの自動追従（8/9 FB96）
      cfg: { closeMin: 3, netCloseMin: 5, timerCount: 3, autoScene: true, autoAlign: true },
    };
  }

  /** 1配信者×1レースの予想エントリ（無ければ空を返す）
      oreTachi＝無料公開の俺たち目1点（表示専用・点数/的中計算には入れない）／isNote＝note予想（勝負レース）フラグ */
  function predOf(state, key, racerId) {
    var race = state.preds[key];
    var p = race && race.byRacer && race.byRacer[racerId];
    return p || { text: "", defaultType: "3連単", unit: 100, investInput: null, oreTachi: "", isNote: false };
  }

  /** 予想エントリをパースして投資額を解決する。
      投資＝手入力の実額のみ（単価×点数方式は廃止・2026/8/4）。回収も結果側の手入力実額 */
  function resolvePred(state, key, racerId) {
    var race = state.preds[key] || {};
    var p = predOf(state, key, racerId);
    var parsed = K.parsePrediction(p.text, p.defaultType, race.cars || 9);
    var invest = p.investInput > 0 ? p.investInput : 0;
    return { entry: p, parsed: parsed, points: parsed.points, unit: 0, invest: invest };
  }

  /** 1レースの精算（結果が無ければ null）。
      現在の配信者ではなく「そのレースに予想を入れた人」全員を精算する
      ＝シフト交代後でも前半配信者の的中・回収が本人名義のまま残る */
  function settleRace(state, key) {
    var result = state.results[key];
    if (!result || !result.order || result.order.length < 2) return null;
    var byRacer = {};
    var br = (state.preds[key] || {}).byRacer || {};
    Object.keys(br).forEach(function (pid) {
      var rp = resolvePred(state, key, pid);
      var s = K.settle(rp.parsed, 0, result.order, result.payouts || []);
      s.invest = rp.invest;
      s.refund = (result.refunds || {})[pid] || 0; // 回収＝手入力の実額
      s.isNote = !!rp.entry.isNote; // note予想レースの的中表示用（8/6 FB53）
      // 俺たち目（無料公開1点）も的中判定に参加（8/4）。金額計算には入れない＝投資/回収は不変
      s.oreHits = [];
      if (rp.entry.oreTachi) {
        var op = K.parsePrediction(K.oreNormalize(rp.entry.oreTachi), "3連単", (state.preds[key] || {}).cars || 9);
        s.oreHits = K.settle(op, 0, result.order, result.payouts || []).hits;
      }
      byRacer[pid] = s;
    });
    return { result: result, byRacer: byRacer };
  }

  function hitId(key, racerId, hit) {
    return key + "|" + racerId + "|" + hit.type + "|" + hit.comboLabel;
  }

  /** 日次派生データ一式。
      集計は「予想を入れた人」単位（人ベースID＝名前）＝現在の配信者が誰かに依存しない。
      表示側は totals[現在の配信者id] を参照するので、シフト交代直後は自然に0スタートになる */
  function day(state) {
    var totals = {};
    // pending＝「的中しているのに回収額が未入力」のレースを抱えている状態（8/8）。
    // 回収は手入力なので、入力までの間このフラグが立つ。表示側は回収額の代わりに
    // 「集計中」を出す＝ティッカーが的中を流しているのに回収¥0、という矛盾を防ぐ。
    // 判定条件はコンソールの警告バー（checkRefundGaps）と同一に揃えてある
    state.racers.forEach(function (rc) { totals[rc.id] = { invest: 0, refund: 0, pending: false }; });
    function tOf(pid) {
      if (!totals[pid]) totals[pid] = { invest: 0, refund: 0, pending: false };
      return totals[pid];
    }

    var hits = [];
    var raceHitFlags = {}; // key → 的中ありフラグ（結果チップの🎯用）
    var hidden = {};
    (state.hitsHidden || []).forEach(function (h) { hidden[h] = true; });

    // 投資は結果の有無に関係なく全予想を合算（入れた本人に計上）
    Object.keys(state.preds || {}).forEach(function (key) {
      var br = (state.preds[key] || {}).byRacer || {};
      Object.keys(br).forEach(function (pid) {
        tOf(pid).invest += resolvePred(state, key, pid).invest;
      });
    });

    // 回収・的中は結果が入ったレースのみ
    Object.keys(state.results || {}).forEach(function (key) {
      var s = settleRace(state, key);
      if (!s) return;
      var parts = key.split("|");
      Object.keys(s.byRacer).forEach(function (pid) {
        var res = s.byRacer[pid];
        if (!res) return;
        tOf(pid).refund += res.refund;
        // 買い目（有料分）の的中がある＋投資済み＋回収未入力＝集計待ち。
        // 俺たち目だけの的中は金額計算の対象外なので回収入力も不要＝pendingにしない
        if (res.hits.length && res.invest > 0 && !res.refund) tOf(pid).pending = true;
        // 俺たち目と同じ目が買い目でもヒットした場合は俺たち目名義だけ残す（8/6 FB53・かさ増し防止）
        var oreCombos = {};
        (res.oreHits || []).forEach(function (h) { oreCombos[h.comboLabel] = true; });
        res.hits.forEach(function (h) {
          if (h.type === "3連単" && oreCombos[h.comboLabel]) return;
          var id = hitId(key, pid, h);
          if (hidden[id]) return;
          raceHitFlags[key] = true;
          hits.push({
            id: id, auto: true,
            resAuto: !!s.result.auto, // 結果が「自動確定」由来か（8/6 FB47・ワイプ演出の抑止判定用）
            note: !!res.isNote, // note予想レースの的中（8/6 FB53・ティッカー表記用）
            racerName: pid,
            place: parts[0] + parts[1] + "R",
            type: h.type, comboLabel: h.comboLabel,
            mult: h.mult, amount: h.amount, manche: h.manche,
            at: s.result.settledAt || "",
          });
        });
        (res.oreHits || []).forEach(function (h) {
          var id = hitId(key, pid, { type: "俺たち目", comboLabel: h.comboLabel });
          if (hidden[id]) return;
          raceHitFlags[key] = true;
          hits.push({
            id: id, auto: true,
            resAuto: !!s.result.auto, // 同上（8/6 FB47）
            note: !!res.isNote, // 同上（8/6 FB53）
            racerName: pid,
            place: parts[0] + parts[1] + "R",
            type: "俺たち目", comboLabel: h.comboLabel,
            mult: h.mult, amount: h.amount, manche: h.manche,
            at: s.result.settledAt || "",
          });
        });
      });
    });

    // 手動追加分をマージ
    (state.hitsManual || []).forEach(function (m, i) {
      hits.push({
        id: "manual-" + i, auto: false,
        racerName: m.racerName, place: m.place, type: m.type || "",
        comboLabel: "", mult: m.mult, amount: m.mult ? Math.round(m.mult * 100) : 0,
        manche: m.mult >= 100, at: m.at || "",
      });
    });

    hits.sort(function (a, b) { return (b.at || "").localeCompare(a.at || ""); }); // 新しい順

    // 結果チップ（確定済みレース・確定順）
    var chips = Object.keys(state.results || {})
      .filter(function (key) { return state.results[key] && state.results[key].order; })
      .map(function (key) {
        var parts = key.split("|");
        return { key: key, label: parts[0] + parts[1] + "R", hit: !!raceHitFlags[key], at: state.results[key].settledAt || "" };
      })
      .sort(function (a, b) { return (a.at || "").localeCompare(b.at || ""); });

    return { totals: totals, hits: hits, chips: chips };
  }

  /* ---------- 発走時刻ベースの自動追従（8/9 FB95/96） ----------
     races＝[{venue, no, startSec}]（呼び出し側が「選択中の場」だけに絞って渡す）。
     純関数としてここに置く＝コンソール・オーバーレイで共用し、Nodeテストで検証できる */

  /** 発走直後（winSec秒以内）のレース。エッジ検知用＝毎tick呼び、新顔が出た1回だけ発火させる */
  function justStartedRace(races, nowSec, winSec) {
    var hit = null;
    (races || []).forEach(function (r) {
      if (r.startSec <= nowSec && nowSec - r.startSec <= winSec &&
          (!hit || r.startSec > hit.startSec)) hit = r;
    });
    return hit;
  }

  /** タイマー基準の「いま映像に映っているはずのレース」：
      発走からliveSec秒以内ならそのレース、いなければ次に発走するレース */
  function videoRaceAt(races, nowSec, liveSec) {
    var live = justStartedRace(races, nowSec, liveSec);
    if (live) return live;
    var next = null;
    (races || []).forEach(function (r) {
      if (r.startSec > nowSec && (!next || r.startSec < next.startSec)) next = r;
    });
    return next;
  }

  /** 盤面をraceに合わせる：メイン（activeVenue・currentRace）＝race／
      サブ（raceSubBy）＝その次に発走するレースの場（サブONの配信者のみ・OFFの人は触らない）。
      変更が1つでもあればtrue（保存は呼び出し側）。
      ⚠️次レースが同じ場のとき（1場運用の帯など）はサブを触らない：
        currentRaceが場単位のため「メイン＝2R・サブ＝3R」を同じ場では表現できない */
  function alignToRace(state, races, race) {
    if (!state || !race) return false;
    var idx = -1;
    (state.venues || []).forEach(function (v, i) { if (v.name === race.venue) idx = i; });
    if (idx < 0) return false;
    var changed = false;
    if (state.activeVenue !== idx) { state.activeVenue = idx; changed = true; }
    if (!state.currentRace) state.currentRace = {};
    if (state.currentRace[race.venue] !== race.no) { state.currentRace[race.venue] = race.no; changed = true; }
    var next = null;
    (races || []).forEach(function (r) {
      if (r.startSec > race.startSec && (!next || r.startSec < next.startSec)) next = r;
    });
    if (next && next.venue !== race.venue) {
      if (state.currentRace[next.venue] !== next.no) { state.currentRace[next.venue] = next.no; changed = true; }
      (state.racers || []).forEach(function (rc) {
        var cur = state.raceSubBy && state.raceSubBy[rc.id];
        if (cur && cur !== next.venue) { state.raceSubBy[rc.id] = next.venue; changed = true; }
      });
    }
    return changed;
  }

  /** 確定時に選手名・決まり手をどこから引き継ぐか（8/27 FB143＝コンソールの手入力欄を撤去したため）。
      戻り値は常に新しい配列（呼び出し側が持ち回っても元データを壊さない）。
        ①自動取得の結果が「同じ着順」ならその names/kimarite を採用
          ⚠️着順が違うのに採用すると2着の名前が1着に付くズレになるので一致を必須にする。
             手入力が自動取得の前方一致（例：2車単だけ入れた 1-9 と 自動 1-9-2）は一致とみなす
        ②既存の確定結果があれば維持（再確定・回収額の入れ直しで消さない）
        ③どちらも無ければ空＝オーバーレイ側の既存フォールバック（出走表から車番で引く→「○番車」）が働く */
  function carryResultMeta(auto, prev, order) {
    if (auto && auto.order && order && order.length &&
        auto.order.slice(0, order.length).join("-") === order.join("-")) {
      return { names: (auto.names || []).slice(), kimarite: (auto.kimarite || []).slice() };
    }
    if (prev) return { names: (prev.names || []).slice(), kimarite: (prev.kimarite || []).slice() };
    return { names: [], kimarite: [] };
  }

  /** 旧形式（文字列名簿・枠ID）からの移行と、配信者への色引き当て */
  function normalizeState(state) {
    state.roster = (state.roster || []).map(function (r) {
      return typeof r === "string" ? { name: r, color: "" } : r;
    });
    renameRacers(state); // 名簿表記の変更（むねお→ムネオ）を実績ごと付け替える（8/15）
    state.narabi = state.narabi || {};
    // 旧スロットID（r1/r2）→ 人ベースID（名前）へ移行。
    // 予想データのキーも現在の割当で付け替える（移行時点の割当までしか遡れない点は許容）
    var idMap = {};
    (state.racers || []).forEach(function (rc) {
      if ((rc.id === "r1" || rc.id === "r2") && rc.name) {
        idMap[rc.id] = rc.name;
        rc.id = rc.name;
      }
    });
    if (idMap.r1 || idMap.r2) {
      Object.keys(state.preds || {}).forEach(function (key) {
        var br = state.preds[key].byRacer;
        if (!br) return;
        Object.keys(idMap).forEach(function (old) {
          if (!br[old]) return;
          if (!br[idMap[old]]) br[idMap[old]] = br[old];
          delete br[old];
        });
      });
    }
    (state.racers || []).forEach(function (rc) {
      if (!rc.color) {
        var m = state.roster.filter(function (r) { return r.name === rc.name; })[0];
        if (m) rc.color = m.color;
      }
    });
    return state;
  }

  root.Derive = {
    raceKey: raceKey,
    defaultState: defaultState,
    normalizeState: normalizeState,
    colorOf: colorOf,
    predOf: predOf,
    resolvePred: resolvePred,
    settleRace: settleRace,
    day: day,
    justStartedRace: justStartedRace,
    videoRaceAt: videoRaceAt,
    alignToRace: alignToRace,
    carryResultMeta: carryResultMeta,
    nameKey: nameKey,
    nameHit: nameHit,
    matchRacer: matchRacer,
    stripName: stripName,
  };
})(typeof self !== "undefined" ? self : this);
