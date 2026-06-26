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
type Curve = {
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
  domain?: [number, number];
};

/** 平面上の 1 点。塗りつぶし（黒丸）または白抜き（白丸）で表す。 */
type Point = {
  x: number;
  y: number;
  /** 点に添える LaTeX ラベル。 */
  label?: string;
  /** 白抜き（その点を含まない）で描くか。既定は false（塗りつぶし）。 */
  open?: boolean;
  /** 強調色で描くか。既定は false。 */
  highlight?: boolean;
};

/** 縦または横の漸近線・補助線。`x` を指定すれば縦線、`y` を指定すれば横線。 */
type AsymptoteLine = {
  x?: number;
  y?: number;
  /** 線に添える LaTeX ラベル。 */
  label?: string;
};

/** 2 点を結ぶ補助線分。傾きの三角形の辺など、限定した区間の補助線に使う。 */
type Segment = {
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** 線分の中点付近に置く LaTeX ラベル（例: "\\Delta x"）。 */
  label?: string;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
};

/** 矢印付きベクトル（有向線分）。始点 from から終点 to へ矢じり付きで描く。 */
type Vec = {
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** 線分の中点付近に置く LaTeX ラベル（例: "\\vec{a}"）。 */
  label?: string;
  /** ベクトルの色。既定は青系（CURVE）。 */
  color?: string;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
};

/** 媒介変数曲線。t を tMin..tMax で標本化し、(x(t), y(t)) を折れ線で結ぶ。 */
type Parametric = {
  /** 媒介変数 t を受け取り、数学座標 (x, y) を返す。 */
  fn: (t: number) => { x: number; y: number };
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
};

/**
 * 軸の目盛り。数値だけ渡すと数値をそのまま描く。$\pi$ など特別な値には
 * `{ value, label }` でラベル（LaTeX）を添える。例: `{ value: Math.PI, label: "\\pi" }`。
 */
type Tick = number | { value: number; label?: string };

type FunctionGraphProps = {
  /** 描画窓の横範囲。 */
  xMin: number;
  xMax: number;
  /** 描画窓の縦範囲。 */
  yMin: number;
  yMax: number;
  /** 重ねて描く曲線。 */
  curves?: Curve[];
  /** 平面上に置く点。 */
  points?: Point[];
  /** 縦・横の漸近線や補助線。破線で描く。 */
  asymptotes?: AsymptoteLine[];
  /** 2 点を結ぶ補助線分（傾きの三角形の辺など）。 */
  segments?: Segment[];
  /** 矢印付きベクトル（有向線分）。 */
  vectors?: Vec[];
  /** 媒介変数曲線。label 付きは凡例にまとめる。 */
  parametrics?: Parametric[];
  /** x 軸の目盛り。省略時は整数位置に自動で振る。空配列で目盛りなし。 */
  xTicks?: Tick[];
  /** y 軸の目盛り。省略時は整数位置に自動で振る。空配列で目盛りなし。 */
  yTicks?: Tick[];
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
};

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
  let plotW = availW;
  let plotH = availH;
  if (equalScale) {
    const unit = Math.min(availW / (xMax - xMin), availH / (yMax - yMin));
    plotW = unit * (xMax - xMin);
    plotH = unit * (yMax - yMin);
  }
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
  const samplesOf = (c: Curve): CurveSample[] => {
    const [lo, hi] = c.domain ?? [xMin, xMax];
    const out: CurveSample[] = [];
    for (let i = 0; i <= SAMPLES; i += 1) {
      const xv = lo + ((hi - lo) * i) / SAMPLES;
      const yv = c.fn(xv);
      out.push({ xv, yv, visible: Number.isFinite(yv) && yv >= yMin && yv <= yMax });
    }
    return out;
  };

  // 凡例（色見本＋数式ラベル）。曲線の上に重ねず、SVG の外の HTML として下に並べる。
  // 隅に置くと、波のように画面全体へ広がる曲線では必ず重なるため、プロット領域の外へ出す。
  // @visx/legend の LegendItem・LegendLabel を使い、ビルド時の静的 HTML として描く。
  // 曲線・媒介変数曲線のうち label 付きを集め、凡例に同じ見た目で並べる。
  const labeledCurves = curves.filter((c): c is Curve & { label: string } => c.label !== undefined);
  const labeledParametrics = parametrics.filter(
    (p): p is Parametric & { label: string } => p.label !== undefined,
  );
  const legendItems: LegendEntry[] =
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
  const placedBoxes: Box[] = [];
  const tickBoxes: Box[] = [
    ...yt.map((t) => {
      const ty = y(tickValue(t));
      return { x0: axisX - 24, x1: axisX - 4, y0: ty - 7, y1: ty + 7 };
    }),
    ...xt.map((t) => {
      const tx = x(tickValue(t));
      return { x0: tx - 9, x1: tx + 9, y0: axisY + 6, y1: axisY + 20 };
    }),
  ];
  const axisBoxes: Box[] = [
    { x0: axisX - 1.5, x1: axisX + 1.5, y0: originY, y1: originY + plotH },
    { x0: originX, x1: originX + plotW, y0: axisY - 1.5, y1: axisY + 1.5 },
  ];
  const crossesCurves = (b: Box): number => {
    let n = 0;
    for (const c of curves) {
      for (let k = 0; k <= 8; k += 1) {
        const sx = b.x0 + ((b.x1 - b.x0) * k) / 8;
        const yv = c.fn(x.invert(sx));
        if (Number.isFinite(yv) && y(yv) >= b.y0 - 2 && y(yv) <= b.y1 + 2) {
          n += 1;
          break;
        }
      }
    }
    return n;
  };
  const penaltyOf = (b: Box): number => {
    let p = 0;
    if (b.x0 < 2 || b.x1 > VIEW_W - 2 || b.y0 < 2 || b.y1 > VIEW_H - 2) p += 1000;
    for (const a of axisBoxes) if (boxesOverlap(b, a)) p += 6;
    for (const t of tickBoxes) if (boxesOverlap(b, t)) p += 8;
    p += crossesCurves(b) * 5;
    for (const q of placedBoxes) if (boxesOverlap(b, q)) p += 7;
    return p;
  };
  const choosePlacement = (cands: LabelPos[], w: number): LabelPos => {
    let best = cands[0];
    let bestP = Infinity;
    cands.forEach((cand, i) => {
      const p = penaltyOf(boxFor(cand, w)) + i * 0.1; // 同点なら前方の候補（上・下）を優先。
      if (p < bestP) {
        bestP = p;
        best = cand;
      }
    });
    placedBoxes.push(boxFor(best, w));
    return best;
  };

  // 漸近線ラベルは線に沿って複数の位置を試し、曲線・軸・目盛りの無い箇所へ置く。曲線が
  // 漸近線に両端で近づく（指数関数の y=0 など）場合でも、線の中ほどの空いた区間を選べる。
  const asymLabelPos = asymptotes.map((a): LabelPos | null => {
    if (a.label === undefined) return null;
    const w = estimateTexWidth(a.label, 12);
    const cands: LabelPos[] = [];
    if (a.x !== undefined) {
      const ax = x(a.x);
      for (const fy of [0.12, 0.32, 0.68, 0.88]) {
        const yy = originY + plotH * fy;
        cands.push({ x: ax + 8, y: yy, align: "left" });
        cands.push({ x: ax - 8, y: yy, align: "right" });
      }
    } else if (a.y !== undefined) {
      const ay = y(a.y);
      for (const fx of [0.2, 0.38, 0.5, 0.62, 0.8]) {
        const xx = originX + plotW * fx;
        cands.push({ x: xx, y: ay - 9, align: "center" });
        cands.push({ x: xx, y: ay + 9, align: "center" });
      }
    }
    if (cands.length === 0) return null;
    return choosePlacement(cands, w);
  });

  const segLabelPos = segments.map((s): LabelPos | null => {
    if (s.label === undefined) return null;
    const a = { x: x(s.from.x), y: y(s.from.y) };
    const b = { x: x(s.to.x), y: y(s.to.y) };
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const perpX = -(b.y - a.y) / len; // 線分に直交する向き。
    const perpY = (b.x - a.x) / len;
    const w = estimateTexWidth(s.label, 12);
    return choosePlacement(
      [
        { x: mx + perpX * 13, y: my + perpY * 13, align: "center" },
        { x: mx - perpX * 13, y: my - perpY * 13, align: "center" },
      ],
      w,
    );
  });

  // ベクトルのラベルは線分の中点から、線分に直交する向きへ逃がす（補助線分と同じ方式）。
  const vectorLabelPos = vectors.map((v): LabelPos | null => {
    if (v.label === undefined) return null;
    const a = { x: x(v.from.x), y: y(v.from.y) };
    const b = { x: x(v.to.x), y: y(v.to.y) };
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const perpX = -(b.y - a.y) / len; // 線分に直交する向き。
    const perpY = (b.x - a.x) / len;
    const w = estimateTexWidth(v.label, 12);
    return choosePlacement(
      [
        { x: mx + perpX * 13, y: my + perpY * 13, align: "center" },
        { x: mx - perpX * 13, y: my - perpY * 13, align: "center" },
      ],
      w,
    );
  });

  // 媒介変数曲線を標本化し、各標本に可視判定を添える。描画窓 [xMin,xMax]×[yMin,yMax] を
  // 外れる、または非有限となる点で経路を分断する（LinePath の defined に渡す）。
  const paramSamplesOf = (p: Parametric): CurveSample[] => {
    // 公開 props の samples に 0 や負数が来ても 0 除算で NaN にならないよう、最低 1 に丸める。
    const n = Math.max(1, p.samples ?? 240);
    const out: CurveSample[] = [];
    for (let i = 0; i <= n; i += 1) {
      const t = p.tMin + ((p.tMax - p.tMin) * i) / n;
      const { x: xv, y: yv } = p.fn(t);
      out.push({
        xv,
        yv,
        visible:
          Number.isFinite(xv) &&
          Number.isFinite(yv) &&
          xv >= xMin &&
          xv <= xMax &&
          yv >= yMin &&
          yv <= yMax,
      });
    }
    return out;
  };

  const pointLabelPos = points.map((p): LabelPos | null => {
    if (p.label === undefined) return null;
    const px = x(p.x);
    const py = y(p.y);
    const w = estimateTexWidth(p.label, 12);
    return choosePlacement(
      [
        { x: px, y: py - 13, align: "center" },
        { x: px, y: py + 16, align: "center" },
        { x: px + 9, y: py - 12, align: "left" },
        { x: px + 9, y: py + 14, align: "left" },
        { x: px - 9, y: py - 12, align: "right" },
        { x: px - 9, y: py + 14, align: "right" },
        { x: px + 12, y: py + 1, align: "left" },
        { x: px - 12, y: py + 1, align: "right" },
      ],
      w,
    );
  });

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
                  stroke={HIGHLIGHT}
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
                  stroke={HIGHLIGHT}
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
          x 軸名は目盛り数字の右外へ離す。 */}
        <KatexLabel tex={xLabel} x={originX + plotW + 14} y={axisY - 11} fontSize={13} />
        <KatexLabel tex={yLabel} x={axisX + 12} y={originY - 9} fontSize={13} />

        {/* x 軸の目盛りと数字。 */}
        {xt.map((t, i) => (
          <g key={`tx-${i}`}>
            <Line
              from={{ x: x(tickValue(t)), y: axisY - 3 }}
              to={{ x: x(tickValue(t)), y: axisY + 3 }}
              stroke={AXIS}
              strokeWidth={1.2}
            />
            <KatexLabel tex={tickLabel(t)} x={x(tickValue(t))} y={axisY + 13} fontSize={11} />
          </g>
        ))}
        {/* y 軸の目盛りと数字。 */}
        {yt.map((t, i) => (
          <g key={`ty-${i}`}>
            <Line
              from={{ x: axisX - 3, y: y(tickValue(t)) }}
              to={{ x: axisX + 3, y: y(tickValue(t)) }}
              stroke={AXIS}
              strokeWidth={1.2}
            />
            <KatexLabel tex={tickLabel(t)} x={axisX - 14} y={y(tickValue(t))} fontSize={11} />
          </g>
        ))}

        {/* 曲線。描画窓でクリップしてはみ出しを防ぐ。 */}
        <Group clipPath={`url(#clip-${uid})`}>
          {curves.map((c, i) => (
            <LinePath<CurveSample>
              key={`curve-${i}`}
              data={samplesOf(c)}
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
              data={paramSamplesOf(p)}
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
          const marks: ReactNode[] = [];
          marks.push(
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
          );
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
function autoTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(lo); v <= Math.floor(hi); v += 1) {
    if (v !== 0) out.push(v);
  }
  return out;
}

/** 曲線の 1 標本。`visible` は描画窓内かつ有限で、LinePath の `defined` に渡す。 */
type CurveSample = { xv: number; yv: number; visible: boolean };

/** 凡例の 1 項目。曲線と媒介変数曲線を同じ見た目で並べるために正規化する。 */
type LegendEntry = { label: string; color: string; dashed: boolean };

/** ラベルの配置先（中心・左端・右端の基準点と寄せ方向）。 */
type LabelPos = { x: number; y: number; align: "center" | "left" | "right" };

/** 当たり判定に使う軸並行の矩形（左上 (x0,y0)・右下 (x1,y1)）。 */
type Box = { x0: number; x1: number; y0: number; y1: number };

/** ラベルの想定文字高（viewBox 単位）。当たり判定の縦幅に使う。 */
const LABEL_H = 15;

/** 配置先と推定文字幅から、ラベルが占める矩形を求める。 */
function boxFor(pos: LabelPos, w: number): Box {
  const x0 = pos.align === "left" ? pos.x : pos.align === "right" ? pos.x - w : pos.x - w / 2;
  return { x0, x1: x0 + w, y0: pos.y - LABEL_H / 2, y1: pos.y + LABEL_H / 2 };
}

/** 2 つの矩形が重なるか。 */
function boxesOverlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}
