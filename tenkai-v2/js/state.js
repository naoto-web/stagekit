/* ===========================================================
   state.js — 状態オブジェクト＋localStorage  v2

   このアプリの真実は State.data ただ1つ。描画は必ずこれを見て描く。
   v2は選手の位置を { d, lane }（周回位置・内外）で持つ（要件定義_v2 §8）。
   保存キーは v2 専用＝v1の (x, y) の保存は読まない。
   =========================================================== */

var State = (function () {

  var listeners = [];

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** スタートの隊列（先頭＝1番）。レース未選択で開いたときの見た目＝人が見て「未設定」と分かる */
  function defaultRiders() {
    var riders = {};
    var start = CONFIG.PHASES[0].d;
    for (var no = 1; no <= CONFIG.MAX_CAR; no++) {
      riders[no] = { d: start + (no - 1) * CONFIG.LAYOUT.gapInLine * CONFIG.CAR, lane: -1 };
    }
    return riders;
  }

  function allCars() {
    var cs = [];
    for (var no = 1; no <= CONFIG.MAX_CAR; no++) cs.push(no);
    return cs;
  }

  function defaultData() {
    return {
      v: 2,
      /* 盤面に出す車番。並びに書かれた車番がそのまま入る */
      cars: allCars(),
      /* 出走表が持っている車番（＝そのレースに存在する車番）。手入力を検証するときの母集合 */
      raceCars: [],
      iconRatio: CONFIG.ICON_RATIO_DEFAULT,
      bg: 'normal',
      showBars: 'on',
      showNames: 'on',
      /* 車番→苗字。出走表を読み込むと入る */
      names: {},
      /* 選択中のレース。date＝この盤面を組んだ時刻表の日付（yyyyMMdd）。
         ⚠️日付を外さないこと。場コードとR番号だけだと**翌日の同じ場・同じR**を
            「もう出している同じレース」と誤判定して盤面を組み直さない（2026-09-21の事故） */
      sel: { date: '', joCode: '', raceNo: 0 },
      titleMain: '',
      titleSub: '',
      lineupText: '',
      /* ライン構成。連結バーの描画と「ラインごと動かす」の単位。例：[[1,3,5],[2,7],[4,6,9]] */
      lines: [],
      /* 車番 → { d:周回位置, lane:内外 } */
      riders: defaultRiders()
    };
  }

  var data = defaultData();

  function cleanRider(r) {
    if (!r || typeof r.d !== 'number' || typeof r.lane !== 'number' ||
        !isFinite(r.d) || !isFinite(r.lane)) return null;
    return { d: clamp(r.d, 0, CONFIG.D_MAX), lane: clamp(r.lane, -1, 1) };
  }

  /* --- 保存されたデータを取り込む（形が違っても壊れないように検証する） --- */
  function sanitize(raw) {
    var d = defaultData();
    if (!raw || typeof raw !== 'object') return d;

    function carList(src) {
      var cs = [];
      (Array.isArray(src) ? src : []).forEach(function (n) {
        var no = parseInt(n, 10);
        if (no >= 1 && no <= CONFIG.MAX_CAR && cs.indexOf(no) === -1) cs.push(no);
      });
      return cs;
    }
    var cs = carList(raw.cars);
    if (cs.length) d.cars = cs;
    d.raceCars = carList(raw.raceCars);
    if (typeof raw.iconRatio === 'number' && isFinite(raw.iconRatio)) {
      d.iconRatio = clamp(raw.iconRatio, CONFIG.ICON_RATIO_MIN, CONFIG.ICON_RATIO_MAX);
    }
    if (raw.bg === 'green' || raw.bg === 'normal') d.bg = raw.bg;
    if (typeof raw.lineupText === 'string') d.lineupText = raw.lineupText;
    if (typeof raw.titleMain === 'string') d.titleMain = raw.titleMain.slice(0, 40);
    if (typeof raw.titleSub === 'string') d.titleSub = raw.titleSub.slice(0, 60);

    if (raw.names && typeof raw.names === 'object') {
      for (var nn = 1; nn <= CONFIG.MAX_CAR; nn++) {
        if (typeof raw.names[nn] === 'string') d.names[nn] = raw.names[nn].slice(0, 8);
      }
    }
    if (raw.sel && typeof raw.sel === 'object') {
      /* 日付の無い旧データは date='' になる＝呼び出し側は「今日の時刻表と一致しない＝組み直す」と判定する */
      d.sel = {
        date: /^\d{8}$/.test(String(raw.sel.date || '')) ? String(raw.sel.date) : '',
        joCode: String(raw.sel.joCode || ''),
        raceNo: parseInt(raw.sel.raceNo, 10) || 0
      };
    }

    if (Array.isArray(raw.lines)) {
      var cleaned = [];
      raw.lines.forEach(function (line) {
        if (!Array.isArray(line)) return;
        var l = [];
        line.forEach(function (n) {
          var no = parseInt(n, 10);
          if (no >= 1 && no <= CONFIG.MAX_CAR && l.indexOf(no) === -1) l.push(no);
        });
        if (l.length) cleaned.push(l);
      });
      d.lines = cleaned;
    }

    if (raw.riders && typeof raw.riders === 'object') {
      for (var no = 1; no <= CONFIG.MAX_CAR; no++) {
        var r = cleanRider(raw.riders[no]);
        if (r) d.riders[no] = r;
      }
    }
    return d;
  }

  function load() {
    try {
      var raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      data = sanitize(raw ? JSON.parse(raw) : null);
    } catch (e) {
      data = defaultData();
    }
    return data;
  }

  /* 出力ビューは操作ビューと同じlocalStorageを共有してしまう（OBSでは同一プロファイル）。
     出力側が書き戻すと操作側の保存を上書きして事故るので、書き込みを止められるようにする */
  var persist = true;

  function save() {
    if (!persist) return;
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      /* プライベートモード等で書けなくても動作は続ける */
    }
  }

  function emit() {
    for (var i = 0; i < listeners.length; i++) listeners[i](data);
  }

  /** 位置だけの写し（取り消し・アニメの起点に使う） */
  function copyRiders(src) {
    var out = {};
    for (var no in src) {
      if (Object.prototype.hasOwnProperty.call(src, no)) out[no] = { d: src[no].d, lane: src[no].lane };
    }
    return out;
  }

  return {
    get data() { return data; },

    load: load,
    save: save,
    sanitize: sanitize,

    /** false にすると localStorage への書き込みを止める（出力ビュー用） */
    setPersist: function (v) { persist = !!v; },

    onChange: function (fn) { listeners.push(fn); },

    /** 一括更新。patch のキーだけ差し替える */
    set: function (patch) {
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) data[k] = patch[k];
      }
      save();
      emit();
    },

    /** 1台だけ動かす（ドラッグ・アニメ用。保存も描画もしない＝呼び出し側がまとめてやる） */
    moveRider: function (no, d, lane) {
      var r = data.riders[no];
      if (!r) return;
      r.d = clamp(d, 0, CONFIG.D_MAX);
      r.lane = clamp(lane, -1, 1);
    },

    /** 全台の位置を差し替える（自動配置・取り消し用） */
    setRiders: function (positions) {
      for (var no in positions) {
        if (!Object.prototype.hasOwnProperty.call(positions, no)) continue;
        var r = cleanRider(positions[no]);
        if (r) data.riders[no] = r;
      }
      save();
      emit();
    },

    copyRiders: copyRiders,

    /** 盤面に出ている選手のうち、いちばん前（d最小）の周回位置。誰もいなければ null */
    leaderD: function () {
      var best = null;
      (data.cars || []).forEach(function (no) {
        var r = data.riders[no];
        if (r && (best === null || r.d < best)) best = r.d;
      });
      return best;
    },

    /** レース由来のものだけ丸ごと捨てて「まだ何も選んでいない」状態に戻す（表示の好みは残す）。
        別の日に組んだ盤面を配信に出さないために使う＝**空**より**前日の嘘**のほうが害が大きい */
    clearRace: function () {
      var d0 = defaultData();
      data.cars = d0.cars;
      data.raceCars = [];
      data.names = {};
      data.lines = [];
      data.lineupText = '';
      data.titleMain = '';
      data.titleSub = '';
      data.sel = { date: '', joCode: '', raceNo: 0 };
      data.riders = d0.riders;
      save();
      emit();
    },

    reset: function () {
      /* 表示の好みと読み込んだ出走表は残し、配置とラインだけ初期に戻す */
      var keep = {
        cars: data.cars, raceCars: data.raceCars,
        iconRatio: data.iconRatio, bg: data.bg,
        names: data.names, sel: data.sel,
        titleMain: data.titleMain, titleSub: data.titleSub
      };
      data = defaultData();
      for (var k in keep) {
        if (Object.prototype.hasOwnProperty.call(keep, k)) data[k] = keep[k];
      }
      save();
      emit();
    },

    clamp: clamp,
    defaultRiders: defaultRiders
  };
})();
