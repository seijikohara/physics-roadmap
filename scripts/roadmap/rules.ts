// 設計書と章の整合の検査。依存の循環、本線から任意枠への依存、切れたリンク、上流以外へのリンクを見つける。

import type { Row } from "./design-doc.ts";
import { closureOf, dependenciesOf, redundantPrereqs } from "./graph.ts";
import { internalLinks } from "./links.ts";

/** 設計書の行に対応しないページ。依存の検査の対象にしない。 */
const NON_CHAPTER_PAGES: ReadonlySet<string> = new Set(["index"]);

/** 読者の出発点の章は、前提に含まれないものの案内として下流の章へ張ってよい。 */
const FORWARD_LINK_PAGES: ReadonlySet<string> = new Set(["prerequisites/knowledge"]);

const duplicates = (ids: readonly string[]): readonly string[] =>
  [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].map(
    (id) => `ID が重複している: ${id}`,
  );

function rowProblems(rows: readonly Row[]): readonly string[] {
  const position = new Map(rows.map((row, index) => [row.id, index]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const dependencies = dependenciesOf(rows);
  return rows.flatMap((row) => [
    ...row.prereqs.flatMap((prereq) => {
      const target = byId.get(prereq);
      if (target === undefined) return [`${row.id}: 前提の ID が見つからない: ${prereq}`];
      return [
        ...(!row.optional && target.optional
          ? [`${row.id}: 本線の行が任意枠の行を前提にしている: ${prereq}`]
          : []),
        ...(target.category === row.category &&
        (position.get(prereq) ?? 0) >= (position.get(row.id) ?? 0)
          ? [`${row.id}: 同じカテゴリの後の行を前提にしている: ${prereq}`]
          : []),
      ];
    }),
    ...(closureOf(row.id, dependencies).has(row.id) ? [`${row.id}: 依存が循環している`] : []),
    ...redundantPrereqs(row.id, dependencies).map(
      (prereq) => `${row.id}: 前提が推移的に得られる ID を重ねている: ${prereq}`,
    ),
  ]);
}

/** 章のファイルから、その章に対応する行への対応を作る。分割の前は 1 つの章に複数の行が対応する。 */
const rowsByChapter = (rows: readonly Row[]): ReadonlyMap<string, readonly Row[]> =>
  rows.reduce<ReadonlyMap<string, readonly Row[]>>(
    (map, row) =>
      new Map([
        ...map,
        ...row.chapters.map((chapter): [string, readonly Row[]] => [
          chapter,
          [...(map.get(chapter) ?? []), row],
        ]),
      ]),
    new Map(),
  );

/** 章の行が推移的に必要とする章と、統合を待つ同じ行の章を返す。 */
export function upstreamChapters(chapter: string, rows: readonly Row[]): ReadonlySet<string> {
  const dependencies = dependenciesOf(rows);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const own = rows.filter((row) => row.chapters.includes(chapter));
  const ids = own.flatMap((row) => [row.id, ...closureOf(row.id, dependencies)]);
  return new Set(
    ids.flatMap((id) => byId.get(id)?.chapters ?? []).filter((target) => target !== chapter),
  );
}

function chapterProblems(
  rows: readonly Row[],
  chapters: ReadonlyMap<string, string>,
): readonly string[] {
  const mapped = rowsByChapter(rows);
  const missing = [...mapped.keys()]
    .filter((chapter) => !chapters.has(chapter))
    .map((chapter) => `設計書の章のファイルが無い: ${chapter}`);
  const unmapped = [...chapters.keys()]
    .filter((chapter) => !mapped.has(chapter) && !NON_CHAPTER_PAGES.has(chapter))
    .map((chapter) => `設計書の行に対応しない章がある: ${chapter}`);
  const links = [...chapters].flatMap(([chapter, text]) => {
    const upstream = upstreamChapters(chapter, rows);
    return internalLinks(chapter, text).flatMap((target) => {
      if (!chapters.has(target)) return [`${chapter}: リンクが切れている: ${target}`];
      if (NON_CHAPTER_PAGES.has(chapter) || NON_CHAPTER_PAGES.has(target)) return [];
      if (FORWARD_LINK_PAGES.has(chapter)) return [];
      return upstream.has(target) ? [] : [`${chapter}: 上流でない章へのリンク: ${target}`];
    });
  });
  return [...missing, ...unmapped, ...links];
}

/** 設計書の行と章の本文を検査し、問題の一覧を返す。問題が無ければ空である。 */
export function checkRoadmap(
  rows: readonly Row[],
  chapters: ReadonlyMap<string, string>,
): readonly string[] {
  return [
    ...duplicates(rows.map((row) => row.id)),
    ...rowProblems(rows),
    ...chapterProblems(rows, chapters),
  ];
}
