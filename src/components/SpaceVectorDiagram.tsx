import { Line } from "@visx/shape";
import {
  anchoredCandidates,
  besideVectorCandidates,
  lineLabelCandidates,
  pointLabelCandidates,
  preferringOwnMark,
  widelyAroundPoint,
  type LabelDirSpec,
} from "./figure-label/candidates";
import { type Box, type XY } from "./figure-label/geometry";
import { glyphBox, glyphSizeOf, type GlyphSize, type LabelPos } from "./figure-label/label-box";
import { boxObstacle, lineObstacle } from "./figure-label/obstacles";
import {
  createPlacer,
  NO_PLACEMENT,
  placedLabel,
  placeInOrder,
  type Candidate,
  type Label,
} from "./figure-label/placer";
import { LABEL_POLICY, OBSTACLE_WEIGHT } from "./figure-label/policy";
import type { ReactNode } from "react";
import KatexLabel from "./KatexLabel";
import { DEFAULT_VIEW, fitView, makeProjector, projectedBounds, toXY } from "./projection3d";
import type { Vec3 } from "./projection3d";

/**
 * インライン SVG として描く、ビルド時生成の静的な空間ベクトルの軸測図。
 *
 * 3 次元の右手系を 2 次元画面へ正投影（軸測投影）して描く。$x, y, z$ の 3 軸と、空間
 * ベクトル（有向線分）・点・2 ベクトルが張る平行四辺形を 1 枚の静的な図で表す。空間
 * ベクトルの成分・和・外積の面積を視覚化する。本コンポーネントはクライアント JavaScript を
 * 一切載せない。Astro がビルド時に HTML へ描画する（クライアントディレクティブなし、
 * ハイドレーションなし）。軸・ベクトルは `@visx/shape` の `Line` で描き、矢じりは色を動的に
 * 変えられるよう polygon を手計算で置く。ラベルは KatexLabel を介して KaTeX で組版し、
 * `figure-label/` の配置器が線・点・軸名を避ける位置へ置く。`labelAt` は基準点、`labelDir` は基準点から
 * 見た画面の上の向きである。
 *
 * 投影は、既定の方位角・仰角を持つ正投影（ダイメトリック軸測）である。$y$ 軸を
 * 真横に寝かせる斜投影だと床面（$xy$ 平面）が線分に潰れて立体に見えない。そこで $x$ 軸を
 * 左手前へ、$y$ 軸を右奥へ、双方に下向きの傾きを与え、$xy$ 平面が「奥へ広がる床」に見える
 * 視点を取る。$z$ 軸は画面の上向きである。投影の計算は 3 次元の図で共有するため
 * `projection3d.ts` に置く。
 *
 * 奥行きの手がかりを 3 つ重ねる。
 * - 床グリッド: $z = 0$ の $xy$ 平面に淡いグリッドを敷き、地面の参照を与える。奥（原点側）の
 *   線を淡く、手前の線を濃く描いて遠近を表す。
 * - 落とし込み線: 各ベクトルの終点・各点から床へ下ろした鉛直の破線と、その足から $x$・$y$ 軸へ
 *   向かう破線を描く。成分 $(a_1, a_2, a_3)$ の分解が立体的に読める。`dropLines` で抑制できる。
 * - 描画順: 床・落とし込み線を背面に置き、主役のベクトル・点を前面に重ねる。
 *
 * 各空間座標 (x, y, z) は `project` で画面座標 (sx, sy) へ線形に写す。原点を viewBox の
 * 中央付近に置く。
 */

/** ラベルの位置の指定。意味は SurfacePlot の点・線分の同じ名前の指定と同じである。 */
type LabelProps = Readonly<{
  /** ラベルの基準点（空間の点）。 */
  labelAt?: Vec3;
  /** 基準点から見たラベルの画面の上の向き。 */
  labelDir?: LabelDirSpec;
  /** 線や基準点とラベルの字形のすきまの目標（px）。既定は 4。 */
  labelOffset?: number;
}>;

/** 空間ベクトル（有向線分）。始点 from から終点 to へ矢じり付きで描く。 */
type SpaceVec = LabelProps &
  Readonly<{
    from: Vec3;
    to: Vec3;
    /** 線分の中点付近に置く LaTeX ラベル（例: "\\vec{a}"）。 */
    label?: string;
    /** ベクトルの色。既定は青系。 */
    color?: string;
    /** 破線で描くか。既定は実線。 */
    dashed?: boolean;
  }>;

/** 空間内の 1 点。塗りつぶしの小丸で描く。 */
type SpacePoint = LabelProps &
  Readonly<{
    x: number;
    y: number;
    z: number;
    /** 点に添える LaTeX ラベル。 */
    label?: string;
    /** 強調色で描くか。既定 false。 */
    highlight?: boolean;
  }>;

/** 起点 o から 2 ベクトル a, b が張る平行四辺形。外積の面積の図示に使う。半透明で塗る。 */
type Parallelogram = LabelProps &
  Readonly<{
    o: Vec3;
    a: Vec3;
    b: Vec3;
    /** 平行四辺形の中心付近に置く LaTeX ラベル。 */
    label?: string;
    /** 塗りの色。既定は青系。 */
    color?: string;
  }>;

type SpaceVectorDiagramProps = Readonly<{
  /** 空間ベクトル（有向線分）。 */
  vectors?: readonly SpaceVec[];
  /** 空間内に置く点。 */
  points?: readonly SpacePoint[];
  /** 2 ベクトルが張る平行四辺形（半透明で塗る）。 */
  parallelogram?: Parallelogram;
  /** 軸の表示範囲。各軸を 0..axisMax まで描く。既定 3。 */
  axisMax?: number;
  /** $z = 0$ の床グリッドを敷くか。既定 true。 */
  floorGrid?: boolean;
  /** 終点・点から床・各軸へ落とし込みの破線を引くか。既定 true。 */
  dropLines?: boolean;
  /** 支援技術が読み上げるアクセシブルな説明。 */
  ariaLabel: string;
}>;

// 軸・ベクトルは global.css の CSS 変数でテーマに追従する。
const AXIS = "var(--fig-axis)";
const GRID = "var(--fig-grid)";
const VEC = "#3b82f6";
const HIGHLIGHT = "#f59e0b";

// 描画領域。他の図と高さ感をそろえ、正方に近い縦横比にする。
const VIEW_W = 320;
const VIEW_H = 280;

// 軸の周りに確保する余白（軸名ラベル・矢じりを収める）。
const MARGIN = 32;

// 矢じり。長さ（線方向）と半幅（直交方向）を px で与える。
const HEAD_LEN = 9;
const HEAD_HALF = 3.6;

// 点の半径（px）。
const POINT_R = 3.6;

// ラベルの字の大きさ（KatexLabel の fontSize）。
const LABEL_FONT = 12;

// ベクトルのラベルを線に沿って試す位置（線の長さに対する割合）。前の位置ほど優先する。
const VECTOR_FRACTIONS: readonly number[] = [0.5, 0.35, 0.65, 0.2, 0.8];

// 配置の範囲。viewBox の縁から 2px 内側に収める。
const VIEW_BOUNDS: Box = { x0: 2, x1: VIEW_W - 2, y0: 2, y1: VIEW_H - 2 };

// 座標が 0 とみなせる許容値（落とし込み線の退化を判定する）。
const EPS = 1e-6;

export default function SpaceVectorDiagram({
  vectors = [],
  points = [],
  parallelogram,
  axisMax = 3,
  floorGrid = true,
  dropLines = true,
  ariaLabel,
}: SpaceVectorDiagramProps) {
  // 図に現れるすべての空間点（軸端・床の隅・ベクトル端・点・平行四辺形の隅）から、倍率 1 の
  // 画面範囲を求める。viewBox（余白を引いた領域）へ収まる最大倍率と中央寄せの原点を決める。
  // axisMax と実データに追従して図が viewBox を埋め、他図と倍率・余白がそろう。
  const boundsPts: readonly Vec3[] = [
    { x: 0, y: 0, z: 0 },
    { x: axisMax, y: 0, z: 0 },
    { x: 0, y: axisMax, z: 0 },
    { x: 0, y: 0, z: axisMax },
    { x: axisMax, y: axisMax, z: 0 }, // 床の奥の隅。
    ...vectors.flatMap((v) => [v.from, v.to]),
    ...points,
    ...(parallelogram
      ? [
          parallelogram.o,
          add(parallelogram.o, parallelogram.a),
          add(parallelogram.o, parallelogram.b),
          add(add(parallelogram.o, parallelogram.a), parallelogram.b),
        ]
      : []),
  ];
  // 投影範囲（倍率適用後）を viewBox 中央へ寄せるよう原点をずらす。奥行き depth は値が
  // 大きいほど視点に近く、床グリッドの濃淡に使う。
  const fit = fitView(projectedBounds(boundsPts, DEFAULT_VIEW), VIEW_W, VIEW_H, MARGIN);
  const { project, depth } = makeProjector(DEFAULT_VIEW, fit);

  // 各軸の正の向きの終点（軸名ラベルを少し外へ離して置く）。
  const axes: readonly Readonly<{ dir: "x" | "y" | "z"; label: string; end: Vec3 }>[] = [
    { dir: "x", label: "x", end: { x: axisMax, y: 0, z: 0 } },
    { dir: "y", label: "y", end: { x: 0, y: axisMax, z: 0 } },
    { dir: "z", label: "z", end: { x: 0, y: 0, z: axisMax } },
  ];
  const originP = project({ x: 0, y: 0, z: 0 });

  // 床グリッドの格子値。3〜4 分割になるよう刻みを選び、端 axisMax を必ず含める。
  const step = axisMax <= 2 ? 0.5 : axisMax <= 5 ? 1 : 2;
  // 格子値は k × step で求める。step は 2 の累乗（0.5・1・2）なので、積は 0 から step を足し重ねた
  // 値と一致し、axisMax + EPS を step で割る計算も丸めを生じない。再帰で作ると axisMax が大きいときに
  // スタックがあふれるため、個数を先に求めて Array.from で作る。
  const stepCount = Math.max(0, Math.floor((axisMax + EPS) / step) + 1);
  const stepped: readonly number[] = Array.from(
    { length: stepCount },
    (_, k) => Math.round(k * step * 1e6) / 1e6,
  );
  const lastStepped = stepped.at(-1);
  const gridValues: readonly number[] =
    lastStepped !== undefined && lastStepped < axisMax - EPS ? [...stepped, axisMax] : stepped;
  // 床グリッドの最大奥行き（手前の隅）。濃淡の正規化に使う。
  const floorMaxDepth = depth({ x: axisMax, y: axisMax, z: 0 }) || 1;
  const gridOpacity = (mx: number, my: number): number => {
    const t = Math.max(0, Math.min(1, depth({ x: mx, y: my, z: 0 }) / floorMaxDepth));
    return 0.4 + 0.45 * t;
  };

  // 落とし込み線の対象（ベクトル終点と点）。床への鉛直線と、床の足から各軸への線を引く。
  const markers: readonly Vec3[] = dropLines
    ? [...vectors.map((v) => v.to), ...points.map((p) => ({ x: p.x, y: p.y, z: p.z }))]
    : [];

  // 軸名は終点の外側へ置く。
  const axisLabelPos = axes.map((ax) => {
    const end = project(ax.end);
    const ang = Math.atan2(end.sy - originP.sy, end.sx - originP.sx);
    return { x: end.sx + Math.cos(ang) * 12, y: end.sy + Math.sin(ang) * 12 };
  });

  // 平行四辺形の 4 隅（起点 o から a、a + b、b の順）。
  const para = parallelogram
    ? {
        p0: project(parallelogram.o),
        p1: project(add(parallelogram.o, parallelogram.a)),
        p2: project(add(add(parallelogram.o, parallelogram.a), parallelogram.b)),
        p3: project(add(parallelogram.o, parallelogram.b)),
        color: parallelogram.color ?? VEC,
      }
    : null;

  // 空間ベクトルの線と矢じり。
  const vectorDraws = vectors.map((v) => {
    const fromP = project(v.from);
    const toP = project(v.to);
    const ang = Math.atan2(toP.sy - fromP.sy, toP.sx - fromP.sx);
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const len = Math.hypot(toP.sx - fromP.sx, toP.sy - fromP.sy) || 1;
    // 矢じり長はベクトルのスクリーン長を超えないよう上限を付ける。短いベクトルで base が
    // 始点を越えて描画が崩れるのを防ぐ。半幅も同じ比率で縮め、矢じりの形を保つ。
    const hl = Math.min(HEAD_LEN, len * 0.8);
    const hh = HEAD_HALF * (hl / HEAD_LEN);
    const base = { sx: toP.sx - hl * cos, sy: toP.sy - hl * sin };
    return {
      color: v.color ?? VEC,
      fromP,
      toP,
      base,
      left: { sx: base.sx - hh * sin, sy: base.sy + hh * cos },
      right: { sx: base.sx + hh * sin, sy: base.sy - hh * cos },
    };
  });

  // 落とし込み線の両端。終点・点から床へ鉛直に下ろし、足から x・y 軸へ引く。
  const dropSegments = (m: Vec3): readonly DropSegment[] => {
    const foot = { x: m.x, y: m.y, z: 0 };
    return [
      ...(Math.abs(m.z) > EPS ? [{ key: "v", a: m, b: foot }] : []),
      ...(Math.abs(m.y) > EPS ? [{ key: "y", a: foot, b: { x: m.x, y: 0, z: 0 } }] : []),
      ...(Math.abs(m.x) > EPS ? [{ key: "x", a: foot, b: { x: 0, y: m.y, z: 0 } }] : []),
    ];
  };

  // ---- ラベルの配置 ----
  // 軸・ベクトル・落とし込み線・床グリッドを障害物に積み、ラベルが線や既出のラベルに重ならない候補を選ぶ。
  const screenOf = (q: Vec3): XY => toXY(project(q));
  const W = OBSTACLE_WEIGHT;
  const axisNameBoxes: readonly Box[] = axes.map((ax, i) =>
    glyphBox({ ...axisLabelPos[i], align: "center" }, glyphSizeOf(ax.label, LABEL_FONT)),
  );
  const paraEdges: readonly (readonly XY[])[] = para
    ? [[para.p0, para.p1, para.p2, para.p3, para.p0].map(toXY)]
    : [];
  const placer = createPlacer([
    ...points.map((pt, i) => {
      const { x, y } = screenOf(pt);
      return boxObstacle(
        { x0: x - POINT_R, x1: x + POINT_R, y0: y - POINT_R, y1: y + POINT_R },
        W.point,
        `pt${i}`,
      );
    }),
    ...axes.flatMap((ax) =>
      lineObstacle(`ax-${ax.dir}`, [toXY(originP), screenOf(ax.end)], W.axis),
    ),
    ...vectorDraws.flatMap((v, i) => lineObstacle(`vc${i}`, [toXY(v.fromP), toXY(v.toP)], W.line)),
    ...paraEdges.flatMap((pts) => lineObstacle("pg", pts, W.edge)),
    ...markers
      .flatMap(dropSegments)
      .flatMap((seg) => lineObstacle("dp", [screenOf(seg.a), screenOf(seg.b)], W.edge)),
    ...(floorGrid
      ? gridValues.flatMap((g) => [
          ...lineObstacle(
            "gd",
            [screenOf({ x: g, y: 0, z: 0 }), screenOf({ x: g, y: axisMax, z: 0 })],
            W.grid,
            true,
          ),
          ...lineObstacle(
            "gd",
            [screenOf({ x: 0, y: g, z: 0 }), screenOf({ x: axisMax, y: g, z: 0 })],
            W.grid,
            true,
          ),
        ])
      : []),
  ]);

  const place = (
    tex: string,
    candidates: (size: GlyphSize) => readonly Candidate<LabelPos>[],
    placed: readonly Box[],
    exclude?: string,
  ) => {
    const size = glyphSizeOf(tex, LABEL_FONT);
    const pos = placer.place(candidates(size), {
      placed,
      bounds: VIEW_BOUNDS,
      exclude,
      rowGap: LABEL_POLICY.rowGap,
    }).item;
    return placedLabel(tex, pos, size);
  };

  // ラベルは、平行四辺形・ベクトル・点の順に 1 つずつ置く。後のラベルが先のラベルを避ける。
  const paraLabels: readonly Readonly<{ tex: string; anchor: XY }>[] =
    parallelogram?.label !== undefined && para
      ? [
          {
            tex: parallelogram.label,
            anchor:
              parallelogram.labelAt === undefined
                ? { x: (para.p0.sx + para.p2.sx) / 2, y: (para.p0.sy + para.p2.sy) / 2 }
                : screenOf(parallelogram.labelAt),
          },
        ]
      : [];
  const paraPlaced = placeInOrder(paraLabels, axisNameBoxes, ({ tex, anchor }, _, placed) =>
    place(
      tex,
      (size) =>
        anchoredCandidates(anchor, size, parallelogram?.labelDir, parallelogram?.labelOffset),
      placed,
    ),
  );
  const vectorPlaced = placeInOrder(vectors, paraPlaced.placed, (v, i, placed) => {
    if (v.label === undefined) return NO_PLACEMENT;
    const { fromP, toP } = vectorDraws[i];
    const from = toXY(fromP);
    const to = toXY(toP);
    return place(
      v.label,
      (size) =>
        lineLabelCandidates(
          {
            at: v.labelAt === undefined ? undefined : screenOf(v.labelAt),
            dir: v.labelDir,
            offset: v.labelOffset,
          },
          from,
          to,
          size,
          (offset) => besideVectorCandidates(from, to, size, HEAD_HALF, offset, VECTOR_FRACTIONS),
        ),
      placed,
      // 基準点が線の上でも線を避けられるよう、labelAt があれば自分の線も判定に含める。
      v.labelAt === undefined ? `vc${i}` : undefined,
    );
  });
  const pointPlaced = placeInOrder(points, vectorPlaced.placed, (pt, i, placed) => {
    if (pt.label === undefined) return NO_PLACEMENT;
    const at = screenOf(pt);
    return place(
      pt.label,
      (size) => {
        const spec = {
          at: pt.labelAt === undefined ? undefined : screenOf(pt.labelAt),
          dir: pt.labelDir,
          offset: pt.labelOffset,
        };
        // 点のラベルが読み違えられる相手の印。他の点と、ベクトルの両端である。
        const rivals = [
          ...points.flatMap((q, k) => (k === i ? [] : [screenOf(q)])),
          ...vectorDraws.flatMap((v) => [toXY(v.fromP), toXY(v.toP)]),
        ];
        return pointLabelCandidates(spec, at, size, POINT_R, () =>
          preferringOwnMark(
            widelyAroundPoint(at, size, POINT_R, pt.labelOffset),
            at,
            rivals,
            W.point,
          ),
        );
      },
      placed,
      // 基準点が点の上でも印を避けられるよう、labelAt があれば自分の印も判定に含める。
      pt.labelAt === undefined ? `pt${i}` : undefined,
    );
  });

  // 置いたラベルを描く。
  const labelNode = (l: Label | null | undefined): ReactNode =>
    l && (
      <KatexLabel tex={l.tex} x={l.pos.x} y={l.pos.y} fontSize={LABEL_FONT} align={l.pos.align} />
    );

  return (
    <svg
      className="space-vector"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label={ariaLabel}
    >
      {/* 床グリッド（z=0 の xy 平面）。奥を淡く手前を濃くして遠近を表す。背面に敷く。 */}
      {floorGrid && (
        <g>
          {gridValues.map((gx) => {
            const a = project({ x: gx, y: 0, z: 0 });
            const b = project({ x: gx, y: axisMax, z: 0 });
            return (
              <line
                key={`gx-${gx}`}
                x1={a.sx}
                y1={a.sy}
                x2={b.sx}
                y2={b.sy}
                stroke={GRID}
                strokeWidth={1}
                strokeOpacity={gridOpacity(gx, axisMax / 2)}
              />
            );
          })}
          {gridValues.map((gy) => {
            const a = project({ x: 0, y: gy, z: 0 });
            const b = project({ x: axisMax, y: gy, z: 0 });
            return (
              <line
                key={`gy-${gy}`}
                x1={a.sx}
                y1={a.sy}
                x2={b.sx}
                y2={b.sy}
                stroke={GRID}
                strokeWidth={1}
                strokeOpacity={gridOpacity(axisMax / 2, gy)}
              />
            );
          })}
        </g>
      )}

      {/* 落とし込み線。終点・点から床へ鉛直に下ろし、足から x・y 軸へ破線を引く。 */}
      {markers.length > 0 && (
        <g>
          {markers.flatMap((m, i) => {
            const fp = project({ x: m.x, y: m.y, z: 0 });
            return [
              ...dropSegments(m).map((seg) => {
                const a = project(seg.a);
                const b = project(seg.b);
                return (
                  <Line
                    key={`drop-${seg.key}-${i}`}
                    from={{ x: a.sx, y: a.sy }}
                    to={{ x: b.sx, y: b.sy }}
                    stroke={AXIS}
                    strokeWidth={1}
                    strokeOpacity={0.55}
                    strokeDasharray="3 3"
                  />
                );
              }),
              ...(Math.abs(m.z) > EPS
                ? [
                    <circle
                      key={`foot-${i}`}
                      cx={fp.sx}
                      cy={fp.sy}
                      r={1.8}
                      fill={AXIS}
                      fillOpacity={0.6}
                    />,
                  ]
                : []),
            ];
          })}
        </g>
      )}

      {/* 平行四辺形（半透明の塗り）。2 ベクトル a, b が起点 o から張る面を示す。 */}
      {parallelogram && para && (
        <g>
          <polygon
            points={`${para.p0.sx},${para.p0.sy} ${para.p1.sx},${para.p1.sy} ${para.p2.sx},${para.p2.sy} ${para.p3.sx},${para.p3.sy}`}
            fill={para.color}
            fillOpacity={0.18}
            stroke={para.color}
            strokeWidth={1}
            strokeDasharray="4 3"
          />
          {labelNode(paraPlaced.items[0])}
        </g>
      )}

      {/* 3 軸。正の向きに矢印を付け、軸名を添える。 */}
      {axes.map((ax, i) => {
        const end = project(ax.end);
        const ang = Math.atan2(end.sy - originP.sy, end.sx - originP.sx);
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        const base = { sx: end.sx - HEAD_LEN * cos, sy: end.sy - HEAD_LEN * sin };
        const left = { sx: base.sx - HEAD_HALF * sin, sy: base.sy + HEAD_HALF * cos };
        const right = { sx: base.sx + HEAD_HALF * sin, sy: base.sy - HEAD_HALF * cos };
        const lp = axisLabelPos[i];
        return (
          <g key={`axis-${ax.dir}`}>
            <Line
              from={{ x: originP.sx, y: originP.sy }}
              to={{ x: base.sx, y: base.sy }}
              stroke={AXIS}
              strokeWidth={1.3}
            />
            <polygon
              points={`${end.sx},${end.sy} ${left.sx},${left.sy} ${right.sx},${right.sy}`}
              fill={AXIS}
            />
            <KatexLabel tex={ax.label} x={lp.x} y={lp.y} fontSize={LABEL_FONT} />
          </g>
        );
      })}

      {/* 空間ベクトル（有向線分）。矢じりは polygon を手計算で置く。 */}
      {vectors.map((v, i) => {
        const { color, fromP, toP, base, left, right } = vectorDraws[i];
        return (
          <g key={`vec-${i}`}>
            <Line
              from={{ x: fromP.sx, y: fromP.sy }}
              to={{ x: base.sx, y: base.sy }}
              stroke={color}
              strokeWidth={2}
              strokeDasharray={v.dashed ? "5 4" : undefined}
              strokeLinecap="round"
            />
            <polygon
              points={`${toP.sx},${toP.sy} ${left.sx},${left.sy} ${right.sx},${right.sy}`}
              fill={color}
            />
            {labelNode(vectorPlaced.items[i])}
          </g>
        );
      })}

      {/* 点。 */}
      {points.map((p, i) => {
        const sp = project(p);
        const color = p.highlight ? HIGHLIGHT : "currentColor";
        return (
          <g key={`pt-${i}`}>
            <circle cx={sp.sx} cy={sp.sy} r={POINT_R} fill={color} />
            {labelNode(pointPlaced.items[i])}
          </g>
        );
      })}
    </svg>
  );
}

/** ベクトルの成分ごとの和を返す。 */
function add(p: Vec3, q: Vec3): Vec3 {
  return { x: p.x + q.x, y: p.y + q.y, z: p.z + q.z };
}

/** 落とし込み線の 1 本。 */
type DropSegment = Readonly<{ key: string; a: Vec3; b: Vec3 }>;
