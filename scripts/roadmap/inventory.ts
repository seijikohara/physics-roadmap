// 章の前提節を機械可読の形で保存する。前提節の目録は、用語と記号の導入章を探す唯一の索引である。
// 前提節を「直接の上流だけ」へ縮める前に、章 → 上流の章 → 項目の表と、導入章 → 項目の逆引きを残す。

import { mkdirSync, writeFileSync } from "node:fs";
import { internalLinks } from "./links.ts";
import { INDEX_DIR, PREREQUISITE_INVENTORY, loadChapters } from "./load.ts";

type Entry = Readonly<{ upstream: string; items: readonly string[] }>;

const prerequisiteSection = (text: string): string =>
  /^## 前提\n(?<body>[\s\S]*?)^## /mu.exec(text)?.groups?.body ?? "";

/** 箇条書きの先頭のリンクより後の説明を返す。 */
const describe = (line: string): string =>
  line
    .replace(/^\s*- /u, "")
    .replace(/^\[[^\]]*\]\([^)]*\)[：:]?\s*/u, "")
    .trim();

function entries(chapter: string, section: string): readonly Entry[] {
  return section.split("\n").reduce<readonly Entry[]>((list, line) => {
    if (line.startsWith("- ")) {
      const [upstream] = internalLinks(chapter, line);
      return upstream === undefined
        ? list
        : [...list, { upstream, items: [describe(line)].filter((item) => item !== "") }];
    }
    const last = list.at(-1);
    if (last === undefined || !/^\s+- /u.test(line)) return list;
    return [...list.slice(0, -1), { ...last, items: [...last.items, describe(line)] }];
  }, []);
}

const chapters = [...loadChapters()].map(([chapter, text]) => ({
  chapter,
  entries: entries(chapter, prerequisiteSection(text)),
}));

const byChapter = Object.fromEntries(
  chapters.filter(({ entries: list }) => list.length > 0).map((c) => [c.chapter, c.entries]),
);

const introducedIn = chapters
  .flatMap((c) => c.entries)
  .reduce<Readonly<Record<string, readonly string[]>>>(
    (index, entry) => ({
      ...index,
      [entry.upstream]: [...new Set([...(index[entry.upstream] ?? []), ...entry.items])],
    }),
    {},
  );

mkdirSync(INDEX_DIR, { recursive: true });
writeFileSync(
  PREREQUISITE_INVENTORY,
  `${JSON.stringify({ byChapter, introducedIn }, undefined, 2)}\n`,
);
console.log(`${Object.keys(byChapter).length} 章の前提節を保存した: ${PREREQUISITE_INVENTORY}`);
