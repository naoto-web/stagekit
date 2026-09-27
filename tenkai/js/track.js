/* ===========================================================
   track.js — コースの幾何（v2の核・要件定義_v2 §3 / §11）

   選手の位置は (d, lane) で持つ。
     d    ＝ゴールまでの残り周回。進むほど減り、0でゴール線
     lane ＝-1 内 / 0 中 / +1 外（半径方向のずれ。レーン間隔 TRACK.LANE px）
   描くときだけ pointAt() で画面座標（仮想 960×572）に直す。
   ドラッグは project() でポインタ座標を最寄りのコース上の点に戻す。
   ＝選手はコースから外れない／コーナーで自動的に曲がる

   コースの弧長 p（ゴール線から前へ何px進んだ地点か）＝ (−d mod 1) × 1周
     0 ≤ p < B  : ホーム直線の終わり（ゴール線→1角）  右へ
     B ≤ p < C  : 1〜2角（右の半円）                   上へ回る
     C ≤ p < D  : バック直線                             左へ
     D ≤ p < E  : 3〜4角（左の半円）                   下へ回る
     E ≤ p < L  : ホーム直線（4角→ゴール線）            右へ
   =========================================================== */

var Track = (function () {

  var T = CONFIG.TRACK;
  var L = CONFIG.LAP;
  var ARC = Math.PI * T.RREF;   // 距離の基準は内レーン（config.js の RREF の説明）
  var XL = T.CX - T.LSTR / 2, XR = T.CX + T.LSTR / 2;
  var P_B = T.GOAL_OFF, P_C = P_B + ARC, P_D = P_C + T.LSTR, P_E = P_D + ARC;

  /** d（周）→ 弧長 p（px, 0..L） */
  function pOf(d) {
    var f = (-d) % 1;
    if (f < 0) f += 1;
    return f * L;
  }

  /** 弧長 p と半径方向のずれ o（px・外が＋）→ 画面座標 */
  function pointP(p, o) {
    var r = T.RC + o, t;
    if (p < P_B) return { x: XR - T.GOAL_OFF + p, y: T.CY + T.RC + o };
    if (p < P_C) { t = Math.PI / 2 - (p - P_B) / T.RREF; return { x: XR + r * Math.cos(t), y: T.CY + r * Math.sin(t) }; }
    if (p < P_D) return { x: XR - (p - P_C), y: T.CY - T.RC - o };
    if (p < P_E) { t = -Math.PI / 2 - (p - P_D) / T.RREF; return { x: XL + r * Math.cos(t), y: T.CY + r * Math.sin(t) }; }
    return { x: XL + (p - P_E), y: T.CY + T.RC + o };
  }

  /** (d, lane) → 画面座標（仮想 960×572） */
  function pointAt(d, lane) {
    return pointP(pOf(d), lane * T.LANE);
  }

  /** 画面座標 → { p, o }（最寄りのコース上の弧長と半径方向のずれ）。
      スタジアム形（直線＋半円）なので、x の範囲で区間が一意に決まる＝4区間の場合分けで厳密 */
  function projectP(x, y) {
    var p, o, t;
    if (x >= XL && x <= XR) {
      if (y < T.CY) {                       // バック直線
        o = (T.CY - T.RC) - y;
        p = P_C + (XR - x);
      } else {                              // ホーム直線
        o = y - (T.CY + T.RC);
        p = (x >= XR - T.GOAL_OFF) ? (x - (XR - T.GOAL_OFF)) : (P_E + (x - XL));
      }
    } else if (x > XR) {                    // 1〜2角
      t = Math.atan2(y - T.CY, x - XR);     // -π/2..π/2
      o = Math.sqrt((x - XR) * (x - XR) + (y - T.CY) * (y - T.CY)) - T.RC;
      p = P_B + (Math.PI / 2 - t) * T.RREF;
    } else {                                // 3〜4角
      t = Math.atan2(y - T.CY, x - XL);
      if (t > 0) t -= 2 * Math.PI;          // -3π/2..-π/2 に揃える
      o = Math.sqrt((x - XL) * (x - XL) + (y - T.CY) * (y - T.CY)) - T.RC;
      p = P_D + (-Math.PI / 2 - t) * T.RREF;
    }
    p = ((p % L) + L) % L;
    return { p: p, o: o };
  }

  /** 端数の差を (-0.5, 0.5] に畳む */
  function wrapHalf(v) {
    v = v % 1;
    if (v > 0.5) v -= 1;
    if (v <= -0.5) v += 1;
    return v;
  }

  /** 画面座標 → { d, lane }。
      d は周回の端数しか決まらないので、基準 refD に最も近い周を選ぶ（ドラッグ中の選手の今の周） */
  function project(x, y, refD) {
    var pr = projectP(x, y);
    var dFrac = -pr.p / L;                  // d ≡ −p/L (mod 1)
    var ref = (typeof refD === 'number' && isFinite(refD)) ? refD : 1;
    return { d: ref + wrapHalf(dFrac - ref), lane: pr.o / T.LANE };
  }

  /** a から b までコースに沿った点列（連結バー用）。d と lane を補間しながら打つ */
  function pathBetween(dA, laneA, dB, laneB, stepPx) {
    var step = (stepPx || 6) / L;
    var n = Math.max(2, Math.ceil(Math.abs(dB - dA) / step));
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      pts.push(pointAt(dA + (dB - dA) * t, laneA + (laneB - laneA) * t));
    }
    return pts;
  }

  /** (d, lane) のところでの「外向き」の単位ベクトル（苗字チップの向き・誘導員の退避に使う） */
  function outward(d) {
    var a = pointAt(d, 0), b = pointAt(d, 1);
    var dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  return {
    pointAt: pointAt,
    pointP: pointP,
    project: project,
    projectP: projectP,
    pathBetween: pathBetween,
    outward: outward,
    pOf: pOf,
    /* 描画用に区間の境目と直線の端を出しておく */
    geom: { XL: XL, XR: XR, ARC: ARC, P_B: P_B, P_C: P_C, P_D: P_D, P_E: P_E, L: L }
  };
})();
