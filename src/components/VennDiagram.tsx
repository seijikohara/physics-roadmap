import { CircleClipPath } from "@visx/clip-path";
import { Bar, Circle } from "@visx/shape";
import { useId } from "react";
import type { ReactNode } from "react";
import KatexLabel from "./KatexLabel";

/**
 * インライン SVG として描く、ビルド時生成の静的なベン図。
 *
 * 各 `variant` は、1 つの集合演算または関係を表す領域を塗り分ける。図は双方向性に
 * 頼らず、自身で凡例を備える。本コンポーネントはクライアント JavaScript を一切載せ
 * ない。Astro がビルド時に HTML へ描画する（クライアントディレクティブなし、ハイド
 * レーションなし）。色と文字は light/dark の両テーマで読める。ラベルは CSS を介して
 * テーマの文字色と KaTeX の数式フォントに追従する（src/styles/global.css の
 * .venn-figure を参照）。
 */

type Variant =
  | "plain" // U の中にラベル付きの 2 円。塗りも領域ラベルもなし
  | "regions" // 基本図。重なる 2 集合がつくる 4 領域
  | "intersection" // A∩B
  | "union" // A∪B
  | "complement" // Ā
  | "subset" // A⊂B
  | "disjoint" // A∩B=∅
  | "equal" // A=B
  | "universal" // A=U
  | "nonempty" // A≠∅
  | "subset-complement"; // B̄⊂Ā（A⊂B の対偶側）

type VennDiagramProps = {
  variant: Variant;
  /** 支援技術が読み上げるアクセシブルな説明。 */
  ariaLabel: string;
  /** 1 文字の集合名。既定は 'A' と 'B'。 */
  labels?: { a?: string; b?: string };
};

const STROKE_A = "#3b82f6";
const STROKE_B = "#ef4444";
const HIGHLIGHT = "#f59e0b";
const FRAME = "#94a3b8";

// 全体集合の矩形の中に置く、重なる 2 つの円。半径と中心は、四方どの辺に対しても枠と
// の余白を確保する。独自の配置を使う `subset` と `disjoint` を除く、すべての variant
// で共有する。
const U = { x: 10, y: 8, w: 300, h: 184 };
const A = { cx: 128, cy: 104, r: 58 };
const B = { cx: 192, cy: 104, r: 58 };

// 中央寄せの KaTeX ラベル用ヘルパ。`tex` は LaTeX 文字列を受け取り、(x, y) を中心に
// 中央寄せで組版する。補集合の上線は `\overline{}` で正しく文字の上へ載せる。生 SVG の
// `text-decoration: overline` と違い、`dominant-baseline: central` でも線が下へずれない。
// コンポーネントの状態を捕捉しないため、描画ごとではなく一度だけ定義するようモジュール
// スコープに置く。
const name = (x: number, y: number, tex: string) => (
  <KatexLabel tex={tex} x={x} y={y} fontSize={14} width={48} />
);
const region = (x: number, y: number, tex: string) => (
  <KatexLabel tex={tex} x={x} y={y} fontSize={12} width={110} />
);

export default function VennDiagram({ variant, ariaLabel, labels }: VennDiagramProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const clipA = `vennClipA-${uid}`;
  const maskNotA = `vennMaskNotA-${uid}`;
  const maskNotB = `vennMaskNotB-${uid}`;

  // 集合名。後方互換のため既定は A/B とする。
  const a = labels?.a ?? "A";
  const b = labels?.b ?? "B";

  const body: ReactNode = ((): ReactNode => {
    switch (variant) {
      case "intersection":
        return (
          <>
            <CircleClipPath id={clipA} cx={A.cx} cy={A.cy} r={A.r} />
            <Circle cx={A.cx} cy={A.cy} r={A.r} fill="none" stroke={STROKE_A} strokeWidth={1.8} />
            <Circle cx={B.cx} cy={B.cy} r={B.r} fill="none" stroke={STROKE_B} strokeWidth={1.8} />
            <Circle
              cx={B.cx}
              cy={B.cy}
              r={B.r}
              fill={HIGHLIGHT}
              fillOpacity={0.55}
              clipPath={`url(#${clipA})`}
            />
            {name(110, 70, a)}
            {name(210, 70, b)}
            {region(160, 112, `${a} \\cap ${b}`)}
          </>
        );
      case "union":
        return (
          <>
            <Circle
              cx={A.cx}
              cy={A.cy}
              r={A.r}
              fill={HIGHLIGHT}
              fillOpacity={0.4}
              stroke={STROKE_A}
              strokeWidth={1.8}
            />
            <Circle
              cx={B.cx}
              cy={B.cy}
              r={B.r}
              fill={HIGHLIGHT}
              fillOpacity={0.4}
              stroke={STROKE_B}
              strokeWidth={1.8}
            />
            {name(110, 70, a)}
            {name(210, 70, b)}
            {region(160, 180, `${a} \\cup ${b}`)}
          </>
        );
      case "complement":
        return (
          <>
            <defs>
              <mask id={maskNotA}>
                <rect x={U.x} y={U.y} width={U.w} height={U.h} fill="#fff" />
                <circle cx={A.cx} cy={A.cy} r={A.r} fill="#000" />
              </mask>
            </defs>
            <Bar
              x={U.x}
              y={U.y}
              width={U.w}
              height={U.h}
              fill={HIGHLIGHT}
              fillOpacity={0.45}
              mask={`url(#${maskNotA})`}
            />
            <Circle cx={A.cx} cy={A.cy} r={A.r} fill="none" stroke={STROKE_A} strokeWidth={1.8} />
            {name(128, 104, a)}
            {region(248, 70, `\\overline{${a}}`)}
          </>
        );
      case "subset": {
        const bb = { cx: 176, cy: 104, r: 72 };
        const aa = { cx: 150, cy: 104, r: 32 };
        return (
          <>
            <Circle
              cx={bb.cx}
              cy={bb.cy}
              r={bb.r}
              fill={STROKE_B}
              fillOpacity={0.06}
              stroke={STROKE_B}
              strokeWidth={1.8}
            />
            <Circle
              cx={aa.cx}
              cy={aa.cy}
              r={aa.r}
              fill={STROKE_A}
              fillOpacity={0.16}
              stroke={STROKE_A}
              strokeWidth={1.8}
            />
            {name(150, 104, a)}
            {name(176, 52, b)}
          </>
        );
      }
      case "disjoint": {
        const ad = { cx: 80, cy: 104, r: 46 };
        const bd = { cx: 240, cy: 104, r: 46 };
        return (
          <>
            <Circle
              cx={ad.cx}
              cy={ad.cy}
              r={ad.r}
              fill={STROKE_A}
              fillOpacity={0.1}
              stroke={STROKE_A}
              strokeWidth={1.8}
            />
            <Circle
              cx={bd.cx}
              cy={bd.cy}
              r={bd.r}
              fill={STROKE_B}
              fillOpacity={0.1}
              stroke={STROKE_B}
              strokeWidth={1.8}
            />
            {name(80, 104, a)}
            {name(240, 104, b)}
            {region(160, 104, `${a} \\cap ${b} = \\varnothing`)}
          </>
        );
      }
      case "equal":
        // ほぼ重なる 2 円。2 集合はすべての要素を共有する（A=B）。
        return (
          <>
            <Circle cx={160} cy={104} r={60} fill={HIGHLIGHT} fillOpacity={0.12} />
            <Circle cx={160} cy={104} r={66} fill="none" stroke={STROKE_A} strokeWidth={1.8} />
            <Circle cx={160} cy={104} r={60} fill="none" stroke={STROKE_B} strokeWidth={1.8} />
            {region(160, 104, `${a} = ${b}`)}
          </>
        );
      case "universal":
        // 集合が全体集合をすべて満たす（A=U）。U の全体を塗る。
        return (
          <>
            <Bar
              x={U.x}
              y={U.y}
              width={U.w}
              height={U.h}
              fill={HIGHLIGHT}
              fillOpacity={0.4}
              rx={4}
            />
            {region(160, 104, `${a} = U`)}
          </>
        );
      case "nonempty": {
        // 要素を少なくとも 1 つ持つ単一の集合（A≠∅）。点 1 つが要素を表す。
        const an = { cx: 160, cy: 104, r: 58 };
        return (
          <>
            <Circle
              cx={an.cx}
              cy={an.cy}
              r={an.r}
              fill={HIGHLIGHT}
              fillOpacity={0.25}
              stroke={STROKE_A}
              strokeWidth={1.8}
            />
            <Circle cx={an.cx} cy={an.cy} r={3.5} fill="currentColor" />
            {name(an.cx, 60, a)}
            {region(an.cx, 132, `${a} \\neq \\varnothing`)}
          </>
        );
      }
      case "subset-complement": {
        // A⊂B の対偶。B の外側は A の外側の内に収まる（B̄⊂Ā）。`subset` と同じ入れ子
        // の配置を使い、マスクで B の外側を塗る。
        const bb = { cx: 176, cy: 104, r: 72 };
        const aa = { cx: 150, cy: 104, r: 32 };
        return (
          <>
            <defs>
              <mask id={maskNotB}>
                <rect x={U.x} y={U.y} width={U.w} height={U.h} fill="#fff" />
                <circle cx={bb.cx} cy={bb.cy} r={bb.r} fill="#000" />
              </mask>
            </defs>
            <Bar
              x={U.x}
              y={U.y}
              width={U.w}
              height={U.h}
              fill={HIGHLIGHT}
              fillOpacity={0.45}
              mask={`url(#${maskNotB})`}
            />
            <Circle
              cx={bb.cx}
              cy={bb.cy}
              r={bb.r}
              fill="none"
              stroke={STROKE_B}
              strokeWidth={1.8}
            />
            <Circle
              cx={aa.cx}
              cy={aa.cy}
              r={aa.r}
              fill={STROKE_A}
              fillOpacity={0.16}
              stroke={STROKE_A}
              strokeWidth={1.8}
            />
            {name(150, 104, a)}
            {name(176, 52, b)}
            {region(50, 176, `\\overline{${b}}`)}
          </>
        );
      }
      case "plain":
        return (
          <>
            <Circle
              cx={A.cx}
              cy={A.cy}
              r={A.r}
              fill={STROKE_A}
              fillOpacity={0.08}
              stroke={STROKE_A}
              strokeWidth={1.8}
            />
            <Circle
              cx={B.cx}
              cy={B.cy}
              r={B.r}
              fill={STROKE_B}
              fillOpacity={0.08}
              stroke={STROKE_B}
              strokeWidth={1.8}
            />
            {name(110, 104, a)}
            {name(210, 104, b)}
          </>
        );
      case "regions":
      default:
        return (
          <>
            <Circle
              cx={A.cx}
              cy={A.cy}
              r={A.r}
              fill={STROKE_A}
              fillOpacity={0.08}
              stroke={STROKE_A}
              strokeWidth={1.8}
            />
            <Circle
              cx={B.cx}
              cy={B.cy}
              r={B.r}
              fill={STROKE_B}
              fillOpacity={0.08}
              stroke={STROKE_B}
              strokeWidth={1.8}
            />
            {name(110, 70, a)}
            {name(210, 70, b)}
            {region(160, 112, `${a} \\cap ${b}`)}
            {region(90, 112, `${a} \\cap \\overline{${b}}`)}
            {region(230, 112, `\\overline{${a}} \\cap ${b}`)}
            {region(48, 178, `\\overline{${a}} \\cap \\overline{${b}}`)}
          </>
        );
    }
  })();

  return (
    <svg className="venn-figure" viewBox="0 0 320 200" role="img" aria-label={ariaLabel}>
      {body}
      <Bar
        x={U.x}
        y={U.y}
        width={U.w}
        height={U.h}
        fill="none"
        stroke={FRAME}
        strokeWidth={1.5}
        rx={4}
      />
      <KatexLabel tex="U" x={U.x + 10} y={U.y + 16} fontSize={13} width={40} align="left" />
    </svg>
  );
}
