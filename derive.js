/* derive.js — 状態からの派生データ計算（日次集計・的中リスト・精算）
   §8「予想＋投資額を入力→結果が入ったら全部自動更新」の計算部。
   コンソール・オーバーレイの双方が同じ計算を使う（二重実装しない）。keirin.jsに依存。 */

(function (root) {
  var K = root.Keirin;

  function raceKey(venue, r) { return venue + "|" + r; }

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
      racers: [
        { id: "r1", name: "しょーた", color: "青" },
        { id: "r2", name: "ピーター", color: "緑" },
      ],
      roster: [
        { name: "しょーた", color: "青" },
        { name: "ピーター", color: "緑" },
        { name: "えーす", color: "オレンジ" },
        { name: "カズ", color: "赤" },
        { name: "もとき", color: "ピンク" },
        { name: "むねお", color: "黄色" },
      ],
      venues: [],
      activeVenue: 0,
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
      cfg: { closeMin: 5, netCloseMin: 15, timerCount: 3 },
    };
  }

  /** 1配信者×1レースの予想エントリ（無ければ空を返す） */
  function predOf(state, key, racerId) {
    var race = state.preds[key];
    var p = race && race.byRacer && race.byRacer[racerId];
    return p || { text: "", defaultType: "3連単", unit: 100, investInput: null };
  }

  /** 予想エントリをパースして投資額・単価を解決する */
  function resolvePred(state, key, racerId) {
    var race = state.preds[key] || {};
    var p = predOf(state, key, racerId);
    var parsed = K.parsePrediction(p.text, p.defaultType, race.cars || 9);
    var invest, unit;
    if (p.investInput > 0) {
      invest = p.investInput;
      unit = parsed.points ? p.investInput / parsed.points : 0;
    } else {
      unit = p.unit > 0 ? p.unit : 0;
      invest = parsed.points * unit;
    }
    return { entry: p, parsed: parsed, points: parsed.points, unit: unit, invest: invest };
  }

  /** 1レースの精算（結果が無ければ null） */
  function settleRace(state, key) {
    var result = state.results[key];
    if (!result || !result.order || result.order.length < 2) return null;
    var byRacer = {};
    state.racers.forEach(function (rc) {
      var rp = resolvePred(state, key, rc.id);
      byRacer[rc.id] = K.settle(rp.parsed, rp.unit, result.order, result.payouts || []);
    });
    return { result: result, byRacer: byRacer };
  }

  function hitId(key, racerId, hit) {
    return key + "|" + racerId + "|" + hit.type + "|" + hit.comboLabel;
  }

  /** 日次派生データ一式 */
  function day(state) {
    var totals = {};
    state.racers.forEach(function (rc) { totals[rc.id] = { invest: 0, refund: 0 }; });

    var hits = [];
    var raceHitFlags = {}; // key → 的中ありフラグ（結果チップの🎯用）
    var hidden = {};
    (state.hitsHidden || []).forEach(function (h) { hidden[h] = true; });

    // 投資は結果の有無に関係なく全予想を合算
    Object.keys(state.preds || {}).forEach(function (key) {
      state.racers.forEach(function (rc) {
        var rp = resolvePred(state, key, rc.id);
        if (totals[rc.id]) totals[rc.id].invest += rp.invest;
      });
    });

    // 回収・的中は結果が入ったレースのみ
    Object.keys(state.results || {}).forEach(function (key) {
      var s = settleRace(state, key);
      if (!s) return;
      var parts = key.split("|");
      state.racers.forEach(function (rc) {
        var res = s.byRacer[rc.id];
        if (!res) return;
        if (totals[rc.id]) totals[rc.id].refund += res.refund;
        res.hits.forEach(function (h) {
          var id = hitId(key, rc.id, h);
          if (hidden[id]) return;
          raceHitFlags[key] = true;
          hits.push({
            id: id, auto: true,
            racerName: rc.name,
            place: parts[0] + parts[1] + "R",
            type: h.type, comboLabel: h.comboLabel,
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

  /** 旧形式（文字列名簿）からの移行と、配信者への色引き当て */
  function normalizeState(state) {
    state.roster = (state.roster || []).map(function (r) {
      return typeof r === "string" ? { name: r, color: "" } : r;
    });
    state.narabi = state.narabi || {};
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
  };
})(typeof self !== "undefined" ? self : this);
