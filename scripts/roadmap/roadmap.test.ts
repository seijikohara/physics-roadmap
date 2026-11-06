import { describe, expect, it } from "vitest";
import { MATH_MARK, parseBody } from "./body.ts";
import { parseDesignDoc } from "./design-doc.ts";
import type { Row } from "./design-doc.ts";
import { closureOf, dependenciesOf, redundantPrereqs } from "./graph.ts";
import { internalLinks } from "./links.ts";
import { checkRoadmap, upstreamChapters } from "./rules.ts";
import {
  buildContext,
  buildTermIndex,
  definedTerms,
  findTerms,
  policyProblems,
  reportChapter,
} from "./term-rules.ts";
import type { TermPolicy } from "./term-rules.ts";

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

const chapterText = (title: string, ...lines: readonly string[]): string =>
  ["---", `title: ${title}`, "---", "", ...lines].join("\n");

const defined = (...lines: readonly string[]): readonly string[] => {
  const text = chapterText("題名", ...lines);
  return definedTerms(text, parseBody(text)).filter((term) => term !== "題名");
};

describe("parseBody", () => {
  const text = [
    "---",
    "title: 題名の語",
    "---",
    "",
    'import Plot from "../Plot";',
    "",
    "export const data = [",
    '  { label: "輸出の語" },',
    "",
    "];",
    "export const f = (x) =>",
    "  x > 0;",
    "",
    "<Plot",
    '  label="属性の語"',
    "  test={(x) => x > 0}",
    "/>",
    "",
    "本文の語 $\\alpha<1$ と[リンクの語](../x/)[^note]。",
    "",
    "<figcaption><em>図の語 $x +",
    "y$ である。</em></figcaption>",
    "",
    "$$",
    "\\beta",
    "$$",
    "",
    "[^note]: 脚注の語。",
  ].join("\n");
  const body = parseBody(text);
  const prose = body.lines.join("\n");

  it("frontmatter・import・export・JSX の属性を散文から除く", () => {
    for (const word of ["題名の語", "輸出の語", "属性の語", "=>", "import"]) {
      expect(prose).not.toContain(word);
    }
  });

  it("行の数を保ち、リンクの表示と図の説明と脚注を残す", () => {
    expect(body.lines).toHaveLength(text.split("\n").length);
    expect(body.lines[18]).toBe(`本文の語 ${MATH_MARK} とリンクの語。`);
    expect(body.lines[20]).toContain("図の語");
    expect(body.lines.at(-1)).toBe(" 脚注の語。");
  });

  it("数式の中身を行番号つきで取り出す。図の説明の中の改行もまたぐ", () => {
    expect(body.math).toEqual([
      { line: 19, tex: "$\\alpha<1$" },
      { line: 21, tex: "$x +\ny$" },
      { line: 24, tex: "$$\n\\beta\n$$" },
    ]);
  });
});

describe("definedTerms", () => {
  it("引用ブロックの見出しの名前を語にする", () => {
    expect(defined("> **定積分（定義）.** 次の値を定める。")).toEqual(["定積分"]);
    expect(defined("> **局所の約束（約束）.** 次のように書く。")).toEqual(["局所の約束"]);
    expect(defined("> **中間値の定理（定理）.** 次が成り立つ。")).toEqual(["中間値の定理"]);
    expect(defined("> **グリーンの定理.** 次が成り立つ。")).toEqual(["グリーンの定理"]);
    expect(defined("> **内積の定義**：次の値である。")).toEqual(["内積"]);
  });

  it("定義の見出しの並列を分け、定理の名前は分けない", () => {
    expect(defined("> **極大・極小（定義）.** 次の点である。")).toEqual([
      "極大・極小",
      "極大",
      "極小",
    ]);
    expect(defined("> **水平・鉛直の補助（定理）.** 次が成り立つ。")).toEqual(["水平・鉛直の補助"]);
  });

  it("太字に続く定義の言い方から語を取り出す", () => {
    expect(defined("値を**極値**と呼ぶ。")).toEqual(["極値"]);
    expect(defined("値を**最大値**という。")).toEqual(["最大値"]);
    expect(defined("関数は**連続**であるという。")).toEqual(["連続"]);
    expect(defined("**級数**とは、数列の和である。")).toEqual(["級数"]);
    expect(defined("次の値を**面積**と定める。")).toEqual(["面積"]);
    expect(defined("名前は**回転**である[^note]。")).toEqual(["回転"]);
  });

  it("連ねた太字のどちらも語にする", () => {
    expect(defined("先頭の項を**初項**または**第 1 項**と呼ぶ。")).toEqual(["初項", "第 1 項"]);
    expect(defined("横の並びを**行**、縦の並びを**列**と呼ぶ。")).toEqual([]);
    expect(defined("横を**横行**、縦の並びを**縦列**と呼ぶ。")).toEqual(["横行", "縦列"]);
  });

  it("見出し語を語にしない", () => {
    expect(defined("**解法.** 次の手順で解く。")).toEqual([]);
    expect(defined("**大きさ.** 値の大きさを調べる。")).toEqual([]);
    expect(defined("- **証明.** 背理法で示す。と呼ぶ。")).toEqual([]);
  });

  it("まとめの箇条書きと強調を語にしない", () => {
    expect(defined("- **定積分**：符号つきの面積である。")).toEqual([]);
    expect(defined("値が**実際にとられる**点を調べる。")).toEqual([]);
  });

  it("語の中の数式は、助詞が続くときだけ修飾語として外す", () => {
    expect(defined("値を **$x$ についての偏微分係数**と呼ぶ。")).toEqual(["偏微分係数"]);
    expect(defined("座標の空間を **$uvw$ 空間**と呼ぶ。")).toEqual([]);
  });

  it("動詞の語は名詞の形も定める", () => {
    expect(defined("数列は**発散する**という。")).toEqual(["発散する", "発散"]);
  });

  it("太字でない定義の言い方と題名を語にする", () => {
    expect(defined("次の値を、一次の漸化式と呼ぶ。")).toEqual(["一次の漸化式"]);
    expect(defined("絶対値とは、符号を除いた大きさである。")).toEqual(["絶対値"]);
    const text = chapterText("定積分とリーマン和（基礎）");
    expect(definedTerms(text, parseBody(text))).toEqual([
      "定積分とリーマン和",
      "定積分",
      "リーマン和",
      "基礎",
    ]);
  });

  it("前提節・学習目標・まとめ・参考文献の文を定義に数えない", () => {
    for (const section of ["前提", "学習目標", "まとめ", "参考文献"]) {
      expect(defined(`## ${section}`, "", "値を**極値**と呼ぶ。")).toEqual([]);
    }
    expect(defined("## 前提", "", "- 語", "", "## 本文", "", "値を**極値**と呼ぶ。")).toEqual([
      "極値",
    ]);
  });

  it("2 文字未満の語を使わない", () => {
    expect(defined("結果を**和**と呼ぶ。")).toEqual([]);
  });
});

describe("findTerms", () => {
  const index = buildTermIndex(["定積分", "不定積分", "積分", "2 変数関数"]);

  it("最長一致で語を取り出す", () => {
    expect(findTerms("不定積分と定積分の積分", index)).toEqual(["不定積分", "定積分", "積分"]);
  });

  it("空白を含む語も取り出す", () => {
    expect(findTerms("2 変数関数を調べる", index)).toEqual(["2 変数関数"]);
  });
});

describe("reportChapter", () => {
  const noPolicy: TermPolicy = { aliases: [], exceptions: [] };
  const chapters = new Map([
    ["a", chapterText("第一", "値を**定積分**と呼ぶ。$\\operatorname{Arg}z$")],
    ["b", chapterText("第二", "値を**定積分**と呼ぶ。値を**線積分**と呼ぶ。")],
    [
      "c",
      chapterText(
        "第三",
        "",
        "定積分と線積分を使う。$\\operatorname{Li}_2$ と $\\mathcal{L}$",
        "",
        "## 参考文献",
        "",
        "- 線積分の本",
      ),
    ],
    ["d", chapterText("第四", "値を**偏微分**と呼ぶ。偏微分を使う。")],
  ]);
  const context = buildContext(chapters, []);

  it("定義する章のどれかが上流か自章にあれば合格とする", () => {
    expect(
      reportChapter("c", new Set(["a"]), context, noPolicy).outside.map((o) => o.term),
    ).toEqual(["線積分"]);
    expect(reportChapter("c", new Set(["b"]), context, noPolicy).outside).toEqual([]);
    expect(reportChapter("d", new Set(), context, noPolicy).outside).toEqual([]);
  });

  it("前提節の語の使用を数えない", () => {
    const inventory = buildContext(
      new Map([
        ["a", chapterText("第一", "値を**定積分**と呼ぶ。")],
        ["c", chapterText("第三", "## 前提", "", "- 定積分を使う。", "", "## 本文", "", "本文。")],
      ]),
      [],
    );
    expect(reportChapter("c", new Set(), inventory, noPolicy).outside).toEqual([]);
  });

  it("語・行番号・定義する章を出し、参考文献の節を数えない", () => {
    expect(reportChapter("c", new Set(), context, noPolicy).outside).toEqual([
      { term: "定積分", lines: [6], definedIn: ["a", "b"] },
      { term: "線積分", lines: [6], definedIn: ["b"] },
    ]);
  });

  it("上流に現れない LaTeX の命令を、名前まで含めて出す", () => {
    expect(reportChapter("c", new Set(["a"]), context, noPolicy).newCommands).toEqual([
      { command: "\\operatorname{Li}", lines: [6] },
      { command: "\\mathcal", lines: [6] },
    ]);
  });

  it("例外の組を説明済みへ分け、報告に現れない例外を問題にする", () => {
    const policy: TermPolicy = {
      aliases: [],
      exceptions: [{ term: "線積分", kind: "多義語", reason: "理由", chapters: ["c", "d"] }],
    };
    const reports = ["c", "d"].map((chapter) =>
      reportChapter(chapter, new Set(["a"]), context, policy),
    );
    expect(reports[0]?.outside).toEqual([]);
    expect(reports[0]?.excused.map((o) => o.term)).toEqual(["線積分"]);
    expect(policyProblems(reports, context, policy)).toEqual(["例外が報告に現れない: 線積分（d）"]);
  });

  it("別の書き方を、元の語を定義する章の語として扱う", () => {
    const aliased = buildContext(
      new Map([
        ["a", chapterText("第一", "規則を **2 変数関数**と呼ぶ。")],
        ["c", chapterText("第三", "2 変数の関数を調べる。")],
      ]),
      [{ term: "2 変数関数", forms: ["2 変数の関数"], reason: "表記の揺れ" }],
    );
    expect(reportChapter("c", new Set(), aliased, noPolicy).outside).toEqual([
      { term: "2 変数の関数", lines: [5], definedIn: ["a"] },
    ]);
    expect(reportChapter("c", new Set(["a"]), aliased, noPolicy).outside).toEqual([]);
  });

  it("見出しに現れた語は、章が導入した語に数える", () => {
    const headed = buildContext(
      new Map([
        ["a", chapterText("第一", "値を**係数**と呼ぶ。")],
        ["b", chapterText("第二", "## 係数の比較")],
        ["c", chapterText("第三", "係数を比べる。")],
      ]),
      [],
    );
    expect(reportChapter("c", new Set(["b"]), headed, noPolicy).outside).toEqual([]);
  });
});
