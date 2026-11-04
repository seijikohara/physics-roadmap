// 図のラベルの幅の見積もり（src/components/figure-label/measure.ts）を、ブラウザで測った字形の幅と
// 比べ、誤差を種類・部品ごとの表にする。

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  labelWidthMargin,
  measureLabel,
  measureText,
} from "../../src/components/figure-label/measure.ts";
import { UsageError, parseCli, parsePositive, runMain, writeJson } from "./lib.ts";

const USAGE = `使い方: pnpm run figures:widths -- <labels.json> [オプション]

<labels.json> は figures:lint の --labels の出力。各ラベルの幅を measure.ts で見積もり、
ブラウザで測った字形の幅（実測）と比べる。誤差は「実測 − 見積もり」（px、図 SVG の座標系）で、
正なら過小、負なら過大である。字形の幅は送り幅より狭いのがふつうなので、過大側に 1px 前後の
差が出るのは正常である。問題は過小側である。

オプション:
  --worst <N>     過小・過大の大きいラベルを N 件ずつ出す（同じ書式・大きさのラベルは 1 件にまとめる）
  --json <パス>   ラベルごとの見積もりと誤差、表の値を JSON で書き出す`;

const OPTIONS = {
  worst: { type: "string" },
  json: { type: "string" },
} as const;

/** figures:lint の --labels が書き出すラベル 1 件。 */
type MeasuredLabel = Readonly<{
  page: string;
  figure: number;
  svg: number;
  component: string;
  name: string;
  kind: "svg-text" | "katex" | "html";
  source: string;
  fontSize: number;
  width?: number;
}>;

/** 見積もりと誤差を添えたラベル。 */
type Compared = MeasuredLabel &
  Readonly<{
    actual: number;
    estimate: number;
    /** 実測 − 見積もり（px）。正なら過小。 */
    diff: number;
    /** 安全の余白を足した後の、実測 − 見積もり（px）。 */
    diffWithMargin: number;
    approximate: boolean;
  }>;

/** 表の 1 行。 */
type Row = Readonly<{
  group: string;
  count: number;
  underMax: number;
  underP95: number;
  overP95: number;
  approximate: number;
  underAfterMargin: number;
}>;

const isLabel = (v: unknown): v is MeasuredLabel =>
  typeof v === "object" &&
  v !== null &&
  "source" in v &&
  typeof v.source === "string" &&
  "kind" in v &&
  typeof v.kind === "string" &&
  "fontSize" in v &&
  typeof v.fontSize === "number";

/** --labels の JSON を読む。 */
function readLabels(file: string): readonly MeasuredLabel[] {
  const data = ((): unknown => {
    try {
      return JSON.parse(readFileSync(path.resolve(file), "utf8"));
    } catch (error) {
      throw new UsageError(
        `ラベルの JSON を読めない: ${file}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  })();
  const labels: unknown =
    typeof data === "object" && data !== null && "labels" in data ? data.labels : null;
  if (!Array.isArray(labels) || !labels.every(isLabel)) {
    throw new UsageError(
      `ラベルの JSON に kind・source を含む labels が無い（figures:lint の --labels の出力を指定する）: ${file}`,
    );
  }
  return labels;
}

/** ラベル 1 件を見積もり、実測と比べる。実測の幅が無いラベルは除く。 */
function compare(label: MeasuredLabel): readonly Compared[] {
  if (label.width === undefined) return [];
  const est =
    label.kind === "svg-text"
      ? { width: measureText(label.source, label.fontSize), approximate: false }
      : measureLabel(label.source, label.fontSize, 0);
  const diff = label.width - est.width;
  return [
    {
      ...label,
      actual: label.width,
      estimate: est.width,
      diff,
      diffWithMargin: diff - labelWidthMargin(est.width),
      approximate: est.approximate,
    },
  ];
}

/** 昇順に並べた値の p パーセンタイル（最近接順位法）。 */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

/** 誤差の表の 1 行を作る。 */
function rowOf(group: string, items: readonly Compared[]): Row {
  const under = items.map((c) => c.diff).toSorted((a, b) => a - b);
  const over = items.map((c) => -c.diff).toSorted((a, b) => a - b);
  return {
    group,
    count: items.length,
    underMax: under.at(-1) ?? 0,
    underP95: percentile(under, 95),
    overP95: percentile(over, 95),
    approximate: items.filter((c) => c.approximate).length,
    underAfterMargin: items.filter((c) => c.diffWithMargin > 0).length,
  };
}

const fixed = (v: number): string => v.toFixed(2);
const cell = (s: string): string => s.replaceAll("|", "\\|").replaceAll("\n", "⏎");

function rowTable(title: string, rows: readonly Row[]): readonly string[] {
  return [
    `## ${title}`,
    "",
    "| 区分 | 件数 | 過小の最大 | 過小の p95 | 過大の p95 | approximate | 余白後も過小 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(
      (r) =>
        `| ${r.group} | ${r.count} | ${fixed(r.underMax)} | ${fixed(r.underP95)} | ${fixed(r.overP95)} | ${r.approximate} | ${r.underAfterMargin} |`,
    ),
    "",
  ];
}

/** 誤差の大きいラベルの表。同じ種類・書式・大きさのラベルは、最初の 1 件だけを残す。 */
function worstTable(title: string, items: readonly Compared[], n: number): readonly string[] {
  const unique = [
    ...Map.groupBy(items, (c) => JSON.stringify([c.kind, c.source, c.fontSize])).values(),
  ].flatMap((group) => group.slice(0, 1));
  return [
    `## ${title}`,
    "",
    "| ページ | 図 | 部品 | source | fontSize | 実測 | 見積もり | 誤差 |",
    "| --- | ---: | --- | --- | ---: | ---: | ---: | ---: |",
    ...unique
      .slice(0, n)
      .map(
        (c) =>
          `| ${c.page} | ${c.figure} | ${c.component} | ${cell(c.source)} | ${c.fontSize} | ${fixed(c.actual)} | ${fixed(c.estimate)} | ${fixed(c.diff)}${c.approximate ? "（approximate）" : ""} |`,
      ),
    "",
  ];
}

async function main(): Promise<void> {
  const { values, positionals } = parseCli(OPTIONS, USAGE);
  const file = positionals[0];
  if (file === undefined || positionals.length > 1) {
    throw new UsageError(`ラベルの JSON を 1 つ指定する。\n\n${USAGE}`);
  }
  const worst = values.worst === undefined ? 0 : parsePositive(values.worst, "worst");
  const compared = readLabels(file).flatMap(compare);
  const groups = (key: (c: Compared) => string): readonly Row[] =>
    [...Map.groupBy(compared, key).entries()]
      .map(([group, items]) => rowOf(group, items))
      .toSorted((a, b) => b.count - a.count);
  const total = rowOf("全体", compared);
  const byKind = groups((c) => c.kind);
  const byComponent = groups((c) => c.component);
  const byUnder = compared.toSorted((a, b) => b.diff - a.diff);
  const byOver = compared.toSorted((a, b) => a.diff - b.diff);
  console.log(
    [
      `ラベル ${compared.length} 件の幅を比べた（誤差 = 実測 − 見積もり、px）。`,
      "余白は measure.ts の labelWidthMargin（max(1px, 幅の 3%)）である。",
      "",
      ...rowTable("種類ごと", [total, ...byKind]),
      ...rowTable("部品ごと", byComponent),
      ...(worst > 0
        ? [
            ...worstTable(`過小の大きい ${worst} 件`, byUnder, worst),
            ...worstTable(`過大の大きい ${worst} 件`, byOver, worst),
          ]
        : []),
    ].join("\n"),
  );
  if (values.json !== undefined) {
    const written = writeJson(values.json, {
      total,
      byKind,
      byComponent,
      labels: compared,
    });
    console.log(`詳細を書き出した: ${written}`);
  }
}

runMain(main);
