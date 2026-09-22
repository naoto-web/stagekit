/* ===========================================================
   kana.js — あいうえお検索（要件§2-2）
   ===========================================================
   フリガナは keirin.jp の選手プロフィールから取る（カタカナ・姓名は全角空白区切り）。
   🔴カナが未取得の選手は行に出さない。推測で読みを作らないため（同じ漢字で読みが違う人がいる）。
   「カナ未取得」のボタンで拾えるようにしてある。
*/

var KANA = (function () {

  var ROWS = [
    { key: 'あ', chars: 'アイウエオ' },
    { key: 'か', chars: 'カキクケコガギグゲゴ' },
    { key: 'さ', chars: 'サシスセソザジズゼゾ' },
    { key: 'た', chars: 'タチツテトダヂヅデド' },
    { key: 'な', chars: 'ナニヌネノ' },
    { key: 'は', chars: 'ハヒフヘホバビブベボパピプペポ' },
    { key: 'ま', chars: 'マミムメモ' },
    { key: 'や', chars: 'ヤユヨ' },
    { key: 'ら', chars: 'ラリルレロ' },
    { key: 'わ', chars: 'ワヲンヴ' }
  ];

  /* 小書き → 大書き（先頭が小書きの人はいないが、名の側で効く） */
  var SMALL = { 'ァ': 'ア', 'ィ': 'イ', 'ゥ': 'ウ', 'ェ': 'エ', 'ォ': 'オ', 'ッ': 'ツ', 'ャ': 'ヤ', 'ュ': 'ユ', 'ョ': 'ヨ', 'ヮ': 'ワ' };

  /** ひらがな→カタカナ・全角英数の正規化・空白落とし */
  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/[ぁ-ゖ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 0x60); })
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[\s　]+/g, '')
      .toUpperCase();
  }

  /** その選手が属する行（'あ'〜'わ'）。カナが無ければ '' */
  function rowOf(kana) {
    var k = norm(kana);
    if (!k) return '';
    var c = k.charAt(0);
    if (SMALL[c]) c = SMALL[c];
    for (var i = 0; i < ROWS.length; i++) if (ROWS[i].chars.indexOf(c) >= 0) return ROWS[i].key;
    return '';
  }

  /** 検索語にあたるか。漢字氏名・カナ・登録番号・府県のどれかに前方一致／部分一致 */
  function match(r, q) {
    if (!q) return true;
    var nq = norm(q);
    if (!nq) return true;
    if (/^\d{3,6}$/.test(nq) && String(r.reg || '').indexOf(nq) >= 0) return true;
    if (norm(r.name).indexOf(nq) >= 0) return true;
    if (norm(r.kana).indexOf(nq) >= 0) return true;
    if (norm(r.pref).indexOf(nq) >= 0) return true;
    return false;
  }

  return {
    ROWS: ROWS,
    norm: norm,
    rowOf: rowOf,
    match: match,
    /** 並べ替え用のキー（カナが無い人は最後） */
    sortKey: function (r) { return norm(r.kana) || '￿' + norm(r.name); }
  };
})();
