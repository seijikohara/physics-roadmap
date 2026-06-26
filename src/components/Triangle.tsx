import { scaleLinear } from "d3-scale";
import KatexLabel from "./KatexLabel";

/**
 * インライン SVG として描く、ビルド時生成の静的な三角形。
 *
 * 3 頂点の座標から三角形を描き、頂点名・辺の長さ・内角・直角の印を添える。直角三角形に
 * よる三角比の定義や、正弦定理・余弦定理の図に使う。本コンポーネントはクライアント
 * JavaScript を一切載せない。Astro がビルド時に HTML へ描画する（クライアントディレク
 * ティブなし、ハイドレーションなし）。横縦で同じ倍率にし、形を歪めない。ラベルは
 * KatexLabel を介して KaTeX で組版する。
 */

type Vertex = {
  /** 頂点の数学座標。 */
  x: number;
  y: number;
  /** 頂点に添える LaTeX ラベル（例: "A"）。 */
  label?: string;
};

/** 辺に添えるラベル。`from`・`to` は vertices の添字（0,1,2）。 */
type EdgeLabel = {
  from: number;
  to: number;
  /** 辺の中点付近に置く LaTeX ラベル（例: "c"、"a"）。 */
  label: string;
};

/** 頂点での内角の印とラベル。`at` は vertices の添字。 */
type AngleMark = {
  at: number;
  /** 角に添える LaTeX ラベル（例: "A"、"\\theta"、"90^\\circ"）。 */
  label?: string;
  /** 直角の印（小さな四角）で描くか。既定 false（弧で描く）。 */
  right?: boolean;
};

/** 数学座標の点。 */
type Pt = { x: number; y: number };

/** 追加の補助線分（破線）。垂線の足までの底辺の延長などに使う。 */
type Segment = { from: Pt; to: Pt };

/**
 * 頂点から底辺へ下ろした垂線。高さの線分（破線）・足の点・直角の印をまとめて描く。
 * `toward` は底辺に沿う向きを示す点（直角の印の向きづけに使う）。
 */
type Perpendicular = {
  from: Pt;
  foot: Pt;
  toward: Pt;
  /** 高さの線分に添えるラベル（例: "h"）。 */
  label?: string;
  /** 足に添えるラベル（例: "H"）。 */
  footLabel?: string;
};

type TriangleProps = {
  /** 3 頂点。反時計回り・時計回りのどちらでもよい。 */
  vertices: [Vertex, Vertex, Vertex];
  /** 辺のラベル。 */
  edges?: EdgeLabel[];
  /** 内角の印。 */
  angles?: AngleMark[];
  /** 補助線分（破線）。底辺の延長などに使う。 */
  segments?: Segment[];
  /** 頂点から底辺へ下ろした垂線（高さ・足・直角の印）。 */
  perpendiculars?: Perpendicular[];
  /**
   * 1 数学単位あたりのピクセル数を固定する。複数の図で縮尺をそろえる（合同な三角形を
   * 同じ大きさで描く）ときに使う。省略時は viewBox に合わせて自動でフィットする。
   */
  unitScale?: number;
  /** 支援技術が読み上げるアクセシブルな説明。 */
  ariaLabel: string;
};

const STROKE = "#3b82f6";
const FILL = "#3b82f6";
// 角・辺・補助線の印は global.css の CSS 変数でテーマに追従する。
const MARK = "var(--fig-axis)";

const VIEW_W = 320;
const VIEW_H = 240;
const PAD = 36;

export default function Triangle({
  vertices,
  edges = [],
  angles = [],
  segments = [],
  perpendiculars = [],
  unitScale,
  ariaLabel,
}: TriangleProps) {
  // 頂点の座標範囲から、横縦同じ倍率のスケールを作り中央へ収める。
  const xs = vertices.map((v) => v.x);
  const ys = vertices.map((v) => v.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const availW = VIEW_W - 2 * PAD;
  const availH = VIEW_H - 2 * PAD;
  // unitScale が指定されればその縮尺を使い、複数の図で大きさをそろえる。
  const unit = unitScale ?? Math.min(availW / spanX, availH / spanY);
  const boxW = unit * spanX;
  const boxH = unit * spanY;
  const offX = PAD + (availW - boxW) / 2;
  const offY = PAD + (availH - boxH) / 2;

  const sx = scaleLinear()
    .domain([minX, maxX])
    .range([offX, offX + boxW]);
  const sy = scaleLinear()
    .domain([minY, maxY])
    .range([offY + boxH, offY]); // 上向きを正にする。

  const P = vertices.map((v) => ({ x: sx(v.x), y: sy(v.y) }));
  const centroid = {
    x: (P[0].x + P[1].x + P[2].x) / 3,
    y: (P[0].y + P[1].y + P[2].y) / 3,
  };

  return (
    <svg
      className="triangle-figure"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label={ariaLabel}
    >
      {/* 三角形の面。 */}
      <polygon
        points={P.map((p) => `${p.x},${p.y}`).join(" ")}
        fill={FILL}
        fillOpacity={0.08}
        stroke={STROKE}
        strokeWidth={2}
        strokeLinejoin="round"
      />

      {/* 角の印。 */}
      {angles.map((a, i) => {
        const v = P[a.at];
        const others = [0, 1, 2].filter((k) => k !== a.at).map((k) => P[k]);
        const u1 = unitVec(v, others[0]);
        const u2 = unitVec(v, others[1]);
        if (a.right) {
          const d = 12;
          const c1 = { x: v.x + u1.x * d, y: v.y + u1.y * d };
          const c2 = { x: v.x + u2.x * d, y: v.y + u2.y * d };
          const c3 = { x: c1.x + u2.x * d, y: c1.y + u2.y * d };
          return (
            <polyline
              key={`ang-${i}`}
              points={`${c1.x},${c1.y} ${c3.x},${c3.y} ${c2.x},${c2.y}`}
              fill="none"
              stroke={MARK}
              strokeWidth={1.3}
            />
          );
        }
        // 弧と角ラベル。
        const rr = 20;
        const a1 = Math.atan2(u1.y, u1.x);
        const a2 = Math.atan2(u2.y, u2.x);
        const start = { x: v.x + rr * Math.cos(a1), y: v.y + rr * Math.sin(a1) };
        const end = { x: v.x + rr * Math.cos(a2), y: v.y + rr * Math.sin(a2) };
        let diff = a2 - a1;
        while (diff <= -Math.PI) diff += 2 * Math.PI;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        const sweepFlag = diff > 0 ? 1 : 0;
        const bis = { x: (u1.x + u2.x) / 2, y: (u1.y + u2.y) / 2 };
        const bisLen = Math.hypot(bis.x, bis.y) || 1;
        return (
          <g key={`ang-${i}`}>
            <path
              d={`M ${start.x} ${start.y} A ${rr} ${rr} 0 0 ${sweepFlag} ${end.x} ${end.y}`}
              fill="none"
              stroke={MARK}
              strokeWidth={1.3}
            />
            {a.label !== undefined && (
              <KatexLabel
                tex={a.label}
                x={v.x + (bis.x / bisLen) * 34}
                y={v.y + (bis.y / bisLen) * 34}
                fontSize={12}
              />
            )}
          </g>
        );
      })}

      {/* 補助線分（破線）。底辺の延長などを表す。 */}
      {segments.map((s, i) => (
        <line
          key={`seg-${i}`}
          x1={sx(s.from.x)}
          y1={sy(s.from.y)}
          x2={sx(s.to.x)}
          y2={sy(s.to.y)}
          stroke={MARK}
          strokeWidth={1.3}
          strokeDasharray="4 3"
        />
      ))}

      {/* 垂線（高さ）・足の点・直角の印。 */}
      {perpendiculars.map((pp, i) => {
        const f = { x: sx(pp.from.x), y: sy(pp.from.y) };
        const h = { x: sx(pp.foot.x), y: sy(pp.foot.y) };
        const u1 = unitVec(h, f);
        const u2 = unitVec(h, { x: sx(pp.toward.x), y: sy(pp.toward.y) });
        const d = 11;
        const c1 = { x: h.x + u1.x * d, y: h.y + u1.y * d };
        const c2 = { x: h.x + u2.x * d, y: h.y + u2.y * d };
        const c3 = { x: c1.x + u2.x * d, y: c1.y + u2.y * d };
        const mid = { x: (f.x + h.x) / 2, y: (f.y + h.y) / 2 };
        const hOut = { x: mid.x - centroid.x, y: mid.y - centroid.y };
        const hLen = Math.hypot(hOut.x, hOut.y) || 1;
        const footOut = { x: h.x - centroid.x, y: h.y - centroid.y };
        const footLen = Math.hypot(footOut.x, footOut.y) || 1;
        return (
          <g key={`perp-${i}`}>
            <line
              x1={f.x}
              y1={f.y}
              x2={h.x}
              y2={h.y}
              stroke={MARK}
              strokeWidth={1.3}
              strokeDasharray="4 3"
            />
            <polyline
              points={`${c1.x},${c1.y} ${c3.x},${c3.y} ${c2.x},${c2.y}`}
              fill="none"
              stroke={MARK}
              strokeWidth={1.3}
            />
            <circle cx={h.x} cy={h.y} r={3} fill={STROKE} />
            {pp.label !== undefined && (
              <KatexLabel
                tex={pp.label}
                x={mid.x + (hOut.x / hLen) * 16}
                y={mid.y + (hOut.y / hLen) * 16}
                fontSize={13}
              />
            )}
            {pp.footLabel !== undefined && (
              <KatexLabel
                tex={pp.footLabel}
                x={h.x + (footOut.x / footLen) * 16}
                y={h.y + (footOut.y / footLen) * 16}
                fontSize={13}
              />
            )}
          </g>
        );
      })}

      {/* 辺のラベル。中点から外側（重心の反対側）へ少しずらす。 */}
      {edges.map((e, i) => {
        const p1 = P[e.from];
        const p2 = P[e.to];
        const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        const out = { x: mid.x - centroid.x, y: mid.y - centroid.y };
        const len = Math.hypot(out.x, out.y) || 1;
        return (
          <KatexLabel
            key={`edge-${i}`}
            tex={e.label}
            x={mid.x + (out.x / len) * 16}
            y={mid.y + (out.y / len) * 16}
            fontSize={13}
          />
        );
      })}

      {/* 頂点の点と名前。名前は外側へずらす。 */}
      {P.map((p, i) => {
        const out = { x: p.x - centroid.x, y: p.y - centroid.y };
        const len = Math.hypot(out.x, out.y) || 1;
        return (
          <g key={`v-${i}`}>
            <circle cx={p.x} cy={p.y} r={3.2} fill={STROKE} />
            {vertices[i].label !== undefined && (
              <KatexLabel
                tex={vertices[i].label ?? ""}
                x={p.x + (out.x / len) * 18}
                y={p.y + (out.y / len) * 18}
                fontSize={13}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** v から w へ向かう単位ベクトル（SVG 座標）。 */
function unitVec(v: { x: number; y: number }, w: { x: number; y: number }) {
  const dx = w.x - v.x;
  const dy = w.y - v.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}
