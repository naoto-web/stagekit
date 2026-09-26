/* ===========================================================
   anim.js — 動きのアニメ  v2（要件定義_v2 §7）

   2種類ある
   ① Anim.to()      ＝ドック側。局面ボタンなどで「目標の隊列」へ滑らかに動かす。
                       途中経過をそのまま State に書いて出力へ流す＝ドックと出力で同じ動き
                       遠いジャンプ（0.75周超）は「目的地の半周手前へ瞬間移動→そこから進む」
                       ＝スタート→赤板で3周回して目が回らない
   ② Anim.Smoother  ＝出力側。届いた状態（約30fps）へ毎フレーム追いつく＝カクつかない。
                       大きく飛んだとき（0.2周超）は追わずに瞬間移動（①のワープをそのまま見せる）
   =========================================================== */

var Anim = (function () {

  var raf = (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame.bind(window)
    : function (f) { return setTimeout(function () { f(Date.now()); }, 16); };
  var caf = (typeof cancelAnimationFrame === 'function')
    ? cancelAnimationFrame.bind(window)
    : clearTimeout;

  var cur = null;   // 実行中のアニメ { id, done }

  function isHidden() {
    try { return typeof document !== 'undefined' && document.hidden === true; } catch (e) { return false; }
  }

  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  function stop() {
    if (!cur) return;
    caf(cur.id);
    var done = cur.done;
    cur = null;
    if (done) done(false);
  }

  /**
   * 目標の隊列へ動かす（ドック側）
   * @param {Object} target  { no: {d, lane} }
   * @param {{ms?:number, onFrame:Function, onDone?:Function}} o
   */
  function to(target, o) {
    stop();
    var data = State.data;
    var from = {}, maxAbs = 0, sign = 1;
    Object.keys(target).forEach(function (no) {
      var r = data.riders[no];
      if (!r) return;
      from[no] = { d: r.d, lane: r.lane };
      var dd = target[no].d - r.d;
      if (Math.abs(dd) > maxAbs) { maxAbs = Math.abs(dd); sign = dd < 0 ? -1 : 1; }
    });

    /* 遠いジャンプは半周手前へワープしてから進む */
    if (maxAbs > 0.75) {
      Object.keys(from).forEach(function (no) {
        from[no] = { d: target[no].d - sign * 0.5, lane: from[no].lane };
      });
      maxAbs = 0.5;
    }
    var ms = (o && o.ms) || Math.round(Math.min(1100, 350 + maxAbs * 1200));
    /* ドックが隠れている（別タブ等）ときは rAF が止まる＝途中の隊列のまま出力に残る。
       rAF を待たずにその場で目標へ置く */
    if (isHidden()) {
      Object.keys(from).forEach(function (no) { State.moveRider(+no, target[no].d, target[no].lane); });
      if (o && o.onFrame) o.onFrame(true);
      if (o && o.onDone) o.onDone(true);
      return;
    }
    var t0 = null;
    var me = { id: 0, done: o && o.onDone };
    cur = me;

    function frame(ts) {
      if (cur !== me) return;
      if (t0 === null) t0 = ts;
      var t = Math.min(1, (ts - t0) / ms);
      var k = ease(t);
      Object.keys(from).forEach(function (no) {
        var a = from[no], b = target[no];
        State.moveRider(+no, a.d + (b.d - a.d) * k, a.lane + (b.lane - a.lane) * k);
      });
      if (o && o.onFrame) o.onFrame(t >= 1);
      if (t < 1) { me.id = raf(frame); return; }
      cur = null;
      if (me.done) me.done(true);
    }
    me.id = raf(frame);
  }

  /** 出力側：届いた状態へ毎フレーム追いつく表示用の写し */
  function Smoother(onFrame) {
    this.view = {};
    this.target = null;
    this.onFrame = onFrame;
    this.last = 0;
    this.running = false;
  }
  Smoother.prototype.setTarget = function (riders) {
    this.target = riders;
    var self = this;
    Object.keys(riders).forEach(function (no) {
      if (!self.view[no]) self.view[no] = { d: riders[no].d, lane: riders[no].lane };
    });
    /* 画面が隠れているときは requestAnimationFrame が止まる＝追いつかないまま古い絵が残る。
       そのときは追わずに最終位置を即座に描く（9/27の検査で、裏に回ったタブの絵が赤板のまま止まった） */
    if (isHidden()) {
      this.jump(riders);
      this.onFrame(this.view);
      return;
    }
    if (!this.running) {
      this.running = true;
      this.last = 0;
      var step = function (ts) {
        if (!self.tick(ts)) { self.running = false; return; }
        raf(step);
      };
      raf(step);
    }
  };
  /** @returns {boolean} まだ動いているか */
  Smoother.prototype.tick = function (ts) {
    var dt = this.last ? Math.min(100, ts - this.last) : 16;
    this.last = ts;
    var k = 1 - Math.exp(-dt / 55);   // 約120msで追いつく
    var moving = false, self = this, T = this.target;
    Object.keys(T).forEach(function (no) {
      var v = self.view[no], t = T[no];
      if (Math.abs(t.d - v.d) > 0.2) { v.d = t.d; v.lane = t.lane; return; }   // ワープはそのまま見せる
      v.d += (t.d - v.d) * k;
      v.lane += (t.lane - v.lane) * k;
      if (Math.abs(t.d - v.d) > 1e-5 || Math.abs(t.lane - v.lane) > 1e-4) moving = true;
      else { v.d = t.d; v.lane = t.lane; }
    });
    this.onFrame(this.view);
    return moving;
  };
  /** 構造が変わった（レース替わり等）ときは追わずに合わせる */
  Smoother.prototype.jump = function (riders) {
    var self = this;
    this.view = {};
    Object.keys(riders).forEach(function (no) { self.view[no] = { d: riders[no].d, lane: riders[no].lane }; });
    this.target = riders;
  };

  return {
    to: to,
    stop: stop,
    busy: function () { return !!cur; },
    Smoother: Smoother
  };
})();
