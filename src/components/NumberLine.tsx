import { scaleLinear } from "d3-scale";
import { useId } from "react";
import type { ReactNode } from "react";
import KatexLabel from "./KatexLabel";

/**
 * インライン SVG として描く、ビルド時生成の静的な数直線。
 *
 * 実数を 1 本の水平な軸上の点として表す。点・区間・端点の開閉（白丸／黒丸）を、
 * 双方向性に頼らず自身で描く。本コンポーネントはクライアント JavaScript を一切載せ
 * ない。Astro がビルド時に HTML へ描画する（クライアントディレクティブなし、ハイド
 * レーションなし）。座標計算には D3 の `scaleLinear` を用いる。目盛り・点のラベルは
 * KatexLabel を介して KaTeX で組版し、本文のインライン数式と同一の字形にそろえる。
 */

/** 軸上に目盛りとして表示する刻み。`label` を省くと数値をそのまま描く。 */
type Tick = {
  /** 目盛りの位置（実数値）。 */
  value: number;
  /** 目盛りに添える LaTeX 文字列。省略時は value を描く。 */
  label?: string;
};

/** 軸上の 1 点。塗りつぶしの丸で表す。 */
type Point = {
  value: number;
  /** 点の真上に添える LaTeX 文字列。 */
  label?: string;
  /** 強調色で描くか。既定は false（通常の文字色）。 */
  highlight?: boolean;
};

/** 軸上の区間。端点の開閉を丸の塗りで表す。 */
type Interval = {
  /** 左端の値。負の無限大側へ伸ばすときは省略する。 */
  from?: number;
  /** 右端の値。正の無限大側へ伸ばすときは省略する。 */
  to?: number;
  /** 左端を含むか（閉区間端＝黒丸）。既定は false（開＝白丸）。端が無い側では無視する。 */
  fromClosed?: boolean;
  /** 右端を含むか（閉区間端＝黒丸）。既定は false（開＝白丸）。端が無い側では無視する。 */
  toClosed?: boolean;
};

type NumberLineProps = {
  /** 軸の最小値。 */
  min: number;
  /** 軸の最大値。 */
  max: number;
  /** 目盛り。省略時は目盛りを描かない（軸線と矢印だけを描く）。 */
  ticks?: Tick[];
  /** 軸上に置く点。 */
  points?: Point[];
  /** 軸上に塗る区間。 */
  intervals?: Interval[];
  /** 支援技術が読み上げるアクセシブルな説明。 */
  ariaLabel: string;
};

const AXIS = "#94a3b8";
const HIGHLIGHT = "#f59e0b";

// 描画領域。viewBox は VennDiagram と同じ 320×（縦は数直線向けに低め）に合わせる。
const VIEW_W = 320;
const VIEW_H = 96;
const PAD = 24; // 軸の左右の余白。矢印と端のラベルを収める。
const AXIS_Y = 56; // 軸線の縦位置。
const TICK_LEN = 5; // 目盛りの縦棒の長さ（軸の上下へ伸ばす半分）。

export default function NumberLine({
  min,
  max,
  ticks,
  points = [],
  intervals = [],
  ariaLabel,
}: NumberLineProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const arrow = `nlArrow-${uid}`;

  // 実数値を SVG の x 座標へ写す線形スケール。
  const x = scaleLinear()
    .domain([min, max])
    .range([PAD, VIEW_W - PAD]);

  // 区間を負／正の無限大側へ伸ばすときは、軸の端まで描く。
  const left = PAD;
  const right = VIEW_W - PAD;

  return (
    <svg
      className="number-line"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <marker
          id={arrow}
          viewBox="0 0 10 10"
          refX={8}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={AXIS} />
        </marker>
      </defs>

      {/* 塗りつぶす区間。軸線の上に太い帯で重ねる。 */}
      {intervals.map((iv, i) => {
        const x1 = iv.from === undefined ? left : x(iv.from);
        const x2 = iv.to === undefined ? right : x(iv.to);
        return (
          <line
            key={`iv-${i}`}
            className="number-line-interval"
            x1={x1}
            y1={AXIS_Y}
            x2={x2}
            y2={AXIS_Y}
            stroke={HIGHLIGHT}
            strokeWidth={4}
            strokeLinecap="round"
          />
        );
      })}

      {/* 軸線。両端に矢印を付け、実数が両方向へ続くことを示す。 */}
      <line
        x1={left - 8}
        y1={AXIS_Y}
        x2={right + 8}
        y2={AXIS_Y}
        stroke={AXIS}
        strokeWidth={1.5}
        markerStart={`url(#${arrow})`}
        markerEnd={`url(#${arrow})`}
      />

      {/* 目盛り。 */}
      {(ticks ?? []).map((t, i) => {
        const tx = x(t.value);
        return (
          <g key={`tick-${i}`}>
            <line
              x1={tx}
              y1={AXIS_Y - TICK_LEN}
              x2={tx}
              y2={AXIS_Y + TICK_LEN}
              stroke={AXIS}
              strokeWidth={1.5}
            />
            <KatexLabel
              tex={t.label ?? String(t.value)}
              x={tx}
              y={AXIS_Y + TICK_LEN + 12}
              fontSize={12}
            />
          </g>
        );
      })}

      {/* 端点の開閉を示す丸。区間の端ごとに描く。 */}
      {intervals.map((iv, i) => {
        const marks: ReactNode[] = [];
        if (iv.from !== undefined) {
          marks.push(endpoint(`ep-${i}-l`, x(iv.from), iv.fromClosed ?? false));
        }
        if (iv.to !== undefined) {
          marks.push(endpoint(`ep-${i}-r`, x(iv.to), iv.toClosed ?? false));
        }
        return <g key={`ep-${i}`}>{marks}</g>;
      })}

      {/* 軸上の点。 */}
      {points.map((p, i) => {
        const px = x(p.value);
        // 通常点はテーマの文字色に追従させ、強調点は強調色で固定する。CSS による上書きを
        // 避け、プレゼンテーション属性 fill で色を確定する。
        const color = p.highlight ? HIGHLIGHT : "currentColor";
        return (
          <g key={`pt-${i}`}>
            <circle cx={px} cy={AXIS_Y} r={4} fill={color} />
            {p.label !== undefined && (
              <KatexLabel tex={p.label} x={px} y={AXIS_Y - 14} fontSize={13} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** 区間の端点。閉端は塗りつぶし（黒丸）、開端は白抜き（白丸）で描く。 */
function endpoint(key: string, cx: number, closed: boolean): ReactNode {
  return (
    <circle
      key={key}
      cx={cx}
      cy={AXIS_Y}
      r={4.5}
      className={closed ? "number-line-closed" : "number-line-open"}
      fill={closed ? HIGHLIGHT : "var(--sl-color-bg, #fff)"}
      stroke={HIGHLIGHT}
      strokeWidth={1.8}
    />
  );
}
