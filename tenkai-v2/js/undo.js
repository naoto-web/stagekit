/* ===========================================================
   undo.js — 取り消し／やり直し  v2（要件定義_v2 §6.6）
   ※名前を History にしないこと＝ブラウザ組み込みの window.History と衝突する

   1手＝ドラッグ1回・局面ボタン1回・ホイールのひと続き・並びの適用・配置を戻す
   最大 CONFIG.UNDO_MAX 手。保存はしない（開き直したら履歴は空）。
   ⚠️追従でレースが変わったら clear() する＝別レースの手を戻せてはいけない

   使い方：動かす「前」に Undo.push() を呼ぶ（その時点の盤面が1手ぶん積まれる）
   =========================================================== */

var Undo = (function () {

  var undoStack = [];
  var redoStack = [];
  var lastCoalesceKey = '', lastCoalesceAt = 0;

  function snapshot() {
    var d = State.data;
    return {
      riders: State.copyRiders(d.riders),
      lines: JSON.parse(JSON.stringify(d.lines || [])),
      cars: (d.cars || []).slice(),
      lineupText: d.lineupText || ''
    };
  }

  function restore(s) {
    State.set({ lines: s.lines, cars: s.cars, lineupText: s.lineupText });
    State.setRiders(s.riders);
  }

  /**
   * 今の盤面を1手ぶん積む
   * @param {string} [coalesceKey] 同じキーで短い間隔（700ms）に続いた操作は1手にまとめる（ホイール用）
   */
  function push(coalesceKey) {
    var now = Date.now();
    if (coalesceKey && coalesceKey === lastCoalesceKey && now - lastCoalesceAt < 700) {
      lastCoalesceAt = now;
      return;
    }
    lastCoalesceKey = coalesceKey || '';
    lastCoalesceAt = now;
    undoStack.push(snapshot());
    if (undoStack.length > CONFIG.UNDO_MAX) undoStack.shift();
    redoStack = [];
  }

  /** 直前の push を取り消す（押したが何も動かなかったとき用） */
  function dropLast() {
    undoStack.pop();
    lastCoalesceKey = '';
  }

  function undo() {
    if (!undoStack.length) return false;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    lastCoalesceKey = '';
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    lastCoalesceKey = '';
    return true;
  }

  function clear() {
    undoStack = [];
    redoStack = [];
    lastCoalesceKey = '';
  }

  return {
    push: push,
    dropLast: dropLast,
    undo: undo,
    redo: redo,
    clear: clear,
    canUndo: function () { return undoStack.length > 0; },
    canRedo: function () { return redoStack.length > 0; }
  };
})();
