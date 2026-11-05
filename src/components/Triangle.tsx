import { scaleLinear } from "@visx/scale";
import { Circle, Line, Polygon } from "@visx/shape";
import { Fragment, type ReactNode } from "react";
import {
  alongBisector,
  besideSegmentCandidates,
  lineLabelCandidates,
  pointLabelCandidates,
  preferringDirection,
  widelyAroundPoint,
  type LabelDirSpec,
} from "./figure-label/candidates";
import type { Box, XY } from "./figure-label/geometry";
import { glyphSizeOf, type GlyphSize, type LabelPos } from "./figure-label/label-box";
import { boxObstacle, lineObstacle } from "./figure-label/obstacles";
import {
  createPlacer,
  NO_PLACEMENT,
  placedLabel,
  placeInOrder,
  type Candidate,
  type Label,
  type Placement,
} from "./figure-label/placer";
import { LABEL_POLICY, OBSTACLE_WEIGHT } from "./figure-label/policy";
import KatexLabel from "./KatexLabel";

/**
 * インライン SVG として描く、ビルド時生成の静的な三角形。
 *
 * 3 頂点の座標から三角形を描き、頂点名・辺の長さ・内角・直角の印を添える。直角三角形に
 * よる三角比の定義や、正弦定理・余弦定理の図に使う。本コンポーネントはクライアント
 * JavaScript を一切載せない。Astro がビルド時に HTML へ描画する（クライアントディレク
 * ティブなし、ハイドレーションなし）。横縦で同じ倍率にし、形を歪めない。ラベルは
 * KatexLabel を介して KaTeX で組版し、`figure-label/` の配置器が線と点を避ける位置へ置く。
 */

/** ラベルの向きとすきまの指定。意味は FunctionGraph の同じ名前の指定と同じである。 */
type LabelProps = Readonly<{
  /** 基準点から見たラベルの向き。"auto" は向きを自動で選ぶ。 */
  labelDir?: LabelDirSpec;
  /** 線や点の印とラベルの字形のすきまの目標（px）。既定は 4。 */
  labelOffset?: number;
}>;

type Vertex = LabelProps &
  Readonly<{
    /** 頂点の数学座標。 */
    x: number;
    y: number;
    /** 頂点に添える LaTeX ラベル（例: "A"）。 */
    label?: string;
  }>;

/** 辺に添えるラベル。`from`・`to` は vertices の添字（0,1,2）。 */
type EdgeLabel = LabelProps &
  Readonly<{
    from: number;
    to: number;
    /** 辺の中点付近に置く LaTeX ラベル（例: "c"、"a"）。 */
    label: string;
  }>;

/** 頂点での内角の印とラベル。`at` は vertices の添字。 */
type AngleMark = Readonly<{
  at: number;
  /** 角に添える LaTeX ラベル（例: "A"、"\\theta"、"90^\\circ"）。 */
  label?: string;
  /** 直角の印（小さな四角）で描くか。既定 false（弧で描く）。 */
  right?: boolean;
}>;

/** 数学座標の点。 */
type Pt = Readonly<{ x: number; y: number }>;

/** 追加の補助線分（破線）。垂線の足までの底辺の延長などに使う。 */
type Segment = Readonly<{ from: Pt; to: Pt }>;

/**
 * 頂点から底辺へ下ろした垂線。高さの線分（破線）・足の点・直角の印をまとめて描く。
 * `toward` は底辺に沿う向きを示す点（直角の印の向きづけに使う）。
 */
type Perpendicular = Readonly<{
  from: Pt;
  foot: Pt;
  toward: Pt;
  /** 高さの線分に添えるラベル（例: "h"）。 */
  label?: string;
  /** 足に添えるラベル（例: "H"）。 */
  footLabel?: string;
}>;

type TriangleProps = Readonly<{
  /** 3 頂点。反時計回り・時計回りのどちらでもよい。 */
  vertices: readonly [Vertex, Vertex, Vertex];
  /** 辺のラベル。 */
  edges?: readonly EdgeLabel[];
  /** 内角の印。 */
  angles?: readonly AngleMark[];
  /** 補助線分（破線）。底辺の延長などに使う。 */
  segments?: readonly Segment[];
  /** 頂点から底辺へ下ろした垂線（高さ・足・直角の印）。 */
  perpendiculars?: readonly Perpendicular[];
  /**
   * 1 数学単位あたりのピクセル数を固定する。複数の図で縮尺をそろえる（合同な三角形を
   * 同じ大きさで描く）ときに使う。省略時は viewBox に合わせて自動でフィットする。
   */
  unitScale?: number;
  /** 支援技術が読み上げるアクセシブルな説明。 */
  ariaLabel: string;
}>;

const STROKE = "#3b82f6";
const FILL = "#3b82f6";
// 角・辺・補助線の印は global.css の CSS 変数でテーマに追従する。
const MARK = "var(--fig-axis)";

const VIEW_W = 320;
const VIEW_H = 240;
const PAD = 36;

// 配置の範囲。viewBox の縁から 2px 内側に収める。
const VIEW_BOUNDS: Box = { x0: 2, x1: VIEW_W - 2, y0: 2, y1: VIEW_H - 2 };

// 頂点・足の点の半径（px）、角の弧の半径（px）、頂点と足の直角の印の辺の長さ（px）。
const VERTEX_R = 3.2;
const FOOT_R = 3;
const ARC_R = 20;
const RIGHT_MARK = 12;
const FOOT_MARK = 11;

// 頂点の名前・辺・高さの字の大きさと、角のラベルの字の大きさ（KatexLabel の fontSize）。
const NAME_FONT = 13;
const ANGLE_FONT = 12;

// 辺と高さのラベルを線に沿って試す位置（線の長さに対する割合）。前の位置ほど優先する。
const EDGE_FRACTIONS: readonly number[] = [0.5, 0.4, 0.6, 0.3, 0.7];

// 角のラベルを試す、頂点からの距離（px）。前の距離ほど優先する。
const ANGLE_DISTANCES: readonly number[] = [34, 38, 30, 42, 46, 50, 56];

// 頂点の名前と辺のラベルを、重心と反対の向きへ寄せる罰点の係数。
const OUTWARD_WEIGHT = 2;

export default function Triangle({
  vertices,
  edges = [],
  angles = [],
  segments = [],
  perpendiculars = [],
  unitScale,
  ariaLabel,
}: TriangleProps) {
  // 頂点の座標範囲から、横縦同じ倍率のスケールを作り中央へ収める。
  const xs = vertices.map((v) => v.x);
  const ys = vertices.map((v) => v.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const availW = VIEW_W - 2 * PAD;
  const availH = VIEW_H - 2 * PAD;
  // unitScale が指定されればその縮尺を使い、複数の図で大きさをそろえる。
  const unit = unitScale ?? Math.min(availW / spanX, availH / spanY);
  const boxW = unit * spanX;
  const boxH = unit * spanY;
  const offX = PAD + (availW - boxW) / 2;
  const offY = PAD + (availH - boxH) / 2;

  const sx = scaleLinear<number>({
    domain: [minX, maxX],
    range: [offX, offX + boxW],
  });
  const sy = scaleLinear<number>({
    domain: [minY, maxY],
    range: [offY + boxH, offY], // 上向きを正にする。
  });

  const P = vertices.map((v) => ({ x: sx(v.x), y: sy(v.y) }));
  const centroid = {
    x: (P[0].x + P[1].x + P[2].x) / 3,
    y: (P[0].y + P[1].y + P[2].y) / 3,
  };

  // ---- ラベルの配置 ----
  // 辺・補助線・垂線・弧・直角の印・頂点を障害物に積み、頂点 → 足 → 辺 → 高さ → 角の順にラベルを置く。図形の
  // 外に置くラベルを先に置き、内側の角のラベルが残りを使う。
  const W = OBSTACLE_WEIGHT;
  const screenOf = (q: Pt): XY => ({ x: sx(q.x), y: sy(q.y) });
  const outwardFrom = (q: XY): XY => unitVec(centroid, q);
  const angleMarks = angles.flatMap((a) => {
    if (a.right === true) {
      const others = otherVertices(P, a.at);
      return lineObstacle(
        `ang${a.at}`,
        rightMark(P[a.at], others[0], others[1], RIGHT_MARK),
        W.thinLine,
      );
    }
    const { start, end, mid } = arcOf(P, a.at);
    return lineObstacle(`ang${a.at}`, [start, mid, end], W.thinLine);
  });
  const footMarks = perpendiculars.flatMap((pp, i) =>
    lineObstacle(
      `fm${i}`,
      rightMark(screenOf(pp.foot), screenOf(pp.from), screenOf(pp.toward), FOOT_MARK),
      W.thinLine,
    ),
  );
  const placer = createPlacer([
    ...P.map((q, i) => boxObstacle(pointBox(q, VERTEX_R), W.point, `v${i}`)),
    ...perpendiculars.map((pp, i) =>
      boxObstacle(pointBox(screenOf(pp.foot), FOOT_R), W.point, `f${i}`),
    ),
    ...lineObstacle("sides", [P[0], P[1], P[2], P[0]], W.line),
    ...segments.flatMap((s) => lineObstacle("sg", [screenOf(s.from), screenOf(s.to)], W.edge)),
    ...perpendiculars.flatMap((pp, i) =>
      lineObstacle(`pp${i}`, [screenOf(pp.from), screenOf(pp.foot)], W.edge),
    ),
    ...angleMarks,
    ...footMarks,
  ]);
  const place = (
    tex: string,
    fontSize: number,
    candidates: (size: GlyphSize) => readonly Candidate<LabelPos>[],
    placed: readonly Box[],
    exclude?: string,
  ): Placement<Label> => {
    const size = glyphSizeOf(tex, fontSize);
    const pos = placer.place(candidates(size), {
      placed,
      bounds: VIEW_BOUNDS,
      exclude,
      rowGap: LABEL_POLICY.rowGap,
    }).item;
    return placedLabel(tex, pos, size);
  };

  const vertexLabels = placeInOrder(vertices, [], (v, i, placed) => {
    if (v.label === undefined) return NO_PLACEMENT;
    const at = P[i];
    return place(
      v.label,
      NAME_FONT,
      (size) =>
        pointLabelCandidates(
          { at: undefined, dir: v.labelDir, offset: v.labelOffset },
          at,
          size,
          VERTEX_R,
          () =>
            preferringDirection(
              widelyAroundPoint(at, size, VERTEX_R, v.labelOffset),
              at,
              outwardFrom(at),
              OUTWARD_WEIGHT,
            ),
        ),
      placed,
      `v${i}`,
    );
  });
  const footLabels = placeInOrder(perpendiculars, vertexLabels.placed, (pp, i, placed) => {
    if (pp.footLabel === undefined) return NO_PLACEMENT;
    const at = screenOf(pp.foot);
    return place(
      pp.footLabel,
      NAME_FONT,
      (size) =>
        preferringDirection(
          widelyAroundPoint(at, size, FOOT_R),
          at,
          outwardFrom(at),
          OUTWARD_WEIGHT,
        ),
      placed,
      `f${i}`,
    );
  });
  const edgeLabels = placeInOrder(edges, footLabels.placed, (e, _, placed) => {
    const p1 = P[e.from];
    const p2 = P[e.to];
    return place(
      e.label,
      NAME_FONT,
      (size) => {
        const spec = { at: undefined, dir: e.labelDir, offset: e.labelOffset };
        const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        return lineLabelCandidates(spec, p1, p2, size, (offset) =>
          preferringDirection(
            besideSegmentCandidates(p1, p2, size, offset, EDGE_FRACTIONS),
            mid,
            outwardFrom(mid),
            OUTWARD_WEIGHT,
          ),
        );
      },
      placed,
    );
  });
  const heightLabels = placeInOrder(perpendiculars, edgeLabels.placed, (pp, i, placed) => {
    if (pp.label === undefined) return NO_PLACEMENT;
    const a = screenOf(pp.from);
    const b = screenOf(pp.foot);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return place(
      pp.label,
      NAME_FONT,
      (size) =>
        preferringDirection(
          besideSegmentCandidates(a, b, size, undefined, EDGE_FRACTIONS),
          mid,
          outwardFrom(mid),
          OUTWARD_WEIGHT,
        ),
      placed,
      `pp${i}`,
    );
  });
  const angleLabels = placeInOrder(angles, heightLabels.placed, (a, _, placed) => {
    if (a.right === true || a.label === undefined) return NO_PLACEMENT;
    const v = P[a.at];
    const { bisector } = arcOf(P, a.at);
    return place(
      a.label,
      ANGLE_FONT,
      (size) => alongBisector(v, bisector, size, ANGLE_DISTANCES),
      placed,
    );
  });

  return (
    <svg
      className="triangle-figure"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label={ariaLabel}
    >
      {/* 三角形の面。 */}
      <Polygon
        points={P.map((p): [number, number] => [p.x, p.y])}
        fill={FILL}
        fillOpacity={0.08}
        stroke={STROKE}
        strokeWidth={2}
        strokeLinejoin="round"
      />

      {/* 角の印。 */}
      {angles.map((a, i) => {
        if (a.right) {
          const others = otherVertices(P, a.at);
          return (
            <polyline
              key={`ang-${i}`}
              points={markPoints(rightMark(P[a.at], others[0], others[1], RIGHT_MARK))}
              fill="none"
              stroke={MARK}
              strokeWidth={1.3}
            />
          );
        }
        // 弧と角ラベル。
        const { start, end, sweepFlag } = arcOf(P, a.at);
        return (
          <g key={`ang-${i}`}>
            <path
              d={`M ${start.x} ${start.y} A ${ARC_R} ${ARC_R} 0 0 ${sweepFlag} ${end.x} ${end.y}`}
              fill="none"
              stroke={MARK}
              strokeWidth={1.3}
            />
            {labelNode(angleLabels.items[i], ANGLE_FONT)}
          </g>
        );
      })}

      {/* 補助線分（破線）。底辺の延長などを表す。 */}
      {segments.map((s, i) => (
        <Line
          key={`seg-${i}`}
          from={{ x: sx(s.from.x), y: sy(s.from.y) }}
          to={{ x: sx(s.to.x), y: sy(s.to.y) }}
          stroke={MARK}
          strokeWidth={1.3}
          strokeDasharray="4 3"
        />
      ))}

      {/* 垂線（高さ）・足の点・直角の印。 */}
      {perpendiculars.map((pp, i) => {
        const f = { x: sx(pp.from.x), y: sy(pp.from.y) };
        const h = { x: sx(pp.foot.x), y: sy(pp.foot.y) };
        return (
          <g key={`perp-${i}`}>
            <Line
              from={{ x: f.x, y: f.y }}
              to={{ x: h.x, y: h.y }}
              stroke={MARK}
              strokeWidth={1.3}
              strokeDasharray="4 3"
            />
            <polyline
              points={markPoints(rightMark(h, f, screenOf(pp.toward), FOOT_MARK))}
              fill="none"
              stroke={MARK}
              strokeWidth={1.3}
            />
            <Circle cx={h.x} cy={h.y} r={FOOT_R} fill={STROKE} />
            {labelNode(heightLabels.items[i], NAME_FONT)}
            {labelNode(footLabels.items[i], NAME_FONT)}
          </g>
        );
      })}

      {/* 辺のラベル。中点のそばの、重心と反対の側を好む。 */}
      {edgeLabels.items.map((l, i) => (
        <Fragment key={`edge-${i}`}>{labelNode(l, NAME_FONT)}</Fragment>
      ))}

      {/* 頂点の点と名前。名前は重心と反対の向きを好む。 */}
      {P.map((p, i) => (
        <g key={`v-${i}`}>
          <Circle cx={p.x} cy={p.y} r={VERTEX_R} fill={STROKE} />
          {labelNode(vertexLabels.items[i], NAME_FONT)}
        </g>
      ))}
    </svg>
  );
}

/**
 * 角の差が -π 以下なら 2π を足し、-π より大きくする。
 *
 * 折り返しは wrapBelowPi と 2 段に分け、先に下側、次に上側の順で 1 回ずつ通す。
 * 両側を 1 つの関数で繰り返し折り返すと、上側の折り返しで丸めにより -π ちょうどになった値を
 * もう一度折り返し、角の向き（弧の sweep）が変わりうる。
 */
function wrapAbovePi(diff: number): number {
  return diff <= -Math.PI ? wrapAbovePi(diff + 2 * Math.PI) : diff;
}

/** 角の差が π より大きければ 2π を引き、π 以下にする。 */
function wrapBelowPi(diff: number): number {
  return diff > Math.PI ? wrapBelowPi(diff - 2 * Math.PI) : diff;
}

/** 頂点 at のほかの 2 頂点。 */
function otherVertices(P: readonly XY[], at: number): readonly XY[] {
  return [0, 1, 2].filter((k) => k !== at).map((k) => P[k]);
}

/** 頂点 v の直角の印の折れ線。a・b は直角をはさむ辺の上の点、d は印の辺の長さである。 */
function rightMark(v: XY, a: XY, b: XY, d: number): readonly XY[] {
  const u1 = unitVec(v, a);
  const u2 = unitVec(v, b);
  const c1 = { x: v.x + u1.x * d, y: v.y + u1.y * d };
  const c2 = { x: v.x + u2.x * d, y: v.y + u2.y * d };
  return [c1, { x: c1.x + u2.x * d, y: c1.y + u2.y * d }, c2];
}

/** 折れ線を polyline の points 属性にする。 */
function markPoints(pts: readonly XY[]): string {
  return pts.map((q) => `${q.x},${q.y}`).join(" ");
}

/** 点の印の占める矩形。 */
function pointBox(q: XY, r: number): Box {
  return { x0: q.x - r, x1: q.x + r, y0: q.y - r, y1: q.y + r };
}

/** 置いたラベルを描く。ラベルの無い要素では何も描かない。 */
function labelNode(l: Label | null, fontSize: number): ReactNode {
  return (
    l && <KatexLabel tex={l.tex} x={l.pos.x} y={l.pos.y} fontSize={fontSize} align={l.pos.align} />
  );
}

/** 頂点 at の内角の弧の始点・中点・終点と、掃く向き、角の二等分線の単位ベクトル。 */
function arcOf(
  P: readonly XY[],
  at: number,
): Readonly<{ start: XY; mid: XY; end: XY; sweepFlag: 0 | 1; bisector: XY }> {
  const v = P[at];
  const others = otherVertices(P, at);
  const u1 = unitVec(v, others[0]);
  const u2 = unitVec(v, others[1]);
  const a1 = Math.atan2(u1.y, u1.x);
  const a2 = Math.atan2(u2.y, u2.x);
  const diff = wrapBelowPi(wrapAbovePi(a2 - a1));
  const bis = { x: (u1.x + u2.x) / 2, y: (u1.y + u2.y) / 2 };
  const bisLen = Math.hypot(bis.x, bis.y) || 1;
  const bisector = { x: bis.x / bisLen, y: bis.y / bisLen };
  return {
    start: { x: v.x + ARC_R * Math.cos(a1), y: v.y + ARC_R * Math.sin(a1) },
    mid: { x: v.x + ARC_R * bisector.x, y: v.y + ARC_R * bisector.y },
    end: { x: v.x + ARC_R * Math.cos(a2), y: v.y + ARC_R * Math.sin(a2) },
    sweepFlag: diff > 0 ? 1 : 0,
    bisector,
  };
}

/** v から w へ向かう単位ベクトル（SVG 座標）。 */
function unitVec(v: Pt, w: Pt) {
  const dx = w.x - v.x;
  const dy = w.y - v.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}
