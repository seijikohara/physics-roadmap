import { RectClipPath } from "@visx/clip-path";
import { GridColumns, GridRows } from "@visx/grid";
import { Group } from "@visx/group";
import { LegendItem, LegendLabel } from "@visx/legend";
import { Marker } from "@visx/marker";
import { scaleLinear } from "@visx/scale";
import { Bar, Circle, Line, LinePath, Polygon } from "@visx/shape";
import { renderToString } from "katex";
import { useId } from "react";
import KatexLabel from "./KatexLabel";

/**
 * インライン SVG として描く、ビルド時生成の静的なリーマン和の図。
 *
 * 1 本の曲線 $y=f(x)$ に、閉区間の分割から作る長方形（リーマン和の各項）、曲線と $x$ 軸の
 * 間の領域の塗り、外枠だけの長方形（定積分の評価に使う高さ $m$・$M$ の長方形）を重ねて描く。
 * 比較用の 2 本目の曲線 $y=g(x)$ を加え、2 曲線の間の領域を別の色で塗ることもできる。
 * `FunctionGraph` は塗りつぶした図形を持たないため、面積を主題とする図を本コンポーネントに
 * 分ける。共有の `FunctionGraph` を変更せず、既存の章の描画に影響を与えないためでもある。
 *
 * 本コンポーネントはクライアント JavaScript を一切載せない。Astro がビルド時に HTML へ描画
 * する（クライアントディレクティブなし、ハイドレーションなし）。座標は `@visx/scale`、長方形と
 * 領域は `@visx/shape` の `Bar`・`Polygon`、曲線は `LinePath` で描く。外側の要素と SVG に
 * `FunctionGraph` と同じクラス名を付け、寸法・目盛り数字のハロー・KaTeX の伸縮グリフの補正
 * （src/styles/global.css）をそのまま共有する。
 *
 * 塗りの色は、関数の値が正の部分と負の部分で分ける。定積分を符号つきの面積として読む図で、
 * $x$ 軸の下の長方形・領域を別の色にして区別するためである。
 */

/**
 * 軸の目盛り。数値だけ渡すと数値をそのまま描く。`{ value, label }` でラベル（LaTeX）を添える。
 * x 軸の目盛りで `above: true` を指定すると、数字を軸の上側に置く。軸の下に負の長方形や領域が
 * あり、数字が塗りの縁と重なるときに使う。`dx` は x 軸の目盛り数字を横へずらす量（px、右が正）で
 * ある。急な曲線が目盛りの真上または真下を通り、数字と重なるときに、曲線の無い側へ逃がす。
 */
type Tick = number | { value: number; label?: string; above?: boolean; dx?: number };

/** 代表点の選び方。左端・右端・中点、または各小区間の代表点の配列。 */
type Sample = "left" | "right" | "mid" | number[];

/** 外枠だけの長方形。区間 [x0, x1] の上に、x 軸から高さ height まで破線で描く。 */
type Frame = {
  x0: number;
  x1: number;
  height: number;
  /** 長方形の上辺の高さに添える LaTeX ラベル（例: "M"）。 */
  label?: string;
  /**
   * ラベルを長方形の左外側と右外側のどちらに置くか。既定 "left"。曲線がラベルの位置を
   * 通るとき（増加関数の最小値の枠の左上など）に、反対側へ逃がす。
   */
  labelSide?: "left" | "right";
  /** 枠線の色。既定は強調色。 */
  color?: string;
};

type RiemannSumGraphProps = {
  /** 描画窓の横範囲。 */
  xMin: number;
  xMax: number;
  /** 描画窓の縦範囲。 */
  yMin: number;
  yMax: number;
  /** 描く関数。x（数学座標）を受け取り y を返す。 */
  fn: (x: number) => number;
  /** 曲線を描く範囲 [min, max]。省略時は描画窓の横範囲全体。 */
  curveDomain?: [number, number];
  /** 曲線の凡例に添える LaTeX ラベル。省略時は凡例に載せない。 */
  curveLabel?: string;
  /** 比較用の 2 本目の曲線。area を指定すると、2 曲線の間の領域も塗る。 */
  upperFn?: (x: number) => number;
  /** 2 本目の曲線の凡例に添える LaTeX ラベル。 */
  upperLabel?: string;
  /**
   * 2 曲線の間を塗る区間。省略時は area と同じ。曲線の下の領域と、2 曲線の間の領域を別の区間で
   * 塗り分けるときに指定する。指定すると、2 本目の曲線もこの区間で描く。
   */
  betweenArea?: [number, number];
  /**
   * 2 曲線の間の領域の下側の境界。省略時は fn。区間の一部で fn と異なる境界（定数の高さなど）を
   * 下側に使い、L 字形などの領域を塗るときに指定する。
   */
  betweenLowerFn?: (x: number) => number;
  /** 分割点 x_0 < x_1 < ... < x_n。指定すると、各小区間に長方形を描く。 */
  partition?: number[];
  /** 代表点の選び方。既定 "left"。配列を渡すときは小区間の個数と同じ長さにする。 */
  sample?: Sample;
  /** 代表点を曲線上の点で示すか。既定 false。 */
  showSamples?: boolean;
  /** 曲線と x 軸の間の領域を塗る区間 [from, to]。両端には x 軸から曲線まで縦の線を引く。 */
  area?: [number, number];
  /** 外枠だけの長方形。 */
  frames?: Frame[];
  /** 領域を区切る縦の破線を引く x 座標。x 軸から曲線上の点まで引く（区間の分け目を示す）。 */
  dividers?: number[];
  /** x 軸の目盛り。省略時は整数位置に自動で振る。空配列で目盛りなし。 */
  xTicks?: Tick[];
  /** y 軸の目盛り。省略時は整数位置に自動で振る。空配列で目盛りなし。 */
  yTicks?: Tick[];
  /** x 軸の名前（LaTeX）。既定は "x"。 */
  xLabel?: string;
  /** y 軸の名前（LaTeX）。既定は "y"。 */
  yLabel?: string;
  /** 支援技術が読み上げるアクセシブルな説明。 */
  ariaLabel: string;
};

// 軸・グリッドは global.css の CSS 変数でテーマに追従する（暗テーマで沈める）。
const AXIS = "var(--fig-axis)";
const GRID = "var(--fig-grid)";
const CURVE = "#3b82f6";
const UPPER = "#10b981";
const POSITIVE = "#3b82f6";
const NEGATIVE = "#ec4899";
const HIGHLIGHT = "#f59e0b";
// 塗りの不透明度は、面積図と同じテーマ変数を使う。暗テーマでは塗りが沈むため値を上げてある。
const FILL_OPACITY = "var(--fig-highlight-fill-opacity)";
// 長方形の枠線は曲線と同じ色相のため、不透明度を下げて曲線（不透明・太線）と見分けやすくする。
const BAR_STROKE_OPACITY = 0.55;

// 描画領域。FunctionGraph と同じ寸法にし、図をまたいで字の大きさをそろえる。
const VIEW_W = 320;
const VIEW_H = 280;
const PAD = 28;

// 曲線と領域の標本数。
const SAMPLES = 480;

type Sample2 = { xv: number; yv: number };

export default function RiemannSumGraph({
  xMin,
  xMax,
  yMin,
  yMax,
  fn,
  curveDomain,
  curveLabel,
  upperFn,
  upperLabel,
  betweenArea,
  betweenLowerFn,
  partition = [],
  sample = "left",
  showSamples = false,
  area,
  frames = [],
  dividers = [],
  xTicks,
  yTicks,
  xLabel = "x",
  yLabel = "y",
  ariaLabel,
}: RiemannSumGraphProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const arrow = `rsArrow-${uid}`;
  const clip = `rsClip-${uid}`;

  const plotW = VIEW_W - 2 * PAD;
  const plotH = VIEW_H - 2 * PAD;
  const originX = PAD;
  const originY = PAD;

  const x = scaleLinear<number>({ domain: [xMin, xMax], range: [originX, originX + plotW] });
  // SVG は下向きが正のため反転する。
  const y = scaleLinear<number>({ domain: [yMin, yMax], range: [originY + plotH, originY] });

  // 軸の交点（数学座標の原点が窓内にあればそこ、なければ近い端に寄せる）。
  const axisX = x(clamp(0, xMin, xMax));
  const axisY = y(clamp(0, yMin, yMax));
  // 長方形と領域の底辺は、数学座標の y=0 に置く（窓外でもクリップで切る）。
  const zeroY = y(0);

  const xt = xTicks ?? autoTicks(xMin, xMax);
  const yt = yTicks ?? autoTicks(yMin, yMax);

  // 各小区間の代表点。配列の長さが足りないときは左端で補い、描画が欠けないようにする。
  const samplePoint = (k: number): number => {
    const lo = partition[k];
    const hi = partition[k + 1];
    if (Array.isArray(sample)) return sample[k] ?? lo;
    if (sample === "right") return hi;
    if (sample === "mid") return (lo + hi) / 2;
    return lo;
  };
  const bars = partition.slice(0, -1).map((lo, k) => {
    const hi = partition[k + 1];
    const xs = samplePoint(k);
    const h = fn(xs);
    return { lo, hi, xs, h };
  });

  // 区間 [from, to] を標本化する。領域の多角形と曲線の両方で使う。
  const sampleRange = (f: (v: number) => number, lo: number, hi: number): Sample2[] => {
    const out: Sample2[] = [];
    for (let i = 0; i <= SAMPLES; i += 1) {
      const xv = lo + ((hi - lo) * i) / SAMPLES;
      out.push({ xv, yv: f(xv) });
    }
    return out;
  };

  // 曲線と x 軸の間の領域を、正の部分と負の部分に分けた多角形にする。値を 0 で切り詰めると、
  // 正の部分の多角形は x 軸より上だけ、負の部分は下だけを覆い、符号ごとに色を分けられる。
  // 値がその符号をとらない部分しか無いときは、面積 0 の多角形を出さずに省く。
  const areaSamples = area === undefined ? [] : sampleRange(fn, area[0], area[1]);
  const areaPolygon = (sign: 1 | -1): [number, number][] | null => {
    if (area === undefined) return null;
    const has = areaSamples.some((d) => (sign === 1 ? d.yv > 0 : d.yv < 0));
    if (!has) return null;
    const pts: [number, number][] = [[x(area[0]), zeroY]];
    for (const d of areaSamples) {
      const clipped = sign === 1 ? Math.max(d.yv, 0) : Math.min(d.yv, 0);
      pts.push([x(d.xv), y(clipped)]);
    }
    pts.push([x(area[1]), zeroY]);
    return pts;
  };
  const positiveArea = areaPolygon(1);
  const negativeArea = areaPolygon(-1);

  // 2 曲線の間の領域。下の曲線に沿って進み、上の曲線に沿って戻る多角形にする。区間と下側の境界は、
  // 指定が無ければ曲線の下の領域と同じ（area と fn）にし、従来の描画を変えない。
  const betweenRange = betweenArea ?? area;
  const betweenLower = betweenLowerFn ?? fn;
  const betweenPolygon: [number, number][] | null =
    betweenRange === undefined || upperFn === undefined
      ? null
      : [
          ...sampleRange(betweenLower, betweenRange[0], betweenRange[1]).map(
            (d): [number, number] => [x(d.xv), y(d.yv)],
          ),
          ...sampleRange(upperFn, betweenRange[0], betweenRange[1])
            .toReversed()
            .map((d): [number, number] => [x(d.xv), y(d.yv)]),
        ];

  // 領域の両端の縦線。図形が直線 x=from・x=to で囲まれることを示す。値が 0 の端では引かない。
  const areaEdges =
    area === undefined
      ? []
      : area.filter(
          (ex) =>
            Math.abs(fn(ex)) > 1e-9 &&
            // 外枠の縦辺と同じ位置の線は、破線のすき間から透けて縞に見えるため引かない。
            !frames.some((f) => Math.abs(f.x0 - ex) < 1e-9 || Math.abs(f.x1 - ex) < 1e-9),
        );

  const [curveLo, curveHi] = curveDomain ?? [xMin, xMax];
  const curveSamples = sampleRange(fn, curveLo, curveHi);
  const [upperLo, upperHi] = betweenArea ?? [curveLo, curveHi];
  const upperSamples = upperFn === undefined ? [] : sampleRange(upperFn, upperLo, upperHi);

  // 凡例。ラベル付きの曲線だけを並べる。
  const legendItems = [
    ...(curveLabel === undefined ? [] : [{ label: curveLabel, color: CURVE }]),
    ...(upperFn === undefined || upperLabel === undefined
      ? []
      : [{ label: upperLabel, color: UPPER }]),
  ];

  return (
    <div className="function-graph-figure">
      <svg
        className="function-graph"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={ariaLabel}
      >
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
          <RectClipPath id={clip} x={originX} y={originY} width={plotW} height={plotH} />
        </defs>

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

        <Group clipPath={`url(#${clip})`}>
          {/* 曲線と x 軸の間の領域。長方形より奥に描く。 */}
          {positiveArea && (
            <Polygon
              points={positiveArea}
              fill={POSITIVE}
              stroke="none"
              style={{ fillOpacity: FILL_OPACITY }}
            />
          )}
          {negativeArea && (
            <Polygon
              points={negativeArea}
              fill={NEGATIVE}
              stroke="none"
              style={{ fillOpacity: FILL_OPACITY }}
            />
          )}
          {betweenPolygon && (
            <Polygon
              points={betweenPolygon}
              fill={UPPER}
              stroke="none"
              style={{ fillOpacity: FILL_OPACITY }}
            />
          )}
          {areaEdges.map((ex, i) => (
            <Line
              key={`edge-${i}`}
              from={{ x: x(ex), y: zeroY }}
              to={{ x: x(ex), y: y(fn(ex)) }}
              stroke={fn(ex) >= 0 ? POSITIVE : NEGATIVE}
              strokeWidth={1.2}
            />
          ))}

          {/* リーマン和の長方形。高さは代表点での関数の値で、負なら x 軸の下へ伸ばす。
              塗りと輪郭を別の層に分ける。輪郭の層は不透明な線をグループごと半透明にし、
              隣り合う長方形が共有する辺が 2 重に濃くならないようにする。 */}
          {bars.map((b, i) => {
            const top = y(Math.max(b.h, 0));
            const bottom = y(Math.min(b.h, 0));
            return (
              <Bar
                key={`barfill-${i}`}
                x={x(b.lo)}
                y={top}
                width={x(b.hi) - x(b.lo)}
                height={bottom - top}
                fill={b.h >= 0 ? POSITIVE : NEGATIVE}
                stroke="none"
                style={{ fillOpacity: FILL_OPACITY }}
              />
            );
          })}
          <g opacity={BAR_STROKE_OPACITY}>
            {bars.map((b, i) => {
              const top = y(Math.max(b.h, 0));
              const bottom = y(Math.min(b.h, 0));
              return (
                <Bar
                  key={`barline-${i}`}
                  x={x(b.lo)}
                  y={top}
                  width={x(b.hi) - x(b.lo)}
                  height={bottom - top}
                  fill="none"
                  stroke={b.h >= 0 ? POSITIVE : NEGATIVE}
                  strokeWidth={1.2}
                />
              );
            })}
          </g>

          {/* 外枠だけの長方形（評価の図）。底辺は x 軸と重なるため描かず、残る 3 辺を破線で引く。
              縦辺はどちらも x 軸から上へ描き、別の枠と縦辺を共有しても破線の位置がそろうようにする。 */}
          {frames.map((f, i) => {
            const x0 = x(f.x0);
            const x1 = x(f.x1);
            const top = y(f.height);
            const stroke = f.color ?? HIGHLIGHT;
            return (
              <g
                key={`frame-${i}`}
                fill="none"
                stroke={stroke}
                strokeWidth={1.6}
                strokeDasharray="5 4"
              >
                <path d={`M ${x0} ${zeroY} L ${x0} ${top}`} />
                <path d={`M ${x1} ${zeroY} L ${x1} ${top}`} />
                <path d={`M ${x0} ${top} L ${x1} ${top}`} />
              </g>
            );
          })}

          {/* 曲線。長方形の上に描き、長方形の上辺とのずれを見せる。 */}
          {upperSamples.length > 0 && (
            <LinePath<Sample2>
              data={upperSamples}
              x={(d) => x(d.xv)}
              y={(d) => y(d.yv)}
              defined={(d) => Number.isFinite(d.yv)}
              fill="none"
              stroke={UPPER}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          <LinePath<Sample2>
            data={curveSamples}
            x={(d) => x(d.xv)}
            y={(d) => y(d.yv)}
            defined={(d) => Number.isFinite(d.yv)}
            fill="none"
            stroke={CURVE}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Group>

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
        <KatexLabel tex={xLabel} x={originX + plotW + 14} y={axisY - 11} fontSize={13} />
        <KatexLabel tex={yLabel} x={axisX + 8} y={originY - 9} fontSize={13} align="left" />

        {xt.map((t, i) => (
          <Line
            key={`tx-${i}`}
            from={{ x: x(tickValue(t)), y: axisY - 3 }}
            to={{ x: x(tickValue(t)), y: axisY + 3 }}
            stroke={AXIS}
            strokeWidth={1.2}
          />
        ))}
        {yt.map((t, i) => (
          <Line
            key={`ty-${i}`}
            from={{ x: axisX - 3, y: y(tickValue(t)) }}
            to={{ x: axisX + 3, y: y(tickValue(t)) }}
            stroke={AXIS}
            strokeWidth={1.2}
          />
        ))}

        {/* 区間の分け目。x 軸から曲線上の点まで破線で引き、塗った領域を 2 つに分けて見せる。
            軸より後に描く。x=0 の分け目が y 軸に隠れないようにするためである。描画窓の外へ
            伸びる分だけは、曲線と同じく描画窓で切る。 */}
        {dividers.length > 0 && (
          <Group clipPath={`url(#${clip})`}>
            {dividers.map((dx, i) => (
              <Line
                key={`div-${i}`}
                from={{ x: x(dx), y: zeroY }}
                to={{ x: x(dx), y: y(fn(dx)) }}
                stroke={HIGHLIGHT}
                strokeWidth={1.6}
                strokeDasharray="5 4"
              />
            ))}
          </Group>
        )}

        {/* 代表点。長方形の上辺と曲線が交わる点に、強調色の丸を置く。 */}
        {showSamples &&
          bars.map((b, i) => (
            <Circle key={`smp-${i}`} cx={x(b.xs)} cy={y(b.h)} r={3.6} fill={HIGHLIGHT} />
          ))}

        {/* 外枠の長方形のラベル。上辺の高さで、長方形の左外側または右外側に置く。 */}
        {frames.map((f, i) => {
          if (f.label === undefined) return null;
          const right = f.labelSide === "right";
          return (
            <KatexLabel
              key={`frl-${i}`}
              tex={f.label}
              x={right ? x(f.x1) + 5 : x(f.x0) - 5}
              y={y(f.height)}
              fontSize={12}
              align={right ? "left" : "right"}
              className="fig-tick-label"
            />
          );
        })}

        {/* 目盛り数字。長方形や曲線と重なっても読めるよう、最前面に描き、ハローを敷く。 */}
        {xt.map((t, i) => (
          <KatexLabel
            key={`txn-${i}`}
            tex={tickLabel(t)}
            x={x(tickValue(t)) + tickDx(t)}
            y={tickAbove(t) ? axisY - 13 : axisY + 13}
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

      {legendItems.length > 0 && (
        <div className="function-graph-legend">
          {legendItems.map((item, i) => {
            const html = renderToString(item.label, {
              throwOnError: false,
              displayMode: false,
              trust: false,
            });
            return (
              <LegendItem key={`lg-${i}`}>
                <svg width={24} height={12} aria-hidden="true">
                  <line x1={0} y1={6} x2={24} y2={6} stroke={item.color} strokeWidth={2} />
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

/** 浮動小数の丸め誤差を抑え、目盛り数値を短い文字列にする（小数第 3 位まで）。 */
function formatNum(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

function tickValue(t: Tick): number {
  return typeof t === "number" ? t : t.value;
}

function tickLabel(t: Tick): string {
  return typeof t === "number" ? formatNum(t) : (t.label ?? formatNum(t.value));
}

function tickAbove(t: Tick): boolean {
  return typeof t === "number" ? false : (t.above ?? false);
}

function tickDx(t: Tick): number {
  return typeof t === "number" ? 0 : (t.dx ?? 0);
}

/** 区間 [lo, hi] 内の 0 以外の整数位置を目盛りとして返す。 */
function autoTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(lo); v <= Math.floor(hi); v += 1) {
    if (v !== 0) out.push(v);
  }
  return out;
}
