import { Line } from "@visx/shape";
import KatexLabel from "./KatexLabel";
import { DEFAULT_VIEW, fitView, makeProjector, projectedBounds } from "./projection3d";
import type { Vec3 } from "./projection3d";

/**
 * インライン SVG として描く、ビルド時生成の静的な空間ベクトルの軸測図。
 *
 * 3 次元の右手系を 2 次元画面へ正投影（軸測投影）して描く。$x, y, z$ の 3 軸と、空間
 * ベクトル（有向線分）・点・2 ベクトルが張る平行四辺形を 1 枚の静的な図で表す。空間
 * ベクトルの成分・和・外積の面積を視覚化する。本コンポーネントはクライアント JavaScript を
 * 一切載せない。Astro がビルド時に HTML へ描画する（クライアントディレクティブなし、
 * ハイドレーションなし）。軸・ベクトルは `@visx/shape` の `Line` で描き、矢じりは色を動的に
 * 変えられるよう polygon を手計算で置く。ラベルは KatexLabel を介して KaTeX で組版する。
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

/** 空間ベクトル（有向線分）。始点 from から終点 to へ矢じり付きで描く。 */
type SpaceVec = Readonly<{
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
type SpacePoint = Readonly<{
  x: number;
  y: number;
  z: number;
  /** 点に添える LaTeX ラベル。 */
  label?: string;
  /** 強調色で描くか。既定 false。 */
  highlight?: boolean;
}>;

/** 起点 o から 2 ベクトル a, b が張る平行四辺形。外積の面積の図示に使う。半透明で塗る。 */
type Parallelogram = Readonly<{
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
  // 格子値は 0 から step を 1 回ずつ足して求める（積 k × step に置き換えず、和の取り方を保つ）。
  const steppedFrom = (t: number): readonly number[] =>
    t <= axisMax + EPS ? [Math.round(t * 1e6) / 1e6, ...steppedFrom(t + step)] : [];
  const stepped = steppedFrom(0);
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

  // 当たり判定に使う線分（軸 3 本とベクトル）。ラベルが線・矢じりの上に乗らないよう、
  // ラベル中心から線分までの距離が近い候補にペナルティを課す。
  const segs: readonly Seg[] = [
    ...axes.map((ax) => {
      const e = project(ax.end);
      return { ax: originP.sx, ay: originP.sy, bx: e.sx, by: e.sy };
    }),
    ...vectors.map((v) => {
      const f = project(v.from);
      const t = project(v.to);
      return { ax: f.sx, ay: f.sy, bx: t.sx, by: t.sy };
    }),
  ];

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
      len,
    };
  });

  // ラベルの自動配置。軸名・線分・矢じり・既出ラベルとの重なりを避けるよう、複数候補から
  // 衝突の少ない位置を選ぶ。軸名を先に積み、平行四辺形・ベクトル・点のラベルを順に逃がす。
  const axisBoxes = axes.map((ax, i) =>
    boxFor(axisLabelPos[i].x, axisLabelPos[i].y, estimateTexWidth(ax.label)),
  );
  const paraPlaced = placeEach(axisBoxes, segs, [
    parallelogram?.label !== undefined && para
      ? {
          cx: (para.p0.sx + para.p2.sx) / 2,
          cy: (para.p0.sy + para.p2.sy) / 2,
          cands: [
            { dx: 0, dy: 0 },
            { dx: 0, dy: -14 },
            { dx: 0, dy: 14 },
            { dx: 16, dy: 0 },
            { dx: -16, dy: 0 },
          ],
          tex: parallelogram.label,
        }
      : null,
  ]);
  const vectorPlaced = placeEach(
    paraPlaced.placed,
    segs,
    vectors.map((v, i) => {
      if (v.label === undefined) return null;
      const { fromP, toP, len } = vectorDraws[i];
      // ラベルは線分の中点を基準に、直交方向へ逃がしつつ線に沿って前後へもずらす。長い
      // ベクトル（縦に伸びる外積など）は、中点で隣のラベルと衝突しても、矢印に沿って先端側へ
      // 滑らせれば空きが見つかる。直交のみだと幅の広いラベルが逃げ切れない。
      const perpX = -(toP.sy - fromP.sy) / len;
      const perpY = (toP.sx - fromP.sx) / len;
      const alongX = (toP.sx - fromP.sx) / len;
      const alongY = (toP.sy - fromP.sy) / len;
      const cand = (a: number, p: number): Offset => ({
        dx: alongX * a + perpX * p,
        dy: alongY * a + perpY * p,
      });
      // 直交方向の逃がし量はラベル半幅に余白を足して決める。幅の広いラベル（外積 a×b など）
      // でも、近い端が自分のベクトル線から確実に離れるようにする。
      const perpClear = estimateTexWidth(v.label) / 2 + 9;
      return {
        cx: (fromP.sx + toP.sx) / 2,
        cy: (fromP.sy + toP.sy) / 2,
        cands: [
          cand(0, perpClear),
          cand(0, -perpClear),
          cand(0, 13),
          cand(0, -13),
          cand(0, 22),
          cand(0, -22),
          cand(26, perpClear),
          cand(26, -perpClear),
          cand(-26, perpClear),
          cand(-26, -perpClear),
          cand(26, 0),
          cand(-26, 0),
        ],
        tex: v.label,
      };
    }),
  );
  // 点のラベルは真上を第一候補に、衝突を避けて上下左右へ逃がす。
  const pointPlaced = placeEach(
    vectorPlaced.placed,
    segs,
    points.map((p) => {
      if (p.label === undefined) return null;
      const sp = project(p);
      return {
        cx: sp.sx,
        cy: sp.sy,
        cands: [
          { dx: 0, dy: -13 },
          { dx: 0, dy: 14 },
          { dx: 13, dy: -11 },
          { dx: -13, dy: -11 },
          { dx: 13, dy: 12 },
          { dx: -13, dy: 12 },
        ],
        tex: p.label,
      };
    }),
  );
  const paraLabelPos = paraPlaced.positions[0];

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
            const foot = { x: m.x, y: m.y, z: 0 };
            const fp = project(foot);
            const lines: readonly Readonly<{ key: string; a: Vec3; b: Vec3 }>[] = [
              ...(Math.abs(m.z) > EPS ? [{ key: `v-${i}`, a: m, b: foot }] : []),
              ...(Math.abs(m.y) > EPS
                ? [{ key: `y-${i}`, a: foot, b: { x: m.x, y: 0, z: 0 } }]
                : []),
              ...(Math.abs(m.x) > EPS
                ? [{ key: `x-${i}`, a: foot, b: { x: 0, y: m.y, z: 0 } }]
                : []),
            ];
            return [
              ...lines.map((seg) => {
                const a = project(seg.a);
                const b = project(seg.b);
                return (
                  <Line
                    key={`drop-${seg.key}`}
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
          {paraLabelPos && parallelogram.label !== undefined && (
            <KatexLabel
              tex={parallelogram.label}
              x={paraLabelPos.x}
              y={paraLabelPos.y}
              fontSize={12}
            />
          )}
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
            <KatexLabel tex={ax.label} x={lp.x} y={lp.y} fontSize={12} />
          </g>
        );
      })}

      {/* 空間ベクトル（有向線分）。矢じりは polygon を手計算で置く。 */}
      {vectors.map((v, i) => {
        const { color, fromP, toP, base, left, right } = vectorDraws[i];
        const lp = vectorPlaced.positions[i];
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
            {lp && v.label !== undefined && (
              <KatexLabel tex={v.label} x={lp.x} y={lp.y} fontSize={12} />
            )}
          </g>
        );
      })}

      {/* 点。 */}
      {points.map((p, i) => {
        const sp = project(p);
        const color = p.highlight ? HIGHLIGHT : "currentColor";
        const lp = pointPlaced.positions[i];
        return (
          <g key={`pt-${i}`}>
            <circle cx={sp.sx} cy={sp.sy} r={3.6} fill={color} />
            {lp && p.label !== undefined && (
              <KatexLabel tex={p.label} x={lp.x} y={lp.y} fontSize={12} />
            )}
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

/** 当たり判定に使う線分（画面座標の端点 a→b）。 */
type Seg = Readonly<{ ax: number; ay: number; bx: number; by: number }>;

/** 点 (px, py) から軸並行矩形 b までの最短距離（矩形の内部なら 0）。 */
function pointToBox(px: number, py: number, b: Box): number {
  const dx = Math.max(b.x0 - px, 0, px - b.x1);
  const dy = Math.max(b.y0 - py, 0, py - b.y1);
  return Math.hypot(dx, dy);
}

/**
 * 線分 s と軸並行矩形 b の最短距離の近似。線分を標本化し、各点から矩形までの距離の最小を返す。
 * ラベル中心ではなく矩形で線分との近接を測り、幅の広いラベルの端が線に接するのを検出する。
 */
function segBoxDist(s: Seg, b: Box): number {
  const N = 16;
  // 標本点 i から先の最小を、それまでの最小 min と比べながら求める（SurfacePlot と同じ方式）。
  const minFrom = (i: number, min: number): number => {
    if (i > N) return min;
    const t = i / N;
    const d = pointToBox(s.ax + (s.bx - s.ax) * t, s.ay + (s.by - s.ay) * t, b);
    return minFrom(i + 1, d < min ? d : min);
  };
  return minFrom(0, Infinity);
}

/** 当たり判定に使う軸並行の矩形（左上 (x0,y0)・右下 (x1,y1)）。 */
type Box = Readonly<{ x0: number; x1: number; y0: number; y1: number }>;

/** ラベルの想定文字高（viewBox 単位）。当たり判定の縦幅に使う。 */
const LABEL_H = 15;

/** 中心 (cx, cy) と推定文字幅から、ラベルが占める矩形を求める（中央寄せ前提）。 */
function boxFor(cx: number, cy: number, w: number): Box {
  return { x0: cx - w / 2, x1: cx + w / 2, y0: cy - LABEL_H / 2, y1: cy + LABEL_H / 2 };
}

/** 2 つの矩形が重なるか。 */
function boxesOverlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/** ラベルの中心を基準点からずらす量。 */
type Offset = Readonly<{ dx: number; dy: number }>;

/** 置いたラベルの中心。 */
type LabelPos = Readonly<{ x: number; y: number }>;

/** 1 つのラベルの配置の依頼。基準点 (cx, cy) と、優先順に並べたずらしの候補を持つ。 */
type LabelRequest = Readonly<{ cx: number; cy: number; cands: readonly Offset[]; tex: string }>;

/**
 * ラベルの位置を候補から選ぶ。既出のラベルの矩形 placed・線分 segs との衝突の罰点が最も小さい
 * 候補を返す。
 */
function chooseLabel(
  placed: readonly Box[],
  segs: readonly Seg[],
  { cx, cy, cands, tex }: LabelRequest,
): LabelPos {
  const w = estimateTexWidth(tex);
  const best = cands.reduce<Readonly<{ c: Offset; p: number }>>(
    (acc, c, i) => {
      const box = boxFor(cx + c.dx, cy + c.dy, w);
      const p0 = i * 0.1; // 同点なら前方の候補を優先。
      const p1 =
        box.x0 < 2 || box.x1 > VIEW_W - 2 || box.y0 < 2 || box.y1 > VIEW_H - 2 ? p0 + 1000 : p0;
      // ラベル同士の重なりは最優先で避ける（線分近接より重く罰する）。
      const p2 = placed.reduce((p, q) => (boxesOverlap(box, q) ? p + 15 : p), p1);
      // ラベルの矩形が線分に近すぎる（線・矢じりを覆う・端が接する）候補を避ける。中心ではなく
      // 矩形で測り、幅の広いラベル（外積など）の端が縦の線に接するのを防ぐ。
      const p3 = segs.reduce((p, s) => (segBoxDist(s, box) < 4 ? p + 12 : p), p2);
      return p3 < acc.p ? { c, p: p3 } : acc;
    },
    { c: cands[0], p: Infinity },
  );
  return { x: cx + best.c.dx, y: cy + best.c.dy };
}

/**
 * ラベルを依頼の順に 1 つずつ置く。置いたラベルの矩形を placed に積み、後のラベルが避ける。
 * 依頼が null の項目は何も置かず、位置も null とする（位置の並びを依頼の並びとそろえる）。
 */
function placeEach(
  placed: readonly Box[],
  segs: readonly Seg[],
  requests: readonly (LabelRequest | null)[],
): Readonly<{ positions: readonly (LabelPos | null)[]; placed: readonly Box[] }> {
  return requests.reduce<
    Readonly<{ positions: readonly (LabelPos | null)[]; placed: readonly Box[] }>
  >(
    (acc, req) => {
      if (req === null) return { positions: [...acc.positions, null], placed: acc.placed };
      const pos = chooseLabel(acc.placed, segs, req);
      return {
        positions: [...acc.positions, pos],
        placed: [...acc.placed, boxFor(pos.x, pos.y, estimateTexWidth(req.tex))],
      };
    },
    { positions: [], placed },
  );
}

/** LaTeX 文字列の表示幅をおおまかに見積もる（DOM が無いビルド時の概算。安全側に広めに取る）。 */
function estimateTexWidth(tex: string, fontSize = 12): number {
  // LaTeX コマンド（\vec・\times など）は描画上 1 グリフ相当とみなし、命令名 1 つを 1 文字に
  // 畳む。コマンド名を字数で数えると \times が 5 文字分に膨れ、ボックスが過大化して衝突回避が
  // 過剰に働く（長い数式ラベルが逃げ場を失う）。装飾記号（{ } ^ _ $ 空白）は幅 0 とする。
  const visible = tex.replace(/\\[a-zA-Z]+/g, "x").replace(/[{}^_$\s]/g, "");
  return Math.max(visible.length * fontSize * 0.6, 14);
}
