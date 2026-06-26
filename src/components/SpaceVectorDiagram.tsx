import { Line } from "@visx/shape";
import KatexLabel from "./KatexLabel";

/**
 * インライン SVG として描く、ビルド時生成の静的な空間ベクトルの軸測図。
 *
 * 3 次元の右手系を 2 次元画面へ軸測投影（斜投影）して描く。$x, y, z$ の 3 軸と、空間
 * ベクトル（有向線分）・点・2 ベクトルが張る平行四辺形を 1 枚の静的な図で表す。空間
 * ベクトルの成分・和・外積の面積を視覚化する。本コンポーネントはクライアント JavaScript を
 * 一切載せない。Astro がビルド時に HTML へ描画する（クライアントディレクティブなし、
 * ハイドレーションなし）。軸・ベクトルは `@visx/shape` の `Line` で描き、矢じりは色を動的に
 * 変えられるよう polygon を手計算で置く。ラベルは KatexLabel を介して KaTeX で組版する。
 *
 * 投影の慣例:
 * - $z$ 軸は画面の上向き（画面ベクトル EZ）。
 * - $y$ 軸は画面の右向き（画面ベクトル EY）。
 * - $x$ 軸は画面の左下手前向き（画面ベクトル EX）。
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
  /** 支援技術が読み上げるアクセシブルな説明。 */
  ariaLabel: string;
};

// 軸・ベクトルは global.css の CSS 変数でテーマに追従する。
const AXIS = "var(--fig-axis)";
const VEC = "#3b82f6";
const HIGHLIGHT = "#f59e0b";

// 描画領域。他の図と高さ感をそろえ、正方に近い縦横比にする。
const VIEW_W = 320;
const VIEW_H = 280;

// 軸測投影の基底の向き（空間の単位ベクトルを写す画面ベクトルの向き。1 単位あたりの画面 px は
// 倍率 SCALE を掛けて決める）。SVG は下向きが正のため、上向きの z 軸は画面の負の y へ向ける。
const DIR_X = { sx: -0.6, sy: 0.4 }; // x 軸: 左下手前。
const DIR_Y = { sx: 1, sy: 0 }; // y 軸: 右。
const DIR_Z = { sx: 0, sy: -1 }; // z 軸: 上。

// 軸の周りに確保する余白（軸名ラベル・矢じりを収める）。
const MARGIN = 34;

// 矢じり。長さ（線方向）と半幅（直交方向）を px で与える。
const HEAD_LEN = 9;
const HEAD_HALF = 3.6;

export default function SpaceVectorDiagram({
  vectors = [],
  points = [],
  parallelogram,
  axisMax = 3,
  ariaLabel,
}: SpaceVectorDiagramProps) {
  // 3 軸の終点が画面に張り出す範囲（原点を基準とした倍率 1 のときの px）から、viewBox（余白を
  // 引いた領域）へ収まる最大倍率と中央寄せの原点を求める。axisMax に追従して図が viewBox を
  // 埋め、他図と倍率・余白がそろう。
  const corners = [
    DIR_X,
    DIR_Y,
    DIR_Z,
    { sx: 0, sy: 0 }, // 原点。
  ].map((d) => ({ sx: d.sx * axisMax, sy: d.sy * axisMax }));
  const minSx = Math.min(...corners.map((c) => c.sx));
  const maxSx = Math.max(...corners.map((c) => c.sx));
  const minSy = Math.min(...corners.map((c) => c.sy));
  const maxSy = Math.max(...corners.map((c) => c.sy));
  const spanX = maxSx - minSx || 1;
  const spanY = maxSy - minSy || 1;
  const scale = Math.min((VIEW_W - 2 * MARGIN) / spanX, (VIEW_H - 2 * MARGIN) / spanY);
  // 投影範囲（倍率適用後）を viewBox 中央へ寄せるよう原点をずらす。
  const originX = (VIEW_W - (minSx + maxSx) * scale) / 2;
  const originY = (VIEW_H - (minSy + maxSy) * scale) / 2;

  const EX = { sx: DIR_X.sx * scale, sy: DIR_X.sy * scale };
  const EY = { sx: DIR_Y.sx * scale, sy: DIR_Y.sy * scale };
  const EZ = { sx: DIR_Z.sx * scale, sy: DIR_Z.sy * scale };

  const project = (p: { x: number; y: number; z: number }): { sx: number; sy: number } => ({
    sx: originX + p.x * EX.sx + p.y * EY.sx + p.z * EZ.sx,
    sy: originY + p.x * EX.sy + p.y * EY.sy + p.z * EZ.sy,
  });

  // 各軸の正の向きの終点（軸名ラベルを少し外へ離して置く）。
  const axes: { dir: "x" | "y" | "z"; label: string; end: { x: number; y: number; z: number } }[] =
    [
      { dir: "x", label: "x", end: { x: axisMax, y: 0, z: 0 } },
      { dir: "y", label: "y", end: { x: 0, y: axisMax, z: 0 } },
      { dir: "z", label: "z", end: { x: 0, y: 0, z: axisMax } },
    ];
  const originP = project({ x: 0, y: 0, z: 0 });

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
      for (const q of placedBoxes) if (boxesOverlap(box, q)) p += 7;
      // ラベル中心が線分に近すぎる（線・矢じりを覆う）候補を避ける。
      for (const s of segs) if (distToSeg(lx, ly, s) < 10) p += 9;
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
      {/* 平行四辺形（半透明の塗り）。2 ベクトル a, b が起点 o から張る面を示す。 */}
      {parallelogram && (
        <g>
          {(() => {
            const { o, a, b } = parallelogram;
            const p0 = project(o);
            const p1 = project({ x: o.x + a.x, y: o.y + a.y, z: o.z + a.z });
            const p2 = project({
              x: o.x + a.x + b.x,
              y: o.y + a.y + b.y,
              z: o.z + a.z + b.z,
            });
            const p3 = project({ x: o.x + b.x, y: o.y + b.y, z: o.z + b.z });
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
        const base = { sx: toP.sx - HEAD_LEN * cos, sy: toP.sy - HEAD_LEN * sin };
        const left = { sx: base.sx - HEAD_HALF * sin, sy: base.sy + HEAD_HALF * cos };
        const right = { sx: base.sx + HEAD_HALF * sin, sy: base.sy - HEAD_HALF * cos };
        // ラベルは線分の中点から直交方向へ逃がす。両側を候補にし、衝突の少ない側を選ぶ。
        const mx = (fromP.sx + toP.sx) / 2;
        const my = (fromP.sy + toP.sy) / 2;
        const len = Math.hypot(toP.sx - fromP.sx, toP.sy - fromP.sy) || 1;
        const perpX = -(toP.sy - fromP.sy) / len;
        const perpY = (toP.sx - fromP.sx) / len;
        const lp =
          v.label !== undefined
            ? place(
                mx,
                my,
                [
                  { dx: perpX * 13, dy: perpY * 13 },
                  { dx: -perpX * 13, dy: -perpY * 13 },
                  { dx: perpX * 22, dy: perpY * 22 },
                  { dx: -perpX * 22, dy: -perpY * 22 },
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

/** 当たり判定に使う線分（画面座標の端点 a→b）。 */
type Seg = { ax: number; ay: number; bx: number; by: number };

/** 点 (px, py) から線分 s までの最短距離（画面座標）。 */
function distToSeg(px: number, py: number, s: Seg): number {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - s.ax, py - s.ay);
  let t = ((px - s.ax) * dx + (py - s.ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s.ax + t * dx), py - (s.ay + t * dy));
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
  // バックスラッシュだけを除き、コマンド名の文字（\vec → vec）は字数として数える。
  // 装飾記号（{ } ^ _ $ 空白）は幅 0 とする。実幅より広めに見積もり、重なり判定を安全側へ倒す。
  const visible = tex.replace(/\\/g, "").replace(/[{}^_$\s]/g, "");
  return Math.max(visible.length * fontSize * 0.72, 18);
}
