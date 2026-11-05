// 2 つのビルド結果（基準と変更後）の図を比べ、HTML が変わった図だけを撮って左右に並べた画像にする。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { Browser, Page } from "playwright-core";
import { extractFigures, figureFileStem, standaloneId } from "./figure-id.ts";
import type { FigureId, PageFigures } from "./figure-id.ts";
import {
  UsageError,
  closeAll,
  displayPath,
  listDistPages,
  listFigures,
  mapSeries,
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
  withBrowser,
} from "./lib.ts";
import type { StaticServer, Theme } from "./lib.ts";

const USAGE = `使い方: pnpm run figures:diff -- --base <基準の dist> [オプション]

基準と変更後のビルド結果を比べ、記事本文の図の HTML が変わった図だけを撮る。
figure の外の図（キャプションの無い SVG）は s1, s2, ... と数え、凡例を含まない SVG だけを比べる。
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
} as const;

/** 文字列の中の区間。 */
/** 変わった図のあるページ。 */
type Change = Readonly<{ route: string; figures: readonly FigureId[]; total: number }>;

/** 図の数が違うページ。 */
type CountDiff = Readonly<{ route: string; base: string; changed: string }>;

/** 撮った図。CSS 上の幅と、data URL に埋め込む base64 の PNG を持つ。 */
type Shot = Readonly<{ base64: string; width: number }>;

/**
 * 図の中の id を振り直し、図と無関係な id の変化を差として数えないようにする。
 *
 * React の useId が出す id（マーカー・マスク・クリップの参照先）は、前にある図の数で変わる。
 * 図の中で現れた順に振り直してから比べる。
 */
function normalizeIds(figure: string): string {
  const ids = [...new Set([...figure.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1] ?? ""))];
  const renamed: ReadonlyMap<string, string> = new Map(ids.map((id, i) => [id, `id${i}`]));
  return figure.replace(
    /(\bid="|url\(#|href="#|aria-(?:labelledby|describedby)=")([^")\s]+)/g,
    (whole: string, prefix: string, id: string) => {
      const next = renamed.get(id);
      return next === undefined ? whole : `${prefix}${next}`;
    },
  );
}

function readFigures(distDir: string, route: string): PageFigures {
  return extractFigures(readFileSync(path.join(distDir, route, "index.html"), "utf8"));
}

/** 同じ系列の図を番号の順に比べ、変わった図の番号を返す。 */
function changedFigures(
  a: readonly string[],
  b: readonly string[],
  idOf: (n: number) => FigureId,
): readonly FigureId[] {
  return a
    .slice(0, Math.min(a.length, b.length))
    .flatMap((fig, i) => (normalizeIds(fig) === normalizeIds(b[i] ?? "") ? [] : [idOf(i + 1)]));
}

/** ページの図の枚数を、報告の文にする。 */
const countText = (p: PageFigures): string =>
  p.standalone.length === 0
    ? `${p.figures.length} 枚`
    : `${p.figures.length} 枚（figure の外に ${p.standalone.length} 枚）`;

/** 2 つのビルド結果の共通のページを比べ、変わった図と図の数の違いを返す。 */
function findChanges(
  baseDir: string,
  distDir: string,
  common: readonly string[],
): Readonly<{ changes: readonly Change[]; countDiffs: readonly CountDiff[] }> {
  const compared = common.map((route) => {
    const a = readFigures(baseDir, route);
    const b = readFigures(distDir, route);
    const figures = [
      ...changedFigures(a.figures, b.figures, (n) => n),
      ...changedFigures(a.standalone, b.standalone, standaloneId),
    ];
    return { route, a, b, figures };
  });
  return {
    changes: compared
      .filter((c) => c.figures.length > 0)
      .map((c) => ({
        route: c.route,
        figures: c.figures,
        total: c.b.figures.length + c.b.standalone.length,
      })),
    countDiffs: compared
      .filter(
        (c) =>
          c.a.figures.length !== c.b.figures.length ||
          c.a.standalone.length !== c.b.standalone.length,
      )
      .map((c) => ({ route: c.route, base: countText(c.a), changed: countText(c.b) })),
  };
}

/** 前回の実行で書いた比較画像を消し、古い結果が残らないようにする。 */
function clearOldOutputs(outDir: string): void {
  if (!existsSync(outDir)) return;
  const dirs = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(outDir, entry.name));
  for (const dir of dirs) {
    for (const file of readdirSync(dir).filter((f) => /^fig-s?\d+(-light|-dark)?\.png$/.test(f))) {
      rmSync(path.join(dir, file));
    }
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  }
}

/** 図を撮り、CSS 上の幅（IHDR の幅を倍率で割った値）と base64 の PNG を返す。 */
async function shoot(page: Page, id: FigureId, scale: number): Promise<Shot> {
  const png = await shootFigure(page, id);
  return { base64: png.toString("base64"), width: png.readUInt32BE(16) / scale };
}

/** 撮った図を、CSS 上の幅を指定した img 要素にする。 */
const imgTag = (shot: Shot): string =>
  `<img src="data:image/png;base64,${shot.base64}" style="width:${shot.width}px">`;

/** 比較画像の HTML を組み立てる。 */
function compositeHtml(base: Shot, changed: Shot, theme: Theme): string {
  const dark = theme === "dark";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
body { margin: 0; background: ${dark ? "#17181c" : "#ffffff"}; color: ${dark ? "#e5e7eb" : "#1f2937"};
  font-family: system-ui, sans-serif; }
.pair { display: inline-flex; gap: 24px; padding: 16px; align-items: flex-start; }
h2 { font-size: 16px; margin: 0 0 8px; }
img { display: block; outline: 1px solid #9ca3af; }
</style></head><body><div class="pair">
<div><h2>基準</h2>${imgTag(base)}</div><div><h2>変更後</h2>${imgTag(changed)}</div>
</div></body></html>`;
}

/**
 * 2 台の静的サーバを立てる。1 台でも起動に失敗したら、起動できた方を閉じてから失敗を伝える。
 */
async function startServers(
  dirs: readonly string[],
  basePath: string,
): Promise<readonly StaticServer[]> {
  const started = await Promise.allSettled(
    dirs.map(async (dir) => startStaticServer(dir, basePath)),
  );
  const servers = started.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failures = started.flatMap((r): readonly unknown[] =>
    r.status === "rejected" ? [r.reason] : [],
  );
  if (failures.length > 0) {
    await closeAll(null, servers);
    throw failures[0];
  }
  return servers;
}

/** 変わった図を基準と変更後の両方で撮り、左右に並べた画像を書く。 */
async function writeComposites(
  browser: Browser,
  options: Readonly<{
    changes: readonly Change[];
    servers: readonly StaticServer[];
    themes: readonly Theme[];
    scale: number;
    outDir: string;
  }>,
): Promise<void> {
  const [baseServer, newServer] = options.servers;
  if (baseServer === undefined || newServer === undefined) return;
  const { scale } = options;
  // 元の画像はすでに scale 倍なので、並べた画像も同じ倍率で撮って画素を 1 対 1 に保つ。
  const composer = await (await browser.newContext({ deviceScaleFactor: scale })).newPage();
  await mapSeries(options.themes, async (theme) => {
    const baseContext = await newThemedContext(browser, { theme, scale });
    const newContext = await newThemedContext(browser, { theme, scale });
    await mapSeries(options.changes, async ({ route, figures, total }) => {
      const basePage = await openPage(baseContext, pageUrl(baseServer.baseUrl, route), theme);
      const newPage = await openPage(newContext, pageUrl(newServer.baseUrl, route), theme);
      if ((await listFigures(newPage)).length !== total) {
        console.warn(
          `警告: ${route} の図の数が HTML と表示で合わない。図の番号がずれている恐れがある。`,
        );
      }
      const dir = path.join(options.outDir, pageName(route));
      mkdirSync(dir, { recursive: true });
      const suffix = options.themes.length > 1 ? `-${theme}` : "";
      await mapSeries(figures, async (id) => {
        const file = path.join(dir, `${figureFileStem(id)}${suffix}.png`);
        const html = compositeHtml(
          await shoot(basePage, id, scale),
          await shoot(newPage, id, scale),
          theme,
        );
        await composer.setContent(html, { waitUntil: "load" });
        await composer.locator(".pair").screenshot({ path: file, animations: "disabled" });
        console.log(displayPath(file));
      });
      await basePage.close();
      await newPage.close();
    });
    await baseContext.close();
    await newContext.close();
  });
}

/** 比較の結果を Markdown の行にする。 */
function reportLines(
  r: Readonly<{
    changes: readonly Change[];
    countDiffs: readonly CountDiff[];
    onlyBase: readonly string[];
    onlyNew: readonly string[];
    compared: number;
  }>,
): readonly string[] {
  const changed = r.changes.reduce((sum, c) => sum + c.figures.length, 0);
  return [
    ...(r.changes.length > 0
      ? [
          "## 変わった図",
          "",
          ...r.changes.map((c) => `- ${c.route}: 図 ${c.figures.join("・")}`),
          "",
        ]
      : []),
    ...(r.countDiffs.length > 0
      ? [
          "## 図の数が違うページ",
          "",
          ...r.countDiffs.map((c) => `- ${c.route}: 基準 ${c.base}・変更後 ${c.changed}`),
          "",
        ]
      : []),
    ...(r.onlyBase.length > 0 || r.onlyNew.length > 0
      ? [
          "## 片方にしかないページ",
          "",
          ...r.onlyBase.map((route) => `- 基準のみ: ${route}`),
          ...r.onlyNew.map((route) => `- 変更後のみ: ${route}`),
          "",
        ]
      : []),
    "## 合計",
    "",
    `比べたページ ${r.compared}・変わった図 ${changed}`,
  ];
}

async function main(): Promise<void> {
  const { values } = parseCli(OPTIONS, USAGE);
  if (values.base === undefined) throw new UsageError(`--base を指定する。\n\n${USAGE}`);
  const themes = parseThemes(values.theme);
  const scale = parsePositive(values.scale, "scale");
  const baseDir = path.resolve(values.base);
  const distDir = path.resolve(values.dist);
  const outDir = path.resolve(values.out);
  const notBuilt = [baseDir, distDir].find((dir) => !existsSync(path.join(dir, "index.html")));
  if (notBuilt !== undefined) {
    throw new UsageError(`ビルド結果のフォルダではない（index.html が無い）: ${notBuilt}`);
  }

  const basePages = listDistPages(baseDir);
  const newPages = listDistPages(distDir);
  const common = basePages.filter((r) => newPages.includes(r));
  const { changes, countDiffs } = findChanges(baseDir, distDir, common);

  clearOldOutputs(outDir);
  if (changes.length > 0) {
    const servers = await startServers([baseDir, distDir], readBasePath());
    await withBrowser(servers, async (browser) =>
      writeComposites(browser, { changes, servers, themes, scale, outDir }),
    );
  }

  const lines = reportLines({
    changes,
    countDiffs,
    onlyBase: basePages.filter((r) => !newPages.includes(r)),
    onlyNew: newPages.filter((r) => !basePages.includes(r)),
    compared: common.length,
  });
  console.log(lines.join("\n"));
}

runMain(main);
