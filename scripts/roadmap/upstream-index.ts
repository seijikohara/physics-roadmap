// 章ごとの推移的な上流の一覧を作る。logic-leap-verifier は Read・Grep・Glob だけで動くので、
// 閉包を計算できない。計算済みの一覧をファイルとして渡す。

import type { Row } from "./design-doc.ts";
import { upstreamChapters } from "./rules.ts";

export type UpstreamEntry = Readonly<{
  rows: readonly string[];
  upstream: readonly string[];
}>;

/** 章のパスから、章の行の ID と推移的な上流の章への対応を作る。章は設計書の順に並ぶ。 */
export function buildUpstreamIndex(rows: readonly Row[]): Readonly<Record<string, UpstreamEntry>> {
  const chapters = [...new Set(rows.flatMap((row) => row.chapters))];
  const order = new Map(chapters.map((chapter, index) => [chapter, index]));
  return Object.fromEntries(
    chapters.map((chapter) => [
      chapter,
      {
        rows: rows.filter((row) => row.chapters.includes(chapter)).map((row) => row.id),
        upstream: [...upstreamChapters(chapter, rows)].toSorted(
          (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
        ),
      },
    ]),
  );
}
