import FlowChart, { type FlowEdge, type FlowNode } from "./FlowChart";

/**
 * トップページのロードマップ全体図。36 カテゴリの依存関係を 1 枚の有向グラフで示す。
 *
 * データの正は docs/roadmap-design.md の「カテゴリ一覧」「カテゴリの依存と推奨順序」
 * 「クリティカルパス」とする。ノードはカテゴリ単位（章ではない）で、上に前提・下に依存先を
 * 置く（direction="TB"）。前提トラックを起点に、数学・物理を経て 2 つのゴール（標準模型・
 * 一般相対性理論）へ至る道筋を一望できる。
 *
 * エッジは各カテゴリの主要な前提に絞る。章ごとの厳密な前提は設計書と各章冒頭に委ねる。
 * 配色トーンは執筆の進捗を表す。done＝執筆済み、goal＝到達目標、未指定＝執筆予定。
 */

/** カテゴリ。id は設計書の接頭辞、label は短縮名。tone は進捗（既定＝執筆予定）。 */
type Category = { id: string; label: string; tone?: "done" | "goal" };

// 執筆済みカテゴリ（2026 年 6 月時点）。docs/roadmap-design.md の実装状況に対応する。
const DONE = new Set(["PRE", "M-SET", "M-ALG", "M-FUN", "M-VEC", "M-AGEO"]);
// 到達目標の 2 カテゴリ。
const GOALS = new Set(["P-SMD", "P-GR"]);

// カテゴリ一覧（設計書の順）。短縮名で描く。
const CATEGORIES: { id: string; label: string }[] = [
  { id: "PRE", label: "前提知識" },
  { id: "M-SET", label: "数学の言葉" },
  { id: "M-ALG", label: "代数" },
  { id: "M-FUN", label: "初等関数" },
  { id: "M-VEC", label: "ベクトル" },
  { id: "M-AGEO", label: "座標幾何" },
  { id: "M-CPX", label: "複素数" },
  { id: "M-SEQ", label: "数列と級数" },
  { id: "M-CALC", label: "微分積分" },
  { id: "M-MVC", label: "多変数微積分" },
  { id: "M-VCAL", label: "ベクトル解析" },
  { id: "M-LIN", label: "線形代数" },
  { id: "M-ODE", label: "常微分方程式" },
  { id: "M-CXA", label: "複素解析" },
  { id: "M-FOU", label: "フーリエ解析" },
  { id: "M-PDE", label: "偏微分方程式" },
  { id: "M-SPF", label: "特殊関数" },
  { id: "M-VAR", label: "変分法" },
  { id: "M-PRB", label: "確率統計" },
  { id: "M-GRP", label: "抽象代数" },
  { id: "M-REP", label: "表現論" },
  { id: "M-LIE", label: "リー群・リー代数" },
  { id: "M-DG", label: "微分幾何" },
  { id: "M-RG", label: "リーマン幾何" },
  { id: "P-CM", label: "古典力学" },
  { id: "P-AM", label: "解析力学" },
  { id: "P-EM", label: "電磁気学" },
  { id: "P-SR", label: "特殊相対論" },
  { id: "P-THM", label: "熱力学" },
  { id: "P-STA", label: "統計力学" },
  { id: "P-QM", label: "量子力学" },
  { id: "P-RQM", label: "相対論的量子力学" },
  { id: "P-QFT", label: "場の量子論" },
  { id: "P-GAU", label: "ゲージ理論" },
  { id: "P-SMD", label: "標準模型" },
  { id: "P-GR", label: "一般相対性理論" },
];

// カテゴリ間の主要な前提関係（前提 → 依存先）。設計書の各章前提とクリティカルパスに基づく。
const DEPENDENCIES: [from: string, to: string][] = [
  ["PRE", "M-SET"],
  ["PRE", "M-ALG"],
  ["M-SET", "M-GRP"],
  ["M-SET", "M-PRB"],
  ["M-ALG", "M-FUN"],
  ["M-ALG", "M-SEQ"],
  ["M-FUN", "M-VEC"],
  ["M-FUN", "M-CPX"],
  ["M-FUN", "M-CALC"],
  ["M-VEC", "M-AGEO"],
  ["M-VEC", "M-LIN"],
  ["M-SEQ", "M-CALC"],
  ["M-CALC", "M-MVC"],
  ["M-CALC", "M-ODE"],
  ["M-CPX", "M-CXA"],
  ["M-MVC", "M-VCAL"],
  ["M-MVC", "M-DG"],
  ["M-LIN", "M-ODE"],
  ["M-LIN", "M-REP"],
  ["M-ODE", "M-PDE"],
  ["M-ODE", "M-VAR"],
  ["M-CXA", "M-FOU"],
  ["M-FOU", "M-PDE"],
  ["M-PDE", "M-SPF"],
  ["M-GRP", "M-REP"],
  ["M-REP", "M-LIE"],
  ["M-LIE", "M-DG"],
  ["M-DG", "M-RG"],
  ["M-VAR", "M-RG"],
  ["M-AGEO", "P-CM"],
  ["M-MVC", "P-CM"],
  ["M-ODE", "P-CM"],
  ["P-CM", "P-AM"],
  ["M-VAR", "P-AM"],
  ["P-CM", "P-EM"],
  ["M-VCAL", "P-EM"],
  ["P-EM", "P-SR"],
  ["M-DG", "P-SR"],
  ["P-CM", "P-THM"],
  ["P-THM", "P-STA"],
  ["M-PRB", "P-STA"],
  ["P-STA", "P-QM"],
  ["M-PDE", "P-QM"],
  ["M-SPF", "P-QM"],
  ["P-QM", "P-RQM"],
  ["P-SR", "P-RQM"],
  ["P-RQM", "P-QFT"],
  ["P-AM", "P-QFT"],
  ["P-QFT", "P-GAU"],
  ["M-LIE", "P-GAU"],
  ["P-GAU", "P-SMD"],
  ["P-SR", "P-GR"],
  ["M-RG", "P-GR"],
];

function toneOf(id: string): Category["tone"] {
  if (GOALS.has(id)) return "goal";
  if (DONE.has(id)) return "done";
  return undefined;
}

const NODES: FlowNode[] = CATEGORIES.map((c) => ({
  id: c.id,
  label: c.label,
  tone: toneOf(c.id),
}));

const EDGES: FlowEdge[] = DEPENDENCIES.map(([from, to]) => ({ from, to }));

const DONE_COUNT = CATEGORIES.filter((c) => DONE.has(c.id)).length;

/** 凡例の 1 項目。 */
function LegendItem({ fill, stroke, label }: { fill: string; stroke: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: "14px",
          height: "14px",
          borderRadius: "3px",
          background: fill,
          border: `1.4px solid ${stroke}`,
        }}
      />
      {label}
    </span>
  );
}

export default function RoadmapOverview() {
  return (
    <figure className="roadmap-overview">
      <FlowChart
        direction="TB"
        nodes={NODES}
        edges={EDGES}
        maxWidth={900}
        ariaLabel="物理学ロードマップの全 36 カテゴリの依存関係図。前提知識を起点に、数学・物理の各分野を経て、標準模型と一般相対性理論の 2 つのゴールへ至る。"
      />
      <figcaption className="roadmap-legend">
        <LegendItem
          fill="var(--flow-node-done-fill)"
          stroke="var(--flow-node-done-stroke)"
          label={`執筆済み（${DONE_COUNT} / ${CATEGORIES.length} カテゴリ）`}
        />
        <LegendItem
          fill="var(--flow-node-fill)"
          stroke="var(--flow-node-stroke)"
          label="執筆予定"
        />
        <LegendItem
          fill="var(--flow-node-goal-fill)"
          stroke="var(--flow-node-goal-stroke)"
          label="到達目標"
        />
      </figcaption>
    </figure>
  );
}
