import { Marker } from "@visx/marker";
import { scaleLinear } from "@visx/scale";
import { Circle, Line } from "@visx/shape";
import { useId } from "react";
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
 * KaTeX で組版する。
 */

type UnitCircleProps = {
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
};

// 軸・円は global.css の CSS 変数でテーマに追従する（暗テーマで沈める）。
const AXIS = "var(--fig-axis)";
const CIRCLE = "var(--fig-axis)";
const RADIUS = "#3b82f6";
const HIGHLIGHT = "#f59e0b";

const VIEW = 280;
const PAD = 36;

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
      <KatexLabel tex="x" x={VIEW - PAD + 12} y={cy + 12} fontSize={12} />
      <KatexLabel tex="y" x={cx - 12} y={PAD - 12} fontSize={12} />

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
          {/* 余弦（横の射影）のラベルは x 軸の射影の上または下に置く。点の上下に応じて
              軸の反対側へ離し、原点近くの角の弧と重ならないよう射影の足側へ寄せる。 */}
          <KatexLabel
            tex={cosLabel}
            x={cx * 0.35 + tipX * 0.65}
            y={cy + (py >= 0 ? 15 : -15)}
            fontSize={12}
          />
          {/* 正弦（縦の射影）のラベルは、点と反対側の y 軸の外へ置く。第2・第3象限では
              点が y 軸の左にあり、横射影の破線が y 軸の左へ伸びる。ラベルを常に左へ置くと
              破線・動径・θ と重なるため、点の左右（px の符号）に応じて配置側を反転する。 */}
          <KatexLabel
            tex={sinLabel}
            x={px >= 0 ? cx - 14 : cx + 14}
            y={tipY + (py >= 0 ? -12 : 12)}
            fontSize={12}
            align={px >= 0 ? "right" : "left"}
          />
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
          <KatexLabel
            tex={angleLabel}
            x={cx + ar * 1.7 * Math.cos(arcMidA)}
            y={cy - ar * 1.7 * Math.sin(arcMidA)}
            fontSize={12}
          />
        </g>
      )}

      {/* 先端の点とラベル。 */}
      <Circle cx={tipX} cy={tipY} r={3.6} fill={RADIUS} />
      {/* 先端のラベルは中心から外向き（点の左右・上下と同じ向き）へ離し、射影の破線・点と
          重ねない。第3・第4象限の下側の点でもラベルを下の外側へ置く。座標ラベルは幅が広い
          ため、中央の x を viewBox 内へクランプし、端での切れを防ぐ。 */}
      {pointLabel !== undefined && (
        <KatexLabel
          tex={pointLabel}
          x={Math.max(52, Math.min(VIEW - 52, tipX + (px >= 0 ? 28 : -28)))}
          y={tipY + (py >= 0 ? -14 : 18)}
          width={96}
          fontSize={12}
        />
      )}
    </svg>
  );
}
