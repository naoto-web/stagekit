/* ===========================================================
   list.js — 選手一覧（あいうえお検索・しぼりこみ）
   =========================================================== */

var LIST = (function () {

  /* 🔑既定は**すべての級班**（2026-09-23 Naoto）。名簿はもともと全級班を1回で取って
     画面側で絞るだけなので（load の `API.roster('all')`）、**読み込みの往復は増えない**。
     増えるのは描く行数だけ（A3 494人 → 全1,010人）。
     ⚠️`index.html` の仮の選択肢（実データが来るまでの1つ）も all にそろえる＝
        main.js の初回 load はそのセレクトの値を読むので、片方だけ直すと既定が食い違う。 */
  var state = { all: [], row: '', q: '', kyuhan: 'all', loaded: false };

  /* 級班の並び順（上が強い）。ここに無い値は最後にまとめて出す */
  var KYUHAN_ORDER = ['SS', 'S1', 'S2', 'A1', 'A2', 'A3', 'L1'];
  var KYUHAN_LABEL = {
    SS: 'S級S班', S1: 'S級1班', S2: 'S級2班',
    A1: 'A級1班', A2: 'A級2班', A3: 'A級3班',
    L1: 'L級1班（ガールズ）'
  };

  /** 名簿は全級班を1回だけ取り、しぼりこみは画面側でやる。
      🔑級班を変えるたびにGASを往復すると毎回1.5秒待たされる（9/23 Naoto指摘で細分化したため
        切り替え回数が増える）。837人＝109KBなので、1回取ってしまうほうが速い。 */
  function load(kyuhan, force) {
    if (kyuhan) state.kyuhan = kyuhan;
    if (state.loaded && !force) { render(); return Promise.resolve(state.all); }
    setCount('読み込み中…');
    return API.roster('all').then(function (j) {
      state.all = j.riders || [];
      state.loaded = true;
      renderKyuhanOptions();
      render();
      return state.all;
    }).catch(function (e) {
      setCount('読み込めませんでした：' + e.message);
      throw e;
    });
  }

  /** しぼりこみの選択肢を実データから作る（人数つき）。使われていない級班は出さない */
  function renderKyuhanOptions() {
    var sel = document.getElementById('kyuhan-sel');
    if (!sel) return;
    var count = {};
    state.all.forEach(function (r) {
      var k = String(r.kyuhan || '').trim() || '（級班なし）';
      count[k] = (count[k] || 0) + 1;
    });
    var keys = Object.keys(count).sort(function (a, b) {
      var ia = KYUHAN_ORDER.indexOf(a), ib = KYUHAN_ORDER.indexOf(b);
      if (ia < 0) ia = 99;
      if (ib < 0) ib = 99;
      return ia !== ib ? ia - ib : a.localeCompare(b, 'ja');
    });

    clear(sel);
    keys.forEach(function (k) {
      var o = el('option', '', (KYUHAN_LABEL[k] || k) + '（' + count[k] + '人）');
      o.value = k;
      sel.appendChild(o);
    });
    var all = el('option', '', 'すべての級班（' + state.all.length + '人）');
    all.value = 'all';
    sel.appendChild(all);

    // 選ばれていた級班が無くなっていたら全部に落とす
    if (state.kyuhan !== 'all' && keys.indexOf(state.kyuhan) < 0) state.kyuhan = 'all';
    sel.value = state.kyuhan;
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
      if (state.kyuhan !== 'all' && String(r.kyuhan || '').trim() !== state.kyuhan) return false;
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
    var label = state.kyuhan === 'all' ? '' : (KYUHAN_LABEL[state.kyuhan] || state.kyuhan) + ' ';
    setCount(label + rows.length + '人' + (state.all.length !== rows.length ? '／名簿全体 ' + state.all.length + '人' : ''));

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
      // 出走表側にも同じ印を付ける＝タブを行き来しても「いま誰を見ているか」が変わらない（9/23 Naoto）
      row.onclick = function () {
        DETAIL.open(r.reg, null, r);
        markCurrent(r.reg);
        if (window.TODAY) TODAY.markCurrent(r.reg);
      };

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

    // 取り直しは不要＝その場で絞るだけ
    var sel = document.getElementById('kyuhan-sel');
    sel.addEventListener('change', function () { state.kyuhan = sel.value; state.row = ''; render(); });
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
