/* ===========================================================
   main.js — 起動・描画・イベント結線  v2（バンク1周・オーバル）

   v1から変わったところ（要件定義_v2）
     ・盤面は1枚のSVG（board.js）。位置は (d, lane)＝周回位置・内外
     ・局面ボタン（スタート〜ゴールの7つ）／ホイール・矢印キーで全体送り
     ・取り消し・やり直し（Ctrl+Z / Ctrl+Y）
     ・出力は届いた状態へ滑らかに追いつく（Anim.Smoother）
     ・出力は旧ドック（v1の (x, y)）の状態も互換描画する＝公開直後にドックを開き直すまで③が空にならない
   v1から変えていないところ：配信への追従（日付込みの sameRace）・2画面・GAS読み取り専用・?gas=
   =========================================================== */

(function () {

  var stageEl, panelEl, hintEl;
  var inputEl, applyBtn, resetBtn, sizeRange, sizeVal, undoBtn, redoBtn;
  var venueSel, raceSel, reloadBtn, followChk, followDiffEl, nowRaceEl, liveDot;
  var phaseBtns = [];
  var verbBtns = [], selLabelEl;
  var sel = null;          // 選択中（v2.1）＝ { type:'rider'|'line', nos:[…] }。ドックだけ・保存も配信もしない
  var pendingRace = null;   // URLで指定されたレース（出走表の取得完了後に適用する）

  /* 'control'＝操作画面（OBSのカスタムブラウザドックに入れる）
     'output' ＝出力画面（OBSのブラウザソースに入れる）。?view=output で切り替える */
  var VIEW = 'control';
  var lastRemoteSig = '';   // 出力側で「構造が変わったか」を見るための署名
  var smoother = null;      // 出力側の追いつき表示

  /* ---------- 描画 ---------- */

  /** 状態を丸ごと画面に反映する（構造が変わったとき） */
  function render() {
    var ph = Board.render(State.data);
    publishLive(true);
    syncControls(ph);
    schedulePrepare();
  }

  /* スタートの升目→並びの一列の「通り道の計画」は計算に約1秒かかる。
     赤板を押してから止まって見えないよう、並びが決まったら裏で先に計算しておく（同じ並びなら2回目以降は即時）。
     戻す（→スタート）は同じ道の逆再生なので計算は要らない */
  var prepareTimer = null;
  function schedulePrepare() {
    if (VIEW !== 'control') return;
    clearTimeout(prepareTimer);
    prepareTimer = setTimeout(function () {
      var d = State.data;
      if (!d.cars || d.cars.length < 2 || Anim.busy()) return;
      try { Anim.prepare(Lineup.grid(d.cars), lineFormation(CONFIG.PHASES[1].d)); } catch (e) {}
    }, 600);
  }

  /** 位置だけ反映する（ドラッグ・アニメ・全体送りの途中） */
  function renderPositions() {
    var ph = Board.positions(State.data);
    publishLive();
    syncPhaseButtons(ph);
  }

  /** コントロールの表示状態を state に合わせる */
  function syncControls(ph) {
    var d = State.data;
    sizeRange.value = String(Math.round(d.iconRatio * 1000));
    sizeVal.textContent = (d.iconRatio * 100).toFixed(1) + '%';
    if (document.activeElement !== inputEl) inputEl.value = d.lineupText;
    syncPhaseButtons(ph);
  }

  /** 局面ボタン：いまの局面を光らせる／取り消しボタンの可否 */
  function syncPhaseButtons(ph) {
    var key = ph ? ph.key : '';
    phaseBtns.forEach(function (b) { b.classList.toggle('is-on', b.dataset.phase === key); });
    if (undoBtn) undoBtn.disabled = !Undo.canUndo();
    if (redoBtn) redoBtn.disabled = !Undo.canRedo();
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

    /* 検証の母集合は raceCars（今の表示 cars ではない）＝一度消した車番を書き戻せるように */
    var pool = (d.raceCars && d.raceCars.length) ? d.raceCars : null;
    var result = Lineup.apply(text, pool);

    Anim.stop();
    Undo.push();
    State.set({
      lineupText: text,
      lines: result.lines,
      cars: carsFromLines(result.lines)
    });
    State.setRiders(Lineup.grid(carsFromLines(result.lines)));   // スタート＝車番順の升目
    render();

    var shown = result.lines.map(function (l) { return l.join('-'); }).join(' / ');
    var msg = '配置しました（スタートは車番順・赤板で並びの一列になります）： ' + shown;
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

  /* ---------- 全体送り（要件定義_v2 §6.4） ---------- */

  /** 全体を delta 周だけ進める（負なら戻す）。先頭はゴールより先へ行かない・最後尾は上限で止める＝間隔を崩さない */
  function clampAdvance(delta) {
    var d = State.data, lead = null, tail = null;
    d.cars.forEach(function (no) {
      var r = d.riders[no];
      if (!r) return;
      if (lead === null || r.d < lead) lead = r.d;
      if (tail === null || r.d > tail) tail = r.d;
    });
    if (lead === null) return 0;
    if (delta > 0) return Math.min(delta, lead);                     // ゴール線で止まる
    return Math.max(delta, tail - CONFIG.D_MAX);                     // 後ろは上限まで
  }

  var saveTimer = null;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { State.save(); }, 400);
  }

  /** ホイール・矢印キー用。即時に動かす（出力側は Smoother で滑らかになる） */
  function advance(delta) {
    Anim.stop();
    State.data.finish = null;
    var dd = clampAdvance(delta);
    if (!dd) return;
    Undo.push('wheel');
    var d = State.data;
    d.cars.forEach(function (no) {
      var r = d.riders[no];
      if (r) State.moveRider(no, r.d - dd, r.lane);
    });
    renderPositions();
    saveSoon();
  }

  /** 並びの一列（ライン順・全員内）。並びが無いレースは車番順の単騎 */
  function lineFormation(headD) {
    var d = State.data;
    var lines = (d.lines && d.lines.length) ? d.lines : d.cars.map(function (no) { return [no]; });
    return Lineup.layout(lines, headD);
  }

  /** 先頭の d（与えた隊形の中で最小） */
  function headOf(pos) {
    var h = null;
    Object.keys(pos).forEach(function (no) { if (h === null || pos[no].d < h) h = pos[no].d; });
    return h;
  }

  /** 局面ボタン：先頭がその局面の位置に来るまで全員を進める（戻す）。アニメ付き。
      隊形の切り替え（9/27 Naoto）：
        スタート → それ以外 ＝ 車番順の升目から、走りながら並びの一列（ライン順・全員内）へ
        それ以外 → スタート ＝ 逆走しながら升目へ戻る
        それ以外どうし        ＝ 今の隊列のまま全員を同じ量だけ（手で動かした形を崩さない） */
  function jumpPhase(key) {
    State.data.finish = null;
    var ph = null;
    CONFIG.PHASES.forEach(function (p) { if (p.key === key) ph = p; });
    var lead = State.leaderD();
    if (!ph || lead === null) return;
    var d = State.data;
    var cur = Board.phaseOf(lead);
    var fromStart = !!cur && cur.key === 'start';
    var target = null, hint;

    if (key === 'start') {
      target = Lineup.grid(d.cars, ph.d);
      hint = 'スタート（車番順）に戻しました。';
    } else if (fromStart) {
      target = lineFormation(ph.d);
      hint = ph.label + 'へ。走りながら並び（' + (d.lines || []).map(function (l) { return l.join(''); }).join(' ') + '）の一列になりました。';
    }

    if (target) {
      /* 升目⇔一列：選手ごとに行き先が違う */
      var tHead = headOf(target);
      var same = Object.keys(target).every(function (no) {
        var r = d.riders[no];
        return r && Math.abs(r.d - target[no].d) < 1e-6 && Math.abs(r.lane - target[no].lane) < 1e-6;
      });
      if (same) { setHint(ph.label + 'の位置です。'); return; }
      Undo.push();
      Anim.reform(target, {
        dd: tHead - lead,
        lapIfWhole: true,
        onFrame: function () { renderPositions(); },
        onDone: function () { State.save(); publishLive(true); }
      });
      setHint(hint + ' ホイール（奥へ＝進む／手前へ＝戻す）や → ← キーで少しずつ動かせます。');
      return;
    }

    var delta = clampAdvance(lead - ph.d);
    if (Math.abs(delta) < 1e-6) { setHint(ph.label + 'の位置です。'); return; }

    Undo.push();
    target = {};
    d.cars.forEach(function (no) {
      var r = d.riders[no];
      if (r) target[no] = { d: r.d - delta, lane: r.lane };
    });
    Anim.to(target, {
      dd: -delta,
      onFrame: function () { renderPositions(); },
      onDone: function () { State.save(); publishLive(true); }
    });
    setHint(ph.label + 'へ進めました。ホイール（奥へ＝進む／手前へ＝戻す）や → ← キーで少しずつ動かせます。');
  }

  /* ---------- 選択と動詞ボタン（v2.1・要件定義_v2 §6.1 / §6.5） ---------- */

  /** 選択を変える。丸を掴む＝その1台、帯を掴む＝ライン全員、盤面の空きをクリック＝解除 */
  function setSel(s) {
    sel = (s && s.nos && s.nos.length) ? s : null;
    Board.setSelected(sel ? sel.nos : []);
    if (!selLabelEl) return;
    if (!sel) {
      selLabelEl.textContent = '選択なし（丸かラインをクリック）';
      selLabelEl.classList.add('is-empty');
      return;
    }
    selLabelEl.classList.remove('is-empty');
    selLabelEl.textContent = '選択中：' + (sel.type === 'line'
      ? 'ライン ' + sel.nos.join('')
      : Verbs.label(sel.nos[0]));
  }

  /** 動詞ボタン：通り道を作って動かす。できないときは理由をヒント欄に出して何もしない */
  function runVerb(key) {
    if (VIEW !== 'control') return;
    Anim.stop();
    var res = Verbs.run(key, sel);
    if (!res || res.error) { setHint((res && res.error) || 'この動きはできません', true); return; }
    if (res.finish) { doFinish(res.finish, res.hint); return; }   // 最終ストレートの差し・突き抜け・ズブズブ＝3着までゴール
    State.data.finish = null;
    Undo.push();
    Anim.path(res.paths, {
      ms: res.long ? Math.round(CONFIG.ANIM.verbMs * 1.5) : CONFIG.ANIM.verbMs,
      onFrame: function () { renderPositions(); },
      onDone: function () { State.save(); publishLive(true); }
    });
    setHint(res.hint + '。（取り消しで元に戻せます）');
  }
  /** 決着（9/27 Naoto）：着順 order（上位3人）で、今の位置からゴールまで走り切る。
      最終周回（先頭が最終ホームより前）でだけ使える。追い抜く選手の通り道は升目⇔一列と同じ計画（重ならない道）。
      計画に約1秒かかるので、ヒントを先に出してから計算する */
  function doFinish(order, hint) {
    var lead = State.leaderD();
    if (lead === null) return;
    if (lead > 1.0 + 1e-6) { setHint('決着は最終周回（最終ホーム以降）で使ってください', true); return; }
    Anim.stop();
    var target = Verbs.finishTarget(order);
    Undo.push();
    State.data.finish = null;
    setHint('決着 ' + order.join('-') + ' を計算しています…');
    setTimeout(function () {
      Anim.reform(target, {
        dd: 0 - lead,
        ms: CONFIG.ANIM.finishMs,
        onFrame: function () { renderPositions(); },
        onDone: function (ok) {
          if (ok) State.set({ finish: order.slice(0, 3) });
          State.save();
          renderPositions();
          publishLive(true);
        }
      });
      setHint((hint ? hint + '。' : '') + '決着 ' + order.join('-') + '（取り消しで元に戻せます）');
    }, 30);
  }

  /** 3連単の欄＋「決着」ボタン */
  function runTrifecta() {
    if (VIEW !== 'control') return;
    var el = document.getElementById('trifecta-input');
    var r = Verbs.parseTrifecta(el ? el.value : '');
    if (r.error) { setHint(r.error, true); return; }
    doFinish(r.finish, '3連単 ' + r.finish.join('-'));
  }
  /* ---------- 取り消し ---------- */

  function doUndo() {
    Anim.stop();
    if (Undo.undo()) { render(); setHint('1手戻しました。'); }
  }
  function doRedo() {
    Anim.stop();
    if (Undo.redo()) { render(); setHint('やり直しました。'); }
  }

  /* ---------- 出力画面との同期 ---------- */

  function publishLive(force) {
    if (VIEW === 'control') Live.publish(State.data, force);
  }

  /** 旧ドック（v1＝riders が {x, y}）の状態を v2 の (d, lane) へ粗く写す（要件定義_v2 §8）。
      公開.ps1 で出力は自動で新しくなるが、ドックは開き直すまで旧版のまま＝その間も③を空にしない。
      v1は「左が先頭」の帯。x の小さい順に前から並べ、横の間隔をそのままコース上の距離にする。
      y は 帯の下寄り（0.5以上）＝内／中ほど＝中／上＝外 */
  function fromV1(d) {
    var out = {};
    for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k];
    out.v = 2;
    var riders = {}, xmin = null;
    var src = d.riders || {};
    Object.keys(src).forEach(function (no) {
      var r = src[no];
      if (r && typeof r.x === 'number' && (xmin === null || r.x < xmin)) xmin = r.x;
    });
    Object.keys(src).forEach(function (no) {
      var r = src[no];
      if (!r || typeof r.x !== 'number' || typeof r.y !== 'number') return;
      var lane = r.y >= 0.5 ? -1 : (r.y >= 0.35 ? 0 : 1);
      riders[no] = { d: 1.0 + (r.x - xmin) * CONFIG.TRACK.W / CONFIG.LAP, lane: lane };
    });
    out.riders = riders;
    return out;
  }

  /** 出力側：操作側から届いた状態を反映する。
      構造（出走車・ライン・名前・見出し等）が変わったときだけ作り直し、それ以外は位置だけ追いつく */
  function applyRemote(d) {
    if (!d) return;
    if (d.v !== 2) d = fromV1(d);
    State.set(State.sanitize(d));

    var sig = JSON.stringify([d.cars, d.lines, d.names, d.titleMain, d.titleSub,
                              d.iconRatio, d.bg, d.showBars, d.showNames, d.sel]);
    if (sig !== lastRemoteSig) {
      lastRemoteSig = sig;
      smoother.jump(State.copyRiders(State.data.riders));
      Board.render(State.data, smoother.view);
      return;
    }
    smoother.setTarget(State.copyRiders(State.data.riders));
  }

  /** 接続インジケータ */
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

  /* ---------- 配信への追従（v1から変更なし） ----------
     **出走表と展開ボードのレースは常に一致させる**（Naoto確定）。
     受け取り方は2経路：①放送通知（`live-sync-v1`）＝即時 ②5秒ごとのGAS読み取り＝土台
     ⚠️追従でレースが変わると盤面は組み直される（手で動かした隊列・取り消しの履歴は消える）。
     緊急時のみ `?follow=0` で手動モード */
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

  /** いま読み込んでいる時刻表の日付（yyyyMMdd）＝盤面が「どの日の出走表」で組まれたかの印 */
  function ttDate() {
    var tt = RaceCard.timetable;
    return (tt && tt.date) ? String(tt.date) : '';
  }

  /** ローカルの今日（yyyyMMdd）。時刻表が届く前に保存データの鮮度を見るためだけに使う */
  function localDateStr() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }

  /** 盤面がいま出しているレースと、配信のレースが同じか。
      ⚠️**必ず日付ごと比べる**。場コードとR番号だけで比べると、翌日の同じ場・同じRを
         「同じレース」と誤判定して盤面を組み直さない（9/21の事故＝前日の弥彦9Rが配信に出た）。
      日付の無い旧保存データ（cur.date=''）は常に false ＝1回だけ必ず組み直される */
  function sameRace(cur, sel) {
    if (!cur || !sel) return false;
    return !!cur.date && cur.date === ttDate() &&
           String(cur.joCode) === sel.joCode && +cur.raceNo === sel.raceNo;
  }

  /** 追従OFFのあいだ「配信は今どこか」を出す（ズレているときだけ赤く） */
  function showFollowDiff(sel) {
    if (!followDiffEl) return;
    var cur = State.data.sel;
    var same = !sel || sameRace(cur, sel);
    if (isFollowing() || same || !sel) { followDiffEl.textContent = ''; followDiffEl.hidden = true; return; }
    var v = RaceCard.findVenue(sel.joCode);
    followDiffEl.textContent = '配信は ' + (v ? v.name : '') + ' ' + sel.raceNo + 'R';
    followDiffEl.hidden = false;
  }

  /** コンソールのレースを盤面に反映する。放送通知とGAS読み取りの共通の受け口 */
  function applyConsoleSel(sel) {
    if (!sel) return;
    if (!isFollowing()) { showFollowDiff(sel); return; }
    /* すでに同じレースなら何もしない＝盤面を毎回作り直さない（手で動かした隊列を消さない）。
       ⚠️同一判定は sameRace＝**日付込み**。ここを場＋Rだけに戻すと前日の盤面が残る（9/21） */
    var cur = State.data.sel;
    if (sameRace(cur, sel)) { showFollowDiff(sel); return; }
    var v = RaceCard.findVenue(sel.joCode);
    if (!v || !RaceCard.findRace(v, sel.raceNo)) return; // 時刻表にまだ無い＝次の巡回で拾う
    venueSel.value = sel.joCode;
    populateRaces();
    raceSel.value = String(sel.raceNo);
    applySelectedRace(true);
    showFollowDiff(sel);
  }

  /* 通知が届いている間はGASを読む回数を落とす（GASの実行枠は全オーバーレイと共用） */
  var lastBcAt = 0;
  function followDue(now) {
    var bcAlive = lastBcAt && (now - lastBcAt) < 120000;
    return bcAlive ? CONFIG.FOLLOW_MS_BC : CONFIG.FOLLOW_MS;
  }
  var lastFollowAt = 0;
  function followTick(force) {
    if (!RaceCard.enabled()) return;
    var now = Date.now();
    if (!force && lastFollowAt && (now - lastFollowAt) < followDue(now)) return;
    lastFollowAt = now;
    RaceCard.fetchConsoleRace().then(applyConsoleSel);
  }

  /* 放送通知の経路。⚠️必ず聞き専（pongを返すとコンソールの疎通テストが嘘をつく） */
  function initConsoleChannel() {
    if (VIEW !== 'control' || typeof BroadcastChannel === 'undefined') return;
    try {
      var ch = new BroadcastChannel('live-sync-v1' + (CONFIG.IS_TEST_BACKEND ? '-test' : ''));
      ch.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.type !== 'state' || !m.state) return;
        lastBcAt = Date.now();
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
    Anim.stop();
    Undo.clear();   // 別レースの手を戻せてはいけない（§6.6）
    setSel(null);

    State.set({
      /* date＝この出走表を読んだ時刻表の日付。翌日の同じ場・同じRと見分ける唯一の手がかり */
      sel: { date: ttDate(), joCode: String(v.joCode), raceNo: +r.no },
      raceCars: raceCars,
      names: RaceCard.namesOf(r),
      titleMain: v.name + ' ' + r.no + 'R',
      titleSub: [v.grade, r.cls, r.lineType].filter(Boolean).join('・')
    });

    if (r.narabi) { applyRaceNarabi(r.narabi, v, r, auto); return; }

    showAllRaceCars(raceCars);
    setHint(RaceCard.labelOf(v, r) + '：並び予想が未公開です。別経路で取得を試みています…');
    RaceCard.fetchNarabi(v.joCode, r.no).then(function (nb) {
      if (nb) { applyRaceNarabi(nb, v, r, auto); return; }
      setHint(RaceCard.labelOf(v, r) +
              '：並び予想がまだ出ていません。出走選手を1列に並べたので、並び欄に手で入力してください。', true);
    });
  }

  /** 並びがまだ無いとき用。ライン無しで出走選手をスタートに1列で置くだけ */
  function showAllRaceCars(raceCars) {
    var solo = raceCars.map(function (no) { return [no]; });
    State.set({ lineupText: '', lines: [], cars: raceCars.slice() });
    State.setRiders(Lineup.grid(raceCars));
    render();
  }

  function applyRaceNarabi(narabi, v, r, auto) {
    var d = State.data;
    var pool = (d.raceCars && d.raceCars.length) ? d.raceCars : null;
    var result = Lineup.apply(narabi, pool);

    State.set({
      lineupText: narabi,
      lines: result.lines,
      cars: carsFromLines(result.lines)
    });
    State.setRiders(Lineup.grid(carsFromLines(result.lines)));   // スタート＝車番順の升目
    render();

    if (nowRaceEl) nowRaceEl.textContent = RaceCard.labelOf(v, r);
    var msg = (auto ? '配信に追従　' : '') + RaceCard.labelOf(v, r) + ' → 並び ' + narabi;
    if (result.missing.length) {
      msg += '　／ 並びに無い ' + result.missing.join('・') + ' 番は盤面に出していません';
    }
    setHint(msg, result.missing.length > 0);
  }

  /* ---------- 初期化 ---------- */

  function bindDrag() {
    for (var no = 1; no <= CONFIG.MAX_CAR; no++) {
      Drag.enableRider(Board.riderEl(no), no, {
        onStart: function (n) { Anim.stop(); Undo.push(); Board.raise(n); setSel({ type: 'rider', nos: [n] }); },
        onMove: function () { renderPositions(); },
        onEnd: function (n, moved) {
          if (!moved) Undo.dropLast();
          renderPositions();
          publishLive(true);
          State.save();
        }
      });
    }
    /* 連結バーは並びが変わるたびに作り直されるので、作られた時点で結線する */
    Bars.onCreate = function (item) {
      Drag.enableLine(item, {
        onStart: function (nos) { Anim.stop(); Undo.push(); setSel({ type: 'line', nos: nos.slice() }); },
        onMove: function () { renderPositions(); },
        onEnd: function (nos, moved) {
          if (!moved) Undo.dropLast();
          renderPositions();
          publishLive(true);
          State.save();
        }
      });
    };
  }

  function bindControls() {
    applyBtn.addEventListener('click', applyLineup);

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
      render();
    });

    /* 局面ボタン */
    phaseBtns.forEach(function (b) {
      b.addEventListener('click', function () { jumpPhase(b.dataset.phase); });
    });
    undoBtn.addEventListener('click', doUndo);
    verbBtns.forEach(function (b) {
      b.addEventListener('click', function () { runVerb(b.dataset.verb); });
    });
    var triBtn = document.getElementById('trifecta-btn'), triIn = document.getElementById('trifecta-input');
    if (triBtn) triBtn.addEventListener('click', runTrifecta);
    if (triIn) triIn.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); runTrifecta(); } });
    redoBtn.addEventListener('click', doRedo);

    /* ホイール＝全体送り（奥へ回す＝進む／手前へ回す＝戻す）。1ノッチ＝0.5車身。
       トラックパッドの細かい量はためてから1ノッチぶんずつ動かす */
    /* 出力ビュー（OBSのブラウザソース）では操作を受け付けない */
    if (VIEW !== 'control') return;

    /* 盤面の空き（選手・帯以外）を押したら選択を外す */
    stageEl.addEventListener('pointerdown', function (ev) {
      var t = ev.target;
      if (t && t.closest && (t.closest('.rider') || t.closest('.line-bar-hit'))) return;
      setSel(null);
    });

    var wheelAcc = 0;
    stageEl.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var unit = ev.deltaMode === 1 ? 3 : (ev.deltaMode === 2 ? 1 : 100);
      wheelAcc += ev.deltaY / unit;
      var notches = wheelAcc > 0 ? Math.floor(wheelAcc) : Math.ceil(wheelAcc);
      if (!notches) return;
      wheelAcc -= notches;
      advance(-notches * CONFIG.WHEEL_STEP);
    }, { passive: false });

    /* キー：→ 進む／← 戻す（0.5車身）・Shift付きは2車身／Ctrl+Z 取り消し／Ctrl+Y・Ctrl+Shift+Z やり直し */
    document.addEventListener('keydown', function (ev) {
      var tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      var k = ev.key;
      if ((ev.ctrlKey || ev.metaKey) && (k === 'z' || k === 'Z')) {
        ev.preventDefault();
        if (ev.shiftKey) doRedo(); else doUndo();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && (k === 'y' || k === 'Y')) { ev.preventDefault(); doRedo(); return; }
      if (k === 'ArrowRight' || k === 'ArrowLeft') {
        ev.preventDefault();
        var step = ev.shiftKey ? 4 * CONFIG.WHEEL_STEP : CONFIG.WHEEL_STEP;
        advance(k === 'ArrowRight' ? step : -step);
      }
    });

    /* 配置を戻す＝「今の並びのまま、スタートの隊列を作り直す」（ラインは消えない） */
    resetBtn.addEventListener('click', function () {
      var d = State.data;
      Anim.stop();

      if (d.lines && d.lines.length) {
        Undo.push();
        State.setRiders(Lineup.grid(d.cars));
        render();
        setHint('スタート（車番順）に戻しました。赤板で並び ' + d.lines.map(function (l) { return l.join('-'); }).join(' / ') +
                ' の一列になります。（取り消しで元に戻せます）');
        return;
      }
      if (d.raceCars && d.raceCars.length) {
        Undo.push();
        showAllRaceCars(d.raceCars);
        setHint('出走選手を1列に戻しました。');
        return;
      }
      Undo.push();
      State.reset();
      inputEl.value = '';
      render();
      setHint('初期配置に戻しました。');
    });
  }

  /**
   * URLパラメータで初期状態を指定できるようにする。
   * 例）index.html?narabi=1-3-5/2-7/4-6-9&bg=green&panel=0&phase=back
   */
  function applyUrlParams() {
    var q;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }

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
      var result = Lineup.apply(narabi, pool);
      State.set({
        lineupText: narabi,
        lines: result.lines,
        cars: carsFromLines(result.lines)
      });
      State.setRiders(Lineup.grid(carsFromLines(result.lines)));
    }

    var jo = q.get('jo');
    var rno = parseInt(q.get('race'), 10);
    if (jo && rno) pendingRace = { jo: String(jo), race: rno };

    if (q.get('panel') === '0') panelEl.style.display = 'none';
    return q;
  }

  function init() {
    try {
      if (new URLSearchParams(location.search).get('view') === 'output') VIEW = 'output';
    } catch (e) {}
    document.body.classList.add('view-' + VIEW);
    /* テスト用バックエンド接続中の目印（盤面にも出す） */
    if (CONFIG.IS_TEST_BACKEND) document.body.classList.add('is-test');
    if (FOLLOW_MODE) document.body.classList.add('follow-auto');

    stageEl   = document.getElementById('stage');
    panelEl   = document.getElementById('panel');
    hintEl    = document.getElementById('hint');
    inputEl   = document.getElementById('lineup-input');
    applyBtn  = document.getElementById('apply-btn');
    resetBtn  = document.getElementById('reset-btn');
    sizeRange = document.getElementById('size-range');
    sizeVal   = document.getElementById('size-val');
    undoBtn   = document.getElementById('undo-btn');
    redoBtn   = document.getElementById('redo-btn');
    venueSel  = document.getElementById('venue-select');
    raceSel   = document.getElementById('race-select');
    reloadBtn = document.getElementById('reload-btn');
    followChk = document.getElementById('follow-chk');
    followDiffEl = document.getElementById('follow-diff');
    nowRaceEl = document.getElementById('now-race');
    liveDot   = document.getElementById('live-dot');
    phaseBtns = Array.prototype.slice.call(document.querySelectorAll('[data-phase]'));
    verbBtns = Array.prototype.slice.call(document.querySelectorAll('[data-verb]'));
    selLabelEl = document.getElementById('sel-label');

    sizeRange.min = String(Math.round(CONFIG.ICON_RATIO_MIN * 1000));
    sizeRange.max = String(Math.round(CONFIG.ICON_RATIO_MAX * 1000));

    Board.init(stageEl);

    /* 出力ビューは書き込まない。OBSではドックとブラウザソースが
       同じlocalStorageを共有するため、出力側が書き戻すと操作側の保存を壊す */
    if (VIEW === 'output') {
      State.setPersist(false);
      smoother = new Anim.Smoother(function (view) { Board.positions(State.data, view); });
    }

    Live.init(VIEW, {
      onState: applyRemote,
      onHello: function () { publishLive(true); },
      onWant:  function () { publishLive(true); }
    });

    State.load();

    /* 別の日に組んだ盤面は、開いた瞬間に捨てる（9/21の事故の本丸）。
       ⚠️時刻表の到着を待ってから判断してはいけない。すぐ下の render() が出力ビューへ
          publish するので、待っているあいだに**前日の絵が配信に出る**。
       ⚠️出力ビューでも実行する＝ドックを開かずに③へ切り替えたときの最後の砦。 */
    if (State.data.sel.date && State.data.sel.date !== localDateStr()) State.clearRace();

    if (VIEW === 'control') bindDrag();
    bindControls();
    var q = applyUrlParams();
    if (VIEW === 'output') smoother.jump(State.copyRiders(State.data.riders));
    render();

    /* 撮影・検証用：?phase=back 等で起動直後にその局面へ（アニメなし） */
    var startPhase = q && q.get('phase');
    if (startPhase && VIEW === 'control') {
      var ph = null;
      CONFIG.PHASES.forEach(function (p) { if (p.key === startPhase) ph = p; });
      var lead = State.leaderD();
      if (ph && lead !== null) {
        var dd = clampAdvance(lead - ph.d);
        State.data.cars.forEach(function (no) {
          var r = State.data.riders[no];
          if (r) State.moveRider(no, r.d - dd, r.lane);
        });
        render();
      }
    }

    if (VIEW === 'control') {
      updateLiveDot();
      setInterval(updateLiveDot, 1000);
      loadTimetable(false);
      setInterval(followTick, CONFIG.FOLLOW_MS);
      initConsoleChannel();
      /* OBSのドックは開きっぱなしで使うので、10分ごとに時刻表を取り直す */
      setInterval(function () { loadTimetable(false, true); }, 10 * 60 * 1000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
