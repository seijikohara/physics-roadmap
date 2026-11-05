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
import {
  besideSegment,
  besideSegmentCandidates,
  besideVectorCandidates,
  linePositions,
  pointPositions,
  positionCandidates,
  widelyAroundPoint,
  type LabelDirSpec,
  type LineLabelSpec,
} from "./figure-label/candidates";
import {
  bboxOf,
  boxesOverlap,
  visiblePieces,
  type Box,
  type LineSample,
  type XY,
} from "./figure-label/geometry";
import { glyphBox, glyphSizeOf, type GlyphSize, type LabelPos } from "./figure-label/label-box";
import { boxObstacle, lineObstacle } from "./figure-label/obstacles";
import {
  NO_PLACEMENT,
  createPlacer,
  placeInOrder,
  placedLabel,
  type Candidate,
  type Label,
} from "./figure-label/placer";
import { OBSTACLE_WEIGHT } from "./figure-label/policy";
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
 * 点・補助線・補助線分・ベクトルのラベルは `figure-label` の配置器が、軸・目盛り数字・線・点の印・
 * 他のラベルを避ける位置へ置く。寸法は KaTeX の組版の木から見積もる。`labelAt` は基準点、`labelDir` は
 * 基準点から見た向き、`labelOffset` はすきまである。
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

/** ラベルの位置の指定。点・補助線・補助線分・ベクトルで共通である。 */
type LabelProps = Readonly<{
  /** ラベルの基準点（数学座標）。既定では自動で選ぶ。 */
  labelAt?: XY;
  /**
   * 基準点から見たラベルの向き。基準点は labelAt、無ければ点そのものや線の中点である。既定は labelAt が
   * あれば "center"（基準点をラベルの中心にする）、無ければ "auto" である。"auto" は向きを自動で選ぶ。
   * 8 方位を渡すと向きを固定する。
   */
  labelDir?: LabelDirSpec;
  /**
   * 線・点の印・基準点と字形のすきまの目標（px）。既定 4。箱は見積もりの誤差の分だけさらに離すので、
   * 箱の縁までは基準点・点の印の端から labelOffset + 1、線の中心から labelOffset + 2.25（向きを固定した
   * ときは labelOffset + 2）である。
   */
  labelOffset?: number;
}>;

/** 平面上の 1 点。塗りつぶし（黒丸）または白抜き（白丸）で表す。 */
type Point = LabelProps &
  Readonly<{
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
type AsymptoteLine = LabelProps &
  Readonly<{
    x?: number;
    y?: number;
    /** 線に添える LaTeX ラベル。 */
    label?: string;
    /** 線の色。既定は強調色（HIGHLIGHT）。準線など他の補助線と区別したいとき指定する。 */
    color?: string;
  }>;

/** 2 点を結ぶ補助線分。傾きの三角形の辺など、限定した区間の補助線に使う。 */
type Segment = LabelProps &
  Readonly<{
    from: XY;
    to: XY;
    /** 線分の中点付近に置く LaTeX ラベル（例: "\\Delta x"）。 */
    label?: string;
    /** 破線で描くか。既定は実線。 */
    dashed?: boolean;
  }>;

/** 矢印付きベクトル（有向線分）。始点 from から終点 to へ矢じり付きで描く。 */
type Vec = LabelProps &
  Readonly<{
    from: XY;
    to: XY;
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

// 点の印の半径と、白抜きの点の輪郭の線の太さ（px）。
const POINT_R = 4;
const OPEN_POINT_STROKE = 1.8;

// 軸がプロット矩形から伸びる長さと、目盛りの線の軸からの長さ（px）。
const AXIS_OVERHANG = 6;
const TICK_HALF = 3;

// 点・補助線・ベクトルのラベル、目盛り数字、軸名の字の大きさ（KatexLabel の fontSize）。
const LABEL_FONT = 12;
const TICK_FONT = 11;
const AXIS_NAME_FONT = 13;
// 目盛り数字の中心と軸の距離（px）。字形と目盛りの線の端のすきまは、実測で x 軸の「1」が 5.15px、
// y 軸の「−1」が 4.5px である。
const X_TICK_OFFSET = 14;
const Y_TICK_OFFSET = 15;

// 既出のラベルと同じ行に並ぶときに残したいすきま（px）。「P dx」のように 1 続きの式に読まれるのを防ぐ。
const LABEL_ROW_GAP = 10;

// 線分・矢印のラベルを置く、線の上の割合。中点を優先する。
const SEGMENT_FRACTIONS: readonly number[] = [0.5, 0.35, 0.65, 0.2, 0.8];
// 補助線のラベルを置く、線の上の割合。線の始点から測り、前の割合ほど優先する。曲線が線に両端で
// 近づく図（指数関数の y=0 など）でも、線の中ほどの空いた区間を選べる。縦線は始点が下端で上寄りを、
// 横線は始点が右端で左寄りを優先する。
const V_LINE_FRACTIONS: readonly number[] = [0.88, 0.76, 0.64, 0.52, 0.4, 0.28, 0.12];
const H_LINE_FRACTIONS: readonly number[] = [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.9, 0.1];

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

  const curveSamples = curves.map(samplesOf);
  const paramSamples = parametrics.map(paramSamplesOf);

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

  // ---- ラベルの自動配置 ----
  // 候補位置を採点し、最も衝突の少ない位置を選ぶ。ビルド時に一度だけ走る。障害物は、軸・軸名・目盛り
  // 数字・点の印（矩形）と、曲線・補助線・ベクトルなどの線（折れ線）、目盛りに沿った格子線である。
  const viewBounds: Box = { x0: 2, x1: VIEW_W - 2, y0: 2, y1: VIEW_H - 2 };
  const toScreen = (p: XY): XY => ({ x: x(p.x), y: y(p.y) });
  const screenPieces = (samples: readonly CurveSample[]): readonly (readonly XY[])[] =>
    visiblePieces(samples.map((s): LineSample => ({ x: x(s.xv), y: y(s.yv), ok: s.visible })));

  // 空ラベルの目盛り（格子線だけを残し数字を省く目盛り）は字形をもたないので、障害物から外す。
  const tickBoxOf = (t: Tick, pos: LabelPos): Box =>
    glyphBox(pos, glyphSizeOf(tickLabel(t), TICK_FONT));
  const xTickBoxes: readonly Box[] = xt.flatMap((t) =>
    tickLabel(t) === ""
      ? []
      : [tickBoxOf(t, { x: x(tickValue(t)), y: axisY + X_TICK_OFFSET, align: "center" })],
  );
  const yTickBoxes: readonly Box[] = yt.flatMap((t) =>
    tickLabel(t) === ""
      ? []
      : [tickBoxOf(t, { x: axisX - Y_TICK_OFFSET, y: y(tickValue(t)), align: "center" })],
  );
  // 目盛り数字の行と列の帯。点や補助線のラベルが入ると、数字に重ならなくても目盛りの 1 つに見える。
  // 線分と矢印のラベルは線に添うので目盛りに見えにくく、帯を避けると線の中ほどから外れる。
  const tickBands: readonly Box[] = [
    ...(xTickBoxes.length === 0
      ? []
      : [{ ...bboxOf(cornersOf(xTickBoxes)), x0: originX, x1: originX + plotW }]),
    ...(yTickBoxes.length === 0
      ? []
      : [{ ...bboxOf(cornersOf(yTickBoxes)), y0: originY, y1: originY + plotH }]),
  ];
  const W = OBSTACLE_WEIGHT;
  const axisObstacles = [
    boxObstacle(
      {
        x0: axisX - 1.5,
        x1: axisX + 1.5,
        y0: originY - AXIS_OVERHANG,
        y1: originY + plotH + AXIS_OVERHANG,
      },
      W.axis,
    ),
    boxObstacle(
      {
        x0: originX - AXIS_OVERHANG,
        x1: originX + plotW + AXIS_OVERHANG,
        y0: axisY - 1.5,
        y1: axisY + 1.5,
      },
      W.axis,
    ),
  ];
  // 軸名（x・y）。描く位置は下の軸名の KatexLabel と同じである。既出のラベルとして扱い、同じ行に並ぶ
  // ラベルが「Z₀ Re」のように 1 続きに読まれるのを避ける。
  const axisNameBoxes: readonly Box[] = [
    glyphBox(
      { x: originX + plotW + 14, y: axisY - 11, align: "center" },
      glyphSizeOf(xLabel, AXIS_NAME_FONT),
    ),
    glyphBox({ x: axisX + 8, y: originY - 9, align: "left" }, glyphSizeOf(yLabel, AXIS_NAME_FONT)),
  ];
  const tickMarks: readonly (readonly XY[])[] = [
    ...xt.map((t) => [
      { x: x(tickValue(t)), y: axisY - TICK_HALF },
      { x: x(tickValue(t)), y: axisY + TICK_HALF },
    ]),
    ...yt.map((t) => [
      { x: axisX - TICK_HALF, y: y(tickValue(t)) },
      { x: axisX + TICK_HALF, y: y(tickValue(t)) },
    ]),
  ];
  const gridLines: readonly (readonly XY[])[] = [
    ...xt.map((t) => [
      { x: x(tickValue(t)), y: originY },
      { x: x(tickValue(t)), y: originY + plotH },
    ]),
    ...yt.map((t) => [
      { x: originX, y: y(tickValue(t)) },
      { x: originX + plotW, y: y(tickValue(t)) },
    ]),
  ];

  // 補助線の両端（画面座標）。縦線・横線のどちらでもなければ null を返す。縦線の右側と横線の上側が
  // besideSegment の先の候補になるよう、縦線は下から上へ、横線は右から左へ向ける。
  const asymptoteEnds = (a: AsymptoteLine): readonly [XY, XY] | null => {
    if (a.x !== undefined) {
      return [
        { x: x(a.x), y: originY + plotH },
        { x: x(a.x), y: originY },
      ];
    }
    if (a.y !== undefined) {
      return [
        { x: originX + plotW, y: y(a.y) },
        { x: originX, y: y(a.y) },
      ];
    }
    return null;
  };

  const placer = createPlacer([
    ...[...xTickBoxes, ...yTickBoxes].map((box) => boxObstacle(box, W.tick)),
    ...axisObstacles,
    ...points.map((p, i) => {
      const px = x(p.x);
      const py = y(p.y);
      const r = markerReach(p);
      return boxObstacle({ x0: px - r, x1: px + r, y0: py - r, y1: py + r }, W.point, `pt${i}`);
    }),
    // 破線の曲線は比べる相手や補助の線なので、主役の曲線より軽い。
    ...curveSamples.flatMap((s, i) =>
      screenPieces(s).flatMap((piece) =>
        lineObstacle(`cv${i}`, piece, curves[i].dashed ? W.line : W.curve),
      ),
    ),
    ...paramSamples.flatMap((s, i) =>
      screenPieces(s).flatMap((piece) =>
        lineObstacle(`pm${i}`, piece, parametrics[i].dashed ? W.line : W.curve),
      ),
    ),
    ...vectors.flatMap((v, i) =>
      lineObstacle(`vc${i}`, [toScreen(v.from), toScreen(v.to)], W.line),
    ),
    ...segments.flatMap((s, i) =>
      lineObstacle(`sg${i}`, [toScreen(s.from), toScreen(s.to)], W.line),
    ),
    ...asymptotes.flatMap((a, i) => {
      const ends = asymptoteEnds(a);
      return ends === null ? [] : lineObstacle(`as${i}`, ends, W.line);
    }),
    ...tickMarks.flatMap((pts) => lineObstacle("tk", pts, W.thinLine)),
    ...gridLines.flatMap((pts) => lineObstacle("gd", pts, W.grid, true)),
  ]);

  // 目盛り数字の帯に入る候補に罰点を足す。
  const avoidTickBands = (
    candidates: readonly Candidate<LabelPos>[],
  ): readonly Candidate<LabelPos>[] =>
    candidates.map((c) => {
      const extra = tickBands.filter((b) => boxesOverlap(c.box, b)).length * W.tickBand;
      return { ...c, score: (penalty) => (c.score?.(penalty) ?? penalty) + extra };
    });

  // 候補から最も罰点の小さい位置を選ぶ。同点なら前方の候補を優先する。
  const choosePlacement = (
    candidates: readonly Candidate<LabelPos>[],
    placed: readonly Box[],
    exclude?: string,
  ): LabelPos | null =>
    placer.place(candidates, { placed, bounds: viewBounds, exclude, rowGap: LABEL_ROW_GAP }).item;

  // 線のラベルの候補。位置も向きも指定が無ければ auto を使い、指定があれば linePositions に従う。
  const lineCandidates = (
    spec: LabelProps,
    a: XY,
    b: XY,
    size: GlyphSize,
    auto: (offset: number | undefined) => readonly Candidate<LabelPos>[],
  ): readonly Candidate<LabelPos>[] => {
    const { labelAt, labelDir, labelOffset } = spec;
    if (labelAt === undefined && (labelDir === undefined || labelDir === "auto")) {
      return auto(labelOffset);
    }
    const at = labelAt === undefined ? undefined : toScreen(labelAt);
    const fixed: LineLabelSpec = { at, dir: labelDir, offset: labelOffset };
    return positionCandidates(
      linePositions(fixed, a, b, size, () => []),
      size,
    );
  };

  // ラベルは、補助線分・ベクトル・点・補助線の順に 1 つずつ置く。動ける範囲の狭いラベルを先に置く。
  // 各段の最後の placed を次の段へ渡し、後のラベルが先のラベルを避けるようにする。
  const segmentLabels = placeInOrder(segments, axisNameBoxes, (s, i, placed) => {
    if (s.label === undefined) return NO_PLACEMENT;
    const size = glyphSizeOf(s.label, LABEL_FONT);
    const a = toScreen(s.from);
    const b = toScreen(s.to);
    const pos = choosePlacement(
      lineCandidates(s, a, b, size, (offset) =>
        besideSegmentCandidates(a, b, size, offset, SEGMENT_FRACTIONS),
      ),
      placed,
      s.labelAt === undefined ? `sg${i}` : undefined,
    );
    return placedLabel(s.label, pos, size);
  });

  const vectorLabels = placeInOrder(vectors, segmentLabels.placed, (v, i, placed) => {
    if (v.label === undefined) return NO_PLACEMENT;
    const size = glyphSizeOf(v.label, LABEL_FONT);
    const from = toScreen(v.from);
    const to = toScreen(v.to);
    const pos = choosePlacement(
      lineCandidates(v, from, to, size, (offset) =>
        besideVectorCandidates(from, to, size, HEAD_HALF, offset, SEGMENT_FRACTIONS),
      ),
      placed,
      // 基準点が線の上でも線を避けられるよう、labelAt があれば自分の線も判定に含める。
      v.labelAt === undefined ? `vc${i}` : undefined,
    );
    return placedLabel(v.label, pos, size);
  });

  const pointLabels = placeInOrder(points, vectorLabels.placed, (p, i, placed) => {
    if (p.label === undefined) return NO_PLACEMENT;
    const size = glyphSizeOf(p.label, LABEL_FONT);
    const at = toScreen(p);
    const reach = markerReach(p);
    const auto = p.labelDir === undefined || p.labelDir === "auto";
    const pointCandidates = auto
      ? widelyAroundPoint(at, size, reach, p.labelOffset)
      : positionCandidates(pointPositions(at, size, reach, p.labelDir, p.labelOffset), size);
    const pos = choosePlacement(
      p.labelAt === undefined
        ? avoidTickBands(pointCandidates)
        : lineCandidates(p, at, at, size, () => []),
      placed,
      `pt${i}`,
    );
    return placedLabel(p.label, pos, size);
  });

  const asymptoteLabels = placeInOrder(asymptotes, pointLabels.placed, (a, i, placed) => {
    const ends = asymptoteEnds(a);
    if (a.label === undefined || ends === null) return NO_PLACEMENT;
    const size = glyphSizeOf(a.label, LABEL_FONT);
    const fractions = a.x === undefined ? H_LINE_FRACTIONS : V_LINE_FRACTIONS;
    const pos = choosePlacement(
      lineCandidates(a, ends[0], ends[1], size, (offset) =>
        avoidTickBands(
          positionCandidates(besideSegment(ends[0], ends[1], size, offset, fractions), size),
        ),
      ),
      placed,
      a.labelAt === undefined ? `as${i}` : undefined,
    );
    return placedLabel(a.label, pos, size);
  });

  // 置いたラベルを描く。ラベルの無い要素では何も描かない。
  const labelNode = (l: Label | null): ReactNode =>
    l && (
      <KatexLabel tex={l.tex} x={l.pos.x} y={l.pos.y} fontSize={LABEL_FONT} align={l.pos.align} />
    );

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
          const label = labelNode(asymptoteLabels.items[i]);
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
                {label}
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
                {label}
              </g>
            );
          }
          return null;
        })}

        {/* 補助線分（傾きの三角形の辺など）。 */}
        {segments.map((s, i) => (
          <g key={`sg-${i}`}>
            <Line
              from={{ x: x(s.from.x), y: y(s.from.y) }}
              to={{ x: x(s.to.x), y: y(s.to.y) }}
              stroke={HIGHLIGHT}
              strokeWidth={1.6}
              strokeDasharray={s.dashed ? "5 4" : undefined}
              strokeLinecap="round"
            />
            {labelNode(segmentLabels.items[i])}
          </g>
        ))}

        {/* 軸。両端に矢印を付ける。 */}
        <Line
          from={{ x: originX - AXIS_OVERHANG, y: axisY }}
          to={{ x: originX + plotW + AXIS_OVERHANG, y: axisY }}
          stroke={AXIS}
          strokeWidth={1.4}
          markerStart={`url(#${arrow})`}
          markerEnd={`url(#${arrow})`}
        />
        <Line
          from={{ x: axisX, y: originY + plotH + AXIS_OVERHANG }}
          to={{ x: axisX, y: originY - AXIS_OVERHANG }}
          stroke={AXIS}
          strokeWidth={1.4}
          markerStart={`url(#${arrow})`}
          markerEnd={`url(#${arrow})`}
        />

        {/* 軸名。y 軸名は目盛り数字と同じ左側に置くと接触するため、軸の右上へ離す。
          x 軸名は目盛り数字の右外へ離す。y 軸名は左寄せにし、幅広のラベル（例: a_n, c_n）
          でも左半分が軸線や矢印へ食い込まないよう、右方向へだけ伸ばす。 */}
        <KatexLabel
          tex={xLabel}
          x={originX + plotW + 14}
          y={axisY - 11}
          fontSize={AXIS_NAME_FONT}
        />
        <KatexLabel
          tex={yLabel}
          x={axisX + 8}
          y={originY - 9}
          fontSize={AXIS_NAME_FONT}
          align="left"
        />

        {/* x 軸の目盛りの刻み線。数字は点・曲線より前面に描くため、最後にまとめて置く。 */}
        {xt.map((t, i) => (
          <Line
            key={`tx-${i}`}
            from={{ x: x(tickValue(t)), y: axisY - TICK_HALF }}
            to={{ x: x(tickValue(t)), y: axisY + TICK_HALF }}
            stroke={AXIS}
            strokeWidth={1.2}
          />
        ))}
        {/* y 軸の目盛りの刻み線。 */}
        {yt.map((t, i) => (
          <Line
            key={`ty-${i}`}
            from={{ x: axisX - TICK_HALF, y: y(tickValue(t)) }}
            to={{ x: axisX + TICK_HALF, y: y(tickValue(t)) }}
            stroke={AXIS}
            strokeWidth={1.2}
          />
        ))}

        {/* 曲線。描画窓でクリップしてはみ出しを防ぐ。 */}
        <Group clipPath={`url(#clip-${uid})`}>
          {curves.map((c, i) => (
            <LinePath<CurveSample>
              key={`curve-${i}`}
              data={[...curveSamples[i]]}
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
              data={[...paramSamples[i]]}
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
              {labelNode(vectorLabels.items[i])}
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
                r={POINT_R}
                fill="var(--sl-color-bg, #fff)"
                stroke={color}
                strokeWidth={OPEN_POINT_STROKE}
              />
            ) : (
              <Circle key="c" cx={px} cy={py} r={POINT_R} fill={color} />
            ),
          ];
          return (
            <g key={`pt-${i}`}>
              {marks}
              {labelNode(pointLabels.items[i])}
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
            y={axisY + X_TICK_OFFSET}
            fontSize={TICK_FONT}
            className="fig-tick-label"
          />
        ))}
        {yt.map((t, i) => (
          <KatexLabel
            key={`tyn-${i}`}
            tex={tickLabel(t)}
            x={axisX - Y_TICK_OFFSET}
            y={y(tickValue(t))}
            fontSize={TICK_FONT}
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

/** 矩形の列の、左上と右下の角の列。 */
function cornersOf(boxes: readonly Box[]): readonly XY[] {
  return boxes.flatMap((b) => [
    { x: b.x0, y: b.y0 },
    { x: b.x1, y: b.y1 },
  ]);
}

/** 点の中心から印の端までの距離（px）。白抜きの点は輪郭の線の太さの半分だけ広い。 */
function markerReach(p: Point): number {
  return p.open === true ? POINT_R + OPEN_POINT_STROKE / 2 : POINT_R;
}
