import { Marker } from "@visx/marker";
import { scaleLinear } from "@visx/scale";
import { Circle, Line } from "@visx/shape";
import { useId, type ReactNode } from "react";
import {
  alongBisector,
  besideSegmentCandidates,
  preferringDirection,
  widelyAroundPoint,
} from "./figure-label/candidates";
import type { Box, XY } from "./figure-label/geometry";
import { glyphBox, glyphSizeOf, type GlyphSize, type LabelPos } from "./figure-label/label-box";
import { boxObstacle, lineObstacle } from "./figure-label/obstacles";
import {
  createPlacer,
  NO_PLACEMENT,
  placedLabel,
  type Candidate,
  type Label,
  type Placement,
} from "./figure-label/placer";
import { LABEL_POLICY, OBSTACLE_WEIGHT } from "./figure-label/policy";
import KatexLabel from "./KatexLabel";

/**
 * インライン SVG として描く、ビルド時生成の静的な単位円。
 *
 * 原点を中心とする半径 1 の円の上に、$x$ 軸の正の向きから測った角 $\theta$ の動径と、
 * その先端 $(\cos\theta,\ \sin\theta)$ を描く。余弦・正弦を座標軸への射影として示し、
 * 三角関数の定義を 1 枚の静的な図で表す。本コンポーネントはクライアント JavaScript を
 * 一切載せない。Astro がビルド時に HTML へ描画する（クライアントディレクティブなし、
 * ハイドレーションなし）。座標計算には visx の `@visx/scale`（`scaleLinear`）を用い、
 * 円・軸・射影は `@visx/shape` の `Circle`・`Line` で描く。ラベルは KatexLabel を介して
 * KaTeX で組版し、`figure-label/` の配置器が線と点を避ける位置へ置く。
 */

type UnitCircleProps = Readonly<{
  /** 動径の角（度）。$x$ 軸の正の向きから反時計回りに測る。 */
  angleDeg: number;
  /** 先端の座標に添える LaTeX ラベル。省略時は描かない。 */
  pointLabel?: string;
  /** 角の弧と $\theta$ ラベルを描くか。既定 true。 */
  showAngle?: boolean;
  /** 角に添える LaTeX ラベル。既定 "\\theta"。 */
  angleLabel?: string;
  /** 余弦・正弦の射影（破線）を描くか。既定 true。 */
  showProjections?: boolean;
  /** 余弦の射影に添える LaTeX ラベル。既定 "\\cos\\theta"。 */
  cosLabel?: string;
  /** 正弦の射影に添える LaTeX ラベル。既定 "\\sin\\theta"。 */
  sinLabel?: string;
  /** 支援技術が読み上げるアクセシブルな説明。 */
  ariaLabel: string;
}>;

// 軸・円は global.css の CSS 変数でテーマに追従する（暗テーマで沈める）。
const AXIS = "var(--fig-axis)";
const CIRCLE = "var(--fig-axis)";
const RADIUS = "#3b82f6";
const HIGHLIGHT = "#f59e0b";

const VIEW = 280;
const PAD = 36;

// 先端の点の半径（px）と、ラベルの字の大きさ（KatexLabel の fontSize）。
const POINT_R = 3.6;
const LABEL_FONT = 12;

// 配置の範囲。viewBox の縁から 2px 内側に収める。
const VIEW_BOUNDS: Box = { x0: 2, x1: VIEW - 2, y0: 2, y1: VIEW - 2 };

// 障害物にする円と弧の標本の数。
const CIRCLE_SAMPLES = 96;
const ARC_SAMPLES = 16;

// 射影のラベルを線分に沿って試す位置（線分の端からの割合）。線分の中点に近いほど好む。
const PROJECTION_FRACTIONS: readonly number[] = [0.6, 0.45, 0.75, 0.3, 0.9];

// 角のラベルを試す、中心からの距離（弧の半径に対する倍率）。前の距離ほど優先する。
const ANGLE_RADII: readonly number[] = [1.7, 2, 2.3, 2.7];

// 角のラベルを試す向き。二等分線からのずれを、角の半分に対する割合で表す。同じ罰点なら前の向きを選ぶ。
const ANGLE_SPREADS: readonly number[] = [0, 0.2, -0.2, 0.45, -0.45];

// 先端のラベルを円の外向きへ寄せる罰点の係数。
const POINT_OUTWARD_WEIGHT = 2;

export default function UnitCircle({
  angleDeg,
  pointLabel,
  showAngle = true,
  angleLabel = "\\theta",
  showProjections = true,
  cosLabel = "\\cos\\theta",
  sinLabel = "\\sin\\theta",
  ariaLabel,
}: UnitCircleProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const arrow = `ucArrow-${uid}`;

  // 数学座標 [-1.3, 1.3] を描画領域へ写す。横縦で同じ倍率にし、円を歪めない。
  const s = scaleLinear<number>({
    domain: [-1.3, 1.3],
    range: [PAD, VIEW - PAD],
  });
  const cx = s(0);
  const cy = s(0);
  const r = s(1) - s(0); // 半径 1 の画面上の長さ。

  const X = (mx: number) => s(mx);
  const Y = (my: number) => VIEW - PAD - (s(my) - PAD); // y 方向は上向きを正にする。

  const theta = (angleDeg * Math.PI) / 180;
  const px = Math.cos(theta);
  const py = Math.sin(theta);
  const tipX = X(px);
  const tipY = Y(py);

  // 角の弧。半径 0.28 の小円弧で θ を示す。
  const ar = r * 0.28;
  const arcEndX = cx + ar * Math.cos(theta);
  const arcEndY = cy - ar * Math.sin(theta);
  const largeArc = Math.abs(angleDeg) > 180 ? 1 : 0;
  const sweep = angleDeg >= 0 ? 0 : 1;
  const arcMidA = theta / 2;

  // ---- ラベルの配置 ----
  // 軸・円・動径・射影を障害物に積み、ラベルが線に重ならない候補を選ぶ。先端の座標 → 余弦 → 角 → 正弦の順に
  // 置く。幅の広いラベルと、弧のそばを離れられないラベルを先に置く。
  const W = OBSTACLE_WEIGHT;
  const origin: XY = { x: cx, y: cy };
  const tip: XY = { x: tipX, y: tipY };
  const circlePts: readonly XY[] = Array.from({ length: CIRCLE_SAMPLES + 1 }, (_, i) => {
    const a = (2 * Math.PI * i) / CIRCLE_SAMPLES;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
  const arcPts: readonly XY[] = Array.from({ length: ARC_SAMPLES + 1 }, (_, i) => {
    const a = (theta * i) / ARC_SAMPLES;
    return { x: cx + ar * Math.cos(a), y: cy - ar * Math.sin(a) };
  });
  const xName: XY = { x: VIEW - PAD + 12, y: cy + 12 };
  const yName: XY = { x: cx - 12, y: PAD - 12 };
  const axisNameBoxes: readonly Box[] = [
    glyphBox({ ...xName, align: "center" }, glyphSizeOf("x", LABEL_FONT)),
    glyphBox({ ...yName, align: "center" }, glyphSizeOf("y", LABEL_FONT)),
  ];
  const placer = createPlacer([
    boxObstacle(
      { x0: tipX - POINT_R, x1: tipX + POINT_R, y0: tipY - POINT_R, y1: tipY + POINT_R },
      W.point,
      "tip",
    ),
    ...lineObstacle(
      "ax-x",
      [
        { x: PAD - 6, y: cy },
        { x: VIEW - PAD + 6, y: cy },
      ],
      W.axis,
    ),
    ...lineObstacle(
      "ax-y",
      [
        { x: cx, y: VIEW - PAD + 6 },
        { x: cx, y: PAD - 6 },
      ],
      W.axis,
    ),
    ...lineObstacle("circle", circlePts, W.line),
    ...lineObstacle("radius", [origin, tip], W.line),
    ...(showProjections
      ? [
          ...lineObstacle("proj-x", [tip, { x: tipX, y: cy }], W.edge),
          ...lineObstacle("proj-y", [tip, { x: cx, y: tipY }], W.edge),
        ]
      : []),
    ...(showAngle ? lineObstacle("arc", arcPts, W.line) : []),
  ]);
  const place = (
    tex: string,
    candidates: (size: GlyphSize) => readonly Candidate<LabelPos>[],
    placed: readonly Box[],
    exclude?: string,
  ): Placement<Label> => {
    const size = glyphSizeOf(tex, LABEL_FONT);
    const pos = placer.place(candidates(size), {
      placed,
      bounds: VIEW_BOUNDS,
      exclude,
      rowGap: LABEL_POLICY.rowGap,
    }).item;
    return placedLabel(tex, pos, size);
  };

  // 中心から外向きの単位ベクトル。先端のラベルをこの向きへ出す。
  const outward: XY = { x: px, y: -py };

  const pointPlaced =
    pointLabel === undefined
      ? NO_PLACEMENT
      : place(
          pointLabel,
          (size) =>
            preferringDirection(
              widelyAroundPoint(tip, size, POINT_R),
              tip,
              outward,
              POINT_OUTWARD_WEIGHT,
            ),
          axisNameBoxes,
          "tip",
        );
  const afterPoint: readonly Box[] =
    pointPlaced.box === null ? axisNameBoxes : [...axisNameBoxes, pointPlaced.box];

  // 射影の線分のそばに置く。besideSegment は a から b へ進む向きの右側を先に試すので、点と反対側の軸の外が
  // 右側になる向きに両端を渡す。
  const beside = (tex: string, foot: XY, towardFoot: boolean, placed: readonly Box[]) => {
    const [a, b] = towardFoot ? [origin, foot] : [foot, origin];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    return place(
      tex,
      (size) =>
        // 角が軸の上にあると射影が点に潰れるので、足のまわりから選ぶ。
        length < size.width
          ? widelyAroundPoint(foot, size, 0)
          : besideSegmentCandidates(a, b, size, undefined, PROJECTION_FRACTIONS),
      placed,
    );
  };
  const cosPlaced = showProjections
    ? beside(cosLabel, { x: tipX, y: cy }, py >= 0 === px >= 0, afterPoint)
    : NO_PLACEMENT;
  const afterCos: readonly Box[] =
    cosPlaced.box === null ? afterPoint : [...afterPoint, cosPlaced.box];

  // 角のラベルは弧の二等分線の近くの、弧より外に置く。正弦のラベルより先に置き、弧のそばを取る。弧のそばが
  // 動径や破線でふさがる図のために、二等分線から少しずらした向きも試す。
  const anglePlaced = showAngle
    ? place(
        angleLabel,
        (size) =>
          ANGLE_SPREADS.flatMap((spread) =>
            alongBisector(
              origin,
              {
                x: Math.cos(arcMidA + (theta / 2) * spread),
                y: -Math.sin(arcMidA + (theta / 2) * spread),
              },
              size,
              ANGLE_RADII.map((k) => ar * k),
            ),
          ),
        afterCos,
      )
    : NO_PLACEMENT;
  const sinPlaced = showProjections
    ? beside(
        sinLabel,
        { x: cx, y: tipY },
        px >= 0 === py < 0,
        anglePlaced.box === null ? afterCos : [...afterCos, anglePlaced.box],
      )
    : NO_PLACEMENT;

  const labelNode = (l: Label | null): ReactNode =>
    l && (
      <KatexLabel tex={l.tex} x={l.pos.x} y={l.pos.y} fontSize={LABEL_FONT} align={l.pos.align} />
    );

  return (
    <svg className="unit-circle" viewBox={`0 0 ${VIEW} ${VIEW}`} role="img" aria-label={ariaLabel}>
      <defs>
        <Marker
          id={arrow}
          viewBox="0 0 10 10"
          refX={8}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          markerUnits="strokeWidth"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={AXIS} />
        </Marker>
      </defs>

      {/* 軸。 */}
      <Line
        from={{ x: PAD - 6, y: cy }}
        to={{ x: VIEW - PAD + 6, y: cy }}
        stroke={AXIS}
        strokeWidth={1.3}
        markerStart={`url(#${arrow})`}
        markerEnd={`url(#${arrow})`}
      />
      <Line
        from={{ x: cx, y: VIEW - PAD + 6 }}
        to={{ x: cx, y: PAD - 6 }}
        stroke={AXIS}
        strokeWidth={1.3}
        markerStart={`url(#${arrow})`}
        markerEnd={`url(#${arrow})`}
      />
      <KatexLabel tex="x" x={xName.x} y={xName.y} fontSize={LABEL_FONT} />
      <KatexLabel tex="y" x={yName.x} y={yName.y} fontSize={LABEL_FONT} />

      {/* 単位円。 */}
      <Circle cx={cx} cy={cy} r={r} fill="none" stroke={CIRCLE} strokeWidth={1.4} />

      {/* 射影（破線）。 */}
      {showProjections && (
        <g>
          <Line
            from={{ x: tipX, y: tipY }}
            to={{ x: tipX, y: cy }}
            stroke={HIGHLIGHT}
            strokeWidth={1.3}
            strokeDasharray="4 3"
          />
          <Line
            from={{ x: tipX, y: tipY }}
            to={{ x: cx, y: tipY }}
            stroke={HIGHLIGHT}
            strokeWidth={1.3}
            strokeDasharray="4 3"
          />
          {/* 余弦は x 軸の、正弦は y 軸の、射影の足までの線分のそばに置く。点と反対側を先に試す。 */}
          {labelNode(cosPlaced.item)}
          {labelNode(sinPlaced.item)}
        </g>
      )}

      {/* 動径。 */}
      <Line from={{ x: cx, y: cy }} to={{ x: tipX, y: tipY }} stroke={RADIUS} strokeWidth={2} />

      {/* 角の弧と θ ラベル。 */}
      {showAngle && (
        <g>
          <path
            d={`M ${cx + ar} ${cy} A ${ar} ${ar} 0 ${largeArc} ${sweep} ${arcEndX} ${arcEndY}`}
            fill="none"
            stroke={RADIUS}
            strokeWidth={1.3}
          />
          {labelNode(anglePlaced.item)}
        </g>
      )}

      {/* 先端の点とラベル。 */}
      <Circle cx={tipX} cy={tipY} r={POINT_R} fill={RADIUS} />
      {labelNode(pointPlaced.item)}
    </svg>
  );
}
