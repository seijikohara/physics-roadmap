// 図のラベルの幅・高さを、DOM を使わずにビルド時に見積もる。
//
// 数式は KaTeX の内部 API（__renderToHTMLTree）が返す組版の木をたどり、katex.css が決める横の並びを
// なぞって幅を足し合わせる。地の文は本文フォント（欧文 Latin Modern Roman 10・和文 Noto Serif JP）の
// 送り幅で数える。内部 API の木の形は版で変わりうるため、package.json で katex の版を固定している。
// 版を上げたら `pnpm run figures:widths` で実測との誤差を測り直す。

import {
  __domTree,
  __renderToHTMLTree,
  type KatexCssStyle,
  type KatexHtmlNode,
  type KatexSpanNode,
  type KatexSymbolNode,
  type KatexTreeOptions,
} from "katex";

/** ラベルの寸法（SVG の px）。height は基線より上、depth は基線より下の長さ。 */
export type LabelSize = Readonly<{
  width: number;
  height: number;
  depth: number;
  /** 組版の木に知らない節点があり、幅を旧来の字数による見積もりで代用したか。 */
  approximate: boolean;
}>;

/**
 * 数式の字の大きさの、外側の字の大きさに対する倍率。katex.css の `.katex { font: normal 1.21em ... }`
 * が数式全体を 1.21 倍にする。KatexLabel の fontSize は外側の div の font-size なので、数式の 1em は
 * fontSize × 1.21 px になる。
 */
export const KATEX_FONT_SCALE = 1.21;

/**
 * 見積もりの幅に足す安全の余白（px）。字ごとの係数に余白を含めると長いラベルほど過大になるため、
 * 最後にまとめて足す。短いラベルでも 1px は空け、長いラベルは幅の 3% を空ける。
 */
export function labelWidthMargin(width: number): number {
  return Math.max(1, width * 0.03);
}

// KatexLabel・FlowChart の renderToString と同じ設定で組版する。strict は警告を出すかどうかだけを
// 変え、組版は変えない。同じ式の警告が renderToString と二重に出ないよう、ここでは出さない。
const RENDER_OPTIONS: KatexTreeOptions = {
  displayMode: false,
  throwOnError: false,
  trust: false,
  output: "html",
  strict: "ignore",
};

/** KaTeX が vlist の行の高さをそろえるために置く、幅 0 の空白。 */
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

// ======================================================================
// 数式
// ======================================================================

/**
 * 数式の幅・高さ・深さを見積もる。fontSize は KatexLabel の fontSize（外側の div の font-size）で、
 * 数式はその 1.21 倍（KATEX_FONT_SCALE）の大きさで組まれる。安全の余白は足さない。
 */
export function measureTex(tex: string, fontSize: number): LabelSize {
  const tree = __renderToHTMLTree(tex, RENDER_OPTIONS);
  const em = fontSize * KATEX_FONT_SCALE;
  const extent = nodeExtent(tree);
  const fullWidth = Array.from(tex).some(isFullWidth);
  return {
    width: extent.known ? extent.width * em : legacyTexWidth(tex, fontSize),
    height: Math.max(tree.height, fullWidth ? FULL_WIDTH_HEIGHT : 0) * em,
    depth: Math.max(tree.depth, fullWidth ? FULL_WIDTH_DEPTH : 0) * em,
    approximate: !extent.known,
  };
}

// 全角の字の、基線より上と下の長さ（数式の 1em を単位とする）。KaTeX は全角の字の寸法に 'M' の値を
// 代用する（高さ 0.683em・深さ 0）が、実際に描く Noto Serif JP の字形は基線より下へも沈む。値は Chrome
// で測った字形の範囲である。
const FULL_WIDTH_HEIGHT = 0.8;
const FULL_WIDTH_DEPTH = 0.13;

/**
 * 節点の横幅と、知らない節点を含まずに求まったか。幅は、節点を置く親の字の大きさの 1em を単位とする
 * （木の根では数式の 1em）。
 */
type Extent = Readonly<{ width: number; known: boolean }>;

const UNKNOWN: Extent = { width: 0, known: false };
const ZERO: Extent = { width: 0, known: true };

const sumOf = (list: readonly Extent[]): Extent =>
  list.reduce((a, c) => ({ width: a.width + c.width, known: a.known && c.known }), ZERO);
// 縦に積む箱の幅は、子の幅の最大で決まる。負の margin で幅が負になった子は 0 とみなす。
const maxOf = (list: readonly Extent[]): Extent =>
  list.reduce((a, c) => ({ width: Math.max(a.width, c.width), known: a.known && c.known }), ZERO);

/** 節点の幅。 */
function nodeExtent(node: KatexHtmlNode): Extent {
  if (node instanceof __domTree.SymbolNode) return symbolExtent(node);
  if (node instanceof __domTree.Span || node instanceof __domTree.Anchor) return spanExtent(node);
  // SVG（根号・矢印・積分の丸など）の幅は、包む span の style（width・min-width）が決める。
  const svgClasses = [__domTree.SvgNode, __domTree.PathNode, __domTree.LineNode];
  if (svgClasses.some((c) => node instanceof c)) return ZERO;
  return UNKNOWN;
}

/** KaTeX の字の大きさの段（size1〜size11）の倍率（KaTeX の sizingMultiplier）。 */
const SIZE_MULTIPLIERS: readonly number[] = [
  0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.2, 1.44, 1.728, 2.074, 2.488,
];

/**
 * span の字の大きさの、親の字の大きさに対する倍率。`sizing reset-sizeN sizeM`（と
 * fontsize-ensurer）の span は、段 M と段 N の倍率の比を font-size にする（katex.css）。
 */
function sizingFactor(classes: readonly string[]): number {
  if (!classes.includes("sizing") && !classes.includes("fontsize-ensurer")) return 1;
  // 接頭辞の後に段の番号が続くクラス（reset-size6・size3 など）から、段の倍率を引く。
  const level = (prefix: string): number | undefined => {
    const name = classes.find((c) => c.startsWith(prefix) && /^\d+$/.test(c.slice(prefix.length)));
    return name === undefined ? undefined : SIZE_MULTIPLIERS[Number(name.slice(prefix.length)) - 1];
  };
  const from = level("reset-size");
  const to = level("size");
  return from === undefined || to === undefined ? 1 : to / from;
}

/**
 * katex.css が幅を決め、子の幅を数えないクラスと、その幅（em）。
 * - nulldelimiter: 空の区切り記号（分数の左右）。幅 0.12em。
 * - strut・pstrut: 高さをそろえる支柱。幅 0。
 * - vlist-s: 幅 2px の列。親の .vlist-t2 の margin-right: -2px と打ち消し合うので 0 とする。
 * - llap・rlap・clap・thinbox: 幅 0 の箱（中身ははみ出して描く）。
 */
const FIXED_WIDTH_CLASSES: ReadonlyMap<string, number> = new Map([
  ["nulldelimiter", 0.12],
  ["strut", 0],
  ["pstrut", 0],
  ["vlist-s", 0],
  ["llap", 0],
  ["rlap", 0],
  ["clap", 0],
  ["thinbox", 0],
]);

/**
 * 幅を親に合わせて伸ばす（width: 100%）クラス。兄弟の幅に従うので、自身は min-width だけを数える。
 * 分数の横線、上線・下線、伸縮する矢印、根号の SVG を包む hide-tail などである。
 */
const FULL_WIDTH_CLASSES: ReadonlySet<string> = new Set([
  "frac-line",
  "overline-line",
  "underline-line",
  "hline",
  "hdashline",
  "stretchy",
  "hide-tail",
  "halfarrow-left",
  "halfarrow-right",
  "brace-left",
  "brace-center",
  "brace-right",
]);

/** katex.css が左右に padding・margin を付けるクラスと、その左右の合計（em）。 */
const CLASS_SIDE_SPACE: ReadonlyMap<string, number> = new Map([
  // padding: 0 0.5em
  ["x-arrow-pad", 1],
  // padding: 0 0.3em
  ["boxpad", 0.6],
  // padding: 0 0.2em
  ["cancel-pad", 0.4],
  // margin-left・margin-right: -0.2em
  ["cancel-lap", -0.4],
  // padding: 0 0.03889em
  ["anglpad", 0.07778],
  // .sqrt > .root の margin-left: 0.2777777778em と margin-right: -0.5555555556em
  ["root", 0.2777777778 - 0.5555555556],
]);

/**
 * 横の並びをなぞるだけでは幅が求まらないクラス。改行（newline）、組版の失敗（katex-error）、
 * 表（mtable）の列の割り付けである。含めば旧来の見積もりで代用する。
 */
const UNSUPPORTED_CLASSES: ReadonlySet<string> = new Set(["newline", "katex-error", "mtable"]);

/** 子を縦に積む（幅が子の最大になる）クラス。KaTeX の vlist の表と列である。 */
const STACK_CLASSES: ReadonlySet<string> = new Set(["vlist", "vlist-t"]);

/** 幅の固定されたアクセント（\vec の矢印・\hat など）の記号を包む span か。 */
const isFixedAccent = (node: KatexHtmlNode): node is KatexSpanNode =>
  node instanceof __domTree.Span &&
  node.classes.includes("accent-body") &&
  !node.classes.includes("accent-full");

/**
 * 縦に積む子の幅。幅の固定されたアクセントの行は、自身の幅を 0 として積み（katex.css）、記号を
 * 土台の中央から style.left だけずらして描く。記号が土台より広いと（\vec{i} の矢印など）、字形は
 * 土台の外へはみ出す。はみ出しも図の上では字形の一部なので、幅に含める。
 */
function stackExtent(children: readonly KatexHtmlNode[]): Extent {
  const accents = children.flatMap((row) => (row.children ?? []).filter(isFixedAccent));
  const base = maxOf(
    children.filter((row) => !(row.children ?? []).some(isFixedAccent)).map(nodeExtent),
  );
  const edges = accents.map((accent) => {
    const left = emOf(accent.style.left);
    const symbol = sumOf(accent.children.map(nodeExtent));
    const from = base.width / 2 + (left ?? 0);
    return { from, to: from + symbol.width, known: symbol.known && left !== null };
  });
  return {
    width:
      edges.reduce((r, e) => Math.max(r, e.to), base.width) -
      edges.reduce((l, e) => Math.min(l, e.from), 0),
    known: base.known && edges.every((e) => e.known),
  };
}

function spanExtent(span: KatexSpanNode): Extent {
  const { classes } = span;
  if (classes.some((c) => UNSUPPORTED_CLASSES.has(c))) return UNKNOWN;
  const style = styleOf(span.style);
  if (style === null) return UNKNOWN;
  const fixed = classes.map((c) => FIXED_WIDTH_CLASSES.get(c)).find((w) => w !== undefined);
  // .accent-body は、幅の固定された記号（\vec の矢印など）のときだけ width: 0 になる。
  const zeroAccent = classes.includes("accent-body") && !classes.includes("accent-full");
  const content = ((): Extent => {
    if (fixed !== undefined) return { width: fixed, known: true };
    if (zeroAccent || classes.some((c) => FULL_WIDTH_CLASSES.has(c))) return ZERO;
    return classes.some((c) => STACK_CLASSES.has(c))
      ? stackExtent(span.children)
      : sumOf(span.children.map(nodeExtent));
  })();
  const sideSpace = classes.reduce((sum, c) => sum + (CLASS_SIDE_SPACE.get(c) ?? 0), 0);
  // style の長さ（em）と子の幅は、この span 自身の字の大きさを単位とする。
  const box = Math.max(style.width ?? content.width, style.minWidth ?? 0);
  return {
    width: Math.max(0, box + style.sides + sideSpace) * sizingFactor(classes),
    known: content.known,
  };
}

/** 幅にかかわる inline style の値（em）。sides は左右の margin と padding の合計。 */
type WidthStyle = Readonly<{ sides: number; width?: number; minWidth?: number }>;

/** 幅にかかわる style のキー。 */
const SIDE_KEYS = ["marginLeft", "marginRight", "paddingLeft", "paddingRight"] as const;

/** CSS の長さ（"0.2222em"）を em の数にする。em 以外の単位は扱わず null を返す。 */
function emOf(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  const m = /^(-?(?:\d+\.?\d*|\.\d+))em$/.exec(value);
  return m === null ? null : Number(m[1]);
}

/** inline style から幅にかかわる値を取り出す。em 以外の長さがあれば null を返す。 */
function styleOf(style: KatexCssStyle): WidthStyle | null {
  const sides = SIDE_KEYS.map((k) => emOf(style[k]));
  const width = emOf(style.width);
  const minWidth = emOf(style.minWidth);
  if (sides.includes(null) || width === null || minWidth === null) return null;
  return {
    sides: sides.reduce<number>((sum, v) => sum + (v ?? 0), 0),
    ...(width === undefined ? {} : { width }),
    ...(minWidth === undefined ? {} : { minWidth }),
  };
}

/**
 * 字の並びの幅。KaTeX は同じクラスの字を 1 つの節点にまとめるが、width は先頭の字の送り幅のまま
 * にする。2 字目以降は、同じ書体で 1 字ずつ組版して送り幅を求める。最後の字のイタリック補正は
 * margin-right として描かれる（正のときだけ）。
 */
function symbolExtent(node: KatexSymbolNode): Extent {
  const [first, ...rest] = Array.from(node.text).filter((ch) => ch !== ZERO_WIDTH_SPACE);
  if (first === undefined) return ZERO;
  const style = styleOf(node.style);
  // 字形を持つのに送り幅が 0 の字は、KaTeX が字の寸法を持たない字である。
  if (style === null || (!isFullWidth(first) && node.width === 0)) return UNKNOWN;
  const widths = [
    isFullWidth(first) ? 1 : (correctedWidth(node.classes, first) ?? node.width),
    ...rest.map((ch) => (isFullWidth(ch) ? 1 : sameFontWidth(node.classes, ch))),
  ];
  if (widths.includes(null)) return UNKNOWN;
  const advance = widths.reduce<number>((sum, w) => sum + (w ?? 0), 0);
  // \large・\scriptstyle などの中身では、KaTeX が sizing のクラスを字の節点にも直接付ける。字の寸法は
  // 字自身の大きさの em なので、span と同じく倍率を掛けて親の em に直す。
  return {
    width: (advance + Math.max(node.italic, 0) + style.sides) * sizingFactor(node.classes),
    known: true,
  };
}

// ======================================================================
// 字の送り幅
// ======================================================================

/**
 * 全角の字か（東アジアの文字幅が W・F の主な範囲）。KaTeX は CJK の字の寸法に 'M' の値を代用するが、
 * 実際には .cjk_fallback と本文の地の文が Noto Serif JP で描くので、1 字 1em になる。
 */
export function isFullWidth(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return FULL_WIDTH_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

const FULL_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  // ハングルの字母
  [0x1100, 0x115f],
  // CJK の部首・康熙部首・記号と句読点（全角の空白・句読点・括弧）
  [0x2e80, 0x303e],
  // ひらがな・カタカナ・注音・ハングルの互換字母・漢文・CJK の画・囲み CJK・CJK 互換
  [0x3041, 0x33ff],
  // CJK 統合漢字の拡張 A
  [0x3400, 0x4dbf],
  // CJK 統合漢字
  [0x4e00, 0x9fff],
  // 彝文字
  [0xa000, 0xa4cf],
  // ハングルの音節
  [0xac00, 0xd7a3],
  // CJK 互換漢字
  [0xf900, 0xfaff],
  // CJK 互換形
  [0xfe30, 0xfe4f],
  // 全角の英数字と記号
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  // CJK 統合漢字の拡張 B 以降
  [0x20000, 0x3fffd],
];

/** 数式の外で書いても KaTeX の書体の字として組める字の、TeX での書き方（\text{} の中）。 */
const TEXT_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["\\", "\\textbackslash{}"],
  ["{", "\\{"],
  ["}", "\\}"],
  ["$", "\\$"],
  ["&", "\\&"],
  ["#", "\\#"],
  ["^", "\\textasciicircum{}"],
  ["_", "\\_"],
  ["%", "\\%"],
  ["~", "\\textasciitilde{}"],
  [" ", "\\ "],
]);

/** 数式の中での特殊文字の書き方。 */
const MATH_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["\\", "\\backslash"],
  ["{", "\\{"],
  ["}", "\\}"],
  ["$", "\\$"],
  ["&", "\\&"],
  ["#", "\\#"],
  ["_", "\\_"],
  ["%", "\\%"],
]);

/** 数式の書体を選ぶクラス（KaTeX の fontMap の名前と \boldsymbol）。同名の命令で 1 字を組める。 */
const MATH_FONT_CLASSES: readonly string[] = [
  "mathnormal",
  "mathrm",
  "mathbf",
  "mathit",
  "mathbb",
  "mathcal",
  "mathfrak",
  "mathscr",
  "mathsf",
  "mathtt",
  "mathsfit",
  "boldsymbol",
];

/**
 * 原子の種類・字の大きさ・用字系を表すクラス。書体の比較では無視する。字の大きさ（sizing の
 * クラス）は、1 字ずつ組んだ送り幅に symbolExtent が倍率を掛けて合わせる。
 */
const NON_FONT_CLASS =
  /^(?:m(?:ord|op|bin|rel|open|close|punct|inner)|mtight|sizing|(?:reset-)?size\d+|.*_fallback)?$/;

/** 書体を表すクラスだけを並べた文字列。 */
const fontSignature = (classes: readonly string[]): string =>
  classes
    .filter((c) => !NON_FONT_CLASS.test(c))
    .toSorted()
    .join(" ");

/** 字を 1 つ組版する TeX の候補。節点のクラスが示す書体で組む候補を先に置く。 */
function probeTexts(classes: readonly string[], ch: string): readonly string[] {
  const math = MATH_ESCAPES.get(ch) ?? ch;
  const mathFont = MATH_FONT_CLASSES.find((c) => classes.includes(c));
  if (mathFont !== undefined) return [`\\${mathFont}{${math}}`];
  const text = TEXT_ESCAPES.get(ch) ?? ch;
  const shaped = classes.includes("textit") ? `\\textit{${text}}` : text;
  const weighted = classes.includes("textbf") ? `\\textbf{${shaped}}` : shaped;
  const family = ["textsf", "texttt"].find((c) => classes.includes(c)) ?? "text";
  return [`\\${family}{${weighted}}`, `\\mathrm{${math}}`, math];
}

/** 木の中の字の並び（vlist の幅 0 の空白を除く）。 */
const symbolsOf = (node: KatexHtmlNode): readonly KatexSymbolNode[] =>
  node instanceof __domTree.SymbolNode
    ? node.text === ZERO_WIDTH_SPACE
      ? []
      : [node]
    : (node.children ?? []).flatMap(symbolsOf);

/**
 * KaTeX の字の寸法の表（fontMetricsData）が、フォントの送り幅と食い違う字。キーは書体を示すクラス
 * （空文字列は書体のクラスの無い KaTeX_Main-Regular）、値は字ごとの送り幅（em）である。値は katex
 * 0.17.0 の dist/fonts の TTF の hmtx から読んだ。表は \iint・\iiint の記号に \int の寸法を当てて
 * いるため、二重・三重の積分記号の幅を 1 字ぶん以上小さく見積もる。
 */
const METRIC_CORRECTIONS: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map([
  // KaTeX_Size1（文中の大きさの積分記号）
  [
    "small-op",
    new Map([
      ["∬", 0.819],
      ["∭", 1.166],
    ]),
  ],
  // KaTeX_Size2（別行立ての大きさの積分記号）
  [
    "large-op",
    new Map([
      ["∬", 1.084],
      ["∭", 1.592],
    ]),
  ],
  // KaTeX_Main-Regular の度の記号
  ["", new Map([["°", 0.5]])],
]);

/** METRIC_CORRECTIONS に載る字なら、フォントの送り幅（em）を返す。 */
function correctedWidth(classes: readonly string[], ch: string): number | undefined {
  const key = ["small-op", "large-op"].find((c) => classes.includes(c)) ?? fontSignature(classes);
  return METRIC_CORRECTIONS.get(key)?.get(ch);
}

/** 字 ch を、classes が示す書体で組んだときの送り幅（em）。求まらなければ null。 */
function sameFontWidth(classes: readonly string[], ch: string): number | null {
  const corrected = correctedWidth(classes, ch);
  if (corrected !== undefined) return corrected;
  const signature = fontSignature(classes);
  // KaTeX は寸法の表に無い字（θ・² など）も幅 0 の節点として組む。幅 0 は「求まらない」として扱い、
  // 呼ぶ側の代わりの見積もり（地の文は 1em、数式は旧来の見積もり）に回す。
  const found = probeTexts(classes, ch)
    .map((tex) => symbolsOf(__renderToHTMLTree(tex, RENDER_OPTIONS)))
    .find(
      (list) =>
        list.length === 1 &&
        list[0]?.text === ch &&
        list[0].width > 0 &&
        fontSignature(list[0].classes) === signature,
    );
  return found?.[0]?.width ?? null;
}

// ======================================================================
// 地の文
// ======================================================================

/**
 * 本文の欧文フォント Latin Modern Roman 10 の送り幅が、KaTeX_Main（cmr10）と違う ASCII の字（em）。
 * 値は src/fonts/lmroman10-regular.woff2 の hmtx から読んだ。cmr10 は語間を字ではなくフォントの
 * 寸法（1/3em）で空けるため、KaTeX_Main の空白は 0.25em と狭い。Latin Modern Roman 10 は語間を
 * 空白の字の送り幅（0.333em）として持つ。
 */
const LATIN_MODERN_WIDTHS: ReadonlyMap<string, number> = new Map([
  [" ", 0.333],
  ['"', 0.374],
  ["^", 0.556],
  ["_", 0.75],
  ["`", 0.5],
  ["~", 0.556],
]);

/**
 * 印字できる ASCII の字（空白から ~ まで）の、本文の欧文フォントでの送り幅（em）。Latin Modern Roman
 * 10 は cmr10 と送り幅をそろえた設計なので、LATIN_MODERN_WIDTHS の字を除き、KaTeX_Main の値を使う。
 * モジュールの読み込み時に 1 回だけ、\text{} で 1 字ずつ組版して作る。
 */
const ASCII_WIDTHS: ReadonlyMap<string, number> = new Map(
  Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCodePoint(0x20 + i)).flatMap((ch) => {
    const lm = LATIN_MODERN_WIDTHS.get(ch);
    if (lm !== undefined) return [[ch, lm] as const];
    // KaTeX は \text{} の中の ' と ` を ’ と ‘ に替えるため、字の一致は確かめない。
    const list = symbolsOf(
      __renderToHTMLTree(`\\text{${TEXT_ESCAPES.get(ch) ?? ch}}`, RENDER_OPTIONS),
    );
    const only = list[0];
    return list.length === 1 && only !== undefined ? [[ch, only.width] as const] : [];
  }),
);

/** 地の文の 1 字の送り幅（em）。全角は 1em、KaTeX_Main に無い字も 1em とする。 */
function textCharWidth(ch: string): number {
  if (isFullWidth(ch)) return 1;
  return ASCII_WIDTHS.get(ch) ?? sameFontWidth([], ch) ?? 1;
}

/**
 * 地の文（数式の外の文字列）の幅（px）。fontSize は外側の要素の font-size で、数式と違い 1.21 倍
 * しない。HTML の空白の詰め（連続する空白を 1 つにする）は、呼ぶ側で済ませておく。
 */
export function measureText(text: string, fontSize: number): number {
  return Array.from(text).reduce((w, ch) => w + textCharWidth(ch) * fontSize, 0);
}

// ======================================================================
// FlowChart の書式のラベル
// ======================================================================

/**
 * 改行を `\n`、数式を `$...$` で表すラベル（FlowChart の書式）の幅と高さ（px）を見積もる。
 * 幅は行ごとの幅（数式は measureTex、地の文は measureText の和）の最大である。高さは行ごとの
 * max(lineHeight, 数式の height + depth) の和である。地の文の空白は HTML と同じく、連続を 1 つに
 * 詰め、行の両端では除く。安全の余白は足さない。
 */
export function measureLabel(
  label: string,
  fontSize: number,
  lineHeight: number,
): Readonly<{ width: number; height: number; approximate: boolean }> {
  const lines = label.split("\n").map((line) => measureLine(line, fontSize, lineHeight));
  return {
    width: lines.reduce((w, l) => Math.max(w, l.width), 0),
    height: lines.reduce((h, l) => h + l.height, 0),
    approximate: lines.some((l) => l.approximate),
  };
}

function measureLine(
  line: string,
  fontSize: number,
  lineHeight: number,
): Readonly<{ width: number; height: number; approximate: boolean }> {
  const segments = line.split(/(\$[^$]*\$)/g).filter((seg) => seg.length > 0);
  const last = segments.length - 1;
  const sizes = segments.map((seg, i) => {
    if (seg.length >= 2 && seg.startsWith("$") && seg.endsWith("$")) {
      const m = measureTex(seg.slice(1, -1), fontSize);
      return { width: m.width, height: m.height + m.depth, approximate: m.approximate };
    }
    const collapsed = seg.replace(/\s+/g, " ");
    const trimmed = i === 0 ? collapsed.trimStart() : collapsed;
    const text = i === last ? trimmed.trimEnd() : trimmed;
    return { width: measureText(text, fontSize), height: 0, approximate: false };
  });
  return {
    width: sizes.reduce((w, s) => w + s.width, 0),
    height: sizes.reduce((h, s) => Math.max(h, s.height), lineHeight),
    approximate: sizes.some((s) => s.approximate),
  };
}

// ======================================================================
// 旧来の見積もり（組版の木に知らない節点があるときの代わり）
// ======================================================================

// 以下は ContourPlot・FunctionGraph の estimateTexWidthPrecise と同じ内容である。字を数えて
// 1 字 0.72em とし、安全側に広めに取る。

/** 字形を持たず、引数の中身だけが幅を持つ組版コマンド（\mathrm{A} は A の幅になる）。 */
const LAYOUT_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "mathrm",
  "mathit",
  "mathbf",
  "mathsf",
  "mathcal",
  "mathbb",
  "text",
  "operatorname",
  "boldsymbol",
  "vec",
  "overline",
  "overrightarrow",
  "hat",
  "bar",
  "tilde",
  "dot",
  "left",
  "right",
  "displaystyle",
  "textstyle",
  "frac",
  "dfrac",
  "tfrac",
]);

/** コマンド名の綴りがそのまま立体で描かれる演算子名（\sin は sin の 3 字）。 */
const OPERATOR_NAMES: ReadonlySet<string> = new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "log",
  "ln",
  "exp",
  "lim",
  "max",
  "min",
  "sup",
  "inf",
  "det",
  "arg",
]);

/** 前後に広い空きが入る関係記号のコマンド名。 */
const RELATION_COMMANDS: ReadonlySet<string> = new Set([
  "le",
  "ge",
  "leq",
  "geq",
  "neq",
  "ne",
  "approx",
  "to",
  "equiv",
]);

/** 前後に空きが入る二項演算子のコマンド名。 */
const BINARY_COMMANDS: ReadonlySet<string> = new Set(["times", "cdot", "pm", "mp", "div"]);

/** LaTeX 文字列の表示幅を、字を数えて見積もる（px）。 */
function legacyTexWidth(tex: string, fontSize: number): number {
  // 字を先頭から順に数える。afterOperand は直前が被演算子（文字・数字・閉じ括弧など）か。
  const { units } = [...tex.matchAll(/\\([a-zA-Z]+)|\\[^a-zA-Z]|[^{}^_$\s]/g)].reduce<
    Readonly<{ units: number; afterOperand: boolean }>
  >(
    (st, m) => {
      const name = m[1];
      if (name !== undefined) {
        if (LAYOUT_ONLY_COMMANDS.has(name)) return st;
        if (RELATION_COMMANDS.has(name) || BINARY_COMMANDS.has(name)) {
          return { units: st.units + 2, afterOperand: false };
        }
        return {
          units: st.units + (OPERATOR_NAMES.has(name) ? name.length : 1),
          afterOperand: true,
        };
      }
      const ch = m[0];
      if (ch.startsWith("\\")) {
        return "{}|".includes(ch[1]) ? { units: st.units + 1, afterOperand: ch[1] !== "{" } : st;
      }
      if (ch === "=" || ch === "<" || ch === ">")
        return { units: st.units + 2, afterOperand: false };
      if (ch === "+" || ch === "-") {
        return { units: st.units + (st.afterOperand ? 2 : 1), afterOperand: false };
      }
      return { units: st.units + 1, afterOperand: !"([,".includes(ch) };
    },
    { units: 0, afterOperand: false },
  );
  return Math.max(units * fontSize * 0.72, 24);
}
