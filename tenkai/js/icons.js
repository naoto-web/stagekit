/* ===========================================================
   icons.js — アイコン生成

   ★差し替え点★
   将来ここを自作SVGシルエット版に入れ替える。
   外に見せるのは create(no) / setDirection(el, dir) の2つだけなので、
   ここだけ書き換えれば他のファイルは一切触らずに差し替えられる。
   ダメだったらこのファイルを戻すだけで元に戻る。
   =========================================================== */

var Icons = (function () {

  var KIND = 'circle';   // 'circle' | （将来）'silhouette'

  /** 色丸＋車番。下に苗字ラベルをぶら下げる */
  function createCircle(no) {
    var c = CONFIG.COLORS[no];

    var wrap = document.createElement('div');
    wrap.className = 'rider';
    wrap.dataset.no = String(no);

    var body = document.createElement('div');
    body.className = 'rider-body';
    body.style.background = c.bg;
    body.style.color = c.fg;
    body.style.border = '2px solid ' + c.ring;
    body.textContent = String(no);

    var label = document.createElement('div');
    label.className = 'rider-name';

    wrap.appendChild(body);
    wrap.appendChild(label);
    return wrap;
  }

  return {
    kind: KIND,

    /** 車番 no のアイコン要素を作って返す */
    create: function (no) {
      return createCircle(no);
    },

    /** 苗字ラベルを差し込む。空文字なら消える */
    setName: function (el, text) {
      var label = el.querySelector('.rider-name');
      if (!label) return;
      label.textContent = text || '';
      el.classList.toggle('is-noname', !text);
    },

    /** 進行方向に合わせて向きを変える（丸は左右対称なので今は何もしない） */
    setDirection: function (el, dir) {
      if (KIND === 'circle') return;
      el.style.transform = (dir === 'left') ? 'scaleX(-1)' : '';
    }
  };
})();
