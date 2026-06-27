import { graphlib, layout as dagreLayout } from "@dagrejs/dagre";
import { curveLinear } from "@visx/curve";
import { Group } from "@visx/group";
import { Marker } from "@visx/marker";
import { Graph } from "@visx/network";
import { Bar, LinePath, Polygon } from "@visx/shape";
import { renderToString } from "katex";
import { useId } from "react";

/**
 * インライン SVG として描く、ビルド時生成の静的なフローチャート。
 *
 * Mermaid のフローチャートを置き換える。ノードとエッジを宣言的なデータで受け取り、
 * dagre（`@dagrejs/dagre`）でビルド時にノード配置・エッジ経路・クラスタ境界を計算し、
 * visx の `@visx/network`（`Graph`）でノードとエッジを描く。クラスタ（サブグラフ）は
 * `@visx/shape` の `Bar` で背面に描く。ノード形状は矩形を `Bar`、菱形を `Polygon` で描く。
 * クライアント JavaScript は一切載せない。Astro がビルド時に HTML へ描画する。
 *
 * ラベルは KaTeX で組版する。ラベル文字列は改行を `\n` で、数式を `$...$` で表す。
 * 例: `"判別式 $D = b^2 - 4ac$\nを計算する"`。数式部分は `katex.renderToString` で
 * 組版し、地の文はそのまま描く。本文のインライン数式 `$...$` と字形をそろえる。
 *
 * dagre の制約上、クラスタごとに方向を変えることはできない。全体の `direction` と
 * エッジの構造でレイアウトを決める。
 */

/** レイアウトの方向。`TB`（上から下）と `LR`（左から右）。`TD` は `TB` と同義。 */
export type FlowDirection = "TB" | "TD" | "LR";

/** ノードの形状。`rect`（矩形・既定）と `diamond`（菱形・判断）。 */
export type FlowShape = "rect" | "diamond";

/**
 * ノードの配色トーン。既定（未指定）は中立色。`done`（完了・達成済み）と
 * `goal`（到達目標）を強調色で描き分ける。意味は利用側が与える（ロードマップ全体図では
 * `done`＝執筆済み）。色は global.css の CSS 変数で与える。
 */
export type FlowTone = "done" | "goal";

/** フローチャートの 1 ノード。 */
export type FlowNode = {
  /** ノードの識別子。エッジ・クラスタから参照する。 */
  id: string;
  /** ラベル。改行は `\n`、数式は `$...$` で表す。 */
  label: string;
  /** 形状。既定は `rect`。判断（分岐）には `diamond` を使う。 */
  shape?: FlowShape;
  /** 配色トーン。既定は中立色。`done`・`goal` を強調色で描く。 */
  tone?: FlowTone;
};

/** 2 ノードを結ぶ有向エッジ。 */
export type FlowEdge = {
  /** 始点ノードの id。 */
  from: string;
  /** 終点ノードの id。 */
  to: string;
  /** エッジに添えるラベル。改行は `\n`、数式は `$...$` で表す。 */
  label?: string;
  /** 破線で描くか。既定は実線。 */
  dashed?: boolean;
};

/** ノードをまとめるクラスタ（Mermaid の subgraph に相当）。入れ子にできる。 */
export type FlowCluster = {
  /** クラスタの識別子。親クラスタの `children` から参照する。 */
  id: string;
  /** クラスタの見出し。改行は `\n`、数式は `$...$` で表す。 */
  label?: string;
  /** 直接の子。ノード id・クラスタ id を混在できる。 */
  children: string[];
};

type FlowChartProps = {
  /** レイアウトの方向。既定 `TB`。 */
  direction?: FlowDirection;
  /** ノードの一覧。 */
  nodes: FlowNode[];
  /** エッジの一覧。 */
  edges?: FlowEdge[];
  /** クラスタ（サブグラフ）の一覧。 */
  clusters?: FlowCluster[];
  /** 支援技術が読み上げるアクセシブルな説明。 */
  ariaLabel: string;
  /** 表示の最大幅（px）。既定は 720。大きなグラフ（ロードマップ全体図）で広げる。 */
  maxWidth?: number;
};

// 色はテーマに追従する CSS 変数（global.css の :root と [data-theme="dark"]）で与える。
const NODE_FILL = "var(--flow-node-fill)";
const NODE_STROKE = "var(--flow-node-stroke)";
const CLUSTER_FILL = "var(--flow-cluster-fill)";
const CLUSTER_STROKE = "var(--flow-cluster-stroke)";
const EDGE = "var(--flow-edge)";
const PAGE_BG = "var(--sl-color-bg, #fff)";

// ラベルの寸法（viewBox 単位）。
const NODE_FONT = 13;
const EDGE_FONT = 12;
const CLUSTER_FONT = 12;
const LINE_H = NODE_FONT * 1.5;
const EDGE_LINE_H = EDGE_FONT * 1.4;
const PAD_X = 14;
const PAD_Y = 12;

// dagre のレイアウト間隔。
const NODE_SEP = 30;
const RANK_SEP = 46;
const MARGIN = 12;

export default function FlowChart({
  direction = "TB",
  nodes,
  edges = [],
  clusters = [],
  ariaLabel,
  maxWidth = 720,
}: FlowChartProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const arrow = `flowArrow-${uid}`;

  const rankdir = direction === "LR" ? "LR" : "TB";

  // dagre の graphlib をラベル型で型付けし、型アサーションなしで配置結果を読む。
  const g = new graphlib.Graph<DagreGraphCfg, DagreNode, DagreEdge>({
    compound: true,
    multigraph: true,
  });
  g.setGraph({ rankdir, nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));

  // ノードを登録する。形状ごとに、ラベルの行・数式から外形の幅・高さを見積もる。
  const metas = nodes.map(measureNode);
  for (const meta of metas) {
    g.setNode(meta.id, { width: meta.width, height: meta.height });
  }

  // クラスタ（複合ノード）を、親子付けの前に全件登録する。子に後で定義されるクラスタ id が
  // 来ても、親子付けの時点で全クラスタのノードが存在するようにする（順序非依存）。
  for (const c of clusters) {
    g.setNode(c.id, { label: c.label ?? "" });
  }

  // 既知の id（ノード＋クラスタ）。子・エッジ端点の参照ミスを、ビルド時に分かる形で弾く。
  const known = new Set<string>([...metas.map((m) => m.id), ...clusters.map((c) => c.id)]);
  for (const c of clusters) {
    for (const childId of c.children) {
      if (!known.has(childId)) {
        throw new Error(
          `FlowChart: クラスタ "${c.id}" の子 "${childId}" がノードにもクラスタにも存在しません。`,
        );
      }
      g.setParent(childId, c.id);
    }
  }

  // エッジを登録する。端点が未定義だと dagre が幽霊ノードを作るため、先に参照を検証する。
  // ラベルがあれば寸法を渡し、dagre にラベルの場所を空けさせる。
  edges.forEach((e, i) => {
    if (!known.has(e.from) || !known.has(e.to)) {
      throw new Error(
        `FlowChart: エッジ "${e.from}" → "${e.to}" が未定義のノードを参照しています。`,
      );
    }
    const lab = e.label ? measureLabel(e.label, EDGE_FONT, EDGE_LINE_H) : undefined;
    g.setEdge(
      e.from,
      e.to,
      { width: lab?.width ?? 0, height: lab?.height ?? 0, labelpos: "c" },
      `e${i}`,
    );
  });

  dagreLayout(g);

  const cfg = g.graph();
  const totalW = cfg.width ?? 0;
  const totalH = cfg.height ?? 0;

  // クラスタの矩形。入れ子の外側が内側を覆い隠さないよう、面積の大きい順に背面へ重ねる。
  const clusterBoxes = clusters
    .map((c) => {
      const node = g.node(c.id);
      const w = node.width ?? 0;
      const h = node.height ?? 0;
      return {
        id: c.id,
        label: c.label ?? "",
        x: (node.x ?? 0) - w / 2,
        y: (node.y ?? 0) - h / 2,
        width: w,
        height: h,
      };
    })
    .toSorted((a, b) => b.width * b.height - a.width * a.height);

  // visx Graph に渡すノード。Graph が (x, y) へ平行移動するため、描画は原点中心で行う。
  const graphNodes: PlacedNode[] = metas.map((meta) => {
    const layout = g.node(meta.id);
    return { ...meta, x: layout.x ?? 0, y: layout.y ?? 0 };
  });

  // visx Graph に渡すリンク。リンクは平行移動されないため、絶対座標の経路で描く。
  const graphLinks: PlacedLink[] = edges.map((e, i) => {
    const ed = g.edge({ v: e.from, w: e.to, name: `e${i}` });
    // dagre が経路を埋めなかった場合（入力不整合・レイアウト失敗）は、壊れた SVG を返さず
    // 原因が分かるエラーにする。
    if (!ed || !ed.points || ed.points.length === 0) {
      throw new Error(
        `FlowChart: エッジ "${e.from}" → "${e.to}" のレイアウト結果が空です。ノード id を確認してください。`,
      );
    }
    const points = ed.points.map((p) => ({ x: p.x, y: p.y }));
    const lab =
      e.label && typeof ed.x === "number" && typeof ed.y === "number"
        ? { text: e.label, x: ed.x, y: ed.y }
        : undefined;
    return {
      source: points[0],
      target: points[points.length - 1],
      points,
      dashed: e.dashed ?? false,
      label: lab,
      arrowId: arrow,
    };
  });

  return (
    <svg
      className="flow-chart"
      viewBox={`0 0 ${totalW} ${totalH}`}
      role="img"
      aria-label={ariaLabel}
      style={{ maxWidth: `${Math.min(totalW, maxWidth)}px` }}
    >
      <defs>
        <Marker
          id={arrow}
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={7}
          markerHeight={7}
          markerUnits="strokeWidth"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE} />
        </Marker>
      </defs>

      {/* クラスタ（サブグラフ）の枠と見出し。ノード・エッジより背面に描く。 */}
      {clusterBoxes.map((c) => (
        <Group key={`clu-${c.id}`}>
          <Bar
            x={c.x}
            y={c.y}
            width={c.width}
            height={c.height}
            rx={8}
            fill={CLUSTER_FILL}
            stroke={CLUSTER_STROKE}
            strokeWidth={1.2}
          />
          {c.label && <ClusterLabel label={c.label} cx={c.x + c.width / 2} top={c.y} />}
        </Group>
      ))}

      <Graph<PlacedLink, PlacedNode>
        graph={{ nodes: graphNodes, links: graphLinks }}
        nodeComponent={NodeShape}
        linkComponent={EdgeShape}
      />
    </svg>
  );
}

/**
 * dagre の graphlib に渡すラベル型。レイアウト前は寸法のみ、レイアウト後に dagre が
 * 中心座標 (x, y) を書き込む。クラスタ（複合ノード）は寸法なしで登録するため、すべて任意。
 */
type DagreNode = { width?: number; height?: number; x?: number; y?: number; label?: string };

/** dagre の graphlib に渡すエッジラベル型。レイアウト後に経路 points とラベル位置が入る。 */
type DagreEdge = {
  width?: number;
  height?: number;
  labelpos?: "l" | "c" | "r";
  points?: Pt[];
  x?: number;
  y?: number;
};

/** dagre の graphlib に渡すグラフ設定型。レイアウト後に全体の width・height が入る。 */
type DagreGraphCfg = {
  rankdir?: "TB" | "LR";
  nodesep?: number;
  ranksep?: number;
  marginx?: number;
  marginy?: number;
  width?: number;
  height?: number;
};

/** レイアウト前に決まるノードの外形と描画情報。 */
type NodeMeta = {
  id: string;
  label: string;
  shape: FlowShape;
  /** 配色トーン。未指定は中立色。 */
  tone?: FlowTone;
  /** 外形（dagre に渡す当たり判定）の幅・高さ。 */
  width: number;
  height: number;
  /** ラベルを収める内枠の幅・高さ。 */
  labelW: number;
  labelH: number;
};

/** レイアウト後の中心座標を加えたノード。 */
type PlacedNode = NodeMeta & { x: number; y: number };

type Pt = { x: number; y: number };

/** レイアウト後のエッジ。visx Graph の Link 形（source・target）に経路と装飾を足す。 */
type PlacedLink = {
  source: Pt;
  target: Pt;
  points: Pt[];
  dashed: boolean;
  label?: { text: string; x: number; y: number };
  /** 矢印マーカーの id。FlowChart インスタンスごとに異なる。 */
  arrowId: string;
};

/** ノードのトーンごとの塗り・輪郭の CSS 変数。未指定（中立）は既定色。 */
function toneColors(tone?: FlowTone): { fill: string; stroke: string } {
  if (tone === "done") {
    return { fill: "var(--flow-node-done-fill)", stroke: "var(--flow-node-done-stroke)" };
  }
  if (tone === "goal") {
    return { fill: "var(--flow-node-goal-fill)", stroke: "var(--flow-node-goal-stroke)" };
  }
  return { fill: NODE_FILL, stroke: NODE_STROKE };
}

/** ノード 1 個を原点中心に描く。矩形は Bar、菱形は Polygon。中央にラベルを置く。 */
function NodeShape({ node }: { node: PlacedNode }) {
  const { shape, width, height, labelW, labelH, label, tone } = node;
  const { fill, stroke } = toneColors(tone);
  return (
    <Group>
      {shape === "diamond" ? (
        <Polygon
          points={[
            [0, -height / 2],
            [width / 2, 0],
            [0, height / 2],
            [-width / 2, 0],
          ]}
          fill={fill}
          stroke={stroke}
          strokeWidth={1.4}
        />
      ) : (
        <Bar
          x={-width / 2}
          y={-height / 2}
          width={width}
          height={height}
          rx={6}
          fill={fill}
          stroke={stroke}
          strokeWidth={1.4}
        />
      )}
      <LabelBox label={label} cx={0} cy={0} width={labelW} height={labelH} fontSize={NODE_FONT} />
    </Group>
  );
}

/** エッジ 1 本を絶対座標で描く。経路・矢印・（あれば）ラベルを置く。 */
function EdgeShape({ link }: { link: PlacedLink }) {
  const { points, dashed, label, arrowId } = link;
  return (
    <Group>
      <LinePath<Pt>
        data={points}
        x={(p) => p.x}
        y={(p) => p.y}
        curve={curveLinear}
        fill="none"
        stroke={EDGE}
        strokeWidth={1.6}
        strokeDasharray={dashed ? "5 4" : undefined}
        markerEnd={`url(#${arrowId})`}
      />
      {label && <EdgeLabel text={label.text} cx={label.x} cy={label.y} />}
    </Group>
  );
}

/** エッジラベル。線の上に重なっても読めるよう、背景チップを敷いてから組版を載せる。 */
function EdgeLabel({ text, cx, cy }: { text: string; cx: number; cy: number }) {
  const { width, height } = measureLabel(text, EDGE_FONT, EDGE_LINE_H);
  return (
    <Group>
      <Bar
        x={cx - width / 2}
        y={cy - height / 2}
        width={width}
        height={height}
        rx={3}
        fill={PAGE_BG}
        opacity={0.92}
      />
      <LabelBox label={text} cx={cx} cy={cy} width={width} height={height} fontSize={EDGE_FONT} />
    </Group>
  );
}

/** クラスタの見出し。上辺の中央に、背景チップで枠線を断ち切って載せる。 */
function ClusterLabel({ label, cx, top }: { label: string; cx: number; top: number }) {
  const { width, height } = measureLabel(label, CLUSTER_FONT, CLUSTER_FONT * 1.4);
  return (
    <Group>
      <Bar
        x={cx - width / 2}
        y={top - height / 2}
        width={width}
        height={height}
        fill={CLUSTER_FILL}
      />
      <LabelBox
        label={label}
        cx={cx}
        cy={top}
        width={width}
        height={height}
        fontSize={CLUSTER_FONT}
      />
    </Group>
  );
}

/**
 * ラベルを foreignObject に HTML として描く。改行 `\n` を行に、`$...$` を数式に分け、
 * 数式は KaTeX で組版する。地の文は HTML エスケープして埋め込む。中心 (cx, cy) に配置する。
 */
function LabelBox({
  label,
  cx,
  cy,
  width,
  height,
  fontSize,
}: {
  label: string;
  cx: number;
  cy: number;
  width: number;
  height: number;
  fontSize: number;
}) {
  const html = labelToHtml(label);
  return (
    <foreignObject
      x={cx - width / 2}
      y={cy - height / 2}
      width={width}
      height={height}
      style={{ overflow: "visible" }}
    >
      <div
        xmlns="http://www.w3.org/1999/xhtml"
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          whiteSpace: "nowrap",
          fontSize: `${fontSize}px`,
          lineHeight: 1.3,
          textAlign: "center",
          color: "currentColor",
        }}
        // ラベルはソース内のリテラルのみを組版する。外部入力は受け取らない。
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </foreignObject>
  );
}

/** ラベル文字列を、行（`\n`）と数式（`$...$`）に分けて HTML へ変換する。 */
function labelToHtml(label: string): string {
  return label
    .split("\n")
    .map((line) => {
      const inner = line
        .split(/(\$[^$]*\$)/g)
        .filter((s) => s.length > 0)
        .map((seg) => {
          if (seg.startsWith("$") && seg.endsWith("$") && seg.length >= 2) {
            return renderToString(seg.slice(1, -1), {
              throwOnError: false,
              displayMode: false,
              trust: false,
            });
          }
          return escapeHtml(seg);
        })
        .join("");
      return `<div>${inner.length > 0 ? inner : "&#8203;"}</div>`;
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** ノードの外形と内枠を、ラベルの行・数式から見積もる。 */
function measureNode(n: FlowNode): NodeMeta {
  const shape = n.shape ?? "rect";
  const { width: contentW, height: contentH } = measureLabel(n.label, NODE_FONT, LINE_H);
  const labelW = contentW;
  const labelH = contentH;
  if (shape === "diamond") {
    // 菱形に矩形のラベルを収めるには対角線を広げる必要がある。安全側に大きく取る。
    return {
      id: n.id,
      label: n.label,
      shape,
      tone: n.tone,
      width: contentW * 1.5 + PAD_X * 2,
      height: contentH * 1.7 + PAD_Y * 2,
      labelW,
      labelH,
    };
  }
  return {
    id: n.id,
    label: n.label,
    shape,
    tone: n.tone,
    width: contentW + PAD_X * 2,
    height: contentH + PAD_Y * 2,
    labelW: contentW + PAD_X * 2,
    labelH: contentH + PAD_Y * 2,
  };
}

/** ラベル（複数行・数式混在）の表示幅・高さを見積もる。DOM の無いビルド時の概算。 */
function measureLabel(
  label: string,
  fontSize: number,
  lineH: number,
): { width: number; height: number } {
  const lines = label.split("\n");
  let maxW = 0;
  for (const line of lines) {
    let w = 0;
    for (const seg of line.split(/(\$[^$]*\$)/g)) {
      if (seg.length === 0) continue;
      if (seg.startsWith("$") && seg.endsWith("$") && seg.length >= 2) {
        w += texWidth(seg.slice(1, -1), fontSize);
      } else {
        w += plainWidth(seg, fontSize);
      }
    }
    // 数式を含む行は、foreignObject 内の KaTeX 描画幅がブラウザ・フォントの違いで
    // 変動する。見積もりの過小評価で枠外へはみ出すのを防ぐため、安全余白を 1 文字分足す。
    if (line.includes("$")) {
      w += fontSize * 0.6;
    }
    maxW = Math.max(maxW, w);
  }
  return { width: Math.max(maxW, fontSize * 2), height: lines.length * lineH };
}

/** 地の文（全角・半角混在）のおおよその表示幅。全角は 1em、半角は約 0.55em。 */
function plainWidth(s: string, fontSize: number): number {
  let w = 0;
  for (const ch of s) {
    // Latin-1 の範囲（コードポイント 0xFF 以下）を半角とみなす。
    const halfWidth = (ch.codePointAt(0) ?? 0) <= 0xff;
    w += halfWidth ? fontSize * 0.55 : fontSize;
  }
  return w;
}

/**
 * LaTeX のおおよその表示幅。コマンド（\word）を 1 グリフと数え、装飾記号を除いて概算する。
 *
 * 係数は安全側（広め）に取る。foreignObject 内の KaTeX 実描画幅はブラウザ・フォント読込で
 * 変動し、過小評価するとノード枠から数式がはみ出すためである。根号 `\sqrt` の surd 記号は
 * 通常のグリフより横に広いため、根号 1 つにつき余分な幅を加える。
 */
function texWidth(tex: string, fontSize: number): number {
  const commands = (tex.match(/\\[a-zA-Z]+/g) ?? []).length;
  const rest = tex.replace(/\\[a-zA-Z]+/g, "").replace(/[{}^_$\s]/g, "");
  const sqrtCount = (tex.match(/\\sqrt/g) ?? []).length;
  return (rest.length + commands) * fontSize * 0.66 + sqrtCount * fontSize * 0.5;
}
