/* ===========================================================
   today.js — 本日の出走表（要件§2-1・§4.1-2）
   ===========================================================
   選手名を押すと右の詳細へ飛ぶ。並び予想も出すので「いまこの人は何番手か」を見ながら書ける。
*/

var TODAY = (function () {

  var state = { day: '0', data: null, venue: 0, loaded: false };

  function load(force) {
    var box = document.getElementById('racecard');
    clear(box);
    box.appendChild(el('div', 'empty', '読み込み中…'));
    return API.racecard(state.day, force).then(function (j) {
      state.data = j.card || { venues: [] };
      state.venue = 0;
      state.loaded = true;
      render();
    }).catch(function (e) {
      clear(box);
      box.appendChild(el('div', 'empty', '取れませんでした：' + e.message));
    });
  }

  function render() {
    var meta = document.getElementById('card-meta');
    var d = state.data || { venues: [] };
    meta.textContent = d.venues.length ? (fmtDate(d.date) + '・' + d.venues.length + '場') : '';

    var tabs = document.getElementById('venue-tabs');
    clear(tabs);
    d.venues.forEach(function (v, i) {
      var b = el('button', 'vtab' + (i === state.venue ? ' is-on' : ''));
      b.type = 'button';
      b.appendChild(el('span', 'vtab-name', v.name));
      if (v.grade) b.appendChild(el('span', 'vtab-grade', v.grade));
      b.onclick = function () { state.venue = i; render(); };
      tabs.appendChild(b);
    });

    var box = document.getElementById('racecard');
    clear(box);
    var v = d.venues[state.venue];
    if (!v) {
      box.appendChild(el('div', 'empty', '開催がありません。'));
      return;
    }

    var frag = document.createDocumentFragment();
    v.races.forEach(function (r) { frag.appendChild(raceBlock(v, r)); });
    box.appendChild(frag);
  }

  function raceBlock(v, r) {
    var wrap = el('div', 'race');

    var head = el('div', 'race-head');
    head.appendChild(el('span', 'race-no', r.no + 'R'));
    if (r.start) head.appendChild(el('span', 'race-time', r.start));
    if (r.cls) head.appendChild(el('span', 'race-cls', r.cls));
    if (r.lineType) head.appendChild(el('span', 'race-line', r.lineType));
    wrap.appendChild(head);

    var lines = r.lines || [];
    if (lines.length) {
      var nb = el('div', 'narabi');
      nb.appendChild(el('span', 'narabi-label', '並び'));
      lines.forEach(function (line, li) {
        if (li) nb.appendChild(el('span', 'narabi-sep', '／'));
        line.forEach(function (pos) {
          if (pos.length < 2) { nb.appendChild(carChip(pos[0])); return; }
          // 競り＝縦に積む。上が競りに行く側（9/23 Naoto指定）
          var stack = el('span', 'narabi-seri');
          stack.title = '競り';
          pos.forEach(function (c) { stack.appendChild(carChip(c)); });
          nb.appendChild(stack);
        });
      });
      wrap.appendChild(nb);
    }

    var roleMap = rolesFromLines(lines);
    var tbl = el('div', 'racers');
    r.racers.forEach(function (s) {
      var row = el('button', 'racer');
      row.type = 'button';
      row.disabled = !s.reg;
      row.onclick = function () {
        if (!s.reg) return;
        DETAIL.open(s.reg, { jo: v.name, raceDate: (state.data || {}).date, raceNo: r.no, role: roleMap[s.no] || '' }, s);
      };
      row.appendChild(carChip(s.no));
      var nm = el('div', 'racer-name');
      nm.appendChild(el('span', 'racer-name-main', s.name || ''));
      var sub = el('span', 'racer-sub', [s.pref, s.term ? s.term + '期' : '', s.age ? s.age + '歳' : ''].filter(Boolean).join(' '));
      nm.appendChild(sub);
      row.appendChild(nm);
      row.appendChild(el('span', 'racer-kyuhan', s.kyuhan || ''));
      row.appendChild(el('span', 'racer-kyaku', s.kyaku || ''));
      row.appendChild(el('span', 'racer-score', s.score || ''));
      if (roleMap[s.no]) row.appendChild(el('span', 'racer-role', roleLabel(roleMap[s.no])));
      tbl.appendChild(row);
    });
    wrap.appendChild(tbl);
    return wrap;
  }

  /** 構造化された並びから 車番→役割 を作る。
      同じ位置に2人以上いる＝競りなので、その全員を「競り」にする。
      ⚠️これは「予想並び」なので当日の実際とは違うことがある。入力時の初期値にだけ使う。 */
  function rolesFromLines(lines) {
    var map = {};
    (lines || []).forEach(function (line) {
      var isSolo = line.length === 1 && line[0].length === 1;
      line.forEach(function (pos, i) {
        if (pos.length > 1) { pos.forEach(function (c) { map[c] = 'seri'; }); return; }
        var car = pos[0];
        if (isSolo) { map[car] = 'solo'; return; }
        map[car] = i === 0 ? 'head' : (i === 1 ? 'bante' : (i === 2 ? 'third' : 'fourth'));
      });
    });
    return map;
  }

  function fmtDate(s) {
    var t = String(s || '');
    if (!/^\d{8}$/.test(t)) return t;
    return (+t.slice(4, 6)) + '/' + (+t.slice(6, 8));
  }

  function bind() {
    document.getElementById('day-sel').addEventListener('change', function (e) {
      state.day = e.target.value;
      load(false);
    });
    document.getElementById('card-reload').addEventListener('click', function () { load(true); });
  }

  return {
    bind: bind,
    load: load,
    ensure: function () { if (!state.loaded) load(false); }
  };
})();
