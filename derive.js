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
      cfg: { closeMin: 3, netCloseMin: 5, timerCount: 3 }, // 公式＝発走−3分・民間＝発走−5分（7/29 Naoto指定）
    };
  }

  /** 1配信者×1レースの予想エントリ（無ければ空を返す）
      oreTachi＝無料公開の俺たち目1点（表示専用・点数/的中計算には入れない）／isNote＝note予想（勝負レース）フラグ */
  function predOf(state, key, racerId) {
    var race = state.preds[key];
    var p = race && race.byRacer && race.byRacer[racerId];
    return p || { text: "", defaultType: "3連単", unit: 100, investInput: null, oreTachi: "", isNote: false };
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
      byRacer[pid] = K.settle(rp.parsed, rp.unit, result.order, result.payouts || []);
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
    state.racers.forEach(function (rc) { totals[rc.id] = { invest: 0, refund: 0 }; });
    function tOf(pid) {
      if (!totals[pid]) totals[pid] = { invest: 0, refund: 0 };
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
        res.hits.forEach(function (h) {
          var id = hitId(key, pid, h);
          if (hidden[id]) return;
          raceHitFlags[key] = true;
          hits.push({
            id: id, auto: true,
            racerName: pid,
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

  /** 旧形式（文字列名簿・枠ID）からの移行と、配信者への色引き当て */
  function normalizeState(state) {
    state.roster = (state.roster || []).map(function (r) {
      return typeof r === "string" ? { name: r, color: "" } : r;
    });
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
  };
})(typeof self !== "undefined" ? self : this);
