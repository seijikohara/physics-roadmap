import { describe, expect, it } from "vitest";
import { parseDesignDoc } from "./design-doc.ts";
import type { Row } from "./design-doc.ts";
import { closureOf, dependenciesOf, redundantPrereqs } from "./graph.ts";
import { internalLinks } from "./links.ts";
import { checkRoadmap, upstreamChapters } from "./rules.ts";

const HEADER = "| ID | タイトル | 扱う内容 | 前提 | 章 |\n| --- | --- | --- | --- | --- |";

const doc = [
  "### 微分積分（M-CALC）",
  "",
  HEADER,
  "| M-CALC-01 | 極限 | $\\lim$ | PRE-01 | math/calculus/limits |",
  "| M-CALC-02 | 導関数 | $f'$ | M-CALC-01、PRE-01 | — |",
  "",
  "### 古典力学（P-CM）",
  "",
  HEADER,
  "| P-CM-01 | 運動 | 位置 | M-CALC-02 | — |",
  "",
  "#### 任意枠",
  "",
  HEADER,
  "| P-CM-02 | 剛体 | 回転 | P-CM-01 | — |",
].join("\n");

const row = (id: string, prereqs: readonly string[], ...chapters: readonly string[]): Row => ({
  id,
  title: id,
  content: "",
  prereqs,
  chapters,
  optional: false,
  category: "M-A",
});

describe("parseDesignDoc", () => {
  it("章の表の行を、カテゴリ・任意枠・未執筆の区別つきで読む", () => {
    const rows = parseDesignDoc(doc);
    expect(rows.map((r) => r.id)).toEqual(["M-CALC-01", "M-CALC-02", "P-CM-01", "P-CM-02"]);
    expect(rows[0]?.chapters).toEqual(["math/calculus/limits"]);
    expect(rows[1]?.chapters).toEqual([]);
    expect(rows[1]?.prereqs).toEqual(["M-CALC-01", "PRE-01"]);
    expect(rows.map((r) => r.category)).toEqual(["M-CALC", "M-CALC", "P-CM", "P-CM"]);
    expect(rows.map((r) => r.optional)).toEqual([false, false, false, true]);
  });

  it("章の表でない表を読まない", () => {
    expect(parseDesignDoc("### 代数（M-ALG）\n\n| a | b |\n| - | - |\n| 1 | 2 |")).toEqual([]);
  });

  it("列の数が違う行で止まる", () => {
    expect(() => parseDesignDoc(`### 代数（M-ALG）\n\n${HEADER}\n| a | b |`)).toThrow(/列の数/u);
  });
});

describe("closureOf と redundantPrereqs", () => {
  const dependencies = dependenciesOf([row("a", []), row("b", ["a"]), row("c", ["b", "a"])]);

  it("推移的な前提を集める", () => {
    expect([...closureOf("c", dependencies)].toSorted()).toEqual(["a", "b"]);
  });

  it("ほかの前提から得られる前提を見つける", () => {
    expect(redundantPrereqs("c", dependencies)).toEqual(["a"]);
    expect(redundantPrereqs("b", dependencies)).toEqual([]);
  });
});

describe("internalLinks", () => {
  it("相対リンクを章自身を基準に解決する", () => {
    const text = "[a](../chain-rule/) [b](../../set/sets/#x) [c](https://example.com) [d](#y)";
    expect(internalLinks("math/calculus/limits", text)).toEqual([
      "math/calculus/chain-rule",
      "math/set/sets",
    ]);
  });

  it("base パスつきのリンクを解決し、章自身へのリンクを除く", () => {
    const text = "[a](/physics-roadmap/math/set/sets/) [b](../limits/)";
    expect(internalLinks("math/calculus/limits", text)).toEqual(["math/set/sets"]);
  });
});

describe("checkRoadmap", () => {
  const rows = [row("a", [], "x"), row("b", ["a"], "y"), row("c", ["b"], "z")];

  it("上流の章へのリンクを通す", () => {
    const chapters = new Map([
      ["x", ""],
      ["y", "[a](../x/)"],
      ["z", "[a](../x/) [b](../y/)"],
    ]);
    expect(checkRoadmap(rows, chapters)).toEqual([]);
  });

  it("下流の章へのリンクと切れたリンクを報告する", () => {
    const chapters = new Map([
      ["x", "[下流](../z/) [無い](../nothing/)"],
      ["y", ""],
      ["z", ""],
    ]);
    expect(checkRoadmap(rows, chapters)).toEqual([
      "x: 上流でない章へのリンク: z",
      "x: リンクが切れている: nothing",
    ]);
  });

  it("未知の前提・循環・本線から任意枠への依存・ファイルの過不足を報告する", () => {
    const broken: readonly Row[] = [
      row("a", ["missing"]),
      row("b", ["c"]),
      row("c", ["b"]),
      { ...row("d", []), optional: true },
      row("e", ["d"], "gone"),
    ];
    const problems = checkRoadmap(broken, new Map([["extra", ""]]));
    expect(problems).toContain("a: 前提の ID が見つからない: missing");
    expect(problems).toContain("b: 依存が循環している");
    expect(problems).toContain("b: 同じカテゴリの後の行を前提にしている: c");
    expect(problems).toContain("e: 本線の行が任意枠の行を前提にしている: d");
    expect(problems).toContain("設計書の章のファイルが無い: gone");
    expect(problems).toContain("設計書の行に対応しない章がある: extra");
  });

  it("推移的に得られる前提の重ね書きを報告する", () => {
    const layered = [row("a", []), row("b", ["a"]), row("c", ["b", "a"])];
    expect(checkRoadmap(layered, new Map())).toContain(
      "c: 前提が推移的に得られる ID を重ねている: a",
    );
  });

  it("重複した ID を報告する", () => {
    expect(checkRoadmap([row("a", []), row("a", [])], new Map())).toContain("ID が重複している: a");
  });

  it("統合の前の 2 つのファイルを 1 行に対応させる", () => {
    const merged = [row("a", [], "x", "x2"), row("b", ["a"], "y")];
    const chapters = new Map([
      ["x", ""],
      ["x2", ""],
      ["y", "[a](../x/) [b](../x2/)"],
    ]);
    expect(checkRoadmap(merged, chapters)).toEqual([]);
  });

  it("出発点の章からの下流へのリンクは許す", () => {
    const start = [row("a", [], "prerequisites/knowledge"), row("b", ["a"], "prerequisites/set")];
    const chapters = new Map([
      ["prerequisites/knowledge", "[下流](../set/)"],
      ["prerequisites/set", ""],
    ]);
    expect(checkRoadmap(start, chapters)).toEqual([]);
  });

  it("1 つの章に複数の行があるとき、どの行の上流へのリンクも許す", () => {
    const split = [
      row("a", [], "x"),
      row("b", [], "y"),
      row("c", ["a"], "z"),
      row("d", ["b"], "z"),
    ];
    expect([...upstreamChapters("z", split)].toSorted()).toEqual(["x", "y"]);
  });
});
