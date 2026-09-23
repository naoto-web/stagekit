/* ===========================================================
   today.js — 本日の出走表（要件§2-1・§4.1-2）
   ===========================================================
   選手名を押すと右の詳細へ飛ぶ。並び予想も出すので「いまこの人は何番手か」を見ながら書ける。
*/

var TODAY = (function () {

  // curReg＝いま右に出している選手。出走表のどの行が選ばれているか分かるようにする
  // （9/23 Naoto「出走表上で今どの選手選んでるか分かるように。選手一覧と同じように」）。
  // ⚠️描画のたびに付け直す必要があるので state に持つ（場のタブを切り替えると行は作り直される）
  var state = { day: '0', data: null, venue: 0, loaded: false, curReg: '' };

  // 直近4ヶ月成績の10列（逃 捲 差 マ／B H S／勝率 2連 3連）。この順番で見出しも明細も作る
  var NUM_KEYS = ['nige', 'makuri', 'sasi', 'mark', 'b', 'h', 's', 'win', 'ren2', 'ren3'];
  // 🔑列のまとまりの切れ目＝上の10列のうち「左に縦線を引く」もの（9/23 Naoto「区切りが無くて分かりづらい」）。
  //   0=逃（得点との境）・4=B（マとの境）・7=勝率（Sとの境）。3連の右＝役割の列に別途 col-sep を付ける。
  //   ⚠️見出しと明細で線の位置がずれると読めないので、出どころはここ1か所にする
  var SEP_AT = { 0: 1, 4: 1, 7: 1 };

  /* 開催区分（9/23 Naoto「青森の右・F2との間に（モ）（デ）（ナ）（ミ）を」）。
     🔑一次情報＝keirin.jp の開催一覧 JSJ048 の `kubunIconName`（GASが venue.kubun で渡す）。
        2026-09-23に実データ13開催で1R発走時刻と突き合わせて確定：
        8=モーニング(1R 8:30〜8:40) / 1=デイ(10:45〜11:01) / 3=ナイター(15:50〜16:04) / 5=ミッドナイト(20:40〜20:50) */
  var KUBUN = { '8': 'モ', '1': 'デ', '3': 'ナ', '5': 'ミ' };

  /* 画面に出す印（2026-09-23 Naoto「（モ）とかの代わりに絵文字を付けたら幅を狭められるんじゃない？」）。
     🔑**デイだけ印を出さない**＝4区分でいちばん多いので、無印にすると幅がいちばん縮む。
        「印が無い＝ふつうの昼」と読む。今日の6場で **631px→475px（25%減）** を実測して案を選んだ。
     ⚠️1文字の記号（◐○●★）や全区分に絵文字を付ける案も測ったが、この形がいちばん狭かった。
     ⚠️内部のキー（モ/デ/ナ/ミ）は変えない＝ホバーの説明（KUBUN_FULL）と時刻からの予備判定が
        そのまま使える。**見せ方だけをここで差し替える。** */
  var KUBUN_MARK = { 'モ': '☀️', 'デ': '', 'ナ': '🌙', 'ミ': '⭐' };

  function load(force) {
    var box = document.getElementById('racecard');
    clear(box);
    box.appendChild(el('div', 'empty', '読み込み中…'));
    return API.racecard(state.day, force).then(function (j) {
      state.data = j.card || { venues: [] };
      sortVenues(state.data.venues);
      state.venue = defaultVenue(state.data);
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
      var kb = kubunLabel(v);
      // ⚠️デイは印なし（KUBUN_MARK が空文字）＝タブに余計な要素を足さない
      if (kb && KUBUN_MARK[kb]) b.appendChild(el('span', 'vtab-kubun', KUBUN_MARK[kb]));
      if (v.grade) b.appendChild(el('span', 'vtab-grade', v.grade));
      b.title = [v.name, kb ? KUBUN_FULL[kb] : '', v.grade, '1R ' + (startText(v) || '—')]
        .filter(Boolean).join('・');
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
    var sizeMap = sizesFromLines(lines);
    var bunsen = bunsenOf(r);
    var tbl = el('div', 'racers');
    tbl.appendChild(racerHeader());
    r.racers.forEach(function (s) {
      var isCur = !!(s.reg && s.reg === state.curReg);
      var row = el('button', 'racer-row racer' + (isCur ? ' is-current' : ''));
      row.type = 'button';
      row.dataset.reg = s.reg || '';
      row.disabled = !s.reg;
      row.onclick = function () {
        if (!s.reg) return;
        markCurrent(s.reg);
        if (window.LIST) LIST.markCurrent(s.reg);   // 選手一覧へ戻ったときも同じ人が選ばれて見える
        // cls（レース種別）も渡す＝詳細の「レース種別ごと」で今日の種別の行に印が付く。
        // lineSize・bunsen＝ライン決着と戦法別で「今日はここ」を太字にするため（9/23 Naoto）
        DETAIL.open(s.reg, {
          jo: v.name, raceDate: (state.data || {}).date, raceNo: r.no,
          role: roleMap[s.no] || '', cls: r.cls || '',
          lineSize: sizeMap[s.no] || 0, bunsen: bunsen
        }, s);
      };
      row.appendChild(carChip(s.no));

      var nm = el('div', 'racer-name');
      nm.appendChild(el('span', 'racer-name-main', s.name || ''));
      nm.appendChild(el('span', 'racer-sub',
        [s.pref, s.term ? s.term + '期' : '', s.age ? s.age + '歳' : ''].filter(Boolean).join(' ')));
      row.appendChild(nm);

      row.appendChild(el('span', 'racer-kyuhan', s.kyuhan || ''));
      row.appendChild(el('span', 'racer-kyaku', s.kyaku || ''));
      row.appendChild(el('span', 'racer-score', s.score || ''));

      // 直近4ヶ月成績。0は薄くして、数字のあるところが目に入るようにする
      // 🔴スマホでは出さない（§35-4）＝10列で551px要るので横スクロールなしに収まらない。
      //   同じ数字は選手を開けば役割別の表にある＝**同じものを2か所に出さない**。
      //   ⚠️CSSの `.racer-row` の列の型（@media）と**必ずセットで直す**。片方だけだと列がずれる。
      if (!narrow()) {
        NUM_KEYS.forEach(function (k, i) {
          var v2 = String(s[k] == null ? '' : s[k]).trim();
          var cls = 'n' + (i >= 7 ? ' n-rate' : '') + (!v2 || v2 === '0' ? ' is-zero' : '')
                  + (SEP_AT[i] ? ' col-sep' : '');
          row.appendChild(el('span', cls, v2 === '' ? '-' : v2));
        });
      }

      row.appendChild(el('span', 'racer-role col-sep', roleMap[s.no] ? roleLabel(roleMap[s.no]) : ''));
      tbl.appendChild(row);
    });
    wrap.appendChild(tbl);
    return wrap;
  }

  /** 見出し行。数字が10個並ぶので、見出しが無いと読めない。
      値は keirin.jp の「直近4ヶ月成績」そのもの（率は%）。 */
  function racerHeader() {
    var h = el('div', 'racer-row racer-head');
    h.appendChild(el('span', '', '車'));
    h.appendChild(el('span', '', '選手名'));
    h.appendChild(el('span', '', '級班'));
    h.appendChild(el('span', '', '脚'));
    h.appendChild(el('span', 'racer-score', '得点'));
    if (!narrow()) {
      ['逃', '捲', '差', 'マ', 'B', 'H', 'S'].forEach(function (t, i) {
        h.appendChild(el('span', 'n' + (SEP_AT[i] ? ' col-sep' : ''), t));
      });
      ['勝率', '2連', '3連'].forEach(function (t, i) {
        h.appendChild(el('span', 'n n-rate' + (SEP_AT[i + 7] ? ' col-sep' : ''), t));
      });
    }
    // 見出しの右端＝PCは「直近4ヶ月」（その左10列の説明）。スマホはその10列が無いので「役割」
    h.appendChild(el('span', 'racer-role col-sep', narrow() ? '役割' : '直近4ヶ月'));
    return h;
  }

  /** スマホ（1カラム）か。出走表は幅で列数が変わる＝§35-4 */
  function narrow() { return !!(window.MOBILE && MOBILE.isNarrow()); }

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

  /* ── 場の並び＝1Rの発走時刻が早い順（9/23 Naoto）──
     結果としてモーニング→デイ→ナイター→ミッドナイトの順に左から並ぶ。
     ⚠️時刻が取れない場は末尾へ（並びから消さない）。sortは安定なので同時刻は元の順のまま */
  function sortVenues(venues) {
    (venues || []).sort(function (a, b) { return firstStartMin(a) - firstStartMin(b); });
  }

  /** その場の1R（＝時刻が取れる最初のレース）の発走時刻。'16:04' → 964分 */
  function firstStartMin(v) {
    var rs = (v || {}).races || [];
    for (var i = 0; i < rs.length; i++) {
      var m = /^(\d{1,2}):(\d{2})$/.exec(String(rs[i].start || '').trim());
      if (m) return (+m[1]) * 60 + (+m[2]);
    }
    return 99999;
  }

  function startText(v) {
    var rs = (v || {}).races || [];
    for (var i = 0; i < rs.length; i++) if (rs[i].start) return String(rs[i].start).trim();
    return '';
  }

  /* ── 最初に開く場（2026-09-23 Naoto「出走が残っている中で一番左をデフォルトに」）──────
     場は1R発走の早い順に並んでいる（sortVenues）ので、
     「まだ発走していないレースが残っている場のうち、いちばん左」＝
     **いま走っている開催のうち、いちばん進んでいるもの**になる。
     朝ならモーニング、昼過ぎならデイ、夜ならナイターが自然に開く。
     ⚠️「明日」を選んだときは時刻で絞らない（全部これからなので、いちばん左＝1Rが早い場でよい）。
        判定は**選択肢（本日/明日）でなくカードの日付**で行う＝日付が変わった直後に開いても取り違えない。
     ⚠️深夜などで全部終わっているときは0に戻す＝どこも残っていないなら左端でよい。 */

  /** 0:00からの分で「いま」 */
  function nowMin() {
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  /** その場の**最終**レースの発走時刻（分）。時刻が1つも取れなければ -1。
      ⚠️レースは番号順なので最後の要素が最終レース。時刻の無い行があってもいいよう後ろから探す */
  function lastStartMin(v) {
    var rs = (v || {}).races || [];
    for (var i = rs.length - 1; i >= 0; i--) {
      var m = /^(\d{1,2}):(\d{2})$/.exec(String(rs[i].start || '').trim());
      if (m) return (+m[1]) * 60 + (+m[2]);
    }
    return -1;
  }

  /** カードの日付が今日か（`20260923` 形式） */
  function isToday(d) {
    var s = String((d || {}).date || '');
    if (!/^\d{8}$/.test(s)) return false;
    var n = new Date();
    var p2 = function (x) { return ('0' + x).slice(-2); };
    return s === (n.getFullYear() + p2(n.getMonth() + 1) + p2(n.getDate()));
  }

  function defaultVenue(d) {
    var venues = (d || {}).venues || [];
    if (!isToday(d)) return 0;
    var now = nowMin();
    for (var i = 0; i < venues.length; i++) {
      if (lastStartMin(venues[i]) >= now) return i;
    }
    return 0;
  }

  var KUBUN_FULL = { 'モ': 'モーニング', 'デ': 'デイ', 'ナ': 'ナイター', 'ミ': 'ミッドナイト' };

  /** 開催区分の1文字。公式の区分コード（venue.kubun）が一次情報。
      ⚠️コードが無い／未知のときだけ1Rの発走時刻から決める
      （GASが古くて kubun を返さない間もラベルが消えないようにするための予備）。 */
  function kubunLabel(v) {
    var k = KUBUN[String((v || {}).kubun || '')];
    if (k) return k;
    var t = firstStartMin(v);
    if (t >= 99999) return '';
    if (t < 10 * 60) return 'モ';
    if (t < 14 * 60) return 'デ';
    if (t < 19 * 60 + 30) return 'ナ';
    return 'ミ';
  }

  /** 車番 → 自分のラインの車数。競りの車も同じラインの1車として数える。
      🔑集計側（`rider_race.line_size`）に合わせる＝DBの `lines_json` は
         [[4,1],[2,5,3],[6]] のように車番を平らに並べた配列で、競りの車もその中に入っている。 */
  function sizesFromLines(lines) {
    var map = {};
    (lines || []).forEach(function (line) {
      var n = 0;
      line.forEach(function (pos) { n += pos.length; });
      line.forEach(function (pos) { pos.forEach(function (c) { map[c] = n; }); });
    });
    return map;
  }

  /** 今日の戦法（'2'＝二分戦／'3'＝三分戦以上／''＝どちらとも言えない）。
      🔑**出走表の見出しに出ている文字をそのまま読む**（2026-09-23 Naoto「出走表の言葉に合わせる」）。
         こうしておけば、Yが見出しで読む言葉と、詳細で「今日」と印が付く表が**必ず一致する**。
         自分で数え直すと、keirin.jpの数え方とわずかでも違ったときに食い違う。
      ⚠️文字が取れないときだけ、集計と同じ数え方（**2車以上のラインの本数**）で補う。
      ⚠️一分戦は「どちらとも言えない」＝印を付けない（集計でも二分戦にも三分戦以上にも入れていない）。
      🪤2026-09-23に「自力の単騎も1つと数える」説を立てて検証したが、その日の全場51レースで
        **94.1%→86.3%と悪化**したので採らなかった（`選手DB案件/実装/verify_bunsen.js`）。
        表示は並びから機械的に決まる値ではない（同じ形でも場によって割れる）＝だから文字を読む。 */
  function bunsenOf(r) {
    var t = String((r || {}).lineType || '');
    if (/^二/.test(t)) return '2';
    if (/^[三四五六七八九十]/.test(t)) return '3';
    if (/^一/.test(t)) return '';
    return bunsenFromLines(r);
  }

  /** 予備＝並びから数える（2車以上のラインの本数）。見出しの文字が無いレース用 */
  function bunsenFromLines(r) {
    var n = 0;
    ((r || {}).lines || []).forEach(function (line) {
      var cars = 0;
      line.forEach(function (pos) { cars += pos.length; });
      if (cars >= 2) n++;
    });
    return n === 2 ? '2' : (n >= 3 ? '3' : '');
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

  /** いま選んでいる選手の行に印を付ける（選手一覧の markCurrent と同じ考え方）。
      同じ人が同じ場で複数レースに出ることは無いが、**場をまたげば同じ登録番号が別のタブに出る**ので、
      いま描かれている行を総当たりで付け替える。 */
  function markCurrent(reg) {
    state.curReg = reg || '';
    var box = document.getElementById('racecard');
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('.racer-row'), function (n) {
      n.classList.toggle('is-current', !!state.curReg && n.dataset.reg === state.curReg);
    });
  }

  return {
    bind: bind,
    load: load,
    markCurrent: markCurrent,
    ensure: function () { if (!state.loaded) load(false); },
    /* 幅の境目をまたいだときに作り直す（§35）＝成績10列を出すか出さないかが変わるので、
       描き直さないと見出しと明細で列がずれる。取り直しは不要＝手元の state から組み直すだけ */
    redraw: function () { if (state.loaded) render(); },
    /* 今日の出走表に出ている場の名前（観察ログの「場」の上に出すため・2026-09-23）。
       出走表をまだ読んでいなければ空を返す＝呼び出し側は40場の一覧だけで普通に動く */
    venueNames: function () {
      return ((state.data || {}).venues || []).map(function (v) { return v.name; })
        .filter(Boolean);
    }
  };
})();
