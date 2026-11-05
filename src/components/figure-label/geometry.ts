// 図のラベル配置で使う平面の幾何の判定（点・矩形・線分・折れ線・多角形）。
//
// DOM にもフォントにも頼らない純粋な関数だけを置き、ビルド時の部品・図のスクリプト・単体テストから
// 同じ判定を使う。浮動小数の演算の順序を変えると丸めが変わり、ラベルの位置と SVG の出力がずれることが
// ある。式を変えるときは図の差分を確かめる。

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

/** 線の標本。ok は描く範囲の中にあって有限かを表す。 */
export type LineSample = XY & Readonly<{ ok: boolean }>;

/** 標本の列から、描く範囲の中の連続した部分ごとの折れ線を取り出す（ラベル配置の障害物に使う）。 */
export function visiblePieces(samples: readonly LineSample[]): readonly (readonly XY[])[] {
  // 描く範囲内の連続した部分の始まり（直前が範囲外か先頭の、範囲内の標本）の番号。
  const starts = samples.flatMap((s, k) => (s.ok && (k === 0 || !samples[k - 1].ok) ? [k] : []));
  // 終わり（直前が範囲内の、範囲外の標本）の番号。始まりと終わりは交互に現れるので、i 番目の終わりが
  // i 番目の始まりに対応する。始まりごとに先頭から探すと、標本数 × 部分の数の時間がかかる。
  const ends = samples.flatMap((s, k) => (!s.ok && k > 0 && samples[k - 1].ok ? [k] : []));
  return starts.map((start, i) =>
    samples.slice(start, ends.at(i) ?? samples.length).map((s) => ({ x: s.x, y: s.y })),
  );
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

/** 線分 pq が範囲 reach の外にあるか。距離の計算の前に座標の比較で線分を絞るために使う。 */
function segmentOutside(p: XY, q: XY, reach: Box): boolean {
  return (
    Math.max(p.x, q.x) < reach.x0 ||
    Math.min(p.x, q.x) > reach.x1 ||
    Math.max(p.y, q.y) < reach.y0 ||
    Math.min(p.y, q.y) > reach.y1
  );
}

/**
 * 折れ線と矩形の距離。交わるときは 0 である。外接矩形を limit だけ広げた範囲の外にある線分は調べない。
 * 範囲の中に線分が無ければ Infinity を返す。等高線のラベルは候補が多いので、距離の計算の前に座標の比較で
 * 線分を絞り、頂点の多い線でも速く保つ。
 */
export function polylineBoxDistance(pts: readonly XY[], box: Box, limit: number): number {
  const reach = inflate(box, limit);
  return pts.reduce((best, p, k) => {
    if (k === 0 || best === 0 || segmentOutside(p, pts[k - 1], reach)) return best;
    return Math.min(best, segmentBoxDistance(pts[k - 1], p, box));
  }, Infinity);
}

/** 弧長の区間の列から、区間 [lo, hi] を除いた残りの区間の列を返す。 */
function withoutInterval(
  pieces: readonly (readonly [number, number])[],
  lo: number,
  hi: number,
): readonly (readonly [number, number])[] {
  return pieces.flatMap(([a, b]): readonly (readonly [number, number])[] => {
    if (hi <= a || lo >= b) return [[a, b]];
    return [...(a < lo ? ([[a, lo]] as const) : []), ...(hi < b ? ([[hi, b]] as const) : [])];
  });
}

/**
 * 折れ線のうち、弧長 s から window より離れた部分と矩形の距離。ラベルが乗る位置の近くを除いて、同じ線の
 * 別の部分（急に折り返す線など）がラベルにどれだけ近いかを調べる。間引いた折れ線は 1 本の線分が長い
 * ので、線分を丸ごと内外に分けず、線分を弧長の窓で切って窓の外の部分だけを測る。閉じた線では窓が始点を
 * またぐので、一周ずらした窓も除く。
 */
export function farPartBoxDistance(
  pts: readonly XY[],
  cum: readonly number[],
  s: number,
  window: number,
  closed: boolean,
  box: Box,
  limit: number,
): number {
  const total = cum[cum.length - 1];
  const centers = closed ? [s - total, s, s + total] : [s];
  const reach = inflate(box, limit);
  return pts.reduce((best, p, k) => {
    if (k === 0 || best === 0 || segmentOutside(p, pts[k - 1], reach)) return best;
    const q = pts[k - 1];
    const a = cum[k - 1];
    const b = cum[k];
    const far = centers.reduce<readonly (readonly [number, number])[]>(
      (rest, c) => withoutInterval(rest, c - window, c + window),
      b > a ? [[a, b]] : [],
    );
    const at = (t: number): XY => lerpAt(q, p, (t - a) / (b - a));
    return far.reduce((d, [u, v]) => Math.min(d, segmentBoxDistance(at(u), at(v), box)), best);
  }, Infinity);
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

/** 点 p と矩形の距離。点が矩形の内側なら 0 である。 */
export function distanceToBox(p: XY, box: Box): number {
  return Math.hypot(
    Math.max(box.x0 - p.x, 0, p.x - box.x1),
    Math.max(box.y0 - p.y, 0, p.y - box.y1),
  );
}

/**
 * 線分と矩形の距離。交わるときは 0 である。線分と矩形はどちらも凸なので、離れているときに最も近い組は、
 * 矩形の 4 隅から線分までと、線分の 2 端から矩形までのどれかである。矩形を四方へ広げて交差を調べる方式と
 * 違い、線の傾きで値が変わらない。広げる方式は斜めの線に対して角が距離の √2 倍まで伸びる。
 */
export function segmentBoxDistance(a: XY, b: XY, box: Box): number {
  if (segmentHitsBox(a, b, box)) return 0;
  const corners: readonly XY[] = [
    { x: box.x0, y: box.y0 },
    { x: box.x1, y: box.y0 },
    { x: box.x0, y: box.y1 },
    { x: box.x1, y: box.y1 },
  ];
  return corners.reduce(
    (d, c) => Math.min(d, distanceToSegment(c, a, b)),
    Math.min(distanceToBox(a, box), distanceToBox(b, box)),
  );
}

/**
 * 折れ線の上で点 p に最も近い点と、点 p からの距離と、始点からの弧長。同点なら始点に近い側の点を返す。
 */
export function nearestOnPolyline(
  pts: readonly XY[],
  p: XY,
): Readonly<{ point: XY; distance: number; arc: number }> {
  const first = { point: pts[0], distance: Math.hypot(p.x - pts[0].x, p.y - pts[0].y), arc: 0 };
  const cum = cumulativeLength(pts);
  return pts.reduce((best, b, k) => {
    if (k === 0) return best;
    const a = pts[k - 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
    const point = lerpAt(a, b, t);
    const distance = Math.hypot(p.x - point.x, p.y - point.y);
    return distance < best.distance
      ? { point, distance, arc: cum[k - 1] + (cum[k] - cum[k - 1]) * t }
      : best;
  }, first);
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

/** 画面上の矢印（始点・終点）。 */
export type ScreenArrow = Readonly<{ from: XY; to: XY }>;

/**
 * 矢じりの根元の中央と両端の点。矢じりの長さは矢印の 8 割を超えないように縮め、短い矢印でも形を保つ。
 * 長さ 0 の矢印には null を返す。
 */
export function arrowHead(
  { from, to }: ScreenArrow,
  headLen: number,
  headHalf: number,
): Readonly<{ base: XY; left: XY; right: XY }> | null {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (!(len > 0)) return null;
  const ux = (to.x - from.x) / len;
  const uy = (to.y - from.y) / len;
  const hl = Math.min(headLen, len * 0.8);
  const hh = headHalf * (hl / headLen);
  const bx = to.x - hl * ux;
  const by = to.y - hl * uy;
  return {
    base: { x: bx, y: by },
    left: { x: bx - hh * uy, y: by + hh * ux },
    right: { x: bx + hh * uy, y: by - hh * ux },
  };
}

/**
 * 矢印の矢じりが、向きの読める程度に窓の中に残るか。矢じりの中ほどが窓の中にあれば残るとみなす。
 * 先端だけが窓から出る矢印まで省くと、窓の縁の矢印の並びが歯抜けになるためである。
 */
export function headInside(
  arrow: ScreenArrow,
  win: Box,
  headLen: number,
  headHalf: number,
): boolean {
  const head = arrowHead(arrow, headLen, headHalf);
  if (head === null) return true;
  const mid = lerpAt(head.base, arrow.to, 0.5);
  return mid.x >= win.x0 && mid.x <= win.x1 && mid.y >= win.y0 && mid.y <= win.y1;
}

/** 矩形を四方へ d だけ広げる。 */
export function inflate(b: Box, d: number): Box {
  return { x0: b.x0 - d, x1: b.x1 + d, y0: b.y0 - d, y1: b.y1 + d };
}

/** 2 つの矩形のすきま。重なるときは 0 である。 */
export function boxGap(a: Box, b: Box): number {
  return Math.hypot(Math.max(a.x0 - b.x1, b.x0 - a.x1, 0), Math.max(a.y0 - b.y1, b.y0 - a.y1, 0));
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
