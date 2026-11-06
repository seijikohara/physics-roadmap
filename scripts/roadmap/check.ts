// 設計書と章の整合を検査する。pnpm run check と CI から呼ぶ。

import { readFileSync } from "node:fs";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { UPSTREAM_INDEX, loadChapters, loadRows } from "./load.ts";
import { checkRoadmap } from "./rules.ts";
import { buildUpstreamIndex } from "./upstream-index.ts";

function main(): void {
  const rows = loadRows();
  const problems = checkRoadmap(rows, loadChapters());
  const index: unknown = JSON.parse(readFileSync(UPSTREAM_INDEX, "utf8"));
  const stale = isDeepStrictEqual(index, buildUpstreamIndex(rows))
    ? []
    : ["docs/roadmap/upstream-index.json が古い。pnpm run roadmap:index で作り直す"];
  const all = [...problems, ...stale];
  for (const problem of all) console.error(problem);
  if (all.length > 0) {
    console.error(`設計書と章の整合に ${all.length} 件の問題がある`);
    process.exitCode = 1;
    return;
  }
  console.log(`設計書の ${rows.length} 行と章の整合を確かめた`);
}

main();
