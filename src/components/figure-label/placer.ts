// ラベルの配置器。候補の矩形を障害物と既出のラベルに照らして採点し、最も罰点の小さい候補を選ぶ。
//
// 乱数・DOM・実行環境のフォントに頼らず、同じ入力から同じ配置を返す。配置器は状態を持たない。
// 既出のラベルの矩形は呼ぶ側が placeInOrder で受け渡す。

import { boxesOverlap, inflate, polylineBoxDistance, type Box } from "./geometry";
import {
  type BoxObstacle,
  type GroupObstacle,
  type LineObstacle,
  type Obstacle,
} from "./obstacles";
import { glyphBox, type GlyphSize, type LabelPos } from "./label-box";
import { LABEL_POLICY } from "./policy";

/**
 * 配置の候補。box は字形が占める矩形、value は選ばれたときに返す値である。score は障害物の罰点に
 * 候補の好みの罰点を足す関数で、足す罰点は 0 以上でなければならない。最良に届かない候補では呼ばない
 * ので、線の曲がり具合のような重い計算を置ける。
 */
export type Candidate<T> = Readonly<{
  box: Box;
  value: T;
  score?: (penalty: number) => number;
}>;

/** 1 つのラベルの採点の条件。 */
export type PlaceOptions = Readonly<{
  /** 先に置いたラベルの占有矩形。 */
  placed: readonly Box[];
  /** ラベルを収める範囲。 */
  bounds: Box;
  /** 判定から外す障害物の id（ラベル自身の線や点の印）。 */
  exclude?: string;
  /** 淡い線と群を避けるか。既定 true。線の上に置くラベルは false にする。 */
  avoidFaint?: boolean;
  /**
   * 既出のラベルと横に並ぶときに残したいすきま（px）。既定は LABEL_POLICY.labelSpacing である。同じ行に
   * 並ぶ 2 つのラベルは 1 続きの式に読まれやすいので、広く取る図で指定する。
   */
  rowGap?: number;
}>;

/** 配置の結果。候補が無ければ item は null になる。 */
export type Choice<T> = Readonly<{ item: T | null; score: number }>;

export type Placer = Readonly<{
  /** 矩形にラベルを置くときの罰点。 */
  penalty: (box: Box, options: PlaceOptions) => number;
  /** 候補から最も罰点の小さいものを選ぶ。同点なら前方の候補を選ぶ。 */
  place: <T>(cands: readonly Candidate<T>[], options: PlaceOptions) => Choice<T>;
}>;

/** 線の中心から、ラベルの矩形の縁まで空ける距離（px）。 */
export const lineReach =
  LABEL_POLICY.lineClearance + LABEL_POLICY.lineHalfWidth + LABEL_POLICY.glyphSlack;

export function createPlacer(obstacles: readonly Obstacle[]): Placer {
  const boxes = obstacles.filter((o): o is BoxObstacle => o.kind === "box");
  const lines = obstacles.filter((o): o is LineObstacle => o.kind === "line");
  const solidLines = lines.filter((l) => !l.faint);
  const faintLines = lines.filter((l) => l.faint);
  const groups = obstacles.filter((o): o is GroupObstacle => o.kind === "group");

  const penalty = (b: Box, options: PlaceOptions): number => {
    const {
      placed,
      bounds,
      exclude,
      avoidFaint = true,
      rowGap = LABEL_POLICY.labelSpacing,
    } = options;
    const outside =
      b.x0 < bounds.x0 || b.x1 > bounds.x1 || b.y0 < bounds.y0 || b.y1 > bounds.y1
        ? LABEL_POLICY.outside
        : 0;
    // 目盛り数字・軸名・点の印・既出のラベルとは、重なりに加えて接するほどの近さも軽く罰し、
    // 隣り合う文字が 1 続きの式に見える（c=4 と目盛り 2 が「c=4 2」に見えるなど）のを避ける。
    const near = inflate(b, LABEL_POLICY.labelSpacing);
    const nearRow: Box = { ...near, x0: b.x0 - rowGap, x1: b.x1 + rowGap };
    const nearPenalty = (p: number, other: Box, weight: number, zone: Box): number => {
      if (boxesOverlap(b, other)) return p + weight;
      return boxesOverlap(zone, other) ? p + LABEL_POLICY.near : p;
    };
    const byBoxes = boxes.reduce(
      (p, o) =>
        o.id !== undefined && o.id === exclude ? p : nearPenalty(p, o.box, o.weight, near),
      outside,
    );
    const byPlaced = placed.reduce(
      (p, q) => nearPenalty(p, q, LABEL_POLICY.labelOverlap, nearRow),
      byBoxes,
    );
    // 線との判定は矩形と線の本当の距離で行い、線の傾きで結果が変わらないようにする。線に触れる位置と、
    // 触れないがすきまが足りない位置を分けて数え、すきまが取れない図でも線を横切らない位置を選べるよう
    // にする。外接矩形で先に絞り、頂点の多い線を調べる回数を減らす。
    const padded = inflate(b, lineReach);
    const touching = inflate(b, LABEL_POLICY.lineTouch);
    const bySolid = solidLines.reduce((p, l) => {
      if (l.id === exclude || !boxesOverlap(padded, l.bbox)) return p;
      const d = polylineBoxDistance(l.pts, b, lineReach);
      if (d <= LABEL_POLICY.lineTouch) return p + l.weight;
      return d < lineReach ? p + l.weight * LABEL_POLICY.nearLine : p;
    }, byPlaced);
    if (!avoidFaint) return bySolid;
    const touches = (l: LineObstacle): boolean =>
      boxesOverlap(touching, l.bbox) &&
      polylineBoxDistance(l.pts, b, LABEL_POLICY.lineTouch) <= LABEL_POLICY.lineTouch;
    // 淡い線は重なった部分をマスクで切り抜くので、触れるかどうかだけを数える。
    const byFaint = faintLines.reduce(
      (p, l) => (l.id !== exclude && touches(l) ? p + l.weight : p),
      bySolid,
    );
    // 群も触れるかどうかだけを数える。すきまの内側まで数えると、密な場ではどの候補も上限に達し、
    // 重なる矢印の少ない位置を選べない。上限に達した群は、残りの線を調べない。
    return groups.reduce((p, group) => {
      const hits = group.lines.reduce(
        (h, l) => (h < group.cap && touches(l) ? h + l.weight : h),
        0,
      );
      return p + Math.min(hits, group.cap);
    }, byFaint);
  };

  const place = <T>(cands: readonly Candidate<T>[], options: PlaceOptions): Choice<T> => {
    const best = bestOf(cands, (cand, _, bestScore) => {
      const pen = penalty(cand.box, options);
      // 好みの罰点は 0 以上なので、障害物の罰点だけで最良に届かない候補は残りを調べない。
      return cand.score === undefined || pen >= bestScore ? pen : cand.score(pen);
    });
    return { item: best.item === null ? null : best.item.value, score: best.score };
  };

  return { penalty, place };
}

/**
 * 候補のうち、罰点 score が最も小さい候補と罰点を返す。同点なら前方の候補を選ぶ。score には前方の
 * 候補の最小の罰点を渡し、届かないと分かった候補の計算を打ち切れるようにする（打ち切るときは最小の
 * 罰点以上の値を返す）。候補が無いか、どの罰点も Infinity より小さくなければ item は null になる。
 */
export function bestOf<T>(
  cands: readonly T[],
  score: (cand: T, index: number, bestScore: number) => number,
): Choice<T> {
  return cands.reduce<Choice<T>>(
    (best, cand, i) => {
      const p = score(cand, i, best.score);
      return p < best.score ? { item: cand, score: p } : best;
    },
    { item: null, score: Infinity },
  );
}

/** 1 つのラベルを置いた結果。item は置いたもの、box は占有矩形（置かなければ null）。 */
export type Placement<T> = Readonly<{ item: T | null; box: Box | null }>;

/** 何も置かない結果。 */
export const NO_PLACEMENT: Placement<never> = { item: null, box: null };

/** 置いたラベル（LaTeX・配置先・字形の矩形）。 */
export type Label = Readonly<{ tex: string; pos: LabelPos; box: Box }>;

/** 選んだ位置のラベルと占有矩形。位置が無ければ何も置かない。 */
export function placedLabel(tex: string, pos: LabelPos | null, size: GlyphSize): Placement<Label> {
  if (pos === null) return NO_PLACEMENT;
  const box = glyphBox(pos, size);
  return { item: { tex, pos, box }, box };
}

/**
 * sources の順にラベルを 1 つずつ置く。place には、先に置いたラベルの占有矩形 placed を
 * 渡し、後のラベルが先のラベルを避けられるようにする。置いた結果（sources と同じ順）と、最後の
 * 占有矩形の列を返す。
 */
export function placeInOrder<S, T>(
  sources: readonly S[],
  placed: readonly Box[],
  place: (source: S, index: number, placed: readonly Box[]) => Placement<T>,
): Readonly<{ items: readonly (T | null)[]; placed: readonly Box[] }> {
  return sources.reduce<Readonly<{ items: readonly (T | null)[]; placed: readonly Box[] }>>(
    (acc, source, i) => {
      const r = place(source, i, acc.placed);
      return {
        items: [...acc.items, r.item],
        placed: r.box === null ? acc.placed : [...acc.placed, r.box],
      };
    },
    { items: [], placed },
  );
}
