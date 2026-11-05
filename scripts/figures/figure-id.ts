// 図の番号と、ビルド結果の HTML から図を切り出す処理。ブラウザを使わない純粋な関数だけを置く。
//
// 図は 2 系列で数える。figure 要素の番号は章のキャプション「図 N」と一致するので、figure の外の図
// （キャプションが無い SVG）を混ぜるとずれる。figure の外の図は、別の系列 s1, s2, ... で数える。

/** 図の番号。数は figure 要素の順、`s1` の形は figure の外の図の順である。どちらも 1 始まりである。 */
export type FigureId = number | `s${number}`;

/** figure の外の図の `n` 番目（1 始まり）の番号を返す。 */
export const standaloneId = (n: number): FigureId => `s${n}`;

/** 2 系列の枚数から、figure → figure の外の順に番号の並びを返す。 */
export function figureIds(figures: number, standalone: number): readonly FigureId[] {
  return [
    ...Array.from({ length: figures }, (_, i) => i + 1),
    ...Array.from({ length: standalone }, (_, i) => standaloneId(i + 1)),
  ];
}

const seriesNumber = (id: FigureId): number => (typeof id === "number" ? id : Number(id.slice(1)));

/** 番号の順序。figure の系列を先に、それぞれの系列は番号の順に並べる。 */
export function compareFigureIds(a: FigureId, b: FigureId): number {
  if (typeof a !== typeof b) return typeof a === "number" ? -1 : 1;
  return seriesNumber(a) - seriesNumber(b);
}

/** 図の番号の、ファイル名に使う部分（`fig-03`・`fig-s03`）を返す。 */
export function figureFileStem(id: FigureId): string {
  const series = typeof id === "number" ? "" : "s";
  return `fig-${series}${String(seriesNumber(id)).padStart(2, "0")}`;
}

/** "3"・"s2" を図の番号に解析する。図の番号でなければ null を返す。 */
export function parseFigureId(text: string): FigureId | null {
  const matched = /^(s?)([1-9]\d*)$/.exec(text.trim());
  if (matched === null) return null;
  const n = Number(matched[2]);
  return matched[1] === "s" ? standaloneId(n) : n;
}

/** ページの図の HTML。 */
export type PageFigures = Readonly<{ figures: readonly string[]; standalone: readonly string[] }>;

type Span = Readonly<{ start: number; end: number }>;

/** HTML の位置の範囲の集まりと、開いたままの範囲の添字の積み上げ。 */
type SpanStack = Readonly<{ spans: readonly Span[]; open: readonly number[] }>;

const EMPTY_STACK: SpanStack = { spans: [], open: [] };

/** 記事本文の div の終わりの位置を、div の入れ子の深さを数えて求める。 */
function contentEnd(html: string, start: number): number {
  const tokens = [...html.slice(start).matchAll(/<div\b[^>]*>|<\/div>/g)];
  const found = tokens.reduce<Readonly<{ depth: number; end: number | null }>>(
    (acc, m) => {
      if (acc.end !== null) return acc;
      const depth = acc.depth + (m[0].startsWith("</") ? -1 : 1);
      return { depth, end: depth === 0 ? start + m.index + m[0].length : null };
    },
    { depth: 0, end: null },
  );
  return found.end ?? html.length;
}

const openSpan = (stack: SpanStack, start: number, end: number): SpanStack => ({
  spans: [...stack.spans, { start, end }],
  open: [...stack.open, stack.spans.length],
});

function closeSpan(stack: SpanStack, end: number): SpanStack {
  const top = stack.open.at(-1);
  if (top === undefined) return stack;
  return {
    spans: stack.spans.map((s, i) => (i === top ? { ...s, end } : s)),
    open: stack.open.slice(0, -1),
  };
}

/** figure の範囲を、入れ子も数えて開始タグの順に返す。 */
function figureSpans(body: string): readonly Span[] {
  const tokens = [...body.matchAll(/<figure\b[^>]*>|<\/figure>/g)];
  return tokens.reduce<SpanStack>(
    (stack, m) =>
      m[0].startsWith("</")
        ? closeSpan(stack, m.index + m[0].length)
        : openSpan(stack, m.index, body.length),
    EMPTY_STACK,
  ).spans;
}

/**
 * figure の外の図 SVG の範囲を返す。
 *
 * 図 SVG は `role="img"` を持つ。凡例の見本は `aria-hidden` なので含まない。svg の入れ子を数えるのは、
 * ラベルの KaTeX が図 SVG の中に svg を持つからである。
 */
function standaloneSpans(body: string, figures: readonly Span[]): readonly Span[] {
  const inFigure = (index: number): boolean =>
    figures.some((f) => f.start <= index && index < f.end);
  const tokens = [...body.matchAll(/<svg\b[^>]*>|<\/svg>/g)].filter((m) => !inFigure(m.index));
  const walked = tokens.reduce<Readonly<{ depth: number; inImage: boolean; stack: SpanStack }>>(
    (acc, m) => {
      if (m[0].startsWith("</")) {
        const depth = acc.depth - 1;
        if (depth > 0) return { ...acc, depth };
        const stack = acc.inImage ? closeSpan(acc.stack, m.index + m[0].length) : acc.stack;
        return { depth, inImage: false, stack };
      }
      if (acc.depth > 0) return { ...acc, depth: acc.depth + 1 };
      const inImage = /\brole="img"/.test(m[0]);
      return {
        depth: 1,
        inImage,
        stack: inImage ? openSpan(acc.stack, m.index, body.length) : acc.stack,
      };
    },
    { depth: 0, inImage: false, stack: EMPTY_STACK },
  );
  return walked.stack.spans;
}

/**
 * 記事本文の図の HTML を、系列ごとに文書の順に返す。
 *
 * 番号をブラウザの `.sl-markdown-content figure`（入れ子も数える文書順）とそろえるため、開始タグの順に
 * 並べ、入れ子は対応する終了タグまでを 1 つの図として切り出す。
 */
export function extractFigures(html: string): PageFigures {
  const start = html.search(/<div\b[^>]*\bclass="[^"]*\bsl-markdown-content\b[^"]*"[^>]*>/);
  if (start < 0) return { figures: [], standalone: [] };
  const body = html.slice(start, contentEnd(html, start));
  const figures = figureSpans(body);
  return {
    figures: figures.map((s) => body.slice(s.start, s.end)),
    standalone: standaloneSpans(body, figures).map((s) => body.slice(s.start, s.end)),
  };
}
