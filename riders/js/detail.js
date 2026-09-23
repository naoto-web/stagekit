/* ===========================================================
   detail.js — 選手詳細（公式データ・役割別・観察ログ・入力）
   ===========================================================
   画面の上から順に
     ①見出し（名前・級班・得点・出自）
     ②基礎データ（keirin.jp）
     ③選手特徴（自由記述）＝いちばん大事な手書きなので上に置く（9/23 Naoto指定）
     ④役割別 6区分＝自動集計の実績＋タグ＋メモ
     ⑤追走能力
     ⑥観察ログ（1件ずつ積む・配信OKの印）
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
  var editing = {};   // メモ欄ごとに「いま書いているか」。既定は読むだけ（下の noteField）
  // 自動保存。🔑「完了」を押した＝保存された、と読めてしまうので、実際に保存する作りにした
  //   （9/23 Naoto指摘）。打っている間も1.2秒止まれば勝手に保存する。
  var saveTimer = null, changeSeq = 0, saveSeq = 0;
  // いま開いている役割。出走表から開いたときは、その日その人が回る役割を最初から開く
  // （9/23 Naoto「この人が今日番手走るから番手の情報見よう、となる」）
  var openRole = null;
  // 表の左端の列幅。着順の表（本体・戦法別・種別）とライン決着で共通にして列をそろえる
  var LABEL_W = '96px';
  /* 着順の表（本体・戦法別・種別）の 1着〜9着 の列幅。🔴**固定幅**（`minmax(52px, auto)` にしない）。
     2026-09-23 Naoto「1着〜9着の位置が着順・戦法別・種別でずれている」＝実測で2つの原因が重なっていた：
       ①種別だけ 44px＋隙間12px の別の型だった（9着で99pxずれ）
       ②`auto` だと**中身の広いマスがその列だけ押し広げる**＝「うち番手に差され」のある表だけ2着が61pxになり、
         同じ型のはずの二分戦（52px）と3着から9pxずれていた
     ⇒ 4つの表の列の型を**この1か所**から出す（`rankCols`）。中身が広くなっても列は動かない（はみ出す側が折り返す）。
     ⚠️幅を変えるときは 1370px のPCで入るか見る＝96＋52×9＋隙間14×9＝690px がいまの上限ぎりぎり。 */
  var RANK_COL = '52px';
  function rankCols(nCol) { return LABEL_W + ' repeat(' + nCol + ', ' + RANK_COL + ')'; }

  /** seed＝一覧や出走表が持っている名前・級班・得点。GASの返事を待たずに見出しだけ先に出す */
  function open(reg, context, seed) {
    flush();            // 前の選手の書きかけを先に保存する
    // スマホは1カラム＝「さがす」画面から「選手」画面へ移る（§35）。PCでは data-m が付くだけで見た目は変わらない
    if (window.MOBILE) MOBILE.toDetail();
    ctx = context || null;
    dirty = false;
    editing = {};
    openRole = (ctx && ctx.role) || null;
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

  /** スマホでは枠を既定で閉じる（§35）。開いたままにするのは**役割別の動き**と**観察ログ**だけ
      ＝Yの用途が「見る＋書く」なので、この2つが最初から見えていれば指を動かさずに済む。
      🔑呼び出し側で明示的に渡す＝`section()` の中でタイトルの文字列から判断すると、
        タイトルを変えた日に黙って全部開く（文字列一致は静かに壊れる）。
      ⚠️PCの見え方は変えない＝広い画面では今までどおり全部開いている。 */
  function mFold() { return narrow(); }

  /** スマホ（1カラム）か＝§35。**表の形**と**折りたたみの既定**がこれで変わる。 */
  function narrow() { return !!(window.MOBILE && MOBILE.isNarrow()); }

  /** 集計期間の一言（例「数字は直近4ヶ月（2026/05/22〜2026/09/22）を数えたものです。」）。
      🔑期間は stats.json 側が持つ＝`build_stats.js` の `WINDOW_MONTHS` を変えれば文言も追いつく。
      古い stats.json（期間を持たない版）が配られても落ちないよう、無ければ何も出さない。 */
  function windowText() {
    var w = statsAll && statsAll.window;
    if (!w || !w.months) return '';
    return '数字は直近' + w.months + 'ヶ月（' + w.from + '〜' + w.to + '）を数えたものです。';
  }

  /* ══════════ 描画 ══════════ */

  function render() {
    var box = document.getElementById('detail');
    clear(box);
    if (!cur || !cur.rider) { box.appendChild(el('div', 'empty', '選手が見つかりません。')); return; }
    var r = cur.rider;

    box.appendChild(head(r));
    box.appendChild(basics(r));
    box.appendChild(featureSection());
    box.appendChild(rolesSection());
    // ※レース種別は独立した枠をやめ、役割別の中（戦法別の下・ライン決着の上）へ入れた
    //   （2026-09-23 Naoto「役割別の中に入れ込んでください」→ 同日「ライン決着の上に」）
    box.appendChild(sSection());
    box.appendChild(followSection());
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
    var s = section('基礎データ', '', mFold());
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

  /** 役割は6つ全部を並べず、ボタンで選んだ1つだけ開く（9/23 Naoto指定）。
      使い方が「今日この人は番手だから番手を見る」なので、全部出すと目的の1つを探すことになる。
      ボタンには走数を出し、メモがある役割には印（右上の点）を付ける。 */
  function rolesSection() {
    // 🔑「いつからいつまでを数えた数字か」を必ず出す（9/23 Naoto指示で全期間→直近4ヶ月に変更）。
    //   期間は stats.json が持っているので、集計側で期間を変えれば画面の文言も自動で追いつく
    var s = section('役割別の動き', '見たい役割を押すと、その役割の成績とメモが出ます。' + windowText());
    var tabs = el('div', 'role-tabs');
    var panel = el('div', 'role-panel');
    s.body.appendChild(tabs);
    s.body.appendChild(panel);
    s.body.appendChild(saveBar());
    paint();
    return s.root;

    function paint() {
      var st = stats();
      clear(tabs);
      CONFIG.ROLES.forEach(function (role) {
        var rs = st && st.roles && st.roles[role.key];
        var hasNote = !!String(cur.memo['note' + capKey(role.key)] || '').trim();
        var b = el('button', 'role-tab' + (openRole === role.key ? ' is-on' : '') + (hasNote ? ' has-note' : ''));
        b.type = 'button';
        b.title = role.hint + (hasNote ? '（メモあり）' : '');
        b.appendChild(el('span', 'role-tab-label', role.label));
        b.appendChild(el('span', 'role-tab-n', rs && rs.n ? rs.n + '走' : '記録なし'));
        b.onclick = function () {
          openRole = (openRole === role.key) ? null : role.key;
          paint();
        };
        tabs.appendChild(b);
      });

      clear(panel);
      if (!openRole) {
        panel.appendChild(el('div', 'muted sm', '上のボタンを押すと、その役割の成績とメモが出ます。点が付いている役割にはメモがあります。'));
        return;
      }
      var role = null;
      CONFIG.ROLES.forEach(function (r) { if (r.key === openRole) role = r; });
      if (role) panel.appendChild(rolePanel(role, st));
    }
  }

  function capKey(k) { return k.charAt(0).toUpperCase() + k.slice(1); }

  function rolePanel(role, st) {
    var card = el('div', 'role-body');
    var rs = st && st.roles && st.roles[role.key];

    var h = el('div', 'role-head');
    h.appendChild(el('span', 'role-label', role.label));
    h.appendChild(el('span', 'role-hint', role.hint));
    card.appendChild(h);

    if (rs && rs.n) {
      var fig = el('div', 'role-figs');
      // ①着順の段＝どの役割でも同じ
      figure(fig, '1着', pct(rs.win, rs.n));
      figure(fig, '2着内', pct(rs.top2, rs.n));
      figure(fig, '3着内', pct(rs.top3, rs.n));
      figure(fig, '4着内', pct(rs.top4, rs.n));
      figure(fig, '走数', rs.n + '走');
      card.appendChild(fig);

      // ②着順の段＝1着〜9着の回数。決まり手の内訳はその着順の下にぶら下げる（9/23 Naoto指定）
      // 🔑スマホは横に9列取れないので、**本体と戦法別を1つの縦表にまとめる**（§35-4 案A）
      if (narrow()) {
        card.appendChild(rankTableV(rs, role.key));
      } else {
        card.appendChild(rankTable(rs, role.key));
        card.appendChild(splitRanks(rs, role.key));
      }
      /* 並び順＝着順 → 戦法別 → レース種別 → **グレード** → ライン決着
         （2026-09-23 Naoto「レース種別をライン決着の上に」／2026-09-24「レース種別の下にグレード」）。
         🔑1着〜9着の表（着順・戦法別・種別・グレード）を続けて置く
            ＝列が同じ位置なので上から下へ縦に見比べられる。
            ライン決着だけ列の意味が違う（車数）ので、いちばん下に離す。PCもスマホも同じ順 */
      card.appendChild(typeRanks(rs, role.key));
      card.appendChild(gradeRanks(rs, role.key));
      card.appendChild(lineRow(role.key));
    } else {
      card.appendChild(el('div', 'muted sm', 'この役割で走った記録がまだありません。'));
    }

    // 🔑先頭だけメモを3つに分ける（9/23 Naoto指定）＝先行は戦法で全く別の走りになるため。
    //   ほかの役割はこれまでどおり1つ。
    if (role.key === 'head') {
      [
        { f: 'noteHead2', t: '二分戦の場合' },
        { f: 'noteHead3', t: '三分戦以上の場合' },
        { f: 'noteHeadSolo', t: '先行一車の場合' }
      ].forEach(function (x) {
        card.appendChild(el('div', 'lbl', x.t));
        card.appendChild(noteField(x.f, x.t + 'の動きを書く', true));
      });
    } else {
      card.appendChild(noteField('note' + capKey(role.key), role.label + 'のときの動きを書く', true));
    }
    return card;
  }

  /* ── メモ欄＝ふだんは全文を読むだけ。「編集」を押したその場で書ける ──
     🔑1行の入力欄だと長い文の後ろが見えなくなる（9/22 Naoto指摘）。
       読む回数のほうが多いので、既定を「読む」にして、書くときだけ開く。
       書くときは高さが中身に合わせて伸びるので、ここでも文字が隠れない。 */
  function noteField(field, placeholder, big) {
    var wrap = el('div', 'note-field');
    paint();
    return wrap;

    function paint() {
      clear(wrap);
      var val = String(cur.memo[field] || '');

      if (!editing[field]) {
        wrap.appendChild(el('div', 'note-view' + (big ? ' is-big' : '') + (val ? '' : ' is-empty'), val || placeholder));
        var b = el('button', 'note-edit', val ? '編集' : '書く');
        b.type = 'button';
        b.onclick = function () { editing[field] = true; paint(); };
        wrap.appendChild(b);
        return;
      }

      var ta = el('textarea', 'note-input' + (big ? ' is-big' : ''));
      ta.rows = 1;
      ta.placeholder = placeholder;
      ta.value = val;
      ta.oninput = function () { cur.memo[field] = ta.value; grow(ta); markDirty(); };
      // Escで読むモードへ戻す（打ち間違えて開いたときのため）
      ta.onkeydown = function (e) { if (e.key === 'Escape') { editing[field] = false; paint(); } };
      wrap.appendChild(ta);

      var done = el('button', 'note-edit is-done', '保存して閉じる');
      done.type = 'button';
      done.onclick = function () { editing[field] = false; paint(); saveMemo(false); };
      wrap.appendChild(done);

      grow(ta);
      setTimeout(function () { grow(ta); }, 0);   // まだ画面に載っていないときの保険
      ta.focus();
      try { ta.setSelectionRange(val.length, val.length); } catch (e) {}
    }
  }

  /** 中身の高さに合わせて伸ばす（縦スクロールを出さない） */
  function grow(ta) {
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight + 2) + 'px';
  }

  /* ── 開催日の3つの形（2026-09-23 Naoto）──────────────────────
     保存＝`20260923`（今までどおり・GASもスプレッドシートも触らない）
     入力＝`2026-09-23`（`input type="date"` の決まり。これ以外の形は**黙って空欄になる**）
     表示＝`2026/9/23`（Naoto指定。`20260923` は読めない）
     ⚠️どれか1つでも通し忘れると、入力欄が空で開くか、保存が消える。変換はこの3つの関数だけを通す。 */

  /** `20260923` / `2026/09/23` → `2026-09-23`（input type=date が受け取れる形） */
  function toDateInput(s) {
    var m = /^(\d{4})[-\/]?(\d{2})[-\/]?(\d{2})$/.exec(String(s || '').trim());
    return m ? (m[1] + '-' + m[2] + '-' + m[3]) : '';
  }

  /** `2026-09-23` → `20260923`（保存する形）。空欄はそのまま空欄 */
  function fromDateInput(s) {
    return String(s || '').replace(/-/g, '');
  }

  /** `20260923` / `2026-09-23` → `2026/9/23`（画面に出す形）。
      ⚠️読めない値はそのまま返す＝手入力時代の値が消えない */
  function fmtObsDate(s) {
    var m = /^(\d{4})[-\/]?(\d{2})[-\/]?(\d{2})$/.exec(String(s || '').trim());
    return m ? (m[1] + '/' + (+m[2]) + '/' + (+m[3])) : String(s || '');
  }

  /** 戦法別（二分戦／三分戦以上）。
      🔑A級3班の全体で見ると番手は二分戦52.7%・三分戦以上38.3%（差14.4pt）＝効く軸。
      🔑2026-09-23：本体と同じ「着順の表」で出す（Naoto「上の記載方法に合わせて」）。
      ⚠️2026-09-23（第2版）Naoto「走数が少ない、的な注意書きは全部消して」＝
         **走数による薄字も注意文も出さない**。走数は表の左上に必ず出ているので、
         母数は読み手が見て判断できる。薄字に残したのは「記録が0のマス」だけ。 */
  function splitRanks(rs, roleKey) {
    var sp = rs.sp || {};
    var defs = [{ k: '2', label: '二分戦' }, { k: '3', label: '三分戦以上' }];
    if (!defs.some(function (d) { return sp[d.k] && sp[d.k].n; })) return el('div', '');

    var today = (ctx && ctx.bunsen) || '';
    var wrap = el('div', '');
    wrap.appendChild(el('div', 'lbl', '戦法別'));
    defs.forEach(function (d) {
      var b = sp[d.k];
      if (!(b && b.n)) return;
      wrap.appendChild(rankTable(b, roleKey, {
        label: d.label,
        showN: true,
        // 今日の戦法には印を付けて太字にする（種別の「◀ 今日」と同じ考え方）
        cur: d.k === today
      }));
    });
    // ※「走数が少ないので目安です」は廃止（2026-09-23 Naoto「注意書きは全部消して」）。
    //   走数は表の左上に必ず出ているので、母数は見れば分かる
    return wrap;
  }

  /** 着順ごとの回数の表（2026-09-23 Naoto指定）。
      🔑上の段が「率」なので、ここは**回数だけ**にして実数で見られるようにする。
         率だけだと「3.7%」が27走中1回なのか分からない。
      🔑決まり手の内訳は**その着順の真下**に置く＝「1着12回のうち逃7・捲4」が縦に読める。
         内訳はどれも着順が決まっている（逃/捲＝1着、番手に差されて2着＝2着、ズブズブ＝3着。
         番手なら 差し1着＝1着、差し2着/マーク＝2着、ハコ3＝3着）。
      ⚠️9着まで固定で出す＝7車立てでは8・9着が常に0になるが、列がずれないほうが読みやすい。
         0は薄く（出走表の数字と同じ扱い）。 */
  /** opts＝{ label, showN, thin, cur }
      🔑2026-09-23（第2版）：**戦法別も同じ表で出す**（Naoto「上の記載方法に合わせて」）。
         左上のマスを『着順』から『二分戦 12走』のように差し替えるだけで、
         列（1着〜9着）は本体とまったく同じ＝上下に並べると縦に見比べられる。
         走数を列に足さずラベルへ入れたのは、この「列を揃える」ためだけの理由。 */
  function rankTable(rs, roleKey, opts) {
    opts = opts || {};
    var ranks = rs.ranks || [];
    if (!ranks.length) return el('div', '');
    var sub = rankSubs(roleKey, rs.detail || {});
    var hasOther = (ranks[9] || 0) > 0;
    var nCol = 9 + (hasOther ? 1 : 0);

    var box = el('div', 'split rank');
    // 列の型は種別の表と同じ1か所（rankCols）から＝縦に並べたとき、1着・2着…の列がぴたり重なる
    box.style.gridTemplateColumns = rankCols(nCol);

    var lab = el('div', 'split-label' + (opts.cur ? ' is-cur' : '') + (opts.label ? ' is-strong' : ''),
      (opts.label || '着順') + (opts.cur ? ' ◀ 今日' : ''));
    if (opts.showN) lab.appendChild(el('span', 'split-n', rs.n + '走'));
    box.appendChild(lab);
    for (var i = 0; i < 9; i++) box.appendChild(el('div', 'split-h', (i + 1) + '着'));
    if (hasOther) box.appendChild(el('div', 'split-h', '他'));

    box.appendChild(el('div', 'split-k', '回数'));
    for (var k = 0; k < 9; k++) {
      var v = ranks[k] || 0;
      box.appendChild(el('div', 'split-v' + (v ? '' : ' is-thin'), v ? v + '回' : '—'));
    }
    if (hasOther) box.appendChild(el('div', 'split-v', ranks[9] + '回'));

    if (sub.some(function (x) { return x && x.length; })) {
      box.appendChild(el('div', 'split-k', '内訳'));
      for (var m = 0; m < 9; m++) {
        var cell = el('div', 'rank-sub');
        (sub[m] || []).forEach(function (x) {
          var line = el('div', 'rank-sub-i' + (x.v ? '' : ' is-thin') + (x.sub ? ' is-note' : ''));
          // 🔑列は52px固定（RANK_COL）＝長い注記は短い形で出し、全文はホバーの説明に残す（スマホと同じ扱い）
          line.appendChild(el('span', 'rank-sub-k', x.short || x.label));
          if (x.short) line.title = x.label + ' ' + x.v + '回';
          line.appendChild(el('span', 'rank-sub-v', x.v + '回'));
          cell.appendChild(line);
        });
        box.appendChild(cell);
      }
      if (hasOther) box.appendChild(el('div', 'rank-sub'));
    }
    return box;
  }

  /** 【スマホ】着順の表を**縦**にする（§35-4 案A・2026-09-23）。
      PCは「横＝1着〜9着／縦＝全体・二分戦・三分戦以上」で表を3つ縦に並べる。
      スマホは横に9列も取れないので **90度回して1つの表にまとめる**（縦＝着順／横＝戦法）。
      🔑読み方は変わらない＝PCで覚えた「回数で見る・母数は走数で見る」がそのまま効く。
      🔑**情報は1つも減らさない**（決まり手の内訳も走数も出す）＝
         「4着以下をまとめる」案は**負け方が隠れる**ので採らなかった（検討メモ§4.1）。
      ⚠️列幅は `minmax(0,1fr)` の均等割＝端末の幅に合わせて縮む。
         固定pxにすると、いちばん狭い360pxで溢れる。 */
  function rankTableV(rs, roleKey) {
    var ranks = rs.ranks || [];
    if (!ranks.length) return el('div', '');
    var sp = rs.sp || {};
    var today = (ctx && ctx.bunsen) || '';

    var cols = [{ k: '', label: '全体', d: rs }];
    [['2', '二分戦'], ['3', '三分戦以上']].forEach(function (p) {
      var d = sp[p[0]];
      if (d && d.n) cols.push({ k: p[0], label: p[1], d: d });
    });

    /* 出す着順＝どこかの列に記録がある最大着順まで。
       ⚠️PCは9着まで固定（列がそろうほうが読みやすい）だが、縦型で9行固定にすると
         7車立てでは常に空の行が2つ増えて縦に伸びるだけになる。 */
    var maxRank = 0;
    cols.forEach(function (c) {
      (c.d.ranks || []).forEach(function (v, i) { if (v && i < 9) maxRank = Math.max(maxRank, i + 1); });
    });
    if (maxRank < 3) maxRank = 3;
    var hasOther = cols.some(function (c) { return ((c.d.ranks || [])[9] || 0) > 0; });

    var tmpl = 'repeat(' + cols.length + ', minmax(0, 1fr))';
    var box = el('div', 'split rank rank-v');
    box.style.gridTemplateColumns = '46px ' + tmpl;

    box.appendChild(el('div', 'split-label is-strong', '着順'));
    cols.forEach(function (c) {
      var on = !!(c.k && c.k === today);
      box.appendChild(el('div', 'split-h' + (on ? ' is-strong is-cur' : ''), c.label + (on ? ' ◀ 今日' : '')));
    });

    var subs = cols.map(function (c) { return rankSubs(roleKey, c.d.detail || {}); });

    for (var i = 0; i < maxRank; i++) {
      box.appendChild(el('div', 'split-k', (i + 1) + '着'));
      cols.forEach(function (c) { box.appendChild(rankCellV(c, today, (c.d.ranks || [])[i] || 0)); });
      // 決まり手の内訳＝その着順の**すぐ下**に、列の並びをそろえて小さく出す（PCと同じ考え方）
      if (subs.some(function (s) { return s[i] && s[i].length; })) {
        var sub = el('div', 'rank-v-sub');
        sub.style.gridTemplateColumns = tmpl;
        cols.forEach(function (c, ci) {
          var cell = el('div', '');
          (subs[ci][i] || []).forEach(function (x) {
            // ⚠️「うち番手に差され」は縦型では長すぎる＝短くして、全文はホバーの説明に残す
            var sp2 = el('span', 'rank-v-i' + (x.sub ? ' is-note' : ''), (x.sub ? '差され' : x.label) + x.v);
            if (x.sub) sp2.title = 'うち番手に差され ' + x.v + '回';
            cell.appendChild(sp2);
          });
          sub.appendChild(cell);
        });
        box.appendChild(sub);
      }
    }
    if (hasOther) {
      box.appendChild(el('div', 'split-k', '他'));
      cols.forEach(function (c) { box.appendChild(rankCellV(c, today, (c.d.ranks || [])[9] || 0)); });
    }
    box.appendChild(el('div', 'split-k is-strong', '走数'));
    cols.forEach(function (c) {
      box.appendChild(el('div', 'split-v' + cellOffV(c, today), c.d.n + '走'));
    });
    return box;
  }

  function rankCellV(c, today, v) {
    return el('div', 'split-v' + cellOffV(c, today) + (v ? '' : ' is-thin'), v ? v + '回' : '—');
  }

  /** 今日の戦法でない列は落とす（§33の決まり）。
      ⚠️「全体」列（k が空）はいつも見る列なので落とさない＝ライン決着の「全体」行と同じ扱い。 */
  function cellOffV(c, today) {
    return (today && c.k && c.k !== today) ? ' is-off' : '';
  }

  /** 着順（1〜9着）ごとにぶら下げる内訳。配列の添字＝着順−1。
      🔑2026-09-23（第2版・Naoto指摘）：**役割で項目を決め打ちしない**。
         1着・2着とも「逃・捲・差・マ」のうち**実際に出たものだけ**を並べる。
         🔴以前は先頭＝1着は逃・捲だけ／番手＝1着は差だけ、と決め打ちしていたので、
            **先頭で差して1着（全体の9.8%）・番手で捲って1着が画面から消えていた**。
            登録014578は先頭で1着2回とも「差」で、内訳が全部0に見えていた。
         決まり手は排他なので **合計＝その着順の回数**＝上の段と足し算が合う（検算できる）。
      ⚠️ここを変えたら build_stats.js の `addRun` も揃える（数える側と出す側は必ず対で直す）。 */
  var KIM = [['nige', '逃'], ['makuri', '捲'], ['sashi', '差'], ['mark', 'マ']];

  function rankSubs(roleKey, d) {
    var s = [];
    // 1着・2着＝決まり手のうち**実際に出たものだけ**。合計＝その着順の回数になる
    [1, 2].forEach(function (rank) {
      var arr = [];
      KIM.forEach(function (k) {
        var v = d[k[0] + rank] || 0;
        if (v) arr.push({ label: k[1], v: v });
      });
      // 「うち番手に差され」は決まり手と**別の軸**で重なるので、点線の下に内数として添える。
      // ⚠️全文（8文字）は 52px の列に入らず**その列だけ61pxに広がって隣の表と列がずれた**（2026-09-23 Naoto指摘）
      //    ⇒ PCは `short`（説明書の用語表と同じ「番手に差され」）で出す。スマホは「差され」（rankTableV）
      if (rank === 2 && roleKey === 'head' && d.sashed2) {
        arr.push({ label: 'うち番手に差され', short: '番手に差され', v: d.sashed2, sub: true });
      }
      if (arr.length) s[rank - 1] = arr;
    });
    // 3着の下＝先頭はズブズブ・番手はハコ3（どちらもめったに出ないので、出たときだけ）
    var third = [];
    if (roleKey === 'head' && d.zubu) third.push({ label: 'ズブズブ', v: d.zubu });
    if (roleKey === 'bante' && d.hako3) third.push({ label: 'ハコ3', v: d.hako3 });
    if (third.length) s[2] = third;
    return s;
  }

  /* ※旧 detailCols（戦法別を横1行の「率／回数」で出すための列定義）は廃止。
        2026-09-23に戦法別も rankTable（着順の表＋内訳）へ寄せたので、
        内訳の定義は rankSubs 1か所だけになった。 */

  /** ライン決着（先頭・番手・3番手）。**自分のラインの車数ごとに条件が変わる**ので分けて出す。
      2車＝1,2着が自分のライン／3車以上＝1〜3着が自分のライン（2026-09-23 Naoto定義）。
      ⚠️戦法別（二分戦・三分戦）とは別の軸なので、あちらの表には入れない。 */
  function lineRow(roleKey) {
    var st = stats();
    var lk = st && st.lineK && st.lineK[roleKey];
    if (!lk) return el('div', '');
    // 🔑横＝自分のラインの車数、縦＝戦法（9/23 Naoto指定で縦横を入れ替え）。
    //   車数は「その選手が実際に組んだ車数」だけ列に出す＝空の列を作らない。
    var cols = [{ k: '2', label: '2車ライン' }, { k: '3', label: '3車ライン' }, { k: '4', label: '4車以上' }]
      .filter(function (df) { return lk[df.k] && lk[df.k].n; });
    if (!cols.length) return el('div', '');

    // 🔑率でなく回数で出す（9/23 Naoto指定）。ただし**分母が列ごとに違う**ので走数を必ず添える。
    //   「3回」だけだと18走中なのか3走中なのか分からず、着順の表と違って上の段にも母数が無い。
    var rows = [
      { k: '', label: '全体', get: function (c) { return c; } },
      { k: '2', label: '二分戦', get: function (c) { return (c.sp || {})['2']; } },
      { k: '3', label: '三分戦以上', get: function (c) { return (c.sp || {})['3']; } }
    ];
    /* 🔑太字＝今日の並びに当たる列と行（2026-09-23 Naoto
       「ライン決着・全体は太字。今回3車ラインの二分戦なので、その文字も太字に」）。
       今日の車数・戦法は出走表から開いたときだけ分かる（ctx）。
       ⚠️太字は「走数が少ない＝薄字」より強くする＝今日の欄が薄いと目で探せなくなるため。 */
    var todaySize = (ctx && ctx.lineSize) ? String(ctx.lineSize >= 4 ? 4 : ctx.lineSize) : '';
    var todayBun = (ctx && ctx.bunsen) || '';

    var box = el('div', 'split');
    /* ⚠️スマホはPCの寸法（96px＋96px×3＝約400px）では入らない。
       ラベルを詰めて列は均等割にする（§35）＝端末の幅に合わせて縮む。 */
    box.style.gridTemplateColumns = narrow()
      ? '72px repeat(' + cols.length + ', minmax(0, 1fr))'
      : LABEL_W + ' repeat(' + cols.length + ', minmax(96px, auto))';
    box.appendChild(el('div', 'split-label is-strong', 'ライン決着'));
    /* 🔑今日に当たる列と行には「◀ 今日」を出す（2026-09-23 Naoto 第3版）。
       レース種別の表と同じ印＝**どこを見ればいいかを文字で言い切る**（太字や色の濃淡だけに頼らない）。
       ⚠️「全体」行には付けない＝今日の戦法ではなく、いつも見る行だから。 */
    cols.forEach(function (df) {
      var on = (df.k === todaySize);
      box.appendChild(el('div', 'split-h' + (on ? ' is-strong is-cur' : ''),
        df.label + (on ? ' ◀ 今日' : '')));
    });
    rows.forEach(function (rw) {
      var strongRow = (rw.k === '' || rw.k === todayBun);   // 「全体」は常に太字
      var rowOn = (rw.k !== '' && rw.k === todayBun);
      /* 🔑「◀ 今日」が付く見出しと行ラベルは**青**（2026-09-23 Naoto「他のところと合わせて青色に」）
         ＝レース種別の表の「◀ 今日」と同じ色。
         ⚠️**セル（数字）は青にしない**＝種別の表は行がまるごと今日だが、ここは列×行の2軸で、
           行を青く塗ると「今日の列と交わるどのマスを見るのか」が分からなくなる。
           交わるマスは白い太字、関係ないマスはグレーのまま（§31 第3版）。 */
      box.appendChild(el('div', 'split-k' + (strongRow ? ' is-strong' : '') + (rowOn ? ' is-cur' : ''),
        rw.label + (rowOn ? ' ◀ 今日' : '')));
      cols.forEach(function (df) {
        var b = rw.get(lk[df.k]);
        // 薄字は「記録が無いマス」だけ＝走数の多い少ないでは薄くしない（9/23 Naoto）。
        /* 🔴太字にするのは**今日の列と今日の行が交わるマスだけ**（2026-09-23 Naoto
           「3車ラインと三分戦以上も太字になってる気がする」）。
           ⚠️**列だけで決めていたのが原因**＝今日が2車ライン・二分戦でも
             「三分戦以上×2車ライン」まで太字になっていた（西本1番車で14走のマスが目立っていた）。
           🔑「全体」行はいつも見る行なので、今日の列との交点は太字のままにする。 */
        var off = (todaySize && !(strongRow && df.k === todaySize)) ? ' is-off' : '';
        var cell = el('div', 'split-v' + off + ((b && b.n) ? '' : ' is-thin'));
        if (b && b.n) {
          cell.appendChild(document.createTextNode(b.hit + '回'));
          cell.appendChild(el('span', 'split-n', b.n + '走'));
        } else cell.textContent = '—';
        box.appendChild(cell);
      });
    });
    /* ⚠️「太字＝今日の並び（◯車ライン・◯分戦）」の但し書きは**書かない**（2026-09-23 Naoto「いらない」）。
       同じことが表の見出しと行ラベルの太字で見えているので、文字で繰り返す必要がない。 */
    var note = el('div', 'split-note muted sm',
      '2車＝1,2着／3車以上＝1〜3着が自分のライン。自分が何着かは問わない');
    note.style.gridColumn = '1 / -1';
    box.appendChild(note);
    return box;
  }

  /* ── ④.3 レース種別／④.4 グレード（記念以上） ──────────────────────
     どちらも「行＝区分／列＝1着〜9着の回数＋決まり手の内訳」で同じ形なので、
     **1つの関数（catRanks）で作る**。§33で決めた「新しい表を足すときはこの表のとおりに作る」を
     コードの側でも1か所にした＝表ごとに強調や列の型が散らばるのを止める。 */

  /** レース種別ごとの着順。
      🔑2026-09-23（第2版）Naoto「ノイズになっていいので、レース種別もそれぞれの役割の回数を」
         ＝**開いている役割の中の種別**（`rs.byType`）。
         1マスが数走しかないことはあるが、走数を種別名の右に必ず出しているので読み手に見えている。
      ⚠️チャレンジ戦（A3）には特選・初特選が無く「選抜」がある＝無い種別の行は出さない。 */
  function typeRanks(rs, roleKey) {
    return catRanks({
      boxes: rs && rs.byType,
      order: (window.RACETYPE && RACETYPE.RACE_TYPES) || [],
      roleKey: roleKey,
      title: 'レース種別',
      corner: '種別',
      cur: (ctx && ctx.cls && window.RACETYPE) ? RACETYPE.raceTypeOf(ctx.cls) : ''
    });
  }

  /** グレード（記念以上）の勝ち上がりごとの着順（2026-09-24 えーすさんの要望・§40）。
      🔴**G1/G2/G3の区別は出せない**＝グレードそのものがデータに無い（`racetype.js` の説明）。
         「一次予選がある開催＝記念以上」で絞ってまとめて数えている。
      ⚠️**記念以上にA級は出ない**ので、A級の選手ではこの枠は見出しだけになる（表は出ない）。
      ⚠️4段階の走数を足しても**その役割の走数にはならない**（記念以外の走が入らないため）。
         行ごとに走数を出しているので、分母はそこを見る。 */
  function gradeRanks(rs, roleKey) {
    /* 今日の印＝出走表から開いていて、**その開催がグレードレース**のときだけ。
       🔑グレードは出走表（keirin.jp の開催一覧）が持っている生の値（F1/F2/G3…）＝
          過去ぶんは推測しているが、今日ぶんは公式の値をそのまま読める。 */
    var isG = /^G/i.test(String((ctx && ctx.grade) || ''));
    return catRanks({
      boxes: rs && rs.byGrade,
      order: (window.RACETYPE && RACETYPE.GRADE_STAGES) || [],
      roleKey: roleKey,
      title: 'グレード（記念以上）',
      corner: '段階',
      cur: (isG && ctx.cls && window.RACETYPE) ? (RACETYPE.gradeStageOf(ctx.cls) || '') : ''
    });
  }

  /** 行＝区分／列＝1着〜9着 の表。レース種別とグレードで共用（2026-09-24）。
      opts＝{ boxes:区分→箱, order:出す順, roleKey, title:枠の見出し, corner:左上のマス, cur:今日の区分 } */
  function catRanks(opts) {
    var bx = (opts.boxes) || {};
    var cats = (opts.order || []).filter(function (t) { return bx[t] && bx[t].n; });
    /* 🔑**1行も無いときは見出しごと出さない**（2026-09-24 Naoto「出走データがゼロなら
       タイトルも表示させないでいい」）＝グレード（記念以上）はA級の選手では必ず空になるので、
       見出しだけが残ると「あるはずのものが出ていない」と読めてしまう。
       ⚠️レース種別は走れば必ずどれかに入るので空にならない（役割の箱があるときだけ呼ばれる）。 */
    if (!cats.length) return el('div', '');
    var wrap = el('div', '');
    wrap.appendChild(el('div', 'lbl', opts.title));

    var cur = opts.cur || '';
    // 列は着順の表とそろえる。「他」は1つでも出た区分があれば全行に出す（列をずらさない）
    var hasOther = cats.some(function (t) { return (bx[t].ranks || [])[9] > 0; });
    /* 🔑スマホは「1着・2着・3着・4着以下」の4列にまとめる（§35-4）。
       行が4〜7本あるので、着順まで9列出すとどう詰めても入らない。
       ⚠️「4着以下」には**「他」も足す**＝どこにも数えられない走が黙って消えないように。 */
    var nar = narrow();
    var nCol = nar ? 4 : 9 + (hasOther ? 1 : 0);

    /* 🔴PCの列の型は着順の表と**同じ1か所**（rankCols）から出す。
       以前はこの表だけ `minmax(44px, auto)`＋`is-compact`（隙間12px）で、1着〜9着が上の表と
       ずれていた（9着で99px・2026-09-23 Naoto指摘）。総幅は着順の表と同じなので入る幅も同じ。 */
    var box = el('div', 'split rank');
    box.style.gridTemplateColumns = nar
      ? '72px repeat(4, minmax(0, 1fr))'
      : rankCols(nCol);
    box.appendChild(el('div', 'split-label is-strong', opts.corner));
    if (nar) {
      ['1着', '2着', '3着', '4着以下'].forEach(function (t) { box.appendChild(el('div', 'split-h', t)); });
    } else {
      for (var i = 0; i < 9; i++) box.appendChild(el('div', 'split-h', (i + 1) + '着'));
      if (hasOther) box.appendChild(el('div', 'split-h', '他'));
    }

    cats.forEach(function (t) {
      var b = bx[t];
      var isCur = (t === cur);
      // 🔑今日の区分でない行は**太字にしない**（9/23 Naoto「関係ないやつは太字にしないで」）
      var off = (cur && !isCur) ? ' is-off' : '';
      var k = el('div', 'split-k' + (isCur ? ' is-cur' : ''), t + (isCur ? ' ◀ 今日' : ''));
      k.appendChild(el('span', 'split-n', b.n + '走'));
      box.appendChild(k);

      /* 決まり手の内訳（2026-09-24 Naoto「着順みたいに決まりても書いてほしい」）。
         🔑着順の表と**同じ rankSubs を通す**＝言葉も並びも必ず同じになる。
            種別・グレードの箱は決まり手（逃捲差マ）しか持たないので、
            「番手に差され」などの別の軸はここには出ない（集計側で持たせていない）。 */
      var sub = rankSubs(opts.roleKey, b.detail || {});
      var ranks = b.ranks || [];
      var vals = [], subs = [];
      if (nar) {
        var rest = 0;
        for (var q = 3; q < ranks.length; q++) rest += ranks[q] || 0;   // 4着以下＋「他」
        vals = [ranks[0] || 0, ranks[1] || 0, ranks[2] || 0, rest];
        subs = [sub[0], sub[1], sub[2], null];   // 4着以下はまとめた列＝内訳は出さない
      } else {
        for (var j = 0; j < nCol; j++) { vals.push(ranks[j] || 0); subs.push(sub[j]); }
      }
      /* 🔑**数字は青にしない＝白い太字のまま**（2026-09-23 Naoto「回数のところは青字ではなく白太字に」）。
         青いのは行ラベルの「◀ 今日」だけ＝**印（青）が「どこを見るか」、白とグレーが「どのマスか」**。 */
      vals.forEach(function (v, i2) { box.appendChild(catCell(v, subs[i2], off, nar)); });
    });
    wrap.appendChild(box);
    return wrap;
  }

  /** 数字のマス＋その真下に決まり手の内訳。
      🔑着順の表（rankTable）は内訳を専用の「内訳」行にまとめて出すが、こちらは**行ごとに区分が違う**
         ので、内訳はその数字のすぐ下に入れる＝どの数字の内訳かが縦に読める。
      ⚠️スマホは列が狭いので「逃2」の形に縮める（PCは「逃 2回」）。 */
  function catCell(v, subList, off, nar) {
    var cell = el('div', 'rank-cell');
    cell.appendChild(el('div', 'split-v' + off + (v ? '' : ' is-thin'), v ? v + '回' : '—'));
    if (subList && subList.length) {
      var s = el('div', nar ? 'rank-cell-sub' : 'rank-sub');
      subList.forEach(function (x) {
        if (nar) {
          s.appendChild(el('span', 'rank-v-i', (x.short || x.label) + x.v));
        } else {
          var line = el('div', 'rank-sub-i');
          line.appendChild(el('span', 'rank-sub-k', x.short || x.label));
          line.appendChild(el('span', 'rank-sub-v', x.v + '回'));
          s.appendChild(line);
        }
      });
      cell.appendChild(s);
    }
    return cell;
  }

  function figure(box, label, val) {
    var f = el('div', 'fig');
    f.appendChild(el('span', 'fig-v', val));
    f.appendChild(el('span', 'fig-k', label));
    box.appendChild(f);
  }

  /* ── ③選手特徴 ── */

  /** 🔑いちばん大事な手書き（Naoto「これが重要な情報になる」9/23）。
      基礎データのすぐ下に単独で置き、幅いっぱいで書けるようにする。
      以前は「特徴と追走能力」の右半分に押し込んでいて、書く場所が狭かった。 */
  function featureSection() {
    var s = section('選手特徴', '出力ビュー（配信）には出ません。', mFold());
    s.body.appendChild(noteField('feature', '事実と観察を書く。人の評価は書かない', true));
    s.body.appendChild(saveBar());
    return s.root;
  }

  /* ── ④.5 S取り（9/23 Naoto指定・役割別と追走能力の間） ── */

  /** 「どの車番のときにSを取ったか」を出す。
      🔑内枠ほど取りやすいので、**回数だけでなく車番の並びを見ないと意味がない**
         （全体では1番3,795回に対し6番458回）。だから車番ごとに出す。 */
  function sSection() {
    var s = section('S取り', windowText(), mFold());
    var st = stats();
    var sk = st && st.sTaken;

    if (sk && sk.n) {
      var top = el('div', 'role-figs');
      figure(top, 'S取り', sk.n + '回');
      if (st.n) figure(top, '走数に対して', pct(sk.n, st.n));
      s.body.appendChild(top);

      var wrap = el('div', 'scar');
      for (var car = 1; car <= 9; car++) {
        var v = sk.byCar[car] || sk.byCar[String(car)] || 0;
        var item = el('span', 'scar-i' + (v ? '' : ' is-zero'));
        var chip = carChip(car);
        item.appendChild(chip);
        item.appendChild(el('span', 'scar-n', v ? v + '回' : '—'));
        wrap.appendChild(item);
      }
      s.body.appendChild(wrap);
    } else {
      s.body.appendChild(el('div', 'muted sm', 'この期間にSを取った記録はありません。'));
    }

    s.body.appendChild(noteField('noteS', 'S取りについて書く（例：3番より内なら8割取りに行く）', true));
    s.body.appendChild(saveBar());
    return s.root;
  }

  /* ── ⑤追走能力 ── */

  function followSection() {
    var s = section('追走能力', '番手を回ったときの確かさ。出力ビュー（配信）には出ません。', mFold());
    var wrap = el('div', 'follow');

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
    wrap.appendChild(sel);

    var st = stats();
    var bs = st && st.roles && st.roles.bante;
    if (bs && bs.n) wrap.appendChild(el('div', 'muted sm', '参考：番手' + bs.n + '走で3着内 ' + pct(bs.top3, bs.n)));
    wrap.appendChild(noteField('followNote', 'そう判断した根拠（例：9/12小倉7R 番手から離れた）'));

    s.body.appendChild(wrap);
    s.body.appendChild(saveBar());
    return s.root;
  }

  function saveBar() {
    var bar = el('div', 'savebar');
    var st = el('span', 'savestate');
    st.dataset.role = 'savestate';
    st.textContent = dirty ? '未保存' : '';
    var b = el('button', 'btn btn-sm', '今すぐ保存');
    b.type = 'button';
    b.onclick = function () { saveMemo(false); };
    bar.appendChild(st);
    bar.appendChild(b);
    return bar;
  }

  function setSaveState(t) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-role="savestate"]'), function (n) { n.textContent = t; });
  }

  /** 何か書き換わった＝1.2秒止まったら勝手に保存する */
  function markDirty() {
    dirty = true;
    changeSeq++;
    setSaveState('未保存');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveMemo(true); }, 1200);
  }

  /** auto=true は自動保存（成功しても通知を出さない） */
  function saveMemo(auto) {
    clearTimeout(saveTimer);
    if (!cur || !cur.rider) return;
    if (auto && !dirty) return;
    var reg = cur.rider.reg;
    var at = changeSeq;                       // いまの内容の版
    var mine = ++saveSeq;
    setSaveState('保存中…');

    API.saveMemo(reg, Object.assign({}, cur.memo)).then(function (j) {
      if (mine !== saveSeq) return;           // もっと新しい保存が走っている
      // ⚠️保存中に書き足したぶんを返事で上書きしない。時刻と書き手だけもらう
      cur.memo.at = j.memo.at;
      cur.memo.by = j.memo.by;
      if (changeSeq === at) {
        dirty = false;
        setSaveState('保存しました');
      } else {
        setSaveState('未保存');               // 保存中にまた書いた＝次の自動保存に任せる
      }
      if (!auto) toast('保存しました');
      LIST.touch(reg, { hasMemo: !!(String(cur.memo.feature || '').trim() || String(cur.memo.follow || '').trim()) });
    }).catch(function (e) {
      if (mine !== saveSeq) return;
      setSaveState('保存できませんでした');
      toast(e.message, true);
    });
  }

  /** 別の選手へ移る・画面を閉じる前に、書きかけを取りこぼさない */
  function flush() {
    if (dirty) saveMemo(false);
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

    /* ── 場＝プルダウン（2026-09-23 Naoto）──
       🔑**今日開催している場を上に固めて出す**＝観察はたいてい当日書くので、40場から探さずに済む。
       ⚠️選択肢に無い値（過去に手入力したもの・新しい場）は先頭に足してから選ぶ＝黙って消えない。 */
    var jo = el('select', 'sel sel-sm');
    var cv = (ctx && ctx.jo) || '';
    var j0 = el('option', '', '場を選ぶ');
    j0.value = '';
    jo.appendChild(j0);

    var todays = (window.TODAY && TODAY.venueNames) ? TODAY.venueNames() : [];
    var seen = {};
    function joOpt(name, parent) {
      if (!name || seen[name]) return;
      seen[name] = 1;
      var o = el('option', '', name);
      o.value = name;
      parent.appendChild(o);
    }
    if (cv && CONFIG.VENUES.indexOf(cv) < 0) joOpt(cv, jo);   // 一覧に無い既存値
    if (todays.length) {
      var g1 = el('optgroup');
      g1.label = '今日開催';
      todays.forEach(function (n) { joOpt(n, g1); });
      if (g1.childNodes.length) jo.appendChild(g1);
      var g2 = el('optgroup');
      g2.label = 'そのほか';
      CONFIG.VENUES.forEach(function (n) { joOpt(n, g2); });
      if (g2.childNodes.length) jo.appendChild(g2);
    } else {
      CONFIG.VENUES.forEach(function (n) { joOpt(n, jo); });
    }
    jo.value = cv;
    top.appendChild(jo);

    /* ── 開催日＝カレンダーで選ぶ（2026-09-23 Naoto）──
       🔴入れ物は `YYYY-MM-DD`（type=date の決まり）だが、**保存は今までどおり `YYYYMMDD`**。
          GAS・スプレッドシート・既存の1件を一切触らずに済む。変換は toDateInput / fromDateInput の2か所だけ。 */
    var rd = el('input', 'inp inp-date');
    rd.type = 'date';
    rd.value = toDateInput((ctx && ctx.raceDate) || '');
    top.appendChild(rd);

    var rn = el('input', 'inp inp-xs');
    rn.type = 'number';
    rn.placeholder = 'R';
    rn.value = (ctx && ctx.raceNo) || '';
    top.appendChild(rn);
    f.appendChild(top);

    // ⚠️ここは「これから書く」欄なので読むモードは付けない。
    //   代わりに高さが中身に合わせて伸びる（1行の入力欄だと後ろが見えなくなるため）
    var body = el('textarea', 'inp ta-grow');
    body.rows = 1;
    body.placeholder = '見たままを書く（例：番手から出ないで4着）';
    body.oninput = function () { grow(body); };
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
        reg: cur.rider.reg, role: roleSel.value, body: body.value,
        jo: jo.value, raceDate: fromDateInput(rd.value), raceNo: rn.value, pub: pubIn.checked ? 1 : ''
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
    var where = [o.jo, fmtObsDate(o.raceDate), o.raceNo ? o.raceNo + 'R' : ''].filter(Boolean).join(' ');
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
    // 並び実績・落車欠場も同じ期間を数えたもの（9/23 Naoto「他のデータも同様に」）
    var s = section('参考', windowText(), true);
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

  return { open: open, flush: flush, isDirty: function () { return dirty; } };
})();
