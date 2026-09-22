/* ===========================================================
   output.js — 出力ビュー（OBSのブラウザソース・背景透明）
   ===========================================================
   URL: …/riders/?view=output&reg=<登録番号>&k=<キー>
        （要件定義の ?view=card も同じ意味で受ける）

   🔴ここに描くのは3つだけ（要件§4.2）
        ①公式データ（名前・府県・級班・期別・脚質・得点）
        ②役割別の実績（自前集計の数字）
        ③配信OKを付けた観察ログ
      本人コメント・選手メモ（特徴／追走能力／役割メモ）は
      GASの card アクションがそもそも返さない＝画面に出しようがない作りにしてある。

   レースに追従させる仕掛けは v1 では入れていない（reg を指定して出す）。
   将来OBSの別シーンに載せるときは、ここに展開ボードと同じ BroadcastChannel を足す。
*/

var OUTPUT = (function () {

  var POLL_MS = 15000;

  function start() {
    document.body.dataset.view = 'output';
    var app = document.getElementById('app');
    if (app) app.remove();
    var box = document.getElementById('outcard');
    box.hidden = false;

    var reg = CONFIG.PARAMS.get('reg') || '';
    if (!reg) { box.appendChild(el('div', 'out-err', 'reg（登録番号）を指定してください')); return; }

    var tick = function () {
      Promise.all([API.card(reg), API.stats()]).then(function (res) {
        render(box, res[0], res[1]);
      }).catch(function () { /* 配信中に赤い文字を出さない。前の表示を残す */ });
    };
    tick();
    setInterval(tick, POLL_MS);
  }

  function render(box, data, statsAll) {
    var r = data.rider || {};
    var st = (statsAll && statsAll.riders && statsAll.riders[r.reg]) || null;
    clear(box);

    var card = el('div', 'oc');

    var head = el('div', 'oc-head');
    head.appendChild(el('span', 'oc-name', r.name || ''));
    var meta = el('span', 'oc-meta');
    [r.pref, r.kyuhan, r.term ? r.term + '期' : '', r.kyaku, r.score ? '得点' + r.score : '']
      .filter(Boolean).forEach(function (t) { meta.appendChild(el('span', 'oc-meta-i', t)); });
    head.appendChild(meta);
    card.appendChild(head);

    if (st && st.roles) {
      var figs = el('div', 'oc-figs');
      CONFIG.ROLES.forEach(function (role) {
        var rs = st.roles[role.key];
        if (!rs || !rs.n) return;
        var f = el('div', 'oc-fig');
        f.appendChild(el('span', 'oc-fig-k', role.label));
        f.appendChild(el('span', 'oc-fig-v', pct(rs.top3, rs.n)));
        f.appendChild(el('span', 'oc-fig-n', rs.n + '走'));
        figs.appendChild(f);
      });
      if (figs.childNodes.length) {
        card.appendChild(el('div', 'oc-lbl', '役割別の3着内率'));
        card.appendChild(figs);
      }
    }

    var obs = (data.obs || []).slice(0, 4);
    if (obs.length) {
      card.appendChild(el('div', 'oc-lbl', 'メモ'));
      var list = el('div', 'oc-obs');
      obs.forEach(function (o) {
        var line = el('div', 'oc-o');
        if (o.role) line.appendChild(el('span', 'oc-o-role', roleLabel(o.role)));
        var text = (o.tags || []).join('・');
        if (o.body) text += (text ? '　' : '') + o.body;
        line.appendChild(el('span', 'oc-o-text', text));
        list.appendChild(line);
      });
      card.appendChild(list);
    }

    box.appendChild(card);
  }

  return { start: start };
})();
