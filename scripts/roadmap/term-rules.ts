// 章が定義した語を本文から取り出し、章が上流の外の語を使っていないかを調べる。
// ファイルを読まない純粋な処理である。正は章の本文であり、前提節の目録は使わない。

import { MATH_MARK, parseBody } from "./body.ts";
import type { Body } from "./body.ts";

/** 語から、語を定義する章の一覧への対応。 */
export type TermTable = ReadonlyMap<string, readonly string[]>;

/** 語の先頭の 1 文字から、長い順に並べた語への対応。最長一致に使う。 */
export type TermIndex = ReadonlyMap<string, readonly string[]>;

/** 同じ語の別の書き方。`forms` は `term` を定義する章が定義したものとして扱う。 */
export type TermAlias = Readonly<{ term: string; forms: readonly string[]; reason: string }>;

/** 上流の外の語のうち、欠陥でないと判断した語と章の組。 */
export type TermException = Readonly<{
  term: string;
  kind: string;
  reason: string;
  chapters: readonly string[];
}>;

export type TermPolicy = Readonly<{
  aliases: readonly TermAlias[];
  exceptions: readonly TermException[];
}>;

/** 語や命令から、現れる行番号への対応。 */
type Occurrences = ReadonlyMap<string, readonly number[]>;

export type TermContext = Readonly<{
  bodies: ReadonlyMap<string, Body>;
  table: TermTable;
  index: TermIndex;
  commands: ReadonlyMap<string, Occurrences>;
}>;

export type OutsideTerm = Readonly<{
  term: string;
  lines: readonly number[];
  definedIn: readonly string[];
}>;

export type NewCommand = Readonly<{ command: string; lines: readonly number[] }>;

export type ChapterReport = Readonly<{
  chapter: string;
  /** 上流の外の語のうち、例外のファイルで説明できないもの。 */
  outside: readonly OutsideTerm[];
  /** 上流の外の語のうち、例外のファイルで説明したもの。 */
  excused: readonly OutsideTerm[];
  /** 本章で初出の記号。合否に使わない。 */
  newCommands: readonly NewCommand[];
}>;

const MIN_TERM_LENGTH = 2;

/**
 * 語を使う範囲に数えない節。正は章の本文であり、前提節は縮める対象なので、結果を前提節に依存させない。
 * 参考文献の題名は読者への案内であり、語の使用ではない。
 */
const IGNORED_SECTIONS: ReadonlySet<string> = new Set(["前提", "参考文献"]);

/**
 * 語を定義する節でないもの。前提節の目録は上流の語を言い換えるので、数えると循環する。
 * 学習目標とまとめは本文の語を振り返るだけである。
 */
const RECAP_SECTIONS: ReadonlySet<string> = new Set(["前提", "学習目標", "まとめ", "参考文献"]);

/**
 * 前提の章は語を定義せず列挙する。列挙する節に現れた語は、前提の章で導入済みとして扱う。
 * 「前提に含まれないもの」の節は数えない。
 */
const ASSUMED_SECTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["prerequisites/knowledge", new Set(["数学の前提", "理科の前提"])],
]);

const BOLD = /\*\*(?<term>[^*\n]+)\*\*/gu;
const QUOTE_HEAD =
  /^>\s*\*\*(?<name>[^*\n]+?)(?:（(?<kind>[^）]*)）)?(?<period>[.．])?\*\*(?<colon>[：:])?/u;
/** 引用ブロックの見出しの種類のうち、語そのものを定めるもの。定理などの名前は全体で 1 語である。 */
const DEFINITION_KINDS: ReadonlySet<string> = new Set(["定義", "約束"]);
const DEFINER =
  /^(?:と呼[ぶびば]|とも呼[ぶびば]|という|といい|ともいう|ともいい|であるという|であるといい|と定め|と定義|とは|を表[すし]|と読[むみ]|を導入|がある。|を、?次の[^。]*定め)/u;
const NAME_DEFINER = /^である(?:。|$)/u;
const PARENTHETICAL = /^\s*(?:（[^）]*）)?\s*/u;
const CHAIN_GAP = /^\s*(?:、または|または|もしくは|、|・|と|か)\s*$|^、[^。*]{1,14}を$/u;
const PLAIN_DEFINER = /(?:（[^（）]*）)?」?(?:とも|と)呼[ぶびば]/gu;
const PLAIN_TAIL = /(?:^|[をは、「])(?<term>[^をは、。「」（）*]{2,16})$/u;
const PLAIN_TOPIC =
  /(?:^|[。、：:]|[-*>]\s)\s*(?<term>[^、。「」（）*§\s]{1,11}[\p{Script=Han}\p{Script=Katakana}ー])とは、/gu;
const TABLE_BOLD = /\|\s*\*\*(?<term>[^*|]+)\*\*\s*(?:\||。)/gu;
const HEADING = /^#{2,4} (?<name>.+)$/u;
const LIST_HEAD = /^(?:>\s*)?\s*[-*]\s+(?:\*\*)?(?<head>[^：:*]{2,16})(?:\*\*)?[：:]/u;
/** 数式の直後の助詞。数式を修飾語として語から外してよい目印である。 */
const AFTER_MATH =
  /^\s*(?:についての|について|における|に関する|に対する|に沿った|での|の上の|の|に|を|と|で|は|が)\s*(?<rest>.+)$/u;
const TRAILING_MATH = new RegExp(`\\s*${MATH_MARK}$`, "u");
const FRONTMATTER_TITLE = /^title:\s*(?<title>.+)$/mu;
/** 「内積の定義」「関数とグラフの概念」は、語そのものを定める。 */
const NAME_SUFFIX = /の(?:定義|概念)$/u;

/**
 * 語の中の数式を除く。「§ についての偏微分係数」の § は修飾語なので、助詞より後を語にする。
 * 「§ 空間」の § は語の一部なので、語の形を決められず、捨てる。
 */
function withoutMath(raw: string): string | undefined {
  const trimmed = raw.replace(TRAILING_MATH, "").trim();
  if (!trimmed.includes(MATH_MARK)) return trimmed;
  return AFTER_MATH.exec(trimmed.split(MATH_MARK).at(-1) ?? "")?.groups?.rest;
}

/** 語を比べる形にする。動詞の「発散する」は「発散」も定める。 */
function normalizeTerm(raw: string): readonly string[] {
  const term = withoutMath(raw)?.replace(NAME_SUFFIX, "").trim();
  if (term === undefined || /^[のをに]/u.test(term)) return [];
  const stem = term.endsWith("する") ? [term.slice(0, -2)] : [];
  return [term, ...stem].filter(
    (word) => word.replaceAll(" ", "").length >= MIN_TERM_LENGTH && /[^ -~]/u.test(word),
  );
}

/** 括弧の外と中を別の語にする。「重積分（二重積分）」は 2 語である。 */
function splitParens(name: string): readonly string[] {
  const inner = [...name.matchAll(/（(?<inner>[^）]*)）/gu)].map((m) => m.groups?.inner ?? "");
  return [name.replaceAll(/（[^）]*）/gu, "").trim(), ...inner];
}

/** 「・」でつないだ語を分ける。全体も残すので、「ド・モアブルの定理」も語になる。 */
const splitDots = (name: string): readonly string[] => [
  name,
  ...name.split("・").map((piece) => piece.trim()),
];

/** 題名と定義の見出しを語へ分ける。どちらも「と」と「・」は並列なので、そこで分ける。 */
const headingTerms = (name: string): readonly string[] =>
  splitParens(name).flatMap((part) => [
    part,
    ...part.split(/[・と]/u).map((piece) => piece.trim()),
  ]);

/** 太字が定義の語か。太字の後の続き方で決める。見出し語は `.` で終わるので除く。 */
function boldTerms(line: string): readonly string[] {
  const spans = [...line.matchAll(BOLD)];
  const rests = spans.map((span, index) =>
    line.slice(span.index + span[0].length, spans[index + 1]?.index ?? line.length),
  );
  const defined = spans.reduceRight<readonly boolean[]>((flags, span, index) => {
    const rest = rests[index] ?? "";
    const after = rest.replace(PARENTHETICAL, "");
    const named = NAME_DEFINER.test(after) && !(span.groups?.term ?? "").includes(MATH_MARK);
    const chained = index < spans.length - 1 && flags[0] && CHAIN_GAP.test(rest);
    return [DEFINER.test(after) || named || chained, ...flags];
  }, []);
  return spans
    .filter((_, index) => defined[index])
    .map((span) => span.groups?.term ?? "")
    .filter((term) => !/[.．]$/u.test(term));
}

/** 太字でない「〜を X と呼ぶ」と「X とは、」から X を取り出す。 */
function plainTerms(line: string): readonly string[] {
  const named = [...line.matchAll(PLAIN_DEFINER)].flatMap((match) => {
    const head = line.slice(0, match.index);
    const term = PLAIN_TAIL.exec(head.split("。").at(-1) ?? "")?.groups?.term;
    return term === undefined || term.includes(MATH_MARK) ? [] : [term.trim()];
  });
  const topics = [...line.matchAll(PLAIN_TOPIC)].map((match) => match.groups?.term ?? "");
  return [...named, ...topics];
}

/** 表の中で、セルの先頭を太字にした語を返す。記号の各部の名前の表に使う形である。 */
const tableTerms = (line: string): readonly string[] =>
  line.startsWith("|") ? [...line.matchAll(TABLE_BOLD)].map((m) => m.groups?.term ?? "") : [];

function quoteHeadTerms(line: string): readonly string[] {
  const groups = QUOTE_HEAD.exec(line)?.groups;
  if (groups === undefined) return [];
  const { name = "", kind = "", period, colon } = groups;
  if (DEFINITION_KINDS.has(kind)) return headingTerms(name);
  if (colon !== undefined && name.includes(MATH_MARK)) return [];
  return period !== undefined || colon !== undefined ? [name] : [];
}

/** 章の本文から、章が定義した語を返す。章の題名も語に数える。 */
export function definedTerms(text: string, body: Body): readonly string[] {
  const title = FRONTMATTER_TITLE.exec(text)?.groups?.title ?? "";
  const sections = sectionNames(body.lines);
  const raw = [
    ...headingTerms(title.trim()),
    ...body.lines
      .filter((_, position) => !RECAP_SECTIONS.has(sections[position] ?? ""))
      .flatMap((line) => [
        ...quoteHeadTerms(line),
        ...boldTerms(line).flatMap((term) => splitParens(term).flatMap((part) => splitDots(part))),
        ...plainTerms(line),
        ...tableTerms(line),
      ]),
  ];
  return [...new Set(raw.flatMap((term) => normalizeTerm(term)))];
}

/** 語の並びから、最長一致に使う索引を作る。 */
export function buildTermIndex(terms: Iterable<string>): TermIndex {
  const sorted = [...terms].toSorted((a, b) => b.length - a.length);
  return new Map(Map.groupBy(sorted, (term) => term.charAt(0)));
}

/** 行の中の語を、左から最長一致で取り出す。「不定積分」の中の「定積分」を拾わない。 */
export function findTerms(line: string, index: TermIndex): readonly string[] {
  // 位置を進めながら集めるので、関数の中に閉じた可変の位置とバッファを使う。
  const found: string[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const term = index.get(line.charAt(cursor))?.find((word) => line.startsWith(word, cursor));
    if (term !== undefined) found.push(term);
    cursor += term?.length ?? 1;
  }
  return found;
}

const withoutBold = (line: string): string => line.replaceAll("**", "");

/** 見出し 2 ごとの節の名前を行の並びで返す。見出しより前は空文字列である。 */
function sectionNames(lines: readonly string[]): readonly string[] {
  // 行ごとに配列を作り直すと遅いので、関数の中に閉じた可変のバッファを使う。
  const names: string[] = [];
  for (const line of lines) {
    names.push(/^## (?<name>.+)$/u.exec(line)?.groups?.name ?? names.at(-1) ?? "");
  }
  return names;
}

/** 章の見出しと、まとめの外の箇条書きの先頭に現れる語を返す。定義の形を取らない導入を拾う。 */
function introducedTerms(body: Body, index: TermIndex): readonly string[] {
  const sections = sectionNames(body.lines);
  return body.lines.flatMap((line, position) => {
    const section = sections[position] ?? "";
    if (RECAP_SECTIONS.has(section)) return [];
    const head = HEADING.exec(line)?.groups?.name ?? LIST_HEAD.exec(line)?.groups?.head;
    return head === undefined ? [] : findTerms(withoutBold(head), index);
  });
}

/** 前提の章が列挙する節に現れる語を返す。 */
function assumedTerms(chapter: string, body: Body, index: TermIndex): readonly string[] {
  const names = ASSUMED_SECTIONS.get(chapter);
  if (names === undefined) return [];
  const sections = sectionNames(body.lines);
  return body.lines.flatMap((line, position) =>
    names.has(sections[position] ?? "") ? findTerms(withoutBold(line), index) : [],
  );
}

const COMMAND = /\\(?<name>[A-Za-z]+)(?:\s*\{(?<argument>[^{}]*)\})?/gu;

/** 引数が記号そのものを決める命令。`\operatorname{Li}` と `\operatorname{Arg}` は別の記号である。 */
const NAMED_COMMANDS: ReadonlySet<string> = new Set(["operatorname", "mathbb", "begin"]);

/** 組版だけに効き、読者の読む記号を増やさない命令。初出の記号に数えない。 */
const LAYOUT_COMMANDS: ReadonlySet<string> = new Set([
  "Big",
  "Bigl",
  "Bigr",
  "big",
  "bigl",
  "bigr",
  "biggl",
  "biggr",
  "displaystyle",
  "end",
  "left",
  "phantom",
  "qquad",
  "quad",
  "right",
  "scriptstyle",
  "tag",
  "text",
  "textstyle",
]);

const commandName = (name: string, argument: string | undefined): string =>
  NAMED_COMMANDS.has(name) && argument !== undefined ? `\\${name}{${argument}}` : `\\${name}`;

/** 語や命令と行番号の組を、語や命令ごとの行番号へまとめる。 */
const groupLines = (pairs: readonly (readonly [string, number])[]): Occurrences =>
  new Map(
    [...Map.groupBy(pairs, ([key]) => key)].map(([key, group]) => [
      key,
      [...new Set(group.map(([, line]) => line))],
    ]),
  );

/** 数式の LaTeX の命令を、行番号つきで返す。 */
const commandsOf = (body: Body): Occurrences =>
  groupLines(
    body.math.flatMap(({ line, tex }) =>
      [...tex.matchAll(COMMAND)]
        .filter((match) => !LAYOUT_COMMANDS.has(match.groups?.name ?? ""))
        .map(
          (match) => [commandName(match.groups?.name ?? "", match.groups?.argument), line] as const,
        ),
    ),
  );

/** 語を定義する章の表を作る。別の書き方と、定義の形を取らない導入もここで加える。 */
function buildTermTable(
  chapters: ReadonlyMap<string, string>,
  bodies: ReadonlyMap<string, Body>,
  aliases: readonly TermAlias[],
): TermTable {
  const direct = [...bodies].flatMap(([chapter, body]) =>
    definedTerms(chapters.get(chapter) ?? "", body).map((term) => [term, chapter] as const),
  );
  const owners = (term: string): readonly (readonly [string, string])[] =>
    direct.filter(([word]) => word === term);
  const aliased = aliases.flatMap(({ term, forms }) =>
    forms.flatMap((form) => owners(term).map(([, chapter]) => [form, chapter] as const)),
  );
  const index = buildTermIndex(new Set([...direct, ...aliased].map(([term]) => term)));
  const introduced = [...bodies].flatMap(([chapter, body]) =>
    [...introducedTerms(body, index), ...assumedTerms(chapter, body, index)].map(
      (term) => [term, chapter] as const,
    ),
  );
  const pairs = [...direct, ...aliased, ...introduced];
  return new Map(
    [...Map.groupBy(pairs, ([term]) => term)].map(([term, group]) => [
      term,
      [...new Set(group.map(([, chapter]) => chapter))],
    ]),
  );
}

/** 全章を読み、章ごとの検査に使う表を作る。 */
export function buildContext(
  chapters: ReadonlyMap<string, string>,
  aliases: readonly TermAlias[],
): TermContext {
  const bodies = new Map([...chapters].map(([chapter, text]) => [chapter, parseBody(text)]));
  const table = buildTermTable(chapters, bodies, aliases);
  return {
    bodies,
    table,
    index: buildTermIndex(table.keys()),
    commands: new Map([...bodies].map(([chapter, body]) => [chapter, commandsOf(body)])),
  };
}

/** 章の本文の語を、語ごとの行番号へまとめる。 */
function usageOf(body: Body, index: TermIndex): Occurrences {
  const sections = sectionNames(body.lines);
  return groupLines(
    body.lines.flatMap((line, position) =>
      IGNORED_SECTIONS.has(sections[position] ?? "")
        ? []
        : findTerms(withoutBold(line), index).map((term) => [term, position + 1] as const),
    ),
  );
}

/** 章の語と記号を調べる。`upstream` は設計書の行から求めた推移的な上流の章である。 */
export function reportChapter(
  chapter: string,
  upstream: ReadonlySet<string>,
  context: TermContext,
  policy: TermPolicy,
): ChapterReport {
  const body = context.bodies.get(chapter) ?? { lines: [], math: [] };
  const allowed = new Set([...upstream, chapter]);
  const found = [...usageOf(body, context.index)].flatMap(
    ([term, lines]): readonly OutsideTerm[] => {
      const definedIn = context.table.get(term) ?? [];
      return definedIn.some((owner) => allowed.has(owner)) ? [] : [{ term, lines, definedIn }];
    },
  );
  const isExcused = (term: string): boolean =>
    policy.exceptions.some((entry) => entry.term === term && entry.chapters.includes(chapter));
  const seen = new Set(
    [...upstream].flatMap((name) => [...(context.commands.get(name)?.keys() ?? [])]),
  );
  const newCommands = [...(context.commands.get(chapter) ?? [])]
    .filter(([command]) => !seen.has(command))
    .map(([command, lines]) => ({ command, lines }));
  return {
    chapter,
    outside: found.filter(({ term }) => !isExcused(term)),
    excused: found.filter(({ term }) => isExcused(term)),
    newCommands,
  };
}

/** 例外のファイルの誤りを返す。報告に現れない組や、定義語でない語は、直した後の残骸である。 */
export function policyProblems(
  reports: readonly ChapterReport[],
  context: TermContext,
  policy: TermPolicy,
): readonly string[] {
  const excused = new Set(
    reports.flatMap((report) => report.excused.map(({ term }) => `${term} ${report.chapter}`)),
  );
  const aliases = policy.aliases
    .filter(({ term }) => !context.table.has(term))
    .map(({ term }) => `別の書き方の元の語が定義語に無い: ${term}`);
  const stale = policy.exceptions.flatMap(({ term, chapters }) =>
    chapters
      .filter((chapter) => !excused.has(`${term} ${chapter}`))
      .map((chapter) => `例外が報告に現れない: ${term}（${chapter}）`),
  );
  return [...aliases, ...stale];
}
