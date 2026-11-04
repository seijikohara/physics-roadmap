// ラベルを置く候補の生成器。図の要素の種類ごとに、基準点や線から候補の位置を並べる。候補は前方ほど
// 好ましく、配置器は同じ罰点なら前方の候補を選ぶ。

import { inflate, pointAtLength, pointInPolygon, turnAngle, type Box, type XY } from "./geometry";
import { glyphBox, glyphCenterOffset, type GlyphSize, type LabelPos } from "./label-box";
import { ownLinesHitBox, type TracedLine } from "./obstacles";
import type { Candidate } from "./placer";
import { LABEL_POLICY } from "./policy";

/** 位置の列を候補にする。前方の候補を添字の重みで優先する。 */
export function rankedCandidates(
  positions: readonly LabelPos[],
  size: GlyphSize,
): readonly Candidate<LabelPos>[] {
  return positions.map((pos, i) => ({
    box: glyphBox(pos, size),
    value: pos,
    score: (penalty) => penalty + i * LABEL_POLICY.order,
  }));
}

/** ラベルを点から見て置く向き。 */
export type LabelDir =
  | "above"
  | "below"
  | "left"
  | "right"
  | "above-left"
  | "above-right"
  | "below-left"
  | "below-right";

/** 点のまわりの 8 方向の位置。キーの順が候補の順である。 */
export function aroundPoint(p: XY): Readonly<Record<LabelDir, LabelPos>> {
  return {
    above: { x: p.x, y: p.y - 13, align: "center" },
    below: { x: p.x, y: p.y + 16, align: "center" },
    "above-right": { x: p.x + 9, y: p.y - 12, align: "left" },
    "below-right": { x: p.x + 9, y: p.y + 14, align: "left" },
    "above-left": { x: p.x - 9, y: p.y - 12, align: "right" },
    "below-left": { x: p.x - 9, y: p.y + 14, align: "right" },
    right: { x: p.x + 12, y: p.y + 1, align: "left" },
    left: { x: p.x - 12, y: p.y + 1, align: "right" },
  };
}

/** 線分・ベクトルとラベル矩形の間に空けるすきま（viewBox 単位）。 */
const SEG_LABEL_GAP = 5.5;

/**
 * 線分・ベクトルの中点から法線方向へ、ラベル中心を離す距離を求める。ラベルの字形の矩形を
 * 単位法線 (perpX, perpY) へ射影した半幅に、すきまを足す。
 */
export function normalLabelOffset(perpX: number, perpY: number, size: GlyphSize): number {
  const h = size.bottom - size.top;
  return (Math.abs(perpX) * size.width) / 2 + (Math.abs(perpY) * h) / 2 + SEG_LABEL_GAP;
}

/** 線分の中点から直交する両側の位置。 */
export function besideSegment(a: XY, b: XY, size: GlyphSize): readonly LabelPos[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const perp = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const off = normalLabelOffset(perp.x, perp.y, size);
  return [
    { x: mid.x + perp.x * off, y: mid.y + perp.y * off, align: "center" },
    { x: mid.x - perp.x * off, y: mid.y - perp.y * off, align: "center" },
  ];
}

/**
 * 矢印のまわりの位置。中点から線に直交する両側を優先し、続いて終点の先・終点の斜め先・終点の横、
 * 始点の手前の順に並べる。勾配の矢印のように等高線の間を短い矢印が横切る図では、中点の横が隣の
 * 等高線にかかりやすく、空いている側が矢印ごとに異なるためである。
 */
export function aroundVector(from: XY, to: XY, size: GlyphSize): readonly LabelPos[] {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const dir = { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
  const perp = { x: -dir.y, y: dir.x };
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const side = normalLabelOffset(perp.x, perp.y, size);
  const along = normalLabelOffset(dir.x, dir.y, size);
  const at = (base: XY, a: number, p: number): LabelPos => ({
    x: base.x + dir.x * a + perp.x * p,
    y: base.y + dir.y * a + perp.y * p,
    align: "center",
  });
  const diag = Math.SQRT1_2;
  return [
    at(mid, 0, side),
    at(mid, 0, -side),
    at(to, along, 0),
    at(to, along * diag, side * diag),
    at(to, along * diag, -side * diag),
    at(to, 0, side),
    at(to, 0, -side),
    at(from, -along, 0),
    at(from, -along * diag, side * diag),
    at(from, -along * diag, -side * diag),
  ];
}

// 領域のラベルを置く候補の、基準点（重心または labelAt）からのずれ（px）。近い順に並べ、同点なら
// 前の候補を選ぶ。斜めのずれを真横のずれより先に試す。重心が軸の上に来たとき、真横へずらすと
// ラベルが同じ高さの目盛り数字と軸をはさんで並び、1 続きの式に見えるためである。
const REGION_LABEL_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, -14],
  [0, 14],
  [-20, -14],
  [20, -14],
  [-20, 14],
  [20, 14],
  [-20, 0],
  [20, 0],
  [0, -28],
  [0, 28],
  [-36, 0],
  [36, 0],
];

/**
 * 領域の基準点のまわりの候補。中心が領域の内側に残る位置を選ぶよう、外へ出る候補に範囲外と同じ
 * 罰点を与える。
 */
export function insideRegion(
  anchor: XY,
  fill: readonly XY[],
  size: GlyphSize,
): readonly Candidate<LabelPos>[] {
  return REGION_LABEL_OFFSETS.map(([dx, dy], i): Candidate<LabelPos> => {
    const pos: LabelPos = { x: anchor.x + dx, y: anchor.y + dy, align: "center" };
    return {
      box: glyphBox(pos, size),
      value: pos,
      score: (penalty) => {
        const p = penalty + i * LABEL_POLICY.order;
        return pointInPolygon(pos, fill) ? p : p + LABEL_POLICY.outside;
      },
    };
  });
}

/** 曲線の上の標本。t は媒介変数である。 */
export type CurvePoint = XY & Readonly<{ t: number }>;

/**
 * 曲線のそばの候補。曲線に沿った各位置で、線の両側へ離した位置を並べる。at があればその媒介変数に
 * 最も近い標本の両側だけを候補にする。指定が無ければ両端を除く 4 点おきの標本を使い、曲線の後半
 * （右寄り）を少し優先する。式のラベルが曲線の終わり近くに付く慣習に合わせるためである。
 */
export function besideCurve(
  visible: readonly CurvePoint[],
  size: GlyphSize,
  at: number | undefined,
): readonly Candidate<LabelPos>[] {
  const idxs =
    at === undefined
      ? visible.flatMap((_, i) =>
          i >= 1 && i < visible.length - 1 && (i - 1) % 4 === 0 ? [i] : [],
        )
      : [
          visible.reduce(
            (k, s, i) => (Math.abs(s.t - at) < Math.abs(visible[k].t - at) ? i : k),
            0,
          ),
        ];
  return idxs.flatMap((i) => {
    const a = visible[Math.max(0, i - 2)];
    const b = visible[Math.min(visible.length - 1, i + 2)];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const perp = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const off = normalLabelOffset(perp.x, perp.y, size);
    const pref = at === undefined ? Math.abs(i / (visible.length - 1) - 0.8) * 1.5 : 0;
    return [1, -1].map((sgn): Candidate<LabelPos> => {
      const pos: LabelPos = {
        x: visible[i].x + sgn * perp.x * off,
        y: visible[i].y + sgn * perp.y * off,
        align: "center",
      };
      return {
        box: glyphBox(pos, size),
        value: pos,
        score: (penalty) => penalty + pref + (sgn === 1 ? 0 : 0.05),
      };
    });
  });
}

/** 線の上に置くラベルの配置先。box は線を切り抜く矩形である。 */
export type OnLinePlacement = Readonly<{ pos: LabelPos; box: Box }>;

/**
 * 線の組の上の候補。字形の中心を線の上に置き、弧長に沿って 4px ごとに並べる。線の曲がり具合（急に
 * 曲がる位置ではラベルの外へ線がはみ出す）を罰点にする。開いた線（窓の縁から縁へ渡る線）は中ほどを、
 * 閉じた線（円など）は右上を少し優先し、同心の等高線のラベルが斜めにそろいやすくする。収まる位置が
 * 無い短い線には候補を作らない。box は字形の矩形を gapPad だけ広げた矩形である。
 */
export function onLine(
  lines: readonly TracedLine[],
  size: GlyphSize,
  gapPad: number,
): readonly Candidate<OnLinePlacement>[] {
  // 字形の中心を線の上に置く。基準点の y は字形の中心より上にある。
  const lift = glyphCenterOffset(size);
  const w = size.width + 2 * gapPad;
  const h = size.bottom - size.top + 2 * gapPad;
  // ラベルが乗る線のうち、ラベルの中心から弧長でこの範囲にある部分は、ラベルが当然重なる部分として
  // 当たり判定から外す。
  const ownWindow = Math.hypot(w, h) / 2 + 2;
  return lines.flatMap((line, li) => {
    const total = line.cum[line.cum.length - 1];
    if (total < w + 8) return [];
    const centroid = line.closed ? meanOf(line.pts) : null;
    const margin = line.closed ? 0 : w / 2 + 2;
    return accumulateSteps(margin, 4, total - margin).map((s): Candidate<OnLinePlacement> => {
      const p = pointAtLength(line.pts, line.cum, s, line.closed);
      const pos: LabelPos = { x: p.x, y: p.y - lift, align: "center" };
      const box = inflate(glyphBox(pos, size), gapPad);
      return {
        box,
        value: { pos, box },
        score: (penalty) => {
          const padded = inflate(box, LABEL_POLICY.lineClearance);
          const ownHit = ownLinesHitBox(lines, { line: li, s }, ownWindow, padded);
          const pa = pointAtLength(line.pts, line.cum, s - w / 2, line.closed);
          const pb = pointAtLength(line.pts, line.cum, s + w / 2, line.closed);
          const turned =
            (ownHit ? penalty + LABEL_POLICY.ownLine : penalty) + turnAngle(pa, p, pb) * 3;
          if (centroid === null) return turned + Math.abs(s / total - 0.5) * 2;
          const phi = Math.atan2(centroid.y - p.y, p.x - centroid.x);
          return turned + (1 - Math.cos(phi - Math.PI / 4));
        },
      };
    });
  });
}

/** 点列の平均。 */
export function meanOf(pts: readonly XY[]): XY {
  const n = pts.length || 1;
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / n,
    y: pts.reduce((s, p) => s + p.y, 0) / n,
  };
}

/**
 * start から step ずつ足していき、end 以下の値を順に返す。start + k * step と掛け算で求めると
 * 浮動小数の丸めが変わるため、直前の値に足して求める。値を作り直さずに積むよう、この関数の中に
 * 閉じた可変の配列を使う。
 */
function accumulateSteps(start: number, step: number, end: number): readonly number[] {
  if (!(start <= end)) return [];
  const out = [start];
  while (out[out.length - 1] + step <= end) out.push(out[out.length - 1] + step);
  return out;
}
