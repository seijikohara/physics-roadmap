import { RectClipPath } from "@visx/clip-path";
import { GridColumns, GridRows } from "@visx/grid";
import { Group } from "@visx/group";
import { LegendItem, LegendLabel } from "@visx/legend";
import { Marker } from "@visx/marker";
import { scaleLinear } from "@visx/scale";
import { Circle, Line, LinePath } from "@visx/shape";
import { renderToString } from "katex";
import { useId } from "react";
import type { ReactNode } from "react";
import KatexLabel from "./KatexLabel";

/**
 * インライン SVG として描く、ビルド時生成の静的な関数グラフ。
 *
 * 直交座標 $xy$ 平面の上に、1 つ以上の関数 $y=f(x)$ の曲線・点・漸近線を描く。一次・
 * 二次・多項式・有理・無理・指数・対数・三角の各関数のグラフを、双方向性に頼らず 1 枚の
 * 静的な図で表す。本コンポーネントはクライアント JavaScript を一切載せない。Astro が
 * ビルド時に HTML へ描画する（クライアントディレクティブなし、ハイドレーションなし）。
 * 座標計算には visx の `@visx/scale`（`scaleLinear`）を用いる。曲線は標本点の列を
 * `@visx/shape` の `LinePath` に渡し、`defined` で窓外・非有限の区間を分断して描く。
 * 軸・補助線・点は visx の `Line`・`Circle`、座標変換は `Group` を用いる。格子線は
 * `@visx/grid` の `GridColumns`・`GridRows`、クリップは `@visx/clip-path` の
 * `RectClipPath`、軸の矢印は `@visx/marker` の `Marker` を用いる。
 * 軸・点のラベルは KatexLabel を介して KaTeX で組版し、本文のインライン数式と同一の
 * 字形にそろえる。曲線の凡例は SVG の外の HTML として `@visx/legend` の `LegendItem`・
 * `LegendLabel` で描き、数式ラベルは KaTeX で組版する。
 *
 * 関数値は描画窓 [xMin, xMax] を細かく標本化して折れ線で近似する。値が描画窓の縦範囲
 * [yMin, yMax] を外れる区間、および NaN・無限大となる区間では経路を分断し、有理関数の
 * 漸近線をまたぐ枝が直線で結ばれないようにする。
 */

/** グラフに重ねる 1 本の曲線。`fn` は MDX から JavaScript の関数式で渡す。 */
type Curve = Readonly<{
  /** 描く関数。x（数学座標）を受け取り y を返す。定義域外では NaN を返してよい。 */
  fn: (x: number) => number;
  /** 曲線の色。既定は青系。 */
  color?: string;
  /** 曲線に添える LaTeX ラベル。凡例（legend）に色見本とともにまとめて表示する。 */
  label?: string;
  /** 後方互換のため残す。凡例方式の導入により現在は未使用。 */
  labelX?: number;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
  /** この曲線だけの定義域 [min, max]。省略時は描画窓の横範囲全体。 */
  domain?: readonly [number, number];
}>;

/** 平面上の 1 点。塗りつぶし（黒丸）または白抜き（白丸）で表す。 */
type Point = Readonly<{
  x: number;
  y: number;
  /** 点に添える LaTeX ラベル。 */
  label?: string;
  /** 白抜き（その点を含まない）で描くか。既定は false（塗りつぶし）。 */
  open?: boolean;
  /** 強調色で描くか。既定は false。 */
  highlight?: boolean;
}>;

/** 縦または横の漸近線・補助線。`x` を指定すれば縦線、`y` を指定すれば横線。 */
type AsymptoteLine = Readonly<{
  x?: number;
  y?: number;
  /** 線に添える LaTeX ラベル。 */
  label?: string;
  /** 線の色。既定は強調色（HIGHLIGHT）。準線など他の補助線と区別したいとき指定する。 */
  color?: string;
}>;

/** 2 点を結ぶ補助線分。傾きの三角形の辺など、限定した区間の補助線に使う。 */
type Segment = Readonly<{
  from: Readonly<{ x: number; y: number }>;
  to: Readonly<{ x: number; y: number }>;
  /** 線分の中点付近に置く LaTeX ラベル（例: "\\Delta x"）。 */
  label?: string;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
}>;

/** 矢印付きベクトル（有向線分）。始点 from から終点 to へ矢じり付きで描く。 */
type Vec = Readonly<{
  from: Readonly<{ x: number; y: number }>;
  to: Readonly<{ x: number; y: number }>;
  /** 線分の中点付近に置く LaTeX ラベル（例: "\\vec{a}"）。 */
  label?: string;
  /** ベクトルの色。既定は青系（CURVE）。 */
  color?: string;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
}>;

/** 媒介変数曲線。t を tMin..tMax で標本化し、(x(t), y(t)) を折れ線で結ぶ。 */
type Parametric = Readonly<{
  /** 媒介変数 t を受け取り、数学座標 (x, y) を返す。 */
  fn: (t: number) => Readonly<{ x: number; y: number }>;
  tMin: number;
  tMax: number;
  /** 標本数。多いほど滑らかになる。既定 240。 */
  samples?: number;
  /** 曲線の色。既定は青系（CURVE）。 */
  color?: string;
  /** 凡例に出す LaTeX ラベル。 */
  label?: string;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
}>;

/**
 * 軸の目盛り。数値だけ渡すと数値をそのまま描く。$\pi$ など特別な値には
 * `{ value, label }` でラベル（LaTeX）を添える。例: `{ value: Math.PI, label: "\\pi" }`。
 */
type Tick = number | Readonly<{ value: number; label?: string }>;

type FunctionGraphProps = Readonly<{
  /** 描画窓の横範囲。 */
  xMin: number;
  xMax: number;
  /** 描画窓の縦範囲。 */
  yMin: number;
  yMax: number;
  /** 重ねて描く曲線。 */
  curves?: readonly Curve[];
  /** 平面上に置く点。 */
  points?: readonly Point[];
  /** 縦・横の漸近線や補助線。破線で描く。 */
  asymptotes?: readonly AsymptoteLine[];
  /** 2 点を結ぶ補助線分（傾きの三角形の辺など）。 */
  segments?: readonly Segment[];
  /** 矢印付きベクトル（有向線分）。 */
  vectors?: readonly Vec[];
  /** 媒介変数曲線。label 付きは凡例にまとめる。 */
  parametrics?: readonly Parametric[];
  /** x 軸の目盛り。省略時は整数位置に自動で振る。空配列で目盛りなし。 */
  xTicks?: readonly Tick[];
  /** y 軸の目盛り。省略時は整数位置に自動で振る。空配列で目盛りなし。 */
  yTicks?: readonly Tick[];
  /** x 軸の名前（LaTeX）。既定は "x"。 */
  xLabel?: string;
  /** y 軸の名前（LaTeX）。既定は "y"。 */
  yLabel?: string;
  /** 横縦で 1 単位の長さをそろえるか。既定 false。円・正方形を歪めず描くとき true。 */
  equalScale?: boolean;
  /**
   * 凡例（色見本＋数式ラベル）を描くか。既定は "auto"（プロット領域の下の帯にまとめて
   * 描く）。曲線ラベルを線のそばに置くと複数曲線・点ラベルと重なるため、ラベル付きの
   * 曲線は凡例にまとめる。"none" で凡例を描かない。
   */
  legend?: "auto" | "none";
  /** 支援技術が読み上げるアクセシブルな説明。 */
  ariaLabel: string;
}>;

// 軸・グリッドは global.css の CSS 変数でテーマに追従する（暗テーマで沈める）。
const AXIS = "var(--fig-axis)";
const GRID = "var(--fig-grid)";
const CURVE = "#3b82f6";
const HIGHLIGHT = "#f59e0b";

// 描画領域。他の図（320 幅）と横幅をそろえ、正方に近い縦横比にする。
const VIEW_W = 320;
const VIEW_H = 280;
const PAD = 28; // 軸ラベルと目盛り数字を収める余白。

// 曲線の標本数。多いほど滑らかになるが SVG が重くなる。
const SAMPLES = 480;

// ベクトルの矢じり。長さ（線方向）と半幅（直交方向）を px で与える。
const HEAD_LEN = 9;
const HEAD_HALF = 3.6;

export default function FunctionGraph({
  xMin,
  xMax,
  yMin,
  yMax,
  curves = [],
  points = [],
  asymptotes = [],
  segments = [],
  vectors = [],
  parametrics = [],
  xTicks,
  yTicks,
  xLabel = "x",
  yLabel = "y",
  equalScale = false,
  legend = "auto",
  ariaLabel,
}: FunctionGraphProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const arrow = `fgArrow-${uid}`;

  const availW = VIEW_W - 2 * PAD;
  const availH = VIEW_H - 2 * PAD;

  // equalScale のときは横縦で 1 単位の長さをそろえ、小さい方の倍率に合わせて中央へ寄せる。
  const unit = Math.min(availW / (xMax - xMin), availH / (yMax - yMin));
  const plotW = equalScale ? unit * (xMax - xMin) : availW;
  const plotH = equalScale ? unit * (yMax - yMin) : availH;
  const originX = PAD + (availW - plotW) / 2;
  const originY = PAD + (availH - plotH) / 2;

  const x = scaleLinear<number>({
    domain: [xMin, xMax],
    range: [originX, originX + plotW],
  });
  const y = scaleLinear<number>({
    domain: [yMin, yMax],
    range: [originY + plotH, originY], // SVG は下向きが正のため反転する。
  });

  // 軸の交点（数学座標の原点が窓内にあればそこ、なければ近い端に寄せる）。
  const axisX = x(clamp(0, xMin, xMax));
  const axisY = y(clamp(0, yMin, yMax));

  const xt = xTicks ?? autoTicks(xMin, xMax);
  const yt = yTicks ?? autoTicks(yMin, yMax);

  // 曲線を標本化し、各標本に可視判定を添えた配列にする。LinePath の `defined` が、値が
  // 描画窓の縦範囲を外れる、または非有限となる点で経路を切り、漸近線をまたぐ枝が直線で
  // 結ばれないようにする。
  const samplesOf = (c: Curve): readonly CurveSample[] => {
    const [lo, hi] = c.domain ?? [xMin, xMax];
    return steps(SAMPLES).map((i) => {
      const xv = lo + ((hi - lo) * i) / SAMPLES;
      const yv = c.fn(xv);
      return { xv, yv, visible: Number.isFinite(yv) && yv >= yMin && yv <= yMax };
    });
  };

  // 凡例（色見本＋数式ラベル）。曲線の上に重ねず、SVG の外の HTML として下に並べる。
  // 隅に置くと、波のように画面全体へ広がる曲線では必ず重なるため、プロット領域の外へ出す。
  // @visx/legend の LegendItem・LegendLabel を使い、ビルド時の静的 HTML として描く。
  // 曲線・媒介変数曲線のうち label 付きを集め、凡例に同じ見た目で並べる。
  const labeledCurves = curves.filter((c): c is Curve & { label: string } => c.label !== undefined);
  const labeledParametrics = parametrics.filter(
    (p): p is Parametric & { label: string } => p.label !== undefined,
  );
  const legendItems: readonly LegendEntry[] =
    legend === "none"
      ? []
      : [
          ...labeledCurves.map((c) => ({
            label: c.label,
            color: c.color ?? CURVE,
            dashed: c.dashed ?? false,
          })),
          ...labeledParametrics.map((p) => ({
            label: p.label,
            color: p.color ?? CURVE,
            dashed: p.dashed ?? false,
          })),
        ];

  // ラベルの自動配置。点・漸近線のラベルを、軸・目盛り数字・曲線・既出ラベルと重ならない
  // 位置へ置く。候補位置を採点し、最も衝突の少ない位置を選ぶ。ビルド時に一度だけ走る。
  // 点が y 軸上にあると中央配置のラベルが目盛り数字と重なり、急な曲線上の点では真上の
  // ラベルを曲線が貫く。候補から逃がし先を選ぶことで、章ごとの手調整なしに重なりを防ぐ。
  const tickBoxes: readonly Box[] = [
    ...yt.map((t) => {
      const ty = y(tickValue(t));
      return { x0: axisX - 24, x1: axisX - 4, y0: ty - 7, y1: ty + 7 };
    }),
    ...xt.map((t) => {
      const tx = x(tickValue(t));
      return { x0: tx - 9, x1: tx + 9, y0: axisY + 6, y1: axisY + 20 };
    }),
  ];
  const axisBoxes: readonly Box[] = [
    { x0: axisX - 1.5, x1: axisX + 1.5, y0: originY, y1: originY + plotH },
    { x0: originX, x1: originX + plotW, y0: axisY - 1.5, y1: axisY + 1.5 },
  ];
  // 曲線ごとに box の横幅を 8 等分した 9 点で値を引き、box の縦範囲に入る点があれば衝突とする。
  const crossesCurves = (b: Box): number =>
    curves.filter((c) =>
      steps(8).some((k) => {
        const sx = b.x0 + ((b.x1 - b.x0) * k) / 8;
        const yv = c.fn(x.invert(sx));
        return Number.isFinite(yv) && y(yv) >= b.y0 - 2 && y(yv) <= b.y1 + 2;
      }),
    ).length;
  // 媒介変数曲線は y=f(x) でないため x で逆引きできない。t で標本化して画面座標へ写し、
  // box 内に入る標本があるかで衝突を判定する。点・漸近線ラベルが楕円などの曲線に重ならない
  // よう、curves と同じ重みでペナルティに含める。
  const crossesParametrics = (b: Box): number =>
    parametrics.filter((p) => {
      const m = Math.max(1, p.samples ?? 240);
      return steps(m).some((k) => {
        const pt = p.fn(p.tMin + ((p.tMax - p.tMin) * k) / m);
        if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return false;
        const px = x(pt.x);
        const py = y(pt.y);
        return px >= b.x0 - 2 && px <= b.x1 + 2 && py >= b.y0 - 2 && py <= b.y1 + 2;
      });
    }).length;
  // placed は、この候補より先に置いたラベルの矩形である。
  const penaltyOf = (b: Box, placed: readonly Box[]): number =>
    (b.x0 < 2 || b.x1 > VIEW_W - 2 || b.y0 < 2 || b.y1 > VIEW_H - 2 ? 1000 : 0) +
    countOverlaps(b, axisBoxes) * 6 +
    countOverlaps(b, tickBoxes) * 8 +
    crossesCurves(b) * 5 +
    crossesParametrics(b) * 5 +
    countOverlaps(b, placed) * 7;
  const choosePlacement = (req: LabelRequest, placed: readonly Box[]): LabelPos =>
    req.cands.reduce<Readonly<{ pos: LabelPos; score: number }>>(
      (best, cand, i) => {
        const p = penaltyOf(boxFor(cand, req.w), placed) + i * 0.1; // 同点なら前方の候補（上・下）を優先。
        return p < best.score ? { pos: cand, score: p } : best;
      },
      { pos: req.cands[0], score: Infinity },
    ).pos;

  // 漸近線ラベルは線に沿って複数の位置を試し、曲線・軸・目盛りの無い箇所へ置く。曲線が
  // 漸近線に両端で近づく（指数関数の y=0 など）場合でも、線の中ほどの空いた区間を選べる。
  const asymRequests = asymptotes.map((a): LabelRequest | null => {
    if (a.label === undefined) return null;
    const w = estimateTexWidth(a.label, 12);
    if (a.x !== undefined) {
      const ax = x(a.x);
      return {
        w,
        cands: [0.12, 0.32, 0.68, 0.88].flatMap((fy): LabelPos[] => {
          const yy = originY + plotH * fy;
          return [
            { x: ax + 8, y: yy, align: "left" },
            { x: ax - 8, y: yy, align: "right" },
          ];
        }),
      };
    }
    if (a.y !== undefined) {
      const ay = y(a.y);
      return {
        w,
        cands: [0.2, 0.38, 0.5, 0.62, 0.8].flatMap((fx): LabelPos[] => {
          const xx = originX + plotW * fx;
          return [
            { x: xx, y: ay - 9, align: "center" },
            { x: xx, y: ay + 9, align: "center" },
          ];
        }),
      };
    }
    return null;
  });

  const segRequests = segments.map((s): LabelRequest | null => {
    if (s.label === undefined) return null;
    const a = { x: x(s.from.x), y: y(s.from.y) };
    const b = { x: x(s.to.x), y: y(s.to.y) };
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const perpX = -(b.y - a.y) / len; // 線分に直交する向き。
    const perpY = (b.x - a.x) / len;
    // 当たり判定は広めの幅 w で行い、線分からの距離は実幅に近い幅で決める。
    const w = estimateTexWidth(s.label, 12);
    const offset = normalLabelOffset(perpX, perpY, estimateTexWidthPrecise(s.label, 12));
    return {
      w,
      cands: [
        { x: mx + perpX * offset, y: my + perpY * offset, align: "center" },
        { x: mx - perpX * offset, y: my - perpY * offset, align: "center" },
      ],
    };
  });

  // ベクトルのラベルは線分の中点から、線分に直交する向きへ逃がす（補助線分と同じ方式）。
  const vectorRequests = vectors.map((v): LabelRequest | null => {
    if (v.label === undefined) return null;
    const a = { x: x(v.from.x), y: y(v.from.y) };
    const b = { x: x(v.to.x), y: y(v.to.y) };
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const perpX = -(b.y - a.y) / len; // 線分に直交する向き。
    const perpY = (b.x - a.x) / len;
    const w = estimateTexWidth(v.label, 12); // segRequests と同じく、当たり判定用の広めの幅。
    const offset = normalLabelOffset(perpX, perpY, estimateTexWidthPrecise(v.label, 12));
    return {
      w,
      cands: [
        { x: mx + perpX * offset, y: my + perpY * offset, align: "center" },
        { x: mx - perpX * offset, y: my - perpY * offset, align: "center" },
      ],
    };
  });

  // 媒介変数曲線を標本化し、各標本に可視判定を添える。描画窓 [xMin,xMax]×[yMin,yMax] を
  // 外れる、または非有限となる点で経路を分断する（LinePath の defined に渡す）。
  const paramSamplesOf = (p: Parametric): readonly CurveSample[] => {
    // 公開 props の samples に 0 や負数が来ても 0 除算で NaN にならないよう、最低 1 に丸める。
    const n = Math.max(1, p.samples ?? 240);
    return steps(n).map((i) => {
      const t = p.tMin + ((p.tMax - p.tMin) * i) / n;
      const { x: xv, y: yv } = p.fn(t);
      return {
        xv,
        yv,
        visible:
          Number.isFinite(xv) &&
          Number.isFinite(yv) &&
          xv >= xMin &&
          xv <= xMax &&
          yv >= yMin &&
          yv <= yMax,
      };
    });
  };

  const pointRequests = points.map((p): LabelRequest | null => {
    if (p.label === undefined) return null;
    const px = x(p.x);
    const py = y(p.y);
    const w = estimateTexWidth(p.label, 12);
    return {
      w,
      cands: [
        { x: px, y: py - 13, align: "center" },
        { x: px, y: py + 16, align: "center" },
        { x: px + 9, y: py - 12, align: "left" },
        { x: px + 9, y: py + 14, align: "left" },
        { x: px - 9, y: py - 12, align: "right" },
        { x: px - 9, y: py + 14, align: "right" },
        { x: px + 12, y: py + 1, align: "left" },
        { x: px - 12, y: py + 1, align: "right" },
      ],
    };
  });

  // 漸近線・補助線分・ベクトル・点の順に 1 つずつ置く。先に置いたラベルの矩形を、後のラベルの
  // 採点に加える。置く順を変えると、同じ候補でも採点が変わり、配置が変わる。
  const labelPos = placeLabels(
    [...asymRequests, ...segRequests, ...vectorRequests, ...pointRequests],
    choosePlacement,
  );
  const segStart = asymptotes.length;
  const vectorStart = segStart + segments.length;
  const pointStart = vectorStart + vectors.length;
  const asymLabelPos = labelPos.slice(0, segStart);
  const segLabelPos = labelPos.slice(segStart, vectorStart);
  const vectorLabelPos = labelPos.slice(vectorStart, pointStart);
  const pointLabelPos = labelPos.slice(pointStart);

  return (
    <div className="function-graph-figure">
      <svg
        className="function-graph"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={ariaLabel}
      >
        <defs>
          {/* 軸の矢印マーカー。@visx/marker の汎用 Marker で描く。 */}
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
          {/* 曲線をプロット矩形でクリップする。@visx/clip-path の RectClipPath で描く。 */}
          <RectClipPath id={`clip-${uid}`} x={originX} y={originY} width={plotW} height={plotH} />
        </defs>

        {/* 目盛りに沿った格子線。@visx/grid の GridColumns・GridRows で描く。 */}
        <GridColumns
          scale={x}
          top={originY}
          height={plotH}
          tickValues={xt.map(tickValue)}
          stroke={GRID}
          strokeWidth={1}
        />
        <GridRows
          scale={y}
          left={originX}
          width={plotW}
          tickValues={yt.map(tickValue)}
          stroke={GRID}
          strokeWidth={1}
        />

        {/* 漸近線・補助線（破線）。 */}
        {asymptotes.map((a, i) => {
          const ap = asymLabelPos[i];
          if (a.x !== undefined) {
            return (
              <g key={`as-${i}`}>
                <Line
                  from={{ x: x(a.x), y: originY }}
                  to={{ x: x(a.x), y: originY + plotH }}
                  stroke={a.color ?? HIGHLIGHT}
                  strokeWidth={1.2}
                  strokeDasharray="4 3"
                />
                {ap && (
                  <KatexLabel
                    tex={a.label ?? ""}
                    x={ap.x}
                    y={ap.y}
                    fontSize={12}
                    align={ap.align}
                  />
                )}
              </g>
            );
          }
          if (a.y !== undefined) {
            return (
              <g key={`as-${i}`}>
                <Line
                  from={{ x: originX, y: y(a.y) }}
                  to={{ x: originX + plotW, y: y(a.y) }}
                  stroke={a.color ?? HIGHLIGHT}
                  strokeWidth={1.2}
                  strokeDasharray="4 3"
                />
                {ap && (
                  <KatexLabel
                    tex={a.label ?? ""}
                    x={ap.x}
                    y={ap.y}
                    fontSize={12}
                    align={ap.align}
                  />
                )}
              </g>
            );
          }
          return null;
        })}

        {/* 補助線分（傾きの三角形の辺など）。 */}
        {segments.map((s, i) => {
          const sp = segLabelPos[i];
          return (
            <g key={`sg-${i}`}>
              <Line
                from={{ x: x(s.from.x), y: y(s.from.y) }}
                to={{ x: x(s.to.x), y: y(s.to.y) }}
                stroke={HIGHLIGHT}
                strokeWidth={1.6}
                strokeDasharray={s.dashed ? "5 4" : undefined}
                strokeLinecap="round"
              />
              {sp && (
                <KatexLabel tex={s.label ?? ""} x={sp.x} y={sp.y} fontSize={12} align={sp.align} />
              )}
            </g>
          );
        })}

        {/* 軸。両端に矢印を付ける。 */}
        <Line
          from={{ x: originX - 6, y: axisY }}
          to={{ x: originX + plotW + 6, y: axisY }}
          stroke={AXIS}
          strokeWidth={1.4}
          markerStart={`url(#${arrow})`}
          markerEnd={`url(#${arrow})`}
        />
        <Line
          from={{ x: axisX, y: originY + plotH + 6 }}
          to={{ x: axisX, y: originY - 6 }}
          stroke={AXIS}
          strokeWidth={1.4}
          markerStart={`url(#${arrow})`}
          markerEnd={`url(#${arrow})`}
        />

        {/* 軸名。y 軸名は目盛り数字と同じ左側に置くと接触するため、軸の右上へ離す。
          x 軸名は目盛り数字の右外へ離す。y 軸名は左寄せにし、幅広のラベル（例: a_n, c_n）
          でも左半分が軸線や矢印へ食い込まないよう、右方向へだけ伸ばす。 */}
        <KatexLabel tex={xLabel} x={originX + plotW + 14} y={axisY - 11} fontSize={13} />
        <KatexLabel tex={yLabel} x={axisX + 8} y={originY - 9} fontSize={13} align="left" />

        {/* x 軸の目盛りの刻み線。数字は点・曲線より前面に描くため、最後にまとめて置く。 */}
        {xt.map((t, i) => (
          <Line
            key={`tx-${i}`}
            from={{ x: x(tickValue(t)), y: axisY - 3 }}
            to={{ x: x(tickValue(t)), y: axisY + 3 }}
            stroke={AXIS}
            strokeWidth={1.2}
          />
        ))}
        {/* y 軸の目盛りの刻み線。 */}
        {yt.map((t, i) => (
          <Line
            key={`ty-${i}`}
            from={{ x: axisX - 3, y: y(tickValue(t)) }}
            to={{ x: axisX + 3, y: y(tickValue(t)) }}
            stroke={AXIS}
            strokeWidth={1.2}
          />
        ))}

        {/* 曲線。描画窓でクリップしてはみ出しを防ぐ。 */}
        <Group clipPath={`url(#clip-${uid})`}>
          {curves.map((c, i) => (
            <LinePath<CurveSample>
              key={`curve-${i}`}
              data={[...samplesOf(c)]}
              x={(d) => x(d.xv)}
              y={(d) => y(d.yv)}
              defined={(d) => d.visible}
              fill="none"
              stroke={c.color ?? CURVE}
              strokeWidth={2}
              strokeDasharray={c.dashed ? "5 4" : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {parametrics.map((p, i) => (
            <LinePath<CurveSample>
              key={`param-${i}`}
              data={[...paramSamplesOf(p)]}
              x={(d) => x(d.xv)}
              y={(d) => y(d.yv)}
              defined={(d) => d.visible}
              fill="none"
              stroke={p.color ?? CURVE}
              strokeWidth={2}
              strokeDasharray={p.dashed ? "5 4" : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </Group>

        {/* 矢印付きベクトル（有向線分）。クリップせず、点と同程度に前面へ描く。矢じりは
            polygon を手計算で置き、色を動的に変えられるようにする。 */}
        {vectors.map((v, i) => {
          const color = v.color ?? CURVE;
          const fromP = { x: x(v.from.x), y: y(v.from.y) };
          const toP = { x: x(v.to.x), y: y(v.to.y) };
          const ang = Math.atan2(toP.y - fromP.y, toP.x - fromP.x);
          const cos = Math.cos(ang);
          const sin = Math.sin(ang);
          // 矢じり長はベクトルのスクリーン長を超えないよう上限を付ける。短いベクトルで base が
          // 始点を越えて描画が崩れるのを防ぐ。半幅も同じ比率で縮め、矢じりの形を保つ。
          const vlen = Math.hypot(toP.x - fromP.x, toP.y - fromP.y);
          const hl = Math.min(HEAD_LEN, vlen * 0.8);
          const hh = HEAD_HALF * (hl / HEAD_LEN);
          // 矢じりの根元まで線を引き、矢じりと線を重ねない。
          const base = { x: toP.x - hl * cos, y: toP.y - hl * sin };
          // 矢じりの底辺の 2 端（進行方向に直交する向きへ半幅だけ広げる）。
          const left = { x: base.x - hh * sin, y: base.y + hh * cos };
          const right = { x: base.x + hh * sin, y: base.y - hh * cos };
          const vp = vectorLabelPos[i];
          return (
            <g key={`vec-${i}`}>
              <Line
                from={fromP}
                to={base}
                stroke={color}
                strokeWidth={2}
                strokeDasharray={v.dashed ? "5 4" : undefined}
                strokeLinecap="round"
              />
              <polygon
                points={`${toP.x},${toP.y} ${left.x},${left.y} ${right.x},${right.y}`}
                fill={color}
              />
              {vp && (
                <KatexLabel tex={v.label ?? ""} x={vp.x} y={vp.y} fontSize={12} align={vp.align} />
              )}
            </g>
          );
        })}

        {/* 点。 */}
        {points.map((p, i) => {
          const px = x(p.x);
          const py = y(p.y);
          const color = p.highlight ? HIGHLIGHT : "currentColor";
          const marks: readonly ReactNode[] = [
            p.open ? (
              <Circle
                key="c"
                cx={px}
                cy={py}
                r={4}
                fill="var(--sl-color-bg, #fff)"
                stroke={color}
                strokeWidth={1.8}
              />
            ) : (
              <Circle key="c" cx={px} cy={py} r={4} fill={color} />
            ),
          ];
          const pos = pointLabelPos[i];
          return (
            <g key={`pt-${i}`}>
              {marks}
              {pos && (
                <KatexLabel
                  tex={p.label ?? ""}
                  x={pos.x}
                  y={pos.y}
                  fontSize={12}
                  align={pos.align}
                />
              )}
            </g>
          );
        })}

        {/* 軸の目盛り数字。曲線や点マーカーと重なっても読めるよう、最後（最前面）に描き、
            背景色のハロー（global.css の .fig-tick-label）を敷く。 */}
        {xt.map((t, i) => (
          <KatexLabel
            key={`txn-${i}`}
            tex={tickLabel(t)}
            x={x(tickValue(t))}
            y={axisY + 13}
            fontSize={11}
            className="fig-tick-label"
          />
        ))}
        {yt.map((t, i) => (
          <KatexLabel
            key={`tyn-${i}`}
            tex={tickLabel(t)}
            x={axisX - 14}
            y={y(tickValue(t))}
            fontSize={11}
            className="fig-tick-label"
          />
        ))}
      </svg>

      {/* 凡例（色見本＋数式ラベル）。SVG の外の HTML として下に並べ、曲線に重ねない。
          @visx/legend の LegendItem・LegendLabel を使い、ビルド時の静的 HTML として描く。 */}
      {legendItems.length > 0 && (
        <div className="function-graph-legend">
          {legendItems.map((c, i) => {
            // 色見本だけ曲線色にし、ラベルの数式は KaTeX で本文と同じ字形に組版する。
            const html = renderToString(c.label, {
              throwOnError: false,
              displayMode: false,
              trust: false,
            });
            return (
              <LegendItem key={`lg-${i}`}>
                <svg width={24} height={12} aria-hidden="true">
                  <line
                    x1={0}
                    y1={6}
                    x2={24}
                    y2={6}
                    stroke={c.color}
                    strokeWidth={2}
                    strokeDasharray={c.dashed ? "5 4" : undefined}
                  />
                </svg>
                <LegendLabel margin="0 0 0 6px">
                  {/* ラベルはソース内のリテラルのみを組版する。外部入力は受け取らない。 */}
                  <span dangerouslySetInnerHTML={{ __html: html }} />
                </LegendLabel>
              </LegendItem>
            );
          })}
        </div>
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** LaTeX 文字列の表示幅をおおまかに見積もる（DOM が無いビルド時の概算。安全側に広めに取る）。 */
function estimateTexWidth(tex: string, fontSize: number): number {
  // バックスラッシュだけを除き、コマンド名の文字（\sin → sin）は字数として数える。
  // 装飾記号（{ } ^ _ $ 空白）は幅 0 とする。実幅より広めに見積もり、枠からのはみ出しを防ぐ。
  const visible = tex.replace(/\\/g, "").replace(/[{}^_$\s]/g, "");
  return Math.max(visible.length * fontSize * 0.72, 24);
}

/** 字形を持たず、引数の中身だけが幅を持つ組版コマンド（\mathrm{A} は A の幅になる）。 */
const LAYOUT_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "mathrm",
  "mathit",
  "mathbf",
  "mathsf",
  "mathcal",
  "mathbb",
  "text",
  "operatorname",
  "boldsymbol",
  "vec",
  "overline",
  "overrightarrow",
  "hat",
  "bar",
  "tilde",
  "dot",
  "left",
  "right",
  "displaystyle",
  "textstyle",
  "frac",
  "dfrac",
  "tfrac",
]);

/** コマンド名の綴りがそのまま立体で描かれる演算子名（\sin は sin の 3 字）。 */
const OPERATOR_NAMES: ReadonlySet<string> = new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "log",
  "ln",
  "exp",
  "lim",
  "max",
  "min",
  "sup",
  "inf",
  "det",
  "arg",
]);

/** 前後に広い空きが入る関係記号のコマンド名。 */
const RELATION_COMMANDS: ReadonlySet<string> = new Set([
  "le",
  "ge",
  "leq",
  "geq",
  "neq",
  "ne",
  "approx",
  "to",
  "equiv",
]);

/** 前後に空きが入る二項演算子のコマンド名。 */
const BINARY_COMMANDS: ReadonlySet<string> = new Set(["times", "cdot", "pm", "mp", "div"]);

/**
 * LaTeX 文字列の表示幅を、estimateTexWidth より実幅に近く見積もる（安全側に広めに取る点は同じ）。
 *
 * 線分・ベクトルのラベルを線分から離す距離（normalLabelOffset）の計算にだけ使う。
 * estimateTexWidth はコマンド名の綴りまで字数に数えるため、|\vec{b}|\sin\theta を実幅の
 * 2 倍以上と見積もり、急勾配の線分でラベルが線分から離れすぎる。
 * 当たり判定の矩形は、すべてのラベルで estimateTexWidth のままにする。線分・ベクトル・
 * 点の印を障害物として扱わない現状では、矩形を実幅へ縮めると、ラベルがそれらの線や印の
 * 上へ逃げる配置が増えるためである（ド・モアブルの定理・ベクトルの演算の章の図で確認した）。
 */
function estimateTexWidthPrecise(tex: string, fontSize: number): number {
  // 1 字形を 0.72em と広めに数え、枠からのはみ出しを防ぐ。コマンド名の綴りは字形にならない
  // ため数えない（\mathrm{A} を 7 字と数えると、実幅の数倍に膨らむ）。KaTeX は関係記号（=）と
  // 二項演算子（+）の前後に空きを入れるため、それらは 2 字ぶんと数える。単項のマイナス
  // （(-2,-1) の -）には空きが入らないため 1 字とする。
  // 字形を先頭から順に数える。afterOperand は、直前の字形が被演算子（文字・数字・閉じ括弧）か
  // を表す。+ や - が二項演算子として空きを伴うかを決める。
  const { units } = Array.from(tex.matchAll(/\\([a-zA-Z]+)|\\[^a-zA-Z]|[^{}^_$\s]/g)).reduce<
    Readonly<{ units: number; afterOperand: boolean }>
  >(
    (state, m) => {
      const name = m[1];
      if (name !== undefined) {
        if (LAYOUT_ONLY_COMMANDS.has(name)) return state;
        if (RELATION_COMMANDS.has(name) || BINARY_COMMANDS.has(name)) {
          return { units: state.units + 2, afterOperand: false };
        }
        return {
          units: state.units + (OPERATOR_NAMES.has(name) ? name.length : 1),
          afterOperand: true,
        };
      }
      const ch = m[0];
      if (ch.startsWith("\\")) {
        // \{ \} \| は字形、\, や \; などは細い空きとみなす。
        return "{}|".includes(ch[1])
          ? { units: state.units + 1, afterOperand: ch[1] !== "{" }
          : state;
      }
      if (ch === "=" || ch === "<" || ch === ">") {
        return { units: state.units + 2, afterOperand: false };
      }
      if (ch === "+" || ch === "-") {
        return { units: state.units + (state.afterOperand ? 2 : 1), afterOperand: false };
      }
      return { units: state.units + 1, afterOperand: !"([,".includes(ch) };
    },
    { units: 0, afterOperand: false },
  );
  return Math.max(units * fontSize * 0.72, 24);
}

/** 浮動小数の丸め誤差を抑え、目盛り数値を短い文字列にする（小数第 3 位まで）。 */
function formatNum(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/** 目盛りの位置（数学座標）を取り出す。 */
function tickValue(t: Tick): number {
  return typeof t === "number" ? t : t.value;
}

/** 目盛りに描く LaTeX ラベルを取り出す。ラベル未指定なら数値を整形して使う。 */
function tickLabel(t: Tick): string {
  return typeof t === "number" ? formatNum(t) : (t.label ?? formatNum(t.value));
}

/** 区間 [lo, hi] 内の 0 以外の整数位置を目盛りとして返す。 */
function autoTicks(lo: number, hi: number): readonly number[] {
  const first = Math.ceil(lo);
  const count = Math.max(0, Math.floor(hi) - first + 1);
  return Array.from({ length: count }, (_, i) => first + i).filter((v) => v !== 0);
}

/**
 * 0 から n までの整数を昇順に並べる（n が整数でなければ n 以下の整数まで）。
 *
 * 標本化の添字 k = 0, 1, …, n を、k ≤ n を満たす範囲で 1 ずつ増やして作る。n が NaN なら空。
 */
function steps(n: number): readonly number[] {
  // n + 1 は、整数の直前の値（3.9999999999999996 など）で丸められて整数になり、k ≤ n を満たさない
  // 添字まで作ってしまう。切り捨ててから 1 を足す。
  return Array.from({ length: Math.floor(n) + 1 }, (_, k) => k);
}

/** 曲線の 1 標本。`visible` は描画窓内かつ有限で、LinePath の `defined` に渡す。 */
type CurveSample = Readonly<{ xv: number; yv: number; visible: boolean }>;

/** 凡例の 1 項目。曲線と媒介変数曲線を同じ見た目で並べるために正規化する。 */
type LegendEntry = Readonly<{ label: string; color: string; dashed: boolean }>;

/** ラベルの配置先（中心・左端・右端の基準点と寄せ方向）。 */
type LabelPos = Readonly<{ x: number; y: number; align: "center" | "left" | "right" }>;

/** 1 つのラベルの配置の要求。候補位置（前方ほど優先）と、当たり判定に使う推定文字幅。 */
type LabelRequest = Readonly<{ cands: readonly LabelPos[]; w: number }>;

/** 当たり判定に使う軸並行の矩形（左上 (x0,y0)・右下 (x1,y1)）。 */
type Box = Readonly<{ x0: number; x1: number; y0: number; y1: number }>;

/** ラベルの想定文字高（viewBox 単位）。フォントサイズ 12 の約 1.25 倍。当たり判定の縦幅に使う。 */
const LABEL_H = 15;

/** 線分・ベクトルとラベル矩形の間に空けるすきま（viewBox 単位）。 */
const SEG_LABEL_GAP = 5.5;

/**
 * 線分・ベクトルの中点から法線方向へ、ラベル中心を離す距離を求める。
 *
 * 中央寄せのラベル矩形（幅 w・高さ LABEL_H）を、単位法線 (perpX, perpY) へ射影した半幅に
 * すきまを足す。矩形が線分を含む直線から、傾きによらず SEG_LABEL_GAP だけ離れる。
 * 水平な線分では文字高の半分、鉛直な線分では幅の半分が効く。幅の半分を一律に足すと、
 * 水平に近い線分で横長のラベルが離れすぎるため、射影で傾きに応じて切り替える。
 * すきまは、水平な線分で従来の固定オフセット 13 と一致する値にしてある。
 */
function normalLabelOffset(perpX: number, perpY: number, w: number): number {
  return (Math.abs(perpX) * w) / 2 + (Math.abs(perpY) * LABEL_H) / 2 + SEG_LABEL_GAP;
}

/** 配置先と推定文字幅から、ラベルが占める矩形を求める。 */
function boxFor(pos: LabelPos, w: number): Box {
  const x0 = pos.align === "left" ? pos.x : pos.align === "right" ? pos.x - w : pos.x - w / 2;
  return { x0, x1: x0 + w, y0: pos.y - LABEL_H / 2, y1: pos.y + LABEL_H / 2 };
}

/** 2 つの矩形が重なるか。 */
function boxesOverlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/** 矩形 b と重なる矩形の個数を数える。 */
function countOverlaps(b: Box, boxes: readonly Box[]): number {
  return boxes.filter((q) => boxesOverlap(b, q)).length;
}

/**
 * ラベルを要求の順に 1 つずつ置き、要求と同じ並びで配置先を返す。
 *
 * 先に置いたラベルの矩形を、後のラベルの採点（choose の placed）に加える。ラベルの無い要求
 * （null）は何も置かず、null を返す。
 */
function placeLabels(
  requests: readonly (LabelRequest | null)[],
  choose: (req: LabelRequest, placed: readonly Box[]) => LabelPos,
): readonly (LabelPos | null)[] {
  return requests.reduce<
    Readonly<{ placed: readonly Box[]; positions: readonly (LabelPos | null)[] }>
  >(
    (state, req) => {
      if (req === null) return { placed: state.placed, positions: [...state.positions, null] };
      const best = choose(req, state.placed);
      return {
        placed: [...state.placed, boxFor(best, req.w)],
        positions: [...state.positions, best],
      };
    },
    { placed: [], positions: [] },
  ).positions;
}
