import { RectClipPath } from "@visx/clip-path";
import { GridColumns, GridRows } from "@visx/grid";
import { Group } from "@visx/group";
import { LegendItem, LegendLabel } from "@visx/legend";
import { Marker } from "@visx/marker";
import { scaleLinear } from "@visx/scale";
import { Circle, Line, LinePath, Polygon } from "@visx/shape";
import { renderToString } from "katex";
import { useId } from "react";
import {
  bboxOf,
  boxesOverlap,
  clamp,
  cumulativeLength,
  distanceToSegment,
  farPartHitsBox,
  inflate,
  lerpAt,
  pointAtLength,
  pointInPolygon,
  polylineHitsBox,
  segmentHitsBox,
  turnAngle,
  type Box,
  type XY,
} from "./figure-label/geometry";
import {
  glyphBox,
  glyphCenterOffset,
  glyphSizeOf,
  type GlyphSize,
  type LabelPos,
} from "./figure-label/label-box";
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
 * 等高線のラベルは線の上に置き、ラベルの下だけ線をマスクで切り抜く。格子線（目盛りに沿った
 * 格子線と極座標の格子）は、すべてのラベルと目盛り数字の下でマスクで切り抜く。
 *
 * ベクトル場（`fields`）は格子点で関数を評価して矢印の群を描く。曲線・媒介変数曲線・領域の境界の
 * `arrows` は、線の向きを矢じりで示す。例えば原点のまわりを回る場と、反時計回りの単位円は次の
 * ように書く。
 *
 * ```mdx
 * <ContourPlot xMin={-2} xMax={2} yMin={-2} yMax={2} ariaLabel="回転する場と単位円"
 *   fields={[{ fn: (x, y) => ({ x: -y, y: x }), step: 0.5, pivot: "center" }]}
 *   parametrics={[{ fn: (t) => ({ x: Math.cos(t), y: Math.sin(t) }), tMin: 0, tMax: 2 * Math.PI,
 *     arrows: 4 }]} />
 * ```
 */

/**
 * 軸の目盛り。数値だけ渡すと数値をそのまま描く。$\pi$ など特別な値には `{ value, label }` で
 * ラベル（LaTeX）を添える。`FunctionGraph` と同じ指定方法である。
 */
type Tick = number | Readonly<{ value: number; label?: string }>;

/**
 * 等高線の 1 つの高さ。数値だけ渡すと、ラベルは `labelVar` を左辺にした等式（例: `c=1`）になる。
 * `{ value, label, color }` でラベル（LaTeX）と線の色を個別に指定できる。`label: ""` で
 * その高さだけラベルを省く。
 */
type ContourLevel = number | Readonly<{ value: number; label?: string; color?: string }>;

/** 1 つの関数の等高線の組。 */
type ContourSet = Readonly<{
  /** 等高線を描く関数。数学座標 (x, y) を受け取り値を返す。定義域外では NaN を返してよい。 */
  fn: (x: number, y: number) => number;
  /** 描く高さ c の並び。 */
  levels: readonly ContourLevel[];
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
}>;

/** 領域の見た目。すべての指定方法に共通する。 */
type RegionStyle = Readonly<{
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
}>;

/**
 * 曲線の向きを示す矢じりの置き方。数値 n なら媒介変数の範囲を n 等分した各小区間の中央に、
 * 配列なら各値の位置に置く。矢じりの中心を曲線の上に置き、媒介変数の範囲を始端から終端へ
 * 進む向き（通常は媒介変数が増える向き）へ向ける。小区間の中央に置くのは、閉曲線の始点と終点
 * （同じ点）に矢じりが 2 つ重ならないためである。
 */
type ArrowMarks = number | readonly number[];

/** 頂点列で与える多角形の領域。頂点は順にたどり、最後の頂点から最初の頂点へ戻って閉じる。 */
type PolygonRegion = RegionStyle &
  Readonly<{
    kind: "polygon";
    points: readonly XY[];
    /** 各辺の中点に、頂点の順にたどる向きの矢じりを付けるか（境界の向きを示す）。既定 false。 */
    arrows?: boolean;
  }>;

/**
 * 2 曲線ではさまれた領域 $a\le x\le b$、$g_1(x)\le y\le g_2(x)$。`x` に $[a,b]$、`lower` に
 * $g_1$、`upper` に $g_2$ を渡す。省いた側は描画窓の外まで広がり、その側の境界線は描かない。
 * 例えば `lower` だけを渡すと $y>g_1(x)$、`upper` だけを渡すと半平面 $y<g_2(x)$ を表す。
 */
type BetweenXRegion = RegionStyle &
  Readonly<{
    kind: "between-x";
    x?: readonly [number, number];
    lower?: (x: number) => number;
    upper?: (x: number) => number;
  }>;

/**
 * $x$ と $y$ の役割を入れ替えた版 $c\le y\le d$、$h_1(y)\le x\le h_2(y)$。`y` に $[c,d]$、`left` に
 * $h_1$、`right` に $h_2$ を渡す。省いた側の扱いは `between-x` と同じである。
 */
type BetweenYRegion = RegionStyle &
  Readonly<{
    kind: "between-y";
    y?: readonly [number, number];
    left?: (y: number) => number;
    right?: (y: number) => number;
  }>;

/** 媒介変数表示の閉曲線 $t\mapsto(x(t),y(t))$（$t_{\min}\le t\le t_{\max}$）で囲まれた領域。 */
type ParametricRegion = RegionStyle &
  Readonly<{
    kind: "parametric";
    fn: (t: number) => XY;
    tMin: number;
    tMax: number;
    /** 標本数。既定 240。 */
    samples?: number;
    /** 境界の向きを示す矢じり（ArrowMarks を参照）。tMin から tMax へ進む向きを指す。既定は矢じりなし。 */
    arrows?: ArrowMarks;
  }>;

/** 極座標の動径の範囲の端。定数、または角 $\theta$ の関数で与える。 */
type RadialBound = number | ((theta: number) => number);

/**
 * 極座標で与える領域 $r_1\le r\le r_2$、$\theta_1\le\theta\le\theta_2$（扇形・環状の領域）。
 * `r` の各端は定数か $\theta$ の関数である。$\theta_2-\theta_1=2\pi$ なら一周する（円板・円環）。
 */
type PolarRegion = RegionStyle &
  Readonly<{
    kind: "polar";
    r: readonly [RadialBound, RadialBound];
    theta: readonly [number, number];
    /** 極（原点）の位置。既定は (0, 0)。 */
    center?: XY;
  }>;

/** 塗りつぶす領域。`kind` で指定方法を選ぶ。描画窓からはみ出す部分は窓で切り取る。 */
type Region = PolygonRegion | BetweenXRegion | BetweenYRegion | ParametricRegion | PolarRegion;

/**
 * 曲線のラベルの置き方。"legend" は凡例にまとめ、"inline" は線のそばの空いた位置に置く。
 * 曲線が少なく、線と式の対応を図の中で示したいときに "inline" を選ぶ。
 */
type LabelPlacement = "legend" | "inline";

/** 陽関数 $y=f(x)$ の曲線。 */
type Curve = Readonly<{
  /** 描く関数。x を受け取り y を返す。定義域外では NaN を返してよい。 */
  fn: (x: number) => number;
  /** この曲線だけの定義域 [min, max]。省略時は描画窓の横範囲全体。 */
  domain?: readonly [number, number];
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
  /**
   * 向きを示す矢じり（ArrowMarks を参照）。媒介変数は x で、定義域の [始端, 終端] の順に進む
   * 向き（通常は x が増える向き）を指す。数値 n なら定義域（省略時は描画窓の横範囲）を n 等分
   * して置く。既定は矢じりなし。
   */
  arrows?: ArrowMarks;
}>;

/** 媒介変数曲線 $t\mapsto(x(t),y(t))$。 */
type ParametricCurve = Readonly<{
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
  /**
   * 向きを示す矢じり（ArrowMarks を参照）。t が増える向きを指す。逆向きを示すには tMin と
   * tMax を入れ替えるか、fn の t の符号を反転する。既定は矢じりなし。
   */
  arrows?: ArrowMarks;
}>;

/** 矢印の見た目。 */
type VectorStyle = Readonly<{
  /** 矢印の色。既定は桃色系（等高線の青と区別する）。 */
  color?: string;
  /** 矢印に添える LaTeX ラベル（例: "\\nabla f"）。 */
  label?: string;
  /** ラベルの中心の位置（数学座標）。省略時は、線・他のラベルと重ならない位置を自動で選ぶ。 */
  labelAt?: XY;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
}>;

/** 矢印（有向線分）。始点 `from` と終点 `to`、または始点 `from` と成分 `delta` で与える。 */
type Vector = VectorStyle & (Readonly<{ from: XY; to: XY }> | Readonly<{ from: XY; delta: XY }>);

/**
 * 平面のベクトル場（矢印の格子）。格子点（または `at` の各点）で関数を評価し、各点に矢印を
 * 描く。長さはすべて座標の単位で決める。横縦の縮尺が異なる図でも、矢印の成分は座標どおりになる。
 */
type VectorField = Readonly<{
  /**
   * 場の関数。数学座標 (x, y) を受け取り、その点のベクトル（成分）を返す。null や有限でない値を
   * 返した点（場が定義されない点）は描かない。
   */
  fn: (x: number, y: number) => XY | null;
  /** 格子の間隔（座標）。数値なら横縦共通、[横, 縦] で個別に与える。既定 1。 */
  step?: number | readonly [number, number];
  /** 格子の基準点（座標）。格子点はこの点から間隔の整数倍の位置に置く。既定は原点。 */
  origin?: XY;
  /**
   * 格子を張る横の範囲 [min, max]（座標。両端を含む）。既定は描画窓の横範囲で、窓の縁の上の
   * 格子点は除く（縁の点の矢印は大半が窓の外へ出て、切れ端だけが残るため）。
   */
  x?: readonly [number, number];
  /** 格子を張る縦の範囲 [min, max]（座標。両端を含む）。既定は描画窓の縦範囲（縁の上の点を除く）。 */
  y?: readonly [number, number];
  /** 格子の代わりに評価する点の列（座標）。曲線の上の法線など、決まった点に矢印を置くときに使う。 */
  at?: readonly XY[];
  /** 評価しない点のマスク。true を返した点には何も描かない（定義域外・原点のまわりなど）。 */
  hide?: (x: number, y: number) => boolean;
  /**
   * 長さの倍率。矢印の成分（座標）をベクトルの scale 倍にする。省略時は、格子なら最も長い矢印が
   * 格子間隔の 0.85 倍になる値、`at` なら 1 とする。
   */
  scale?: number;
  /**
   * すべての矢印を同じ長さにそろえるか（向きだけを示す）。そろえた長さ（座標）は scale で、
   * 省略時は格子なら格子間隔の 0.7 倍、`at` なら 1 とする。既定 false。
   */
  normalize?: boolean;
  /** 矢印の長さの上限（座標）。超える矢印は向きを保って縮める。特異点の近くで伸びすぎるのを防ぐ。 */
  maxLength?: number;
  /** 評価点に矢印のどこを合わせるか。"tail" は始点、"center" は中点。既定 "tail"。 */
  pivot?: "tail" | "center";
  /** 零ベクトルの点の描き方。"skip" は描かない、"dot" は小さな点で示す。既定 "skip"。 */
  zero?: "skip" | "dot";
  /** 矢印の色。既定は青緑（等高線の青・矢印の桃色・強調の琥珀色と区別する）。 */
  color?: string;
  /** 矢印の群の不透明度（0〜1）。既定 1。重ねる曲線・領域を目立たせたいときに下げる。 */
  opacity?: number;
  /** 矢印の軸の線の太さ（px）。既定 1.4。 */
  width?: number;
  /**
   * ラベル・目盛り数字に重なる矢印を描かないか。既定 false（ラベルはハローを敷いて矢印の上に
   * 描く）。密な場で目盛り数字やラベルが読みにくいときに true にする。省くのは矢印 1 本ごとで、
   * 矢じりの無い切れ端は残さない。
   */
  avoidLabels?: boolean;
  /** 凡例に載せる LaTeX ラベル（例: "\\mathbf{F}=(-y,x)"）。省略時は凡例に載せない。 */
  legendLabel?: string;
}>;

/** 平面上の 1 点。塗りつぶし（黒丸）または白抜き（白丸。その点を含まない）で表す。 */
type Point = Readonly<{
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
}>;

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
type Partition = Readonly<{
  /** x 方向の区間 [a, b]。 */
  x: readonly [number, number];
  /** y 方向の区間 [c, d]。 */
  y: readonly [number, number];
  /** x 方向の分割数。 */
  m: number;
  /** y 方向の分割数。 */
  n: number;
  /** 強調して塗る小長方形。label は小長方形の中に置く LaTeX（例: "R_{32}"）。 */
  highlight?: readonly Readonly<{ i: number; j: number; label?: string }>[];
  /** 各小長方形の代表点。省略時は代表点を描かない。 */
  samples?: PartitionSample;
  /** 長方形全体を淡く塗るか。既定 false。 */
  fill?: boolean;
  /** 格子線の色。既定は青系。 */
  color?: string;
}>;

/** 2 点を結ぶ補助線分。既定は破線。 */
type Segment = Readonly<{
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
}>;

/**
 * 極座標の格子。極を中心とする円（`radii`）と、極から出る半直線（`angles`、弧度法）を細線で描く。
 * 半直線は最も外側の円まで引く。`angles` に `{ value, label }` を渡すと、半直線の先に角の
 * ラベル（LaTeX）を置く。
 */
type PolarGrid = Readonly<{
  radii?: readonly number[];
  angles?: readonly Tick[];
  /** 極の位置。既定は (0, 0)。 */
  center?: XY;
}>;

type ContourPlotProps = Readonly<{
  /** 描画窓の横範囲。 */
  xMin: number;
  xMax: number;
  /** 描画窓の縦範囲。 */
  yMin: number;
  yMax: number;
  /** 等高線の組。関数ごとに 1 組を渡す。 */
  contours?: readonly ContourSet[];
  /** 塗りつぶす領域。配列の順に奥から描く。 */
  regions?: readonly Region[];
  /** 陽関数 $y=f(x)$ の曲線。 */
  curves?: readonly Curve[];
  /** 媒介変数曲線。 */
  parametrics?: readonly ParametricCurve[];
  /** 矢印（有向線分）。 */
  vectors?: readonly Vector[];
  /**
   * ベクトル場（矢印の格子）。領域・等高線より前面、曲線・矢印・点・ラベルより奥に描き、
   * 描画窓で切り取る。
   */
  fields?: readonly VectorField[];
  /** 平面上に置く点。 */
  points?: readonly Point[];
  /** 長方形の分割の格子。 */
  partition?: Partition;
  /** 補助線分。 */
  segments?: readonly Segment[];
  /** 極座標の格子。 */
  polarGrid?: PolarGrid;
  /** x 軸の目盛り。省略時は整数位置に自動で振る。空配列で目盛りなし。 */
  xTicks?: readonly Tick[];
  /** y 軸の目盛り。省略時は整数位置に自動で振る。空配列で目盛りなし。 */
  yTicks?: readonly Tick[];
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
}>;

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

// ベクトル場の既定色。等高線（青）・矢印（桃色）・強調（琥珀色）のいずれとも見分けられる青緑にする。
const FIELD = "#0d9488";
// ベクトル場の矢じりと軸の太さ（px）。矢印が数十〜数百本並び、1 本ずつは短いため、通常の矢印より
// 小さくする。矢じりの縦横比は通常の矢印（9 : 3.6）と同じに保つ。
const FIELD_HEAD_LEN = 6;
const FIELD_HEAD_HALF = 2.4;
const FIELD_WIDTH = 1.4;
// 零ベクトルを示す点の半径（px）。
const FIELD_DOT_R = 1.6;
// 画面上の長さがこれ（px）より短い矢印は、向きが読めないため零ベクトルと同じに扱う。
const FIELD_MIN_PX = 0.5;
// 格子の 1 方向あたりの格子点数の上限。間隔の指定を誤ったときに、ビルドが止まらないようにする。
const FIELD_MAX_STEPS = 200;
// ラベル配置で、ベクトル場の矢印 1 本と重なるごとの罰点と、1 つの場あたりの罰点の上限。上限を
// 曲線・等高線の重み（6）より小さくし、場が図全体を覆う場合も、ラベルは線を避けることを優先し、
// そのうえで重なる矢印の少ない位置を選ぶ。罰点が有限なので、ラベルが置けなくなることはない。
const FIELD_WEIGHT = 1;
const FIELD_MAX_PENALTY = 4;

// 領域のラベルを置く候補の、基準点（重心または labelAt）からのずれ（px）。近い順に並べ、同点なら
// 前の候補を選ぶ。斜めのずれを真横のずれより先に試す。重心が軸の上に来たとき、真横へずらすと
// ラベルが同じ高さの目盛り数字と軸をはさんで並び、1 続きの式に見えるためである。
const REGION_LABEL_OFFSETS: readonly (readonly [number, number])[] = [
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
// 等高線を切り抜く矩形の、字形の矩形からの余白（px）。ラベルと線の切れ目の間にすきまを残す。
const CONTOUR_GAP_PAD = 2;
// 領域・点・矢印などのラベル、目盛り数字、軸名の字の大きさ（KatexLabel の fontSize）。
const LABEL_FONT = 12;
const TICK_FONT = 11;
const AXIS_NAME_FONT = 13;

// 目盛りに沿った格子線を、ラベルの配置で避ける重み。淡い補助線のため他のどの障害物より軽くし、
// 空いた位置が無いときは重なりを許す。重なった部分は格子線のマスクで切り抜く。
const GRID_WEIGHT = 1;
// 格子線を切り抜く範囲を、字形の矩形からさらに広げる量（px）。見積もりと実際の字幅の差と、ハローの
// 広がりを吸収する。
const GRID_CUT_PAD = 2;
// 格子線を切り抜いた外側に残る線の長さの下限（px）。これより短く残るなら、縁まで切り抜く。
const GRID_STUB_PX = 12;

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
  fields = [],
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
  const gridMask = `cpGridMask-${uid}`;

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
  const curveSamples = curves.map((c): readonly Sample[] => {
    const [lo, hi] = c.domain ?? [xMin, xMax];
    return upTo(SAMPLES).map((i) => {
      const xv = lo + ((hi - lo) * i) / SAMPLES;
      const p = { x: xv, y: c.fn(xv) };
      return { ...toScreen(inExt(p) ? p : { x: xv, y: 0 }), ok: inExt(p), t: xv };
    });
  });
  const paramSamples = parametrics.map((pc): readonly Sample[] => {
    // 公開 props の samples に 0 や負数が来ても 0 除算で NaN にならないよう、最低 1 に丸める。
    const n = Math.max(1, pc.samples ?? PARAM_SAMPLES);
    return upTo(n).map((i) => {
      const t = pc.tMin + ((pc.tMax - pc.tMin) * i) / n;
      const p = pc.fn(t);
      return { ...toScreen(inExt(p) ? p : { x: 0, y: 0 }), ok: inExt(p), t };
    });
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

  // ---- ベクトル場 ----
  const fieldData = fields.map((f) =>
    fieldGeometry(f, { x0: xMin, x1: xMax, y0: yMin, y1: yMax }, toScreen),
  );

  // ---- 曲線・境界の向きの矢じり ----
  // 矢じりは画面座標で向きを求め、横縦の縮尺が異なる図でも線に沿って向くようにする。接線は
  // ごく近い 2 点の差で求めるため、0.01px に丸める toScreen でなく丸めない写像を使う。
  const toPx = (p: XY): XY => ({ x: x(p.x), y: y(p.y) });
  const curveHeads = [
    ...curves.flatMap((c) => {
      const [lo, hi] = c.domain ?? [xMin, xMax];
      const color = c.color ?? CURVE;
      const heads = orientationHeads((t) => ({ x: t, y: c.fn(t) }), c.arrows, lo, hi, toPx, inExt);
      return heads.map((head) => ({ head, color }));
    }),
    ...parametrics.flatMap((pc) => {
      const color = pc.color ?? CURVE;
      const heads = orientationHeads(pc.fn, pc.arrows, pc.tMin, pc.tMax, toPx, inExt);
      return heads.map((head) => ({ head, color }));
    }),
  ];
  const regionHeads = regions.flatMap((r) => {
    const color = r.boundaryColor ?? r.color ?? CURVE;
    if (r.kind === "parametric") {
      const heads = orientationHeads(r.fn, r.arrows, r.tMin, r.tMax, toPx, inExt);
      return heads.map((head) => ({ head, color }));
    }
    if (r.kind === "polygon" && r.arrows === true) {
      // 各辺を 0〜1 の媒介変数でたどり、中点に矢じりを置く。
      return r.points.flatMap((p, k) => {
        const q = r.points[(k + 1) % r.points.length];
        const heads = orientationHeads((t) => lerpAt(p, q, t), [0.5], 0, 1, toPx, inExt);
        return heads.map((head) => ({ head, color }));
      });
    }
    return [];
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
  // 数字・点の印（矩形）と、等高線・曲線・境界・矢印などの線（折れ線）、目盛りに沿った格子線である。
  const viewBounds: Box = { x0: 2, x1: viewW - 2, y0: 2, y1: viewH - 2 };
  const plotBounds: Box = {
    x0: originX + 1,
    x1: originX + plotW - 1,
    y0: originY + 1,
    y1: originY + plotH - 1,
  };
  // 空ラベルの目盛り（格子線だけを残し数字を省く目盛り）は字形をもたないので、障害物・格子線の
  // 切り抜き・avoidLabels の判定から外す。外さないと、数字の無い位置で格子線が規則的に途切れて見える。
  const tickBoxOf = (t: Tick, pos: LabelPos): Box =>
    glyphBox(pos, glyphSizeOf(tickLabel(t), TICK_FONT));
  const tickBoxes: readonly Box[] = axes
    ? [
        ...xt.flatMap((t) =>
          tickLabel(t) === ""
            ? []
            : [tickBoxOf(t, { x: x(tickValue(t)), y: axisY + 13, align: "center" })],
        ),
        ...yt.flatMap((t) =>
          tickLabel(t) === ""
            ? []
            : [tickBoxOf(t, { x: axisX - 14, y: y(tickValue(t)), align: "center" })],
        ),
      ]
    : [];
  const boxObstacles: readonly BoxObstacle[] = [
    ...tickBoxes.map((box) => ({ box, weight: 8 })),
    ...(axes
      ? [
          {
            box: { x0: axisX - 1.5, x1: axisX + 1.5, y0: originY, y1: originY + plotH },
            weight: 6,
          },
          {
            box: { x0: originX, x1: originX + plotW, y0: axisY - 1.5, y1: axisY + 1.5 },
            weight: 6,
          },
          // 軸名（x・y）。描く位置は下の軸名の KatexLabel と同じである。
          {
            box: glyphBox(
              { x: originX + plotW + 14, y: axisY - 11, align: "center" },
              glyphSizeOf(xLabel, AXIS_NAME_FONT),
            ),
            weight: 8,
          },
          {
            box: glyphBox(
              { x: axisX + 8, y: originY - 9, align: "left" },
              glyphSizeOf(yLabel, AXIS_NAME_FONT),
            ),
            weight: 8,
          },
        ]
      : []),
    ...points.map((p) => {
      const px = x(p.x);
      const py = y(p.y);
      return { box: { x0: px - 5, x1: px + 5, y0: py - 5, y1: py + 5 }, weight: 12 };
    }),
    ...(partitionData?.samples ?? []).map((s) => ({
      box: { x0: s.x - 4, x1: s.x + 4, y0: s.y - 4, y1: s.y + 4 },
      weight: 8,
    })),
  ];
  const lineObstacles: readonly LineObstacle[] = [
    ...contourData.flatMap((levels) =>
      levels.flatMap((lv) => lv.lines.flatMap((l) => lineObstacle(lv.id, l.pts, 6))),
    ),
    ...curveSamples.flatMap((s, i) =>
      visiblePieces(s).flatMap((piece) => lineObstacle(`cv${i}`, piece, 6)),
    ),
    ...paramSamples.flatMap((s, i) =>
      visiblePieces(s).flatMap((piece) => lineObstacle(`pm${i}`, piece, 6)),
    ),
    ...regionData.flatMap((r, i) =>
      (regions[i].boundary ?? "solid") === "none"
        ? []
        : r.edges.flatMap((e) => lineObstacle(`rg${i}`, e, 3)),
    ),
    ...vectorData.flatMap((v, i) => lineObstacle(`vc${i}`, [v.from, v.to], 6)),
    ...segments.flatMap((s, i) => lineObstacle(`sg${i}`, [toScreen(s.from), toScreen(s.to)], 3)),
    ...(partitionData?.lines ?? []).flatMap((l) => lineObstacle("pt", l.pts, l.outer ? 3 : 1)),
    ...(polar === null
      ? []
      : polar.rays.flatMap((ray) => lineObstacle("pl", [polar.center, ray.end], 1))),
  ];
  // ベクトル場の矢印は、場ごとにまとめて別に持つ。重なる本数の罰点に場ごとの上限を設けるためで
  // ある（FIELD_MAX_PENALTY を参照）。
  const fieldObstacles: readonly (readonly LineObstacle[])[] = fieldData.map((fd, i) =>
    fd.arrows.map((a) => {
      const pts = [a.from, a.to];
      return { id: `fd${i}`, pts, weight: FIELD_WEIGHT, bbox: bboxOf(pts) };
    }),
  );
  // 目盛りに沿った格子線。格子線が式のラベルを貫くと、「=」が「≠」に、「−」が線と並走して読み
  // にくくなる。他の線と分けて持ち、等高線のラベルだけが判定から外せるようにする。
  const gridObstacles: readonly LineObstacle[] = grid
    ? [
        ...xt.map((t) => {
          const gx = x(tickValue(t));
          return [
            { x: gx, y: originY },
            { x: gx, y: originY + plotH },
          ];
        }),
        ...yt.map((t) => {
          const gy = y(tickValue(t));
          return [
            { x: originX, y: gy },
            { x: originX + plotW, y: gy },
          ];
        }),
      ].map((pts) => ({ id: "gd", pts, weight: GRID_WEIGHT, bbox: bboxOf(pts) }))
    : [];
  const linesAndGrid = [...lineObstacles, ...gridObstacles];

  // 矩形 b にラベルを置くときの罰点。placed は、それまでに置いたラベルの占有矩形である。
  const penaltyOf = (
    b: Box,
    placed: readonly Box[],
    exclude: string | undefined,
    bounds: Box,
    avoidGrid = true,
  ): number => {
    const outside =
      b.x0 < bounds.x0 || b.x1 > bounds.x1 || b.y0 < bounds.y0 || b.y1 > bounds.y1 ? 1000 : 0;
    // 目盛り数字・軸名・点の印・既出のラベルとは、重なりに加えて接するほどの近さも軽く罰し、
    // 隣り合う文字が 1 続きの式に見える（c=4 と目盛り 2 が「c=4 2」に見えるなど）のを避ける。
    const near = inflate(b, LABEL_SPACING);
    const byBoxes = boxObstacles.reduce(
      (p, o) => (boxesOverlap(b, o.box) ? p + o.weight : boxesOverlap(near, o.box) ? p + 2 : p),
      outside,
    );
    const byPlaced = placed.reduce(
      (p, q) => (boxesOverlap(b, q) ? p + 10 : boxesOverlap(near, q) ? p + 2 : p),
      byBoxes,
    );
    // 線との判定は矩形を少し広げて行い、ラベルの字形と線の間にすきまを残す。
    const padded = inflate(b, LINE_CLEARANCE);
    const byLines = (avoidGrid ? linesAndGrid : lineObstacles).reduce(
      (p, l) =>
        l.id !== exclude && boxesOverlap(padded, l.bbox) && polylineHitsBox(l.pts, padded)
          ? p + l.weight
          : p,
      byPlaced,
    );
    // ベクトル場の矢印。格子線と同じく、等高線のラベル（avoidGrid が false）は避けない。等高線の
    // ラベルは線の上で置ける位置が限られ、矢印を避けると線の中ほどから外れるためである。重なる
    // 矢印はラベルのハローで読める。上限に達した場は、残りの矢印を調べない。
    if (!avoidGrid) return byLines;
    return fieldObstacles.reduce((p, group) => {
      const hits = group.reduce(
        (h, l) =>
          h < FIELD_MAX_PENALTY && boxesOverlap(padded, l.bbox) && polylineHitsBox(l.pts, padded)
            ? h + l.weight
            : h,
        0,
      );
      return p + Math.min(hits, FIELD_MAX_PENALTY);
    }, byLines);
  };
  // 候補から最も罰点の小さい位置を選ぶ。同点なら前方の候補を優先する。
  const choosePlacement = (
    cands: readonly LabelPos[],
    size: GlyphSize,
    placed: readonly Box[],
    exclude?: string,
  ): LabelPos | null =>
    bestOf(
      cands,
      (cand, i) => penaltyOf(glyphBox(cand, size), placed, exclude, viewBounds) + i * 0.1,
    ).item;
  // 選んだ位置のラベルと、そのラベルが占める矩形。位置が無ければ何も置かない。
  const placedLabel = (tex: string, pos: LabelPos | null, size: GlyphSize): Placement<Label> => {
    if (pos === null) return NO_PLACEMENT;
    const box = glyphBox(pos, size);
    return { item: { tex, pos, box }, box };
  };

  // ラベルは、領域・極座標の角・点・小長方形・矢印・補助線分・曲線・媒介変数曲線・等高線の順に
  // 1 つずつ置く。各段の最後の placed を次の段へ渡し、後のラベルが先のラベルを避けるようにする。

  // 領域のラベル。重心（または labelAt）を中心に周囲の候補を試し、軸・目盛り数字・線と重ならず、
  // 中心が領域の内側に残る位置を選ぶ。重心は原点や軸の上に来やすい（原点中心の円板など）ため、
  // 重心に固定すると軸線がラベルを貫く。他のラベルより先に置き、他のラベルがこれを避けるようにする。
  const regionLabels = placeInOrder(regionData, [], (r, i, placed) => {
    const tex = regions[i].label;
    if (tex === undefined || r.labelAt === null) return NO_PLACEMENT;
    const anchor = r.labelAt;
    const size = glyphSizeOf(tex, LABEL_FONT);
    const cands = REGION_LABEL_OFFSETS.map(([dx, dy]): LabelPos => ({
      x: anchor.x + dx,
      y: anchor.y + dy,
      align: "center",
    }));
    const best = bestOf(cands, (cand, k) => {
      const p = penaltyOf(glyphBox(cand, size), placed, undefined, plotBounds) + k * 0.1;
      return pointInPolygon(cand, r.fill) ? p : p + 1000;
    }).item;
    return placedLabel(tex, best, size);
  });
  const polarLabels = placeInOrder(polar?.rays ?? [], regionLabels.placed, (ray) => {
    if (ray.label === undefined) return NO_PLACEMENT;
    const size = glyphSizeOf(ray.label, LABEL_FONT);
    // 半直線の延長上へ、ラベル矩形が円に触れない距離だけ離す。
    const off = normalLabelOffset(ray.dir.x, ray.dir.y, size);
    const pos: LabelPos = {
      x: ray.end.x + ray.dir.x * off,
      y: ray.end.y + ray.dir.y * off,
      align: "center",
    };
    return placedLabel(ray.label, pos, size);
  });

  // 点のラベル。点の周囲 8 方向の候補から選ぶ（FunctionGraph と同じ候補）。
  const pointLabels = placeInOrder(points, polarLabels.placed, (p, _, placed) => {
    if (p.label === undefined) return NO_PLACEMENT;
    const px = x(p.x);
    const py = y(p.y);
    const cands: Readonly<Record<LabelDir, LabelPos>> = {
      above: { x: px, y: py - 13, align: "center" },
      below: { x: px, y: py + 16, align: "center" },
      "above-right": { x: px + 9, y: py - 12, align: "left" },
      "below-right": { x: px + 9, y: py + 14, align: "left" },
      "above-left": { x: px - 9, y: py - 12, align: "right" },
      "below-left": { x: px - 9, y: py + 14, align: "right" },
      right: { x: px + 12, y: py + 1, align: "left" },
      left: { x: px - 12, y: py + 1, align: "right" },
    };
    const size = glyphSizeOf(p.label, LABEL_FONT);
    const pos = choosePlacement(
      p.labelDir === undefined ? Object.values(cands) : [cands[p.labelDir]],
      size,
      placed,
    );
    return placedLabel(p.label, pos, size);
  });

  // 分割の小長方形のラベル。小長方形の中心を優先し、代表点と重なるときは上下へ逃がす。逃がす量は、
  // ラベルの半分の高さと代表点の印の半径を足した距離より大きくとる。
  const cellLabels = placeInOrder(
    partitionData?.highlights ?? [],
    pointLabels.placed,
    (h, _, placed) => {
      if (h.label === undefined) return NO_PLACEMENT;
      const size = glyphSizeOf(h.label, LABEL_FONT);
      const pos = choosePlacement(
        [
          { x: h.cx, y: h.cy, align: "center" },
          { x: h.cx, y: h.cy - 13, align: "center" },
          { x: h.cx, y: h.cy + 13, align: "center" },
        ],
        size,
        placed,
      );
      return placedLabel(h.label, pos, size);
    },
  );

  // 矢印のラベル。中点から線に直交する両側を優先し、続いて終点の先・終点の斜め先・終点の横、
  // 始点の手前の順に候補にする。勾配の矢印のように等高線の間を短い矢印が横切る図では、中点の
  // 横が隣の等高線にかかりやすく、空いている側が矢印ごとに異なるためである。
  const vectorLabels = placeInOrder(vectors, cellLabels.placed, (v, i, placed) => {
    if (v.label === undefined) return NO_PLACEMENT;
    const { from, to } = vectorData[i];
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const dir = { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
    const perp = { x: -dir.y, y: dir.x };
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const size = glyphSizeOf(v.label, LABEL_FONT);
    const side = normalLabelOffset(perp.x, perp.y, size);
    const along = normalLabelOffset(dir.x, dir.y, size);
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
      size,
      placed,
      `vc${i}`,
    );
    return placedLabel(v.label, pos, size);
  });

  // 補助線分のラベル。中点から線分に直交する両側を候補にする（FunctionGraph と同じ方式）。
  const segmentLabels = placeInOrder(segments, vectorLabels.placed, (s, i, placed) => {
    if (s.label === undefined) return NO_PLACEMENT;
    const a = toScreen(s.from);
    const b = toScreen(s.to);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const perp = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const size = glyphSizeOf(s.label, LABEL_FONT);
    const off = normalLabelOffset(perp.x, perp.y, size);
    const pos = choosePlacement(
      s.labelAt === undefined
        ? [
            { x: mid.x + perp.x * off, y: mid.y + perp.y * off, align: "center" },
            { x: mid.x - perp.x * off, y: mid.y - perp.y * off, align: "center" },
          ]
        : [{ ...toScreen(s.labelAt), align: "center" }],
      size,
      placed,
      `sg${i}`,
    );
    return placedLabel(s.label, pos, size);
  });

  // 曲線のそばに置くラベル。曲線に沿った各位置で、線の両側へ離した候補を採点する。labelAt が
  // あればその位置の両側だけを候補にする。指定が無ければ、曲線の後半（右寄り）を少し優先し、
  // 式のラベルが曲線の終わり近くに付く慣習に合わせる。
  const inlineLabelOf = (
    samples: readonly Sample[],
    tex: string,
    at: number | undefined,
    placed: readonly Box[],
  ): Placement<Label> => {
    const size = glyphSizeOf(tex, LABEL_FONT);
    const visible = samples.filter(
      (s) =>
        s.ok &&
        s.x >= plotBounds.x0 &&
        s.x <= plotBounds.x1 &&
        s.y >= plotBounds.y0 &&
        s.y <= plotBounds.y1,
    );
    if (visible.length < 3) return NO_PLACEMENT;
    // 候補にする標本の番号。labelAt があれば媒介変数が最も近い 1 点、無ければ両端を除く 4 点おき。
    const idxs =
      at === undefined
        ? visible.flatMap((_, i) =>
            i >= 1 && i < visible.length - 1 && (i - 1) % 4 === 0 ? [i] : [],
          )
        : [
            visible.reduce(
              (k, s, i) => (Math.abs(s.t - at) < Math.abs(visible[k].t - at) ? i : k),
              0,
            ),
          ];
    const cands = idxs.flatMap((i) => {
      const a = visible[Math.max(0, i - 2)];
      const b = visible[Math.min(visible.length - 1, i + 2)];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const perp = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
      const off = normalLabelOffset(perp.x, perp.y, size);
      const pref = at === undefined ? Math.abs(i / (visible.length - 1) - 0.8) * 1.5 : 0;
      return [1, -1].map((sgn) => {
        const pos: LabelPos = {
          x: visible[i].x + sgn * perp.x * off,
          y: visible[i].y + sgn * perp.y * off,
          align: "center",
        };
        return { pos, pref, sgn };
      });
    });
    const best = bestOf(
      cands,
      (c) =>
        penaltyOf(glyphBox(c.pos, size), placed, undefined, viewBounds) +
        c.pref +
        (c.sgn === 1 ? 0 : 0.05),
    ).item;
    return placedLabel(tex, best === null ? null : best.pos, size);
  };
  const curveLabels = placeInOrder(curves, segmentLabels.placed, (c, i, placed) =>
    c.label !== undefined && c.labelPlacement === "inline"
      ? inlineLabelOf(curveSamples[i], c.label, c.labelAt, placed)
      : NO_PLACEMENT,
  );
  const paramLabels = placeInOrder(parametrics, curveLabels.placed, (pc, i, placed) =>
    pc.label !== undefined && pc.labelPlacement === "inline"
      ? inlineLabelOf(paramSamples[i], pc.label, pc.labelAt, placed)
      : NO_PLACEMENT,
  );

  // 等高線のラベル。線の上の位置を弧長に沿って候補にし、軸・目盛り・他の線・既出ラベルとの
  // 衝突、線の曲がり具合（急に曲がる位置ではラベルの外へ線がはみ出す）を罰点にして選ぶ。
  // 開いた線（窓の縁から縁へ渡る線）は中ほどを、閉じた線（円など）は右上を少し優先し、
  // 同心の等高線のラベルが斜めにそろいやすくする。収まる位置が無い短い線にはラベルを付けない。
  const contourPlacement = placeInOrder(
    contourData.flat(),
    paramLabels.placed,
    (lv, _, placed): Placement<ContourLabel> => {
      if (lv.label === undefined) return NO_PLACEMENT;
      const size = glyphSizeOf(lv.label, CONTOUR_FONT);
      // 字形の中心を線の上に置く。基準点の y は字形の中心より上にある。
      const lift = glyphCenterOffset(size);
      const w = size.width + 2 * CONTOUR_GAP_PAD;
      const h = size.bottom - size.top + 2 * CONTOUR_GAP_PAD;
      const cums = lv.lines.map((l) => cumulativeLength(l.pts));
      // ラベルが乗る線のうち、ラベルの中心から弧長でこの範囲にある部分は、ラベルが当然重なる
      // 部分として当たり判定から外す。範囲の外で同じ高さの線が矩形に入れば（交わる 2 本の
      // 等高線のもう一方など）、他の線と同じく罰点にする。
      const ownWindow = Math.hypot(w, h) / 2 + 2;
      const cands = lv.lines.flatMap((line, li) => {
        const cum = cums[li];
        const total = cum[cum.length - 1];
        if (total < w + 8) return [];
        const centroid = line.closed ? meanOf(line.pts) : null;
        const margin = line.closed ? 0 : w / 2 + 2;
        return accumulateSteps(margin, 4, total - margin).map((s) => {
          const p = pointAtLength(line.pts, cum, s, line.closed);
          const box = inflate(
            glyphBox({ x: p.x, y: p.y - lift, align: "center" }, size),
            CONTOUR_GAP_PAD,
          );
          return { line, li, cum, total, centroid, s, p, box };
        });
      });
      const best = bestOf(cands, (c, _k, bestP) => {
        // 等高線のラベルは格子線を避けない。線の上で置ける位置が限られ、格子線を避けると線の
        // 中ほどから大きく外れるためである。重なった格子線は、下の線と同じくマスクで切り抜く。
        const pen = penaltyOf(c.box, placed, lv.id, plotBounds, false);
        // 以下で足す罰点は 0 以上なので、この時点で最良に届かない候補は残りを調べない。
        if (pen >= bestP) return pen;
        const padded = inflate(c.box, LINE_CLEARANCE);
        const ownHit = lv.lines.some((other, oi) =>
          oi === c.li
            ? farPartHitsBox(other.pts, c.cum, c.s, ownWindow, c.line.closed, padded)
            : polylineHitsBox(other.pts, padded),
        );
        const pa = pointAtLength(c.line.pts, c.cum, c.s - w / 2, c.line.closed);
        const pb = pointAtLength(c.line.pts, c.cum, c.s + w / 2, c.line.closed);
        const turned = (ownHit ? pen + 6 : pen) + turnAngle(pa, c.p, pb) * 3;
        if (c.centroid === null) return turned + Math.abs(c.s / c.total - 0.5) * 2;
        const phi = Math.atan2(c.centroid.y - c.p.y, c.p.x - c.centroid.x);
        return turned + (1 - Math.cos(phi - Math.PI / 4));
      });
      if (best.item === null || !(best.score < 1000)) return NO_PLACEMENT;
      const { p, box } = best.item;
      const pos: LabelPos = { x: p.x, y: p.y - lift, align: "center" };
      return { item: { tex: lv.label, pos, box }, box };
    },
  );
  const contourLabels = contourPlacement.items.filter((l): l is ContourLabel => l !== null);

  // ---- 凡例 ----
  const legendItems: readonly LegendEntry[] =
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
          ...fields.flatMap((f) =>
            f.legendLabel === undefined
              ? []
              : [{ label: f.legendLabel, color: f.color ?? FIELD, dashed: false }],
          ),
        ];

  const allLabels = [
    ...regionLabels.items,
    ...polarLabels.items,
    ...cellLabels.items,
    ...segmentLabels.items,
    ...curveLabels.items,
    ...paramLabels.items,
    ...vectorLabels.items,
    ...pointLabels.items,
  ].filter((l): l is Label => l !== null);

  // 格子線（目盛りに沿った格子線と極座標の格子）を切り抜く矩形。すべてのラベルと目盛り数字の下で
  // 補助線を切り、線が字形を貫かないようにする。ハローは字の輪郭から 2〜3px しか覆わず、字の
  // すき間を通る線（「=」の 2 本の間、「−」に沿う線）を隠せないためである。背景色の矩形を重ねる
  // 方式と違い、領域の塗りを隠さない。等高線のラベルは、等高線を切る矩形と同じ範囲で切る。
  // 切り抜きとプロット矩形の縁の間に残る格子線が GRID_STUB_PX より短いときは、縁まで切り抜く。
  // ラベルの脇に数 px だけ残った線が、「=1_」のように字の続きに見えるのを防ぐ。
  const plotRight = originX + plotW;
  const plotBottom = originY + plotH;
  const toEdge = (b: Box): Box => ({
    x0: b.x0 < originX + GRID_STUB_PX ? Math.min(b.x0, originX - 1) : b.x0,
    x1: b.x1 > plotRight - GRID_STUB_PX ? Math.max(b.x1, plotRight + 1) : b.x1,
    y0: b.y0 < originY + GRID_STUB_PX ? Math.min(b.y0, originY - 1) : b.y0,
    y1: b.y1 > plotBottom - GRID_STUB_PX ? Math.max(b.y1, plotBottom + 1) : b.y1,
  });
  const gridCuts: readonly Box[] =
    grid || polar !== null
      ? [
          ...contourLabels.map((l) => l.box),
          ...allLabels.map((l) => inflate(l.box, GRID_CUT_PAD)),
          ...tickBoxes.map((b) => inflate(b, GRID_CUT_PAD)),
        ].map(toEdge)
      : [];
  const gridMaskRef = gridCuts.length > 0 ? `url(#${gridMask})` : undefined;

  // avoidLabels の場では、ラベル・目盛り数字の矩形に触れる矢印と零ベクトルの点を描かない。矢印を
  // マスクで部分的に切ると、矢じりの無い切れ端が残って向きを誤読させるため、1 本ごと省く。
  const fieldShown = fieldData.map((fd, i) => {
    if (fields[i].avoidLabels !== true) return fd;
    const boxes = [
      ...contourLabels.map((l) => l.box),
      ...allLabels.map((l) => inflate(l.box, 1)),
      ...tickBoxes.map((b) => inflate(b, GRID_CUT_PAD)),
    ];
    return {
      arrows: fd.arrows.filter((a) => !boxes.some((b) => segmentHitsBox(a.from, a.to, b))),
      dots: fd.dots.filter(
        (d) =>
          !boxes.some((b) =>
            boxesOverlap(inflate(b, FIELD_DOT_R), {
              x0: d.x,
              x1: d.x,
              y0: d.y,
              y1: d.y,
            }),
          ),
      ),
    };
  });

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
          {/* ラベル・目盛り数字の下だけ格子線を切り抜くマスク。等高線のマスクと同じ作りである。 */}
          {gridCuts.length > 0 && (
            <mask id={gridMask} maskUnits="userSpaceOnUse" x={0} y={0} width={viewW} height={viewH}>
              <rect x={0} y={0} width={viewW} height={viewH} fill="#fff" />
              {gridCuts.map((b, i) => (
                <rect
                  key={`gm-${i}`}
                  x={round2(b.x0)}
                  y={round2(b.y0)}
                  width={round2(b.x1 - b.x0)}
                  height={round2(b.y1 - b.y0)}
                  rx={3}
                  fill="#000"
                />
              ))}
            </mask>
          )}
        </defs>

        {/* 目盛りに沿った格子線。@visx/grid の GridColumns・GridRows で描く。 */}
        {grid && (
          <g mask={gridMaskRef}>
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
          </g>
        )}

        <Group clipPath={`url(#${clip})`}>
          {/* 極座標の格子。軸と同じ淡い色の細線で描き、主役の曲線・領域より沈める。 */}
          {polar !== null && (
            <g fill="none" stroke={AXIS} strokeWidth={1} mask={gridMaskRef}>
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
                    data={[...e]}
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
          {/* 領域の境界の向きを示す矢じり。 */}
          {regionHeads.map((h, i) => (
            <polygon key={`rh-${i}`} points={h.head} fill={h.color} />
          ))}

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
                    data={[...l.pts]}
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

          {/* ベクトル場。等高線より前面、曲線より奥に描き、閉曲線などの主役の線を矢印の上に残す。
              矢印は数百本になりうるため、場ごとに全矢印の軸を 1 本の path、矢じりを 1 本の path に
              まとめて SVG を軽くする。不透明度は g にかけ、軸と矢じりの重なりが濃くならないようにする。 */}
          {fieldShown.map((fd, i) => {
            const f = fields[i];
            const color = f.color ?? FIELD;
            const { shafts, heads } = arrowPaths(fd.arrows, FIELD_HEAD_LEN, FIELD_HEAD_HALF);
            return (
              <g key={`fd-${i}`} opacity={f.opacity}>
                {shafts !== "" && (
                  <path
                    d={shafts}
                    fill="none"
                    stroke={color}
                    strokeWidth={f.width ?? FIELD_WIDTH}
                    strokeLinecap="round"
                  />
                )}
                {heads !== "" && <path d={heads} fill={color} />}
                {fd.dots.map((d, k) => (
                  <Circle key={`fz-${i}-${k}`} cx={d.x} cy={d.y} r={FIELD_DOT_R} fill={color} />
                ))}
              </g>
            );
          })}

          {/* 曲線。 */}
          {curves.map((c, i) => (
            <LinePath<Sample>
              key={`cv-${i}`}
              data={[...curveSamples[i]]}
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
              data={[...paramSamples[i]]}
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
          {/* 曲線の向きを示す矢じり。 */}
          {curveHeads.map((h, i) => (
            <polygon key={`ch-${i}`} points={h.head} fill={h.color} />
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
            fontSize={LABEL_FONT}
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
              fontSize={TICK_FONT}
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
              fontSize={TICK_FONT}
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
): Readonly<{
  viewW: number;
  viewH: number;
  originX: number;
  originY: number;
  plotW: number;
  plotH: number;
}> {
  const viewW = width;
  const availW = viewW - 2 * PAD;
  if (!equalScale) {
    const viewH = height ?? DEFAULT_H;
    return { viewW, viewH, originX: PAD, originY: PAD, plotW: availW, plotH: viewH - 2 * PAD };
  }
  const fitW = availW / xr;
  const unit =
    height === undefined
      ? Math.min(fitW, MAX_AUTO_PLOT_H / yr)
      : Math.min(fitW, (height - 2 * PAD) / yr);
  const viewH = height === undefined ? Math.round(unit * yr + 2 * PAD) : height;
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
type Step = Readonly<{ num: number; den: number }>;

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

/**
 * 格子点での関数値。等高線の全レベルで共有する。fn は交点を精密化するために持つ。lo・hi は
 * 有限な値の最小と最大で、どのレベルでも同じため標本化のときに 1 度だけ求める。
 */
type ScalarGrid = Readonly<{
  fn: (x: number, y: number) => number;
  nx: number;
  ny: number;
  xs: readonly number[];
  ys: readonly number[];
  v: Readonly<Float64Array>;
  lo: number;
  hi: number;
}>;

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
  // 格子点 (i, j) の値を添字 j * (nx + 1) + i に置く。格子点は数十万になるため、型付き配列へ
  // 行（j）ごとに左から右へ直接書き込み、同じ走査で有限な値の [最小, 最大] を更新する（どちらも
  // この関数の中に閉じた可変のバッファ）。最小・最大は、書き込んだ後の（数値に変換した）値で求める。
  const v = new Float64Array(xs.length * ys.length);
  const range = [Infinity, -Infinity];
  ys.forEach((yv, j) => {
    xs.forEach((xv, i) => {
      const k = j * (nx + 1) + i;
      v[k] = fn(xv, yv);
      const w = v[k];
      if (Number.isFinite(w)) {
        range[0] = Math.min(range[0], w);
        range[1] = Math.max(range[1], w);
      }
    });
  });
  return { fn, nx, ny, xs, ys, v, lo: range[0], hi: range[1] };
}

/**
 * 区間 [lo, hi] を覆う、origin から刻み h の整数倍の格子点の座標（両端は区間の外側の格子点まで
 * 広げる）。origin が 0 のときは i * num / den で求め、x と y で同じ添字の座標を完全に一致させる。
 */
function gridCoords(lo: number, hi: number, h: Step, origin: number): readonly number[] {
  const i0 = Math.floor(((lo - origin) * h.den) / h.num);
  const i1 = Math.ceil(((hi - origin) * h.den) / h.num);
  return intRange(i0, i1).map((i) => origin + (i * h.num) / h.den);
}

/** 等高線の 1 本の折れ線。closed は始点に戻る閉じた線（円など）か。 */
type ContourLine = Readonly<{ pts: readonly XY[]; closed: boolean }>;

/**
 * 1 つの高さの等高線を、marching squares 法で折れ線の集まりとして求める。
 *
 * 値が高さ以上の格子点を「上」、未満を「下」とし、上下が入れ替わる辺に交点を置く。交点は辺の
 * 両端の値から線形補間で求める。交点にはどの辺の上か（端点ちょうどなら格子点）を表すキーを付け、
 * 隣り合うセルが同じ交点を共有する。線分はキーでつなぐため、浮動小数の比較なしに折れ線が閉じる。
 * 「以上」の判定を全体で統一し、等高線が格子点や格子線の上をちょうど通る場合（xy=0 の座標軸
 * など）も、線が重複したり欠けたりしないようにする（長さ 0 の線分と重複する線分は捨てる）。
 *
 * 格子は数十万のセルになるため、交点の表・線分の列・隣接の表・使用済みの印は、この関数の中に
 * 閉じた可変のバッファに積む。作り直すとセルの数に比例した複製が重なり、ビルドが遅くなる。
 */
function traceLevel(g: ScalarGrid, target: number): readonly ContourLine[] {
  const { fn, nx, ny, xs, ys, v, lo, hi } = g;
  const stride = nx + 1;
  const at = (i: number, j: number): number => v[j * stride + i];
  // 交点のキーから座標への表（局所の可変バッファ）。辺の交点は隣り合う 2 つのセルから求められる
  // ため、根の精密化を 1 辺 1 回にとどめるよう覚えておく。
  const pos = new Map<string, XY>();

  // 高さを値の幅のごく一部（1e-9 倍）だけずらして追跡する。格子点の値が高さにちょうど等しい
  // 場合（x=1 上で 0 になる (x-1)(y-0.3) の c=0 など）、格子点を上下どちらに数えても、別の
  // 等高線との交点が隣の格子点へ寄り、交差に折れが出る。ずらすと等しい格子点が無くなり、
  // 交点はすべて辺の内側に来る。ずれは描画に表れない大きさである。
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

  // 線分の列（局所の可変バッファ）。seen で重複する線分を捨てる。
  const segs: (readonly [string, string])[] = [];
  const seen = new Set<string>();
  const addSeg = (a: string, b: string): void => {
    if (a === b) return;
    const id = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(id)) return;
    seen.add(id);
    segs.push([a, b]);
  };

  const cols = indices(nx);
  for (const j of indices(ny)) {
    for (const i of cols) {
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
  // 端点ごとの線分の番号の表（局所の可変バッファ）。
  const adj = new Map<string, number[]>();
  segs.forEach(([a, b], k) => {
    for (const key of [a, b]) {
      const list = adj.get(key);
      if (list === undefined) adj.set(key, [k]);
      else list.push(k);
    }
  });
  // 使用済みの線分の印（局所の可変バッファ）。たどるたびに書き換え、次にたどる線の選び方を決める。
  const used = new Uint8Array(segs.length);
  const walk = (start: string): readonly string[] => {
    // たどった交点のキーを積む（局所の可変バッファ）。1 本の線が数千の交点を持ちうるため。
    const keys = [start];
    for (;;) {
      const cur = keys[keys.length - 1];
      const next = (adj.get(cur) ?? []).find((k) => used[k] === 0);
      if (next === undefined) return keys;
      used[next] = 1;
      const [a, b] = segs[next];
      keys.push(a === cur ? b : a);
    }
  };
  // 端点 key から、未使用の線分が残る限りたどり直す。たどる順は配列の要素の評価順で決まる。
  const walksFrom = (key: string, list: readonly number[]): readonly (readonly string[])[] =>
    list.some((k) => used[k] === 0) ? [walk(key), ...walksFrom(key, list)] : [];
  const openWalks = [...adj].flatMap(([key, list]) =>
    list.length % 2 === 0 ? [] : walksFrom(key, list),
  );
  const closedWalks = segs.flatMap(([a], k) => (used[k] === 0 ? [walk(a)] : []));
  return [...openWalks, ...closedWalks].flatMap((keys): readonly ContourLine[] =>
    keys.length < 2
      ? []
      : [
          {
            pts: keys.map((k) => pos.get(k) ?? { x: Number.NaN, y: Number.NaN }),
            closed: keys.length > 2 && keys[0] === keys[keys.length - 1],
          },
        ],
  );
}

/** Illinois 法の 1 段の状態。[a, b] は根をはさむ区間、t は次に評価する点である。 */
type RootBracket = Readonly<{
  a: number;
  b: number;
  fa: number;
  fb: number;
  t: number;
  side: number;
}>;

/**
 * 区間 [0, 1] で符号の変わる関数 g の根を Illinois 法（はさみうち法の改良）で求める。t は線形
 * 補間による初期値、fa・fb は両端での g の値である。途中で値が有限でなくなれば初期値を返す。
 */
function refineRoot(
  g: (s: number) => number,
  init: Readonly<{ t: number; fa: number; fb: number }>,
): number {
  // 1 段ずつ区間を縮める。段数は高々 12 で、再帰の深さも 12 にとどまる。
  const iterate = (st: RootBracket, k: number): number => {
    if (!(k < 12 && st.b - st.a > 1e-9)) return clamp(st.t, 0, 1);
    const ft = g(st.t);
    if (!Number.isFinite(ft)) return init.t;
    if (ft === 0) return st.t;
    const next =
      ft > 0 === st.fb > 0
        ? { a: st.a, b: st.t, fa: st.side === -1 ? st.fa / 2 : st.fa, fb: ft, side: -1 }
        : { a: st.t, b: st.b, fa: ft, fb: st.side === 1 ? st.fb / 2 : st.fb, side: 1 };
    return iterate(
      { ...next, t: (next.a * next.fb - next.b * next.fa) / (next.fb - next.fa) },
      k + 1,
    );
  };
  return iterate({ a: 0, b: 1, fa: init.fa, fb: init.fb, t: init.t, side: 0 }, 0);
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
type Extent = Readonly<{ x0: number; x1: number; y0: number; y1: number }>;

/** 領域の塗りの多角形と、描く境界の折れ線（数学座標）。 */
type RegionShape = Readonly<{ fill: readonly XY[]; edges: readonly (readonly XY[])[] }>;

/**
 * 領域の塗りの多角形と、描く境界の折れ線を求める（数学座標）。省いた側の端は描画窓の外
 * （ext の縁）に置き、境界線を描かない。窓の外へ出る値は ext の縁に丸め、無限大でも塗りが
 * 壊れないようにする。
 */
function regionGeometry(r: Region, ext: Extent): RegionShape {
  switch (r.kind) {
    case "polygon": {
      const pts = r.points;
      return { fill: pts, edges: pts.length > 1 ? [[...pts, pts[0]]] : [] };
    }
    case "between-x": {
      const [a, b] = r.x ?? [ext.x0, ext.x1];
      const lowerFn = r.lower ?? (() => ext.y0);
      const upperFn = r.upper ?? (() => ext.y1);
      // 下側と上側の曲線を、標本点ごとに下・上の順で評価する。
      const pairs = upTo(SAMPLES).map((i) => {
        const xv = a + ((b - a) * i) / SAMPLES;
        return {
          lower: { x: xv, y: clampTo(lowerFn(xv), ext.y0, ext.y1) },
          upper: { x: xv, y: clampTo(upperFn(xv), ext.y0, ext.y1) },
        };
      });
      const lower = pairs.map((p) => p.lower);
      const upper = pairs.map((p) => p.upper);
      return { fill: [...lower, ...upper.toReversed()], edges: betweenEdges(r, lower, upper) };
    }
    case "between-y": {
      const [c, d] = r.y ?? [ext.y0, ext.y1];
      const leftFn = r.left ?? (() => ext.x0);
      const rightFn = r.right ?? (() => ext.x1);
      // 左側と右側の曲線を、標本点ごとに左・右の順で評価する。
      const pairs = upTo(SAMPLES).map((i) => {
        const yv = c + ((d - c) * i) / SAMPLES;
        return {
          left: { x: clampTo(leftFn(yv), ext.x0, ext.x1), y: yv },
          right: { x: clampTo(rightFn(yv), ext.x0, ext.x1), y: yv },
        };
      });
      const left = pairs.map((p) => p.left);
      const right = pairs.map((p) => p.right);
      const edges = [
        ...(r.left === undefined ? [] : [left]),
        ...(r.right === undefined ? [] : [right]),
        ...(r.y === undefined
          ? []
          : [
              [left[0], right[0]],
              [left[left.length - 1], right[right.length - 1]],
            ]),
      ];
      return { fill: [...left, ...right.toReversed()], edges };
    }
    case "parametric": {
      const n = Math.max(3, r.samples ?? PARAM_SAMPLES);
      const pts = upTo(n).map((i) => {
        const p = r.fn(r.tMin + ((r.tMax - r.tMin) * i) / n);
        return { x: clampTo(p.x, ext.x0, ext.x1), y: clampTo(p.y, ext.y0, ext.y1) };
      });
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
  // 外側と内側の弧を、角ごとに外・内の順で評価する。
  const arcs = upTo(SAMPLES).map((i) => {
    const t = t1 + ((t2 - t1) * i) / SAMPLES;
    return { outer: at(radialAt(rOut, t), t), inner: at(radialAt(rIn, t), t) };
  });
  const outer = arcs.map((p) => p.outer);
  const inner = arcs.map((p) => p.inner);
  // 内側の端が 0（扇形）なら、内側の弧は極の 1 点に縮む。
  const pointInner = rIn === 0;
  const full = Math.abs(t2 - t1) >= 2 * Math.PI - 1e-9;
  const edges = [
    outer,
    ...(pointInner ? [] : [inner]),
    // 一周する領域（円板・円環）には、始まりの角の継ぎ目に動径の線分を描かない。
    ...(full
      ? []
      : [
          [inner[0], outer[0]],
          [inner[SAMPLES], outer[SAMPLES]],
        ]),
  ];
  return { fill: [...outer, ...(pointInner ? [c] : inner.toReversed())], edges };
}

/** 動径の範囲の端を、角 t での値にする。 */
function radialAt(b: RadialBound, t: number): number {
  return typeof b === "number" ? b : b(t);
}

/** `between-x` の境界の折れ線。指定のある曲線と、区間の両端の縦の線分だけを返す。 */
function betweenEdges(
  r: BetweenXRegion,
  lower: readonly XY[],
  upper: readonly XY[],
): readonly (readonly XY[])[] {
  const n = lower.length - 1;
  return [
    ...(r.lower === undefined ? [] : [lower]),
    ...(r.upper === undefined ? [] : [upper]),
    ...(r.x === undefined
      ? []
      : [
          [lower[0], upper[0]],
          [lower[n], upper[n]],
        ]),
  ];
}

/** 分割の格子の画面上の要素（格子線・強調する小長方形・代表点・外周）。 */
function partitionGeometry(
  p: Partition,
  toScreen: (q: XY) => XY,
  sx: (v: number) => number,
  sy: (v: number) => number,
): Readonly<{
  lines: readonly Readonly<{ pts: readonly XY[]; outer: boolean }>[];
  highlights: readonly Readonly<{ box: Box; cx: number; cy: number; label?: string }>[];
  samples: readonly XY[];
  outer: Box;
}> {
  const [a, b] = p.x;
  const [c, d] = p.y;
  const m = Math.max(1, Math.round(p.m));
  const n = Math.max(1, Math.round(p.n));
  const xk = (k: number) => a + ((b - a) * k) / m;
  const yk = (k: number) => c + ((d - c) * k) / n;
  const lines = [
    ...upTo(m).map((k) => ({
      pts: [toScreen({ x: xk(k), y: c }), toScreen({ x: xk(k), y: d })],
      outer: k === 0 || k === m,
    })),
    ...upTo(n).map((k) => ({
      pts: [toScreen({ x: a, y: yk(k) }), toScreen({ x: b, y: yk(k) })],
      outer: k === 0 || k === n,
    })),
  ];
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
  // 代表点は小長方形の番号 (i, j) の順（j ごとに i を 1 から m まで）に並べる。
  const sample = p.samples;
  const samples =
    sample === undefined
      ? []
      : intRange(1, n).flatMap((j) =>
          intRange(1, m).map((i) => toScreen(samplePoint(sample, i, j))),
        );
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
function clippedCentroid(poly: readonly XY[], win: Box): XY | null {
  const edges: readonly (readonly [(p: XY) => boolean, (p: XY, q: XY) => XY])[] = [
    [(p) => p.x >= win.x0, (p, q) => lerpAt(p, q, (win.x0 - p.x) / (q.x - p.x))],
    [(p) => p.x <= win.x1, (p, q) => lerpAt(p, q, (win.x1 - p.x) / (q.x - p.x))],
    [(p) => p.y >= win.y0, (p, q) => lerpAt(p, q, (win.y0 - p.y) / (q.y - p.y))],
    [(p) => p.y <= win.y1, (p, q) => lerpAt(p, q, (win.y1 - p.y) / (q.y - p.y))],
  ];
  // 窓の 4 辺で順に切り取る。途中で頂点が無くなれば null にし、以降の辺では切らない。
  const pts = edges.reduce<readonly XY[] | null>((cur, [inside, cut]) => {
    if (cur === null) return null;
    const out = cur.flatMap((q, k) => {
      const prev = cur[(k + cur.length - 1) % cur.length];
      if (inside(q)) return inside(prev) ? [q] : [cut(prev, q), q];
      return inside(prev) ? [cut(prev, q)] : [];
    });
    return out.length === 0 ? null : out;
  }, poly);
  if (pts === null) return null;
  const sum = pts.reduce(
    (acc, p, k) => {
      const q = pts[(k + 1) % pts.length];
      const cross = p.x * q.y - q.x * p.y;
      return {
        area: acc.area + cross,
        cx: acc.cx + (p.x + q.x) * cross,
        cy: acc.cy + (p.y + q.y) * cross,
      };
    },
    { area: 0, cx: 0, cy: 0 },
  );
  // 面積がほぼ 0（線状の図形）のときは、頂点の平均で代える。
  if (Math.abs(sum.area) < 1e-12) return meanOf(pts);
  return { x: sum.cx / (3 * sum.area), y: sum.cy / (3 * sum.area) };
}

function meanOf(pts: readonly XY[]): XY {
  const n = pts.length || 1;
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / n,
    y: pts.reduce((s, p) => s + p.y, 0) / n,
  };
}

// ======================================================================
// ベクトル場と向きの矢じり
// ======================================================================

/** 画面上の矢印（始点・終点）。 */
type ScreenArrow = Readonly<{ from: XY; to: XY }>;

/**
 * ベクトル場を格子点（または at の点）で評価し、画面上の矢印と、零ベクトルを示す点にする。
 * 長さは座標の単位で決めてから両端を toScreen で写し、横縦の縮尺が異なる図でも矢印の成分を
 * 座標どおりに保つ。画面上で FIELD_MIN_PX より短い矢印は向きが読めないため、零ベクトルと同じに
 * 扱う。
 */
function fieldGeometry(
  f: VectorField,
  win: Box,
  toScreen: (p: XY) => XY,
): Readonly<{ arrows: readonly ScreenArrow[]; dots: readonly XY[] }> {
  const [hx, hy] = typeof f.step === "number" ? [f.step, f.step] : (f.step ?? [1, 1]);
  // 公開 props の間隔に 0 や負数が来ても、格子点の列挙が止まるよう 1 に置き換える。
  const stepX = hx > 0 ? hx : 1;
  const stepY = hy > 0 ? hy : 1;
  const origin = f.origin ?? { x: 0, y: 0 };
  const base: readonly XY[] =
    f.at ??
    stepsIn(f.y ?? [win.y0, win.y1], stepY, origin.y, f.y === undefined).flatMap((yv) =>
      stepsIn(f.x ?? [win.x0, win.x1], stepX, origin.x, f.x === undefined).map((xv) => ({
        x: xv,
        y: yv,
      })),
    );
  const samples = base.flatMap((p) => {
    if (f.hide?.(p.x, p.y) === true) return [];
    const v = f.fn(p.x, p.y);
    if (v === null || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return [];
    return [{ p, v, mag: Math.hypot(v.x, v.y) }];
  });
  // 自動の倍率は、最も長い矢印（normalize ならすべての矢印）を格子間隔より短くし、隣の格子点の
  // 矢印と重ならないようにする。点の列で渡したときは格子間隔が無いため、ベクトルをそのまま描く。
  const unit = Math.min(stepX, stepY);
  const maxMag = samples.reduce((m, s) => Math.max(m, s.mag), 0);
  const autoScale =
    f.at !== undefined
      ? 1
      : f.normalize === true
        ? 0.7 * unit
        : maxMag > 0
          ? (0.85 * unit) / maxMag
          : 1;
  const scale = f.scale ?? autoScale;
  const placedArrows = samples.map(({ p, v, mag }) => {
    const rawLen = mag > 0 ? (f.normalize === true ? scale : scale * mag) : 0;
    const len = f.maxLength === undefined ? rawLen : Math.min(rawLen, f.maxLength);
    const d = mag > 0 ? { x: (v.x / mag) * len, y: (v.y / mag) * len } : { x: 0, y: 0 };
    const start = f.pivot === "center" ? { x: p.x - d.x / 2, y: p.y - d.y / 2 } : p;
    const from = toScreen(start);
    const to = toScreen({ x: start.x + d.x, y: start.y + d.y });
    return { p, from, to, visible: Math.hypot(to.x - from.x, to.y - from.y) >= FIELD_MIN_PX };
  });
  return {
    arrows: placedArrows.flatMap((a) => (a.visible ? [{ from: a.from, to: a.to }] : [])),
    dots: f.zero === "dot" ? placedArrows.flatMap((a) => (a.visible ? [] : [toScreen(a.p)])) : [],
  };
}

/**
 * 区間 [lo, hi] にある、origin から step の整数倍の位置を小さい順に返す。open なら両端の上の
 * 位置を除く（開区間）。端との一致は step の 1e-9 倍の誤差まで許す。
 */
function stepsIn(
  range: readonly [number, number],
  step: number,
  origin: number,
  open = false,
): readonly number[] {
  const lo = (Math.min(...range) - origin) / step;
  const hi = (Math.max(...range) - origin) / step;
  const k0 = open ? Math.floor(lo + 1e-9) + 1 : Math.ceil(lo - 1e-9);
  const k1 = open ? Math.ceil(hi - 1e-9) - 1 : Math.floor(hi + 1e-9);
  const count = Math.max(0, Math.min(k1 - k0 + 1, FIELD_MAX_STEPS));
  // 先頭は k0 そのもの（-0 を +0 に変えない）、以降は k0 に 1 ずつ足した値にする。
  return Array.from({ length: count }, (_, j) => origin + (j === 0 ? k0 : k0 + j) * step);
}

/**
 * 矢印の列を、全矢印の軸をつないだ path と、全矢じりをつないだ path の d 属性にする。矢じりの
 * 形と短い矢印での縮め方は、通常の矢印（vectors）と同じである。軸は矢じりの根元で止め、矢じりと
 * 重ねない。
 */
function arrowPaths(
  arrows: readonly ScreenArrow[],
  headLen: number,
  headHalf: number,
): Readonly<{ shafts: string; heads: string }> {
  const parts = arrows.flatMap(({ from, to }) => {
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    if (!(len > 0)) return [];
    const ux = (to.x - from.x) / len;
    const uy = (to.y - from.y) / len;
    const hl = Math.min(headLen, len * 0.8);
    const hh = headHalf * (hl / headLen);
    const bx = to.x - hl * ux;
    const by = to.y - hl * uy;
    return [
      {
        shaft: `M${round2(from.x)} ${round2(from.y)}L${round2(bx)} ${round2(by)}`,
        head:
          `M${round2(to.x)} ${round2(to.y)}` +
          `L${round2(bx - hh * uy)} ${round2(by + hh * ux)}` +
          `L${round2(bx + hh * uy)} ${round2(by - hh * ux)}Z`,
      },
    ];
  });
  return {
    shafts: parts.map((q) => q.shaft).join(""),
    heads: parts.map((q) => q.head).join(""),
  };
}

/** ArrowMarks を、矢じりを置く媒介変数の値の列にする。 */
function arrowParams(marks: ArrowMarks | undefined, lo: number, hi: number): readonly number[] {
  if (marks === undefined) return [];
  if (typeof marks !== "number") return marks;
  const n = Math.max(0, Math.round(marks));
  return Array.from({ length: n }, (_, k) => lo + ((hi - lo) * (k + 0.5)) / n);
}

/**
 * 曲線 fn の上に置く向きの矢じり（polygon の points 属性）の列。矢じりの中心を曲線の上の点に
 * 合わせ、媒介変数を lo から hi の順に進む向きへ向ける。接線は前後のごく近い 2 点の画面上の差で
 * 求める。点が描く範囲（inExt）の外にある位置と、接線が求まらない位置には置かない。
 */
function orientationHeads(
  fn: (t: number) => XY,
  marks: ArrowMarks | undefined,
  lo: number,
  hi: number,
  toPx: (p: XY) => XY,
  inExt: (p: XY) => boolean,
): readonly string[] {
  // 差分の刻みは範囲に符号付きで比例させ、hi < lo（逆向きにたどる指定）でも進む向きを指す。
  const h = (hi - lo) * 1e-3;
  // 差分の評価点を範囲の中に収める。端の点では片側の差分になり、範囲の外で例外を投げる関数も呼ばない。
  const clampT = (s: number) => Math.min(Math.max(s, Math.min(lo, hi)), Math.max(lo, hi));
  return arrowParams(marks, lo, hi).flatMap((t) => {
    const p = fn(t);
    if (!inExt(p)) return [];
    const c = toPx(p);
    const tb = clampT(t - h);
    const ta = clampT(t + h);
    const before = tb === t ? p : fn(tb);
    const after = ta === t ? p : fn(ta);
    const a = inExt(before) ? toPx(before) : c;
    const b = inExt(after) ? toPx(after) : c;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(len > 1e-9)) return [];
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const tip = { x: c.x + (ux * HEAD_LEN) / 2, y: c.y + (uy * HEAD_LEN) / 2 };
    const bx = c.x - (ux * HEAD_LEN) / 2;
    const by = c.y - (uy * HEAD_LEN) / 2;
    return [
      `${round2(tip.x)},${round2(tip.y)} ` +
        `${round2(bx - HEAD_HALF * uy)},${round2(by + HEAD_HALF * ux)} ` +
        `${round2(bx + HEAD_HALF * uy)},${round2(by - HEAD_HALF * ux)}`,
    ];
  });
}

// ======================================================================
// 曲線の標本と折れ線の幾何
// ======================================================================

/** 曲線の 1 標本（画面座標）。ok は描く範囲内かつ有限か。t は元の x または媒介変数。 */
type Sample = Readonly<{ x: number; y: number; ok: boolean; t: number }>;

/** 標本列から、描く範囲内の連続した部分ごとの折れ線を取り出す（ラベル配置の障害物に使う）。 */
function visiblePieces(samples: readonly Sample[]): readonly (readonly XY[])[] {
  // 描く範囲内の連続した部分の始まり（直前が範囲外か先頭の、範囲内の標本）の番号。
  const starts = samples.flatMap((s, k) => (s.ok && (k === 0 || !samples[k - 1].ok) ? [k] : []));
  // 終わり（直前が範囲内の、範囲外の標本）の番号。始まりと終わりは交互に現れるので、i 番目の終わりが
  // i 番目の始まりに対応する。始まりごとに先頭から探すと、標本数 × 部分の数の時間がかかる。
  const ends = samples.flatMap((s, k) => (!s.ok && k > 0 && samples[k - 1].ok ? [k] : []));
  return starts.map((start, i) =>
    samples.slice(start, ends.at(i) ?? samples.length).map((s) => ({ x: s.x, y: s.y })),
  );
}

/**
 * 折れ線を Ramer–Douglas–Peucker 法で間引く。始点と終点を結ぶ線分から最も離れた頂点が eps を
 * 超えれば残して両側を再帰的に調べ、超えなければ間の頂点を捨てる。閉じた線（始点と終点が同じ）
 * でも、線分の長さが 0 のときは点からの距離で測るため正しく間引ける。
 */
function simplifyPolyline(pts: readonly XY[], eps: number): readonly XY[] {
  if (pts.length <= 2) return pts;
  // 再帰で両側を調べると、最遠点が端に偏る折れ線（鋸歯状など）で深さが頂点数に比例し、スタックが
  // あふれる。関数の中に閉じた明示のスタックと、残す頂点の印（局所の可変バッファ）で走査する。
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: (readonly [number, number])[] = [[0, pts.length - 1]];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [a, b] = top;
    // 頂点 a と b の間で最も離れた頂点。同点なら前の頂点を選ぶ。
    const far = indices(b - a - 1).reduce<Readonly<{ d: number; k: number }>>(
      (best, o) => {
        const k = a + 1 + o;
        const d = distanceToSegment(pts[k], pts[a], pts[b]);
        return d > best.d ? { d, k } : best;
      },
      { d: -1, k: -1 },
    );
    if (far.k >= 0 && far.d > eps) {
      keep[far.k] = 1;
      stack.push([a, far.k], [far.k, b]);
    }
  }
  return pts.filter((_, k) => keep[k] === 1);
}

// ======================================================================
// ラベル配置の当たり判定
// ======================================================================

/** ラベル配置の障害物となる矩形と、重なったときの罰点。 */
type BoxObstacle = Readonly<{ box: Box; weight: number }>;

/** ラベル配置の障害物となる折れ線。id が同じ線（ラベル自身の線）は判定から外せる。 */
type LineObstacle = Readonly<{ id: string; pts: readonly XY[]; weight: number; bbox: Box }>;

/** 置いたラベル（LaTeX・配置先・字形の矩形）。 */
type Label = Readonly<{ tex: string; pos: LabelPos; box: Box }>;

/** 置いた等高線のラベル。box は字形の矩形でなく、等高線を切り抜く矩形である。 */
type ContourLabel = Label;

/** 1 つのラベルを置いた結果。item は置いたもの、box はそれが占める矩形（置かなければ null）。 */
type Placement<T> = Readonly<{ item: T | null; box: Box | null }>;

/** 何も置かない結果。 */
const NO_PLACEMENT: Placement<never> = { item: null, box: null };

/** 凡例の 1 項目。 */
type LegendEntry = Readonly<{ label: string; color: string; dashed: boolean }>;

/**
 * sources の順にラベルを 1 つずつ置く。place には、それまでに置いたラベルの占有矩形 placed を
 * 渡し、後のラベルが先のラベルを避けられるようにする。置いた結果（sources と同じ順）と、最後の
 * 占有矩形の列を返す。
 */
function placeInOrder<S, T>(
  sources: readonly S[],
  placed: readonly Box[],
  place: (source: S, index: number, placed: readonly Box[]) => Placement<T>,
): Readonly<{ items: readonly (T | null)[]; placed: readonly Box[] }> {
  return sources.reduce<Readonly<{ items: readonly (T | null)[]; placed: readonly Box[] }>>(
    (acc, source, i) => {
      const r = place(source, i, acc.placed);
      return {
        items: [...acc.items, r.item],
        placed: r.box === null ? acc.placed : [...acc.placed, r.box],
      };
    },
    { items: [], placed },
  );
}

/**
 * 候補のうち、罰点 score が最も小さいものとその罰点を返す。同点なら前方の候補を選ぶ。score には
 * それまでの最小の罰点を渡し、届かないと分かった候補の計算を打ち切れるようにする（打ち切るときは
 * その最小以上の値を返す）。候補が無いか、どの罰点も Infinity より小さくなければ item は null になる。
 */
function bestOf<T>(
  cands: readonly T[],
  score: (cand: T, index: number, bestScore: number) => number,
): Readonly<{ item: T | null; score: number }> {
  return cands.reduce<Readonly<{ item: T | null; score: number }>>(
    (best, cand, i) => {
      const p = score(cand, i, best.score);
      return p < best.score ? { item: cand, score: p } : best;
    },
    { item: null, score: Infinity },
  );
}

/** 2 点以上ある折れ線を、ラベル配置の障害物にする（1 点以下なら障害物にしない）。 */
function lineObstacle(id: string, pts: readonly XY[], weight: number): readonly LineObstacle[] {
  return pts.length >= 2 ? [{ id, pts, weight, bbox: bboxOf(pts) }] : [];
}

/** 線分・ベクトルとラベル矩形の間に空けるすきま（viewBox 単位）。 */
const SEG_LABEL_GAP = 5.5;

/**
 * 線分・ベクトルの中点から法線方向へ、ラベル中心を離す距離を求める。ラベルの字形の矩形を
 * 単位法線 (perpX, perpY) へ射影した半幅に、すきまを足す。
 */
function normalLabelOffset(perpX: number, perpY: number, size: GlyphSize): number {
  const h = size.bottom - size.top;
  return (Math.abs(perpX) * size.width) / 2 + (Math.abs(perpY) * h) / 2 + SEG_LABEL_GAP;
}

/** 線とラベルの間に残すすきま（px）。線との当たり判定で、ラベルの矩形をこの幅だけ広げる。 */
const LINE_CLEARANCE = 1.5;

/** ラベルどうしの間に残したいすきま（px）。これより近いと軽い罰点を与える。 */
const LABEL_SPACING = 4;

// ======================================================================
// 数値の補助
// ======================================================================

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
function autoTicks(lo: number, hi: number): readonly number[] {
  return intRange(Math.ceil(lo), Math.floor(hi)).filter((v) => v !== 0);
}

/** 0 以上 n 未満の整数の列（0, 1, …, n−1）。 */
function indices(n: number): readonly number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** 0 以上 n 以下の整数の列（0, 1, …）。n が整数でなければ n を超えない整数までにする。 */
function upTo(n: number): readonly number[] {
  return indices(Math.floor(n) + 1);
}

/** 整数 lo から hi まで（両端を含む）の列。先頭は lo そのものにし、-0 を +0 に変えない。 */
function intRange(lo: number, hi: number): readonly number[] {
  return Array.from({ length: Math.max(0, hi - lo + 1) }, (_, k) => (k === 0 ? lo : lo + k));
}

/**
 * start から step ずつ足していき、end 以下の値を順に返す。start + k * step と掛け算で求めると
 * 浮動小数の丸めが変わるため、直前の値に足して求める。値を作り直さずに積むよう、この関数の中に
 * 閉じた可変の配列を使う。
 */
function accumulateSteps(start: number, step: number, end: number): readonly number[] {
  if (!(start <= end)) return [];
  const out = [start];
  while (out[out.length - 1] + step <= end) out.push(out[out.length - 1] + step);
  return out;
}
