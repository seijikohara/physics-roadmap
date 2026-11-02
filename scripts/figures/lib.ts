// 図の撮影・計測・比較のスクリプト（shot・lint・diff）が共有する処理。
// 対象サイトの用意（dev サーバの URL か、ビルド結果を配信する静的サーバ）、ページの指定の解決、
// テーマを固定したブラウザの用意を受け持つ。
// 計算（ページの指定の解決・応答の組み立て）は純粋な関数にし、入出力とブラウザ・サーバの起動と
// 後始末は main とその直下の関数に寄せる。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CONTENT_DIR = path.join(ROOT, "src/content/docs");
export const DEFAULT_URL = "http://localhost:4321/physics-roadmap";

/** 章のキャプション「図 N」と番号をそろえるため、記事本文の中の figure だけを数える。 */
export const FIGURE_SELECTOR = ".sl-markdown-content figure";

/** 撮影の邪魔になる固定ヘッダーを隠す。fixed 配置なので、隠しても本文の配置は変わらない。 */
const SHOT_STYLE = "header.header { visibility: hidden !important; }";

const VIEWPORT = { width: 1280, height: 900 } as const;

export type Theme = "light" | "dark";

/** 閉じられる資源（静的サーバなど）。 */
export type Closable = Readonly<{ close: () => Promise<void> }>;

/** 静的サーバ。 */
export type StaticServer = Readonly<{ baseUrl: string; close: () => Promise<void> }>;

/** 対象のサイト。--dist のときは静的サーバを持つ。 */
export type Target = Readonly<{
  baseUrl: string;
  distDir: string | null;
  close: () => Promise<void>;
}>;

/** 使い方の誤り。終了コード 2 で終える。 */
export class UsageError extends Error {}

/** parseArgs に渡すオプションの定義。各スクリプトは `as const` の定数表で与える。 */
type OptionsConfig = Readonly<
  Record<
    string,
    Readonly<{ type: "string" | "boolean"; default?: string | boolean; short?: string }>
  >
>;

/**
 * コマンドライン引数を `node:util` の parseArgs で解析する。
 *
 * `pnpm run <script> -- <args>` は `--` をそのままスクリプトへ渡すことがある。parseArgs は `--` の
 * 後ろをすべて位置引数として扱い、後続のオプションを読まなくなるため、先頭の `--` を取り除く。
 */
export function parseCli<const O extends OptionsConfig>(options: O, usage: string) {
  const raw = process.argv.slice(2);
  const args = raw[0] === "--" ? raw.slice(1) : raw;
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    process.exit(0);
  }
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(`引数を解釈できない: ${errorMessage(error)}\n\n${usage}`);
  }
}

/** 例外の値から 1 行目のメッセージを取り出す。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * スクリプトの main を実行し、エラーなら終了コード 2 で終える。
 *
 * 終了コード 1 は figures:lint の `--fail-on` の該当に充てるため、エラーは 2 で区別する。
 */
export function runMain(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    const message = errorMessage(error);
    console.error(error instanceof UsageError ? message : `エラー: ${message}`);
    process.exitCode = 2;
  });
}

/** 正の数のオプションを解析する。正の数でなければ使い方の誤りとする。 */
export function parsePositive(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`--${name} には正の数を指定する: ${value}`);
  }
  return n;
}

/** `--theme` の値に対応するテーマの並びを返す。 */
export function parseThemes(value: string): readonly Theme[] {
  if (value === "both") return ["light", "dark"];
  if (value === "light" || value === "dark") return [value];
  throw new UsageError(`--theme は light・dark・both のいずれか: ${value}`);
}

/** astro.config.ts の `base:` のパス（例: "/physics-roadmap"）を読む。 */
export function readBasePath(): string {
  const config = readFileSync(path.join(ROOT, "astro.config.ts"), "utf8");
  const m = /^\s*base:\s*["'`]([^"'`]*)["'`]/m.exec(config);
  return m === null ? "" : `/${(m[1] ?? "").replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "");
}

const MIME: Readonly<Record<string, string>> = {
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
const TEXT_TYPE = "text/plain; charset=utf-8";

/** 静的サーバの 1 回の応答。 */
type Reply = Readonly<{
  status: number;
  type: string;
  body: string | Uint8Array;
  headers?: Readonly<Record<string, string>>;
}>;

/**
 * リクエストのパスから応答を組み立てる。ファイルを読むほかに副作用を持たない。
 *
 * 本番と同じ base パスの下に置くのは、Astro が出力するアセットの URL が base 付きの絶対パスだからである。
 */
async function replyFor(root: string, basePath: string, requestUrl: string): Promise<Reply> {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
    return { status: 404, type: TEXT_TYPE, body: "not found" };
  }
  const requested = path.join(root, pathname.slice(basePath.length));
  // base の外のファイルを読ませない。
  if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) {
    return { status: 403, type: TEXT_TYPE, body: "forbidden" };
  }
  const isDirectory = existsSync(requested) && statSync(requested).isDirectory();
  if (isDirectory && !pathname.endsWith("/")) {
    return { status: 301, type: TEXT_TYPE, body: "", headers: { Location: `${pathname}/` } };
  }
  const file = isDirectory ? path.join(requested, "index.html") : requested;
  if (!existsSync(file)) {
    const notFound = path.join(root, "404.html");
    const body = existsSync(notFound) ? await readFile(notFound) : "not found";
    return { status: 404, type: MIME.html ?? TEXT_TYPE, body };
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  return { status: 200, type: MIME[ext] ?? "application/octet-stream", body: await readFile(file) };
}

/** ビルド結果のフォルダを、空きポートの静的サーバでサイトの base パスの下に配信する。 */
export async function startStaticServer(distDir: string, basePath: string): Promise<StaticServer> {
  const root = path.resolve(distDir);
  if (!existsSync(path.join(root, "index.html")) && !existsSync(path.join(root, "404.html"))) {
    throw new UsageError(`ビルド結果のフォルダではない（index.html が無い）: ${distDir}`);
  }
  const server = createServer((req, res) => {
    void replyFor(root, basePath, req.url ?? "/")
      .catch((error: unknown): Reply => ({ status: 500, type: TEXT_TYPE, body: String(error) }))
      .then((reply) => {
        res.writeHead(reply.status, { "Content-Type": reply.type, ...reply.headers });
        res.end(reply.body);
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}${basePath}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // ブラウザが保持する keep-alive の接続が残ると close が終わらない。
        server.closeAllConnections();
      }),
  };
}

/** `--dist` の値から、ビルド結果のフォルダの絶対パスを返す（`--url` のときは null）。 */
export function distDirOf(values: Readonly<{ url?: string; dist?: string }>): string | null {
  if (values.url !== undefined && values.dist !== undefined) {
    throw new UsageError("--url と --dist は同時に指定できない");
  }
  return values.dist === undefined ? null : path.resolve(values.dist);
}

/**
 * `--url` か `--dist` から対象のサイトを用意する。
 *
 * `--dist` のときは静的サーバを立て、`close()` で止める。
 */
export async function openTarget(
  values: Readonly<{ url?: string; dist?: string }>,
): Promise<Target> {
  const distDir = distDirOf(values);
  if (distDir !== null) {
    const server = await startStaticServer(distDir, readBasePath());
    return { baseUrl: server.baseUrl, distDir, close: server.close };
  }
  const baseUrl = (values.url ?? DEFAULT_URL).replace(/\/+$/, "");
  return { baseUrl, distDir: null, close: async () => {} };
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** アセットと検索索引のフォルダには HTML のページが無い。 */
const NON_PAGE_DIRS: ReadonlySet<string> = new Set(["_astro", "pagefind"]);

const joinRoute = (rel: string, name: string): string => (rel === "" ? name : `${rel}/${name}`);

function walkDist(distDir: string, rel: string): readonly string[] {
  const dir = path.join(distDir, rel);
  if (!existsSync(dir)) return [];
  const here = existsSync(path.join(dir, "index.html")) ? [rel] : [];
  const below = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !(rel === "" && NON_PAGE_DIRS.has(entry.name)))
    .flatMap((entry) => walkDist(distDir, joinRoute(rel, entry.name)));
  return [...here, ...below];
}

/** ビルド結果のフォルダの下の全ページ（index.html のあるフォルダ）のルートを返す。 */
export function listDistPages(distDir: string, sub = ""): readonly string[] {
  return walkDist(distDir, sub).toSorted(compareText);
}

/** src/content/docs からの相対パスをルートに直す（"a/b.mdx" → "a/b"、"a/index.md" → "a"）。 */
function fileToRoute(rel: string): string {
  return rel
    .replace(/\.mdx?$/, "")
    .replace(/(^|\/)index$/, "")
    .replace(/\/+$/, "");
}

function walkContent(rel: string): readonly string[] {
  const dir = path.join(CONTENT_DIR, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = joinRoute(rel, entry.name);
    if (entry.isDirectory()) return walkContent(child);
    return /\.mdx?$/.test(entry.name) ? [fileToRoute(child)] : [];
  });
}

/** src/content/docs の下の全章ファイル（.md/.mdx）のルートを返す。 */
export function listContentPages(sub = ""): readonly string[] {
  return walkContent(sub).toSorted(compareText);
}

/** ページの指定 1 つを正規化した結果。末尾が `/` の指定は folder を真にする。 */
type PageSpec = Readonly<{ route: string; folder: boolean }>;

const trimSlashes = (s: string): string => s.replace(/^\/+|\/+$/g, "");

/** ページの指定 1 つを正規化する。ルート・URL・URL のパス・章ファイルのパスのどれでも受け付ける。 */
function normalizeSpec(spec: string, basePath: string): PageSpec {
  const slashed = spec.trim().replaceAll("\\", "/");
  const fromUrl = /^https?:\/\//.test(slashed) ? new URL(slashed).pathname : slashed;
  const relative =
    path.isAbsolute(fromUrl) && fromUrl.startsWith(ROOT)
      ? path.relative(ROOT, fromUrl).replaceAll("\\", "/")
      : fromUrl;
  const s = relative.replace(/^\.\//, "");
  const contentPrefix = "src/content/docs";
  if (s === contentPrefix || s.startsWith(`${contentPrefix}/`)) {
    const rel = s.slice(contentPrefix.length).replace(/^\/+/, "");
    if (/\.mdx?$/.test(rel)) return { route: fileToRoute(rel), folder: false };
    return { route: rel.replace(/\/+$/, ""), folder: true };
  }
  const underBase =
    basePath !== "" && (s === basePath || s.startsWith(`${basePath}/`))
      ? s.slice(basePath.length)
      : s;
  const page = underBase.replace(/index\.html$/, "");
  return { route: trimSlashes(page), folder: page.endsWith("/") && trimSlashes(page) !== "" };
}

/** ページの指定 1 つを、ルートの並びに展開する。 */
function expandSpec(spec: string, basePath: string, distDir: string | null): readonly string[] {
  const { route, folder } = normalizeSpec(spec, basePath);
  if (folder) {
    const expanded = distDir === null ? listContentPages(route) : listDistPages(distDir, route);
    if (expanded.length > 0) return expanded;
    // URL のパス（…/curl/）は末尾が / でも 1 ページを指す。章のフォルダが無ければ 1 ページとして扱う。
    if (distDir !== null) throw new UsageError(`フォルダの下にページが無い: ${spec}`);
  }
  if (distDir !== null && !existsSync(path.join(distDir, route, "index.html"))) {
    throw new UsageError(`ビルド結果にページが無い: ${spec}（${path.join(distDir, route)}）`);
  }
  return [route];
}

/**
 * ページの指定を、重複のないルートの並びに解決する。
 *
 * `--dist` のときは、末尾がフォルダの指定と `--all` をビルド結果の index.html から展開する。
 * `--url` のときはサーバの中を列挙できないため、同じ指定を src/content/docs の章ファイルから展開する。
 */
export function resolvePages(
  specs: readonly string[],
  options: Readonly<{ distDir: string | null; all?: boolean }>,
): readonly string[] {
  const basePath = readBasePath();
  const { distDir } = options;
  const everything =
    options.all === true ? (distDir === null ? listContentPages() : listDistPages(distDir)) : [];
  const listed = specs.flatMap((spec) => expandSpec(spec, basePath, distDir));
  // Set は最初に現れた順を保つので、指定の順のまま重複を除ける。
  return [...new Set([...everything, ...listed])];
}

/** ルートから出力フォルダ名を作る（"math/vector-calculus/curl" → "math-vector-calculus-curl"）。 */
export function pageName(route: string): string {
  return route === "" ? "index" : route.replaceAll("/", "-");
}

/** base URL の下のルートのページ URL を返す（末尾に必ず / を付ける）。 */
export function pageUrl(baseUrl: string, route: string): string {
  return route === "" ? `${baseUrl}/` : `${baseUrl}/${route}/`;
}

/** "1,3" のような図番号の並びを、昇順の配列に解析する。 */
export function parseFigureList(value: string): readonly number[] {
  const nums = value.split(",").map((t) => Number(t.trim()));
  if (nums.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new UsageError(`--only には 1 以上の図番号をカンマ区切りで指定する: ${value}`);
  }
  return [...new Set(nums)].toSorted((a, b) => a - b);
}

/** 非同期の処理を、並びの順に 1 つずつ実行して結果を集める。 */
export async function mapSeries<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  return items.reduce<Promise<readonly R[]>>(
    async (done, item, index) => [...(await done), await fn(item, index)],
    Promise.resolve([]),
  );
}

/** インストール済みの Google Chrome を playwright-core で起動する。 */
export async function launchBrowser(): Promise<Browser> {
  try {
    // Playwright のブラウザはダウンロードせず、インストール済みの Chrome を使う。
    return await chromium.launch({ channel: "chrome" });
  } catch (error) {
    const detail = errorMessage(error).split("\n")[0] ?? "";
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
export async function closeAll(
  browser: Browser | null,
  closables: readonly Closable[],
): Promise<void> {
  await Promise.allSettled([browser?.close(), ...closables.map((c) => c.close())]);
}

/**
 * ブラウザを起動して fn を実行し、成否にかかわらずブラウザと closables を閉じる。
 *
 * ブラウザの起動に失敗したときも closables（起動済みの静的サーバ）を閉じる。
 */
export async function withBrowser<R>(
  closables: readonly Closable[],
  fn: (browser: Browser) => Promise<R>,
): Promise<R> {
  const browser = await launchBrowser().catch(async (error: unknown) => {
    await closeAll(null, closables);
    throw error;
  });
  try {
    return await fn(browser);
  } finally {
    await closeAll(browser, closables);
  }
}

/**
 * tsx（esbuild の keepNames）は関数の名前を保つため、ソースに `__name(...)` の呼び出しを差し込む。
 * page.evaluate へ渡す関数はソースの文字列としてブラウザへ送られるので、ブラウザ側にも同じ名前の
 * 関数が要る。名前を付けずに対象をそのまま返す代わりの関数を、ページの読み込み前に入れておく。
 */
const NAME_HELPER = "globalThis.__name = (target) => target;";

/**
 * Starlight のテーマを `theme` に固定したブラウザのコンテキストを作る。
 *
 * colorScheme だけでは足りない。Starlight の ThemeProvider は localStorage の `starlight-theme` を
 * 最優先で読むため、初期化スクリプトで同じ値を書き込んでおく。初期化スクリプトは文字列で渡し、
 * `__name` の差し込みを避ける。
 */
export async function newThemedContext(
  browser: Browser,
  options: Readonly<{ theme: Theme; scale: number }>,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    colorScheme: options.theme,
    deviceScaleFactor: options.scale,
    viewport: VIEWPORT,
  });
  await context.addInitScript({ content: NAME_HELPER });
  await context.addInitScript({
    content: `try { localStorage.setItem("starlight-theme", ${JSON.stringify(options.theme)}); } catch {}`,
  });
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(60_000);
  return context;
}

/**
 * ページを開き、Web フォントの読み込みを待って、テーマを確かめる。
 *
 * KaTeX と本文のフォントが読み込まれる前に撮ると、字形や計測した範囲が変わる。
 */
export async function openPage(context: BrowserContext, url: string, theme: Theme): Promise<Page> {
  const page = await context.newPage();
  const response = await page.goto(url, { waitUntil: "load" }).catch(async (error: unknown) => {
    await page.close();
    const detail = errorMessage(error).split("\n")[0] ?? "";
    throw new Error(
      `ページを開けない: ${url}\n` +
        "dev サーバ（pnpm dev）が起動しているか確かめる。ビルド結果を使うときは --dist を指定する。" +
        `\n詳細: ${detail}`,
      { cause: error },
    );
  });
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
export async function countFigures(page: Page): Promise<number> {
  return page.locator(FIGURE_SELECTOR).count();
}

/** 図 `n`（1 始まり）を要素のスクリーンショットで撮り、PNG のバイト列を返す。 */
export async function shootFigure(page: Page, n: number, outPath?: string): Promise<Buffer> {
  return page
    .locator(FIGURE_SELECTOR)
    .nth(n - 1)
    .screenshot({ ...(outPath === undefined ? {} : { path: outPath }), animations: "disabled" });
}

/** 表示用に、パスを作業ディレクトリからの相対パスにする。 */
export function displayPath(p: string): string {
  const rel = path.relative(process.cwd(), p);
  return rel.startsWith("..") ? p : rel;
}
