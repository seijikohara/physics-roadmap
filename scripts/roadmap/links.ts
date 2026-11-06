// 章の本文から、サイトの中の別のページへのリンクを取り出す。

import path from "node:path";

const MARKDOWN_LINK = /\]\((?<target>[^)\s]+)\)/gu;
const BASE_PATH = "/physics-roadmap/";

const isExternal = (target: string): boolean =>
  /^[a-z][a-z+.-]*:/iu.test(target) || target.startsWith("#");

/** リンク先を `src/content/docs/` からの相対パスへ直す。公開の URL は末尾が `/` なので、章自身が基準である。 */
function resolveTarget(chapter: string, target: string): string {
  const [location = ""] = target.split("#");
  const normalized = location.startsWith(BASE_PATH)
    ? location.slice(BASE_PATH.length)
    : path.posix.join(chapter, location);
  return normalized.replace(/^\/+/u, "").replace(/\/+$/u, "");
}

/** 章の本文にあるサイト内のリンク先を、重複なしで返す。章自身へのリンクは除く。 */
export function internalLinks(chapter: string, text: string): readonly string[] {
  const targets = [...text.matchAll(MARKDOWN_LINK)]
    .map((match) => match.groups?.target ?? "")
    .filter((target) => target !== "" && !isExternal(target))
    .map((target) => resolveTarget(chapter, target));
  return [...new Set(targets)].filter((target) => target !== chapter);
}
