/* ===========================================================
   main.js — 起動・描画・イベント結線
   =========================================================== */

(function () {

  var stageEl, ridersEl, barsEl, panelEl, hintEl;
  var inputEl, applyBtn, resetBtn, sizeRange, sizeVal;
  var venueSel, raceSel, reloadBtn, followChk, followDiffEl, nowRaceEl;
  var titleEl, titleMainEl, titleSubEl, dirEl, liveDot;
  var pendingRace = null;   // URLで指定されたレース（出走表の取得完了後に適用する）

  /* 'control'＝操作画面（OBSのカスタムブラウザドックに入れる）
     'output' ＝出力画面（OBSのブラウザソースに入れる）。?view=output で切り替える */
  var VIEW = 'control';
  var lastRemoteSig = '';   // 出力側で「構造が変わったか」を見るための署名
  var riderEls = {};   // { 1: HTMLElement, ... }

  /* ---------- 描画 ---------- */

  /** 1台の位置を反映する（dataset にも持たせてドラッグの基準にする） */
  function applyPosition(no, x, y) {
    var el = riderEls[no];
    if (!el) return;
    el.dataset.x = String(x);
    el.dataset.y = String(y);
    el.style.left = (x * 100) + '%';
    el.style.top = (y * 100) + '%';
  }

  /** ステージを残りスペースいっぱいに広げる。
      以前は16:9で固定していたが、それだと高さが上限になって横が余っていた。
      座標はすべて正規化（0..1）なので、縦横比が変わっても配置はそのまま成立する。
      ※OBSに載せるときは、クロップ後にウィンドウサイズを固定すること */
  function fitStage() {
    var wrap = stageEl.parentElement;
    if (!wrap) return;
    var w = wrap.clientWidth;
    var h = wrap.clientHeight;
    if (!w || !h) return;

    stageEl.style.width  = w + 'px';
    stageEl.style.height = h + 'px';
    /* 見出し・進行方向ラベルの文字サイズがステージ高に追従できるように渡す */
    stageEl.style.setProperty('--stage-w', w + 'px');
    stageEl.style.setProperty('--stage-h', h + 'px');
  }

  /** アイコン径を実ピクセルで決める */
  function applyIconSize() {
    fitStage();
    var px = Math.round(CONFIG.iconPx(stageEl.clientWidth, stageEl.clientHeight, State.data.iconRatio));
    stageEl.style.setProperty('--icon-px', px + 'px');
    Bars.sync();   // 連結バーの太さ・座標もステージサイズに連動する
  }

  /** 状態を丸ごと画面に反映する */
  function render() {
    var d = State.data;

    for (var no = 1; no <= CONFIG.MAX_CAR; no++) {
      var el = riderEls[no];
      if (!el) continue;
      /* 出走している車番だけ出す。6車立て・欠車もこれで正しく消える */
      var visible = (d.cars.indexOf(no) !== -1);
      el.classList.toggle('is-hidden', !visible);
      if (visible) {
        applyPosition(no, d.riders[no].x, d.riders[no].y);
        Icons.setName(el, d.names[no] || '');
        Icons.setDirection(el, d.dir);
      }
    }

    stageEl.dataset.bg = d.bg;
    stageEl.dataset.names = d.showNames;
    stageEl.dataset.dir = d.dir;

    titleMainEl.textContent = d.titleMain || '';
    titleSubEl.textContent = d.titleSub || '';
    titleEl.classList.toggle('is-empty', !d.titleMain);

    /* 先頭がどちら側かを、ラベルの中身と置き場所の両方で示す */
    dirEl.textContent = (d.dir === 'right') ? '先頭 ▶' : '◀ 先頭';

    publishLive(true);
    Bars.rebuild();
    applyIconSize();
    syncControls();
  }

  /** コントロールの表示状態を state に合わせる */
  function syncControls() {
    var d = State.data;

    sizeRange.value = String(Math.round(d.iconRatio * 1000));
    sizeVal.textContent = (d.iconRatio * 100).toFixed(1) + '%';

    if (document.activeElement !== inputEl) inputEl.value = d.lineupText;
  }

  function setHint(text, isWarn) {
    hintEl.textContent = text;
    hintEl.classList.toggle('is-warn', !!isWarn);
  }

  /* ---------- 並びの適用 ---------- */

  /** ラインに出てくる車番＝盤面に出す車番 */
  function carsFromLines(lines) {
    var out = [];
    (lines || []).forEach(function (line) {
      line.forEach(function (no) { if (out.indexOf(no) === -1) out.push(no); });
    });
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  function applyLineup() {
    var text = inputEl.value;
    var d = State.data;

    if (!Lineup.normalize(text)) {
      setHint('並びを入力してください。例）1-3-5 / 2-7 / 4-6-9', true);
      return;
    }

    /* 出走表を読み込み済みなら、そのレースに存在する車番だけ受け付ける。
       検証の母集合は raceCars（今の表示 cars ではない）。
       cars で検証すると、一度並びから外して消えた車番を書き戻せなくなる */
    var pool = (d.raceCars && d.raceCars.length) ? d.raceCars : null;
    var result = Lineup.apply(text, pool, d.dir, d.iconRatio);

    State.set({
      lineupText: text,
      lines: result.lines,
      cars: carsFromLines(result.lines)   // 並びに書かれた車番だけを盤面に出す
    });
    State.setRiders(result.positions);
    render();

    /* 結果の要約を出す */
    var shown = result.lines.map(function (l) { return l.join('-'); }).join(' / ');
    var msg = '配置しました： ' + shown;
    var warn = false;

    if (result.missing.length) {
      msg += '　／ 並びに無い ' + result.missing.join('・') + ' 番は盤面に出していません';
      warn = true;
    }
    if (result.ignored.length) {
      var uniq = result.ignored.filter(function (v, i, a) { return a.indexOf(v) === i; });
      msg += '　／ ' + uniq.join('・') + ' 番は重複または出走していないので無視しました';
      warn = true;
    }
    setHint(msg, warn);
  }

  /* ---------- 出力画面との同期（C案の検証部分） ---------- */

  /** 操作側→出力側へ現状を流す。ドラッグ中に毎フレーム呼ばれるのでLive側で間引かれる */
  function publishLive(force) {
    if (VIEW === 'control') Live.publish(State.data, force);
  }

  /** 出力側：操作側から届いた状態を反映する。
      構造（出走車・ライン・名前・見出し等）が変わったときだけ作り直し、
      それ以外は座標だけ更新する。毎フレーム作り直すとライン帯がちらつくため */
  function applyRemote(d) {
    if (!d) return;
    State.set(d);

    var sig = JSON.stringify([d.cars, d.lines, d.names, d.titleMain, d.titleSub,
                              d.dir, d.iconRatio, d.bg, d.showBars, d.showNames]);
    if (sig !== lastRemoteSig) { lastRemoteSig = sig; render(); return; }

    for (var no = 1; no <= CONFIG.MAX_CAR; no++) {
      if (d.cars.indexOf(no) !== -1 && d.riders[no]) {
        applyPosition(no, d.riders[no].x, d.riders[no].y);
      }
    }
    Bars.sync();
  }

  /** 接続インジケータ。これが緑になればC案は成立、赤のままなら伝送路の作り直しが要る */
  function updateLiveDot() {
    if (!liveDot) return;
    if (!Live.available()) {
      liveDot.dataset.live = 'na';
      liveDot.textContent = '同期不可（この環境）';
      return;
    }
    var on = Live.isAlive();
    liveDot.dataset.live = on ? 'on' : 'off';
    liveDot.textContent = on ? '出力：接続中' : '出力：未接続';
  }

  /* ---------- 出走表（レース選択） ---------- */

  function populateVenues() {
    var vs = RaceCard.venues();
    venueSel.innerHTML = '';

    if (!vs.length) {
      venueSel.appendChild(new Option('（開催なし）', ''));
      venueSel.disabled = true;
      raceSel.disabled = true;
      return;
    }

    vs.forEach(function (v) {
      venueSel.appendChild(new Option(v.name + (v.grade ? '（' + v.grade + '）' : ''), v.joCode));
    });
    venueSel.disabled = false;

    var want = State.data.sel.joCode;
    if (want && RaceCard.findVenue(want)) venueSel.value = want;
    populateRaces();
  }

  function populateRaces() {
    var v = RaceCard.findVenue(venueSel.value);
    raceSel.innerHTML = '';

    if (!v || !v.races || !v.races.length) { raceSel.disabled = true; return; }

    v.races.forEach(function (r) {
      /* 以前はタイムテーブル側の並びが空のとき「※並び未」と出していたが、
         実際は保険経路（action=narabi）でほぼ取れるため警告として機能せず、
         「全部＊並び未なのに選ぶと出る」という誤解を招いたので廃止した（8/12）。
         取れたかどうかは、選んだ直後のヒント欄で正確に分かる */
      raceSel.appendChild(new Option(r.no + 'R ' + (r.start || ''), r.no));
    });
    raceSel.disabled = false;

    var want = State.data.sel.raceNo;
    if (want && RaceCard.findRace(v, want)) raceSel.value = String(want);
  }

  /**
   * @param {boolean} refresh GAS側のキャッシュも無視して取り直す
   * @param {boolean} silent  定期再取得用。ヒント欄とボタンを触らない
   */
  function loadTimetable(refresh, silent) {
    if (!RaceCard.enabled()) {
      if (!silent) setHint('出走表の取得先が未設定です（js/config.js の GAS_URL）。並びの手入力だけで使えます。', true);
      return;
    }
    if (!silent) {
      setHint('出走表を取得しています…');
      reloadBtn.disabled = true;
    }

    RaceCard.fetchTimetable(refresh).then(function (tt) {
      populateVenues();

      /* URLでレースを指定されていたら、ここで初めて適用できる */
      if (pendingRace) {
        var pv = RaceCard.findVenue(pendingRace.jo);
        if (pv && RaceCard.findRace(pv, pendingRace.race)) {
          venueSel.value = pendingRace.jo;
          populateRaces();
          raceSel.value = String(pendingRace.race);
          pendingRace = null;
          applySelectedRace();
          return;
        }
        pendingRace = null;
      }

      followTick();   // 場コードは時刻表からしか引けないので、届いた直後に追従を1回回す

      if (silent) return;
      var races = 0;
      RaceCard.venues().forEach(function (v) { races += v.races.length; });
      setHint((CONFIG.IS_TEST_BACKEND ? '【テスト接続】' : '') +
              '出走表を取得しました（' + (tt && tt.date ? tt.date : '') + '・' +
              RaceCard.venues().length + '場 ' + races + 'レース）。' +
              (isFollowing() ? '配信のレースに自動で追従します。' : '場とレースを選ぶと並びと選手名が入ります。'),
              CONFIG.IS_TEST_BACKEND);
    }).catch(function (e) {
      if (silent) return;
      setHint('出走表の取得に失敗しました：' + ((e && e.message) || e) +
              '　※file:// で開いている場合はブラウザのCORS制限の可能性があります', true);
    }).then(function () {
      if (!silent) reloadBtn.disabled = false;
    });
  }

  /* ---------- 配信への追従（8/12・常時ONへ変更） ----------
     **出走表と展開ボードのレースは常に一致させる**（Naoto確定）。
     ボード側でレースを選ぶ用途は無いので、場・レース選択と追従チェックはUIから隠し、
     コンソールの操作中レースにいつでも従う。

     受け取り方は2経路：
       ①放送通知（`live-sync-v1`）＝コンソールが保存した瞬間に届く。**出走表と同時に切り替わる**
       ②5秒ごとのGAS読み取り＝通知が届かない環境でも必ず追いつく土台
     ①だけだと、通知は「変化の瞬間」しか流れないため後から起動したボードが取り残される
     （③オーバーレイで実際に踏んだ罠と同じ）。②が土台、①が速度。

     ⚠️追従でレースが変わると盤面の配置は組み直される（＝手で動かした隊列は消える）。
        レースが変わる＝解説対象が変わるタイミングなので、組み直しが正しい。

     緊急時のみ `?follow=0` で手動モード（場・レース選択が現れる）。通常は使わない */
  var FOLLOW_MODE = true;
  try { FOLLOW_MODE = new URLSearchParams(location.search).get('follow') !== '0'; } catch (e) {}

  function isFollowing() {
    if (FOLLOW_MODE) return true;
    return !!(followChk && followChk.checked);
  }

  function setFollowing(on, why) {
    if (!followChk || followChk.checked === on) return;
    followChk.checked = on;
    if (why) setHint(why);
  }

  /** 追従OFFのあいだ「配信は今どこか」を出す。
      OFFにしたこと自体は本人の操作だが、そのまま忘れて盤面だけ取り残される事故が起きる
      （8/12実機＝出走表は松山3R・盤面は松山2Rのまま）。ズレているときだけ赤く出す */
  function showFollowDiff(sel) {
    if (!followDiffEl) return;
    var cur = State.data.sel;
    var same = !sel || (cur && String(cur.joCode) === sel.joCode && +cur.raceNo === sel.raceNo);
    if (isFollowing() || same || !sel) { followDiffEl.textContent = ''; followDiffEl.hidden = true; return; }
    var v = RaceCard.findVenue(sel.joCode);
    followDiffEl.textContent = '配信は ' + (v ? v.name : '') + ' ' + sel.raceNo + 'R';
    followDiffEl.hidden = false;
  }

  /** コンソールのレースを盤面に反映する。放送通知とGAS読み取りの共通の受け口 */
  function applyConsoleSel(sel) {
    if (!sel) return;
    if (!isFollowing()) { showFollowDiff(sel); return; }
    /* すでに同じレースなら何もしない＝盤面を毎回作り直さない */
    var cur = State.data.sel;
    if (cur && String(cur.joCode) === sel.joCode && +cur.raceNo === sel.raceNo) { showFollowDiff(sel); return; }
    var v = RaceCard.findVenue(sel.joCode);
    if (!v || !RaceCard.findRace(v, sel.raceNo)) return; // 時刻表にまだ無い＝次の巡回で拾う
    venueSel.value = sel.joCode;
    populateRaces();
    raceSel.value = String(sel.raceNo);
    applySelectedRace(true);
    showFollowDiff(sel);
  }

  /* 通知が届いている間はGASを読む回数を落とす（8/12）。
     GASの実行枠はGoogleアカウント単位で、本番・テストの全オーバーレイが5秒ごとに叩いている。
     ボードがもう1本5秒で叩くと混雑を押し上げ、コンソールの保存が失敗しやすくなる（実際に発生）。
     通知が生きているならGASは保険でしかないので、間隔を大きく取る。
     通知が来ていない環境では従来どおり短い間隔で回す＝遅れない */
  var lastBcAt = 0;
  function followDue(now) {
    var bcAlive = lastBcAt && (now - lastBcAt) < 120000; // 直近2分に通知が来ていれば生きている
    return bcAlive ? CONFIG.FOLLOW_MS_BC : CONFIG.FOLLOW_MS;
  }
  var lastFollowAt = 0;
  function followTick(force) {
    if (!RaceCard.enabled()) return;
    var now = Date.now();
    if (!force && lastFollowAt && (now - lastFollowAt) < followDue(now)) return;
    lastFollowAt = now;
    /* 追従OFF（?follow=0）でもコンソールは読む＝ズレていることを知らせるため */
    RaceCard.fetchConsoleRace().then(applyConsoleSel);
  }

  /* 放送通知の経路＝コンソールが保存した瞬間に届く。これで**出走表と同時に**切り替わる。
     stagekitのsync.jsが流しているのと同じチャンネル名。

     ⚠️必ず聞き専にすること。あちらのオーバーレイはpingにpongを返す作りなので、
        ボードまで返すとコンソールの「オーバーレイ疎通テスト」が、
        オーバーレイが1つも無くてもOKと出てしまう（診断が嘘をつく）。 */
  function initConsoleChannel() {
    if (VIEW !== 'control' || typeof BroadcastChannel === 'undefined') return;
    try {
      /* ⚠️チャンネル名はバックエンドごとに分ける（stagekitのsync.jsと同じ規則）。
         同名だとテストコンソールの通知が本番のボードにも届いてしまう */
      var ch = new BroadcastChannel('live-sync-v1' + (CONFIG.IS_TEST_BACKEND ? '-test' : ''));
      ch.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.type !== 'state' || !m.state) return;
        lastBcAt = Date.now();   // 通知が生きている＝GASの巡回は間隔を空けてよい
        applyConsoleSel(RaceCard.selFromState(m.state));
      };
    } catch (e) { /* 通知が使えなくても5秒巡回で追いつく */ }
  }

  /** 選んだレースの並び・選手名・車立てを盤面に反映する
      @param {boolean} auto 追従による自動適用（ヒント欄に出所を書く） */
  function applySelectedRace(auto) {
    var v = RaceCard.findVenue(venueSel.value);
    var r = RaceCard.findRace(v, raceSel.value);
    if (!v || !r) return;

    var raceCars = RaceCard.carsOf(r);

    State.set({
      sel: { joCode: String(v.joCode), raceNo: +r.no },
      raceCars: raceCars,
      names: RaceCard.namesOf(r),
      titleMain: v.name + ' ' + r.no + 'R',
      titleSub: [v.grade, r.cls, r.lineType].filter(Boolean).join('・')
    });

    if (r.narabi) { applyRaceNarabi(r.narabi, v, r, auto); return; }

    /* タイムテーブル側に並びが無いレースがある（本日は72中14）。保険経路を叩く */
    showAllRaceCars(raceCars);
    setHint(RaceCard.labelOf(v, r) + '：並び予想が未公開です。別経路で取得を試みています…');
    RaceCard.fetchNarabi(v.joCode, r.no).then(function (nb) {
      if (nb) { applyRaceNarabi(nb, v, r, auto); return; }
      setHint(RaceCard.labelOf(v, r) +
              '：並び予想がまだ出ていません。出走選手を横一列に並べたので、並び欄に手で入力してください。', true);
    });
  }

  /** 並びがまだ無いとき用。ライン無しで出走選手を横一列に置くだけ */
  function showAllRaceCars(raceCars) {
    var d = State.data;
    var solo = raceCars.map(function (no) { return [no]; });
    State.set({ lineupText: '', lines: [], cars: raceCars.slice() });
    State.setRiders(Lineup.layout(solo, d.dir, d.iconRatio));
    render();
  }

  function applyRaceNarabi(narabi, v, r, auto) {
    var d = State.data;
    var pool = (d.raceCars && d.raceCars.length) ? d.raceCars : null;
    var result = Lineup.apply(narabi, pool, d.dir, d.iconRatio);

    State.set({
      lineupText: narabi,
      lines: result.lines,
      cars: carsFromLines(result.lines)
    });
    State.setRiders(result.positions);
    render();

    if (nowRaceEl) nowRaceEl.textContent = RaceCard.labelOf(v, r);
    var msg = (auto ? '配信に追従　' : '') + RaceCard.labelOf(v, r) + ' → 並び ' + narabi;
    if (result.missing.length) {
      msg += '　／ 並びに無い ' + result.missing.join('・') + ' 番は盤面に出していません';
    }
    setHint(msg, result.missing.length > 0);
  }

  /* ---------- 初期化 ---------- */

  function buildRiders() {
    ridersEl.innerHTML = '';
    for (var no = 1; no <= CONFIG.MAX_CAR; no++) {
      var el = Icons.create(no);
      ridersEl.appendChild(el);
      riderEls[no] = el;

      Drag.enable(stageEl, el, {
        onMove: function (n, x, y) {
          State.moveRider(n, x, y);
          applyPosition(n, State.data.riders[n].x, State.data.riders[n].y);
          Bars.sync();   // 1台だけ動かしたら連結バーが折れて追従する
          publishLive();
        },
        onEnd: function () {
          State.save();
        }
      });
    }
  }

  function bindControls() {
    applyBtn.addEventListener('click', applyLineup);

    /* 手でレースを選んだら追従を外す＝実況の途中で勝手に飛ばされないようにするため。
       戻したいときはチェックを入れ直す（入れた瞬間に現在レースへ合わせる） */
    venueSel.addEventListener('change', function () {
      setFollowing(false);
      populateRaces();
      applySelectedRace();
    });
    raceSel.addEventListener('change', function () {
      setFollowing(false);
      applySelectedRace();   // ⚠️addEventListenerに直接渡すとEventがauto扱いになるので包む
    });
    followChk.addEventListener('change', function () {
      if (followChk.checked) { setHint('配信に追従します。'); showFollowDiff(null); followTick(true); }
      else setHint('追従を外しました。場とレースは手動のままになります。');
    });
    /* 警告そのものが復帰ボタン＝ズレに気づいた瞬間に1クリックで追い付ける */
    followDiffEl.addEventListener('click', function () {
      setFollowing(true, '配信に追従します。');
      showFollowDiff(null);
      followTick();
    });
    reloadBtn.addEventListener('click', function () { loadTimetable(true); });

    inputEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); applyLineup(); }
    });

    sizeRange.addEventListener('input', function () {
      var ratio = parseInt(sizeRange.value, 10) / 1000;
      State.set({ iconRatio: ratio });
      applyIconSize();
      sizeVal.textContent = (ratio * 100).toFixed(1) + '%';
    });

    /* リセット＝「今の並びのまま、自動配置をやり直す」。
       ドラッグで動かした分だけが取り消され、ラインは残る。
       以前は lines・lineupText ごと空に戻していたので、実況中に押すと連結バーまで消えて
       並びを入れ直すはめになっていた（8/12 Naoto指摘）。
       基準にするのは「最後に適用された並び」＝ State.data.lines。
       公式の並び予想か手入力かは問わない（手で直した並びを消さないため）。
       公式の並びを取り直したいときは、場・レースを選び直せば再取得される */
    resetBtn.addEventListener('click', function () {
      var d = State.data;

      if (d.lines && d.lines.length) {
        State.setRiders(Lineup.layout(d.lines, d.dir, d.iconRatio));
        render();
        setHint('並び ' + d.lines.map(function (l) { return l.join('-'); }).join(' / ') +
                ' の初期配置に戻しました。');
        return;
      }

      /* 並びがまだ無いレース（＝出走選手を横一列に置いた状態）は、その横一列に戻す */
      if (d.raceCars && d.raceCars.length) {
        showAllRaceCars(d.raceCars);
        setHint('出走選手を横一列に戻しました。');
        return;
      }

      /* レース未選択・並びも無い。ここだけは従来どおり丸ごと初期化 */
      State.reset();
      inputEl.value = '';
      render();
      setHint('初期配置に戻しました。');
    });

    window.addEventListener('resize', applyIconSize);
  }

  /**
   * URLパラメータで初期状態を指定できるようにする。
   * 例）index.html?narabi=1-3-5/2-7/4-6-9&cars=9&dir=right&bg=green&panel=0
   * OBSのブラウザソースやstagekit統合のときに効いてくる。
   */
  function applyUrlParams() {
    var q;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }

    /* 背景だけは残してある。OBSでクロマキー合成したいときの逃げ道 */
    var bg = q.get('bg');
    if (bg === 'green' || bg === 'normal') State.set({ bg: bg });

    var size = parseFloat(q.get('size'));
    if (isFinite(size)) {
      State.set({ iconRatio: State.clamp(size / 100, CONFIG.ICON_RATIO_MIN, CONFIG.ICON_RATIO_MAX) });
    }

    var narabi = q.get('narabi');
    if (narabi) {
      var d = State.data;
      var pool = (d.raceCars && d.raceCars.length) ? d.raceCars : null;
      var result = Lineup.apply(narabi, pool, d.dir, d.iconRatio);
      State.set({
        lineupText: narabi,
        lines: result.lines,
        cars: carsFromLines(result.lines)
      });
      State.setRiders(result.positions);
    }

    /* 場コード＋レース番号でレースを直接指定する（OBSのブラウザソース用） */
    var jo = q.get('jo');
    var rno = parseInt(q.get('race'), 10);
    if (jo && rno) pendingRace = { jo: String(jo), race: rno };

    if (q.get('panel') === '0') panelEl.style.display = 'none';
  }

  function init() {
    try {
      if (new URLSearchParams(location.search).get('view') === 'output') VIEW = 'output';
    } catch (e) {}
    document.body.classList.add('view-' + VIEW);
    /* テスト用バックエンド接続中の目印。ヒント欄は配信画面から見えないので盤面にも出す。
       ③の出走表とボードで別のバックエンドを掴むと「出走表8R・展開図6R」のズレが起きるため、
       どちらがテストかを画面上で見分けられるようにしておく（8/12に実際に踏んだ） */
    if (CONFIG.IS_TEST_BACKEND) document.body.classList.add('is-test');
    /* 常時追従のときは場・レース選択と追従チェックを隠す＝ボードでレースを選ぶ操作は無い。
       DOMには残す（コードから値を書き込むため）。?follow=0 のときだけ現れる */
    if (FOLLOW_MODE) document.body.classList.add('follow-auto');

    stageEl   = document.getElementById('stage');
    ridersEl  = document.getElementById('riders');
    barsEl    = document.getElementById('line-bars');
    panelEl   = document.getElementById('panel');
    hintEl    = document.getElementById('hint');
    inputEl   = document.getElementById('lineup-input');
    applyBtn  = document.getElementById('apply-btn');
    resetBtn  = document.getElementById('reset-btn');
    sizeRange = document.getElementById('size-range');
    sizeVal   = document.getElementById('size-val');
    venueSel  = document.getElementById('venue-select');
    raceSel   = document.getElementById('race-select');
    reloadBtn = document.getElementById('reload-btn');
    followChk = document.getElementById('follow-chk');
    followDiffEl = document.getElementById('follow-diff');
    nowRaceEl = document.getElementById('now-race');
    titleEl     = document.getElementById('stage-title');
    titleMainEl = document.getElementById('stage-title-main');
    titleSubEl  = document.getElementById('stage-title-sub');
    dirEl       = document.getElementById('stage-dir');
    liveDot     = document.getElementById('live-dot');

    sizeRange.min = String(Math.round(CONFIG.ICON_RATIO_MIN * 1000));
    sizeRange.max = String(Math.round(CONFIG.ICON_RATIO_MAX * 1000));

    /* 連結バーをドラッグしたとき、動いた分の丸の位置を反映して返すための橋渡し */
    Bars.init(stageEl, barsEl, function (nos) {
      nos.forEach(function (no) {
        applyPosition(no, State.data.riders[no].x, State.data.riders[no].y);
      });
      publishLive();
    });

    /* 出力ビューは書き込まない。OBSではドックとブラウザソースが
       同じlocalStorageを共有するため、出力側が書き戻すと操作側の保存を壊す */
    if (VIEW === 'output') State.setPersist(false);

    Live.init(VIEW, {
      onState: applyRemote,                        // 出力側：届いた状態を描く
      onHello: function () { publishLive(true); }, // 操作側：出力が起動したら即座に追いつかせる
      onWant:  function () { publishLive(true); }  // 操作側：聞き専の購読者（③オーバーレイ）の求めに応じる
    });

    State.load();
    buildRiders();
    bindControls();
    applyUrlParams();
    render();

    if (VIEW === 'control') {
      updateLiveDot();
      setInterval(updateLiveDot, 1000);
    }

    /* レイアウト確定後にもう一度だけアイコン径を合わせる */
    requestAnimationFrame(applyIconSize);

    /* 出走表は非同期で追いかける。取得できるまでは手入力で普通に使える。
       起動時は選択を復元するだけで、盤面には自動適用しない（前回の配置を消さないため）。
       出力ビューは操作側から状態が流れてくるので、自分では取りにいかない（GASへの無駄打ち防止） */
    if (VIEW === 'control') {
      loadTimetable(false);
      /* 配信への追従（8/12）。初回は時刻表の取得完了時に loadTimetable から1回走る
         （場コードを引くのに時刻表が要るため）。以降は一定間隔＝通知が届かなくても必ず追いつく土台。
         出力ビューは操作側から状態が流れてくるので追従しない＝GASを二重に叩かない */
      setInterval(followTick, CONFIG.FOLLOW_MS);
      initConsoleChannel();   // 保存の瞬間に届く高速経路＝出走表と同時に切り替わる
      /* OBSのドックは開きっぱなしで使うので、1回しか取らないと確実に古くなる。
         実際、深夜に開いたドックが「並びが1本も無い」時点のリストを持ち続けて
         全レースが「並び未」に見える事故が起きた（8/12）。stagekitのオーバーレイに
         合わせて10分ごとに取り直す。選択とヒント欄は壊さない（silent） */
      setInterval(function () { loadTimetable(false, true); }, 10 * 60 * 1000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
