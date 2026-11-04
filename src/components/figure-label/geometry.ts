// 図のラベル配置で使う平面の幾何の判定（点・矩形・線分・折れ線・多角形）。
//
// DOM にもフォントにも頼らない純粋な関数だけを置き、ビルド時の部品・図のスクリプト・単体テストから
// 同じ判定を使う。関数の中身は ContourPlot から移したもので、浮動小数の演算の順序を変えていない。
// 演算の順序を変えると丸めが変わり、ラベルの位置と SVG の出力がずれるためである。

/** 平面上の点。数学座標と画面座標のどちらにも使う。 */
export type XY = Readonly<{ x: number; y: number }>;

/** 当たり判定に使う軸並行の矩形（左上 (x0,y0)・右下 (x1,y1)）。 */
export type Box = Readonly<{ x0: number; x1: number; y0: number; y1: number }>;

/** 点列を囲む最小の軸並行の矩形。 */
export function bboxOf(pts: readonly XY[]): Box {
  return {
    x0: pts.reduce((m, p) => Math.min(m, p.x), Infinity),
    x1: pts.reduce((m, p) => Math.max(m, p.x), -Infinity),
    y0: pts.reduce((m, p) => Math.min(m, p.y), Infinity),
    y1: pts.reduce((m, p) => Math.max(m, p.y), -Infinity),
  };
}

/** 点が多角形の内側にあるか（交差数の偶奇で判定する。塗りの evenodd 規則と一致させる）。 */
export function pointInPolygon(p: XY, poly: readonly XY[]): boolean {
  return poly.reduce((inside, a, k) => {
    const b = poly[k === 0 ? poly.length - 1 : k - 1];
    return a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
      ? !inside
      : inside;
  }, false);
}

/** 折れ線が矩形と交わるか（いずれかの線分が矩形に入るか）。 */
export function polylineHitsBox(pts: readonly XY[], b: Box): boolean {
  return pts.some((p, k) => k > 0 && segmentHitsBox(pts[k - 1], p, b));
}

/**
 * 折れ線のうち、弧長 s から window より離れた部分が矩形と交わるか。ラベルが乗る位置の近くを
 * 除いて、同じ線の別の部分（急に折り返す線など）がラベルに重なるかを調べる。
 */
export function farPartHitsBox(
  pts: readonly XY[],
  cum: readonly number[],
  s: number,
  window: number,
  closed: boolean,
  b: Box,
): boolean {
  const total = cum[cum.length - 1];
  return pts.some((p, k) => {
    if (k === 0) return false;
    const mid = (cum[k - 1] + cum[k]) / 2;
    const along = Math.abs(mid - s);
    const dist = closed ? Math.min(along, total - along) : along;
    return dist > window && segmentHitsBox(pts[k - 1], p, b);
  });
}

/** 線分が矩形と交わるか（Liang–Barsky 法で、線分を矩形で切り取れるかを調べる）。 */
export function segmentHitsBox(a: XY, b: XY, box: Box): boolean {
  if (
    Math.max(a.x, b.x) < box.x0 ||
    Math.min(a.x, b.x) > box.x1 ||
    Math.max(a.y, b.y) < box.y0 ||
    Math.min(a.y, b.y) > box.y1
  ) {
    return false;
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const pq: readonly (readonly [number, number])[] = [
    [-dx, a.x - box.x0],
    [dx, box.x1 - a.x],
    [-dy, a.y - box.y0],
    [dy, box.y1 - a.y],
  ];
  // 線分の媒介変数の範囲 [t0, t1] を矩形の 4 辺で順に狭める。範囲が空になれば null にする。
  const clipped = pq.reduce<Readonly<{ t0: number; t1: number }> | null>(
    (range, [p, q]) => {
      if (range === null) return null;
      if (p === 0) return q < 0 ? null : range;
      const r = q / p;
      if (p < 0) {
        if (r > range.t1) return null;
        return r > range.t0 ? { t0: r, t1: range.t1 } : range;
      }
      if (r < range.t0) return null;
      return r < range.t1 ? { t0: range.t0, t1: r } : range;
    },
    { t0: 0, t1: 1 },
  );
  return clipped !== null && clipped.t0 <= clipped.t1;
}

/** 点 p から線分 ab までの距離。 */
export function distanceToSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** 折れ線の各頂点までの累積の長さ。 */
export function cumulativeLength(pts: readonly XY[]): readonly number[] {
  // 直前の累積に辺の長さを足す（局所の可変バッファ）。頂点は数千になりうるため、配列を作り直さずに
  // 積む。
  const cum = [0];
  pts.forEach((p, k) => {
    if (k > 0) cum.push(cum[k - 1] + Math.hypot(p.x - pts[k - 1].x, p.y - pts[k - 1].y));
  });
  return cum;
}

/** 折れ線の始点から弧長 s の位置。閉じた線では s を一周の長さで巻き戻す。 */
export function pointAtLength(
  pts: readonly XY[],
  cum: readonly number[],
  s: number,
  closed: boolean,
): XY {
  const total = cum[cum.length - 1];
  const wrapped = closed && total > 0 ? ((s % total) + total) % total : s;
  const t = clamp(wrapped, 0, total);
  // cum[lo] <= t < cum[hi] となる隣り合う頂点 lo・hi を二分探索で求める。
  const search = (lo: number, hi: number): readonly [number, number] => {
    if (!(hi - lo > 1)) return [lo, hi];
    const mid = (lo + hi) >> 1;
    return cum[mid] <= t ? search(mid, hi) : search(lo, mid);
  };
  const [lo, hi] = search(0, cum.length - 1);
  const seg = cum[hi] - cum[lo];
  const u = seg > 0 ? (t - cum[lo]) / seg : 0;
  return lerpAt(pts[lo], pts[hi], u);
}

/** 3 点 a→p→b で進む向きが変わる角（ラジアン、0〜π）。 */
export function turnAngle(a: XY, p: XY, b: XY): number {
  const a1 = Math.atan2(p.y - a.y, p.x - a.x);
  const a2 = Math.atan2(b.y - p.y, b.x - p.x);
  const d = Math.abs(a2 - a1) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

/** 矩形を四方へ d だけ広げる。 */
export function inflate(b: Box, d: number): Box {
  return { x0: b.x0 - d, x1: b.x1 + d, y0: b.y0 - d, y1: b.y1 + d };
}

/** 2 つの矩形が重なるか。 */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/** 値を [lo, hi] に丸める。 */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 2 点 p・q を t : (1 − t) に内分する点（t が 0 から 1 の外なら外分する点）。 */
export function lerpAt(p: XY, q: XY, t: number): XY {
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
}
