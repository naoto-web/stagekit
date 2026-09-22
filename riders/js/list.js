/* ===========================================================
   list.js — 選手一覧（あいうえお検索・しぼりこみ）
   =========================================================== */

var LIST = (function () {

  var state = { all: [], row: '', q: '', kyuhan: 'A3', loaded: false };

  function load(kyuhan, force) {
    var want = kyuhan || state.kyuhan;
    if (state.loaded && want === state.kyuhan && !force) return Promise.resolve(state.all);
    state.kyuhan = want;
    setCount('読み込み中…');
    return API.roster(want).then(function (j) {
      state.all = j.riders || [];
      state.loaded = true;
      render();
      return state.all;
    }).catch(function (e) {
      setCount('読み込めませんでした：' + e.message);
      throw e;
    });
  }

  function setCount(t) {
    var n = document.getElementById('list-count');
    if (n) n.textContent = t;
  }

  function renderKanaRows() {
    var box = document.getElementById('kana-rows');
    clear(box);
    var mk = function (key, label) {
      var b = el('button', 'kana' + (state.row === key ? ' is-on' : ''), label);
      b.type = 'button';
      b.onclick = function () { state.row = (state.row === key ? '' : key); render(); };
      return b;
    };
    box.appendChild(mk('', '全部'));
    KANA.ROWS.forEach(function (r) { box.appendChild(mk(r.key, r.key)); });
    box.appendChild(mk('__none', 'カナ未取得'));
  }

  function filtered() {
    return state.all.filter(function (r) {
      if (!KANA.match(r, state.q)) return false;
      if (!state.row) return true;
      var row = KANA.rowOf(r.kana);
      if (state.row === '__none') return !row;
      return row === state.row;
    });
  }

  function render() {
    renderKanaRows();
    var rows = filtered();
    rows.sort(function (a, b) { return KANA.sortKey(a).localeCompare(KANA.sortKey(b), 'ja'); });

    var box = document.getElementById('rider-list');
    clear(box);
    setCount(rows.length + '人' + (state.all.length !== rows.length ? '（全' + state.all.length + '人）' : ''));

    if (!rows.length) {
      box.appendChild(el('div', 'empty', state.all.length ? '見つかりませんでした。' : '名簿がまだ空です。セットアップ手順の「名簿の種まき」を実行してください。'));
      return;
    }

    var frag = document.createDocumentFragment();
    rows.forEach(function (r) {
      var row = el('button', 'rrow');
      row.type = 'button';
      row.dataset.reg = r.reg;
      // 一覧が持っている名前・級班・得点をそのまま渡す＝見出しが即座に出る
      row.onclick = function () { DETAIL.open(r.reg, null, r); markCurrent(r.reg); };

      var main = el('div', 'rrow-main');
      main.appendChild(el('span', 'rname', r.name || '（氏名未取得）'));
      if (r.kana) main.appendChild(el('span', 'rkana', r.kana));
      row.appendChild(main);

      var sub = el('div', 'rrow-sub');
      if (r.kyuhan) sub.appendChild(el('span', 'tag tag-kyuhan', r.kyuhan));
      if (r.pref) sub.appendChild(el('span', 'tag', r.pref));
      if (r.kyaku) sub.appendChild(el('span', 'tag', r.kyaku));
      if (r.term) sub.appendChild(el('span', 'tag', r.term + '期'));
      if (r.score) sub.appendChild(el('span', 'tag tag-score', r.score));
      if (r.origin) sub.appendChild(el('span', 'tag tag-' + originCls(r.origin), r.origin));
      row.appendChild(sub);

      var marks = el('div', 'rrow-marks');
      if (r.obsN) marks.appendChild(el('span', 'badge badge-obs', '観察' + r.obsN));
      if (r.hasMemo) marks.appendChild(el('span', 'badge badge-memo', 'メモ'));
      if (!r.hasProf) marks.appendChild(el('span', 'badge badge-wait', '公式待ち'));
      row.appendChild(marks);

      frag.appendChild(row);
    });
    box.appendChild(frag);
  }

  function originCls(o) {
    if (o === '新人') return 'new';
    if (o === '降班組') return 'down';
    return 'stay';
  }

  function markCurrent(reg) {
    var box = document.getElementById('rider-list');
    Array.prototype.forEach.call(box.querySelectorAll('.rrow'), function (n) {
      n.classList.toggle('is-current', n.dataset.reg === reg);
    });
  }

  function bind() {
    var q = document.getElementById('q');
    q.addEventListener('input', function () { state.q = q.value; render(); });

    var sel = document.getElementById('kyuhan-sel');
    sel.addEventListener('change', function () { load(sel.value, true); });
  }

  /** 名簿の1人ぶんを差し替える（詳細で保存したあと一覧のバッジを合わせる） */
  function touch(reg, patch) {
    for (var i = 0; i < state.all.length; i++) {
      if (state.all[i].reg === reg) {
        Object.assign(state.all[i], patch || {});
        break;
      }
    }
    render();
    markCurrent(reg);
  }

  return { load: load, bind: bind, render: render, touch: touch, markCurrent: markCurrent };
})();
