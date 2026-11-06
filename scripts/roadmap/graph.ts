// 設計書の行の依存を扱う。前提の列から、ある行が推移的に必要とする行の全体（閉包）を求める。

import type { Row } from "./design-doc.ts";

/** 行の ID から、直接の前提の ID への対応。 */
export type Dependencies = ReadonlyMap<string, readonly string[]>;

export const dependenciesOf = (rows: readonly Row[]): Dependencies =>
  new Map(rows.map((row) => [row.id, row.prereqs]));

/**
 * `start` が推移的に必要とする行の ID を返す。`start` 自身は、循環があるときだけ含まれる。
 * 未知の ID は結果に含めて止まる。
 */
export function closureOf(start: string, dependencies: Dependencies): ReadonlySet<string> {
  const walk = (pending: readonly string[], seen: ReadonlySet<string>): ReadonlySet<string> => {
    const [head, ...rest] = pending;
    if (head === undefined) return seen;
    if (seen.has(head)) return walk(rest, seen);
    return walk([...(dependencies.get(head) ?? []), ...rest], new Set([...seen, head]));
  };
  return walk(dependencies.get(start) ?? [], new Set());
}

/** 直接の前提のうち、ほかの前提から推移的に得られる ID を返す。 */
export function redundantPrereqs(id: string, dependencies: Dependencies): readonly string[] {
  const prereqs = dependencies.get(id) ?? [];
  return prereqs.filter((candidate) =>
    prereqs.some((other) => other !== candidate && closureOf(other, dependencies).has(candidate)),
  );
}
