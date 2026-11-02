// 図の撮影・計測・比較のスクリプト（shot・lint・diff）が共有する処理。
// 対象サイトの用意（dev サーバの URL か、ビルド結果を配信する静的サーバ）、ページの指定の解決、
// テーマを固定したブラウザの用意を受け持つ。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CONTENT_DIR = path.join(ROOT, "src/content/docs");
export const DEFAULT_URL = "http://localhost:4321/physics-roadmap";

/** 章のキャプション「図 N」と番号をそろえるため、記事本文の中の figure だけを数える。 */
export const FIGURE_SELECTOR = ".sl-markdown-content figure";

/** 撮影の邪魔になる固定ヘッダーを隠す。fixed 配置なので、隠しても本文の配置は変わらない。 */
const SHOT_STYLE = "header.header { visibility: hidden !important; }";

const VIEWPORT = { width: 1280, height: 900 };

/** 使い方の誤り。終了コード 2 で終える。 */
export class UsageError extends Error {}

/**
 * コマンドライン引数を `node:util` の parseArgs で解析する。
 *
 * `pnpm run <script> -- <args>` は `--` をそのままスクリプトへ渡すことがある。parseArgs は `--` の
 * 後ろをすべて位置引数として扱い、後続のオプションを読まなくなるため、先頭の `--` を取り除く。
 */
export function parseCli(options, usage) {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    process.exit(0);
  }
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(`引数を解釈できない: ${error.message}\n\n${usage}`);
  }
}

/**
 * スクリプトの main を実行し、エラーなら終了コード 2 で終える。
 *
 * 終了コード 1 は figures:lint の `--fail-on` の該当に充てるため、エラーは 2 で区別する。
 */
export function runMain(main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error instanceof UsageError ? message : `エラー: ${message}`);
    process.exitCode = 2;
  });
}

/** 正の数のオプションを解析する。正の数でなければ使い方の誤りとする。 */
export function parsePositive(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0)
    throw new UsageError(`--${name} には正の数を指定する: ${value}`);
  return n;
}

/** `--theme` の値に対応するテーマの並びを返す。 */
export function parseThemes(value) {
  if (value === "both") return ["light", "dark"];
  if (value === "light" || value === "dark") return [value];
  throw new UsageError(`--theme は light・dark・both のいずれか: ${value}`);
}

/** astro.config.mjs の `base:` のパス（例: "/physics-roadmap"）を読む。 */
export function readBasePath() {
  const config = readFileSync(path.join(ROOT, "astro.config.mjs"), "utf8");
  const m = config.match(/^\s*base:\s*["'`]([^"'`]*)["'`]/m);
  return m ? `/${m[1].replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "") : "";
}

const MIME = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ico: "image/x-icon",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

/**
 * ビルド結果のフォルダを、空きポートの静的サーバでサイトの base パスの下に配信する。
 *
 * 本番と同じ base パスの下に置くのは、Astro が出力するアセットの URL が base 付きの絶対パスだからである。
 */
export async function startStaticServer(distDir, basePath) {
  const root = path.resolve(distDir);
  if (!existsSync(path.join(root, "index.html")) && !existsSync(path.join(root, "404.html"))) {
    throw new UsageError(`ビルド結果のフォルダではない（index.html が無い）: ${distDir}`);
  }
  const server = createServer((req, res) => {
    void serveFile(root, basePath, req, res);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}${basePath}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        // ブラウザが保持する keep-alive の接続が残ると close が終わらない。
        server.closeAllConnections();
      }),
  };
}

async function serveFile(root, basePath, req, res) {
  const send = (status, body, type = MIME.txt, headers = {}) => {
    res.writeHead(status, { "Content-Type": type, ...headers });
    res.end(body);
  };
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      send(404, "not found");
      return;
    }
    let file = path.join(root, pathname.slice(basePath.length));
    // base の外のファイルを読ませない。
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
      send(403, "forbidden");
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!pathname.endsWith("/")) {
        send(301, "", MIME.txt, { Location: `${pathname}/` });
        return;
      }
      file = path.join(file, "index.html");
    }
    if (!existsSync(file)) {
      const notFound = path.join(root, "404.html");
      send(404, existsSync(notFound) ? await readFile(notFound) : "not found", MIME.html);
      return;
    }
    const ext = path.extname(file).slice(1).toLowerCase();
    send(200, await readFile(file), MIME[ext] ?? "application/octet-stream");
  } catch (error) {
    send(500, String(error));
  }
}

/**
 * `--url` か `--dist` から対象のサイトを用意する。
 *
 * `--dist` のときは静的サーバを立て、`close()` で止める。
 */
export async function openTarget(values) {
  if (values.url !== undefined && values.dist !== undefined) {
    throw new UsageError("--url と --dist は同時に指定できない");
  }
  if (values.dist !== undefined) {
    const distDir = path.resolve(values.dist);
    const server = await startStaticServer(distDir, readBasePath());
    return { baseUrl: server.baseUrl, distDir, close: server.close };
  }
  const baseUrl = (values.url ?? DEFAULT_URL).replace(/\/+$/, "");
  return { baseUrl, distDir: null, close: async () => {} };
}

const compareRoutes = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** ビルド結果のフォルダの下の全ページ（index.html のあるフォルダ）のルートを返す。 */
export function listDistPages(distDir, sub = "") {
  const out = [];
  const walk = (rel) => {
    const dir = path.join(distDir, rel);
    if (!existsSync(dir)) return;
    if (existsSync(path.join(dir, "index.html"))) out.push(rel);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // アセットと検索索引のフォルダには HTML のページが無い。
      if (!entry.isDirectory() || (rel === "" && ["_astro", "pagefind"].includes(entry.name))) {
        continue;
      }
      walk(rel === "" ? entry.name : `${rel}/${entry.name}`);
    }
  };
  walk(sub);
  return out.toSorted(compareRoutes);
}

/** src/content/docs の下の全章ファイル（.md/.mdx）のルートを返す。 */
export function listContentPages(sub = "") {
  const out = [];
  const walk = (rel) => {
    const dir = path.join(CONTENT_DIR, rel);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.mdx?$/.test(entry.name)) out.push(fileToRoute(child));
    }
  };
  walk(sub);
  return out.toSorted(compareRoutes);
}

/** src/content/docs からの相対パスをルートに直す（"a/b.mdx" → "a/b"、"a/index.md" → "a"）。 */
function fileToRoute(rel) {
  return rel
    .replace(/\.mdx?$/, "")
    .replace(/(^|\/)index$/, "")
    .replace(/\/+$/, "");
}

/**
 * ページの指定 1 つを `{ route, folder }` に正規化する。
 *
 * ルート・URL・URL のパス・章ファイルのパスのどれでも受け付ける。末尾が `/` なら folder を真にする。
 */
function normalizeSpec(spec, basePath) {
  let s = spec.trim().replaceAll("\\", "/");
  if (/^https?:\/\//.test(s)) s = new URL(s).pathname;
  if (path.isAbsolute(s) && s.startsWith(ROOT)) s = path.relative(ROOT, s).replaceAll("\\", "/");
  s = s.replace(/^\.\//, "");
  const contentPrefix = "src/content/docs";
  if (s === contentPrefix || s.startsWith(`${contentPrefix}/`)) {
    const rel = s.slice(contentPrefix.length).replace(/^\/+/, "");
    if (/\.mdx?$/.test(rel)) return { route: fileToRoute(rel), folder: false };
    return { route: rel.replace(/\/+$/, ""), folder: true };
  }
  if (basePath !== "" && (s === basePath || s.startsWith(`${basePath}/`))) {
    s = s.slice(basePath.length);
  }
  s = s.replace(/index\.html$/, "");
  const folder = s.endsWith("/") && s.replace(/^\/+|\/+$/g, "") !== "";
  return { route: s.replace(/^\/+|\/+$/g, ""), folder };
}

/**
 * ページの指定を、重複のないルートの並びに解決する。
 *
 * `--dist` のときは、末尾がフォルダの指定と `--all` をビルド結果の index.html から展開する。
 * `--url` のときはサーバの中を列挙できないため、同じ指定を src/content/docs の章ファイルから展開する。
 */
export function resolvePages(specs, { distDir, all = false }) {
  const basePath = readBasePath();
  const routes = [];
  const add = (r) => {
    if (!routes.includes(r)) routes.push(r);
  };
  if (all) {
    for (const r of distDir ? listDistPages(distDir) : listContentPages()) add(r);
  }
  for (const spec of specs) {
    const { route, folder } = normalizeSpec(spec, basePath);
    if (folder) {
      const expanded = distDir ? listDistPages(distDir, route) : listContentPages(route);
      if (expanded.length > 0) {
        for (const r of expanded) add(r);
        continue;
      }
      // URL のパス（…/curl/）は末尾が / でも 1 ページを指す。章のフォルダが無ければ 1 ページとして扱う。
      if (distDir) throw new UsageError(`フォルダの下にページが無い: ${spec}`);
    }
    if (distDir && !existsSync(path.join(distDir, route, "index.html"))) {
      throw new UsageError(`ビルド結果にページが無い: ${spec}（${path.join(distDir, route)}）`);
    }
    add(route);
  }
  return routes;
}

/** ルートから出力フォルダ名を作る（"math/vector-calculus/curl" → "math-vector-calculus-curl"）。 */
export function pageName(route) {
  return route === "" ? "index" : route.replaceAll("/", "-");
}

/** base URL の下のルートのページ URL を返す（末尾に必ず / を付ける）。 */
export function pageUrl(baseUrl, route) {
  return route === "" ? `${baseUrl}/` : `${baseUrl}/${route}/`;
}

/** "1,3" のような図番号の並びを、昇順の配列に解析する。 */
export function parseFigureList(value) {
  const nums = value.split(",").map((t) => Number(t.trim()));
  if (nums.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new UsageError(`--only には 1 以上の図番号をカンマ区切りで指定する: ${value}`);
  }
  return [...new Set(nums)].toSorted((a, b) => a - b);
}

/** インストール済みの Google Chrome を playwright-core で起動する。 */
export async function launchBrowser() {
  try {
    // Playwright のブラウザはダウンロードせず、インストール済みの Chrome を使う。
    return await chromium.launch({ channel: "chrome" });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(
      "Google Chrome を起動できない。図のスクリプトはインストール済みの Google Chrome を使う。" +
        `Chrome をインストールしてから再実行する。\n詳細: ${detail}`,
      { cause: error },
    );
  }
}

/**
 * ブラウザと静的サーバをすべて閉じる。
 *
 * 1 つの close が失敗しても残りを閉じる。listen 中のサーバが残ると、プロセスが終了しないためである。
 */
export async function closeAll(browser, ...servers) {
  await Promise.allSettled([browser?.close(), ...servers.map((s) => s.close())]);
}

/**
 * Starlight のテーマを `theme` に固定したブラウザのコンテキストを作る。
 *
 * colorScheme だけでは足りない。Starlight の ThemeProvider は localStorage の `starlight-theme` を
 * 最優先で読むため、初期化スクリプトで同じ値を書き込んでおく。
 */
export async function newThemedContext(browser, { theme, scale }) {
  const context = await browser.newContext({
    colorScheme: theme,
    deviceScaleFactor: scale,
    viewport: VIEWPORT,
  });
  await context.addInitScript((t) => {
    try {
      localStorage.setItem("starlight-theme", t);
    } catch {
      // localStorage が使えないページ（about:blank など）では何もしない。
    }
  }, theme);
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(60_000);
  return context;
}

/**
 * ページを開き、Web フォントの読み込みを待って、テーマを確かめる。
 *
 * KaTeX と本文のフォントが読み込まれる前に撮ると、字形や計測した範囲が変わる。
 */
export async function openPage(context, url, theme) {
  const page = await context.newPage();
  let response;
  try {
    response = await page.goto(url, { waitUntil: "load" });
  } catch (error) {
    await page.close();
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(
      `ページを開けない: ${url}\n` +
        "dev サーバ（pnpm dev）が起動しているか確かめる。ビルド結果を使うときは --dist を指定する。" +
        `\n詳細: ${detail}`,
      { cause: error },
    );
  }
  if (response === null || !response.ok()) {
    await page.close();
    throw new Error(`ページを開けない: ${url}（HTTP ${response?.status() ?? "応答なし"}）`);
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const actual = await page.evaluate(() => document.documentElement.dataset.theme);
  if (actual !== theme) {
    console.warn(`警告: テーマを ${theme} に固定できなかった（実際は ${actual}）: ${url}`);
  }
  await page.addStyleTag({ content: SHOT_STYLE });
  return page;
}

/** 記事本文の図の数を返す。 */
export async function countFigures(page) {
  return page.locator(FIGURE_SELECTOR).count();
}

/** 図 `n`（1 始まり）を要素のスクリーンショットで撮り、PNG のバッファを返す。 */
export async function shootFigure(page, n, outPath) {
  return page
    .locator(FIGURE_SELECTOR)
    .nth(n - 1)
    .screenshot({ path: outPath, animations: "disabled" });
}

/** 表示用に、パスを作業ディレクトリからの相対パスにする。 */
export function displayPath(p) {
  const rel = path.relative(process.cwd(), p);
  return rel.startsWith("..") ? p : rel;
}
