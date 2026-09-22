/* ===========================================================
   detail.js — 選手詳細（公式データ・役割別・観察ログ・入力）
   ===========================================================
   画面の上から順に
     ①見出し（名前・級班・得点・出自）
     ②基礎データ（keirin.jp）
     ③役割別 6区分＝自動集計の実績＋タグ＋1行メモ
     ④特徴（自由記述）と追走能力
     ⑤観察ログ（1件ずつ積む・配信OKの印）
     ⑥参考（級班履歴・出場予定・人間関係・競輪学校）
     ⑦本人コメント（内部限定・折りたたみ）
   ⚠️⑦と④は出力ビューへ出さない。出るのは①②③の数字と、⑤のうち配信OKのものだけ。
*/

var DETAIL = (function () {

  var cur = null;     // { rider, memo, obs, comments, tags }
  var ctx = null;     // 出走表から開いたときの文脈（場・日付・R・役割）
  var statsAll = null;
  var dirty = false;
  var cache = {};     // 登録番号 → 取得済みの詳細。同じ選手を開き直したら往復なしで出す
  var seq = 0;        // 連打したとき、あとから届いた古い返事で上書きしないための番号

  /** seed＝一覧や出走表が持っている名前・級班・得点。GASの返事を待たずに見出しだけ先に出す */
  function open(reg, context, seed) {
    ctx = context || null;
    dirty = false;
    var box = document.getElementById('detail');
    var my = ++seq;

    if (cache[reg]) {
      cur = cache[reg];
      if (!statsAll) API.stats().then(function (s) { statsAll = s || { riders: {} }; if (seq === my) render(); });
      render();
      return;
    }

    clear(box);
    if (seed) box.appendChild(head(Object.assign({ reg: reg }, seed), true));
    box.appendChild(el('div', 'empty', '詳細を読み込み中…'));

    Promise.all([API.rider(reg), API.stats()]).then(function (res) {
      if (seq !== my) return;          // すでに別の選手を開いている
      cur = res[0];
      cache[reg] = cur;
      statsAll = res[1] || { riders: {} };
      render();
    }).catch(function (e) {
      if (seq !== my) return;
      clear(box);
      box.appendChild(el('div', 'empty', '開けませんでした：' + e.message));
    });
  }

  function stats() {
    var reg = cur && cur.rider && cur.rider.reg;
    return (statsAll && statsAll.riders && statsAll.riders[reg]) || null;
  }

  /* ══════════ 描画 ══════════ */

  function render() {
    var box = document.getElementById('detail');
    clear(box);
    if (!cur || !cur.rider) { box.appendChild(el('div', 'empty', '選手が見つかりません。')); return; }
    var r = cur.rider;

    box.appendChild(head(r));
    box.appendChild(basics(r));
    box.appendChild(rolesSection());
    box.appendChild(featureSection());
    box.appendChild(obsSection());
    box.appendChild(refSection(r));
    box.appendChild(commentsSection());
  }

  /** skeleton=true は「読み込み中の仮の見出し」＝右側のボタン類は出さない */
  function head(r, skeleton) {
    var h = el('div', 'dt-head');
    var left = el('div', 'dt-head-l');
    var n = el('div', 'dt-name');
    n.appendChild(el('span', 'dt-name-main', r.name || '（氏名未取得）'));
    if (r.kana) n.appendChild(el('span', 'dt-name-kana', r.kana));
    left.appendChild(n);

    var tags = el('div', 'dt-tags');
    if (r.kyuhan) tags.appendChild(el('span', 'tag tag-kyuhan', r.kyuhan));
    if (r.origin) tags.appendChild(el('span', 'tag tag-' + (r.origin === '新人' ? 'new' : r.origin === '降班組' ? 'down' : 'stay'), r.origin));
    if (r.pref) tags.appendChild(el('span', 'tag', r.pref + (r.area ? '・' + r.area : '')));
    if (r.term) tags.appendChild(el('span', 'tag', r.term + '期'));
    if (r.age) tags.appendChild(el('span', 'tag', r.age + '歳'));
    if (r.kyaku) tags.appendChild(el('span', 'tag', r.kyaku));
    if (r.score) tags.appendChild(el('span', 'tag tag-score', '得点 ' + r.score));
    tags.appendChild(el('span', 'tag tag-reg', '登録 ' + r.reg));
    left.appendChild(tags);
    h.appendChild(left);
    if (skeleton) return h;

    var right = el('div', 'dt-head-r');
    var sync = el('button', 'btn btn-sm', '公式データを更新');
    sync.type = 'button';
    sync.onclick = function () {
      sync.disabled = true;
      sync.textContent = '取得中…';
      API.syncProfile(r.reg).then(function (j) {
        cur.rider = j.rider;
        toast('公式データを更新しました');
        render();
        LIST.touch(r.reg, { name: j.rider.name, kana: j.rider.kana, kyuhan: j.rider.kyuhan, score: j.rider.score, origin: j.rider.origin, hasProf: true });
      }).catch(function (e) {
        toast(e.message, true);
        sync.disabled = false;
        sync.textContent = '公式データを更新';
      });
    };
    right.appendChild(sync);
    if (r.profAt) right.appendChild(el('span', 'muted sm', String(r.profAt).indexOf('取得不可') === 0 ? r.profAt : '公式 ' + r.profAt));
    h.appendChild(right);
    return h;
  }

  function basics(r) {
    var s = section('基礎データ');
    var g = el('div', 'kv');
    var add = function (k, v) {
      if (!v && v !== 0) return;
      g.appendChild(el('span', 'kv-k', k));
      g.appendChild(el('span', 'kv-v', v));
    };
    add('ホームバンク', r.home);
    add('得意な周長', r.favLap);
    add('得意な競輪場', r.favJo);
    add('ニックネーム', r.nick);
    add('身長・体重', [r.height, r.weight].filter(Boolean).join(' / '));
    add('生年月日', r.birth);
    add('級班所属日', r.kyuhanDate);
    add('次期級班', r.nextKyuhan);
    if (!g.childNodes.length) g.appendChild(el('span', 'muted', '公式プロフィールの取得待ちです（15分おきに自動で埋まります）'));
    s.body.appendChild(g);
    return s.root;
  }

  /* ── ③役割別 ── */

  function rolesSection() {
    var s = section('役割別の動き', '自動の数字は手元のレースDBの集計。タグとメモはYの観察。');
    var st = stats();
    var grid = el('div', 'roles');
    CONFIG.ROLES.forEach(function (role) {
      grid.appendChild(roleCard(role, st));
    });
    s.body.appendChild(grid);
    s.body.appendChild(saveBar());
    return s.root;
  }

  function roleCard(role, st) {
    var card = el('div', 'role-card');
    var h = el('div', 'role-head');
    h.appendChild(el('span', 'role-label', role.label));
    var rs = st && st.roles && st.roles[role.key];
    if (rs && rs.n) h.appendChild(el('span', 'role-n', rs.n + '走'));
    card.appendChild(h);

    // 自動集計（あれば）
    if (rs && rs.n) {
      var fig = el('div', 'role-figs');
      figure(fig, '1着', pct(rs.win, rs.n));
      figure(fig, '3着内', pct(rs.top3, rs.n));
      if (role.key === 'head' && rs.detail) {
        figure(fig, '逃げ切り', pct(rs.detail.nigekiri, rs.n));
        figure(fig, '番手に差された', pct(rs.detail.sashed, rs.n));
      }
      if (role.key === 'bante' && rs.detail) {
        figure(fig, '差し切り', pct(rs.detail.sashi, rs.n));
        figure(fig, '連れ込み', pct(rs.detail.hold, rs.n));
      }
      card.appendChild(fig);
    } else {
      card.appendChild(el('div', 'role-figs muted sm', '集計データなし'));
    }

    // タグ
    var key = role.key.charAt(0).toUpperCase() + role.key.slice(1);
    var chosen = splitTags(cur.memo['tags' + key]);
    var defs = (cur.tags || []).filter(function (t) { return t.role === role.key; });
    var chips = el('div', 'chips');
    defs.forEach(function (t) {
      var b = el('button', 'chip' + (chosen.indexOf(t.tag) >= 0 ? ' is-on' : ''), t.tag);
      b.type = 'button';
      b.onclick = function () {
        var i = chosen.indexOf(t.tag);
        if (i >= 0) chosen.splice(i, 1); else chosen.push(t.tag);
        cur.memo['tags' + key] = chosen.join(',');
        b.classList.toggle('is-on');
        markDirty();
      };
      chips.appendChild(b);
    });
    if (!defs.length) chips.appendChild(el('span', 'muted sm', 'タグ未定義（スプレッドシートの「タグ定義」で足せます）'));
    card.appendChild(chips);

    // 1行メモ
    var inp = el('input', 'role-note');
    inp.type = 'text';
    inp.placeholder = role.hint;
    inp.value = cur.memo['note' + key] || '';
    inp.oninput = function () { cur.memo['note' + key] = inp.value; markDirty(); };
    card.appendChild(inp);
    return card;
  }

  function figure(box, label, val) {
    var f = el('div', 'fig');
    f.appendChild(el('span', 'fig-v', val));
    f.appendChild(el('span', 'fig-k', label));
    box.appendChild(f);
  }

  /* ── ④特徴・追走能力 ── */

  function featureSection() {
    var s = section('特徴と追走能力', '出力ビュー（配信）には出ません。');
    var wrap = el('div', 'feat');

    var fl = el('div', 'feat-follow');
    fl.appendChild(el('div', 'lbl', '追走能力'));
    var sel = el('select', 'sel');
    var opt0 = el('option', '', '—');
    opt0.value = '';
    sel.appendChild(opt0);
    CONFIG.FOLLOW_LEVELS.forEach(function (l) {
      var o = el('option', '', l.label);
      o.value = l.v;
      if (String(cur.memo.follow) === l.v) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function () { cur.memo.follow = sel.value; markDirty(); };
    fl.appendChild(sel);

    var st = stats();
    var bs = st && st.roles && st.roles.bante;
    if (bs && bs.n) fl.appendChild(el('div', 'muted sm', '参考：番手' + bs.n + '走で3着内 ' + pct(bs.top3, bs.n)));
    var note = el('input', 'inp');
    note.type = 'text';
    note.placeholder = 'そう判断した根拠（例：9/12小倉7R 番手から離れた）';
    note.value = cur.memo.followNote || '';
    note.oninput = function () { cur.memo.followNote = note.value; markDirty(); };
    fl.appendChild(note);
    wrap.appendChild(fl);

    var ft = el('div', 'feat-text');
    ft.appendChild(el('div', 'lbl', '選手特徴'));
    var ta = el('textarea', 'ta');
    ta.rows = 5;
    ta.placeholder = '事実と観察を書く。人の評価は書かない（要件§5-2）';
    ta.value = cur.memo.feature || '';
    ta.oninput = function () { cur.memo.feature = ta.value; markDirty(); };
    ft.appendChild(ta);
    wrap.appendChild(ft);

    s.body.appendChild(wrap);
    s.body.appendChild(saveBar());
    return s.root;
  }

  function saveBar() {
    var bar = el('div', 'savebar');
    var st = el('span', 'savestate');
    st.dataset.role = 'savestate';
    st.textContent = dirty ? '未保存' : '';
    var b = el('button', 'btn btn-primary btn-sm', 'メモを保存');
    b.type = 'button';
    b.onclick = saveMemo;
    bar.appendChild(st);
    bar.appendChild(b);
    return bar;
  }

  function markDirty() {
    dirty = true;
    Array.prototype.forEach.call(document.querySelectorAll('[data-role="savestate"]'), function (n) { n.textContent = '未保存'; });
  }

  function saveMemo() {
    var reg = cur.rider.reg;
    API.saveMemo(reg, cur.memo).then(function (j) {
      cur.memo = j.memo;
      dirty = false;
      Array.prototype.forEach.call(document.querySelectorAll('[data-role="savestate"]'), function (n) { n.textContent = '保存しました'; });
      toast('保存しました');
      LIST.touch(reg, { hasMemo: !!(String(cur.memo.feature || '').trim() || String(cur.memo.follow || '').trim()) });
    }).catch(function (e) { toast(e.message, true); });
  }

  /* ── ⑤観察ログ ── */

  function obsSection() {
    var s = section('観察ログ', '1件ずつ積みます。上書きしません。「配信OK」を押したものだけが出力ビューに出ます。');
    s.body.appendChild(obsForm());
    var list = el('div', 'obs-list');
    (cur.obs || []).forEach(function (o) { list.appendChild(obsRow(o)); });
    if (!cur.obs || !cur.obs.length) list.appendChild(el('div', 'muted sm', 'まだ観察はありません。'));
    s.body.appendChild(list);
    return s.root;
  }

  function obsForm() {
    var f = el('div', 'obs-form');
    var picked = [];

    var top = el('div', 'obs-form-top');
    var roleSel = el('select', 'sel');
    var o0 = el('option', '', '役割を選ぶ');
    o0.value = '';
    roleSel.appendChild(o0);
    CONFIG.ROLES.forEach(function (r) {
      var o = el('option', '', r.label);
      o.value = r.key;
      if (ctx && ctx.role === r.key) o.selected = true;
      roleSel.appendChild(o);
    });
    top.appendChild(roleSel);

    var jo = el('input', 'inp inp-sm');
    jo.type = 'text';
    jo.placeholder = '場';
    jo.value = (ctx && ctx.jo) || '';
    top.appendChild(jo);

    var rd = el('input', 'inp inp-sm');
    rd.type = 'text';
    rd.placeholder = '開催日';
    rd.value = (ctx && ctx.raceDate) || '';
    top.appendChild(rd);

    var rn = el('input', 'inp inp-xs');
    rn.type = 'number';
    rn.placeholder = 'R';
    rn.value = (ctx && ctx.raceNo) || '';
    top.appendChild(rn);
    f.appendChild(top);

    var chips = el('div', 'chips');
    function renderChips() {
      clear(chips);
      var defs = (cur.tags || []).filter(function (t) { return t.role === roleSel.value; });
      if (!roleSel.value) { chips.appendChild(el('span', 'muted sm', '役割を選ぶとタグが出ます')); return; }
      defs.forEach(function (t) {
        var b = el('button', 'chip' + (picked.indexOf(t.tag) >= 0 ? ' is-on' : ''), t.tag);
        b.type = 'button';
        b.onclick = function () {
          var i = picked.indexOf(t.tag);
          if (i >= 0) picked.splice(i, 1); else picked.push(t.tag);
          b.classList.toggle('is-on');
        };
        chips.appendChild(b);
      });
    }
    roleSel.onchange = function () { picked.length = 0; renderChips(); };
    renderChips();
    f.appendChild(chips);

    var body = el('input', 'inp');
    body.type = 'text';
    body.placeholder = '見たままを1行で（例：番手から出ないで4着）';
    f.appendChild(body);

    var bar = el('div', 'obs-form-bar');
    var pub = el('label', 'chk');
    var pubIn = el('input');
    pubIn.type = 'checkbox';
    pub.appendChild(pubIn);
    pub.appendChild(el('span', '', '配信OK（公開してよい書き方になっている）'));
    bar.appendChild(pub);

    var add = el('button', 'btn btn-primary btn-sm', '観察を追加');
    add.type = 'button';
    add.onclick = function () {
      add.disabled = true;
      API.addObs({
        reg: cur.rider.reg, role: roleSel.value, tags: picked, body: body.value,
        jo: jo.value, raceDate: rd.value, raceNo: rn.value, pub: pubIn.checked ? 1 : ''
      }).then(function (j) {
        cur.obs = j.obs;
        toast('追加しました');
        render();
        LIST.touch(cur.rider.reg, { obsN: (cur.obs || []).length });
      }).catch(function (e) {
        toast(e.message, true);
        add.disabled = false;
      });
    };
    bar.appendChild(add);
    f.appendChild(bar);
    return f;
  }

  function obsRow(o) {
    var row = el('div', 'obs' + (o.pub ? ' is-pub' : ''));
    var top = el('div', 'obs-top');
    if (o.role) top.appendChild(el('span', 'tag tag-role', roleLabel(o.role)));
    (o.tags || []).forEach(function (t) { top.appendChild(el('span', 'tag', t)); });
    var where = [o.jo, o.raceDate, o.raceNo ? o.raceNo + 'R' : ''].filter(Boolean).join(' ');
    if (where) top.appendChild(el('span', 'muted sm', where));
    row.appendChild(top);

    if (o.body) row.appendChild(el('div', 'obs-body', o.body));

    var bar = el('div', 'obs-bar');
    bar.appendChild(el('span', 'muted sm', o.at + '・' + o.by));

    var pub = el('button', 'btn btn-xs' + (o.pub ? ' is-on' : ''), o.pub ? '配信OK' : '配信OKにする');
    pub.type = 'button';
    pub.onclick = function () {
      API.patchObs(o.id, { pub: o.pub ? '' : 1 }).then(function (j) {
        cur.obs = j.obs;
        render();
      }).catch(function (e) { toast(e.message, true); });
    };
    bar.appendChild(pub);

    var del = el('button', 'btn btn-xs btn-danger', '削除');
    del.type = 'button';
    del.onclick = function () {
      if (!confirm('この観察を削除します。よろしいですか？')) return;
      API.patchObs(o.id, { deleted: 1 }).then(function (j) {
        cur.obs = j.obs;
        toast('削除しました');
        render();
        LIST.touch(cur.rider.reg, { obsN: (cur.obs || []).length });
      }).catch(function (e) { toast(e.message, true); });
    };
    bar.appendChild(del);
    row.appendChild(bar);
    return row;
  }

  /* ── ⑥参考 ── */

  function refSection(r) {
    var s = section('参考', '', true);
    var st = stats();

    if (st && st.lines && st.lines.length) {
      s.body.appendChild(el('div', 'lbl', '並び実績（よく組む相手）'));
      var lw = el('div', 'chips');
      st.lines.slice(0, 10).forEach(function (l) {
        lw.appendChild(el('span', 'tag', l.name + ' ' + l.n + '回' + (l.pos ? '（' + l.pos + '）' : '')));
      });
      s.body.appendChild(lw);
    }
    if (st && st.trouble && (st.trouble.fell || st.trouble.dq || st.trouble.absent)) {
      s.body.appendChild(el('div', 'lbl', '落車・失格・欠場'));
      s.body.appendChild(el('div', 'kv-line', '落車 ' + (st.trouble.fell || 0) + '回／失格 ' + (st.trouble.dq || 0) + '回／欠場 ' + (st.trouble.absent || 0) + '回' + (st.trouble.last ? '（直近 ' + st.trouble.last + '）' : '')));
    }

    if (r.kyuhanHist) {
      s.body.appendChild(el('div', 'lbl', '級班の履歴'));
      s.body.appendChild(pre(r.kyuhanHist));
    }
    if (r.plans) {
      s.body.appendChild(el('div', 'lbl', '出場予定'));
      s.body.appendChild(pre(r.plans));
    }
    var p = r.people || {};
    var relMap = [['master', '師匠'], ['disciples', '弟子'], ['mates', '練習仲間'], ['friends', '友人'], ['grp', '練習グループ'], ['family', '縁故']];
    var any = relMap.some(function (m) { return (p[m[0]] || []).length; });
    if (any) {
      s.body.appendChild(el('div', 'lbl', '人間関係（並び読みの材料）'));
      var rw = el('div', 'rel');
      relMap.forEach(function (m) {
        var items = p[m[0]] || [];
        if (!items.length) return;
        var line = el('div', 'rel-line');
        line.appendChild(el('span', 'rel-k', m[1]));
        items.forEach(function (it) {
          if (it.reg) {
            var b = el('button', 'linkish', it.text);
            b.type = 'button';
            b.onclick = function () { open(it.reg); };
            line.appendChild(b);
          } else {
            line.appendChild(el('span', 'rel-v', it.text));
          }
        });
        rw.appendChild(line);
      });
      s.body.appendChild(rw);
    }
    if (r.schoolRank || r.school1) {
      s.body.appendChild(el('div', 'lbl', '競輪学校'));
      s.body.appendChild(el('div', 'kv-line',
        [r.schoolExam ? '受験区分 ' + r.schoolExam : '', r.schoolRank ? '順位 ' + r.schoolRank : '',
        (r.school1 !== '' ? '1着 ' + r.school1 + '／2着 ' + r.school2 + '／3着 ' + r.school3 + '／着外 ' + r.schoolOut : '')]
          .filter(Boolean).join('・')));
    }
    if (!s.body.childNodes.length) s.body.appendChild(el('div', 'muted sm', '参考データがまだありません。'));
    return s.root;
  }

  function pre(t) {
    var p = el('div', 'pre');
    String(t).split('\n').forEach(function (line) { p.appendChild(el('div', '', line)); });
    return p;
  }

  /* ── ⑦本人コメント ── */

  /** 本人コメントは開いたときだけ取りに行く（3,430行を毎回読まない＝詳細が速くなる） */
  function commentsSection() {
    var s = section('本人のレース後コメント', '内部限定。配信・note・SNSには出さないこと。開くと読み込みます。', true);
    var reg = cur.rider.reg;
    var fill = function (list) {
      clear(s.body);
      if (!list.length) { s.body.appendChild(el('div', 'muted sm', 'コメントはありません。')); return; }
      list.forEach(function (c) {
        var row = el('div', 'cmt');
        row.appendChild(el('div', 'cmt-head', [c.date, c.jo, c.raceNo ? c.raceNo + 'R' : '', c.rank ? c.rank + '着' : '', c.kimarite].filter(Boolean).join(' ')));
        row.appendChild(el('div', 'cmt-body', c.body));
        s.body.appendChild(row);
      });
    };
    if (cur.comments) { fill(cur.comments); return s.root; }

    var loading = false;
    // section() が先に折りたたみを切り替えるので、ここに来た時点で「開いた直後」かを見る
    s.root.querySelector('.sec-head').addEventListener('click', function () {
      if (loading || cur.comments || s.root.dataset.folded === '1') return;
      loading = true;
      clear(s.body);
      s.body.appendChild(el('div', 'muted sm', '読み込み中…'));
      API.comments(reg).then(function (j) {
        cur.comments = j.comments || [];
        fill(cur.comments);
      }).catch(function (e) {
        clear(s.body);
        s.body.appendChild(el('div', 'muted sm', '読み込めませんでした：' + e.message));
        loading = false;
      });
    });
    return s.root;
  }

  /* ── 枠 ── */

  function section(title, hint, folded) {
    var root = el('section', 'sec');
    var h = el('button', 'sec-head');
    h.type = 'button';
    h.appendChild(el('span', 'sec-title', title));
    if (hint) h.appendChild(el('span', 'sec-hint', hint));
    var body = el('div', 'sec-body');
    if (folded) { root.dataset.folded = '1'; }
    h.onclick = function () { root.dataset.folded = root.dataset.folded === '1' ? '' : '1'; };
    root.appendChild(h);
    root.appendChild(body);
    return { root: root, body: body };
  }

  function splitTags(v) {
    return String(v == null ? '' : v).split(/[,、\s]+/).filter(Boolean);
  }

  return { open: open, isDirty: function () { return dirty; } };
})();
