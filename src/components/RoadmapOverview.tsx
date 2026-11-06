import FlowChart, { type FlowEdge, type FlowNode } from "./FlowChart";

/**
 * トップページのロードマップ全体図。35 カテゴリの依存関係を 1 枚の有向グラフで示す。
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
type Category = Readonly<{ id: string; label: string; tone?: "done" | "goal" }>;

// 執筆済みカテゴリ（2026 年 10 月時点）。docs/roadmap-design.md の実装状況に対応する。
const DONE: ReadonlySet<string> = new Set([
  "PRE",
  "M-SET",
  "M-ALG",
  "M-FUN",
  "M-VEC",
  "M-AGEO",
  "M-CPX",
  "M-SEQ",
  "M-CALC",
  "M-MVC",
  "M-VCAL",
]);
// 到達目標の 2 カテゴリ。
const GOALS: ReadonlySet<string> = new Set(["P-SMD", "P-GR"]);

// カテゴリ一覧（設計書の順）。短縮名で描く。
const CATEGORIES: readonly Readonly<{ id: string; label: string }>[] = [
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
  { id: "M-VAR", label: "変分法" },
  { id: "M-FOU", label: "フーリエ解析" },
  { id: "M-PDE", label: "偏微分方程式" },
  { id: "M-SPF", label: "特殊関数" },
  { id: "M-PRB", label: "確率" },
  { id: "M-CXA", label: "複素解析" },
  { id: "M-GRP", label: "抽象代数" },
  { id: "M-REP", label: "表現論" },
  { id: "M-LIE", label: "リー群・リー代数" },
  { id: "M-RG", label: "リーマン幾何" },
  { id: "P-CM", label: "古典力学" },
  { id: "P-AM", label: "解析力学" },
  { id: "P-SR", label: "特殊相対論" },
  { id: "P-EM", label: "電磁気学" },
  { id: "P-THM", label: "熱力学" },
  { id: "P-QM", label: "量子力学" },
  { id: "P-STA", label: "統計力学" },
  { id: "P-RQM", label: "相対論的量子力学" },
  { id: "P-QFT", label: "場の量子論" },
  { id: "P-GAU", label: "ゲージ理論" },
  { id: "P-SMD", label: "標準模型" },
  { id: "P-GR", label: "一般相対性理論" },
];

// カテゴリ間の前提関係（前提 → 依存先）。設計書の前提の列から求め、推移的な辺を除いた。
const DEPENDENCIES: readonly (readonly [from: string, to: string])[] = [
  ["PRE", "M-SET"],
  ["M-SET", "M-ALG"],
  ["M-ALG", "M-FUN"],
  ["M-FUN", "M-VEC"],
  ["M-VEC", "M-AGEO"],
  ["M-VEC", "M-CPX"],
  ["M-FUN", "M-SEQ"],
  ["M-AGEO", "M-CALC"],
  ["M-CPX", "M-CALC"],
  ["M-SEQ", "M-CALC"],
  ["M-CALC", "M-MVC"],
  ["M-MVC", "M-VCAL"],
  ["M-MVC", "M-LIN"],
  ["M-LIN", "M-ODE"],
  ["M-VCAL", "M-VAR"],
  ["M-ODE", "M-VAR"],
  ["M-ODE", "M-FOU"],
  ["M-VCAL", "M-PDE"],
  ["M-FOU", "M-PDE"],
  ["M-PDE", "M-SPF"],
  ["M-MVC", "M-PRB"],
  ["M-VCAL", "M-CXA"],
  ["M-ODE", "M-CXA"],
  ["M-LIN", "M-GRP"],
  ["M-GRP", "M-REP"],
  ["M-ODE", "M-LIE"],
  ["M-REP", "M-LIE"],
  ["M-VAR", "M-RG"],
  ["M-VCAL", "P-CM"],
  ["M-ODE", "P-CM"],
  ["M-VAR", "P-AM"],
  ["M-PDE", "P-AM"],
  ["P-CM", "P-AM"],
  ["P-CM", "P-SR"],
  ["P-AM", "P-EM"],
  ["P-SR", "P-EM"],
  ["M-MVC", "P-THM"],
  ["M-SPF", "P-QM"],
  ["M-PRB", "P-QM"],
  ["P-EM", "P-QM"],
  ["P-THM", "P-STA"],
  ["P-QM", "P-STA"],
  ["M-LIE", "P-RQM"],
  ["P-QM", "P-RQM"],
  ["M-CXA", "P-QFT"],
  ["P-RQM", "P-QFT"],
  ["P-QFT", "P-GAU"],
  ["P-GAU", "P-SMD"],
  ["M-RG", "P-GR"],
  ["P-AM", "P-GR"],
  ["P-SR", "P-GR"],
];

function toneOf(id: string): Category["tone"] {
  if (GOALS.has(id)) return "goal";
  if (DONE.has(id)) return "done";
  return undefined;
}

const NODES: readonly FlowNode[] = CATEGORIES.map((c) => ({
  id: c.id,
  label: c.label,
  tone: toneOf(c.id),
}));

const EDGES: readonly FlowEdge[] = DEPENDENCIES.map(([from, to]) => ({ from, to }));

const DONE_COUNT = CATEGORIES.filter((c) => DONE.has(c.id)).length;

/** 凡例の 1 項目。 */
function LegendItem({
  fill,
  stroke,
  label,
}: Readonly<{ fill: string; stroke: string; label: string }>) {
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
        ariaLabel="物理学ロードマップの全 35 カテゴリの依存関係図。前提知識を起点に、数学・物理の各分野を経て、標準模型と一般相対性理論の 2 つのゴールへ至る。"
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
