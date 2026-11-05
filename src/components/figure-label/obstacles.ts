// ラベル配置の障害物。矩形・折れ線・上限付きの群の 3 種類で、図の要素を部品によらず同じ形で表す。

import {
  bboxOf,
  cumulativeLength,
  farPartBoxDistance,
  polylineBoxDistance,
  type Box,
  type XY,
} from "./geometry";

/** 矩形の障害物（目盛り数字・軸名・点の印など）。id を持つ矩形は判定から外せる（点の自分の印）。 */
export type BoxObstacle = Readonly<{ kind: "box"; box: Box; weight: number; id?: string }>;

/**
 * 折れ線の障害物。id が同じ線はまとめて判定から外せる（ラベル自身の線）。faint の線は、線の上に
 * 置くラベルが避けない淡い線である。
 */
export type LineObstacle = Readonly<{
  kind: "line";
  id: string;
  pts: readonly XY[];
  weight: number;
  faint: boolean;
  bbox: Box;
}>;

/**
 * 折れ線の群（ベクトル場の矢印など）。重なる本数ぶんの罰点を cap で打ち切る。線の上に置くラベルは
 * 群を避けない。
 */
export type GroupObstacle = Readonly<{
  kind: "group";
  lines: readonly LineObstacle[];
  cap: number;
}>;

export type Obstacle = BoxObstacle | LineObstacle | GroupObstacle;

export function boxObstacle(box: Box, weight: number, id?: string): BoxObstacle {
  return id === undefined ? { kind: "box", box, weight } : { kind: "box", box, weight, id };
}

/** 2 点以上ある折れ線を障害物にする（1 点以下なら障害物にしない）。 */
export function lineObstacle(
  id: string,
  pts: readonly XY[],
  weight: number,
  faint = false,
): readonly LineObstacle[] {
  return pts.length >= 2 ? [{ kind: "line", id, pts, weight, faint, bbox: bboxOf(pts) }] : [];
}

export function groupObstacle(lines: readonly LineObstacle[], cap: number): GroupObstacle {
  return { kind: "group", lines, cap };
}

/** ラベルが乗りうる線の 1 本。弧長の累積を持ち、弧長の窓を調べられるようにする。 */
export type TracedLine = Readonly<{
  pts: readonly XY[];
  cum: readonly number[];
  closed: boolean;
}>;

export function tracedLine(pts: readonly XY[], closed: boolean): TracedLine {
  return { pts, cum: cumulativeLength(pts), closed };
}

/** 線の組の上の位置。line 番目の線の、始点から弧長 s の点を指す。 */
export type LinePosition = Readonly<{ line: number; s: number }>;

/**
 * ラベルが乗る線の組のうち、ラベルが当然重なる部分を除いた線と矩形の距離。乗っている線は弧長 s から
 * window より離れた部分だけを調べ、同じ組の他の線は全体を調べる。交わる 2 本の等高線のもう一方や、
 * 急に折り返す線の別の部分を見つけるためである。limit より遠い線分は調べない。
 */
export function ownLinesBoxDistance(
  lines: readonly TracedLine[],
  at: LinePosition,
  window: number,
  box: Box,
  limit: number,
): number {
  return lines.reduce(
    (best, line, i) =>
      Math.min(
        best,
        i === at.line
          ? farPartBoxDistance(line.pts, line.cum, at.s, window, line.closed, box, limit)
          : polylineBoxDistance(line.pts, box, limit),
      ),
    Infinity,
  );
}
