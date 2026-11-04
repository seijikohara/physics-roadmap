// ラベルを置く候補の生成器。図の要素の種類ごとに、基準点や線から候補の位置を並べる。候補は前方ほど
// 好ましく、配置器は同じ罰点なら前方の候補を選ぶ。

import { inflate, pointAtLength, pointInPolygon, turnAngle, type Box, type XY } from "./geometry";
import { glyphBox, glyphCenterOffset, type GlyphSize, type LabelPos } from "./label-box";
import { ownLinesHitBox, type TracedLine } from "./obstacles";
import { lineReach, type Candidate } from "./placer";
import { LABEL_POLICY } from "./policy";

/** 位置の列を候補にする。 */
export function positionCandidates(
  positions: readonly LabelPos[],
  size: GlyphSize,
): readonly Candidate<LabelPos>[] {
  return positions.map((pos) => ({ box: glyphBox(pos, size), value: pos }));
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

/**
 * ラベルの向きの指定。"auto" は向きを自動で選ぶ。"center" は基準点を KatexLabel の中心にする。
 * 8 方位は基準点から見た向きに固定する。
 */
export type LabelDirSpec = "auto" | "center" | LabelDir;

/** ラベルの箱の縁と、線や基準点の間のすきまの既定（px）。 */
export const DEFAULT_LABEL_OFFSET: number = LABEL_POLICY.lineClearance;

/** 字形の矩形の中心が (cx, cy) に来る、中央寄せの基準点。 */
export function centeredAt(cx: number, cy: number, size: GlyphSize): LabelPos {
  return { x: cx, y: cy - glyphCenterOffset(size), align: "center" };
}

/**
 * 点のまわりの 8 方向の位置。キーの順が候補の順である。reach は点の中心から印の端までの距離、offset は
 * 印の端からラベルの箱の縁までのすきまである。真上・真下・真横は箱の辺を、斜めは箱の角を離す。
 * 字形の見積もりの誤差のぶんだけ、箱を余分に離す。
 */
export function aroundPoint(
  p: XY,
  size: GlyphSize,
  reach: number,
  offset = DEFAULT_LABEL_OFFSET,
): Readonly<Record<LabelDir, LabelPos>> {
  const r = reach + offset + LABEL_POLICY.glyphSlack;
  const d = r * Math.SQRT1_2;
  const lift = glyphCenterOffset(size);
  return {
    above: { x: p.x, y: p.y - r - size.bottom, align: "center" },
    below: { x: p.x, y: p.y + r - size.top, align: "center" },
    "above-right": { x: p.x + d, y: p.y - d - size.bottom, align: "left" },
    "below-right": { x: p.x + d, y: p.y + d - size.top, align: "left" },
    "above-left": { x: p.x - d, y: p.y - d - size.bottom, align: "right" },
    "below-left": { x: p.x - d, y: p.y + d - size.top, align: "right" },
    right: { x: p.x + r, y: p.y - lift, align: "left" },
    left: { x: p.x - r, y: p.y - lift, align: "right" },
  };
}

/** 基準点から固定の位置。"center" は基準点を KatexLabel の中心にする。 */
export function fixedPosition(
  p: XY,
  dir: Exclude<LabelDirSpec, "auto">,
  size: GlyphSize,
  reach: number,
  offset = DEFAULT_LABEL_OFFSET,
): LabelPos {
  return dir === "center"
    ? { x: p.x, y: p.y, align: "center" }
    : aroundPoint(p, size, reach, offset)[dir];
}

/** 基準点のまわりの位置。基準点そのものを最初に試し、続いて 8 方向を試す。 */
export function positionsAround(
  p: XY,
  size: GlyphSize,
  reach: number,
  offset = DEFAULT_LABEL_OFFSET,
): readonly LabelPos[] {
  return [
    fixedPosition(p, "center", size, reach),
    ...Object.values(aroundPoint(p, size, reach, offset)),
  ];
}

/**
 * 線の中心からラベルの箱の縁までの距離の、すきまに足す分（px）。既定のすきまの候補を線の当たり判定の
 * 幅より少し遠くへ置き、まっすぐな線のそばの候補が自分の線に近いと数えられないようにする。
 */
const LINE_SIDE_EXTRA = lineReach - LABEL_POLICY.lineClearance + 0.25;

/**
 * 線の上の点から法線方向へ、字形の矩形の中心を離す距離を求める。矩形を単位法線 (perpX, perpY) へ
 * 射影した半幅に、線から箱の縁までのすきまを足す。
 */
export function normalLabelOffset(
  perpX: number,
  perpY: number,
  size: GlyphSize,
  offset = DEFAULT_LABEL_OFFSET,
): number {
  const h = size.bottom - size.top;
  return (Math.abs(perpX) * size.width) / 2 + (Math.abs(perpY) * h) / 2 + offset + LINE_SIDE_EXTRA;
}

/** 線分の中点から直交する両側の位置。 */
export function besideSegment(
  a: XY,
  b: XY,
  size: GlyphSize,
  offset = DEFAULT_LABEL_OFFSET,
): readonly LabelPos[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const perp = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const off = normalLabelOffset(perp.x, perp.y, size, offset);
  return [
    centeredAt(mid.x + perp.x * off, mid.y + perp.y * off, size),
    centeredAt(mid.x - perp.x * off, mid.y - perp.y * off, size),
  ];
}

/**
 * 矢印のまわりの位置。中点から線に直交する両側を優先し、続いて終点の先・終点の斜め先・終点の横、
 * 始点の手前の順に並べる。勾配の矢印のように等高線の間を短い矢印が横切る図では、中点の横が隣の
 * 等高線にかかりやすく、空いている側が矢印ごとに異なるためである。
 */
export function aroundVector(
  from: XY,
  to: XY,
  size: GlyphSize,
  headHalf: number,
  offset = DEFAULT_LABEL_OFFSET,
): readonly LabelPos[] {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const dir = { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
  const perp = { x: -dir.y, y: dir.x };
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const side = normalLabelOffset(perp.x, perp.y, size, offset);
  const along = normalLabelOffset(dir.x, dir.y, size, offset);
  // 矢じりは線より太いので、終点の横の候補は矢じりの半幅だけ余分に離す。
  const headSide = side + headHalf - LABEL_POLICY.lineHalfWidth;
  const at = (base: XY, a: number, p: number): LabelPos =>
    centeredAt(base.x + dir.x * a + perp.x * p, base.y + dir.y * a + perp.y * p, size);
  const diag = Math.SQRT1_2;
  return [
    at(mid, 0, side),
    at(mid, 0, -side),
    at(to, along, 0),
    at(to, along * diag, headSide * diag),
    at(to, along * diag, -headSide * diag),
    at(to, 0, headSide),
    at(to, 0, -headSide),
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
  return REGION_LABEL_OFFSETS.map(([dx, dy]): Candidate<LabelPos> => {
    const pos: LabelPos = { x: anchor.x + dx, y: anchor.y + dy, align: "center" };
    return {
      box: glyphBox(pos, size),
      value: pos,
      score: (penalty) => (pointInPolygon(pos, fill) ? penalty : penalty + LABEL_POLICY.outside),
    };
  });
}

/** 曲線の上の標本。t は媒介変数である。 */
export type CurvePoint = XY & Readonly<{ t: number }>;

/**
 * 曲線のそばの候補。曲線に沿った各位置で、線の両側へ離した位置を並べる。at があればその媒介変数に
 * 最も近い標本の両側だけを候補にする。指定が無ければ両端を除く 4 点おきの標本を使い、曲線の後半
 * （右寄り）を少し優先する。式のラベルが曲線の終わり近くに付く慣習に合わせるためである。dir が
 * "auto" でなければ、線の両側の代わりに、各位置から dir の向きの 1 か所だけを候補にする。
 */
export function besideCurve(
  visible: readonly CurvePoint[],
  size: GlyphSize,
  at: number | undefined,
  dir: LabelDirSpec = "auto",
  offset = DEFAULT_LABEL_OFFSET,
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
    const off = normalLabelOffset(perp.x, perp.y, size, offset);
    const pref = at === undefined ? Math.abs(i / (visible.length - 1) - 0.8) * 1.5 : 0;
    if (dir !== "auto") {
      const pos = fixedPosition(visible[i], dir, size, LABEL_POLICY.lineHalfWidth, offset);
      return [{ box: glyphBox(pos, size), value: pos, score: (penalty) => penalty + pref }];
    }
    return [1, -1].map((sgn): Candidate<LabelPos> => {
      const pos = centeredAt(
        visible[i].x + sgn * perp.x * off,
        visible[i].y + sgn * perp.y * off,
        size,
      );
      return {
        box: glyphBox(pos, size),
        value: pos,
        score: (penalty) => penalty + pref + (sgn === 1 ? 0 : 0.05),
      };
    });
  });
}

/** 線の上に置くラベルの配置先。glyph は字形の矩形、cut は線を切り抜く矩形である。 */
export type OnLinePlacement = Readonly<{ pos: LabelPos; glyph: Box; cut: Box }>;

/**
 * 線の組の上の候補。字形の中心を線の上に置き、弧長に沿って 4px ごとに並べる。線の曲がり具合（急に
 * 曲がる位置ではラベルの外へ線がはみ出す）を罰点にする。開いた線（窓の縁から縁へ渡る線）は中ほどを、
 * 閉じた線（円など）は右上を少し優先し、同心の等高線のラベルが斜めにそろいやすくする。収まる位置が
 * 無い短い線には候補を作らない。線を切り抜く矩形は、字形の矩形を gapPad だけ広げた矩形である。
 */
export function onLine(
  lines: readonly TracedLine[],
  size: GlyphSize,
  gapPad: number,
): readonly Candidate<OnLinePlacement>[] {
  // 字形の中心を線の上に置く。基準点の y は字形の中心より上にある。
  const lift = glyphCenterOffset(size);
  const w = size.width + 2 * gapPad;
  // ラベルが乗る線のうち、ラベルの中心から弧長でこの範囲にある部分は、ラベルが当然重なる部分として
  // 当たり判定から外す。判定に使う矩形の対角の半分より長くとる。
  const ownWindow =
    Math.hypot(size.width + 2 * lineReach, size.bottom - size.top + 2 * lineReach) / 2 + 2;
  return lines.flatMap((line, li) => {
    const total = line.cum[line.cum.length - 1];
    if (total < w + 8) return [];
    const centroid = line.closed ? meanOf(line.pts) : null;
    const margin = line.closed ? 0 : w / 2 + 2;
    return accumulateSteps(margin, 4, total - margin).map((s): Candidate<OnLinePlacement> => {
      const p = pointAtLength(line.pts, line.cum, s, line.closed);
      const pos: LabelPos = { x: p.x, y: p.y - lift, align: "center" };
      const glyph = glyphBox(pos, size);
      return {
        box: glyph,
        value: { pos, glyph, cut: inflate(glyph, gapPad) },
        score: (penalty) => {
          const at = { line: li, s };
          const ownNear = ownLinesHitBox(lines, at, ownWindow, inflate(glyph, lineReach));
          const ownTouch =
            ownNear && ownLinesHitBox(lines, at, ownWindow, inflate(glyph, LABEL_POLICY.lineTouch));
          const own = ownTouch ? 1 : ownNear ? LABEL_POLICY.nearLine : 0;
          const pa = pointAtLength(line.pts, line.cum, s - w / 2, line.closed);
          const pb = pointAtLength(line.pts, line.cum, s + w / 2, line.closed);
          const turned = penalty + own * LABEL_POLICY.ownLine + turnAngle(pa, p, pb) * 3;
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
