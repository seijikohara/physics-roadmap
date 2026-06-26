import { Line } from "@visx/shape";
import KatexLabel from "./KatexLabel";

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
 * 投影は、方位角 AZIMUTH・仰角 ELEVATION を持つ正投影（ダイメトリック軸測）である。$y$ 軸を
 * 真横に寝かせる斜投影だと床面（$xy$ 平面）が線分に潰れて立体に見えない。そこで $x$ 軸を
 * 左手前へ、$y$ 軸を右奥へ、双方に下向きの傾きを与え、$xy$ 平面が「奥へ広がる床」に見える
 * 視点を取る。$z$ 軸は画面の上向きである。
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
type SpaceVec = {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  /** 線分の中点付近に置く LaTeX ラベル（例: "\\vec{a}"）。 */
  label?: string;
  /** ベクトルの色。既定は青系。 */
  color?: string;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
};

/** 空間内の 1 点。塗りつぶしの小丸で描く。 */
type SpacePoint = {
  x: number;
  y: number;
  z: number;
  /** 点に添える LaTeX ラベル。 */
  label?: string;
  /** 強調色で描くか。既定 false。 */
  highlight?: boolean;
};

/** 起点 o から 2 ベクトル a, b が張る平行四辺形。外積の面積の図示に使う。半透明で塗る。 */
type Parallelogram = {
  o: { x: number; y: number; z: number };
  a: { x: number; y: number; z: number };
  b: { x: number; y: number; z: number };
  /** 平行四辺形の中心付近に置く LaTeX ラベル。 */
  label?: string;
  /** 塗りの色。既定は青系。 */
  color?: string;
};

type SpaceVectorDiagramProps = {
  /** 空間ベクトル（有向線分）。 */
  vectors?: SpaceVec[];
  /** 空間内に置く点。 */
  points?: SpacePoint[];
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
};

// 軸・ベクトルは global.css の CSS 変数でテーマに追従する。
const AXIS = "var(--fig-axis)";
const GRID = "var(--fig-grid)";
const VEC = "#3b82f6";
const HIGHLIGHT = "#f59e0b";

// 描画領域。他の図と高さ感をそろえ、正方に近い縦横比にする。
const VIEW_W = 320;
const VIEW_H = 280;

// 正投影の視点。方位角 AZIMUTH（鉛直軸まわりの回転）と仰角 ELEVATION（見下ろし角）で決める。
// 35°・30° のダイメトリックは、床面が十分開いて見え、3 軸の成分も読み取りやすい。
const AZIMUTH = (35 * Math.PI) / 180;
const ELEVATION = (30 * Math.PI) / 180;
const SIN_T = Math.sin(AZIMUTH);
const COS_T = Math.cos(AZIMUTH);
const SIN_P = Math.sin(ELEVATION);
const COS_P = Math.cos(ELEVATION);

// 空間の単位ベクトルを写す画面ベクトルの向き（1 単位あたりの画面 px は倍率 SCALE を掛けて決める）。
// SVG は下向きが正のため、上向きの z 軸は画面の負の y へ向ける。x は左手前（左・下）、y は
// 右奥（右・下、x より浅い）へ退かせ、xy 平面を床として見せる。
const DIR_X = { sx: -SIN_T, sy: COS_T * SIN_P }; // x 軸: 左手前。
const DIR_Y = { sx: COS_T, sy: SIN_T * SIN_P }; // y 軸: 右奥。
const DIR_Z = { sx: 0, sy: -COS_P }; // z 軸: 上。

// 視線方向（画面手前を正とする奥行き）。値が大きいほど視点に近い。床グリッドの濃淡に使う。
const FWD = { x: COS_T * COS_P, y: SIN_T * COS_P, z: SIN_P };

// 軸の周りに確保する余白（軸名ラベル・矢じりを収める）。
const MARGIN = 32;

// 矢じり。長さ（線方向）と半幅（直交方向）を px で与える。
const HEAD_LEN = 9;
const HEAD_HALF = 3.6;

// 座標が 0 とみなせる許容値（落とし込み線の退化を判定する）。
const EPS = 1e-6;

type Vec3 = { x: number; y: number; z: number };

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
  const boundsPts: Vec3[] = [
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
  const raw = boundsPts.map((p) => ({
    sx: p.x * DIR_X.sx + p.y * DIR_Y.sx + p.z * DIR_Z.sx,
    sy: p.x * DIR_X.sy + p.y * DIR_Y.sy + p.z * DIR_Z.sy,
  }));
  const minSx = Math.min(...raw.map((c) => c.sx));
  const maxSx = Math.max(...raw.map((c) => c.sx));
  const minSy = Math.min(...raw.map((c) => c.sy));
  const maxSy = Math.max(...raw.map((c) => c.sy));
  const spanX = maxSx - minSx || 1;
  const spanY = maxSy - minSy || 1;
  const scale = Math.min((VIEW_W - 2 * MARGIN) / spanX, (VIEW_H - 2 * MARGIN) / spanY);
  // 投影範囲（倍率適用後）を viewBox 中央へ寄せるよう原点をずらす。
  const originX = (VIEW_W - (minSx + maxSx) * scale) / 2;
  const originY = (VIEW_H - (minSy + maxSy) * scale) / 2;

  const EX = { sx: DIR_X.sx * scale, sy: DIR_X.sy * scale };
  const EY = { sx: DIR_Y.sx * scale, sy: DIR_Y.sy * scale };
  const EZ = { sx: DIR_Z.sx * scale, sy: DIR_Z.sy * scale };

  const project = (p: Vec3): { sx: number; sy: number } => ({
    sx: originX + p.x * EX.sx + p.y * EY.sx + p.z * EZ.sx,
    sy: originY + p.x * EX.sy + p.y * EY.sy + p.z * EZ.sy,
  });
  const depth = (p: Vec3): number => p.x * FWD.x + p.y * FWD.y + p.z * FWD.z;

  // 各軸の正の向きの終点（軸名ラベルを少し外へ離して置く）。
  const axes: { dir: "x" | "y" | "z"; label: string; end: Vec3 }[] = [
    { dir: "x", label: "x", end: { x: axisMax, y: 0, z: 0 } },
    { dir: "y", label: "y", end: { x: 0, y: axisMax, z: 0 } },
    { dir: "z", label: "z", end: { x: 0, y: 0, z: axisMax } },
  ];
  const originP = project({ x: 0, y: 0, z: 0 });

  // 床グリッドの格子値。3〜4 分割になるよう刻みを選び、端 axisMax を必ず含める。
  const step = axisMax <= 2 ? 0.5 : axisMax <= 5 ? 1 : 2;
  const gridValues: number[] = [];
  for (let t = 0; t <= axisMax + EPS; t += step) gridValues.push(Math.round(t * 1e6) / 1e6);
  if (gridValues[gridValues.length - 1] < axisMax - EPS) gridValues.push(axisMax);
  // 床グリッドの最大奥行き（手前の隅）。濃淡の正規化に使う。
  const floorMaxDepth = depth({ x: axisMax, y: axisMax, z: 0 }) || 1;
  const gridOpacity = (mx: number, my: number): number => {
    const t = Math.max(0, Math.min(1, depth({ x: mx, y: my, z: 0 }) / floorMaxDepth));
    return 0.4 + 0.45 * t;
  };

  // 落とし込み線の対象（ベクトル終点と点）。床への鉛直線と、床の足から各軸への線を引く。
  const markers: Vec3[] = dropLines
    ? [...vectors.map((v) => v.to), ...points.map((p) => ({ x: p.x, y: p.y, z: p.z }))]
    : [];

  // 当たり判定に使う線分（軸 3 本とベクトル）。ラベルが線・矢じりの上に乗らないよう、
  // ラベル中心から線分までの距離が近い候補にペナルティを課す。
  const segs: Seg[] = [
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

  // ラベルの自動配置。軸名・線分・矢じり・既出ラベルとの重なりを避けるよう、複数候補から
  // 衝突の少ない位置を選ぶ。軸名を先に積み、平行四辺形・ベクトル・点のラベルを順に逃がす。
  const placedBoxes: Box[] = [];
  const place = (
    cx: number,
    cy: number,
    cands: { dx: number; dy: number }[],
    tex: string,
  ): {
    x: number;
    y: number;
  } => {
    const w = estimateTexWidth(tex);
    let best = cands[0];
    let bestP = Infinity;
    cands.forEach((c, i) => {
      const lx = cx + c.dx;
      const ly = cy + c.dy;
      const box = boxFor(lx, ly, w);
      let p = i * 0.1; // 同点なら前方の候補を優先。
      if (box.x0 < 2 || box.x1 > VIEW_W - 2 || box.y0 < 2 || box.y1 > VIEW_H - 2) p += 1000;
      // ラベル同士の重なりは最優先で避ける（線分近接より重く罰する）。
      for (const q of placedBoxes) if (boxesOverlap(box, q)) p += 15;
      // ラベルの矩形が線分に近すぎる（線・矢じりを覆う・端が接する）候補を避ける。中心ではなく
      // 矩形で測り、幅の広いラベル（外積など）の端が縦の線に接するのを防ぐ。
      for (const s of segs) if (segBoxDist(s, box) < 4) p += 12;
      if (p < bestP) {
        bestP = p;
        best = c;
      }
    });
    placedBoxes.push(boxFor(cx + best.dx, cy + best.dy, w));
    return { x: cx + best.dx, y: cy + best.dy };
  };

  // 軸名は終点の外側へ置き、当たり判定に積む（以降のラベルが軸名を避ける）。
  const axisLabelPos = axes.map((ax) => {
    const end = project(ax.end);
    const ang = Math.atan2(end.sy - originP.sy, end.sx - originP.sx);
    const lx = end.sx + Math.cos(ang) * 12;
    const ly = end.sy + Math.sin(ang) * 12;
    placedBoxes.push(boxFor(lx, ly, estimateTexWidth(ax.label)));
    return { x: lx, y: ly };
  });

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
            const lines: { key: string; a: Vec3; b: Vec3 }[] = [];
            if (Math.abs(m.z) > EPS) lines.push({ key: `v-${i}`, a: m, b: foot });
            if (Math.abs(m.y) > EPS)
              lines.push({ key: `y-${i}`, a: foot, b: { x: m.x, y: 0, z: 0 } });
            if (Math.abs(m.x) > EPS)
              lines.push({ key: `x-${i}`, a: foot, b: { x: 0, y: m.y, z: 0 } });
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
      {parallelogram && (
        <g>
          {(() => {
            const { o, a, b } = parallelogram;
            const p0 = project(o);
            const p1 = project(add(o, a));
            const p2 = project(add(add(o, a), b));
            const p3 = project(add(o, b));
            const color = parallelogram.color ?? VEC;
            const cx = (p0.sx + p2.sx) / 2;
            const cy = (p0.sy + p2.sy) / 2;
            const lp =
              parallelogram.label !== undefined
                ? place(
                    cx,
                    cy,
                    [
                      { dx: 0, dy: 0 },
                      { dx: 0, dy: -14 },
                      { dx: 0, dy: 14 },
                      { dx: 16, dy: 0 },
                      { dx: -16, dy: 0 },
                    ],
                    parallelogram.label,
                  )
                : null;
            return (
              <>
                <polygon
                  points={`${p0.sx},${p0.sy} ${p1.sx},${p1.sy} ${p2.sx},${p2.sy} ${p3.sx},${p3.sy}`}
                  fill={color}
                  fillOpacity={0.18}
                  stroke={color}
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
                {lp && parallelogram.label !== undefined && (
                  <KatexLabel tex={parallelogram.label} x={lp.x} y={lp.y} fontSize={12} />
                )}
              </>
            );
          })()}
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
        const color = v.color ?? VEC;
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
        const left = { sx: base.sx - hh * sin, sy: base.sy + hh * cos };
        const right = { sx: base.sx + hh * sin, sy: base.sy - hh * cos };
        // ラベルは線分の中点を基準に、直交方向へ逃がしつつ線に沿って前後へもずらす。長い
        // ベクトル（縦に伸びる外積など）は、中点で隣のラベルと衝突しても、矢印に沿って先端側へ
        // 滑らせれば空きが見つかる。直交のみだと幅の広いラベルが逃げ切れない。
        const mx = (fromP.sx + toP.sx) / 2;
        const my = (fromP.sy + toP.sy) / 2;
        const perpX = -(toP.sy - fromP.sy) / len;
        const perpY = (toP.sx - fromP.sx) / len;
        const alongX = (toP.sx - fromP.sx) / len;
        const alongY = (toP.sy - fromP.sy) / len;
        const cand = (a: number, p: number): { dx: number; dy: number } => ({
          dx: alongX * a + perpX * p,
          dy: alongY * a + perpY * p,
        });
        // 直交方向の逃がし量はラベル半幅に余白を足して決める。幅の広いラベル（外積 a×b など）
        // でも、近い端が自分のベクトル線から確実に離れるようにする。
        const perpClear = estimateTexWidth(v.label ?? "") / 2 + 9;
        const lp =
          v.label !== undefined
            ? place(
                mx,
                my,
                [
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
                v.label,
              )
            : null;
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

      {/* 点。ラベルは真上を第一候補に、衝突を避けて上下左右へ逃がす。 */}
      {points.map((p, i) => {
        const sp = project(p);
        const color = p.highlight ? HIGHLIGHT : "currentColor";
        const lp =
          p.label !== undefined
            ? place(
                sp.sx,
                sp.sy,
                [
                  { dx: 0, dy: -13 },
                  { dx: 0, dy: 14 },
                  { dx: 13, dy: -11 },
                  { dx: -13, dy: -11 },
                  { dx: 13, dy: 12 },
                  { dx: -13, dy: 12 },
                ],
                p.label,
              )
            : null;
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
type Seg = { ax: number; ay: number; bx: number; by: number };

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
  let min = Infinity;
  const N = 16;
  for (let i = 0; i <= N; i += 1) {
    const t = i / N;
    const d = pointToBox(s.ax + (s.bx - s.ax) * t, s.ay + (s.by - s.ay) * t, b);
    if (d < min) min = d;
  }
  return min;
}

/** 当たり判定に使う軸並行の矩形（左上 (x0,y0)・右下 (x1,y1)）。 */
type Box = { x0: number; x1: number; y0: number; y1: number };

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

/** LaTeX 文字列の表示幅をおおまかに見積もる（DOM が無いビルド時の概算。安全側に広めに取る）。 */
function estimateTexWidth(tex: string, fontSize = 12): number {
  // LaTeX コマンド（\vec・\times など）は描画上 1 グリフ相当とみなし、命令名 1 つを 1 文字に
  // 畳む。コマンド名を字数で数えると \times が 5 文字分に膨れ、ボックスが過大化して衝突回避が
  // 過剰に働く（長い数式ラベルが逃げ場を失う）。装飾記号（{ } ^ _ $ 空白）は幅 0 とする。
  const visible = tex.replace(/\\[a-zA-Z]+/g, "x").replace(/[{}^_$\s]/g, "");
  return Math.max(visible.length * fontSize * 0.6, 14);
}
