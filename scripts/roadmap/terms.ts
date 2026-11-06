// 章が上流の外の語を使っていないかを調べ、本章で初出の記号を一覧にする。検証者への入力である。
// pnpm run roadmap:terms -- <章>...
// pnpm run roadmap:terms -- --all
// pnpm run roadmap:terms -- --file <パス> --as <章>

import { readFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { TERM_EXCEPTIONS, loadChapters, loadRows } from "./load.ts";
import { upstreamChapters } from "./rules.ts";
import { buildContext, policyProblems, reportChapter } from "./term-rules.ts";
import type { ChapterReport, TermPolicy } from "./term-rules.ts";

const TOP = 20;

const isPolicy = (value: unknown): value is TermPolicy =>
  typeof value === "object" &&
  value !== null &&
  "aliases" in value &&
  Array.isArray(value.aliases) &&
  "exceptions" in value &&
  Array.isArray(value.exceptions);

function loadPolicy(): TermPolicy {
  const value: unknown = JSON.parse(readFileSync(TERM_EXCEPTIONS, "utf8"));
  if (!isPolicy(value)) throw new Error(`例外のファイルの形が違う: ${TERM_EXCEPTIONS}`);
  return value;
}

function printChapter(report: ChapterReport, upstreamCount: number): void {
  console.log(`${report.chapter}（上流 ${upstreamCount} 章）`);
  console.log(`(a) 上流の外の語: ${report.outside.length} 件`);
  for (const { term, lines, definedIn } of report.outside) {
    console.log(`  ${term}  行 ${lines.join(", ")}  定義する章: ${definedIn.join("、")}`);
  }
  if (report.excused.length > 0) {
    const terms = report.excused.map(({ term }) => term).join("、");
    console.log(`  例外のファイルで説明した語 ${report.excused.length} 件: ${terms}`);
  }
  console.log(`(b) 本章で初出の記号（合否に使わない）: ${report.newCommands.length} 件`);
  for (const { command, lines } of report.newCommands) {
    console.log(`  ${command}  行 ${lines.join(", ")}`);
  }
}

const ranked = (counts: ReadonlyMap<string, number>): readonly string[] =>
  [...counts]
    .toSorted(([, a], [, b]) => b - a)
    .slice(0, TOP)
    .map(([name, count]) => `  ${count}  ${name}`);

function printSummary(reports: readonly ChapterReport[], termCount: number): void {
  const outside = reports.flatMap((report) => report.outside);
  const excused = reports.flatMap((report) => report.excused);
  const byTerm = Map.groupBy(outside, ({ term }) => term);
  console.log(`${reports.length} 章、定義語 ${termCount} 語`);
  console.log(`(a) 説明できない語と章の組: ${outside.length} 件（${byTerm.size} 語）`);
  console.log(`    例外のファイルで説明した組: ${excused.length} 件`);
  console.log("章ごとの件数の上位:");
  const byChapter = reports.map((report) => [report.chapter, report.outside.length] as const);
  for (const line of ranked(new Map(byChapter))) console.log(line);
  console.log("語ごとの件数の上位:");
  const termCounts = [...byTerm].map(([term, group]) => [term, group.length] as const);
  for (const line of ranked(new Map(termCounts))) console.log(line);
  const commands = reports.reduce((sum, report) => sum + report.newCommands.length, 0);
  console.log(`(b) 章ごとの初出の記号の合計: ${commands} 件`);
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      all: { type: "boolean", default: false },
      file: { type: "string" },
      as: { type: "string" },
    },
  });
  if ((values.file === undefined) !== (values.as === undefined)) {
    throw new Error("--file と --as は一緒に指定する");
  }
  const rows = loadRows();
  const policy = loadPolicy();
  const repository = loadChapters();
  const known = [...new Set(rows.flatMap((row) => row.chapters))];
  const mapped = new Map([...repository].filter(([chapter]) => known.includes(chapter)));
  // 写しはその章の本文を置き換える。上流は写しの前提節でなく、設計書の行から求める。
  const chapters =
    values.file === undefined || values.as === undefined
      ? mapped
      : new Map([...mapped, [values.as, readFileSync(values.file, "utf8")]]);
  const targets = values.all
    ? known
    : [...positionals, ...(values.as === undefined ? [] : [values.as])];
  const unknown = targets.filter((target) => !chapters.has(target));
  if (unknown.length > 0) throw new Error(`設計書に無い章: ${unknown.join("、")}`);
  if (targets.length === 0) throw new Error("章を指定する。全章は --all で調べる");

  const context = buildContext(chapters, policy.aliases);
  const reportOf = (target: string): ChapterReport =>
    reportChapter(target, upstreamChapters(target, rows), context, policy);

  if (values.all) {
    const reports = targets.map((target) => reportOf(target));
    printSummary(reports, context.table.size);
    const problems = policyProblems(reports, context, policy);
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) process.exitCode = 1;
    return;
  }
  for (const target of targets) {
    printChapter(reportOf(target), upstreamChapters(target, rows).size);
  }
}

main();
