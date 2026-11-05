// 章の図を 1 枚ずつ PNG に撮る。サイトの CSS とフォントがそのまま効いた描画を撮る。

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import { figureFileStem } from "./figure-id.ts";
import type { FigureId } from "./figure-id.ts";
import {
  UsageError,
  displayPath,
  distDirOf,
  listFigures,
  mapSeries,
  newThemedContext,
  openPage,
  openTarget,
  pageName,
  pageUrl,
  parseCli,
  parseFigureList,
  parsePositive,
  parseThemes,
  resolvePages,
  runMain,
  shootFigure,
  withBrowser,
} from "./lib.ts";
import type { Theme } from "./lib.ts";

const USAGE = `使い方: pnpm run figures:shot -- <ページ>... [オプション]

<ページ> はルート（math/vector-calculus/curl）・URL のパス・章ファイルのパスのいずれか。
末尾が / のフォルダは、その下の全ページに展開する。

オプション:
  --only 1,3,s2       撮る図の番号。s の付く番号は figure の外の図（既定: すべて）
  --theme <テーマ>    light・dark・both（既定: light）
  --scale <倍率>      画像の解像度の倍率（既定: 2）
  --out <フォルダ>    出力先（既定: .figures/shots）
  --no-caption        figcaption を隠して撮る
  --url <URL>         対象サイトの base URL（既定: http://localhost:4321/physics-roadmap）
  --dist <フォルダ>   ビルド結果を静的サーバで配信して撮る（--url の代わり）`;

const OPTIONS = {
  only: { type: "string" },
  theme: { type: "string", default: "light" },
  scale: { type: "string", default: "2" },
  out: { type: "string", default: ".figures/shots" },
  "no-caption": { type: "boolean", default: false },
  url: { type: "string" },
  dist: { type: "string" },
} as const;

/** 撮影の前に図のキャプションを消す。配置の計算から外すため、visibility ではなく display を使う。 */
const NO_CAPTION_STYLE = ".sl-markdown-content figure figcaption { display: none !important; }";

/** 1 ページの撮影の設定。 */
type ShotPlan = Readonly<{
  baseUrl: string;
  outDir: string;
  theme: Theme;
  only: readonly FigureId[] | null;
  noCaption: boolean;
}>;

/** 撮る図の番号と出力先の組を返す。存在しない番号は除く。 */
function figureFiles(
  plan: ShotPlan,
  route: string,
  ids: readonly FigureId[],
): readonly Readonly<{ id: FigureId; file: string }>[] {
  const wanted = plan.only ?? ids;
  const dir = path.join(plan.outDir, pageName(route));
  return wanted
    .filter((id) => ids.includes(id))
    .map((id) => ({ id, file: path.join(dir, `${figureFileStem(id)}-${plan.theme}.png`) }));
}

/** 1 ページの図を撮り、書いたファイルの並びを返す。 */
async function shootPage(
  context: BrowserContext,
  plan: ShotPlan,
  route: string,
): Promise<readonly string[]> {
  const page = await openPage(context, pageUrl(plan.baseUrl, route), plan.theme);
  try {
    if (plan.noCaption) await page.addStyleTag({ content: NO_CAPTION_STYLE });
    const ids = await listFigures(page);
    const missing = (plan.only ?? []).filter((id) => !ids.includes(id));
    if (missing.length > 0) {
      console.warn(`警告: ${route} に図 ${missing.join("・")} は無い（図は ${ids.length} 枚）`);
    }
    const files = figureFiles(plan, route, ids);
    if (files.length > 0) mkdirSync(path.join(plan.outDir, pageName(route)), { recursive: true });
    return await mapSeries(files, async ({ id, file }) => {
      await shootFigure(page, id, file);
      console.log(displayPath(file));
      return file;
    });
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseCli(OPTIONS, USAGE);
  const themes = parseThemes(values.theme);
  const scale = parsePositive(values.scale, "scale");
  const only = values.only === undefined ? null : parseFigureList(values.only);
  const outDir = path.resolve(values.out);
  if (positionals.length === 0) {
    throw new UsageError(`撮るページを指定する。\n\n${USAGE}`);
  }
  // ページの指定はサーバを立てる前に解決し、誤りなら何も起動せずに終える。
  const routes = resolvePages(positionals, { distDir: distDirOf(values) });

  const target = await openTarget(values);
  const written = await withBrowser([target], async (browser) =>
    mapSeries(themes, async (theme) => {
      const context = await newThemedContext(browser, { theme, scale });
      const plan: ShotPlan = {
        baseUrl: target.baseUrl,
        outDir,
        theme,
        only,
        noCaption: values["no-caption"],
      };
      try {
        return (await mapSeries(routes, async (route) => shootPage(context, plan, route))).flat();
      } finally {
        await context.close();
      }
    }),
  );
  console.log(`${written.flat().length} 枚を書き出した。`);
}

runMain(main);
