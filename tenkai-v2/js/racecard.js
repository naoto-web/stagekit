/* ===========================================================
   racecard.js — 出走表・並び予想の取得

   データ元＝OKL配信システム（stagekit）のGASバックエンド。読み取り専用。

   ・action=timetable → 本日の全場・全レース（出走表＋並び予想が同梱）
     { date, source, venues:[ { name, joCode, grade,
         races:[ { no, start, cls, lineType, narabi, racers:[{no,name,pref,kyaku}] } ] } ] }
   ・action=narabi&jo=&race= → 並びの保険経路（timetable側が空のとき用）

   narabi の形式は「91624 5 738」＝スペースがライン区切り・左が先頭・数字は1桁ずつ。
   これは lineup.js のパーサーがそのまま food として食える形。
   =========================================================== */

var RaceCard = (function () {

  var timetable = null;

  function enabled() {
    return !!CONFIG.GAS_URL;
  }

  /** 本日のタイムテーブル（出走表＋並び）を取る */
  function fetchTimetable(refresh) {
    if (!enabled()) return Promise.reject(new Error('GAS_URLが未設定です'));
    var url = CONFIG.GAS_URL + '?action=timetable&day=0' + (refresh ? '&refresh=1' : '');
    return fetch(url, { redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || 'timetable fetch failed');
        timetable = j.timetable || null;
        return timetable;
      });
  }

  /** コンソール（OKL配信システム）が今どのレースを出しているかを読む。**読み取り専用**。
      ①トークの出走表・②の予想帯が見ているのと同じ「操作中の場＋そのレース」を返す。
      コンソール側は発走・②切替に合わせてここを自動で進めている（FB96・既定ON）ので、
      これに追従すればボードも手を触れずに現在レースへ揃う。
      @returns {Promise<{joCode:string, raceNo:number}|null>} 取れなければ null */
  function fetchConsoleRace() {
    if (!enabled()) return Promise.resolve(null);
    return fetch(CONFIG.GAS_URL + '?action=state', { redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (j) { return selFromState(j && j.ok ? j.state : null); })
      .catch(function () { return null; });
  }

  /** コンソールのstate → ボードが選ぶべきレース。
      GASから取った場合も、放送通知で届いた場合も同じ関数で解釈する（解釈が2か所に割れないように） */
  function selFromState(s) {
    if (!s || !s.venues || !s.venues.length) return null;
    var v = s.venues[s.activeVenue || 0];
    if (!v || !v.name) return null;
    var no = +(s.currentRace || {})[v.name] || 0;
    if (!no) return null;
    /* コンソールは場を「名前」で持つ。ボードは場コードで選ぶので時刻表で引き直す */
    var tv = null;
    venues().forEach(function (x) { if (x.name === v.name) tv = x; });
    return tv ? { joCode: String(tv.joCode), raceNo: no } : null;
  }

  /** 並びの保険経路。取れなければ空文字（失敗しても落とさない） */
  function fetchNarabi(joCode, raceNo) {
    if (!enabled()) return Promise.resolve('');
    var url = CONFIG.GAS_URL + '?action=narabi&jo=' + encodeURIComponent(joCode) +
              '&race=' + (+raceNo || 0);
    return fetch(url, { redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (j) { return (j && j.ok && j.narabi) ? String(j.narabi) : ''; })
      .catch(function () { return ''; });
  }

  /** 「山出 裕幸」→「山出」。
      keirin.jp の senName は姓名が半角スペース区切りで返ってくる（実データで確認済み）。
      万一区切りが無い場合だけ、日本人の姓で最も多い2文字で切る */
  function surname(full) {
    var s = String(full == null ? '' : full).replace(/[\s　]+/g, ' ').trim();
    if (!s) return '';
    var parts = s.split(' ');
    return parts.length > 1 ? parts[0] : s.slice(0, 2);
  }

  function venues() {
    return (timetable && timetable.venues) ? timetable.venues : [];
  }

  function findVenue(joCode) {
    var vs = venues();
    for (var i = 0; i < vs.length; i++) {
      if (String(vs[i].joCode) === String(joCode)) return vs[i];
    }
    return null;
  }

  function findRace(venue, raceNo) {
    if (!venue || !venue.races) return null;
    for (var i = 0; i < venue.races.length; i++) {
      if (+venue.races[i].no === +raceNo) return venue.races[i];
    }
    return null;
  }

  /** 出走している車番のリスト。
      6車立てのレースや欠車があるレースもあるので、人数ではなく車番そのものを返す */
  function carsOf(race) {
    var out = [];
    ((race && race.racers) || []).forEach(function (r) {
      var no = +r.no;
      if (no >= 1 && no <= CONFIG.MAX_CAR && out.indexOf(no) === -1) out.push(no);
    });
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  /** 車番→苗字 のマップ */
  function namesOf(race) {
    var out = {};
    ((race && race.racers) || []).forEach(function (r) {
      var no = +r.no;
      if (no >= 1 && no <= CONFIG.MAX_CAR) out[no] = surname(r.name);
    });
    return out;
  }

  /** 表示用のレース見出し（例：和歌山 7R Ｓ級特選・三分戦） */
  function labelOf(venue, race) {
    var s = (venue ? venue.name : '') + ' ' + (race ? race.no : '') + 'R';
    var sub = [];
    if (race && race.cls) sub.push(race.cls);
    if (race && race.lineType) sub.push(race.lineType);
    return sub.length ? (s + ' ' + sub.join('・')) : s;
  }

  return {
    enabled: enabled,
    get timetable() { return timetable; },
    venues: venues,
    fetchTimetable: fetchTimetable,
    fetchNarabi: fetchNarabi,
    fetchConsoleRace: fetchConsoleRace,
    selFromState: selFromState,
    findVenue: findVenue,
    findRace: findRace,
    carsOf: carsOf,
    namesOf: namesOf,
    labelOf: labelOf,
    surname: surname
  };
})();
