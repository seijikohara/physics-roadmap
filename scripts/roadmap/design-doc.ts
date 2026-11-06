// 設計書（docs/roadmap-design.md）の章の表を読み、行の並びにする。DOM もファイルも使わない純粋な処理である。

/** 設計書の 1 行。行の順序が読む順序である。 */
export type Row = Readonly<{
  id: string;
  title: string;
  content: string;
  prereqs: readonly string[];
  /**
   * 行の内容を載せる章（`src/content/docs/` からの相対パス、拡張子なし）。未執筆なら空である。
   * 統合の前は 2 つのファイルが 1 行に、分割の前は 1 つのファイルが複数の行に対応する。
   */
  chapters: readonly string[];
  /** 本線に含まれない任意枠の行か。 */
  optional: boolean;
  /** カテゴリの ID 接頭辞（`M-CALC` など）。 */
  category: string;
}>;

const TABLE_HEADER = /^\|\s*ID\s*\|\s*タイトル\s*\|\s*扱う内容\s*\|\s*前提\s*\|\s*章\s*\|\s*$/u;
const CATEGORY_HEADING = /^### .*（(?<category>[A-Z-]+)）\s*$/u;
const OPTIONAL_HEADING = /^#### 任意枠\s*$/u;
const UNWRITTEN = "—";

const splitCells = (line: string): readonly string[] =>
  line
    .replace(/^\|/u, "")
    .replace(/\|\s*$/u, "")
    .split("|")
    .map((cell) => cell.trim());

const parseList = (cell: string): readonly string[] =>
  cell
    .split("、")
    .map((item) => item.trim())
    .filter((item) => item !== "" && item !== UNWRITTEN);

function parseRow(line: string, category: string, optional: boolean): Row {
  const cells = splitCells(line);
  if (cells.length !== 5) {
    throw new Error(`表の列の数が 5 でない行がある: ${line.slice(0, 60)}`);
  }
  const [id = "", title = "", content = "", prereqs = "", chapters = ""] = cells;
  return {
    id,
    title,
    content,
    prereqs: parseList(prereqs),
    chapters: parseList(chapters),
    optional,
    category,
  };
}

type Scan = Readonly<{
  rows: readonly Row[];
  category: string;
  optional: boolean;
  /** 章の表の中にいるか。 */
  inTable: boolean;
}>;

function step(scan: Scan, line: string): Scan {
  const heading = CATEGORY_HEADING.exec(line);
  if (heading !== null) {
    return { ...scan, category: heading.groups?.category ?? "", optional: false, inTable: false };
  }
  if (OPTIONAL_HEADING.test(line)) return { ...scan, optional: true, inTable: false };
  if (TABLE_HEADER.test(line)) return { ...scan, inTable: true };
  if (!scan.inTable) return scan;
  if (!line.startsWith("|")) return { ...scan, inTable: false };
  if (/^\|\s*-/u.test(line)) return scan;
  return { ...scan, rows: [...scan.rows, parseRow(line, scan.category, scan.optional)] };
}

/** 設計書の本文から、章の表の行を順に取り出す。 */
export function parseDesignDoc(text: string): readonly Row[] {
  return text
    .split("\n")
    .reduce<Scan>(step, { rows: [], category: "", optional: false, inTable: false }).rows;
}
