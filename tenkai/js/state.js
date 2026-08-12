/* ===========================================================
   state.js — 状態オブジェクト＋localStorage

   このアプリの真実は State.data ただ1つ。描画は必ずこれを見て描く。
   stagekit へ統合するときは、この data をそのまま同期に載せる。
   =========================================================== */

var State = (function () {

  var listeners = [];

  function defaultRiders() {
    /* 初期は内圏線のすぐ外に1列。先頭は左（＝1番が左端） */
    var riders = {};
    var L = CONFIG.LAYOUT;
    for (var no = 1; no <= CONFIG.MAX_CAR; no++) {
      riders[no] = {
        x: clamp(1 - (L.headX - (no - 1) * L.gapInLine), CONFIG.BOUNDS.minX, CONFIG.BOUNDS.maxX),
        y: L.lineY[0]
      };
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
      /* 盤面に出す車番。並びに書かれた車番がそのまま入る */
      cars: allCars(),
      /* 出走表が持っている車番（＝そのレースに存在する車番）。
         手入力を検証するときの母集合。cars と分けているのは、
         並びを打ち直したときに一度消えた車番を復活させられるようにするため */
      raceCars: [],
      /* 進行方向は「左が先頭」で固定（2026-08-08確定）。
         反転ロジックは残してあるので、必要になれば 'right' を入れれば戻せる */
      dir: 'left',
      iconRatio: CONFIG.ICON_RATIO_DEFAULT,
      bg: 'normal',
      showBars: 'on',
      showNames: 'on',
      /* 車番→苗字。出走表を読み込むと入る */
      names: {},
      /* 選択中のレース（再読込時に選び直すため保持） */
      sel: { joCode: '', raceNo: 0 },
      /* 盤面左上に出す見出し。例 '和歌山 12R' / 'G3・Ｓ級決勝・三分戦' */
      titleMain: '',
      titleSub: '',
      lineupText: '',
      /* ライン構成。連結バーの描画と「ラインごと動かす」の単位になる。
         並びを適用したときに更新される。例：[[1,3,5],[2,7],[4,6,9]] */
      lines: [],
      riders: defaultRiders()
    };
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  var data = defaultData();

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
      d.sel = {
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
        var r = raw.riders[no];
        if (r && typeof r.x === 'number' && typeof r.y === 'number' &&
            isFinite(r.x) && isFinite(r.y)) {
          d.riders[no] = {
            x: clamp(r.x, CONFIG.BOUNDS.minX, CONFIG.BOUNDS.maxX),
            y: clamp(r.y, CONFIG.BOUNDS.minY, CONFIG.BOUNDS.maxY)
          };
        }
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

  return {
    get data() { return data; },

    load: load,
    save: save,

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

    /** 1台だけ動かす（ドラッグ用。描画は呼び出し側が直接やる） */
    moveRider: function (no, x, y) {
      var r = data.riders[no];
      if (!r) return;
      r.x = clamp(x, CONFIG.BOUNDS.minX, CONFIG.BOUNDS.maxX);
      r.y = clamp(y, CONFIG.BOUNDS.minY, CONFIG.BOUNDS.maxY);
    },

    /** 全台の座標を差し替える（自動配置用） */
    setRiders: function (positions) {
      for (var no in positions) {
        if (!Object.prototype.hasOwnProperty.call(positions, no)) continue;
        var p = positions[no];
        data.riders[no] = {
          x: clamp(p.x, CONFIG.BOUNDS.minX, CONFIG.BOUNDS.maxX),
          y: clamp(p.y, CONFIG.BOUNDS.minY, CONFIG.BOUNDS.maxY)
        };
      }
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

    clamp: clamp
  };
})();
