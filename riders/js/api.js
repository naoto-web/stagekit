/* ===========================================================
   api.js — GASとの通信・自前集計ファイルの読み込み・共通の小物
   =========================================================== */

var API = (function () {

  function qs(obj) {
    return Object.keys(obj).filter(function (k) { return obj[k] !== undefined && obj[k] !== null && obj[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]); }).join('&');
  }

  /** 読み取り。GASのdoGetはリダイレクトを返すのでfetchの既定（follow）に任せる */
  function get(action, params) {
    var p = params || {};
    p.action = action;
    p.key = CONFIG.KEY;
    return fetch(CONFIG.GAS_URL + '?' + qs(p), { method: 'GET' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '取得に失敗しました');
        return j;
      });
  }

  /** 書き込み。GASのdoPostはCORSプリフライトを避けるため text/plain で送る */
  function post(action, body) {
    var payload = Object.assign({}, body || {}, { action: action, key: CONFIG.KEY });
    return fetch(CONFIG.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '保存に失敗しました');
        return j;
      });
  }

  /* ── 自前集計（静的ファイル）。無くてもアプリは動く ──
     🔑期間（4／8／12ヶ月）ごとに別ファイル・別キャッシュ（2026-09-24 §41）。
        同じセッションで一度読んだ窓は読み直さない＝切り替えを行き来しても通信は窓ごとに1回。
     ⚠️取れなかったとき（まだ公開されていない窓など）は**キャッシュしない**＝次に押したらもう一度取りに行く。
        返す箱に `missing: true` を立てるので、画面はそれを見て「この期間の集計はまだありません」と出せる。 */
  var statsCache = {};
  function stats(months) {
    var m = String(months || '4');
    if (statsCache[m]) return Promise.resolve(statsCache[m]);
    var url = (CONFIG.STATS_URLS && CONFIG.STATS_URLS[m]) || CONFIG.STATS_URL;
    return fetch(url + '?cb=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (j) {
        if (!j) return { riders: {}, missing: true, months: m };
        statsCache[m] = j;
        return j;
      });
  }

  return {
    get: get,
    post: post,
    stats: stats,
    roster: function (kyuhan) { return get('roster', { kyuhan: kyuhan }); },
    rider: function (reg) { return get('rider', { reg: reg }); },
    comments: function (reg) { return get('comments', { reg: reg }); },
    card: function (reg) { return get('card', { reg: reg }); },
    racecard: function (day, refresh) { return get('racecard', { day: day, refresh: refresh ? 1 : '' }); },
    ping: function () { return fetch(CONFIG.GAS_URL + '?action=ping').then(function (r) { return r.json(); }); },
    addObs: function (obs) { return post('addObs', { obs: obs }); },
    patchObs: function (id, patch) { return post('patchObs', { id: id, patch: patch }); },
    saveMemo: function (reg, memo) { return post('saveMemo', { reg: reg, memo: memo }); },
    syncProfile: function (reg) { return post('syncProfile', { reg: reg }); }
  };
})();

/* ══════════ DOMの小物 ══════════ */

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

function $(sel) { return document.querySelector(sel); }

/** 車番の丸（展開ボードと同じ配色） */
function carChip(no) {
  var c = CONFIG.COLORS[no] || { bg: '#888', fg: '#fff' };
  var e = el('span', 'car', no);
  e.style.background = c.bg;
  e.style.color = c.fg;
  return e;
}

/** 苗字だけ（表示が長くなるところ用） */
function surname(name) {
  return String(name || '').split(/[\s　]+/)[0] || '';
}

function roleLabel(key) {
  for (var i = 0; i < CONFIG.ROLES.length; i++) if (CONFIG.ROLES[i].key === key) return CONFIG.ROLES[i].label;
  return key || '';
}

/** 「1.2%」のような表示。分母が0なら「—」
    🔑小数第1位まで必ず出す（2026-09-23 Naoto「50%じゃなくて50.0%。桁を合わせるために」）。
       `Math.round(…)/10` だけだと 50 や 0 のとき小数が消え、
       戦法別の表で列の桁がずれて数字を見比べにくくなる。
       丸め方は変えていない（表示の桁を固定するだけ）。 */
function pct(n, d) {
  if (!d) return '—';
  return (Math.round((n / d) * 1000) / 10).toFixed(1) + '%';
}

function toast(msg, isErr) {
  var t = document.getElementById('toast');
  if (!t) {
    t = el('div', 'toast');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.dataset.err = isErr ? '1' : '';
  t.classList.add('is-on');
  clearTimeout(t._tm);
  t._tm = setTimeout(function () { t.classList.remove('is-on'); }, isErr ? 6000 : 2200);
}
