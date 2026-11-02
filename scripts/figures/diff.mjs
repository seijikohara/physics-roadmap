// 2 つのビルド結果（基準と変更後）の図を比べ、HTML が変わった図だけを撮って左右に並べた画像にする。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  UsageError,
  closeAll,
  countFigures,
  displayPath,
  launchBrowser,
  listDistPages,
  newThemedContext,
  openPage,
  pageName,
  pageUrl,
  parseCli,
  parsePositive,
  parseThemes,
  readBasePath,
  runMain,
  shootFigure,
  startStaticServer,
} from "./lib.mjs";

const USAGE = `使い方: pnpm run figures:diff -- --base <基準の dist> [オプション]

基準と変更後のビルド結果を比べ、記事本文の figure の HTML が変わった図だけを撮る。
左に基準、右に変更後を並べた 1 枚の PNG を <out>/<ページ名>/fig-NN.png に書く。
基準は、変更前に pnpm build した dist を、既存の基準と置き換えてコピーして作る。
  rm -rf .figures/base && mkdir -p .figures && cp -R dist .figures/base

オプション:
  --base <フォルダ>   基準のビルド結果（必須。例: .figures/base）
  --dist <フォルダ>   変更後のビルド結果（既定: dist）
  --theme <テーマ>    light・dark・both（既定: light。both のときはファイル名にテーマを付ける）
  --scale <倍率>      画像の解像度の倍率（既定: 2）
  --out <フォルダ>    出力先（既定: .figures/diff）`;

const OPTIONS = {
  base: { type: "string" },
  dist: { type: "string", default: "dist" },
  theme: { type: "string", default: "light" },
  scale: { type: "string", default: "2" },
  out: { type: "string", default: ".figures/diff" },
};

/**
 * 記事本文のすべての figure の HTML を、文書の順に返す。
 *
 * 番号をブラウザの `.sl-markdown-content figure`（入れ子も数える文書順）とそろえるため、開始タグの順に
 * 並べ、入れ子は対応する終了タグまでを 1 つの図として切り出す。
 */
function extractFigures(html) {
  const start = html.search(/<div\b[^>]*\bclass="[^"]*\bsl-markdown-content\b[^"]*"[^>]*>/);
  if (start < 0) return [];
  const divRe = /<div\b[^>]*>|<\/div>/g;
  divRe.lastIndex = start;
  let depth = 0;
  let end = html.length;
  for (let m = divRe.exec(html); m !== null; m = divRe.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      end = divRe.lastIndex;
      break;
    }
  }
  const body = html.slice(start, end);
  const figures = [];
  const open = [];
  const figRe = /<figure\b[^>]*>|<\/figure>/g;
  for (let m = figRe.exec(body); m !== null; m = figRe.exec(body)) {
    if (m[0].startsWith("</")) {
      const i = open.pop();
      if (i !== undefined) figures[i].end = figRe.lastIndex;
    } else {
      open.push(figures.length);
      figures.push({ start: m.index, end: body.length });
    }
  }
  return figures.map((f) => body.slice(f.start, f.end));
}

/**
 * 図の中の id を振り直し、図と無関係な id の変化を差として数えないようにする。
 *
 * React の useId が出す id（マーカー・マスク・クリップの参照先）は、前にある図の数で変わる。
 * 図の中で現れた順に振り直してから比べる。
 */
function normalizeIds(figure) {
  const ids = [...new Set([...figure.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))];
  const map = new Map(ids.map((id, i) => [id, `id${i}`]));
  return figure.replace(
    /(\bid="|url\(#|href="#|aria-(?:labelledby|describedby)=")([^")\s]+)/g,
    (whole, prefix, id) => (map.has(id) ? `${prefix}${map.get(id)}` : whole),
  );
}

function readFigures(distDir, route) {
  return extractFigures(readFileSync(path.join(distDir, route, "index.html"), "utf8"));
}

/** 前回の実行で書いた比較画像を消し、古い結果が残らないようにする。 */
function clearOldOutputs(outDir) {
  if (!existsSync(outDir)) return;
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(outDir, entry.name);
    for (const file of readdirSync(dir)) {
      if (/^fig-\d+(-light|-dark)?\.png$/.test(file)) rmSync(path.join(dir, file));
    }
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  }
}

/** `scale` 倍で撮った PNG の CSS 上の幅（IHDR の幅を倍率で割った値）を返す。 */
const cssWidth = (png, scale) => png.readUInt32BE(16) / scale;

/** 基準と変更後の画像を左右に並べ、1 枚の PNG に撮る。 */
async function compose(page, { base, changed, theme, scale, file }) {
  const dark = theme === "dark";
  const img = (png) =>
    `<img src="data:image/png;base64,${png.toString("base64")}" style="width:${cssWidth(png, scale)}px">`;
  await page.setContent(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
body { margin: 0; background: ${dark ? "#17181c" : "#ffffff"}; color: ${dark ? "#e5e7eb" : "#1f2937"};
  font-family: system-ui, sans-serif; }
.pair { display: inline-flex; gap: 24px; padding: 16px; align-items: flex-start; }
h2 { font-size: 16px; margin: 0 0 8px; }
img { display: block; outline: 1px solid #9ca3af; }
</style></head><body><div class="pair">
<div><h2>基準</h2>${img(base)}</div><div><h2>変更後</h2>${img(changed)}</div>
</div></body></html>`,
    { waitUntil: "load" },
  );
  await page.locator(".pair").screenshot({ path: file, animations: "disabled" });
}

async function main() {
  const { values } = parseCli(OPTIONS, USAGE);
  if (values.base === undefined) throw new UsageError(`--base を指定する。\n\n${USAGE}`);
  const themes = parseThemes(values.theme);
  const scale = parsePositive(values.scale, "scale");
  const baseDir = path.resolve(values.base);
  const distDir = path.resolve(values.dist);
  const outDir = path.resolve(values.out);
  for (const dir of [baseDir, distDir]) {
    if (!existsSync(path.join(dir, "index.html"))) {
      throw new UsageError(`ビルド結果のフォルダではない（index.html が無い）: ${dir}`);
    }
  }

  const basePages = listDistPages(baseDir);
  const newPages = listDistPages(distDir);
  const onlyBase = basePages.filter((r) => !newPages.includes(r));
  const onlyNew = newPages.filter((r) => !basePages.includes(r));
  const common = basePages.filter((r) => newPages.includes(r));

  const changes = [];
  const countDiffs = [];
  for (const route of common) {
    const a = readFigures(baseDir, route);
    const b = readFigures(distDir, route);
    if (a.length !== b.length) countDiffs.push({ route, base: a.length, changed: b.length });
    const figures = [];
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (normalizeIds(a[i]) !== normalizeIds(b[i])) figures.push(i + 1);
    }
    if (figures.length > 0) changes.push({ route, figures, total: b.length });
  }

  clearOldOutputs(outDir);
  if (changes.length > 0) {
    const basePath = readBasePath();
    const servers = [];
    let browser = null;
    try {
      // 2 台目の起動に失敗しても 1 台目を閉じられるよう、起動したサーバから順に積む。
      for (const dir of [baseDir, distDir]) servers.push(await startStaticServer(dir, basePath));
      const [baseServer, newServer] = servers;
      browser = await launchBrowser();
      // 元の画像はすでに scale 倍なので、並べた画像も同じ倍率で撮って画素を 1 対 1 に保つ。
      const composer = await (await browser.newContext({ deviceScaleFactor: scale })).newPage();
      for (const theme of themes) {
        const baseContext = await newThemedContext(browser, { theme, scale });
        const newContext = await newThemedContext(browser, { theme, scale });
        for (const { route, figures, total } of changes) {
          const basePage = await openPage(baseContext, pageUrl(baseServer.baseUrl, route), theme);
          const newPage = await openPage(newContext, pageUrl(newServer.baseUrl, route), theme);
          if ((await countFigures(newPage)) !== total) {
            console.warn(
              `警告: ${route} の図の数が HTML と表示で合わない。図の番号がずれている恐れがある。`,
            );
          }
          const dir = path.join(outDir, pageName(route));
          mkdirSync(dir, { recursive: true });
          for (const n of figures) {
            const suffix = themes.length > 1 ? `-${theme}` : "";
            const file = path.join(dir, `fig-${String(n).padStart(2, "0")}${suffix}.png`);
            const base = await shootFigure(basePage, n);
            const changed = await shootFigure(newPage, n);
            await compose(composer, { base, changed, theme, scale, file });
            console.log(displayPath(file));
          }
          await basePage.close();
          await newPage.close();
        }
        await baseContext.close();
        await newContext.close();
      }
    } finally {
      await closeAll(browser, ...servers);
    }
  }

  const lines = [];
  if (changes.length > 0) {
    lines.push(
      "## 変わった図",
      "",
      ...changes.map((c) => `- ${c.route}: 図 ${c.figures.join("・")}`),
      "",
    );
  }
  if (countDiffs.length > 0) {
    lines.push(
      "## 図の数が違うページ",
      "",
      ...countDiffs.map((c) => `- ${c.route}: 基準 ${c.base} 枚・変更後 ${c.changed} 枚`),
      "",
    );
  }
  if (onlyBase.length > 0 || onlyNew.length > 0) {
    lines.push(
      "## 片方にしかないページ",
      "",
      ...onlyBase.map((r) => `- 基準のみ: ${r}`),
      ...onlyNew.map((r) => `- 変更後のみ: ${r}`),
      "",
    );
  }
  const changedCount = changes.reduce((sum, c) => sum + c.figures.length, 0);
  lines.push("## 合計", "", `比べたページ ${common.length}・変わった図 ${changedCount}`);
  console.log(lines.join("\n"));
}

runMain(main);
