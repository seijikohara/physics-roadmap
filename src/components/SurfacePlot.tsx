import { LinePath } from "@visx/shape";
import { Fragment } from "react";
import {
  anchoredCandidates,
  aroundPoint,
  besideCurve,
  besideSegmentCandidates,
  besideVectorCandidates,
  centeredAt,
  insideRegion,
  lineLabelCandidates,
  pointPositions,
  positionCandidates,
  preferringOwnMark,
  widelyAroundPoint,
  withPenalty,
  type CurvePoint,
  type LabelDirSpec,
} from "./figure-label/candidates";
import { chainEdges, type Box, type XY } from "./figure-label/geometry";
import { glyphBox, glyphSizeOf, type GlyphSize, type LabelPos } from "./figure-label/label-box";
import { boxObstacle, groupObstacle, lineObstacle } from "./figure-label/obstacles";
import { createPlacer, placedLabel, placeInOrder, type Candidate } from "./figure-label/placer";
import { FIELD_PENALTY_CAP, LABEL_POLICY, OBSTACLE_WEIGHT } from "./figure-label/policy";
import KatexLabel from "./KatexLabel";
import {
  DEFAULT_AZIMUTH_DEG,
  DEFAULT_ELEVATION_DEG,
  degToRad,
  fitView,
  makeProjector,
  minMax,
  projectedBounds,
  viewBasis,
} from "./projection3d";
import type { ScreenPoint, Vec3, ViewBasis } from "./projection3d";

/**
 * インライン SVG として描く、ビルド時生成の静的な 3 次元の図（曲面・平面・直方体・空間曲線）。
 *
 * 多変数関数のグラフ $z = f(x, y)$ や媒介変数曲面を、空間の軸・平面・直方体・床の領域・
 * 空間曲線・線分・点と 1 枚に重ねて描く。偏微分の断面、接平面、等高線、重積分のリーマン和の
 * 柱などを、双方向性に頼らず静的な図で表す。本コンポーネントはクライアント JavaScript を
 * 一切載せない。Astro がビルド時に HTML へ描画する（クライアントディレクティブなし、
 * ハイドレーションなし）。線は `@visx/shape` の `LinePath`、面は polygon を手計算で置く。
 * ラベルは KatexLabel を介して KaTeX で組版し、`figure-label/` の配置器が線・点・目盛り・面の縁を
 * 避ける位置へ置く。`labelAt` は基準点、`labelDir` は基準点から見た画面の上の向きである。
 *
 * 投影は SpaceVectorDiagram と共有する正投影（`projection3d.ts`）で、既定の視点では $x$ 軸が
 * 左手前、$y$ 軸が右奥、$z$ 軸が上を向く。図ごとに方位角・仰角を上書きできる。
 *
 * 前後関係は次の 2 段で解く。
 * - 面: 曲面を細かい四角形（セル）に分け、平面・直方体の面・床の領域と合わせて奥から手前へ
 *   描く（画家のアルゴリズム）。セルの重心の奥行きで並べるだけでは、大きな平面の手前と奥に
 *   またがるセルや、背の高さが違う直方体の並びで順序を誤る。そこで大きな平面図形（平面・
 *   直方体の面・床の領域）を分割平面とする BSP 木（空間の二分割）を組み、分割平面の奥の面、
 *   分割平面、手前の面の順に描く。分割平面をまたぐセルは平面で切り分ける。小さなセルどうし
 *   だけが残った区画では、重心の奥行きで並べる。
 * - 線・点: 面の後に描く。ただし面に隠れる部分を素朴に上描きすると、曲面の裏の軸や床の
 *   破線が手前に浮いて見える。線を細かく標本化し、各標本点の手前にある面の不透明度から
 *   透過率を求め、隠れた部分を淡く描く（または描かない）。
 *
 * 陰影は、各セルの法線と光源の向きのなす角で明暗をつける（ランバート反射）。光源は視点に
 * 固定し、視点を変えても左上手前から照らす。高さによる濃淡にも切り替えられる。
 *
 * ベクトル場（`fields`）は格子点または指定した点で関数を評価して矢印の群を描き、空間曲線の
 * `arrows` は曲線の向きを矢じりで示す。例えば単位球面の上の外向き単位法線は次のように書く。
 *
 * ```mdx
 * <SurfacePlot xRange={[-1.5, 1.5]} yRange={[-1.5, 1.5]} zRange={[-1.5, 1.5]} ariaLabel="…"
 *   surfaces={[{ kind: "parametric", fn: (u, v) => ({ x: Math.sin(u) * Math.cos(v),
 *     y: Math.sin(u) * Math.sin(v), z: Math.cos(u) }), u: [0, Math.PI], v: [0, 2 * Math.PI],
 *     opacity: 0.3 }]}
 *   fields={[{ fn: (x, y, z) => ({ x, y, z }), scale: 0.5,
 *     at: [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }] }]} />
 * ```
 */

/**
 * ラベルの向きとすきまの指定。向きは画面の上の方位で、基準点から見た向きである。意味は ContourPlot・
 * FunctionGraph の `labelDir`・`labelOffset` と同じである。
 */
type LabelPlacementProps = Readonly<{
  /** 基準点から見たラベルの向き。"auto" は向きを自動で選ぶ。 */
  labelDir?: LabelDirSpec;
  /** 線や基準点とラベルの字形のすきまの目標（px）。既定は 4。 */
  labelOffset?: number;
}>;

/** 閉区間 [下端, 上端]。 */
type Range = readonly [number, number];

/**
 * 線・点が面に隠れた部分の描き方。いずれも半透明の面越しの部分は透過率に応じて淡くする。
 * "fade" は不透明に近い面に隠れた部分も薄く残す（線の行方を追える）。"hide" はその部分を
 * 描かない。"show" は隠れを無視して常に描く。
 */
type HiddenMode = "fade" | "hide" | "show";

/** 曲面の見た目の指定（陽関数・媒介変数の両方に共通）。 */
type SurfaceStyle = Readonly<{
  /** 面の色（"#rrggbb" か "#rgb"）。陰影はこの色を明暗に振って付ける。既定は青系。 */
  color?: string;
  /** 面の不透明度（0〜1）。既定 0.85。奥を透かしたい曲面（球面など）は 0.25 前後にする。 */
  opacity?: number;
  /** 網目の線を描くか。既定 true。 */
  mesh?: boolean;
  /** 網目の線を何セルおきに引くか。既定 2（面は細かく、線は粗くして見やすくする）。 */
  meshEvery?: number;
  /** 曲面の縁（定義域の端・切り取り・マスクの境界）を濃い線で縁取るか。既定 true。 */
  outline?: boolean;
  /** 陰影の付け方。"light" は光源による明暗（既定）、"height" は高さによる濃淡、"flat" は単色。 */
  shading?: "light" | "height" | "flat";
  /** $z$ の範囲 [下限, 上限]。範囲の外の部分を切り取る。切り口は縁取りの線になる。 */
  zClip?: Range;
  /**
   * 描かないセルを指定するマスク。セルの中心の座標 p と媒介変数 (u, v) を受け取り、true を
   * 返したセルを抜く。不連続点のまわりを抜くのに使う。陽関数の長方形上では (u, v) = (x, y)、
   * 円板上では (u, v) = (半径, 偏角) である。
   */
  hide?: (p: Vec3, uv: Readonly<{ u: number; v: number }>) => boolean;
  /** 曲面に添える LaTeX ラベル。 */
  label?: string;
  /** ラベルの基準点（空間の点）。省略時は曲面の右端の外側に置く。 */
  labelAt?: Vec3;
}> &
  LabelPlacementProps;

/** 円板（または扇形・円環）の定義域。極座標の網を張る。 */
type Disk = Readonly<{
  /** 外側の半径。 */
  r: number;
  /** 内側の半径。既定 0（中心まで張る）。正にすると中心に穴が開く。 */
  r0?: number;
  /** 中心。既定は原点。 */
  center?: Readonly<{ x: number; y: number }>;
  /** 偏角の範囲（ラジアン）。既定 [0, 2π]（1 周）。 */
  theta?: Range;
}>;

/**
 * 陽関数 $z = f(x, y)$ のグラフ。定義域は長方形 x × y・円板 disk・2 曲線にはさまれた領域
 * typeI / typeII のいずれかで指定する（優先順は disk、typeI、typeII、長方形）。
 */
type GraphSurface = SurfaceStyle &
  Readonly<{
    kind: "graph";
    /** 描く関数。定義域外・不連続点では NaN を返してよい（そのセルは描かない）。 */
    f: (x: number, y: number) => number;
    /** 長方形の定義域の $x$ の範囲。省略時は軸の範囲 xRange。 */
    x?: Range;
    /** 長方形の定義域の $y$ の範囲。省略時は軸の範囲 yRange。 */
    y?: Range;
    /** 円板の定義域。極座標の網を張る（u = 半径、v = 偏角）。 */
    disk?: Disk;
    /**
     * $a \le x \le b$、$\mathrm{lower}(x) \le y \le \mathrm{upper}(x)$ の定義域。網を領域の形に
     * 沿わせて張るため、マスクで抜くより縁が滑らかになる（u = x、v = 0〜1 の割合）。
     */
    typeI?: Readonly<{ x: Range; lower: (x: number) => number; upper: (x: number) => number }>;
    /** $c \le y \le d$、$\mathrm{left}(y) \le x \le \mathrm{right}(y)$ の定義域（u = y、v = 0〜1 の割合）。 */
    typeII?: Readonly<{ y: Range; left: (y: number) => number; right: (y: number) => number }>;
    /** セルの分割数 [u 方向, v 方向]。既定は円板 [10, 40]（半径, 偏角）、それ以外 [20, 20]。 */
    resolution?: readonly [number, number];
  }>;

/** 媒介変数曲面 $(u, v) \mapsto (x, y, z)$。球面・円柱面・円錐面などに使う。 */
type ParametricSurface = SurfaceStyle &
  Readonly<{
    kind: "parametric";
    /** 媒介変数 (u, v) を受け取り、空間の点を返す。 */
    fn: (u: number, v: number) => Vec3;
    /** u の範囲。 */
    u: Range;
    /** v の範囲。 */
    v: Range;
    /** セルの分割数 [u 方向, v 方向]。既定 [24, 24]。 */
    resolution?: readonly [number, number];
  }>;

type Surface = GraphSurface | ParametricSurface;

/** 平面の一部の見た目の指定。 */
type PlaneStyle = Readonly<{
  /** 塗りの色（"#rrggbb" か "#rgb"）。既定は灰青。 */
  color?: string;
  /** 不透明度（0〜1）。既定 0.25。 */
  opacity?: number;
  /** 縁を線で描くか。既定 true。 */
  outline?: boolean;
  /** 平面に添える LaTeX ラベル（例: "z = 2"）。 */
  label?: string;
  /** ラベルの基準点（空間の点）。省略時は平面の右端の外側に置く。 */
  labelAt?: Vec3;
}> &
  LabelPlacementProps;

/** 平面の一部（半透明の長方形・多角形）。 */
type PlanePatch = PlaneStyle &
  (
    | Readonly<{
        /** 鉛直面 $x = c$。 */
        kind: "planeX";
        x: number;
        /** $y$ の範囲。省略時は yRange。 */
        y?: Range;
        /** $z$ の範囲。省略時は zRange。 */
        z?: Range;
      }>
    | Readonly<{
        /** 鉛直面 $y = c$。 */
        kind: "planeY";
        y: number;
        /** $x$ の範囲。省略時は xRange。 */
        x?: Range;
        /** $z$ の範囲。省略時は zRange。 */
        z?: Range;
      }>
    | Readonly<{
        /** 水平面 $z = c$。 */
        kind: "planeZ";
        z: number;
        /** $x$ の範囲。省略時は xRange。 */
        x?: Range;
        /** $y$ の範囲。省略時は yRange。 */
        y?: Range;
      }>
    | Readonly<{
        /**
         * 点 $(a, b, z_0)$ での接平面 $z = z_0 + p(x - a) + q(y - b)$ の、$(a, b)$ を中心とする
         * 一辺 2 × size の正方形のパッチ。
         */
        kind: "tangent";
        at: Readonly<{ x: number; y: number }>;
        z0: number;
        /** $x$ 方向の傾き（偏微分係数 $f_x(a, b)$）。 */
        p: number;
        /** $y$ 方向の傾き（偏微分係数 $f_y(a, b)$）。 */
        q: number;
        /** 正方形の半幅。既定 0.6。 */
        size?: number;
      }>
    | Readonly<{
        /** 頂点を順に並べた平面多角形（同一平面上にあること）。 */
        kind: "polygon";
        vertices: readonly Vec3[];
      }>
  );

/** 直方体 $[x_0, x_1] \times [y_0, y_1] \times [z_0, z_1]$。リーマン和の柱や小さな箱に使う。 */
type Box3 = Readonly<{
  x: Range;
  y: Range;
  z: Range;
  /** 塗りの色（"#rrggbb" か "#rgb"）。既定は緑系。 */
  color?: string;
  /** 不透明度（0〜1）。既定 0.75。中の物を透かしたい小さな箱は 0.4 前後にする。 */
  opacity?: number;
  /** 辺を線で描くか。既定 true。 */
  outline?: boolean;
}>;

/** 床（既定 $z = 0$）の上の領域の見た目の指定。 */
type RegionStyle = Readonly<{
  /** 領域を置く高さ。既定 0（床）。 */
  z?: number;
  /** 塗りの色（"#rrggbb" か "#rgb"）。既定は琥珀色。 */
  color?: string;
  /** 不透明度（0〜1）。既定 0.35。 */
  opacity?: number;
  /** 縁を線で描くか。既定 true。 */
  outline?: boolean;
  /** 領域に添える LaTeX ラベル（例: "D"）。領域の重心付近に置く。 */
  label?: string;
  /** ラベルの基準点（領域の面の上の x・y）。省略時は領域の重心である。 */
  labelAt?: Readonly<{ x: number; y: number }>;
  /** 境界の曲線の標本数。既定 48。 */
  samples?: number;
}> &
  LabelPlacementProps;

/** 床の上の領域。多角形、または 2 曲線にはさまれた領域で指定する。 */
type FloorRegion = RegionStyle &
  (
    | Readonly<{
        /** 頂点 (x, y) を順に並べた多角形。 */
        kind: "polygon";
        vertices: readonly Readonly<{ x: number; y: number }>[];
      }>
    | Readonly<{
        /** $a \le x \le b$、$\mathrm{lower}(x) \le y \le \mathrm{upper}(x)$ の領域。 */
        kind: "typeI";
        x: Range;
        lower: (x: number) => number;
        upper: (x: number) => number;
      }>
    | Readonly<{
        /** $c \le y \le d$、$\mathrm{left}(y) \le x \le \mathrm{right}(y)$ の領域。 */
        kind: "typeII";
        y: Range;
        left: (y: number) => number;
        right: (y: number) => number;
      }>
  );

/** 空間曲線 $t \mapsto (x(t), y(t), z(t))$。断面の曲線・等高線・経路などに使う。 */
type SpaceCurve = Readonly<{
  /** 媒介変数 t を受け取り、空間の点を返す。 */
  fn: (t: number) => Vec3;
  /** t の範囲。 */
  t: Range;
  /** 標本数。既定 160。 */
  samples?: number;
  /** 線の色。既定は橙色。 */
  color?: string;
  /** 線の太さ（px）。既定 2。 */
  width?: number;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
  /** 曲線に添える LaTeX ラベル。 */
  label?: string;
  /** ラベルを置く位置の t。既定は t の上端。 */
  labelAt?: number;
  /** 面に隠れた部分の描き方。既定 "fade"。 */
  hidden?: HiddenMode;
  /**
   * 向きを示す矢じり。数値 n なら t の範囲を n 等分した各小区間の中央に、配列なら各 t の位置に
   * 置く。矢じりの中心を曲線の上に置き、t の範囲の [始端, 終端] の順に進む向きへ向ける。小区間の
   * 中央に置くのは、閉曲線の始点と終点（同じ点）に矢じりが 2 つ重ならないためである。面に隠れた
   * 矢じりは hidden に従って淡く描く（または描かない）。既定は矢じりなし。
   */
  arrows?: number | readonly number[];
}> &
  LabelPlacementProps;

/** 空間の線分。arrow を付けると矢印（空間ベクトル）になる。 */
type SpaceSegment = Readonly<{
  from: Vec3;
  to: Vec3;
  /** 終点に矢じりを付けるか。既定 false。 */
  arrow?: boolean;
  /** 線の色。既定は本文の文字色。 */
  color?: string;
  /** 線の太さ（px）。既定 1.8。 */
  width?: number;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
  /** 線分の中点付近に置く LaTeX ラベル。 */
  label?: string;
  /** ラベルの基準点（空間の点）。`labelDir` の既定は "center" である。 */
  labelAt?: Vec3;
  /** 面に隠れた部分の描き方。既定 "fade"。 */
  hidden?: HiddenMode;
}> &
  LabelPlacementProps;

/**
 * 空間のベクトル場。格子点（または `at` の各点）で関数を評価し、各点に矢印を描く。長さはすべて
 * 座標の単位（zScale を掛ける前の座標）で決める。矢印は線分の矢印（segments の arrow）と同じ
 * 見た目・同じ隠れ線の扱いで描く。
 */
type SpaceField = Readonly<{
  /**
   * 場の関数。空間の点 (x, y, z) を受け取り、その点のベクトル（成分）を返す。null や有限でない
   * 値を返した点（場が定義されない点）は描かない。
   */
  fn: (x: number, y: number, z: number) => Vec3 | null;
  /**
   * 格子の代わりに評価する点の列（座標）。曲面の上の点（球面の上の法線など）に矢印を置くときに
   * 使う。
   */
  at?: readonly Vec3[];
  /** 格子の $x$ の範囲（両端を含む）。省略時は軸の範囲 xRange。 */
  x?: Range;
  /** 格子の $y$ の範囲（両端を含む）。省略時は軸の範囲 yRange。 */
  y?: Range;
  /** 格子の $z$ の範囲（両端を含む）。省略時は軸の範囲 zRange。 */
  z?: Range;
  /**
   * 格子の各軸の分割数 [x, y, z]。各軸の範囲を等分し、両端を含む「分割数 + 1」個の格子点を
   * 置く。0 なら範囲の下端の 1 点だけを置く（床の上の場など）。既定 [2, 2, 2]。
   */
  divisions?: readonly [number, number, number];
  /** 評価しない点のマスク。true を返した点には何も描かない（原点のまわりなど）。 */
  hide?: (p: Vec3) => boolean;
  /**
   * 長さの倍率。矢印の成分（座標）をベクトルの scale 倍にする。省略時は、格子なら最も長い矢印が
   * 最も狭い格子間隔の 0.8 倍になる値、`at` なら 1 とする。
   */
  scale?: number;
  /**
   * すべての矢印を同じ長さにそろえるか（向きだけを示す）。そろえた長さ（座標）は scale で、
   * 省略時は格子なら最も狭い格子間隔の 0.6 倍、`at` なら 1 とする。既定 false。
   */
  normalize?: boolean;
  /** 矢印の長さの上限（座標）。超える矢印は向きを保って縮める。 */
  maxLength?: number;
  /** 評価点に矢印のどこを合わせるか。"tail" は始点、"center" は中点。既定 "tail"。 */
  pivot?: "tail" | "center";
  /** 零ベクトルの点の描き方。"skip" は描かない、"dot" は小さな点で示す。既定 "skip"。 */
  zero?: "skip" | "dot";
  /** 矢印の色。既定は青緑（曲面の青・曲線の橙色・強調の琥珀色と区別する）。 */
  color?: string;
  /** 線の太さ（px）。既定 1.8（線分の矢印と同じ）。 */
  width?: number;
  /** 面に隠れた部分の描き方。既定 "fade"。 */
  hidden?: HiddenMode;
}>;

/** 空間の 1 点。塗りつぶしの小丸で描く。 */
type SpacePoint = Vec3 &
  LabelPlacementProps &
  Readonly<{
    /** 点に添える LaTeX ラベル。 */
    label?: string;
    /** ラベルの基準点（空間の点）。`labelDir` の既定は "center" である。 */
    labelAt?: Vec3;
    /** 点の色。既定は本文の文字色。 */
    color?: string;
    /** 強調色（琥珀色）で描くか。既定 false。color を指定するとそちらを優先する。 */
    highlight?: boolean;
    /** 床（$z = 0$）へ鉛直に落とし込みの破線を引くか。既定 false。 */
    drop?: boolean;
    /** 白抜きの丸で描くか（含まない端点など）。既定 false（塗りつぶし）。 */
    open?: boolean;
    /** 面に隠れた点の描き方。既定 "fade"。 */
    hidden?: HiddenMode;
  }>;

/** 3 軸の目盛り（数値の配列）。 */
type Ticks = Readonly<{ x?: readonly number[]; y?: readonly number[]; z?: readonly number[] }>;

type SurfacePlotProps = Readonly<{
  /** 曲面（陽関数・媒介変数）。 */
  surfaces?: readonly Surface[];
  /** 平面の一部（水平面・鉛直面・接平面・多角形）。 */
  planes?: readonly PlanePatch[];
  /** 直方体。 */
  boxes?: readonly Box3[];
  /** 床の上の領域。 */
  regions?: readonly FloorRegion[];
  /** 空間曲線。 */
  curves?: readonly SpaceCurve[];
  /** 線分・矢印。 */
  segments?: readonly SpaceSegment[];
  /** ベクトル場（矢印の群）。空間曲線より前面、線分・点・ラベルより奥に描く。 */
  fields?: readonly SpaceField[];
  /** 点。 */
  points?: readonly SpacePoint[];
  /** $x$ 軸の範囲。軸は下端から上端（矢じり）まで描く。既定 [0, 3]。 */
  xRange?: Range;
  /** $y$ 軸の範囲。既定 [0, 3]。 */
  yRange?: Range;
  /** $z$ 軸の範囲。既定 [0, 3]。 */
  zRange?: Range;
  /** 3 軸を描くか。既定 true。 */
  axes?: boolean;
  /** 軸名（LaTeX）。既定は "x"・"y"・"z"。 */
  axisLabels?: Readonly<{ x?: string; y?: string; z?: string }>;
  /** 軸の目盛り（数値の配列）。少数にとどめる。既定は目盛りなし。 */
  ticks?: Ticks;
  /** 床（$z = 0$）に淡いグリッドを敷くか。既定 true。 */
  floorGrid?: boolean;
  /** 床グリッドの間隔。省略時は軸の範囲から 0.5・1・2 のいずれかを選ぶ。 */
  gridStep?: number;
  /** 方位角（度）。既定 35。 */
  azimuth?: number;
  /** 仰角（度）。既定 30。 */
  elevation?: number;
  /** $z$ 方向の縮尺（$x$・$y$ に対する倍率）。値域の広い関数を潰すのに使う。既定 1。 */
  zScale?: number;
  /** 支援技術が読み上げるアクセシブルな説明。 */
  ariaLabel: string;
}>;

// 軸・グリッドは global.css の CSS 変数でテーマに追従する（暗テーマで沈める）。
const AXIS = "var(--fig-axis)";
const GRID = "var(--fig-grid)";
const SURFACE = "#3b82f6";
const PLANE = "#64748b";
const BOX = "#10b981";
const REGION = "#f59e0b";
const CURVE = "#ea580c";
const HIGHLIGHT = "#f59e0b";
// ベクトル場の既定色。曲面（青）・曲線（橙色）・強調（琥珀色）のいずれとも見分けられる青緑にする。
// 平面図（ContourPlot）のベクトル場と同じ色である。
const FIELD = "#0d9488";
// 零ベクトルを示す点の半径（px）。
const FIELD_DOT_R = 1.8;
// 画面上の長さがこれ（px）より短い矢印は、向きが読めないため零ベクトルと同じに扱う。
const FIELD_MIN_PX = 0.5;
// 格子の 1 軸あたりの分割数の上限。指定を誤ったときに、ビルドが止まらないようにする。
const FIELD_MAX_DIVISIONS = 40;

// 描画領域。幅は他の図と同じ 320 とし、高さは内容に合わせて決める（空白の帯を作らない）。
const VIEW_W = 320;
const MIN_VIEW_H = 200;
const MAX_VIEW_H = 340;
const MARGIN = 28;

// 矢じり。長さ（線方向）と半幅（直交方向）を px で与える（SpaceVectorDiagram とそろえる）。
const HEAD_LEN = 9;
const HEAD_HALF = 3.6;

// 点の半径（px）と、白抜きの点の線の太さ（px）。
const POINT_R = 3.4;
const OPEN_POINT_STROKE = 1.8;

// ラベルと目盛り数字の字の大きさ（KatexLabel の fontSize）。
const LABEL_FONT = 12;
const TICK_FONT = 11;

// 目盛りの線の半分の長さ（px）と、目盛りの中心から数字の箱の縁までの距離（px）。
const TICK_HALF = 3;
const TICK_LABEL_GAP = 9;

// 線分・矢印のラベルを線に沿って試す位置（線の長さに対する割合）。前の位置ほど優先する。
const SEGMENT_FRACTIONS: readonly number[] = [0.5, 0.35, 0.65, 0.2, 0.8];

// 面のラベルが基準点のまわりから離れるときの罰点。線に近い罰点より軽い値を足すと動きやすいので、線に近い
// 罰点（1.5）に遠い輪の罰点（1.5）を足した値が、面の縁に触れる罰点（3）より小さくなる範囲で重くする。
const SHAPE_RING_PENALTY = 1;

// 網目の線は面の上のどこにでもあるので、触れる本数の罰点を打ち切る。面のラベルが線を避けられなくならない
// よう、縁取りの線の重みより軽くする。
const MESH_PENALTY_CAP = 4;

// 面の上の点や基準点のラベルが網目に触れる罰点の上限。遠い輪の罰点（1.5）より軽くする。
const SURFACE_MESH_PENALTY_CAP = 1;

// 網目・縁取りの線。網目は面の濃淡を邪魔しないよう細く淡く、縁取りは形を締めるよう濃くする。
const MESH_WIDTH = 0.5;
const MESH_OPACITY = 0.5;
const OUTLINE_WIDTH = 0.9;
const OUTLINE_OPACITY = 0.8;

// 面に隠れた線・点を淡く描くときの不透明度の下限。0 にすると線の行方を追えなくなる。
const FADE_FLOOR = 0.2;

// 線の可視判定の標本間隔（画面 px）。細かいほど隠れの境目が正確になるが SVG が重くなる。
const LINE_STEP_PX = 4;

/** 辺の描き方。網目の線・縁取りの線・描かない（切り分けで生じた辺など）。 */
type EdgeFlag = "none" | "mesh" | "outline";

/** 描画する多角形の面。頂点は表示座標（$z$ に zScale を掛けた空間座標）で持つ。 */
type Face = Readonly<{
  pts: readonly Vec3[];
  /** 各辺 pts[i] → pts[i + 1]（末尾は先頭へ戻る）の描き方。 */
  edges: readonly EdgeFlag[];
  fill: string;
  opacity: number;
  /** 網目・縁取りの線の色。 */
  edgeColor: string;
  /** BSP 木の分割平面に使う大きな平面図形か。曲面のセルは false。 */
  splitter: boolean;
}>;

export default function SurfacePlot({
  surfaces = [],
  planes = [],
  boxes = [],
  regions = [],
  curves = [],
  segments = [],
  fields = [],
  points = [],
  xRange = [0, 3],
  yRange = [0, 3],
  zRange = [0, 3],
  axes = true,
  axisLabels = {},
  ticks = {},
  floorGrid = true,
  gridStep,
  azimuth = DEFAULT_AZIMUTH_DEG,
  elevation = DEFAULT_ELEVATION_DEG,
  zScale = 1,
  ariaLabel,
}: SurfacePlotProps) {
  const basis = viewBasis(degToRad(azimuth), degToRad(elevation));
  const fwd = basis.fwd;
  // 画面の右向き・上向きを空間のベクトルとして求め、光源を視点に固定する（左上手前から照らす）。
  const right: Vec3 = { x: basis.dirX.sx, y: basis.dirY.sx, z: basis.dirZ.sx };
  const up: Vec3 = { x: -basis.dirX.sy, y: -basis.dirY.sy, z: -basis.dirZ.sy };
  const light = normalize(add(add(scale3(right, -0.45), scale3(up, 0.6)), scale3(fwd, 0.66)));

  // 数学の座標を表示座標へ写す（$z$ だけ zScale 倍する）。以降の幾何計算は表示座標で行う。
  const toView = (p: Vec3): Vec3 => ({ x: p.x, y: p.y, z: p.z * zScale });
  const ctx: BuildCtx = { xRange, yRange, zRange, toView, light, fwd };

  // ---- 面の組み立て ----
  const surfaceBuilt = surfaces.map((s) => buildSurface(s, ctx));
  const planeBuilt = planes.map((p) => buildPlane(p, ctx));
  const boxFaces = boxes.flatMap((b) => buildBox(b, ctx));
  const regionBuilt = regions.map((r) => buildRegion(r, ctx));
  const allFaces: readonly Face[] = [
    ...surfaceBuilt.flatMap((b) => b.faces),
    ...planeBuilt.flatMap((b) => (b.face ? [b.face] : [])),
    ...boxFaces,
    ...regionBuilt.flatMap((b) => (b.face ? [b.face] : [])),
  ];

  // ---- 線・点の空間座標（表示座標） ----
  const axisDefs: readonly Readonly<{
    key: "x" | "y" | "z";
    from: Vec3;
    to: Vec3;
    label: string;
  }>[] = axes
    ? [
        {
          key: "x",
          from: toView({ x: Math.min(xRange[0], 0), y: 0, z: 0 }),
          to: toView({ x: xRange[1], y: 0, z: 0 }),
          label: axisLabels.x ?? "x",
        },
        {
          key: "y",
          from: toView({ x: 0, y: Math.min(yRange[0], 0), z: 0 }),
          to: toView({ x: 0, y: yRange[1], z: 0 }),
          label: axisLabels.y ?? "y",
        },
        {
          key: "z",
          from: toView({ x: 0, y: 0, z: Math.min(zRange[0], 0) }),
          to: toView({ x: 0, y: 0, z: zRange[1] }),
          label: axisLabels.z ?? "z",
        },
      ]
    : [];

  // 床グリッドの格子値。間隔の倍数のうち軸の範囲に入るものを使う。
  const step =
    gridStep ??
    (() => {
      const span = Math.max(xRange[1] - xRange[0], yRange[1] - yRange[0]);
      return span <= 2.5 ? 0.5 : span <= 6 ? 1 : 2;
    })();
  const gridXs = floorGrid ? multiplesIn(xRange, step) : [];
  const gridYs = floorGrid ? multiplesIn(yRange, step) : [];
  const gridLines: readonly Readonly<{ a: Vec3; b: Vec3 }>[] =
    gridXs.length > 0 && gridYs.length > 0
      ? [
          ...gridXs.map((gx) => ({
            a: { x: gx, y: gridYs[0], z: 0 },
            b: { x: gx, y: gridYs[gridYs.length - 1], z: 0 },
          })),
          ...gridYs.map((gy) => ({
            a: { x: gridXs[0], y: gy, z: 0 },
            b: { x: gridXs[gridXs.length - 1], y: gy, z: 0 },
          })),
        ]
      : [];

  const curvePts = curves.map((c) => {
    const n = Math.max(2, c.samples ?? 160);
    // 添字 i ≤ n の範囲だけを作る。n + 1 のままだと、整数の直前の n で丸められて範囲の外の添字ができる。
    return Array.from({ length: Math.floor(n) + 1 }, (_, i): Vec3 => {
      const t = c.t[0] + ((c.t[1] - c.t[0]) * i) / n;
      const p = c.fn(t);
      return isFiniteVec(p) ? toView(p) : { x: Number.NaN, y: Number.NaN, z: Number.NaN };
    });
  });
  const segPts = segments.map((s) => ({ from: toView(s.from), to: toView(s.to) }));
  // ベクトル場の矢印。投影の当てはめより前に求め、矢印の先が図からはみ出さないよう投影範囲に含める。
  const fieldPts = fields.map((f) => buildField(f, ctx));
  const pointPts = points.map((p) => toView(p));
  const dropLines = points.flatMap((p, i) =>
    p.drop && Math.abs(p.z) > 1e-9
      ? [{ from: pointPts[i], to: toView({ x: p.x, y: p.y, z: 0 }) }]
      : [],
  );

  // ---- 投影の当てはめ ----
  // 図に現れるすべての点から投影範囲を求め、幅 320 に収まる倍率を決める。高さは内容に合わせ、
  // 上限を超えるときは高さ側で倍率を抑える。
  const shownPts: readonly Vec3[] = [
    ...axisDefs.flatMap((a) => [a.from, a.to]),
    ...gridLines.flatMap((g) => [g.a, g.b]),
    ...allFaces.flatMap((f) => f.pts),
    ...curvePts.flat().filter(isFiniteVec),
    ...segPts.flatMap((s) => [s.from, s.to]),
    ...pointPts,
    ...fieldPts.flatMap((fp) => fp.flatMap((a) => [a.from, a.to])),
  ];
  // 何も描かない図でも投影を決められるよう、原点 1 点で代える。
  const boundsPts: readonly Vec3[] = shownPts.length === 0 ? [{ x: 0, y: 0, z: 0 }] : shownPts;
  const rawBounds = projectedBounds(boundsPts, basis);
  const spanX = rawBounds.maxSx - rawBounds.minSx || 1;
  const spanY = rawBounds.maxSy - rawBounds.minSy || 1;
  const s0 = Math.min((VIEW_W - 2 * MARGIN) / spanX, (MAX_VIEW_H - 2 * MARGIN) / spanY);
  const viewH = Math.max(MIN_VIEW_H, Math.ceil(spanY * s0 + 2 * MARGIN));
  const fit = fitView(rawBounds, VIEW_W, viewH, MARGIN);
  const { project, depth } = makeProjector(basis, fit);

  // ---- 面の前後関係（BSP 木） ----
  const [depthLo, depthHi] = minMax(boundsPts.map(depth));
  const depthRange = depthHi - depthLo || 1;
  const ordered = orderFaces(allFaces, fwd, 1e-7 * depthRange);

  // ---- 面の描画データと、線の可視判定のための索引 ----
  const faceDraws = ordered.map((f) => {
    const sp = f.pts.map(project);
    return { face: f, sp, dep: f.pts.map(depth) };
  });
  const occ = buildOcclusionIndex(
    faceDraws.map((d) => ({ sp: d.sp, dep: d.dep, alpha: d.face.opacity })),
    VIEW_W,
    viewH,
  );
  // 線が自分の載る面に隠されないための奥行きの許容幅。セルの弦と真の曲面のずれより大きく、
  // 面と線の実際の前後差よりは十分小さく取る。
  const depEps = 0.015 * depthRange;

  /** 空間の折れ線を可視の区間に分ける。各区間は同じ不透明度で描く。 */
  const visibleRuns = (pts: readonly Vec3[], mode: HiddenMode): readonly Run[] => {
    // 各辺を画面上 LINE_STEP_PX ごとの小片に刻み、小片の中点で可視の度合いを求める。端が有限で
    // ない辺は描かず、その次の小片から区間を始め直す（breaks）。
    const pieces = pts.slice(0, -1).flatMap((a, i) => {
      const b = pts[i + 1];
      if (!isFiniteVec(a) || !isFiniteVec(b)) return [];
      const pa = project(a);
      const pb = project(b);
      const n = Math.max(1, Math.ceil(Math.hypot(pb.sx - pa.sx, pb.sy - pa.sy) / LINE_STEP_PX));
      return Array.from({ length: n }, (_, k) => {
        const p0 = lerp(a, b, k / n);
        const p1 = lerp(a, b, (k + 1) / n);
        const mid = lerp(p0, p1, 0.5);
        const ms = project(mid);
        const level =
          mode === "show"
            ? 1
            : visibilityLevel(occ.transmit(ms.sx, ms.sy, depth(mid), depEps), mode);
        return {
          level,
          s0: project(p0),
          s1: project(p1),
          breaks: k === 0 && (i === 0 || !isFiniteVec(pts[i - 1])),
        };
      });
    });
    // 区間の切れ目か、可視の度合いが前の小片と変わる小片から、新しい区間を始める。
    const starts = pieces.flatMap((q, j) =>
      j === 0 || q.breaks || q.level !== pieces[j - 1].level ? [j] : [],
    );
    return starts
      .map((s, r): Run => {
        const group = pieces.slice(s, r + 1 < starts.length ? starts[r + 1] : pieces.length);
        return { level: group[0].level, pts: [group[0].s0, ...group.map((q) => q.s1)] };
      })
      .filter((r) => r.level > 0);
  };

  /** 1 点の可視の度合い（不透明度の倍率）。 */
  const pointLevel = (p: Vec3, mode: HiddenMode): number => {
    if (mode === "show") return 1;
    const sp = project(p);
    return visibilityLevel(occ.transmit(sp.sx, sp.sy, depth(p), depEps), mode);
  };

  // ---- ベクトル場の矢印の振り分け ----
  // 画面上で FIELD_MIN_PX より短い矢印は向きが読めないため、零ベクトルと同じに扱う。
  const fieldDraws = fieldPts.map((fp, i) => {
    const projected = fp.map((a) => {
      const sFrom = project(a.from);
      const sTo = project(a.to);
      return {
        a,
        sFrom,
        sTo,
        long: Math.hypot(sTo.sx - sFrom.sx, sTo.sy - sFrom.sy) >= FIELD_MIN_PX,
      };
    });
    return {
      arrows: projected
        .filter((q) => q.long)
        .map(({ a, sFrom, sTo }) => ({ from: a.from, to: a.to, sFrom, sTo })),
      dots: fields[i].zero === "dot" ? projected.filter((q) => !q.long).map((q) => q.a.at) : [],
    };
  });

  // ---- ラベルの配置 ----
  // 軸・線分・曲線・面の縁を障害物に積み、ラベルが線や既出のラベルに重ならない候補を選ぶ。
  const screenOf = (p: Vec3): XY => toXY(project(p));
  const viewBounds: Box = { x0: 2, x1: VIEW_W - 2, y0: 2, y1: viewH - 2 };
  const W = OBSTACLE_WEIGHT;

  // 軸名は終点の外側へ置き、既出のラベルとして扱う。同じ行に並ぶラベルが 1 続きに読まれるのを避ける。
  const axisLabelPos: readonly XY[] = axisDefs.map((a) => {
    const from = project(a.from);
    const end = project(a.to);
    const ang = Math.atan2(end.sy - from.sy, end.sx - from.sx);
    return { x: end.sx + Math.cos(ang) * 12, y: end.sy + Math.sin(ang) * 12 };
  });
  const axisNameBoxes: readonly Box[] = axisDefs.flatMap((a, i) =>
    a.label === ""
      ? []
      : [glyphBox({ ...axisLabelPos[i], align: "center" }, glyphSizeOf(a.label, LABEL_FONT))],
  );

  // 目盛り。目盛り線は軸に直交する床（$z$ 軸は水平）の向きに短く引き、数字はその外側へ置く。
  const tickSpecs = axes ? tickSpecsOf(basis, ticks) : [];
  const tickItems = tickSpecs.flatMap((sp) =>
    sp.values.map((v) => {
      const p = toView({
        x: sp.axis === "x" ? v : 0,
        y: sp.axis === "y" ? v : 0,
        z: sp.axis === "z" ? v : 0,
      });
      const c = project(p);
      const text = formatTick(v);
      const size = glyphSizeOf(text, TICK_FONT);
      // 数字の中心を、目盛り線の端から数字の半幅ぶん外へ離す。
      const halfH = (size.bottom - size.top) / 2;
      const off =
        TICK_LABEL_GAP + Math.abs(sp.out.sx) * (size.width / 2) + Math.abs(sp.out.sy) * halfH;
      const pos = centeredAt(c.sx + sp.out.sx * off, c.sy + sp.out.sy * off, size);
      return {
        key: `${sp.axis}-${v}`,
        at: p,
        a: { sx: c.sx - sp.dir.sx * TICK_HALF, sy: c.sy - sp.dir.sy * TICK_HALF },
        b: { sx: c.sx + sp.dir.sx * TICK_HALF, sy: c.sy + sp.dir.sy * TICK_HALF },
        pos,
        text,
        box: glyphBox(pos, size),
      };
    }),
  );

  // 面の辺のうち、描き方が flag の辺の両端を並べる。
  const faceEdges = (flag: EdgeFlag): readonly (readonly [XY, XY])[] =>
    faceDraws.flatMap(({ face, sp }) =>
      sp.flatMap((a, i): readonly (readonly [XY, XY])[] =>
        face.edges[i] === flag ? [[toXY(a), toXY(sp[(i + 1) % sp.length])]] : [],
      ),
    );

  // 線の可視の区間を障害物にする。面に隠れて淡く描く区間は、見える度合いのぶんだけ軽い。
  const runObstacles = (id: string, runs: readonly Run[], weight: number) =>
    runs.flatMap((run) => lineObstacle(id, run.pts.map(toXY), weight * run.level));

  // 空間曲線の標本（画面座標と媒介変数）。曲線のラベルの候補に使う。
  const curveSamples: readonly (readonly CurvePoint[])[] = curves.map((c, i) => {
    const n = Math.max(2, c.samples ?? 160);
    return curvePts[i].flatMap((p, k) =>
      isFiniteVec(p) ? [{ ...screenOf(p), t: c.t[0] + ((c.t[1] - c.t[0]) * k) / n }] : [],
    );
  });

  const obstacles = [
    ...tickItems.map((t) => boxObstacle(t.box, W.tick)),
    ...pointPts.map((p, i) => {
      const { x, y } = screenOf(p);
      const r = markerReach(points[i]);
      return boxObstacle({ x0: x - r, x1: x + r, y0: y - r, y1: y + r }, W.point, `pt${i}`);
    }),
    ...axisDefs.flatMap((a) =>
      runObstacles(`ax-${a.key}`, visibleRuns([a.from, a.to], "fade"), W.axis),
    ),
    ...tickItems.flatMap((t) => lineObstacle("tk", [toXY(t.a), toXY(t.b)], W.thinLine)),
    // 破線の曲線は比べる相手や補助の線なので、主役の曲線より軽い。
    ...curves.flatMap((c, i) =>
      runObstacles(
        `cv${i}`,
        visibleRuns(curvePts[i], c.hidden ?? "fade"),
        c.dashed ? W.line : W.curve,
      ),
    ),
    ...segments.flatMap((s, i) =>
      runObstacles(
        `sg${i}`,
        visibleRuns([segPts[i].from, segPts[i].to], s.hidden ?? "fade"),
        W.line,
      ),
    ),
    ...dropLines.flatMap((d) => runObstacles("dp", visibleRuns([d.from, d.to], "fade"), W.edge)),
    ...chainEdges(faceEdges("outline")).flatMap((pts) => lineObstacle("ol", pts, W.edge)),
    ...gridLines.flatMap((g) => lineObstacle("gd", [screenOf(g.a), screenOf(g.b)], W.grid, true)),
    ...fieldDraws.map((fd) =>
      groupObstacle(
        fd.arrows.flatMap((a) =>
          lineObstacle("fd", [toXY(a.sFrom), toXY(a.sTo)], W.fieldArrow, true),
        ),
        FIELD_PENALTY_CAP,
      ),
    ),
  ];
  const meshLines = faceEdges("mesh").flatMap((pts) => lineObstacle("ms", pts, W.grid, true));
  const placer = createPlacer([...obstacles, groupObstacle(meshLines, MESH_PENALTY_CAP)]);
  // 面の上の点や基準点のラベルは、面から離れられない。網目を強く避けると遠くへ逃げて、点との対応が読めなく
  // なるので、すぐ外へ出られるときだけ外を選ぶ軽い罰点にする。
  const surfacePlacer = createPlacer([
    ...obstacles,
    groupObstacle(meshLines, SURFACE_MESH_PENALTY_CAP),
  ]);

  // 曲面・平面のラベルの候補。基準点の指定が無ければ、図形の右端の外側を右から順に試す。
  const shapeCandidates = (
    spec: LabelPlacementProps & Readonly<{ labelAt?: Vec3 }>,
    verts: readonly Vec3[],
    size: GlyphSize,
  ): readonly Candidate<LabelPos>[] => {
    if (spec.labelAt !== undefined) {
      const at = screenOf(toView(spec.labelAt));
      const fixed = anchoredCandidates(at, size, spec.labelDir, spec.labelOffset);
      // 向きの指定が無ければ、幅の広いラベルが面の縁の外へ出られるよう、遠い位置も試す。遠い位置には
      // 軽い罰点を足し、線に近いだけの基準点から動かないようにする。
      return spec.labelDir === undefined || spec.labelDir === "auto"
        ? [
            ...fixed,
            ...withPenalty(widelyAroundPoint(at, size, 0, spec.labelOffset), SHAPE_RING_PENALTY),
          ]
        : fixed;
    }
    if (verts.length === 0) return [];
    const anchor = verts.map(screenOf).reduce((m, q) => (q.x > m.x ? q : m), screenOf(verts[0]));
    const dir = spec.labelDir ?? "auto";
    if (dir !== "auto") return anchoredCandidates(anchor, size, dir, spec.labelOffset);
    const around = aroundPoint(anchor, size, 0, spec.labelOffset);
    return [
      ...positionCandidates(
        [
          around.right,
          around["above-right"],
          around["below-right"],
          around.above,
          around.below,
          around.left,
        ],
        size,
      ),
      ...withPenalty(widelyAroundPoint(anchor, size, 0, spec.labelOffset), SHAPE_RING_PENALTY),
    ];
  };

  const regionCandidates = (
    r: FloorRegion,
    face: Face,
    size: GlyphSize,
  ): readonly Candidate<LabelPos>[] => {
    const at = r.labelAt;
    const z = face.pts[0]?.z ?? 0;
    const anchor = at === undefined ? screenOf(centroid(face.pts)) : screenOf({ ...at, z });
    if (r.labelDir !== undefined && r.labelDir !== "auto") {
      return anchoredCandidates(anchor, size, r.labelDir, r.labelOffset);
    }
    return insideRegion(anchor, face.pts.map(screenOf), size);
  };

  // 曲線のラベルの候補。線の両側に続けて、基準の点のまわりの 8 方向を試す。線が基準の点で曲がるときに、
  // 線の両側がどちらも他の線にかかることがあるためである。
  const curveCandidates = (
    c: SpaceCurve,
    i: number,
    size: GlyphSize,
  ): readonly Candidate<LabelPos>[] => {
    const samples = curveSamples[i];
    const at = c.labelAt ?? c.t[1];
    const dir = c.labelDir ?? "auto";
    const beside = besideCurve(samples, size, at, dir, c.labelOffset);
    if (dir !== "auto" || samples.length === 0) return beside;
    const on = samples.reduce((m, s) => (Math.abs(s.t - at) < Math.abs(m.t - at) ? s : m));
    const around = aroundPoint(on, size, LABEL_POLICY.lineHalfWidth, c.labelOffset);
    return [...beside, ...positionCandidates(Object.values(around), size)];
  };

  const segmentCandidates = (
    s: SpaceSegment,
    i: number,
    size: GlyphSize,
  ): readonly Candidate<LabelPos>[] => {
    const a = screenOf(segPts[i].from);
    const b = screenOf(segPts[i].to);
    const spec = {
      at: s.labelAt === undefined ? undefined : screenOf(toView(s.labelAt)),
      dir: s.labelDir,
      offset: s.labelOffset,
    };
    return lineLabelCandidates(spec, a, b, size, (offset) =>
      s.arrow
        ? besideVectorCandidates(a, b, size, HEAD_HALF, offset, SEGMENT_FRACTIONS)
        : besideSegmentCandidates(a, b, size, offset, SEGMENT_FRACTIONS),
    );
  };

  // 点のラベルが読み違えられる相手の印。他の点と、線分の両端である。
  const marksOtherThan = (i: number): readonly XY[] => [
    ...pointPts.flatMap((q, k) => (k === i ? [] : [screenOf(q)])),
    ...segPts.flatMap((s) => [screenOf(s.from), screenOf(s.to)]),
  ];

  const pointCandidates = (
    p: SpacePoint,
    i: number,
    size: GlyphSize,
  ): readonly Candidate<LabelPos>[] => {
    const at = screenOf(pointPts[i]);
    const reach = markerReach(p);
    if (p.labelAt !== undefined) {
      const spec = { at: screenOf(toView(p.labelAt)), dir: p.labelDir, offset: p.labelOffset };
      return lineLabelCandidates(spec, at, at, size, () => []);
    }
    if (p.labelDir !== undefined && p.labelDir !== "auto") {
      return positionCandidates(pointPositions(at, size, reach, p.labelDir, p.labelOffset), size);
    }
    return preferringOwnMark(
      widelyAroundPoint(at, size, reach, p.labelOffset),
      at,
      marksOtherThan(i),
      W.point,
    );
  };

  // ラベルは、曲面・平面・領域・曲線・線分・点の順に 1 つずつ置く。後のラベルが先のラベルを避ける。
  const labelRequests: readonly LabelRequest[] = [
    ...surfaces.flatMap((s, i): readonly LabelRequest[] =>
      s.label === undefined
        ? []
        : [
            {
              key: `s-${i}`,
              tex: s.label,
              candidates: (size) => shapeCandidates(s, surfaceBuilt[i].verts, size),
              onSurface: s.labelAt !== undefined,
            },
          ],
    ),
    ...planes.flatMap((pl, i): readonly LabelRequest[] =>
      pl.label === undefined
        ? []
        : [
            {
              key: `p-${i}`,
              tex: pl.label,
              candidates: (size) => shapeCandidates(pl, planeBuilt[i].face?.pts ?? [], size),
              onSurface: pl.labelAt !== undefined,
            },
          ],
    ),
    ...regions.flatMap((r, i): readonly LabelRequest[] => {
      const face = regionBuilt[i].face;
      if (r.label === undefined || !face) return [];
      return [
        {
          key: `r-${i}`,
          tex: r.label,
          candidates: (size) => regionCandidates(r, face, size),
          onSurface: true,
        },
      ];
    }),
    ...curves.flatMap((c, i): readonly LabelRequest[] =>
      c.label === undefined
        ? []
        : [{ key: `c-${i}`, tex: c.label, candidates: (size) => curveCandidates(c, i, size) }],
    ),
    ...segments.flatMap((s, i): readonly LabelRequest[] =>
      s.label === undefined
        ? []
        : [
            {
              key: `g-${i}`,
              tex: s.label,
              candidates: (size) => segmentCandidates(s, i, size),
              // 基準点が線の上でも線を避けられるよう、labelAt があれば自分の線も判定に含める。
              exclude: s.labelAt === undefined ? `sg${i}` : undefined,
            },
          ],
    ),
    ...points.flatMap((p, i): readonly LabelRequest[] =>
      p.label === undefined
        ? []
        : [
            {
              key: `pt-${i}`,
              tex: p.label,
              candidates: (size) => pointCandidates(p, i, size),
              // 基準点が点の上でも印を避けられるよう、labelAt があれば自分の印も判定に含める。
              exclude: p.labelAt === undefined ? `pt${i}` : undefined,
              onSurface: true,
            },
          ],
    ),
  ];
  const placedLabels = placeInOrder(labelRequests, axisNameBoxes, (req, _, placed) => {
    const size = glyphSizeOf(req.tex, LABEL_FONT);
    const pos = (req.onSurface === true ? surfacePlacer : placer).place(req.candidates(size), {
      placed,
      bounds: viewBounds,
      exclude: req.exclude,
      rowGap: LABEL_POLICY.rowGap,
    }).item;
    return placedLabel(req.tex, pos, size);
  }).items;

  // ---- 空間曲線の向きの矢じり ----
  // 矢じりの中心を曲線の上の点に合わせ、接線の向きは前後のごく近い 2 点を投影した差で求める。
  // 差分の刻みは t の範囲に符号付きで比例させ、範囲を逆に与えた曲線でも進む向きを指す。
  const curveHeads = curves.flatMap((c, i) => {
    const [t0, t1] = c.t;
    const h = (t1 - t0) * 1e-3;
    // 差分の評価点を範囲の中に収める。端の点では片側の差分になり、範囲の外で例外を投げる関数も呼ばない。
    const clampT = (s: number) => Math.min(Math.max(s, Math.min(t0, t1)), Math.max(t0, t1));
    const mode = c.hidden ?? "fade";
    return arrowParams(c.arrows, t0, t1).flatMap((t, k) => {
      const p = c.fn(t);
      if (!isFiniteVec(p)) return [];
      const pv = toView(p);
      const level = pointLevel(pv, mode);
      if (level <= 0) return [];
      const sc = project(pv);
      const tb = clampT(t - h);
      const ta = clampT(t + h);
      const before = tb === t ? p : c.fn(tb);
      const after = ta === t ? p : c.fn(ta);
      const a = isFiniteVec(before) ? project(toView(before)) : sc;
      const b = isFiniteVec(after) ? project(toView(after)) : sc;
      const len = Math.hypot(b.sx - a.sx, b.sy - a.sy);
      if (!(len > 1e-9)) return [];
      const ux = (b.sx - a.sx) / len;
      const uy = (b.sy - a.sy) / len;
      const back = { sx: sc.sx - (ux * HEAD_LEN) / 2, sy: sc.sy - (uy * HEAD_LEN) / 2 };
      const tip = { sx: sc.sx + (ux * HEAD_LEN) / 2, sy: sc.sy + (uy * HEAD_LEN) / 2 };
      return [
        {
          key: `ch-${i}-${k}`,
          points: arrowHead(back, tip, HEAD_LEN, HEAD_HALF),
          color: c.color ?? CURVE,
          level,
        },
      ];
    });
  });

  // ---- 描画 ----
  // 最も多くの面が使う不透明度（親の g に置き、各面での記述を省く）。同数なら先に現れた値を採る。
  const [commonOpacity] = [...Map.groupBy(faceDraws, (d) => d.face.opacity)].reduce<
    readonly [number, number]
  >((best, [op, group]) => (group.length > best[1] ? [op, group.length] : best), [1, 0]);
  const gridMaxDepth = Math.max(
    ...gridLines.flatMap((g) => [depth(g.a), depth(g.b)]),
    Number.NEGATIVE_INFINITY,
  );
  const gridMinDepth = Math.min(
    ...gridLines.flatMap((g) => [depth(g.a), depth(g.b)]),
    Number.POSITIVE_INFINITY,
  );

  return (
    <svg
      className="surface-plot"
      viewBox={`0 0 ${VIEW_W} ${viewH}`}
      style={{ aspectRatio: `${VIEW_W} / ${viewH}` }}
      role="img"
      aria-label={ariaLabel}
    >
      {/*
        面（曲面のセル・平面・直方体の面・床の領域）。BSP 木で決めた奥から手前の順に描く。
        面 1 枚ごとに要素が 1〜3 個並ぶため、SVG が重くならないよう、共通の属性（塗りなし・
        線端の形・網目の線の太さと濃さ・最も多い面の不透明度）を親の g に置いて継がせ、
        異なる値だけを各要素に書く。多角形は自身の fill で塗りなしを上書きする。
      */}
      <g
        fill="none"
        fillOpacity={commonOpacity}
        strokeWidth={MESH_WIDTH}
        strokeOpacity={MESH_OPACITY}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {faceDraws.map(({ face, sp }, i) => {
          const pts = sp.map((p) => `${r1(p.sx)},${r1(p.sy)}`).join(" ");
          // 不透明な面は同色の細い縁を足し、隣のセルとの継ぎ目に背景が透けるのを防ぐ。
          const seam = face.opacity >= 0.999;
          const meshD = edgePath(sp, face.edges, "mesh");
          const outlineD = edgePath(sp, face.edges, "outline");
          return (
            <Fragment key={`f-${i}`}>
              <polygon
                points={pts}
                fill={face.fill}
                fillOpacity={face.opacity === commonOpacity ? undefined : face.opacity}
                stroke={seam ? face.fill : undefined}
                strokeWidth={seam ? 0.5 : undefined}
                strokeOpacity={seam ? 1 : undefined}
              />
              {meshD && <path d={meshD} stroke={face.edgeColor} />}
              {outlineD && (
                <path
                  d={outlineD}
                  stroke={face.edgeColor}
                  strokeWidth={OUTLINE_WIDTH}
                  strokeOpacity={OUTLINE_OPACITY}
                />
              )}
            </Fragment>
          );
        })}
      </g>

      {/* 床グリッド。面に隠れた部分は描かない。奥を淡く手前を濃くして遠近を表す。 */}
      {gridLines.length > 0 && (
        <g>
          {gridLines.flatMap((g, i) => {
            const t =
              gridMaxDepth > gridMinDepth
                ? (depth(lerp(g.a, g.b, 0.5)) - gridMinDepth) / (gridMaxDepth - gridMinDepth)
                : 1;
            const base = 0.45 + 0.4 * t;
            return visibleRuns([g.a, g.b], "hide").map((run, k) => (
              <RunPath
                key={`grid-${i}-${k}`}
                run={run}
                stroke={GRID}
                width={1}
                opacity={base * run.level}
              />
            ));
          })}
        </g>
      )}

      {/* 3 軸。面に隠れた部分は淡く描く。正の向きに矢じりを付ける。 */}
      {axisDefs.map((a) => {
        const runs = visibleRuns([a.from, a.to], "fade");
        const head = arrowHead(project(a.from), project(a.to), HEAD_LEN, HEAD_HALF);
        return (
          <g key={`axis-${a.key}`}>
            {runs.map((run, k) => (
              <RunPath
                key={`axis-${a.key}-${k}`}
                run={run}
                stroke={AXIS}
                width={1.3}
                opacity={run.level}
                trimEnd={k === runs.length - 1 ? HEAD_LEN : 0}
                trimTo={project(a.to)}
              />
            ))}
            <polygon points={head} fill={AXIS} fillOpacity={pointLevel(a.to, "fade")} />
          </g>
        );
      })}

      {/* 目盛り線。軸と同じく、面に隠れた目盛りは淡く描く。 */}
      {tickItems.map((t) => (
        <line
          key={`tick-${t.key}`}
          x1={r1(t.a.sx)}
          y1={r1(t.a.sy)}
          x2={r1(t.b.sx)}
          y2={r1(t.b.sy)}
          stroke={AXIS}
          strokeWidth={1.2}
          strokeOpacity={pointLevel(t.at, "fade")}
        />
      ))}

      {/* 点から床への落とし込み線（破線）。 */}
      {dropLines.map((d, i) => {
        const foot = project(d.to);
        return (
          <g key={`drop-${i}`}>
            {visibleRuns([d.from, d.to], "fade").map((run, k) => (
              <RunPath
                key={`drop-${i}-${k}`}
                run={run}
                stroke={AXIS}
                width={1}
                opacity={0.8 * run.level}
                dashed="3 3"
              />
            ))}
            <circle
              cx={r1(foot.sx)}
              cy={r1(foot.sy)}
              r={1.8}
              fill={AXIS}
              fillOpacity={0.8 * pointLevel(d.to, "fade")}
            />
          </g>
        );
      })}

      {/* 空間曲線。 */}
      {curves.map((c, i) =>
        visibleRuns(curvePts[i], c.hidden ?? "fade").map((run, k) => (
          <RunPath
            key={`curve-${i}-${k}`}
            run={run}
            stroke={c.color ?? CURVE}
            width={c.width ?? 2}
            opacity={run.level}
            dashed={c.dashed ? "5 4" : undefined}
          />
        )),
      )}
      {/* 空間曲線の向きを示す矢じり。面に隠れた矢じりは曲線と同じく淡く描く。 */}
      {curveHeads.map((h) => (
        <polygon
          key={h.key}
          points={h.points}
          fill={h.color}
          fillOpacity={h.level < 1 ? h.level : undefined}
        />
      ))}

      {/* ベクトル場。1 本ずつ線分の矢印（segments の arrow）と同じ描き方・隠れ線の扱いで描く。 */}
      {fieldDraws.map((fd, fi) => {
        const f = fields[fi];
        const color = f.color ?? FIELD;
        const mode = f.hidden ?? "fade";
        return (
          <g key={`field-${fi}`}>
            {fd.arrows.map((a, i) => {
              const runs = visibleRuns([a.from, a.to], mode);
              const len = Math.hypot(a.sTo.sx - a.sFrom.sx, a.sTo.sy - a.sFrom.sy) || 1;
              // 矢じり長は矢印の画面上の長さを超えないよう上限を付ける（線分の矢印と同じ）。
              const hl = Math.min(HEAD_LEN, len * 0.8);
              const level = pointLevel(a.to, mode);
              return (
                <g key={`field-${fi}-${i}`}>
                  {runs.map((run, k) => (
                    <RunPath
                      key={`field-${fi}-${i}-${k}`}
                      run={run}
                      stroke={color}
                      width={f.width ?? 1.8}
                      opacity={run.level}
                      trimEnd={k === runs.length - 1 ? hl : 0}
                      trimTo={a.sTo}
                    />
                  ))}
                  {level > 0 && (
                    <polygon
                      points={arrowHead(a.sFrom, a.sTo, hl, HEAD_HALF * (hl / HEAD_LEN))}
                      fill={color}
                      fillOpacity={level < 1 ? level : undefined}
                    />
                  )}
                </g>
              );
            })}
            {fd.dots.map((d, i) => {
              const level = pointLevel(d, mode);
              if (level <= 0) return null;
              const s = project(d);
              return (
                <circle
                  key={`field-${fi}-z${i}`}
                  cx={r1(s.sx)}
                  cy={r1(s.sy)}
                  r={FIELD_DOT_R}
                  fill={color}
                  fillOpacity={level < 1 ? level : undefined}
                />
              );
            })}
          </g>
        );
      })}

      {/* 線分・矢印。 */}
      {segments.map((s, i) => {
        const color = s.color ?? "currentColor";
        const from = project(segPts[i].from);
        const to = project(segPts[i].to);
        const runs = visibleRuns([segPts[i].from, segPts[i].to], s.hidden ?? "fade");
        const len = Math.hypot(to.sx - from.sx, to.sy - from.sy) || 1;
        // 矢じり長は線分の画面上の長さを超えないよう上限を付ける（短い矢印の崩れを防ぐ）。
        const hl = Math.min(HEAD_LEN, len * 0.8);
        return (
          <g key={`seg-${i}`}>
            {runs.map((run, k) => (
              <RunPath
                key={`seg-${i}-${k}`}
                run={run}
                stroke={color}
                width={s.width ?? 1.8}
                opacity={run.level}
                dashed={s.dashed ? "5 4" : undefined}
                trimEnd={s.arrow && k === runs.length - 1 ? hl : 0}
                trimTo={to}
              />
            ))}
            {s.arrow && (
              <polygon
                points={arrowHead(from, to, hl, HEAD_HALF * (hl / HEAD_LEN))}
                fill={color}
                fillOpacity={pointLevel(segPts[i].to, s.hidden ?? "fade")}
              />
            )}
          </g>
        );
      })}

      {/* 点。隠れた点は線より濃いめに残す（小さな印は淡いと見落とすため）。 */}
      {points.map((p, i) => {
        const sp = project(pointPts[i]);
        const color = p.color ?? (p.highlight ? HIGHLIGHT : "currentColor");
        const mode = p.hidden ?? "fade";
        const level = pointLevel(pointPts[i], mode);
        if (level <= 0) return null;
        const opacity = mode === "fade" ? Math.max(0.35, level) : level;
        return p.open ? (
          <circle
            key={`pt-${i}`}
            cx={r1(sp.sx)}
            cy={r1(sp.sy)}
            r={POINT_R}
            fill="var(--sl-color-bg, #fff)"
            stroke={color}
            strokeWidth={OPEN_POINT_STROKE}
            opacity={opacity}
          />
        ) : (
          <circle
            key={`pt-${i}`}
            cx={r1(sp.sx)}
            cy={r1(sp.sy)}
            r={POINT_R}
            fill={color}
            fillOpacity={opacity}
          />
        );
      })}

      {/* 目盛り数字・軸名・各ラベル。最前面に置き、背景色のハロー（global.css）で読みやすくする。 */}
      {tickItems.map((t) => {
        // 面に隠れた目盛りの数字も淡くする。隠れた軸に濃い数字だけが浮くと、面の上の
        // 印と見誤るため。
        const level = pointLevel(t.at, "fade");
        return (
          <g key={`tl-${t.key}`} opacity={level < 1 ? Math.max(0.35, level) : undefined}>
            <KatexLabel
              tex={t.text}
              x={t.pos.x}
              y={t.pos.y}
              fontSize={TICK_FONT}
              className="surface-plot-label"
            />
          </g>
        );
      })}
      {axisDefs.map((a, i) => (
        <KatexLabel
          key={`al-${a.key}`}
          tex={a.label}
          x={axisLabelPos[i].x}
          y={axisLabelPos[i].y}
          fontSize={LABEL_FONT}
          className="surface-plot-label"
        />
      ))}
      {placedLabels.map(
        (l, i) =>
          l && (
            <KatexLabel
              key={`lb-${labelRequests[i].key}`}
              tex={l.tex}
              x={l.pos.x}
              y={l.pos.y}
              fontSize={LABEL_FONT}
              align={l.pos.align}
              className="surface-plot-label"
            />
          ),
      )}
    </svg>
  );
}

/** 可視の区間（同じ不透明度で描く画面上の折れ線）。 */
type Run = Readonly<{ level: number; pts: readonly ScreenPoint[] }>;

/**
 * 可視の区間を 1 本の折れ線として描く。trimEnd を与え、区間が終点 trimTo まで届くときは、
 * trimTo から trimEnd px 手前で線を止める（矢じりの下に線が突き出ないようにする）。
 */
function RunPath({
  run,
  stroke,
  width,
  opacity,
  dashed,
  trimEnd = 0,
  trimTo,
}: Readonly<{
  run: Run;
  stroke: string;
  width: number;
  opacity: number;
  dashed?: string;
  trimEnd?: number;
  trimTo?: ScreenPoint;
}>) {
  // 終点まで届かない区間（終点が面に隠れて途切れた区間）は縮めない。縮めると、隠れた部分へ線を補ってしまう。
  const pts =
    trimEnd > 0 && trimTo && reachesEnd(run.pts, trimTo)
      ? trimTail(run.pts, trimTo, trimEnd)
      : run.pts;
  if (pts === null || pts.length < 2) return null;
  // LinePath の data は可変の配列型を求めるため、写しを渡す。
  return (
    <LinePath<ScreenPoint>
      data={[...pts]}
      x={(p) => r1(p.sx)}
      y={(p) => r1(p.sy)}
      fill="none"
      stroke={stroke}
      strokeWidth={width}
      strokeOpacity={opacity < 1 ? r2(opacity) : undefined}
      strokeDasharray={dashed}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

/** 折れ線 pts の終点が点 to に（0.5 px 未満で）届くか。 */
function reachesEnd(pts: readonly ScreenPoint[], to: ScreenPoint): boolean {
  const end = pts.at(-1);
  return end !== undefined && Math.hypot(end.sx - to.sx, end.sy - to.sy) < 0.5;
}

/**
 * 折れ線 pts から終点 to まで trim 以内の標本点を落とし、to から trim 手前の境目の点を補う。
 * 残る標本点が無ければ null。
 */
function trimTail(
  pts: readonly ScreenPoint[],
  to: ScreenPoint,
  trim: number,
): readonly ScreenPoint[] | null {
  const keep = pts.filter((p) => Math.hypot(p.sx - to.sx, p.sy - to.sy) > trim);
  const last = keep.at(-1);
  if (last === undefined) return null;
  const d = Math.hypot(to.sx - last.sx, to.sy - last.sy) || 1;
  const k = (d - trim) / d;
  return [...keep, { sx: last.sx + (to.sx - last.sx) * k, sy: last.sy + (to.sy - last.sy) * k }];
}

// ---------------------------------------------------------------------------
// 面の組み立て
// ---------------------------------------------------------------------------

/** 面の組み立てに使う共通の文脈。 */
type BuildCtx = Readonly<{
  xRange: Range;
  yRange: Range;
  zRange: Range;
  toView: (p: Vec3) => Vec3;
  light: Vec3;
  fwd: Vec3;
}>;

/** 頂点と各辺の描き方を持つ多角形。 */
type Polygon = Readonly<{ pts: readonly Vec3[]; edges: readonly EdgeFlag[] }>;

/** 曲面の媒介変数 (u, v) の格子。分割数・u と v の範囲・格子点を空間の点へ写す関数を持つ。 */
type ParamGrid = Readonly<{
  resolution: readonly [number, number];
  uR: Range;
  vR: Range;
  pointAt: (u: number, v: number) => Vec3;
  /** v の両端の格子線が一致する（1 周する円板の偏角）か。 */
  periodicV: boolean;
}>;

/** 曲面の種類ごとに、媒介変数 (u, v) の格子と、格子点を空間の点へ写す関数を決める。 */
function paramGridOf(s: Surface, ctx: BuildCtx): ParamGrid {
  if (s.kind !== "graph") {
    return {
      resolution: s.resolution ?? [24, 24],
      uR: s.u,
      vR: s.v,
      pointAt: s.fn,
      periodicV: false,
    };
  }
  const f = s.f;
  if (s.disk) {
    const { r, r0 = 0, center = { x: 0, y: 0 }, theta = [0, 2 * Math.PI] } = s.disk;
    return {
      resolution: s.resolution ?? [10, 40],
      uR: [r0, r],
      vR: theta,
      periodicV: Math.abs(theta[1] - theta[0] - 2 * Math.PI) < 1e-9,
      pointAt: (u, v) => {
        const x = center.x + u * Math.cos(v);
        const y = center.y + u * Math.sin(v);
        return { x, y, z: f(x, y) };
      },
    };
  }
  if (s.typeI) {
    const { x, lower, upper } = s.typeI;
    return {
      resolution: s.resolution ?? [20, 20],
      uR: x,
      vR: [0, 1],
      periodicV: false,
      pointAt: (u, v) => {
        const lo = lower(u);
        const y = lo + (upper(u) - lo) * v;
        return { x: u, y, z: f(u, y) };
      },
    };
  }
  if (s.typeII) {
    const { y, left, right } = s.typeII;
    return {
      resolution: s.resolution ?? [20, 20],
      uR: y,
      vR: [0, 1],
      periodicV: false,
      pointAt: (u, v) => {
        const lo = left(u);
        const x = lo + (right(u) - lo) * v;
        return { x, y: u, z: f(x, u) };
      },
    };
  }
  return {
    resolution: s.resolution ?? [20, 20],
    uR: s.x ?? ctx.xRange,
    vR: s.y ?? ctx.yRange,
    periodicV: false,
    pointAt: (u, v) => ({ x: u, y: v, z: f(u, v) }),
  };
}

/** 多角形を $z$ の範囲 [lo, hi] で切り取る（下限、上限の順）。切り口の辺には flag を与える。 */
function clipZ(poly: Polygon, [lo, hi]: Range, flag: EdgeFlag): Polygon | null {
  const above = clipByDist(
    poly.pts,
    poly.edges,
    poly.pts.map((p) => p.z - lo),
    flag,
  );
  return above === null
    ? null
    : clipByDist(
        above.pts,
        above.edges,
        above.pts.map((p) => hi - p.z),
        flag,
      );
}

/** 曲面をセルに分けて面の列にする。verts はラベルの基準点を探すための表示座標の頂点。 */
function buildSurface(
  s: Surface,
  ctx: BuildCtx,
): Readonly<{ faces: readonly Face[]; verts: readonly Vec3[] }> {
  const color = s.color ?? SURFACE;
  const opacity = s.opacity ?? 0.85;
  const meshOn = s.mesh ?? true;
  const meshEvery = Math.max(1, Math.round(s.meshEvery ?? 2));
  const outlineOn = s.outline ?? true;
  const shading = s.shading ?? "light";

  // 媒介変数 (u, v) の格子と、格子点を空間の点へ写す関数を種類ごとに決める。
  const { resolution, uR, vR, pointAt, periodicV: periodicTheta } = paramGridOf(s, ctx);
  const nu = Math.max(1, Math.round(resolution[0]));
  const nv = Math.max(1, Math.round(resolution[1]));
  const uAt = (i: number): number => uR[0] + ((uR[1] - uR[0]) * i) / nu;
  const vAt = (j: number): number => vR[0] + ((vR[1] - vR[0]) * j) / nv;

  const grid: readonly (readonly (Vec3 | null)[])[] = Array.from({ length: nu + 1 }, (_row, i) =>
    Array.from({ length: nv + 1 }, (_col, j) => {
      const p = pointAt(uAt(i), vAt(j));
      return isFiniteVec(p) ? p : null;
    }),
  );
  const at = (i: number, j: number): Vec3 | null => grid[i][j];

  // 媒介変数曲面は、両端の格子線が空間で一致するかで周期（継ぎ目）を見分ける。継ぎ目は縁では
  // ないので縁取りしない（球面の経度 0 と 2π など）。
  const periodicU =
    s.kind === "parametric" &&
    Array.from({ length: nv + 1 }, (_, j) => j).every((j) => near3(at(0, j), at(nu, j)));
  const periodicV =
    s.kind === "parametric"
      ? Array.from({ length: nu + 1 }, (_, i) => i).every((i) => near3(at(i, 0), at(i, nv)))
      : periodicTheta;

  // セルの有効性（4 隅が有限で、マスクに当たらない）。
  const valid: readonly (readonly boolean[])[] = Array.from({ length: nu }, (_row, i) =>
    Array.from({ length: nv }, (_col, j) => {
      const c = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      const finite = c.every((p) => p !== null);
      if (!finite || !s.hide) return finite;
      const cps = c.filter((p): p is Vec3 => p !== null);
      return !s.hide(centroid(cps), {
        u: (uAt(i) + uAt(i + 1)) / 2,
        v: (vAt(j) + vAt(j + 1)) / 2,
      });
    }),
  );
  const cellOk = (i: number, j: number): boolean => {
    const ii = periodicU ? ((i % nu) + nu) % nu : i;
    const jj = periodicV ? ((j % nv) + nv) % nv : j;
    if (ii < 0 || ii >= nu || jj < 0 || jj >= nv) return false;
    return valid[ii][jj];
  };
  // 格子線 u = i（v 方向に走る線）と v = j（u 方向に走る線）が網目の線か。
  const meshU = (i: number): boolean => meshOn && (i % meshEvery === 0 || i === nu);
  const meshV = (j: number): boolean => meshOn && (j % meshEvery === 0 || j === nv);
  const flagFor = (isMesh: boolean, neighborOk: boolean): EdgeFlag =>
    !neighborOk && outlineOn ? "outline" : isMesh ? "mesh" : "none";

  // まず数学の座標で多角形を作り、$z$ の切り取りをしてから表示座標へ写す。
  const clipFlag: EdgeFlag = outlineOn ? "outline" : "none";
  const polys: readonly Polygon[] = Array.from({ length: nu }, (_, i) => i).flatMap((i) =>
    Array.from({ length: nv }, (_, j) => j).flatMap((j) => {
      if (!valid[i][j]) return [];
      const p00 = at(i, j);
      const p10 = at(i + 1, j);
      const p11 = at(i + 1, j + 1);
      const p01 = at(i, j + 1);
      if (!p00 || !p10 || !p11 || !p01) return [];
      const poly: Polygon = {
        pts: [p00, p10, p11, p01],
        edges: [
          flagFor(meshV(j), cellOk(i, j - 1)),
          flagFor(meshU(i + 1), cellOk(i + 1, j)),
          flagFor(meshV(j + 1), cellOk(i, j + 1)),
          flagFor(meshU(i), cellOk(i - 1, j)),
        ],
      };
      const clipped = s.zClip ? clipZ(poly, s.zClip, clipFlag) : poly;
      return clipped ? [clipped] : [];
    }),
  );

  // 高さによる濃淡の基準（切り取り後の $z$ の範囲）。
  const [zLo, zHi] = minMax(polys.flatMap((p) => p.pts.map((q) => q.z)));
  const base = parseHex(color);
  // 網目の色は面の色を暗くして作る。ただし透かした曲面（球面など）は塗りが淡く、網目が形を
  // 担う。暗くしすぎると暗テーマの背景に沈むため、面の色に近い明るさにとどめる。
  const edgeColor = base ? toHex(mix(base, BLACK, opacity < 0.5 ? 0.15 : 0.45)) : color;
  /** 法線 n（長さ nl）・高さの平均 zMid のセルの塗りの色。 */
  const fillOf = (n: Vec3, nl: number, zMid: number): string => {
    if (base && shading === "light") return litColor(base, scale3(n, 1 / nl), ctx.light, ctx.fwd);
    if (base && shading === "height") {
      const t = zHi > zLo ? (zMid - zLo) / (zHi - zLo) : 0.5;
      return toHex(mix(mix(base, BLACK, 0.4 * (1 - t)), WHITE, 0.35 * t));
    }
    return color;
  };

  const faces: readonly Face[] = polys.flatMap((poly) => {
    const d = dedupe(poly.pts.map(ctx.toView), poly.edges);
    if (!d) return [];
    const n = newell(d.pts);
    const nl = Math.hypot(n.x, n.y, n.z);
    if (nl < 1e-12) return [];
    const zMid = poly.pts.reduce((acc, p) => acc + p.z, 0) / poly.pts.length;
    return [
      {
        pts: d.pts,
        edges: d.edges,
        fill: fillOf(n, nl, zMid),
        opacity,
        edgeColor,
        splitter: false,
      },
    ];
  });
  return { faces, verts: faces.flatMap((f) => f.pts) };
}

/** 平面の一部の頂点（数学の座標）を、種類ごとに順に並べる。 */
function planeCorners(p: PlanePatch, ctx: BuildCtx): readonly Vec3[] {
  if (p.kind === "planeX") {
    const [y0, y1] = p.y ?? ctx.yRange;
    const [z0, z1] = p.z ?? ctx.zRange;
    return [
      { x: p.x, y: y0, z: z0 },
      { x: p.x, y: y1, z: z0 },
      { x: p.x, y: y1, z: z1 },
      { x: p.x, y: y0, z: z1 },
    ];
  }
  if (p.kind === "planeY") {
    const [x0, x1] = p.x ?? ctx.xRange;
    const [z0, z1] = p.z ?? ctx.zRange;
    return [
      { x: x0, y: p.y, z: z0 },
      { x: x1, y: p.y, z: z0 },
      { x: x1, y: p.y, z: z1 },
      { x: x0, y: p.y, z: z1 },
    ];
  }
  if (p.kind === "planeZ") {
    const [x0, x1] = p.x ?? ctx.xRange;
    const [y0, y1] = p.y ?? ctx.yRange;
    return [
      { x: x0, y: y0, z: p.z },
      { x: x1, y: y0, z: p.z },
      { x: x1, y: y1, z: p.z },
      { x: x0, y: y1, z: p.z },
    ];
  }
  if (p.kind === "tangent") {
    const h = p.size ?? 0.6;
    const { x: a, y: b } = p.at;
    const zAt = (x: number, y: number): number => p.z0 + p.p * (x - a) + p.q * (y - b);
    return [
      [a - h, b - h],
      [a + h, b - h],
      [a + h, b + h],
      [a - h, b + h],
    ].map(([x, y]) => ({ x, y, z: zAt(x, y) }));
  }
  return p.vertices;
}

/** 平面の一部を 1 枚の多角形の面にする。 */
function buildPlane(p: PlanePatch, ctx: BuildCtx): Readonly<{ face: Face | null }> {
  const corners = planeCorners(p, ctx);
  const color = p.color ?? PLANE;
  const base = parseHex(color);
  const d = dedupe(
    corners.map(ctx.toView),
    corners.map((): EdgeFlag => ((p.outline ?? true) ? "outline" : "none")),
  );
  if (!d) return { face: null };
  return {
    face: {
      pts: d.pts,
      edges: d.edges,
      fill: color,
      opacity: p.opacity ?? 0.25,
      edgeColor: base ? toHex(mix(base, BLACK, 0.3)) : color,
      splitter: true,
    },
  };
}

/** 直方体を 6 枚の面にする。面ごとに光源による明暗をつけ、立体に見せる。 */
function buildBox(b: Box3, ctx: BuildCtx): readonly Face[] {
  const [x0, x1] = b.x;
  const [y0, y1] = b.y;
  const [z0, z1] = b.z;
  const v = (x: number, y: number, z: number): Vec3 => ctx.toView({ x, y, z });
  const quads: readonly (readonly Vec3[])[] = [
    [v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0)], // 底面
    [v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)], // 上面
    [v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)], // y = y0
    [v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1)], // y = y1
    [v(x0, y0, z0), v(x0, y1, z0), v(x0, y1, z1), v(x0, y0, z1)], // x = x0
    [v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)], // x = x1
  ];
  const color = b.color ?? BOX;
  const base = parseHex(color);
  const flag: EdgeFlag = (b.outline ?? true) ? "outline" : "none";
  return quads.flatMap((q) => {
    const d = dedupe(
      q,
      q.map(() => flag),
    );
    if (!d) return [];
    const n = newell(d.pts);
    const nl = Math.hypot(n.x, n.y, n.z);
    if (nl < 1e-12) return [];
    return [
      {
        pts: d.pts,
        edges: d.edges,
        fill: base ? litColor(base, scale3(n, 1 / nl), ctx.light, ctx.fwd) : color,
        opacity: b.opacity ?? 0.75,
        edgeColor: base ? toHex(mix(base, BLACK, 0.45)) : color,
        splitter: true,
      },
    ];
  });
}

/** 床の上の領域の境界の点 (x, y) を順に並べる。2 曲線にはさまれた領域は n 等分で標本化する。 */
function regionOutline(r: FloorRegion, n: number): readonly Readonly<{ x: number; y: number }>[] {
  if (r.kind === "polygon") return r.vertices;
  if (r.kind === "typeI") {
    const [a, b] = r.x;
    const xs = Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
    return [
      ...xs.map((x) => ({ x, y: r.lower(x) })),
      ...xs.toReversed().map((x) => ({ x, y: r.upper(x) })),
    ];
  }
  const [c, d] = r.y;
  const ys = Array.from({ length: n + 1 }, (_, i) => c + ((d - c) * i) / n);
  return [
    ...ys.map((y) => ({ x: r.left(y), y })),
    ...ys.toReversed().map((y) => ({ x: r.right(y), y })),
  ];
}

/** 床の上の領域を 1 枚の多角形の面にする。 */
function buildRegion(r: FloorRegion, ctx: BuildCtx): Readonly<{ face: Face | null }> {
  const z = r.z ?? 0;
  const n = Math.max(2, r.samples ?? 48);
  const pts = regionOutline(r, n)
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ctx.toView({ ...p, z }));
  const color = r.color ?? REGION;
  const base = parseHex(color);
  const flag: EdgeFlag = (r.outline ?? true) ? "outline" : "none";
  const d = dedupe(
    pts,
    pts.map(() => flag),
  );
  if (!d) return { face: null };
  return {
    face: {
      pts: d.pts,
      edges: d.edges,
      fill: color,
      opacity: r.opacity ?? 0.35,
      edgeColor: base ? toHex(mix(base, BLACK, 0.3)) : color,
      splitter: true,
    },
  };
}

// ---------------------------------------------------------------------------
// ベクトル場
// ---------------------------------------------------------------------------

/** ベクトル場の 1 本の矢印（表示座標）。at は評価点で、零ベクトルの点を描く位置に使う。 */
type FieldArrow = Readonly<{ at: Vec3; from: Vec3; to: Vec3 }>;

/**
 * ベクトル場を格子点（または at の点）で評価し、矢印の列（表示座標）にする。長さは数学の座標で
 * 決めてから両端を表示座標へ写す。zScale を掛けた図でも、矢印の成分を座標どおりに保つためである。
 * 零ベクトルの点は始点と終点の一致した矢印として返し、投影後に点として描くかを決める。
 */
function buildField(f: SpaceField, ctx: BuildCtx): readonly FieldArrow[] {
  const ranges: readonly Range[] = [f.x ?? ctx.xRange, f.y ?? ctx.yRange, f.z ?? ctx.zRange];
  const divs = (f.divisions ?? [2, 2, 2]).map((n) =>
    clampInt(Number.isFinite(n) ? Math.round(n) : 0, 0, FIELD_MAX_DIVISIONS),
  );
  const values = ranges.map((r, k) =>
    divs[k] === 0 || r[1] === r[0]
      ? [r[0]]
      : Array.from({ length: divs[k] + 1 }, (_, i) => r[0] + ((r[1] - r[0]) * i) / divs[k]),
  );
  const base: readonly Vec3[] =
    f.at ?? values[2].flatMap((z) => values[1].flatMap((y) => values[0].map((x) => ({ x, y, z }))));
  const samples = base.flatMap((p) => {
    if (f.hide?.(p) === true) return [];
    const v = f.fn(p.x, p.y, p.z);
    if (!isFiniteVec(v)) return [];
    return [{ p, v, mag: Math.hypot(v.x, v.y, v.z) }];
  });
  // 自動の倍率は、最も長い矢印（normalize ならすべての矢印）を最も狭い格子間隔より短くし、隣の
  // 格子点の矢印と重ならないようにする。投影で奥行き方向の間隔が縮んで見えるため、平面図より短く
  // とる。点の列で渡したときは格子間隔が無いため、ベクトルをそのまま描く。
  const spacings = ranges.flatMap((r, k) =>
    divs[k] > 0 && r[1] !== r[0] ? [Math.abs(r[1] - r[0]) / divs[k]] : [],
  );
  const unit = spacings.length > 0 ? Math.min(...spacings) : 1;
  const maxMag = samples.reduce((m, s) => Math.max(m, s.mag), 0);
  const autoScale =
    f.at !== undefined
      ? 1
      : f.normalize === true
        ? 0.6 * unit
        : maxMag > 0
          ? (0.8 * unit) / maxMag
          : 1;
  const scale = f.scale ?? autoScale;
  return samples.map(({ p, v, mag }) => {
    const rawLen = mag > 0 ? (f.normalize === true ? scale : scale * mag) : 0;
    const len = f.maxLength !== undefined ? Math.min(rawLen, f.maxLength) : rawLen;
    const d = mag > 0 ? scale3(v, len / mag) : { x: 0, y: 0, z: 0 };
    const start = f.pivot === "center" ? add(p, scale3(d, -0.5)) : p;
    return { at: ctx.toView(p), from: ctx.toView(start), to: ctx.toView(add(start, d)) };
  });
}

// ---------------------------------------------------------------------------
// 面の前後関係（BSP 木）
// ---------------------------------------------------------------------------

/** 平面 n·p = d（n は単位ベクトル）。 */
type PlaneEq = Readonly<{ n: Vec3; d: number }>;

/** 平面で振り分けた面。奥・手前・同一平面のそれぞれの並び。 */
type Partition = Readonly<{
  back: readonly Face[];
  front: readonly Face[];
  coplanar: readonly Face[];
}>;

/**
 * 面を奥から手前の順に並べる。大きな平面図形（splitter）を分割平面とする BSP 木を組み、
 * 分割平面の奥・分割平面・手前の順に出力する。分割平面をまたぐ面は平面で切り分ける。
 * 分割平面が尽きた区画の面（曲面のセル）は、重心の奥行きの昇順に並べる。
 */
function orderFaces(faces: readonly Face[], fwd: Vec3, eps: number): readonly Face[] {
  const centerDepth = (f: Face): number => dot(centroid(f.pts), fwd);
  const visit = (sp: readonly Face[], sm: readonly Face[]): readonly Face[] => {
    if (sp.length === 0) {
      return sm
        .map((f) => ({ f, d: centerDepth(f) }))
        .toSorted((a, b) => a.d - b.d)
        .map((k) => k.f);
    }
    const idx = chooseSplitter(sp, eps);
    const s = sp[idx];
    const rest = sp.filter((_, i) => i !== idx);
    const plane = planeOf(s, fwd);
    if (!plane) {
      // 面積が 0 の分割平面は分割に使えない。小さな面として扱う。
      return visit(rest, [...sm, s]);
    }
    const ps = rest.map((f) => partition(f, plane, eps));
    const pm = sm.map((f) => partition(f, plane, eps));
    return [
      ...visit(
        ps.flatMap((q) => q.back),
        pm.flatMap((q) => q.back),
      ),
      s,
      ...ps.flatMap((q) => q.coplanar),
      ...pm.flatMap((q) => q.coplanar),
      ...visit(
        ps.flatMap((q) => q.front),
        pm.flatMap((q) => q.front),
      ),
    ];
  };
  return visit(
    faces.filter((f) => f.splitter),
    faces.filter((f) => !f.splitter),
  );
}

/** 他の分割平面を切る回数が最も少ない分割平面を選ぶ（切り分けによる断片の増加を抑える）。 */
function chooseSplitter(sp: readonly Face[], eps: number): number {
  if (sp.length <= 2) return 0;
  const limit = Math.min(sp.length, 48);
  return Array.from({ length: limit }, (_, i) => i).reduce<
    Readonly<{ best: number; bestCuts: number }>
  >(
    (acc, i) => {
      const plane = planeOf(sp[i], { x: 0, y: 0, z: 1 });
      if (!plane) return acc;
      // これまでの最少の回数に達したら、その候補は選ばれないので数えるのをやめる。
      const cuts = sp.reduce(
        (n, f, j) => (n >= acc.bestCuts || j === i || !straddles(f, plane, eps) ? n : n + 1),
        0,
      );
      return cuts < acc.bestCuts ? { best: i, bestCuts: cuts } : acc;
    },
    { best: 0, bestCuts: Infinity },
  ).best;
}

/** 面 f の頂点が、平面の表側（eps を超える）と裏側（-eps 未満）の両方にあるか。 */
function straddles(f: Face, plane: PlaneEq, eps: number): boolean {
  const sides = f.pts.map((p) => {
    const dd = dot(plane.n, p) - plane.d;
    return dd > eps ? 1 : dd < -eps ? -1 : 0;
  });
  return sides.includes(1) && sides.includes(-1);
}

/** 面 f の平面を求め、法線を視点側（fwd との内積が非負）へ向ける。面積 0 なら null。 */
function planeOf(f: Face, fwd: Vec3): PlaneEq | null {
  const n = newell(f.pts);
  const len = Math.hypot(n.x, n.y, n.z);
  if (len < 1e-12) return null;
  const unit = scale3(n, 1 / len);
  const u = dot(unit, fwd) < 0 ? scale3(unit, -1) : unit;
  return { n: u, d: dot(u, centroid(f.pts)) };
}

/** 面 f を平面の奥・手前・同一平面に振り分ける。またぐ面は切り分けて両側へ入れる。 */
function partition(f: Face, plane: PlaneEq, eps: number): Partition {
  const dist = f.pts.map((p) => dot(plane.n, p) - plane.d);
  const max = Math.max(...dist);
  const min = Math.min(...dist);
  if (max <= eps && min >= -eps) return { back: [], front: [], coplanar: [f] };
  if (min >= -eps) return { back: [], front: [f], coplanar: [] };
  if (max <= eps) return { back: [f], front: [], coplanar: [] };
  // 許容幅の内側の頂点は平面上とみなし、切り分けで細い断片が生じないようにする。
  const snapped = dist.map((d) => (Math.abs(d) <= eps ? 0 : d));
  const fr = clipByDist(f.pts, f.edges, snapped, "none");
  const bk = clipByDist(
    f.pts,
    f.edges,
    snapped.map((d) => -d),
    "none",
  );
  const frd = fr ? dedupe(fr.pts, fr.edges) : null;
  const bkd = bk ? dedupe(bk.pts, bk.edges) : null;
  return {
    back: bkd ? [{ ...f, pts: bkd.pts, edges: bkd.edges }] : [],
    front: frd ? [{ ...f, pts: frd.pts, edges: frd.edges }] : [],
    coplanar: [],
  };
}

/**
 * 多角形を「距離 dist が 0 以上」の側で切り取る（Sutherland–Hodgman）。各辺の描き方を引き継ぎ、
 * 切り口に生じた辺には clipFlag を与える。頂点が 3 未満になれば null。
 */
function clipByDist(
  pts: readonly Vec3[],
  edges: readonly EdgeFlag[],
  dist: readonly number[],
  clipFlag: EdgeFlag,
): Polygon | null {
  const n = pts.length;
  const out = pts.flatMap((p, i) => {
    const j = (i + 1) % n;
    const da = dist[i];
    const db = dist[j];
    const e = edges[i];
    return [
      // 平面上の頂点から外側へ出る辺は捨てられ、次の頂点（再入点）までは切り口になる。
      ...(da >= 0 ? [{ p, e: da === 0 && db < 0 ? clipFlag : e }] : []),
      // 出ていく交点からは切り口、入ってくる交点からは元の辺の続き。
      ...((da > 0 && db < 0) || (da < 0 && db > 0)
        ? [{ p: lerp(p, pts[j], da / (da - db)), e: da > 0 ? clipFlag : e }]
        : []),
    ];
  });
  return out.length >= 3 ? { pts: out.map((v) => v.p), edges: out.map((v) => v.e) } : null;
}

/** 頂点と、その頂点から出る辺の描き方の組。 */
type Vertex = Readonly<{ p: Vec3; e: EdgeFlag }>;

/** 末尾から、先頭の頂点と一致する頂点を除く（閉じた多角形の重複した終点を落とす）。 */
function dropClosingDuplicates(vs: readonly Vertex[]): readonly Vertex[] {
  // 末尾から見て、先頭と一致しない最初の頂点までを残す（先頭の頂点は必ず残す）。
  const keep = vs.findLastIndex((v, i) => i === 0 || !near3(v.p, vs[0].p));
  return vs.slice(0, keep + 1);
}

/** 連続して一致する頂点（円板の中心・球の極など）を除く。頂点が 3 未満になれば null。 */
function dedupe(pts: readonly Vec3[], edges: readonly EdgeFlag[]): Polygon | null {
  // 頂点の数は境界の標本数に比例し、数万になりうる。蓄積した配列を頂点ごとに写すと 2 乗の時間が
  // かかるため、関数の中に閉じた可変のバッファに積む（外へは読み取り専用の値だけを返す）。
  const merged: Vertex[] = [];
  pts.forEach((p, k) => {
    const last = merged.at(-1);
    // 長さ 0 の辺を捨て、直前の頂点から先は p の次の辺を引き継ぐ。
    if (last !== undefined && near3(last.p, p)) {
      merged[merged.length - 1] = { p: last.p, e: edges[k] };
    } else {
      merged.push({ p, e: edges[k] });
    }
  });
  const out = dropClosingDuplicates(merged);
  return out.length >= 3 ? { pts: out.map((v) => v.p), edges: out.map((v) => v.e) } : null;
}

// ---------------------------------------------------------------------------
// 線の可視判定
// ---------------------------------------------------------------------------

/** 可視判定に使う、画面へ投影した面。奥行きは画面座標の 1 次式 a·sx + b·sy + c で表す。 */
type OccFace = Readonly<{
  xs: readonly number[];
  ys: readonly number[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  a: number;
  b: number;
  c: number;
  /** 画面上で 1 px ずれたときの奥行きの変化量（奥行きの勾配の大きさ）。 */
  slope: number;
  alpha: number;
}>;

/**
 * 面の画面上の範囲を小区画（バケット）に登録した索引を作る。transmit は画面の点 (sx, sy)・
 * 奥行き dep の点について、より手前にある面の (1 − 不透明度) の積（透過率）を返す。
 */
function buildOcclusionIndex(
  faces: readonly Readonly<{ sp: readonly ScreenPoint[]; dep: readonly number[]; alpha: number }>[],
  width: number,
  height: number,
): Readonly<{ transmit: (sx: number, sy: number, dep: number, eps: number) => number }> {
  const CELL = 16;
  const cols = Math.ceil(width / CELL) + 1;
  const rows = Math.ceil(height / CELL) + 1;
  const occs = faces.flatMap((f) => {
    if (f.alpha <= 0 || f.sp.length < 3) return [];
    // 画面座標と奥行きの組 (sx, sy, dep) で面の平面を当てはめる（正投影なので平面は平面に写る）。
    const pts3 = f.sp.map((p, i) => ({ x: p.sx, y: p.sy, z: f.dep[i] }));
    const n = newell(pts3);
    const len = Math.hypot(n.x, n.y, n.z);
    // 視線に平行な面（画面上で線分に潰れる面）は何も隠さない。
    if (len < 1e-12 || Math.abs(n.z) < 1e-6 * len) return [];
    const c0 = centroid(pts3);
    const xs = f.sp.map((p) => p.sx);
    const ys = f.sp.map((p) => p.sy);
    const occ: OccFace = {
      xs,
      ys,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      a: -n.x / n.z,
      b: -n.y / n.z,
      c: c0.z + (n.x * c0.x + n.y * c0.y) / n.z,
      slope: Math.hypot(n.x, n.y) / Math.abs(n.z),
      alpha: f.alpha,
    };
    return [
      {
        occ,
        cx0: clampInt(Math.floor(occ.minX / CELL), 0, cols - 1),
        cx1: clampInt(Math.floor(occ.maxX / CELL), 0, cols - 1),
        cy0: clampInt(Math.floor(occ.minY / CELL), 0, rows - 1),
        cy1: clampInt(Math.floor(occ.maxY / CELL), 0, rows - 1),
      },
    ];
  });
  // 小区画 (cx, cy) ごとに、画面上の範囲がその小区画にかかる面を、面の並びの順に集める。添字は
  // cy * cols + cx である。全区画で全面を調べると遅いため、先に行 cy にかかる面へ絞り込む。
  const buckets: readonly (readonly OccFace[])[] = Array.from({ length: rows }, (_row, cy) =>
    occs.filter((o) => o.cy0 <= cy && cy <= o.cy1),
  ).flatMap((inRow) =>
    Array.from({ length: cols }, (_col, cx) =>
      inRow.filter((o) => o.cx0 <= cx && cx <= o.cx1).map((o) => o.occ),
    ),
  );
  return {
    transmit: (sx, sy, dep, eps) => {
      const cx = clampInt(Math.floor(sx / CELL), 0, cols - 1);
      const cy = clampInt(Math.floor(sy / CELL), 0, rows - 1);
      return buckets[cy * cols + cx].reduce((t, f) => {
        if (sx < f.minX || sx > f.maxX || sy < f.minY || sy > f.maxY) return t;
        if (!pointInPoly(sx, sy, f.xs, f.ys)) return t;
        // 曲面上の線は、セル（弦）と真の曲面のずれの分だけ画面上で隣のセルへはみ出す。視線に
        // ほぼ平行なセルでは、そのわずかなずれが大きな奥行き差になり、線が自分の載る曲面に
        // 隠されてしまう。画面上 1 px のずれに相当する奥行きを許容幅に足して防ぐ。
        return f.a * sx + f.b * sy + f.c > dep + eps + f.slope ? t * (1 - f.alpha) : t;
      }, 1);
    },
  };
}

/** 透過率 t を、描画に使う不透明度の段階へ丸める（同じ段階の区間を 1 本にまとめるため）。 */
function visibilityLevel(t: number, mode: HiddenMode): number {
  if (t >= 0.9) return 1;
  if (mode === "hide") return t < 0.35 ? 0 : Math.round(t * 10) / 10;
  return Math.max(FADE_FLOOR, Math.round(t * 10) / 10);
}

/** 点 (x, y) が多角形の内部にあるか（交差数による判定）。 */
function pointInPoly(x: number, y: number, xs: readonly number[], ys: readonly number[]): boolean {
  // 辺 (j, i) は直前の頂点 j から頂点 i へ向かう（先頭の頂点の直前は末尾の頂点）。
  return xs.reduce((inside, xi, i) => {
    const j = i === 0 ? xs.length - 1 : i - 1;
    const yi = ys[i];
    return yi > y !== ys[j] > y && x < ((xs[j] - xi) * (y - yi)) / (ys[j] - yi) + xi
      ? !inside
      : inside;
  }, false);
}

// ---------------------------------------------------------------------------
// 色と陰影
// ---------------------------------------------------------------------------

type RGB = Readonly<{ r: number; g: number; b: number }>;
const BLACK: RGB = { r: 0, g: 0, b: 0 };
const WHITE: RGB = { r: 255, g: 255, b: 255 };

/** "#rrggbb" か "#rgb" を RGB に読む。読めなければ null（陰影をつけず指定色のまま描く）。 */
function parseHex(c: string): RGB | null {
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (m6) return { r: parseInt(m6[1], 16), g: parseInt(m6[2], 16), b: parseInt(m6[3], 16) };
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  if (m3) {
    return {
      r: parseInt(m3[1] + m3[1], 16),
      g: parseInt(m3[2] + m3[2], 16),
      b: parseInt(m3[3] + m3[3], 16),
    };
  }
  return null;
}

function toHex(c: RGB): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

/** 0〜255 の値を 2 桁の 16 進にする（範囲外は切り詰める）。 */
function hex2(v: number): string {
  return Math.round(Math.max(0, Math.min(255, v)))
    .toString(16)
    .padStart(2, "0");
}

/** 色 a と b を割合 t（0 で a、1 で b）で混ぜる。 */
function mix(a: RGB, b: RGB, t: number): RGB {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

/**
 * 法線 n（単位ベクトル）の面を光源 light で照らした色。法線を視点側へ向けてから明暗を決め、
 * 裏側が見える面（鞍形の奥など）も表と同じ規則で照らす。光の当たらない面は暗く、正対する面は
 * わずかに白へ寄せてつやを出す。
 */
function litColor(base: RGB, n: Vec3, light: Vec3, fwd: Vec3): string {
  const nn = dot(n, fwd) < 0 ? scale3(n, -1) : n;
  const lam = Math.max(0, dot(nn, light));
  return toHex(mix(mix(base, BLACK, 0.42 * (1 - lam)), WHITE, 0.22 * lam ** 4));
}

// ---------------------------------------------------------------------------
// ベクトルと補助
// ---------------------------------------------------------------------------

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale3(a: Vec3, k: number): Vec3 {
  return { x: a.x * k, y: a.y * k, z: a.z * k };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return scale3(a, 1 / l);
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function centroid(pts: readonly Vec3[]): Vec3 {
  const s = pts.reduce((acc, p) => add(acc, p), { x: 0, y: 0, z: 0 });
  return scale3(s, 1 / (pts.length || 1));
}

/** Newell の方法による多角形の法線（長さは面積の 2 倍）。非平面の四角形でも平均的な向きを返す。 */
function newell(pts: readonly Vec3[]): Vec3 {
  return pts.reduce<Vec3>(
    (acc, a, i) => {
      const b = pts[(i + 1) % pts.length];
      return {
        x: acc.x + (a.y - b.y) * (a.z + b.z),
        y: acc.y + (a.z - b.z) * (a.x + b.x),
        z: acc.z + (a.x - b.x) * (a.y + b.y),
      };
    },
    { x: 0, y: 0, z: 0 },
  );
}

function isFiniteVec(p: Vec3 | null | undefined): p is Vec3 {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

/** 2 点が（丸め誤差の範囲で）一致するか。どちらかが null なら false。 */
function near3(a: Vec3 | null, b: Vec3 | null): boolean {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.z - b.z) < 1e-9;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** range の中にある step の倍数を小さい順に返す。 */
function multiplesIn(range: Range, step: number): readonly number[] {
  if (!(step > 0)) return [];
  const k0 = Math.ceil(range[0] / step - 1e-9);
  const k1 = Math.floor(range[1] / step + 1e-9);
  return Array.from({ length: Math.max(0, k1 - k0 + 1) }, (_, i) => {
    // 先頭は k0 をそのまま使う。k0 + 0 とすると、k0 が -0（range の下端が 0 のとき）なら +0 に変わる。
    const k = i === 0 ? k0 : k0 + i;
    return Math.round(k * step * 1e6) / 1e6;
  });
}

/** 目盛りの数値を LaTeX にする（負号は KaTeX が数式の負号で組む）。 */
function formatTick(v: number): string {
  return String(Math.round(v * 1e6) / 1e6);
}

/** 座標を 0.1 px に丸める（SVG を軽くする。表示倍率 1.0 では見分けられない）。 */
function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 画面上の多角形の辺のうち、描き方が flag の辺を path の d 属性にまとめる。なければ null。 */
function edgePath(
  sp: readonly ScreenPoint[],
  edges: readonly EdgeFlag[],
  flag: EdgeFlag,
): string | null {
  // 続けて現れる辺は 1 本の部分経路につなぎ、M の繰り返しを省く（直前の辺も flag なら M を置かない）。
  // flag でない辺は空文字列にする。flag の辺は必ず L を含むので、空でない部分の有無で判定できる。
  const parts = sp.map((a, i) => {
    if (edges[i] !== flag) return "";
    const b = sp[(i + 1) % sp.length];
    const move = i > 0 && edges[i - 1] === flag ? "" : `M${r1(a.sx)} ${r1(a.sy)}`;
    return `${move}L${r1(b.sx)} ${r1(b.sy)}`;
  });
  return parts.some((part) => part !== "") ? parts.join("") : null;
}

/** 1 軸の目盛りの指定。目盛り線を引く画面上の向き dir と、数字を置く外向き out を持つ。 */
type TickSpec = Readonly<{
  axis: "x" | "y" | "z";
  values: readonly number[];
  dir: ScreenPoint;
  out: ScreenPoint;
}>;

/** 3 軸の目盛りの指定を、視点の基底 basis から決める。 */
function tickSpecsOf(basis: ViewBasis, ticks: Ticks): readonly TickSpec[] {
  const uy = unitOf(basis.dirY);
  const ux = unitOf(basis.dirX);
  return [
    // x 軸の目盛り数字は y 軸と反対側（左上）、y 軸は x 軸と反対側（右上）、z 軸は左へ置く。
    { axis: "x", values: ticks.x ?? [], dir: uy, out: { sx: -uy.sx, sy: -uy.sy } },
    { axis: "y", values: ticks.y ?? [], dir: ux, out: { sx: -ux.sx, sy: -ux.sy } },
    { axis: "z", values: ticks.z ?? [], dir: { sx: 1, sy: 0 }, out: { sx: -1, sy: 0 } },
  ];
}

/** 画面ベクトルを長さ 1 に正規化する。 */
function unitOf(d: ScreenPoint): ScreenPoint {
  const len = Math.hypot(d.sx, d.sy) || 1;
  return { sx: d.sx / len, sy: d.sy / len };
}

/** 画面の点を配置器の座標にする。 */
function toXY(p: ScreenPoint): XY {
  return { x: p.sx, y: p.sy };
}

/** 点の中心から印の端までの距離（px）。 */
function markerReach(p: SpacePoint): number {
  return p.open === true ? POINT_R + OPEN_POINT_STROKE / 2 : POINT_R;
}

/** 1 つのラベルの配置の依頼。候補は寸法を受けて作り、exclude は判定から外す障害物の id である。 */
type LabelRequest = Readonly<{
  key: string;
  tex: string;
  candidates: (size: GlyphSize) => readonly Candidate<LabelPos>[];
  exclude?: string;
  /** 面の上に置くラベルか。面の上のどこにでもある網目を避けない。 */
  onSurface?: boolean;
}>;

/**
 * 向きの矢じりの指定（数値なら等分の個数、配列なら位置）を、矢じりを置く媒介変数の値の列にする。
 * 個数で与えたときは、範囲を等分した各小区間の中央の値を返す。
 */
function arrowParams(
  marks: number | readonly number[] | undefined,
  lo: number,
  hi: number,
): readonly number[] {
  if (marks === undefined) return [];
  if (typeof marks !== "number") return marks;
  const n = Math.max(0, Math.round(marks));
  return Array.from({ length: n }, (_, k) => lo + ((hi - lo) * (k + 0.5)) / n);
}

/** 始点 from から終点 to へ向かう矢じりの三角形（polygon の points 属性）。 */
function arrowHead(from: ScreenPoint, to: ScreenPoint, len: number, half: number): string {
  const ang = Math.atan2(to.sy - from.sy, to.sx - from.sx);
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const bx = to.sx - len * cos;
  const by = to.sy - len * sin;
  return [
    `${r1(to.sx)},${r1(to.sy)}`,
    `${r1(bx - half * sin)},${r1(by + half * cos)}`,
    `${r1(bx + half * sin)},${r1(by - half * cos)}`,
  ].join(" ");
}
