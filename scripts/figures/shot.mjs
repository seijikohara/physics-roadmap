// 章の図を 1 枚ずつ PNG に撮る。サイトの CSS とフォントがそのまま効いた描画を撮る。

import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  UsageError,
  closeAll,
  countFigures,
  displayPath,
  launchBrowser,
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
} from "./lib.mjs";

const USAGE = `使い方: pnpm run figures:shot -- <ページ>... [オプション]

<ページ> はルート（math/vector-calculus/curl）・URL のパス・章ファイルのパスのいずれか。
末尾が / のフォルダは、その下の全ページに展開する。

オプション:
  --only 1,3          撮る図の番号（既定: すべて）
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
};

/** 撮影の前に図のキャプションを消す。配置の計算から外すため、visibility ではなく display を使う。 */
const NO_CAPTION_STYLE = ".sl-markdown-content figure figcaption { display: none !important; }";

async function main() {
  const { values, positionals } = parseCli(OPTIONS, USAGE);
  const themes = parseThemes(values.theme);
  const scale = parsePositive(values.scale, "scale");
  const only = values.only === undefined ? null : parseFigureList(values.only);
  const outDir = path.resolve(values.out);
  if (positionals.length === 0) {
    throw new UsageError(`撮るページを指定する。\n\n${USAGE}`);
  }

  const target = await openTarget(values);
  let browser = null;
  let written = 0;
  try {
    const routes = resolvePages(positionals, { distDir: target.distDir });
    browser = await launchBrowser();
    for (const theme of themes) {
      const context = await newThemedContext(browser, { theme, scale });
      for (const route of routes) {
        const url = pageUrl(target.baseUrl, route);
        const page = await openPage(context, url, theme);
        if (values["no-caption"]) await page.addStyleTag({ content: NO_CAPTION_STYLE });
        const total = await countFigures(page);
        const numbers = only ?? Array.from({ length: total }, (_, i) => i + 1);
        const missing = numbers.filter((n) => n > total);
        if (missing.length > 0) {
          console.warn(`警告: ${route} に図 ${missing.join("・")} は無い（図は ${total} 枚）`);
        }
        const dir = path.join(outDir, pageName(route));
        mkdirSync(dir, { recursive: true });
        for (const n of numbers.filter((m) => m <= total)) {
          const file = path.join(dir, `fig-${String(n).padStart(2, "0")}-${theme}.png`);
          await shootFigure(page, n, file);
          console.log(displayPath(file));
          written += 1;
        }
        await page.close();
      }
      await context.close();
    }
  } finally {
    await closeAll(browser, target);
  }
  console.log(`${written} 枚を書き出した。`);
}

runMain(main);
