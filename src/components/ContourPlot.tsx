import { RectClipPath } from "@visx/clip-path";
import { GridColumns, GridRows } from "@visx/grid";
import { Group } from "@visx/group";
import { LegendItem, LegendLabel } from "@visx/legend";
import { Marker } from "@visx/marker";
import { scaleLinear } from "@visx/scale";
import { Circle, Line, LinePath, Polygon } from "@visx/shape";
import { renderToString } from "katex";
import { useId } from "react";
import KatexLabel from "./KatexLabel";

/**
 * インライン SVG として描く、ビルド時生成の静的な平面図（等高線・領域・ベクトルの図）。
 *
 * 2 変数関数 $f(x,y)$ の等高線、平面上の領域の塗り、曲線、矢印（勾配の向きなど）、点、長方形の
 * 分割の格子（二重積分のリーマン和）、極座標の格子、補助線分を、1 枚の $xy$ 平面に重ねて描く。
 * 多変数の微積分で、定義域・等高線・勾配・積分領域を同じ見た目の 1 部品で表すために
 * `FunctionGraph` から分ける。共有の `FunctionGraph` を変更せず、既存の章の描画に影響を
 * 与えないためでもある。
 *
 * 本コンポーネントはクライアント JavaScript を一切載せない。Astro がビルド時に HTML へ描画する
 * （クライアントディレクティブなし、ハイドレーションなし）。座標は `@visx/scale`、等高線・曲線・
 * 境界は `@visx/shape` の `LinePath`、領域は `Polygon`、軸・線分は `Line`、点は `Circle` で
 * 描く。格子線は `@visx/grid`、クリップは `@visx/clip-path`、軸の矢印は `@visx/marker` を
 * 用いる。軸・目盛り・凡例の寸法と配色は `FunctionGraph` にそろえる。
 *
 * 等高線は marching squares 法で求める。描画窓を細かい正方の格子に区切り、各セルで等高線が
 * 横切る辺を格子点の値の符号から判定し、辺上の交点を線形補間で求めて線分で結ぶ。線分は交点の
 * キー（どの辺の上か）でつなぎ、折れ線にする。新しい npm 依存を増やさないよう自前で実装する。
 *
 * ラベルは KatexLabel で組版する。点・ベクトル・曲線・等高線のラベルは、候補位置を採点して、
 * 軸・目盛り数字・線・既出ラベルと重ならない位置を選ぶ（`FunctionGraph` と同じ考え方）。
 * 等高線のラベルは線の上に置き、ラベルの下だけ線をマスクで切り抜く。
 */

/** 数学座標の点。 */
type XY = { x: number; y: number };

/**
 * 軸の目盛り。数値だけ渡すと数値をそのまま描く。$\pi$ など特別な値には `{ value, label }` で
 * ラベル（LaTeX）を添える。`FunctionGraph` と同じ指定方法である。
 */
type Tick = number | { value: number; label?: string };

/**
 * 等高線の 1 つの高さ。数値だけ渡すと、ラベルは `labelVar` を左辺にした等式（例: `c=1`）になる。
 * `{ value, label, color }` でラベル（LaTeX）と線の色を個別に指定できる。`label: ""` で
 * その高さだけラベルを省く。
 */
type ContourLevel = number | { value: number; label?: string; color?: string };

/** 1 つの関数の等高線の組。 */
type ContourSet = {
  /** 等高線を描く関数。数学座標 (x, y) を受け取り値を返す。定義域外では NaN を返してよい。 */
  fn: (x: number, y: number) => number;
  /** 描く高さ c の並び。 */
  levels: ContourLevel[];
  /** 横方向の格子の分割数の目安。多いほど細かくなる。既定はプロット幅の約 0.5px ごと。 */
  resolution?: number;
  /**
   * 格子点に必ず含める点。等高線どうしが交わる点（鞍点など）を渡すと、交点がちょうど格子点に
   * 乗り、交わりがくびれずに描ける。既定は原点で、0・整数・半整数の座標の点は常に格子点に乗る。
   */
  gridAnchor?: XY;
  /** 全レベルの線の色。省略時は、高さの順に既定のパレット（単色の濃淡）から割り当てる。 */
  color?: string;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
  /** 数値だけのレベルのラベルで、左辺に置く文字（LaTeX）。既定 "c"。"f" なら "f=2" になる。 */
  labelVar?: string;
  /** レベルのラベルを線の上に描くか。既定 true。 */
  labels?: boolean;
  /** 凡例に載せる LaTeX ラベル（例: "x^2+y^2=c"）。省略時は凡例に載せない。 */
  legendLabel?: string;
};

/** 領域の見た目。すべての指定方法に共通する。 */
type RegionStyle = {
  /** 塗りの色。既定は青系。 */
  color?: string;
  /** 塗りの不透明度（0〜1）。省略時はテーマ変数（明 0.2・暗 0.34）に従う。 */
  opacity?: number;
  /**
   * 境界線。"solid"（実線）は境界を含む、"dashed"（破線）は境界を含まないことを表す。"none" で
   * 境界線を描かない。既定 "solid"。境界の一部だけを含む領域は "none" にし、境界を曲線・
   * 補助線分で個別に描く。
   */
  boundary?: "solid" | "dashed" | "none";
  /** 境界線の色。既定は塗りの色。 */
  boundaryColor?: string;
  /** 領域内に置く LaTeX ラベル（例: "D"）。 */
  label?: string;
  /**
   * ラベルを置く基準の位置（数学座標）。省略時は、描画窓で切り取った領域の重心とする。基準の
   * 位置が軸・目盛り数字・線に重なるときは、領域の内側に残る近くの空いた位置へずらす。
   */
  labelAt?: XY;
};

/** 頂点列で与える多角形の領域。頂点は順にたどり、最後の頂点から最初の頂点へ戻って閉じる。 */
type PolygonRegion = RegionStyle & { kind: "polygon"; points: XY[] };

/**
 * 2 曲線ではさまれた領域 $a\le x\le b$、$g_1(x)\le y\le g_2(x)$。`x` に $[a,b]$、`lower` に
 * $g_1$、`upper` に $g_2$ を渡す。省いた側は描画窓の外まで広がり、その側の境界線は描かない。
 * 例えば `lower` だけを渡すと $y>g_1(x)$、`upper` だけを渡すと半平面 $y<g_2(x)$ を表す。
 */
type BetweenXRegion = RegionStyle & {
  kind: "between-x";
  x?: [number, number];
  lower?: (x: number) => number;
  upper?: (x: number) => number;
};

/**
 * $x$ と $y$ の役割を入れ替えた版 $c\le y\le d$、$h_1(y)\le x\le h_2(y)$。`y` に $[c,d]$、`left` に
 * $h_1$、`right` に $h_2$ を渡す。省いた側の扱いは `between-x` と同じである。
 */
type BetweenYRegion = RegionStyle & {
  kind: "between-y";
  y?: [number, number];
  left?: (y: number) => number;
  right?: (y: number) => number;
};

/** 媒介変数表示の閉曲線 $t\mapsto(x(t),y(t))$（$t_{\min}\le t\le t_{\max}$）で囲まれた領域。 */
type ParametricRegion = RegionStyle & {
  kind: "parametric";
  fn: (t: number) => XY;
  tMin: number;
  tMax: number;
  /** 標本数。既定 240。 */
  samples?: number;
};

/** 極座標の動径の範囲の端。定数、または角 $\theta$ の関数で与える。 */
type RadialBound = number | ((theta: number) => number);

/**
 * 極座標で与える領域 $r_1\le r\le r_2$、$\theta_1\le\theta\le\theta_2$（扇形・環状の領域）。
 * `r` の各端は定数か $\theta$ の関数である。$\theta_2-\theta_1=2\pi$ なら一周する（円板・円環）。
 */
type PolarRegion = RegionStyle & {
  kind: "polar";
  r: [RadialBound, RadialBound];
  theta: [number, number];
  /** 極（原点）の位置。既定は (0, 0)。 */
  center?: XY;
};

/** 塗りつぶす領域。`kind` で指定方法を選ぶ。描画窓からはみ出す部分は窓で切り取る。 */
type Region = PolygonRegion | BetweenXRegion | BetweenYRegion | ParametricRegion | PolarRegion;

/**
 * 曲線のラベルの置き方。"legend" は凡例にまとめ、"inline" は線のそばの空いた位置に置く。
 * 曲線が少なく、線と式の対応を図の中で示したいときに "inline" を選ぶ。
 */
type LabelPlacement = "legend" | "inline";

/** 陽関数 $y=f(x)$ の曲線。 */
type Curve = {
  /** 描く関数。x を受け取り y を返す。定義域外では NaN を返してよい。 */
  fn: (x: number) => number;
  /** この曲線だけの定義域 [min, max]。省略時は描画窓の横範囲全体。 */
  domain?: [number, number];
  /** 曲線の色。既定は青系。 */
  color?: string;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
  /** 曲線に添える LaTeX ラベル。 */
  label?: string;
  /** ラベルの置き方。既定 "legend"。 */
  labelPlacement?: LabelPlacement;
  /** "inline" のとき、ラベルを置く位置の x 座標。省略時は空いた位置を自動で選ぶ。 */
  labelAt?: number;
};

/** 媒介変数曲線 $t\mapsto(x(t),y(t))$。 */
type ParametricCurve = {
  fn: (t: number) => XY;
  tMin: number;
  tMax: number;
  /** 標本数。既定 240。 */
  samples?: number;
  /** 曲線の色。既定は青系。 */
  color?: string;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
  /** 曲線に添える LaTeX ラベル。 */
  label?: string;
  /** ラベルの置き方。既定 "legend"。 */
  labelPlacement?: LabelPlacement;
  /** "inline" のとき、ラベルを置く位置の媒介変数 t。省略時は空いた位置を自動で選ぶ。 */
  labelAt?: number;
};

/** 矢印の見た目。 */
type VectorStyle = {
  /** 矢印の色。既定は桃色系（等高線の青と区別する）。 */
  color?: string;
  /** 矢印に添える LaTeX ラベル（例: "\\nabla f"）。 */
  label?: string;
  /** ラベルの中心の位置（数学座標）。省略時は、線・他のラベルと重ならない位置を自動で選ぶ。 */
  labelAt?: XY;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
};

/** 矢印（有向線分）。始点 `from` と終点 `to`、または始点 `from` と成分 `delta` で与える。 */
type Vector = VectorStyle & ({ from: XY; to: XY } | { from: XY; delta: XY });

/** 平面上の 1 点。塗りつぶし（黒丸）または白抜き（白丸。その点を含まない）で表す。 */
type Point = {
  x: number;
  y: number;
  /** 点に添える LaTeX ラベル。 */
  label?: string;
  /** 白抜き（その点を含まない）で描くか。既定 false。 */
  open?: boolean;
  /** 強調色（琥珀色）で描くか。既定 false。 */
  highlight?: boolean;
  /** 点の色。highlight より優先する。 */
  color?: string;
  /**
   * ラベルを置く向き。省略時は、軸・線・他のラベルと重ならない向きを自動で選ぶ。接点のように
   * 線が混み合う点で、自動の選択が線に触れるときに指定する。
   */
  labelDir?: LabelDir;
};

/** 点のラベルを置く向き。 */
type LabelDir =
  | "above"
  | "below"
  | "left"
  | "right"
  | "above-left"
  | "above-right"
  | "below-left"
  | "below-right";

/** 小長方形の代表点の選び方。関数を渡すと、小長方形の番号 (i, j) から代表点を返す。 */
type PartitionSample =
  | "center"
  | "lower-left"
  | "lower-right"
  | "upper-left"
  | "upper-right"
  | ((i: number, j: number) => XY);

/**
 * 長方形 $[a,b]\times[c,d]$ を $m\times n$ の小長方形に分ける格子。二重積分のリーマン和の図に使う。
 * 小長方形の番号 (i, j) は 1 始まりで、i が x 方向（左から）、j が y 方向（下から）である。
 */
type Partition = {
  /** x 方向の区間 [a, b]。 */
  x: [number, number];
  /** y 方向の区間 [c, d]。 */
  y: [number, number];
  /** x 方向の分割数。 */
  m: number;
  /** y 方向の分割数。 */
  n: number;
  /** 強調して塗る小長方形。label は小長方形の中に置く LaTeX（例: "R_{32}"）。 */
  highlight?: { i: number; j: number; label?: string }[];
  /** 各小長方形の代表点。省略時は代表点を描かない。 */
  samples?: PartitionSample;
  /** 長方形全体を淡く塗るか。既定 false。 */
  fill?: boolean;
  /** 格子線の色。既定は青系。 */
  color?: string;
};

/** 2 点を結ぶ補助線分。既定は破線。 */
type Segment = {
  from: XY;
  to: XY;
  /** 線分の中点付近に置く LaTeX ラベル。 */
  label?: string;
  /** ラベルの中心の位置（数学座標）。省略時は、線分の両側のうち空いた側を自動で選ぶ。 */
  labelAt?: XY;
  /** 破線で描くか。既定 true。 */
  dashed?: boolean;
  /** 線の色。既定は強調色（琥珀色）。 */
  color?: string;
};

/**
 * 極座標の格子。極を中心とする円（`radii`）と、極から出る半直線（`angles`、弧度法）を細線で描く。
 * 半直線は最も外側の円まで引く。`angles` に `{ value, label }` を渡すと、半直線の先に角の
 * ラベル（LaTeX）を置く。
 */
type PolarGrid = {
  radii?: number[];
  angles?: Tick[];
  /** 極の位置。既定は (0, 0)。 */
  center?: XY;
};

type ContourPlotProps = {
  /** 描画窓の横範囲。 */
  xMin: number;
  xMax: number;
  /** 描画窓の縦範囲。 */
  yMin: number;
  yMax: number;
  /** 等高線の組。関数ごとに 1 組を渡す。 */
  contours?: ContourSet[];
  /** 塗りつぶす領域。配列の順に奥から描く。 */
  regions?: Region[];
  /** 陽関数 $y=f(x)$ の曲線。 */
  curves?: Curve[];
  /** 媒介変数曲線。 */
  parametrics?: ParametricCurve[];
  /** 矢印（有向線分）。 */
  vectors?: Vector[];
  /** 平面上に置く点。 */
  points?: Point[];
  /** 長方形の分割の格子。 */
  partition?: Partition;
  /** 補助線分。 */
  segments?: Segment[];
  /** 極座標の格子。 */
  polarGrid?: PolarGrid;
  /** x 軸の目盛り。省略時は整数位置に自動で振る。空配列で目盛りなし。 */
  xTicks?: Tick[];
  /** y 軸の目盛り。省略時は整数位置に自動で振る。空配列で目盛りなし。 */
  yTicks?: Tick[];
  /** x 軸の名前（LaTeX）。既定は "x"。 */
  xLabel?: string;
  /** y 軸の名前（LaTeX）。既定は "y"。 */
  yLabel?: string;
  /** 横縦で 1 単位の長さをそろえるか。既定 true（円が円に見える）。 */
  equalScale?: boolean;
  /** 目盛りに沿った格子線を描くか。既定 true。 */
  grid?: boolean;
  /** 軸（矢印・目盛り・軸名）を描くか。既定 true。 */
  axes?: boolean;
  /** 図の幅（viewBox 幅）。表示の最大幅（px）もこの値にし、表示倍率を 1.0 に保つ。既定 320。 */
  width?: number;
  /**
   * 図の高さ（viewBox 高さ）。省略時は、equalScale なら描画窓の縦横比から決め、そうでなければ
   * 280 とする。
   */
  height?: number;
  /** 凡例を描くか。既定は "auto"（ラベル付きの曲線と legendLabel 付きの等高線を下に並べる）。 */
  legend?: "auto" | "none";
  /** 支援技術が読み上げるアクセシブルな説明。 */
  ariaLabel: string;
};

// 軸・グリッドは global.css の CSS 変数でテーマに追従する（暗テーマで沈める）。
const AXIS = "var(--fig-axis)";
const GRID = "var(--fig-grid)";
const CURVE = "#3b82f6";
const HIGHLIGHT = "#f59e0b";
// 矢印の既定色。等高線（青の濃淡）・強調点（琥珀色）と見分けられる色相にする。
const VECTOR = "#ec4899";
// 塗りの不透明度は、面積図・リーマン和の図と同じテーマ変数を使う。暗テーマでは塗りが沈むため
// 値を上げてある。
const FILL_OPACITY = "var(--fig-highlight-fill-opacity)";
// 分割の格子の内側の線は、外周より淡くして、長方形全体の輪郭と見分けやすくする。
const PARTITION_INNER_OPACITY = 0.6;

// 描画領域。FunctionGraph と同じ幅・余白にし、図をまたいで字の大きさをそろえる。
const DEFAULT_W = 320;
const DEFAULT_H = 280;
const PAD = 28; // 軸ラベルと目盛り数字を収める余白。
// equalScale で高さを自動で決めるとき、縦長の窓で図が縦へ伸びすぎないよう上限を付ける。
const MAX_AUTO_PLOT_H = 360;

// 曲線・境界の標本数。多いほど滑らかになるが SVG が重くなる。
const SAMPLES = 480;
const PARAM_SAMPLES = 240;

// ベクトルの矢じり。長さ（線方向）と半幅（直交方向）を px で与える。FunctionGraph と同じ。
const HEAD_LEN = 9;
const HEAD_HALF = 3.6;

// 領域のラベルを置く候補の、基準点（重心または labelAt）からのずれ（px）。近い順に並べ、同点なら
// 前の候補を選ぶ。斜めのずれを真横のずれより先に試す。重心が軸の上に来たとき、真横へずらすと
// ラベルが同じ高さの目盛り数字と軸をはさんで並び、1 続きの式に見えるためである。
const REGION_LABEL_OFFSETS: [number, number][] = [
  [0, 0],
  [0, -14],
  [0, 14],
  [-20, -14],
  [20, -14],
  [-20, 14],
  [20, 14],
  [-20, 0],
  [20, 0],
  [0, -28],
  [0, 28],
  [-36, 0],
  [36, 0],
];

// 等高線を求める格子のセルの幅（px）。marching squares 法は、等高線どうしが交わる点（鞍点）が
// セルの内側や辺の上に来ると、その点の近くで最大 1 セルぶん角を切った折れ線になる。セルを
// 0.5px まで細かくして、角の切れを表示上見えない大きさに抑える。
const CONTOUR_CELL_PX = 0.5;
// 等高線の折れ線を間引くときの許容誤差（px）。
const SIMPLIFY_PX = 0.15;

// 等高線のラベル。目盛り数字と同じ大きさにし、線の数が多くても図が文字で埋まらないようにする。
const CONTOUR_FONT = 11;
const CONTOUR_LABEL_H = 13;
// 等高線を切り抜く幅の左右の余白（px）。ラベルの両端と線の切れ目の間にすきまを残す。
const CONTOUR_GAP_PAD = 2;

export default function ContourPlot({
  xMin,
  xMax,
  yMin,
  yMax,
  contours = [],
  regions = [],
  curves = [],
  parametrics = [],
  vectors = [],
  points = [],
  partition,
  segments = [],
  polarGrid,
  xTicks,
  yTicks,
  xLabel = "x",
  yLabel = "y",
  equalScale = true,
  grid = true,
  axes = true,
  width = DEFAULT_W,
  height,
  legend = "auto",
  ariaLabel,
}: ContourPlotProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const arrow = `cpArrow-${uid}`;
  const clip = `cpClip-${uid}`;
  const mask = `cpMask-${uid}`;

  const xr = xMax - xMin;
  const yr = yMax - yMin;
  const { viewW, viewH, originX, originY, plotW, plotH } = layoutOf(
    width,
    height,
    xr,
    yr,
    equalScale,
  );

  const x = scaleLinear<number>({ domain: [xMin, xMax], range: [originX, originX + plotW] });
  // SVG は下向きが正のため反転する。
  const y = scaleLinear<number>({ domain: [yMin, yMax], range: [originY + plotH, originY] });
  const toScreen = (p: XY): XY => ({ x: round2(x(p.x)), y: round2(y(p.y)) });

  // 軸の交点（数学座標の原点が窓内にあればそこ、なければ近い端に寄せる）。
  const axisX = x(clamp(0, xMin, xMax));
  const axisY = y(clamp(0, yMin, yMax));

  const xt = xTicks ?? autoTicks(xMin, xMax);
  const yt = yTicks ?? autoTicks(yMin, yMax);

  // 描画窓を上下左右へ半分ずつ広げた範囲。窓の外へ出る曲線・境界も窓の縁まで途切れずに描くため、
  // この範囲内の標本は描く側に数え、窓からはみ出した分はクリップで切る。範囲より外の値（漸近線の
  // 近くなど）は描かず、またぐ枝が直線で結ばれないようにする。
  const ext = { x0: xMin - xr / 2, x1: xMax + xr / 2, y0: yMin - yr / 2, y1: yMax + yr / 2 };
  const inExt = (p: XY): boolean =>
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    p.x >= ext.x0 &&
    p.x <= ext.x1 &&
    p.y >= ext.y0 &&
    p.y <= ext.y1;

  // ---- 等高線 ----
  // 格子の刻みは、equalScale なら横縦で共通にし、セルを画面上で正方にする。刻みは 0 と整数・
  // 半整数を格子点に含む値にそろえる（gridStep を参照）。
  const contourData = contours.map((set, si) => {
    const cells = Math.max(8, set.resolution ?? Math.round(plotW / CONTOUR_CELL_PX));
    const hx = gridStep(xr / cells);
    const hy = equalScale ? hx : gridStep(yr / Math.max(8, Math.round((cells * plotH) / plotW)));
    const g = sampleGrid(
      set.fn,
      { x0: xMin, x1: xMax, y0: yMin, y1: yMax },
      hx,
      hy,
      set.gridAnchor ?? { x: 0, y: 0 },
    );
    // 既定のパレットは高さの順に割り当てる。配列の順でなく値の大小で濃淡を決め、大きい c ほど
    // 背景との差が大きい色にする。
    const order = set.levels
      .map((lv, k) => ({ k, v: levelValue(lv) }))
      .toSorted((a, b) => a.v - b.v)
      .map((e) => e.k);
    return set.levels.map((lv, li) => {
      const value = levelValue(lv);
      // 細かい格子で求めた折れ線は頂点が密なため、見た目の変わらない範囲で間引き、SVG を軽くする。
      const lines = traceLevel(g, value).map((l) => ({
        pts: simplifyPolyline(l.pts.map(toScreen), SIMPLIFY_PX),
        closed: l.closed,
      }));
      const rank = order.indexOf(li);
      const color =
        (typeof lv === "number" ? undefined : lv.color) ??
        set.color ??
        paletteColor(rank, set.levels.length);
      const label =
        set.labels === false
          ? undefined
          : typeof lv === "number" || lv.label === undefined
            ? `${set.labelVar ?? "c"}=${formatNum(value)}`
            : lv.label;
      return { id: `c${si}-${li}`, lines, color, label: label === "" ? undefined : label };
    });
  });

  // ---- 曲線 ----
  const curveSamples = curves.map((c) => {
    const [lo, hi] = c.domain ?? [xMin, xMax];
    const out: Sample[] = [];
    for (let i = 0; i <= SAMPLES; i += 1) {
      const xv = lo + ((hi - lo) * i) / SAMPLES;
      const p = { x: xv, y: c.fn(xv) };
      out.push({ ...toScreen(inExt(p) ? p : { x: xv, y: 0 }), ok: inExt(p), t: xv });
    }
    return out;
  });
  const paramSamples = parametrics.map((pc) => {
    // 公開 props の samples に 0 や負数が来ても 0 除算で NaN にならないよう、最低 1 に丸める。
    const n = Math.max(1, pc.samples ?? PARAM_SAMPLES);
    const out: Sample[] = [];
    for (let i = 0; i <= n; i += 1) {
      const t = pc.tMin + ((pc.tMax - pc.tMin) * i) / n;
      const p = pc.fn(t);
      out.push({ ...toScreen(inExt(p) ? p : { x: 0, y: 0 }), ok: inExt(p), t });
    }
    return out;
  });

  // ---- 領域 ----
  const regionData = regions.map((r) => {
    const geom = regionGeometry(r, ext);
    const at = r.labelAt ?? clippedCentroid(geom.fill, { x0: xMin, x1: xMax, y0: yMin, y1: yMax });
    return {
      fill: geom.fill.map(toScreen),
      edges: geom.edges.map((e) => e.map(toScreen)),
      labelAt: at === null ? null : toScreen(at),
    };
  });

  // ---- 分割の格子 ----
  const partitionData =
    partition === undefined ? null : partitionGeometry(partition, toScreen, x, y);

  // ---- 矢印 ----
  const vectorData = vectors.map((v) => {
    const to = "to" in v ? v.to : { x: v.from.x + v.delta.x, y: v.from.y + v.delta.y };
    return { from: toScreen(v.from), to: toScreen(to) };
  });

  // ---- 極座標の格子 ----
  const polar =
    polarGrid === undefined
      ? null
      : (() => {
          const c = polarGrid.center ?? { x: 0, y: 0 };
          const radii = polarGrid.radii ?? [];
          const rMax = radii.length > 0 ? Math.max(...radii) : Math.max(xr, yr);
          const center = toScreen(c);
          return {
            center,
            // equalScale でない図でも極座標の円が窓の縮尺どおりになるよう、楕円として描く。
            circles: radii.map((r) => ({ rx: Math.abs(x(r) - x(0)), ry: Math.abs(y(r) - y(0)) })),
            rays: (polarGrid.angles ?? []).map((a) => {
              const th = tickValue(a);
              const end = toScreen({ x: c.x + rMax * Math.cos(th), y: c.y + rMax * Math.sin(th) });
              const dir = { x: Math.cos(th), y: -Math.sin(th) }; // 画面座標の向き（y は下向き）。
              const label = typeof a === "number" ? undefined : a.label;
              return { end, dir, label };
            }),
          };
        })();

  // ---- ラベルの自動配置 ----
  // 候補位置を採点し、最も衝突の少ない位置を選ぶ。ビルド時に一度だけ走る。障害物は、軸・目盛り
  // 数字・点の印（矩形）と、等高線・曲線・境界・矢印などの線（折れ線）である。
  const viewBounds: Box = { x0: 2, x1: viewW - 2, y0: 2, y1: viewH - 2 };
  const plotBounds: Box = {
    x0: originX + 1,
    x1: originX + plotW - 1,
    y0: originY + 1,
    y1: originY + plotH - 1,
  };
  const boxObstacles: { box: Box; weight: number }[] = [];
  const lineObstacles: LineObstacle[] = [];
  const placed: Box[] = [];
  const addLine = (id: string, pts: XY[], weight: number) => {
    if (pts.length >= 2) lineObstacles.push({ id, pts, weight, bbox: bboxOf(pts) });
  };

  if (axes) {
    for (const t of yt) {
      const ty = y(tickValue(t));
      boxObstacles.push({
        box: { x0: axisX - 24, x1: axisX - 4, y0: ty - 7, y1: ty + 7 },
        weight: 8,
      });
    }
    for (const t of xt) {
      const tx = x(tickValue(t));
      boxObstacles.push({
        box: { x0: tx - 9, x1: tx + 9, y0: axisY + 6, y1: axisY + 20 },
        weight: 8,
      });
    }
    boxObstacles.push(
      {
        box: { x0: axisX - 1.5, x1: axisX + 1.5, y0: originY, y1: originY + plotH },
        weight: 6,
      },
      {
        box: { x0: originX, x1: originX + plotW, y0: axisY - 1.5, y1: axisY + 1.5 },
        weight: 6,
      },
    );
  }
  if (axes) {
    // 軸名（x・y）。描く位置は下の軸名の KatexLabel と同じである。
    const xl = originX + plotW + 14;
    const yl = axisX + 8;
    boxObstacles.push(
      { box: { x0: xl - 8, x1: xl + 8, y0: axisY - 19, y1: axisY - 3 }, weight: 8 },
      { box: { x0: yl, x1: yl + 16, y0: originY - 17, y1: originY - 1 }, weight: 8 },
    );
  }
  for (const p of points) {
    const px = x(p.x);
    const py = y(p.y);
    boxObstacles.push({ box: { x0: px - 5, x1: px + 5, y0: py - 5, y1: py + 5 }, weight: 12 });
  }
  for (const s of partitionData?.samples ?? []) {
    boxObstacles.push({ box: { x0: s.x - 4, x1: s.x + 4, y0: s.y - 4, y1: s.y + 4 }, weight: 8 });
  }
  contourData.forEach((levels) => {
    for (const lv of levels) for (const l of lv.lines) addLine(lv.id, l.pts, 6);
  });
  curveSamples.forEach((s, i) => {
    for (const piece of visiblePieces(s)) addLine(`cv${i}`, piece, 6);
  });
  paramSamples.forEach((s, i) => {
    for (const piece of visiblePieces(s)) addLine(`pm${i}`, piece, 6);
  });
  regionData.forEach((r, i) => {
    if ((regions[i].boundary ?? "solid") === "none") return;
    for (const e of r.edges) addLine(`rg${i}`, e, 3);
  });
  vectorData.forEach((v, i) => addLine(`vc${i}`, [v.from, v.to], 6));
  segments.forEach((s, i) => addLine(`sg${i}`, [toScreen(s.from), toScreen(s.to)], 3));
  if (partitionData !== null) {
    for (const l of partitionData.lines) addLine("pt", l.pts, l.outer ? 3 : 1);
  }
  if (polar !== null) {
    for (const ray of polar.rays) addLine("pl", [polar.center, ray.end], 1);
  }

  const penaltyOf = (b: Box, exclude: string | undefined, bounds: Box): number => {
    let p = 0;
    if (b.x0 < bounds.x0 || b.x1 > bounds.x1 || b.y0 < bounds.y0 || b.y1 > bounds.y1) p += 1000;
    // 目盛り数字・軸名・点の印・既出のラベルとは、重なりに加えて接するほどの近さも軽く罰し、
    // 隣り合う文字が 1 続きの式に見える（c=4 と目盛り 2 が「c=4 2」に見えるなど）のを避ける。
    const near = inflate(b, LABEL_SPACING);
    for (const o of boxObstacles) {
      if (boxesOverlap(b, o.box)) p += o.weight;
      else if (boxesOverlap(near, o.box)) p += 2;
    }
    for (const q of placed) {
      if (boxesOverlap(b, q)) p += 10;
      else if (boxesOverlap(near, q)) p += 2;
    }
    // 線との判定は矩形を少し広げて行い、ラベルの字形と線の間にすきまを残す。
    const padded = inflate(b, LINE_CLEARANCE);
    for (const l of lineObstacles) {
      if (l.id !== exclude && boxesOverlap(padded, l.bbox) && polylineHitsBox(l.pts, padded)) {
        p += l.weight;
      }
    }
    return p;
  };
  // 候補から最も罰点の小さい位置を選び、占有矩形を記録する。同点なら前方の候補を優先する。
  const choosePlacement = (cands: LabelPos[], w: number, exclude?: string): LabelPos | null => {
    let best: LabelPos | null = null;
    let bestP = Infinity;
    for (const [i, cand] of cands.entries()) {
      const p = penaltyOf(boxFor(cand, w), exclude, viewBounds) + i * 0.1;
      if (p < bestP) {
        bestP = p;
        best = cand;
      }
    }
    if (best !== null) placed.push(boxFor(best, w));
    return best;
  };

  // 領域のラベル。重心（または labelAt）を中心に周囲の候補を試し、軸・目盛り数字・線と重ならず、
  // 中心が領域の内側に残る位置を選ぶ。重心は原点や軸の上に来やすい（原点中心の円板など）ため、
  // 重心に固定すると軸線がラベルを貫く。他のラベルより先に置き、他のラベルがこれを避けるようにする。
  const regionLabels = regionData.map((r, i) => {
    const tex = regions[i].label;
    if (tex === undefined || r.labelAt === null) return null;
    const anchor = r.labelAt;
    const w = estimateTexWidthPrecise(tex, 12);
    let best: LabelPos | null = null;
    let bestP = Infinity;
    for (const [k, [dx, dy]] of REGION_LABEL_OFFSETS.entries()) {
      const cand: LabelPos = { x: anchor.x + dx, y: anchor.y + dy, align: "center" };
      let p = penaltyOf(boxFor(cand, w), undefined, plotBounds) + k * 0.1;
      if (!pointInPolygon(cand, r.fill)) p += 1000;
      if (p < bestP) {
        bestP = p;
        best = cand;
      }
    }
    if (best === null) return null;
    placed.push(boxFor(best, w));
    return { tex, pos: best };
  });
  const polarLabels = (polar?.rays ?? []).map((ray) => {
    if (ray.label === undefined) return null;
    const w = estimateTexWidthPrecise(ray.label, 12);
    // 半直線の延長上へ、ラベル矩形が円に触れない距離だけ離す。
    const off = normalLabelOffset(ray.dir.x, ray.dir.y, w);
    const pos: LabelPos = {
      x: ray.end.x + ray.dir.x * off,
      y: ray.end.y + ray.dir.y * off,
      align: "center",
    };
    placed.push(boxFor(pos, w));
    return { tex: ray.label, pos };
  });

  // 点のラベル。点の周囲 8 方向の候補から選ぶ（FunctionGraph と同じ候補）。
  const pointLabels = points.map((p) => {
    if (p.label === undefined) return null;
    const px = x(p.x);
    const py = y(p.y);
    const cands: Record<LabelDir, LabelPos> = {
      above: { x: px, y: py - 13, align: "center" },
      below: { x: px, y: py + 16, align: "center" },
      "above-right": { x: px + 9, y: py - 12, align: "left" },
      "below-right": { x: px + 9, y: py + 14, align: "left" },
      "above-left": { x: px - 9, y: py - 12, align: "right" },
      "below-left": { x: px - 9, y: py + 14, align: "right" },
      right: { x: px + 12, y: py + 1, align: "left" },
      left: { x: px - 12, y: py + 1, align: "right" },
    };
    const pos = choosePlacement(
      p.labelDir === undefined ? Object.values(cands) : [cands[p.labelDir]],
      estimateTexWidthPrecise(p.label, 12),
    );
    return pos === null ? null : { tex: p.label, pos };
  });

  // 分割の小長方形のラベル。小長方形の中心を優先し、代表点と重なるときは上下へ逃がす。逃がす量は、
  // ラベルの半分の高さと代表点の印の半径を足した距離より大きくとる。
  const cellLabels = (partitionData?.highlights ?? []).map((h) => {
    if (h.label === undefined) return null;
    const pos = choosePlacement(
      [
        { x: h.cx, y: h.cy, align: "center" },
        { x: h.cx, y: h.cy - 13, align: "center" },
        { x: h.cx, y: h.cy + 13, align: "center" },
      ],
      estimateTexWidthPrecise(h.label, 12),
    );
    return pos === null ? null : { tex: h.label, pos };
  });

  // 矢印のラベル。中点から線に直交する両側を優先し、続いて終点の先・終点の斜め先・終点の横、
  // 始点の手前の順に候補にする。勾配の矢印のように等高線の間を短い矢印が横切る図では、中点の
  // 横が隣の等高線にかかりやすく、空いている側が矢印ごとに異なるためである。
  const vectorLabels = vectors.map((v, i) => {
    if (v.label === undefined) return null;
    const { from, to } = vectorData[i];
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const dir = { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
    const perp = { x: -dir.y, y: dir.x };
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const w = estimateTexWidthPrecise(v.label, 12);
    const side = normalLabelOffset(perp.x, perp.y, w);
    const along = normalLabelOffset(dir.x, dir.y, w);
    const at = (base: XY, a: number, p: number): LabelPos => ({
      x: base.x + dir.x * a + perp.x * p,
      y: base.y + dir.y * a + perp.y * p,
      align: "center",
    });
    const diag = Math.SQRT1_2;
    const pos = choosePlacement(
      v.labelAt === undefined
        ? [
            at(mid, 0, side),
            at(mid, 0, -side),
            at(to, along, 0),
            at(to, along * diag, side * diag),
            at(to, along * diag, -side * diag),
            at(to, 0, side),
            at(to, 0, -side),
            at(from, -along, 0),
            at(from, -along * diag, side * diag),
            at(from, -along * diag, -side * diag),
          ]
        : [{ ...toScreen(v.labelAt), align: "center" }],
      w,
      `vc${i}`,
    );
    return pos === null ? null : { tex: v.label, pos };
  });

  // 補助線分のラベル。中点から線分に直交する両側を候補にする（FunctionGraph と同じ方式）。
  const segmentLabels = segments.map((s, i) => {
    if (s.label === undefined) return null;
    const a = toScreen(s.from);
    const b = toScreen(s.to);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const perp = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const w = estimateTexWidthPrecise(s.label, 12);
    const off = normalLabelOffset(perp.x, perp.y, w);
    const pos = choosePlacement(
      s.labelAt === undefined
        ? [
            { x: mid.x + perp.x * off, y: mid.y + perp.y * off, align: "center" },
            { x: mid.x - perp.x * off, y: mid.y - perp.y * off, align: "center" },
          ]
        : [{ ...toScreen(s.labelAt), align: "center" }],
      w,
      `sg${i}`,
    );
    return pos === null ? null : { tex: s.label, pos };
  });

  // 曲線のそばに置くラベル。曲線に沿った各位置で、線の両側へ離した候補を採点する。labelAt が
  // あればその位置の両側だけを候補にする。指定が無ければ、曲線の後半（右寄り）を少し優先し、
  // 式のラベルが曲線の終わり近くに付く慣習に合わせる。
  const inlineLabelOf = (samples: Sample[], tex: string, at: number | undefined) => {
    const w = estimateTexWidthPrecise(tex, 12);
    const visible = samples.filter(
      (s) =>
        s.ok &&
        s.x >= plotBounds.x0 &&
        s.x <= plotBounds.x1 &&
        s.y >= plotBounds.y0 &&
        s.y <= plotBounds.y1,
    );
    if (visible.length < 3) return null;
    const idxs: number[] = [];
    if (at !== undefined) {
      let k = 0;
      visible.forEach((s, i) => {
        if (Math.abs(s.t - at) < Math.abs(visible[k].t - at)) k = i;
      });
      idxs.push(k);
    } else {
      for (let i = 1; i < visible.length - 1; i += 4) idxs.push(i);
    }
    let best: LabelPos | null = null;
    let bestP = Infinity;
    for (const i of idxs) {
      const a = visible[Math.max(0, i - 2)];
      const b = visible[Math.min(visible.length - 1, i + 2)];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const perp = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
      const off = normalLabelOffset(perp.x, perp.y, w);
      const pref = at === undefined ? Math.abs(i / (visible.length - 1) - 0.8) * 1.5 : 0;
      for (const sgn of [1, -1]) {
        const cand: LabelPos = {
          x: visible[i].x + sgn * perp.x * off,
          y: visible[i].y + sgn * perp.y * off,
          align: "center",
        };
        const p = penaltyOf(boxFor(cand, w), undefined, viewBounds) + pref + (sgn === 1 ? 0 : 0.05);
        if (p < bestP) {
          bestP = p;
          best = cand;
        }
      }
    }
    if (best !== null) placed.push(boxFor(best, w));
    return best === null ? null : { tex, pos: best };
  };
  const curveLabels = curves.map((c, i) =>
    c.label !== undefined && c.labelPlacement === "inline"
      ? inlineLabelOf(curveSamples[i], c.label, c.labelAt)
      : null,
  );
  const paramLabels = parametrics.map((pc, i) =>
    pc.label !== undefined && pc.labelPlacement === "inline"
      ? inlineLabelOf(paramSamples[i], pc.label, pc.labelAt)
      : null,
  );

  // 等高線のラベル。線の上の位置を弧長に沿って候補にし、軸・目盛り・他の線・既出ラベルとの
  // 衝突、線の曲がり具合（急に曲がる位置ではラベルの外へ線がはみ出す）を罰点にして選ぶ。
  // 開いた線（窓の縁から縁へ渡る線）は中ほどを、閉じた線（円など）は右上を少し優先し、
  // 同心の等高線のラベルが斜めにそろいやすくする。収まる位置が無い短い線にはラベルを付けない。
  const contourLabels: { tex: string; pos: LabelPos; box: Box }[] = [];
  contourData.forEach((levels) => {
    for (const lv of levels) {
      if (lv.label === undefined) continue;
      const w = estimateTexWidthPrecise(lv.label, CONTOUR_FONT) + 2 * CONTOUR_GAP_PAD;
      const h = CONTOUR_LABEL_H;
      let best: { pos: LabelPos; box: Box } | null = null;
      let bestP = Infinity;
      const cums = lv.lines.map((l) => cumulativeLength(l.pts));
      // ラベルが乗る線のうち、ラベルの中心から弧長でこの範囲にある部分は、ラベルが当然重なる
      // 部分として当たり判定から外す。範囲の外で同じ高さの線が矩形に入れば（交わる 2 本の
      // 等高線のもう一方など）、他の線と同じく罰点にする。
      const ownWindow = Math.hypot(w, h) / 2 + 2;
      for (const [li, line] of lv.lines.entries()) {
        const cum = cums[li];
        const total = cum[cum.length - 1];
        if (total < w + 8) continue;
        const centroid = line.closed ? meanOf(line.pts) : null;
        const margin = line.closed ? 0 : w / 2 + 2;
        for (let s = margin; s <= total - margin; s += 4) {
          const p = pointAtLength(line.pts, cum, s, line.closed);
          const box: Box = { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y - h / 2, y1: p.y + h / 2 };
          let pen = penaltyOf(box, lv.id, plotBounds);
          if (pen >= bestP) continue;
          const padded = inflate(box, LINE_CLEARANCE);
          const ownHit = lv.lines.some((other, oi) =>
            oi === li
              ? farPartHitsBox(other.pts, cum, s, ownWindow, line.closed, padded)
              : polylineHitsBox(other.pts, padded),
          );
          if (ownHit) pen += 6;
          const pa = pointAtLength(line.pts, cum, s - w / 2, line.closed);
          const pb = pointAtLength(line.pts, cum, s + w / 2, line.closed);
          pen += turnAngle(pa, p, pb) * 3;
          if (centroid === null) {
            pen += Math.abs(s / total - 0.5) * 2;
          } else {
            const phi = Math.atan2(centroid.y - p.y, p.x - centroid.x);
            pen += 1 - Math.cos(phi - Math.PI / 4);
          }
          if (pen < bestP) {
            bestP = pen;
            best = { pos: { x: p.x, y: p.y, align: "center" }, box };
          }
        }
      }
      if (best !== null && bestP < 1000) {
        placed.push(best.box);
        contourLabels.push({ tex: lv.label, pos: best.pos, box: best.box });
      }
    }
  });

  // ---- 凡例 ----
  const legendItems: LegendEntry[] =
    legend === "none"
      ? []
      : [
          ...contours.flatMap((set) =>
            set.legendLabel === undefined
              ? []
              : [
                  {
                    label: set.legendLabel,
                    color: set.color ?? paletteColor(1, 2),
                    dashed: set.dashed ?? false,
                  },
                ],
          ),
          ...curves.flatMap((c) =>
            c.label === undefined || c.labelPlacement === "inline"
              ? []
              : [{ label: c.label, color: c.color ?? CURVE, dashed: c.dashed ?? false }],
          ),
          ...parametrics.flatMap((pc) =>
            pc.label === undefined || pc.labelPlacement === "inline"
              ? []
              : [{ label: pc.label, color: pc.color ?? CURVE, dashed: pc.dashed ?? false }],
          ),
        ];

  const allLabels = [
    ...regionLabels,
    ...polarLabels,
    ...cellLabels,
    ...segmentLabels,
    ...curveLabels,
    ...paramLabels,
    ...vectorLabels,
    ...pointLabels,
  ].filter((l): l is { tex: string; pos: LabelPos } => l !== null);

  return (
    <div className="contour-plot-figure" style={{ maxWidth: `${viewW}px` }}>
      <svg
        className="contour-plot"
        viewBox={`0 0 ${viewW} ${viewH}`}
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
          {/* 曲線・領域・等高線をプロット矩形でクリップする。 */}
          <RectClipPath id={clip} x={originX} y={originY} width={plotW} height={plotH} />
          {/* 等高線のラベルの下だけ線を切り抜くマスク。白の部分を描き、黒の矩形の部分を消す。
              背景色の矩形を上に重ねる方式と違い、領域の塗りの上でも塗りを隠さない。 */}
          {contourLabels.length > 0 && (
            <mask id={mask} maskUnits="userSpaceOnUse" x={0} y={0} width={viewW} height={viewH}>
              <rect x={0} y={0} width={viewW} height={viewH} fill="#fff" />
              {contourLabels.map((l, i) => (
                <rect
                  key={`mk-${i}`}
                  x={l.box.x0}
                  y={l.box.y0}
                  width={l.box.x1 - l.box.x0}
                  height={l.box.y1 - l.box.y0}
                  rx={3}
                  fill="#000"
                />
              ))}
            </mask>
          )}
        </defs>

        {/* 目盛りに沿った格子線。@visx/grid の GridColumns・GridRows で描く。 */}
        {grid && (
          <>
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
          </>
        )}

        <Group clipPath={`url(#${clip})`}>
          {/* 極座標の格子。軸と同じ淡い色の細線で描き、主役の曲線・領域より沈める。 */}
          {polar !== null && (
            <g fill="none" stroke={AXIS} strokeWidth={1}>
              {polar.circles.map((c, i) => (
                <ellipse
                  key={`pc-${i}`}
                  cx={polar.center.x}
                  cy={polar.center.y}
                  rx={c.rx}
                  ry={c.ry}
                />
              ))}
              {polar.rays.map((r, i) => (
                <Line key={`pr-${i}`} from={polar.center} to={r.end} />
              ))}
            </g>
          )}

          {/* 領域の塗り。配列の順に奥から重ねる。自己交差する境界でも塗りが欠けないよう、
              塗りの規則は evenodd にする。 */}
          {regions.map((r, i) => (
            <Polygon
              key={`rf-${i}`}
              points={regionData[i].fill.map((p): [number, number] => [p.x, p.y])}
              fill={r.color ?? CURVE}
              fillRule="evenodd"
              stroke="none"
              style={{ fillOpacity: r.opacity ?? FILL_OPACITY }}
            />
          ))}

          {/* 分割の格子の塗り（長方形全体と、強調する小長方形）。格子線は軸より前面に描く。 */}
          {partitionData !== null && partition !== undefined && (
            <g>
              {partition.fill === true && (
                <rect
                  x={partitionData.outer.x0}
                  y={partitionData.outer.y0}
                  width={partitionData.outer.x1 - partitionData.outer.x0}
                  height={partitionData.outer.y1 - partitionData.outer.y0}
                  fill={partition.color ?? CURVE}
                  style={{ fillOpacity: FILL_OPACITY }}
                />
              )}
              {partitionData.highlights.map((h, i) => (
                <rect
                  key={`ph-${i}`}
                  x={h.box.x0}
                  y={h.box.y0}
                  width={h.box.x1 - h.box.x0}
                  height={h.box.y1 - h.box.y0}
                  fill={HIGHLIGHT}
                  style={{ fillOpacity: FILL_OPACITY }}
                />
              ))}
            </g>
          )}
        </Group>

        {/* 軸。両端に矢印を付ける。 */}
        {axes && (
          <>
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
            {/* 軸名。位置は FunctionGraph と同じ（y 軸名は軸の右上、x 軸名は目盛り数字の右外）。 */}
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
          </>
        )}

        {/* 境界・格子線・等高線・曲線。軸より前面に描き、軸と重なる線（xy=0 の等高線、
            半平面 y>0 の破線の境界、分割の外周の辺など）も軸線に隠れないようにする。
            等高線のラベルの位置はマスクで切り抜く。 */}
        <Group clipPath={`url(#${clip})`}>
          {/* 領域の境界。実線は境界を含む、破線は含まないことを表す。 */}
          {regions.map((r, i) => {
            const boundary = r.boundary ?? "solid";
            if (boundary === "none") return null;
            return (
              <g key={`rb-${i}`}>
                {regionData[i].edges.map((e, k) => (
                  <LinePath<XY>
                    key={`re-${k}`}
                    data={e}
                    x={(d) => d.x}
                    y={(d) => d.y}
                    fill="none"
                    stroke={r.boundaryColor ?? r.color ?? CURVE}
                    strokeWidth={1.6}
                    strokeDasharray={boundary === "dashed" ? "5 4" : undefined}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
              </g>
            );
          })}

          {/* 分割の格子線。内側の細線、外周の順に重ねる。 */}
          {partitionData !== null &&
            partition !== undefined &&
            partitionData.lines.map((l, i) => (
              <Line
                key={`pl-${i}`}
                from={l.pts[0]}
                to={l.pts[1]}
                stroke={partition.color ?? CURVE}
                strokeWidth={l.outer ? 1.6 : 1}
                strokeOpacity={l.outer ? 1 : PARTITION_INNER_OPACITY}
                strokeLinecap="square"
              />
            ))}

          <g mask={contourLabels.length > 0 ? `url(#${mask})` : undefined}>
            {contourData.map((levels, si) =>
              levels.map((lv, li) =>
                lv.lines.map((l, k) => (
                  <LinePath<XY>
                    key={`ct-${si}-${li}-${k}`}
                    data={l.pts}
                    x={(d) => d.x}
                    y={(d) => d.y}
                    fill="none"
                    strokeWidth={1.6}
                    strokeDasharray={contours[si].dashed ? "5 4" : undefined}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    // 既定のパレットは CSS の color-mix で作るため、プレゼンテーション属性でなく
                    // style で渡す。
                    style={{ stroke: lv.color }}
                  />
                )),
              ),
            )}
          </g>

          {/* 曲線。 */}
          {curves.map((c, i) => (
            <LinePath<Sample>
              key={`cv-${i}`}
              data={curveSamples[i]}
              x={(d) => d.x}
              y={(d) => d.y}
              defined={(d) => d.ok}
              fill="none"
              stroke={c.color ?? CURVE}
              strokeWidth={2}
              strokeDasharray={c.dashed ? "5 4" : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {parametrics.map((pc, i) => (
            <LinePath<Sample>
              key={`pm-${i}`}
              data={paramSamples[i]}
              x={(d) => d.x}
              y={(d) => d.y}
              defined={(d) => d.ok}
              fill="none"
              stroke={pc.color ?? CURVE}
              strokeWidth={2}
              strokeDasharray={pc.dashed ? "5 4" : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {/* 補助線分。 */}
          {segments.map((s, i) => (
            <Line
              key={`sg-${i}`}
              from={toScreen(s.from)}
              to={toScreen(s.to)}
              stroke={s.color ?? HIGHLIGHT}
              strokeWidth={1.6}
              strokeDasharray={s.dashed === false ? undefined : "5 4"}
              strokeLinecap="round"
            />
          ))}
        </Group>

        {/* 矢印。クリップせず、点と同程度に前面へ描く。矢じりは polygon を手計算で置き、色を
            動的に変えられるようにする（FunctionGraph と同じ描き方）。 */}
        {vectors.map((v, i) => {
          const color = v.color ?? VECTOR;
          const { from, to } = vectorData[i];
          const ang = Math.atan2(to.y - from.y, to.x - from.x);
          const cos = Math.cos(ang);
          const sin = Math.sin(ang);
          // 矢じり長はベクトルの画面上の長さを超えないよう上限を付け、短い矢印でも形を保つ。
          const vlen = Math.hypot(to.x - from.x, to.y - from.y);
          const hl = Math.min(HEAD_LEN, vlen * 0.8);
          const hh = HEAD_HALF * (hl / HEAD_LEN);
          // 矢じりの根元まで線を引き、矢じりと線を重ねない。
          const base = { x: to.x - hl * cos, y: to.y - hl * sin };
          const left = { x: base.x - hh * sin, y: base.y + hh * cos };
          const right = { x: base.x + hh * sin, y: base.y - hh * cos };
          return (
            <g key={`vc-${i}`}>
              <Line
                from={from}
                to={base}
                stroke={color}
                strokeWidth={2}
                strokeDasharray={v.dashed ? "5 4" : undefined}
                strokeLinecap="round"
              />
              <polygon
                points={`${to.x},${to.y} ${left.x},${left.y} ${right.x},${right.y}`}
                fill={color}
              />
            </g>
          );
        })}

        {/* 分割の小長方形の代表点。 */}
        {(partitionData?.samples ?? []).map((s, i) => (
          <Circle key={`ps-${i}`} cx={s.x} cy={s.y} r={2.8} fill="currentColor" />
        ))}

        {/* 点。白抜きの点は背景色で塗り抜き、その点を含まないことを表す。 */}
        {points.map((p, i) => {
          const px = x(p.x);
          const py = y(p.y);
          const color = p.color ?? (p.highlight ? HIGHLIGHT : "currentColor");
          return p.open ? (
            <Circle
              key={`pt-${i}`}
              cx={px}
              cy={py}
              r={4}
              fill="var(--sl-color-bg, #fff)"
              stroke={color}
              strokeWidth={1.8}
            />
          ) : (
            <Circle key={`pt-${i}`} cx={px} cy={py} r={4} fill={color} />
          );
        })}

        {/* 等高線のラベル。線の切れ目に置く。 */}
        {contourLabels.map((l, i) => (
          <KatexLabel
            key={`cl-${i}`}
            tex={l.tex}
            x={l.pos.x}
            y={l.pos.y}
            fontSize={CONTOUR_FONT}
            className="fig-tick-label"
          />
        ))}

        {/* 領域・点・矢印などのラベル。線や塗りと重なっても読めるよう、背景色のハローを敷く。 */}
        {allLabels.map((l, i) => (
          <KatexLabel
            key={`lb-${i}`}
            tex={l.tex}
            x={l.pos.x}
            y={l.pos.y}
            fontSize={12}
            align={l.pos.align}
            className="fig-tick-label"
          />
        ))}

        {/* 軸の目盛り数字。最前面に描き、背景色のハローを敷く。 */}
        {axes &&
          xt.map((t, i) => (
            <KatexLabel
              key={`txn-${i}`}
              tex={tickLabel(t)}
              x={x(tickValue(t))}
              y={axisY + 13}
              fontSize={11}
              className="fig-tick-label"
            />
          ))}
        {axes &&
          yt.map((t, i) => (
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

      {/* 凡例（色見本＋数式ラベル）。SVG の外の HTML として下に並べる。見た目と CSS は
          FunctionGraph の凡例と共有する。 */}
      {legendItems.length > 0 && (
        <div className="function-graph-legend">
          {legendItems.map((c, i) => {
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
                    strokeWidth={2}
                    strokeDasharray={c.dashed ? "5 4" : undefined}
                    style={{ stroke: c.color }}
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

// ======================================================================
// 寸法
// ======================================================================

/**
 * 図の寸法とプロット矩形を決める。equalScale のときは横縦で 1 単位の長さをそろえ、高さの指定が
 * 無ければ描画窓の縦横比から高さを決める（余白の無い図にする）。高さの指定があれば、収まる
 * 倍率に合わせて中央へ寄せる（FunctionGraph と同じ）。
 */
function layoutOf(
  width: number,
  height: number | undefined,
  xr: number,
  yr: number,
  equalScale: boolean,
): {
  viewW: number;
  viewH: number;
  originX: number;
  originY: number;
  plotW: number;
  plotH: number;
} {
  const viewW = width;
  const availW = viewW - 2 * PAD;
  if (!equalScale) {
    const viewH = height ?? DEFAULT_H;
    return { viewW, viewH, originX: PAD, originY: PAD, plotW: availW, plotH: viewH - 2 * PAD };
  }
  let unit = availW / xr;
  let viewH: number;
  if (height === undefined) {
    unit = Math.min(unit, MAX_AUTO_PLOT_H / yr);
    viewH = Math.round(unit * yr + 2 * PAD);
  } else {
    viewH = height;
    unit = Math.min(unit, (height - 2 * PAD) / yr);
  }
  const plotW = unit * xr;
  const plotH = unit * yr;
  return {
    viewW,
    viewH,
    originX: PAD + (availW - plotW) / 2,
    originY: PAD + (viewH - 2 * PAD - plotH) / 2,
    plotW,
    plotH,
  };
}

// ======================================================================
// 等高線（marching squares 法）
// ======================================================================

/** 格子の刻み。分子 num と分母 den で表し、格子点の座標を i * num / den で求める。 */
type Step = { num: number; den: number };

/**
 * 格子の刻みを、目安の幅 h 以下で、0 と整数（1 未満なら半整数も）を格子点に含む値にする。
 *
 * 等高線が格子点をちょうど通る場合（x^2-y^2=0 の原点、xy=0 の座標軸）、格子点を外れた交差は
 * 線形補間で 1 セルぶん欠け、交わる 2 直線がくびれて見える。教科書の例の交点・鞍点は 0 や整数・
 * 半整数に来ることが多いため、それらを格子点に含めて欠けを防ぐ。1 未満の刻みは 1/den
 * （den は偶数）とし、i / den で計算する。割り算で求めると、x と y で同じ i の座標が
 * 浮動小数でも完全に一致し、x^2-y^2 が対角線上でちょうど 0 になる。
 */
function gridStep(h: number): Step {
  if (h < 1) return { num: 1, den: 2 * Math.ceil(1 / (2 * h)) };
  const pow = 10 ** Math.floor(Math.log10(h));
  const nice = [5, 2, 1].map((k) => k * pow).find((v) => v <= h) ?? pow;
  return { num: nice, den: 1 };
}

/** 格子点での関数値。等高線の全レベルで共有する。fn は交点を精密化するために持つ。 */
type ScalarGrid = {
  fn: (x: number, y: number) => number;
  nx: number;
  ny: number;
  xs: number[];
  ys: number[];
  v: Float64Array;
};

/**
 * 描画窓を覆う格子で関数を標本化する。格子点は anchor から刻みの整数倍の位置に置き、窓より最大
 * 1 セル外まで広げる。等高線が窓の縁まで届き、はみ出した分はクリップで切る。
 */
function sampleGrid(
  fn: (x: number, y: number) => number,
  win: Box,
  hx: Step,
  hy: Step,
  anchor: XY,
): ScalarGrid {
  const xs = gridCoords(win.x0, win.x1, hx, anchor.x);
  const ys = gridCoords(win.y0, win.y1, hy, anchor.y);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const v = new Float64Array(xs.length * ys.length);
  for (let j = 0; j <= ny; j += 1) {
    for (let i = 0; i <= nx; i += 1) v[j * (nx + 1) + i] = fn(xs[i], ys[j]);
  }
  return { fn, nx, ny, xs, ys, v };
}

/**
 * 区間 [lo, hi] を覆う、origin から刻み h の整数倍の格子点の座標（両端は区間の外側の格子点まで
 * 広げる）。origin が 0 のときは i * num / den で求め、x と y で同じ添字の座標を完全に一致させる。
 */
function gridCoords(lo: number, hi: number, h: Step, origin: number): number[] {
  const i0 = Math.floor(((lo - origin) * h.den) / h.num);
  const i1 = Math.ceil(((hi - origin) * h.den) / h.num);
  const out: number[] = [];
  for (let i = i0; i <= i1; i += 1) out.push(origin + (i * h.num) / h.den);
  return out;
}

/** 等高線の 1 本の折れ線。closed は始点に戻る閉じた線（円など）か。 */
type ContourLine = { pts: XY[]; closed: boolean };

/**
 * 1 つの高さの等高線を、marching squares 法で折れ線の集まりとして求める。
 *
 * 値が高さ以上の格子点を「上」、未満を「下」とし、上下が入れ替わる辺に交点を置く。交点は辺の
 * 両端の値から線形補間で求める。交点にはどの辺の上か（端点ちょうどなら格子点）を表すキーを付け、
 * 隣り合うセルが同じ交点を共有する。線分はキーでつなぐため、浮動小数の比較なしに折れ線が閉じる。
 * 「以上」の判定を全体で統一し、等高線が格子点や格子線の上をちょうど通る場合（xy=0 の座標軸
 * など）も、線が重複したり欠けたりしないようにする（長さ 0 の線分と重複する線分は捨てる）。
 */
function traceLevel(g: ScalarGrid, target: number): ContourLine[] {
  const { fn, nx, ny, xs, ys, v } = g;
  const stride = nx + 1;
  const at = (i: number, j: number): number => v[j * stride + i];
  const pos = new Map<string, XY>();

  // 高さを値の幅のごく一部（1e-9 倍）だけずらして追跡する。格子点の値が高さにちょうど等しい
  // 場合（x=1 上で 0 になる (x-1)(y-0.3) の c=0 など）、格子点を上下どちらに数えても、別の
  // 等高線との交点が隣の格子点へ寄り、交差に折れが出る。ずらすと等しい格子点が無くなり、
  // 交点はすべて辺の内側に来る。ずれは描画に表れない大きさである。
  let lo = Infinity;
  let hi = -Infinity;
  for (const w of v) {
    if (Number.isFinite(w)) {
      lo = Math.min(lo, w);
      hi = Math.max(hi, w);
    }
  }
  const delta = 1e-9 * (hi > lo ? hi - lo : 1);
  const level = target + delta;

  // 格子点 (i0, j0)・(i1, j1) を結ぶ辺の上の交点のキー。辺は常に添字の小さい側から大きい側へ
  // 向けて呼び、隣のセルからも同じ交点が得られるようにする。交点は線形補間を出発点に、辺に
  // 沿って関数そのものの根を求めて精密化する（Illinois 法）。鞍点の近くでは勾配が小さく、
  // 線形補間だけでは等高線が波打ち、交わる 2 本の線がくびれて見えるためである。
  const crossing = (i0: number, j0: number, i1: number, j1: number): string => {
    const va = at(i0, j0);
    const vb = at(i1, j1);
    const t = clamp((level - va) / (vb - va), 0, 1);
    if (t === 0 || t === 1) {
      const [i, j] = t === 0 ? [i0, j0] : [i1, j1];
      const key = `n${i},${j}`;
      if (!pos.has(key)) pos.set(key, { x: xs[i], y: ys[j] });
      return key;
    }
    const key = `e${i0},${j0},${i1},${j1}`;
    if (!pos.has(key)) {
      const a = { x: xs[i0], y: ys[j0] };
      const b = { x: xs[i1], y: ys[j1] };
      const u = refineRoot((s) => fn(a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s) - level, {
        t,
        fa: va - level,
        fb: vb - level,
      });
      pos.set(key, lerpAt(a, b, u));
    }
    return key;
  };

  const segs: [string, string][] = [];
  const seen = new Set<string>();
  const addSeg = (a: string, b: string) => {
    if (a === b) return;
    const id = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(id)) return;
    seen.add(id);
    segs.push([a, b]);
  };

  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      // セルの 4 頂点。0 左下、1 右下、2 右上、3 左上。
      const v0 = at(i, j);
      const v1 = at(i + 1, j);
      const v2 = at(i + 1, j + 1);
      const v3 = at(i, j + 1);
      if (![v0, v1, v2, v3].every(Number.isFinite)) continue;
      const a0 = v0 >= level;
      const a1 = v1 >= level;
      const a2 = v2 >= level;
      const a3 = v3 >= level;
      const bottom = a0 === a1 ? null : crossing(i, j, i + 1, j);
      const right = a1 === a2 ? null : crossing(i + 1, j, i + 1, j + 1);
      const top = a3 === a2 ? null : crossing(i, j + 1, i + 1, j + 1);
      const left = a0 === a3 ? null : crossing(i, j, i, j + 1);
      const edges = [bottom, right, top, left].filter((e): e is string => e !== null);
      if (edges.length === 2) {
        addSeg(edges[0], edges[1]);
        continue;
      }
      if (bottom === null || right === null || top === null || left === null) continue;
      // 鞍点のセル（対角の 2 頂点だけが上）。セル内の双一次補間の鞍点での値で、どちらの対角を
      // つなぐかを決める（asymptotic decider）。値が元の高さにほぼ等しければ（ずらした分を
      // 許容する）、2 本の等高線がセル内で交わるため、4 つの交点をすべて鞍点へ結ぶ。
      const d = v0 - v1 + v2 - v3;
      const saddle = (v0 * v2 - v1 * v3) / d;
      const scale = Math.max(...[v0, v1, v2, v3].map((w) => Math.abs(w - level)));
      if (Math.abs(saddle - level) <= 2 * delta + 1e-9 * scale) {
        const key = `s${i},${j}`;
        const u = (v0 - v3) / d;
        const w = (v0 - v1) / d;
        pos.set(key, { x: xs[i] + (xs[i + 1] - xs[i]) * u, y: ys[j] + (ys[j + 1] - ys[j]) * w });
        for (const e of [bottom, right, top, left]) addSeg(e, key);
        continue;
      }
      // 鞍点と上下が異なる頂点を、その頂点に接する 2 辺の交点を結ぶ線分で切り離す。
      const center = saddle >= level;
      if (a0 !== center) addSeg(left, bottom);
      if (a1 !== center) addSeg(bottom, right);
      if (a2 !== center) addSeg(right, top);
      if (a3 !== center) addSeg(top, left);
    }
  }

  // 線分をキーでつなぎ、折れ線にする。まず次数が奇数の端点（窓の縁で切れる線の端）からたどり、
  // 残りを閉じた線としてたどる。交差点（次数 4）では未使用の線分を順に選ぶ。
  const adj = new Map<string, number[]>();
  segs.forEach(([a, b], k) => {
    for (const key of [a, b]) {
      const list = adj.get(key);
      if (list === undefined) adj.set(key, [k]);
      else list.push(k);
    }
  });
  const used = new Uint8Array(segs.length);
  const walk = (start: string): string[] => {
    const keys = [start];
    let cur = start;
    for (;;) {
      const next = (adj.get(cur) ?? []).find((k) => used[k] === 0);
      if (next === undefined) break;
      used[next] = 1;
      const [a, b] = segs[next];
      cur = a === cur ? b : a;
      keys.push(cur);
    }
    return keys;
  };
  const lines: ContourLine[] = [];
  const push = (keys: string[]) => {
    if (keys.length < 2) return;
    const pts = keys.map((k) => pos.get(k) ?? { x: Number.NaN, y: Number.NaN });
    lines.push({ pts, closed: keys.length > 2 && keys[0] === keys[keys.length - 1] });
  };
  for (const [key, list] of adj) {
    if (list.length % 2 === 0) continue;
    while (list.some((k) => used[k] === 0)) push(walk(key));
  }
  segs.forEach(([a], k) => {
    if (used[k] === 0) push(walk(a));
  });
  return lines;
}

/**
 * 区間 [0, 1] で符号の変わる関数 g の根を Illinois 法（はさみうち法の改良）で求める。t は線形
 * 補間による初期値、fa・fb は両端での g の値である。途中で値が有限でなくなれば初期値を返す。
 */
function refineRoot(g: (s: number) => number, init: { t: number; fa: number; fb: number }): number {
  let a = 0;
  let b = 1;
  let { fa, fb } = init;
  let t = init.t;
  let side = 0;
  for (let k = 0; k < 12 && b - a > 1e-9; k += 1) {
    const ft = g(t);
    if (!Number.isFinite(ft)) return init.t;
    if (ft === 0) return t;
    if (ft > 0 === fb > 0) {
      b = t;
      fb = ft;
      if (side === -1) fa /= 2;
      side = -1;
    } else {
      a = t;
      fa = ft;
      if (side === 1) fb /= 2;
      side = 1;
    }
    t = (a * fb - b * fa) / (fb - fa);
  }
  return clamp(t, 0, 1);
}

/** 等高線の高さの値を取り出す。 */
function levelValue(lv: ContourLevel): number {
  return typeof lv === "number" ? lv : lv.value;
}

/**
 * 既定のパレットの k 番目（n 色中）の色。単色（青）の濃淡で、高さの順に背景との差を大きくする。
 * 両端の色は global.css のテーマ変数（--contour-lo・--contour-hi）で、明・暗テーマごとに
 * 背景から判別できる範囲にとる。中間色は CSS の color-mix で両端を混ぜて作る。
 */
function paletteColor(k: number, n: number): string {
  const pct = n <= 1 ? 100 : Math.round((k / (n - 1)) * 100);
  return `color-mix(in oklab, var(--contour-hi, #1e3a8a) ${pct}%, var(--contour-lo, #60a5fa))`;
}

// ======================================================================
// 領域・格子
// ======================================================================

/** 描画窓を広げた範囲（領域の省いた側の端に使う）。 */
type Extent = { x0: number; x1: number; y0: number; y1: number };

/**
 * 領域の塗りの多角形と、描く境界の折れ線を求める（数学座標）。省いた側の端は描画窓の外
 * （ext の縁）に置き、境界線を描かない。窓の外へ出る値は ext の縁に丸め、無限大でも塗りが
 * 壊れないようにする。
 */
function regionGeometry(r: Region, ext: Extent): { fill: XY[]; edges: XY[][] } {
  switch (r.kind) {
    case "polygon": {
      const pts = r.points;
      return { fill: pts, edges: pts.length > 1 ? [[...pts, pts[0]]] : [] };
    }
    case "between-x": {
      const [a, b] = r.x ?? [ext.x0, ext.x1];
      const lowerFn = r.lower ?? (() => ext.y0);
      const upperFn = r.upper ?? (() => ext.y1);
      const lower: XY[] = [];
      const upper: XY[] = [];
      for (let i = 0; i <= SAMPLES; i += 1) {
        const xv = a + ((b - a) * i) / SAMPLES;
        lower.push({ x: xv, y: clampTo(lowerFn(xv), ext.y0, ext.y1) });
        upper.push({ x: xv, y: clampTo(upperFn(xv), ext.y0, ext.y1) });
      }
      return { fill: [...lower, ...upper.toReversed()], edges: betweenEdges(r, lower, upper) };
    }
    case "between-y": {
      const [c, d] = r.y ?? [ext.y0, ext.y1];
      const leftFn = r.left ?? (() => ext.x0);
      const rightFn = r.right ?? (() => ext.x1);
      const left: XY[] = [];
      const right: XY[] = [];
      for (let i = 0; i <= SAMPLES; i += 1) {
        const yv = c + ((d - c) * i) / SAMPLES;
        left.push({ x: clampTo(leftFn(yv), ext.x0, ext.x1), y: yv });
        right.push({ x: clampTo(rightFn(yv), ext.x0, ext.x1), y: yv });
      }
      const edges: XY[][] = [];
      if (r.left !== undefined) edges.push(left);
      if (r.right !== undefined) edges.push(right);
      if (r.y !== undefined) {
        edges.push([left[0], right[0]], [left[left.length - 1], right[right.length - 1]]);
      }
      return { fill: [...left, ...right.toReversed()], edges };
    }
    case "parametric": {
      const n = Math.max(3, r.samples ?? PARAM_SAMPLES);
      const pts: XY[] = [];
      for (let i = 0; i <= n; i += 1) {
        const p = r.fn(r.tMin + ((r.tMax - r.tMin) * i) / n);
        pts.push({ x: clampTo(p.x, ext.x0, ext.x1), y: clampTo(p.y, ext.y0, ext.y1) });
      }
      return { fill: pts, edges: [pts] };
    }
  }
  // 残る指定方法は極座標の領域である。
  const c = r.center ?? { x: 0, y: 0 };
  const [t1, t2] = r.theta;
  const [rIn, rOut] = r.r;
  const at = (rad: number, t: number): XY => ({
    x: c.x + rad * Math.cos(t),
    y: c.y + rad * Math.sin(t),
  });
  const outer: XY[] = [];
  const inner: XY[] = [];
  for (let i = 0; i <= SAMPLES; i += 1) {
    const t = t1 + ((t2 - t1) * i) / SAMPLES;
    outer.push(at(radialAt(rOut, t), t));
    inner.push(at(radialAt(rIn, t), t));
  }
  // 内側の端が 0（扇形）なら、内側の弧は極の 1 点に縮む。
  const pointInner = rIn === 0;
  const full = Math.abs(t2 - t1) >= 2 * Math.PI - 1e-9;
  const edges: XY[][] = [outer];
  if (!pointInner) edges.push(inner);
  // 一周する領域（円板・円環）には、始まりの角の継ぎ目に動径の線分を描かない。
  if (!full) edges.push([inner[0], outer[0]], [inner[SAMPLES], outer[SAMPLES]]);
  return { fill: [...outer, ...(pointInner ? [c] : inner.toReversed())], edges };
}

/** 動径の範囲の端を、角 t での値にする。 */
function radialAt(b: RadialBound, t: number): number {
  return typeof b === "number" ? b : b(t);
}

/** `between-x` の境界の折れ線。指定のある曲線と、区間の両端の縦の線分だけを返す。 */
function betweenEdges(r: BetweenXRegion, lower: XY[], upper: XY[]): XY[][] {
  const edges: XY[][] = [];
  if (r.lower !== undefined) edges.push(lower);
  if (r.upper !== undefined) edges.push(upper);
  if (r.x !== undefined) {
    const n = lower.length - 1;
    edges.push([lower[0], upper[0]], [lower[n], upper[n]]);
  }
  return edges;
}

/** 分割の格子の画面上の要素（格子線・強調する小長方形・代表点・外周）。 */
function partitionGeometry(
  p: Partition,
  toScreen: (q: XY) => XY,
  sx: (v: number) => number,
  sy: (v: number) => number,
): {
  lines: { pts: XY[]; outer: boolean }[];
  highlights: { box: Box; cx: number; cy: number; label?: string }[];
  samples: XY[];
  outer: Box;
} {
  const [a, b] = p.x;
  const [c, d] = p.y;
  const m = Math.max(1, Math.round(p.m));
  const n = Math.max(1, Math.round(p.n));
  const xk = (k: number) => a + ((b - a) * k) / m;
  const yk = (k: number) => c + ((d - c) * k) / n;
  const lines: { pts: XY[]; outer: boolean }[] = [];
  for (let k = 0; k <= m; k += 1) {
    lines.push({
      pts: [toScreen({ x: xk(k), y: c }), toScreen({ x: xk(k), y: d })],
      outer: k === 0 || k === m,
    });
  }
  for (let k = 0; k <= n; k += 1) {
    lines.push({
      pts: [toScreen({ x: a, y: yk(k) }), toScreen({ x: b, y: yk(k) })],
      outer: k === 0 || k === n,
    });
  }
  const samplePoint = (s: PartitionSample, i: number, j: number): XY => {
    if (typeof s === "function") return s(i, j);
    const fx = s === "center" ? 0.5 : s.endsWith("left") ? 0 : 1;
    const fy = s === "center" ? 0.5 : s.startsWith("lower") ? 0 : 1;
    return { x: xk(i - 1 + fx), y: yk(j - 1 + fy) };
  };
  const cellBox = (i: number, j: number): Box => ({
    x0: sx(xk(i - 1)),
    x1: sx(xk(i)),
    y0: sy(yk(j)),
    y1: sy(yk(j - 1)),
  });
  const highlights = (p.highlight ?? [])
    .filter((h) => h.i >= 1 && h.i <= m && h.j >= 1 && h.j <= n)
    .map((h) => {
      const box = cellBox(h.i, h.j);
      return { box, cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, label: h.label };
    });
  const samples: XY[] = [];
  if (p.samples !== undefined) {
    for (let j = 1; j <= n; j += 1) {
      for (let i = 1; i <= m; i += 1) samples.push(toScreen(samplePoint(p.samples, i, j)));
    }
  }
  return {
    // 外周を最後に描き、内側の線の端が外周の上に重ならないようにする。
    lines: lines.toSorted((l1, l2) => Number(l1.outer) - Number(l2.outer)),
    highlights,
    samples,
    outer: { x0: sx(a), x1: sx(b), y0: sy(d), y1: sy(c) },
  };
}

/**
 * 多角形を描画窓（凸な矩形）で切り取った図形の重心を求める（Sutherland–Hodgman 法で切り取る）。
 * 領域のラベルの既定位置に使う。窓と重ならなければ null を返す。
 */
function clippedCentroid(poly: XY[], win: Box): XY | null {
  let pts = poly;
  const edges: [(p: XY) => boolean, (p: XY, q: XY) => XY][] = [
    [(p) => p.x >= win.x0, (p, q) => lerpAt(p, q, (win.x0 - p.x) / (q.x - p.x))],
    [(p) => p.x <= win.x1, (p, q) => lerpAt(p, q, (win.x1 - p.x) / (q.x - p.x))],
    [(p) => p.y >= win.y0, (p, q) => lerpAt(p, q, (win.y0 - p.y) / (q.y - p.y))],
    [(p) => p.y <= win.y1, (p, q) => lerpAt(p, q, (win.y1 - p.y) / (q.y - p.y))],
  ];
  for (const [inside, cut] of edges) {
    const out: XY[] = [];
    pts.forEach((cur, k) => {
      const prev = pts[(k + pts.length - 1) % pts.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(cut(prev, cur));
      }
    });
    pts = out;
    if (pts.length === 0) return null;
  }
  let area = 0;
  let cx = 0;
  let cy = 0;
  pts.forEach((p, k) => {
    const q = pts[(k + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    area += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  });
  // 面積がほぼ 0（線状の図形）のときは、頂点の平均で代える。
  if (Math.abs(area) < 1e-12) return meanOf(pts);
  return { x: cx / (3 * area), y: cy / (3 * area) };
}

function lerpAt(p: XY, q: XY, t: number): XY {
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
}

function meanOf(pts: XY[]): XY {
  const n = pts.length || 1;
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / n,
    y: pts.reduce((s, p) => s + p.y, 0) / n,
  };
}

// ======================================================================
// 曲線の標本と折れ線の幾何
// ======================================================================

/** 曲線の 1 標本（画面座標）。ok は描く範囲内かつ有限か。t は元の x または媒介変数。 */
type Sample = { x: number; y: number; ok: boolean; t: number };

/** 標本列から、描く範囲内の連続した部分ごとの折れ線を取り出す（ラベル配置の障害物に使う）。 */
function visiblePieces(samples: Sample[]): XY[][] {
  const out: XY[][] = [];
  let cur: XY[] = [];
  for (const s of samples) {
    if (s.ok) cur.push({ x: s.x, y: s.y });
    else if (cur.length > 0) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * 折れ線を Ramer–Douglas–Peucker 法で間引く。始点と終点を結ぶ線分から最も離れた頂点が eps を
 * 超えれば残して両側を再帰的に調べ、超えなければ間の頂点を捨てる。閉じた線（始点と終点が同じ）
 * でも、線分の長さが 0 のときは点からの距離で測るため正しく間引ける。
 */
function simplifyPolyline(pts: XY[], eps: number): XY[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [a, b] = top;
    let maxD = -1;
    let idx = -1;
    for (let k = a + 1; k < b; k += 1) {
      const d = distanceToSegment(pts[k], pts[a], pts[b]);
      if (d > maxD) {
        maxD = d;
        idx = k;
      }
    }
    if (idx >= 0 && maxD > eps) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, k) => keep[k] === 1);
}

/** 点 p から線分 ab までの距離。 */
function distanceToSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** 折れ線の各頂点までの累積の長さ。 */
function cumulativeLength(pts: XY[]): number[] {
  const cum = [0];
  for (let k = 1; k < pts.length; k += 1) {
    cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
  }
  return cum;
}

/** 折れ線の始点から弧長 s の位置。閉じた線では s を一周の長さで巻き戻す。 */
function pointAtLength(pts: XY[], cum: number[], s: number, closed: boolean): XY {
  const total = cum[cum.length - 1];
  let t = s;
  if (closed && total > 0) t = ((s % total) + total) % total;
  t = clamp(t, 0, total);
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= t) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const u = seg > 0 ? (t - cum[lo]) / seg : 0;
  return lerpAt(pts[lo], pts[hi], u);
}

/** 3 点 a→p→b で進む向きが変わる角（ラジアン、0〜π）。 */
function turnAngle(a: XY, p: XY, b: XY): number {
  const a1 = Math.atan2(p.y - a.y, p.x - a.x);
  const a2 = Math.atan2(b.y - p.y, b.x - p.x);
  const d = Math.abs(a2 - a1) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

// ======================================================================
// ラベル配置の当たり判定
// ======================================================================

/** ラベルの配置先（中心・左端・右端の基準点と寄せ方向）。 */
type LabelPos = { x: number; y: number; align: "center" | "left" | "right" };

/** 当たり判定に使う軸並行の矩形（左上 (x0,y0)・右下 (x1,y1)）。 */
type Box = { x0: number; x1: number; y0: number; y1: number };

/** ラベル配置の障害物となる折れ線。id が同じ線（ラベル自身の線）は判定から外せる。 */
type LineObstacle = { id: string; pts: XY[]; weight: number; bbox: Box };

/** 凡例の 1 項目。 */
type LegendEntry = { label: string; color: string; dashed: boolean };

function bboxOf(pts: XY[]): Box {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  return { x0, x1, y0, y1 };
}

/** 点が多角形の内側にあるか（交差数の偶奇で判定する。塗りの evenodd 規則と一致させる）。 */
function pointInPolygon(p: XY, poly: XY[]): boolean {
  let inside = false;
  for (let k = 0, m = poly.length - 1; k < poly.length; m = k, k += 1) {
    const a = poly[k];
    const b = poly[m];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 折れ線が矩形と交わるか（いずれかの線分が矩形に入るか）。 */
function polylineHitsBox(pts: XY[], b: Box): boolean {
  for (let k = 1; k < pts.length; k += 1) {
    if (segmentHitsBox(pts[k - 1], pts[k], b)) return true;
  }
  return false;
}

/**
 * 折れ線のうち、弧長 s から window より離れた部分が矩形と交わるか。ラベルが乗る位置の近くを
 * 除いて、同じ線の別の部分（急に折り返す線など）がラベルに重なるかを調べる。
 */
function farPartHitsBox(
  pts: XY[],
  cum: number[],
  s: number,
  window: number,
  closed: boolean,
  b: Box,
): boolean {
  const total = cum[cum.length - 1];
  for (let k = 1; k < pts.length; k += 1) {
    const mid = (cum[k - 1] + cum[k]) / 2;
    let dist = Math.abs(mid - s);
    if (closed) dist = Math.min(dist, total - dist);
    if (dist > window && segmentHitsBox(pts[k - 1], pts[k], b)) return true;
  }
  return false;
}

/** 線分が矩形と交わるか（Liang–Barsky 法で、線分を矩形で切り取れるかを調べる）。 */
function segmentHitsBox(a: XY, b: XY, box: Box): boolean {
  if (
    Math.max(a.x, b.x) < box.x0 ||
    Math.min(a.x, b.x) > box.x1 ||
    Math.max(a.y, b.y) < box.y0 ||
    Math.min(a.y, b.y) > box.y1
  ) {
    return false;
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const pq: [number, number][] = [
    [-dx, a.x - box.x0],
    [dx, box.x1 - a.x],
    [-dy, a.y - box.y0],
    [dy, box.y1 - a.y],
  ];
  for (const [p, q] of pq) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t0 <= t1;
}

// 以下のラベル幅の見積もりと配置の補助関数は、FunctionGraph.tsx の同名の関数と同じ内容である。
// FunctionGraph の関数はモジュール内に閉じており、共有のモジュールへ移すには FunctionGraph を
// 変更する必要がある。既存の章の描画を変えないため、ここに複製して持つ。
// FunctionGraph は当たり判定の矩形に、より広めの見積もり（コマンド名の綴りも字数に数える）を
// 使う。線や点の印を障害物に数えないため、矩形を広く取ってそれらから離すためである。本図は線と
// 点の印を障害物に数えるため、すべてのラベルで実幅に近い estimateTexWidthPrecise を使う。広めの
// 見積もりでは \nabla f が実幅の 3 倍になり、等高線の間に置ける位置が見つからなくなる。

/** ラベルの想定文字高（viewBox 単位）。フォントサイズ 12 の約 1.25 倍。当たり判定の縦幅に使う。 */
const LABEL_H = 15;

/** 線分・ベクトルとラベル矩形の間に空けるすきま（viewBox 単位）。 */
const SEG_LABEL_GAP = 5.5;

/** 字形を持たず、引数の中身だけが幅を持つ組版コマンド（\mathrm{A} は A の幅になる）。 */
const LAYOUT_ONLY_COMMANDS = new Set([
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
const OPERATOR_NAMES = new Set([
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
const RELATION_COMMANDS = new Set(["le", "ge", "leq", "geq", "neq", "ne", "approx", "to", "equiv"]);

/** 前後に空きが入る二項演算子のコマンド名。 */
const BINARY_COMMANDS = new Set(["times", "cdot", "pm", "mp", "div"]);

/**
 * LaTeX 文字列の表示幅を、estimateTexWidth より実幅に近く見積もる（安全側に広めに取る点は同じ）。
 * ラベルを線から離す距離と、等高線を切り抜く幅に使う。
 */
function estimateTexWidthPrecise(tex: string, fontSize: number): number {
  let units = 0;
  let afterOperand = false;
  for (const m of tex.matchAll(/\\([a-zA-Z]+)|\\[^a-zA-Z]|[^{}^_$\s]/g)) {
    const name = m[1];
    if (name !== undefined) {
      if (LAYOUT_ONLY_COMMANDS.has(name)) continue;
      if (RELATION_COMMANDS.has(name) || BINARY_COMMANDS.has(name)) {
        units += 2;
        afterOperand = false;
      } else {
        units += OPERATOR_NAMES.has(name) ? name.length : 1;
        afterOperand = true;
      }
      continue;
    }
    const ch = m[0];
    if (ch.startsWith("\\")) {
      if ("{}|".includes(ch[1])) {
        units += 1;
        afterOperand = ch[1] !== "{";
      }
      continue;
    }
    if (ch === "=" || ch === "<" || ch === ">") {
      units += 2;
      afterOperand = false;
    } else if (ch === "+" || ch === "-") {
      units += afterOperand ? 2 : 1;
      afterOperand = false;
    } else {
      units += 1;
      afterOperand = !"([,".includes(ch);
    }
  }
  return Math.max(units * fontSize * 0.72, 24);
}

/**
 * 線分・ベクトルの中点から法線方向へ、ラベル中心を離す距離を求める。中央寄せのラベル矩形
 * （幅 w・高さ LABEL_H）を単位法線 (perpX, perpY) へ射影した半幅に、すきまを足す。
 */
function normalLabelOffset(perpX: number, perpY: number, w: number): number {
  return (Math.abs(perpX) * w) / 2 + (Math.abs(perpY) * LABEL_H) / 2 + SEG_LABEL_GAP;
}

/** 配置先と推定文字幅から、ラベルが占める矩形を求める。 */
function boxFor(pos: LabelPos, w: number): Box {
  const x0 = pos.align === "left" ? pos.x : pos.align === "right" ? pos.x - w : pos.x - w / 2;
  return { x0, x1: x0 + w, y0: pos.y - LABEL_H / 2, y1: pos.y + LABEL_H / 2 };
}

/** 線とラベルの間に残すすきま（px）。線との当たり判定で、ラベルの矩形をこの幅だけ広げる。 */
const LINE_CLEARANCE = 1.5;

/** ラベルどうしの間に残したいすきま（px）。これより近いと軽い罰点を与える。 */
const LABEL_SPACING = 4;

/** 矩形を四方へ d だけ広げる。 */
function inflate(b: Box, d: number): Box {
  return { x0: b.x0 - d, x1: b.x1 + d, y0: b.y0 - d, y1: b.y1 + d };
}

/** 2 つの矩形が重なるか。 */
function boxesOverlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

// ======================================================================
// 数値の補助
// ======================================================================

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 値を [lo, hi] に丸める。NaN は lo とし（その位置で領域の幅を 0 にする）、無限大も端に丸める。 */
function clampTo(v: number, lo: number, hi: number): number {
  return Number.isNaN(v) ? lo : clamp(v, lo, hi);
}

/** 画面座標を小数第 2 位に丸め、SVG の出力を短くする（0.01px の差は描画に表れない）。 */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
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
