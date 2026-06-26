import { scaleLinear } from "@visx/scale";
import { Group } from "@visx/group";
import { Circle, Line, LinePath } from "@visx/shape";
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
 * 軸・補助線・点は visx の `Line`・`Circle`、座標変換は `Group` を用いる。
 * 軸・点のラベルは KatexLabel を介して KaTeX で組版し、本文のインライン数式と同一の
 * 字形にそろえる。
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

export default function FunctionGraph({
  xMin,
  xMax,
  yMin,
  yMax,
  curves = [],
  points = [],
  asymptotes = [],
  segments = [],
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

  // 凡例（色見本＋数式ラベル）。曲線の上に重ねず、グラフの下の帯へ流し込みで並べる。
  // 隅に置くと、波のように画面全体へ広がる曲線では必ず重なるため、プロット領域の外へ出す。
  const labeled = curves.filter((c): c is Curve & { label: string } => c.label !== undefined);
  const legendItems = legend === "none" ? [] : labeled;
  const legendAvailW = VIEW_W - 2 * PAD;
  const placedLegend: Array<{
    label: string;
    color: string;
    dashed: boolean;
    x: number;
    row: number;
    w: number;
  }> = [];
  let lgX = PAD;
  let lgRow = 0;
  for (const c of legendItems) {
    const labelW = estimateTexWidth(c.label, 12);
    const itemW = LEGEND_SWATCH + LEGEND_GAP + labelW;
    if (lgX > PAD && lgX + itemW > PAD + legendAvailW) {
      lgX = PAD;
      lgRow += 1;
    }
    placedLegend.push({
      label: c.label,
      color: c.color ?? CURVE,
      dashed: c.dashed ?? false,
      x: lgX,
      row: lgRow,
      w: labelW,
    });
    lgX += itemW + LEGEND_ITEM_GAP;
  }
  const legendRows = placedLegend.length > 0 ? lgRow + 1 : 0;
  const legendBandH = legendRows > 0 ? LEGEND_TOP + legendRows * LEGEND_ROW_H + LEGEND_PAD : 0;
  const legendBaseY = VIEW_H + LEGEND_TOP;
  const totalH = VIEW_H + legendBandH;

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
    <svg
      className="function-graph"
      viewBox={`0 0 ${VIEW_W} ${totalH}`}
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
        <clipPath id={`clip-${uid}`}>
          <rect x={originX} y={originY} width={plotW} height={plotH} />
        </clipPath>
      </defs>

      {/* 目盛りに沿った格子線。 */}
      {xt.map((t, i) => (
        <Line
          key={`gx-${i}`}
          from={{ x: x(tickValue(t)), y: originY }}
          to={{ x: x(tickValue(t)), y: originY + plotH }}
          stroke={GRID}
          strokeWidth={1}
        />
      ))}
      {yt.map((t, i) => (
        <Line
          key={`gy-${i}`}
          from={{ x: originX, y: y(tickValue(t)) }}
          to={{ x: originX + plotW, y: y(tickValue(t)) }}
          stroke={GRID}
          strokeWidth={1}
        />
      ))}

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
                <KatexLabel tex={a.label ?? ""} x={ap.x} y={ap.y} fontSize={12} align={ap.align} />
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
                <KatexLabel tex={a.label ?? ""} x={ap.x} y={ap.y} fontSize={12} align={ap.align} />
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
      </Group>

      {/* 凡例（色見本＋数式ラベル）。プロット領域の下の帯に置き、曲線に重ねない。 */}
      {placedLegend.length > 0 && (
        <g>
          <Line
            from={{ x: PAD, y: VIEW_H + 2 }}
            to={{ x: VIEW_W - PAD, y: VIEW_H + 2 }}
            stroke={GRID}
            strokeWidth={1}
          />
          {placedLegend.map((it, i) => {
            const rowY = legendBaseY + LEGEND_ROW_H * (it.row + 0.5);
            // 色見本だけ曲線色にし、ラベル文字は本文と同じ標準色で描く。曲線色が淡い
            // （補助線など）場合でもラベルを読めるようにする。
            return (
              <g key={`lg-${i}`}>
                <Line
                  from={{ x: it.x, y: rowY }}
                  to={{ x: it.x + LEGEND_SWATCH, y: rowY }}
                  stroke={it.color}
                  strokeWidth={2}
                  strokeDasharray={it.dashed ? "5 4" : undefined}
                  strokeLinecap="round"
                />
                <KatexLabel
                  tex={it.label}
                  x={it.x + LEGEND_SWATCH + LEGEND_GAP}
                  y={rowY}
                  width={it.w}
                  fontSize={12}
                  align="left"
                />
              </g>
            );
          })}
        </g>
      )}

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
              <KatexLabel tex={p.label ?? ""} x={pos.x} y={pos.y} fontSize={12} align={pos.align} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// 凡例の寸法（viewBox 単位）。凡例はプロットの下の帯に流し込みで並べる。
const LEGEND_PAD = 6;
const LEGEND_ROW_H = 18;
const LEGEND_SWATCH = 20;
const LEGEND_GAP = 6; // 色見本とラベルの間隔。
const LEGEND_ITEM_GAP = 16; // 同じ行の項目どうしの間隔。
const LEGEND_TOP = 10; // プロット下端と凡例帯の間隔。

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
