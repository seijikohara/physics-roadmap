// 章のファイルを、語を調べる散文と数式へ分ける。ファイルを読まない純粋な処理である。
// 行番号を保つため、除く部分は消さず、改行だけを残して空にする。

/** 散文の中で数式の位置を示す 1 文字。数式をまたいで語が連ならないように残す。 */
export const MATH_MARK = "§";

export type MathSpan = Readonly<{ line: number; tex: string }>;

export type Body = Readonly<{
  /** 散文の行。添字に 1 を足すと、ファイルの行番号である。 */
  lines: readonly string[];
  math: readonly MathSpan[];
}>;

type Span = Readonly<{ start: number; end: number; kind: "math" | "hidden" | "keep" }>;

const FRONTMATTER = /^---\n[\s\S]*?\n---(?:\n|$)/u;
const ESM_HEAD = /^(?:import|export)\s/u;
const CLOSERS: ReadonlyMap<string, string> = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);

const isLineHead = (text: string, index: number): boolean =>
  index === 0 || text.charAt(index - 1) === "\n";

/** `index` の引用符で始まる文字列の、閉じた直後の位置を返す。 */
function stringEnd(text: string, index: number): number {
  const quote = text.charAt(index);
  // 1 文字ずつ進む走査なので、関数の中に閉じた可変の位置を使う。
  let cursor = index + 1;
  while (cursor < text.length && text.charAt(cursor) !== quote) {
    cursor += text.charAt(cursor) === "\\" ? 2 : 1;
  }
  return cursor + 1;
}

/**
 * JavaScript の字句を文字列と括弧の深さだけ追い、`stop` が真を返す位置を探す。
 * 見つからなければファイルの末尾を返す。
 */
function scanCode(
  text: string,
  start: number,
  stop: (cursor: number, depth: number) => boolean,
): number {
  // 深さと位置を更新しながら進む走査なので、関数の中に閉じた可変の変数を使う。
  let depth = 0;
  let cursor = start;
  while (cursor < text.length) {
    if (stop(cursor, depth)) return cursor;
    const char = text.charAt(cursor);
    if (char === '"' || char === "'" || char === "`") {
      cursor = stringEnd(text, cursor);
    } else {
      if (CLOSERS.has(char)) depth += 1;
      if ([...CLOSERS.values()].includes(char)) depth -= 1;
      cursor += 1;
    }
  }
  return text.length;
}

/** import・export の塊の終わりを返す。MDX と同じく、括弧の外の空行で閉じる。 */
const esmEnd = (text: string, start: number): number =>
  scanCode(text, start, (cursor, depth) => depth === 0 && text.startsWith("\n\n", cursor));

/** `<` で始まるタグの、`>` の直後の位置を返す。属性の値の中の `>` では閉じない。 */
const tagEnd = (text: string, start: number): number =>
  scanCode(text, start, (cursor, depth) => depth === 0 && text.charAt(cursor) === ">") + 1;

/** `{` で始まる式の、対応する `}` の直後の位置を返す。 */
const expressionEnd = (text: string, start: number): number =>
  scanCode(text, start + 1, (cursor, depth) => depth === 0 && text.charAt(cursor) === "}") + 1;

const closingIndex = (text: string, marker: string, from: number): number => {
  const index = text.indexOf(marker, from);
  return index === -1 ? text.length : index + marker.length;
};

/** 行内の数式の閉じる `$` の位置を返す。図の説明文は改行を含むので、段落の中を探す。無ければ -1 である。 */
function inlineMathClose(text: string, start: number): number {
  // 1 文字ずつ進む走査なので、関数の中に閉じた可変の位置を使う。
  let cursor = start + 1;
  while (cursor < text.length && !text.startsWith("\n\n", cursor)) {
    if (text.charAt(cursor) === "$") return cursor;
    cursor += text.charAt(cursor) === "\\" ? 2 : 1;
  }
  return -1;
}

/** `index` から始まる、散文でない部分を返す。散文の文字なら undefined を返す。 */
function spanAt(text: string, index: number): Span | undefined {
  const char = text.charAt(index);
  if (isLineHead(text, index) && ESM_HEAD.test(text.slice(index, index + 7))) {
    return { start: index, end: esmEnd(text, index), kind: "hidden" };
  }
  if (isLineHead(text, index) && text.startsWith("```", index)) {
    return { start: index, end: closingIndex(text, "\n```", index), kind: "hidden" };
  }
  if (char === "\\") return { start: index, end: index + 2, kind: "keep" };
  if (char === "`") {
    return { start: index, end: closingIndex(text, "`", index + 1), kind: "hidden" };
  }
  if (text.startsWith("$$", index)) {
    return { start: index, end: closingIndex(text, "$$", index + 2), kind: "math" };
  }
  if (char === "$") {
    const close = inlineMathClose(text, index);
    return close === -1 ? undefined : { start: index, end: close + 1, kind: "math" };
  }
  if (char === "<" && /[A-Za-z/]/u.test(text.charAt(index + 1))) {
    return { start: index, end: tagEnd(text, index), kind: "hidden" };
  }
  if (char === "{") return { start: index, end: expressionEnd(text, index), kind: "hidden" };
  return undefined;
}

function scan(text: string): readonly Span[] {
  const frontmatter = FRONTMATTER.exec(text)?.[0].length ?? 0;
  // 章の全文を 1 文字ずつ進むので、作り直すと遅い。可変の配列と位置は関数の外へ出さない。
  const spans: Span[] = frontmatter > 0 ? [{ start: 0, end: frontmatter, kind: "hidden" }] : [];
  let cursor = frontmatter;
  while (cursor < text.length) {
    const span = spanAt(text, cursor);
    if (span !== undefined) spans.push(span);
    cursor = span?.end ?? cursor + 1;
  }
  return spans;
}

const newlines = (segment: string): string => segment.replaceAll(/[^\n]/gu, "");

const countNewlines = (segment: string): number => newlines(segment).length;

const replacement = (segment: string, kind: Span["kind"]): string => {
  if (kind === "keep") return segment;
  return `${kind === "math" ? MATH_MARK : ""}${newlines(segment)}`;
};

/** リンクを表示の文字列だけにし、脚注の印を除く。 */
const cleanLine = (line: string): string =>
  line
    .replace(/^\[\^[^\]]+\]:/u, "")
    .replaceAll(/\[\^[^\]]+\]/gu, "")
    .replaceAll(/\[(?<label>[^\]]*)\]\([^)]*\)/gu, "$<label>");

/** 数式の部分を行番号つきで取り出す。全文の先頭から数え直すと遅いので、前の位置からの差分を数える。 */
function mathSpans(text: string, spans: readonly Span[]): readonly MathSpan[] {
  const found: MathSpan[] = [];
  let line = 1;
  let position = 0;
  for (const span of spans) {
    line += countNewlines(text.slice(position, span.start));
    position = span.start;
    if (span.kind === "math") found.push({ line, tex: text.slice(span.start, span.end) });
  }
  return found;
}

/** 章のファイルの全文を、散文の行と数式へ分ける。 */
export function parseBody(text: string): Body {
  const spans = scan(text);
  const prose = spans.flatMap((span, index) => [
    text.slice(spans[index - 1]?.end ?? 0, span.start),
    replacement(text.slice(span.start, span.end), span.kind),
  ]);
  const joined = [...prose, text.slice(spans.at(-1)?.end ?? 0)].join("");
  return {
    lines: joined.split("\n").map((line) => cleanLine(line)),
    math: mathSpans(text, spans),
  };
}
