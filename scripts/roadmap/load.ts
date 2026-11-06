// 設計書と章のファイルを読み込む。パスの解決とファイルの入出力をここへ寄せる。

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDesignDoc } from "./design-doc.ts";
import type { Row } from "./design-doc.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DESIGN_DOC = path.join(ROOT, "docs/roadmap-design.md");
export const INDEX_DIR = path.join(ROOT, "docs/roadmap");
export const UPSTREAM_INDEX = path.join(INDEX_DIR, "upstream-index.json");
export const PREREQUISITE_INVENTORY = path.join(INDEX_DIR, "prerequisite-inventory.json");
const CONTENT_DIR = path.join(ROOT, "src/content/docs");

export const loadRows = (): readonly Row[] => parseDesignDoc(readFileSync(DESIGN_DOC, "utf8"));

/** 章のパス（`src/content/docs/` からの相対、拡張子なし）から本文への対応を返す。 */
export function loadChapters(): ReadonlyMap<string, string> {
  const files = readdirSync(CONTENT_DIR, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.mdx?$/u.test(file))
    .toSorted((a, b) => a.localeCompare(b));
  return new Map(
    files.map((file) => [
      file.replaceAll(path.sep, "/").replace(/\.mdx?$/u, ""),
      readFileSync(path.join(CONTENT_DIR, file), "utf8"),
    ]),
  );
}
