// ゴールの行が推移的に必要とする行を、カテゴリごとの数で出す。設計書のクリティカルパスの節はこの出力から書く。

import process from "node:process";
import type { Row } from "./design-doc.ts";
import { closureOf, dependenciesOf } from "./graph.ts";
import { loadRows } from "./load.ts";

const GOALS = process.argv.slice(2);

function report(goal: string, rows: readonly Row[]): string {
  const closure = closureOf(goal, dependenciesOf(rows));
  const categories = [...new Set(rows.map((row) => row.category))];
  const counts = categories.flatMap((category) => {
    const members = rows.filter((row) => row.category === category);
    const reached = members.filter((row) => closure.has(row.id)).length;
    return reached === 0 ? [] : [`${category} ${reached}/${members.length}`];
  });
  return `${goal}（${closure.size} 行）: ${counts.join("、")}`;
}

const rows = loadRows();
for (const goal of GOALS) console.log(report(goal, rows));
