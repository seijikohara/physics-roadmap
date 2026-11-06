// 章ごとの推移的な上流の一覧 docs/roadmap/upstream-index.json を書き出す。

import { mkdirSync, writeFileSync } from "node:fs";
import { INDEX_DIR, UPSTREAM_INDEX, loadRows } from "./load.ts";
import { buildUpstreamIndex } from "./upstream-index.ts";

mkdirSync(INDEX_DIR, { recursive: true });
writeFileSync(UPSTREAM_INDEX, `${JSON.stringify(buildUpstreamIndex(loadRows()), undefined, 2)}\n`);
console.log(UPSTREAM_INDEX);
