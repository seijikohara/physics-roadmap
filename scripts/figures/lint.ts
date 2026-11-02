// 図の中のラベルと線・点・他のラベルとの重なりと近接、図の外へのはみ出しを、ブラウザで計測して一覧にする。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { BrowserContext } from "playwright-core";
import {
  UsageError,
  displayPath,
  distDirOf,
  mapSeries,
  newThemedContext,
  openPage,
  openTarget,
  pageUrl,
  parseCli,
  parsePositive,
  resolvePages,
  runMain,
  withBrowser,
} from "./lib.ts";

const USAGE = `使い方: pnpm run figures:lint -- [<ページ>...] [オプション]

<ページ> はルート（math/vector-calculus/curl）・URL のパス・章ファイルのパスのいずれか。
末尾が / のフォルダは、その下の全ページに展開する。

オプション:
  --all               全ページを検査する（--dist ならビルド結果、--url なら src/content/docs の章）
  --near <px>         近接とみなす距離の上限（既定: 4）。距離 0 以下は重なり（overlap）
  --json <パス>       詳細を JSON で書き出す（--compare の基準に使える）
  --labels <パス>     全ラベルの名前・フォントサイズ・字形の矩形（図 SVG の座標系）を JSON で書き出す
  --compare <パス>    --json で書き出した基準と比べ、図ごとに増えた所見と消えた所見だけを出す
                      （所見はページ・図番号・ラベル名・相手・種別で照合し、距離の違いは無視する）
  --fail-on <種別>    overlap なら overlap・outside、near なら near も含めて、該当があれば終了コード 1
                      （--compare と併用したときは、増えた所見だけで判定する）
  --url <URL>         対象サイトの base URL（既定: http://localhost:4321/physics-roadmap）
  --dist <フォルダ>   ビルド結果を静的サーバで配信して検査する（--url の代わり）`;

const OPTIONS = {
  all: { type: "boolean", default: false },
  near: { type: "string", default: "4" },
  json: { type: "string" },
  labels: { type: "string" },
  compare: { type: "string" },
  "fail-on": { type: "string" },
  url: { type: "string" },
  dist: { type: "string" },
} as const;

/** 線の標本の間隔（画面の px）と、1 要素あたりの標本数の上限。 */
const SAMPLE_STEP = 2;
const MAX_SAMPLES = 3000;
/** 矢じり・点とみなす小さな塗りの外接矩形の上限（画面の px）。 */
const SMALL_FILL = 24;

// ここから下の型は、ブラウザの中の計測と、Node 側の集計の両方で使う。計測の結果は JSON として
// ブラウザから受け取り、--json の出力と --compare の基準にもそのまま使う。

/** 矩形（左・上・右・下）。 */
type Box = Readonly<{ l: number; t: number; r: number; b: number }>;
/** 点。 */
type Pt = Readonly<{ x: number; y: number }>;
/** 所見の種別。 */
type Kind = "overlap" | "near" | "outside";
/** 所見の相手。図形・marker・ラベル・図の表示範囲のいずれか。 */
type Partner = Readonly<{
  type: "line" | "fill" | "marker" | "label" | "svg";
  tag?: string;
  stroke?: string;
  fill?: string;
  className?: string;
  name?: string;
  labelBox?: Box;
}>;
/** 1 件の所見。同じラベルと同じ見た目の相手の組は 1 件にまとめ、件数を count に持つ。 */
type Finding = Readonly<{
  label: string;
  labelBox: Box;
  partner: Partner;
  distance: number;
  kind: Kind;
  at?: Pt;
  count: number;
}>;
/** --labels に書き出すラベルの寸法（図 SVG の座標系）。 */
type LabelInfo = Readonly<{
  name: string;
  fontSize: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}>;
/** 図 SVG 1 枚の計測の結果。 */
type SvgResult = Readonly<{
  className: string;
  labels: number;
  findings: readonly Finding[];
  labelList?: readonly LabelInfo[];
}>;
/** 図 1 つの計測の結果。 */
type FigureResult = Readonly<{ figure: number; svgs: readonly SvgResult[] }>;
/** ページ 1 つの計測の結果。 */
type PageResult = Readonly<{ route: string; url: string; figures: readonly FigureResult[] }>;
/** 計測の設定。 */
type MeasureOptions = Readonly<{
  near: number;
  sampleStep: number;
  maxSamples: number;
  smallFill: number;
}>;

// ブラウザの中だけで使う型。
/** 線・輪郭の標本。s は線の始点からの長さ、brk は図形の切れ目、edge は切り取られた端を表す。 */
type Sample = Readonly<{
  x: number;
  y: number;
  visible: boolean;
  s?: number;
  cut?: boolean;
  edge?: boolean;
  brk?: boolean;
}>;
/** 破線の模様（1 周期の中の描画区間と、周期・ずらし）。 */
type Dash = Readonly<{
  dashes: readonly (readonly [number, number])[];
  period: number;
  offset: number;
}>;
/** clip-path の矩形の組と、mask で隠れる矩形。 */
type Filter = Readonly<{ clips: readonly (readonly Box[])[]; holes: readonly Box[] }>;
/** 距離の計測の結果。 */
type Hit = Readonly<{ distance: number; at: Pt }>;
/** 障害物（線・小さな塗り・marker の矢じり）。 */
type Obstacle = Readonly<{
  kind: "line" | "fill" | "marker";
  el: SVGGeometryElement;
  geom: SVGGeometryElement;
  ctm: DOMMatrixReadOnly | null;
  scale: number;
  half: number;
  cap: string;
  dash: Dash | null;
  solid: boolean;
  rect: Box;
  reach: Box;
  node: Element | null;
  color?: string;
  samples?: readonly Sample[];
}>;
/** 計測するラベル。 */
type Label = Readonly<{
  el: SVGGraphicsElement;
  rects: readonly Box[];
  rect: Box;
  name: string;
  containers: readonly Element[];
}>;
/** ラベルの背景の板。 */
type Plate = Readonly<{ el: Element; rect: Box }>;
/** まとめる前の所見。key は同じ相手を見分けるための文字列。 */
type RawFinding = Readonly<{ key: string; finding: Omit<Finding, "count"> }>;

// page.evaluate はこの関数の本文だけをブラウザへ送るため、補助の関数も内側に置く必要がある。
/* oxlint-disable unicorn/consistent-function-scoping */
/**
 * 開いているページのすべての図 SVG について、ラベルごとの重なり・近接・はみ出しを計測する。
 *
 * ブラウザの中で実行する。page.evaluate へ渡すため、外側の変数を参照しない（型は消えるので使える）。
 * 座標はすべて画面の CSS px で扱う（getBoundingClientRect と getScreenCTM が同じ座標系を返す）。
 */
function measureFigures(options: MeasureOptions): readonly FigureResult[] {
  const { near, sampleStep, maxSamples, smallFill } = options;
  const SKIP_ANCESTORS: ReadonlySet<string> = new Set([
    "foreignObject",
    "defs",
    "clipPath",
    "mask",
    "marker",
    "pattern",
    "symbol",
  ]);
  const SHAPES = "path, line, polyline, polygon, circle, ellipse, rect";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
  const BREAK: Sample = { x: Number.NaN, y: Number.NaN, visible: false, brk: true };
  const ctx2d = document.createElement("canvas").getContext("2d");
  const pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const range = document.createRange();

  const box = (l: number, t: number, r: number, b: number): Box => ({ l, t, r, b });
  const fromDom = (d: DOMRectReadOnly): Box => box(d.left, d.top, d.right, d.bottom);
  const isEmpty = (d: DOMRectReadOnly): boolean => d.width <= 0 && d.height <= 0;
  const unionAll = (rs: readonly Box[]): Box =>
    rs.reduce(
      (a, c) => box(Math.min(a.l, c.l), Math.min(a.t, c.t), Math.max(a.r, c.r), Math.max(a.b, c.b)),
      box(Infinity, Infinity, -Infinity, -Infinity),
    );
  const intersect = (a: Box, c: Box): Box =>
    box(Math.max(a.l, c.l), Math.max(a.t, c.t), Math.min(a.r, c.r), Math.min(a.b, c.b));
  const inside = (p: Pt, r: Box): boolean => p.x >= r.l && p.x <= r.r && p.y >= r.t && p.y <= r.b;
  const contains = (outer: Box, r: Box, tolerance: number): boolean =>
    r.l >= outer.l - tolerance &&
    r.r <= outer.r + tolerance &&
    r.t >= outer.t - tolerance &&
    r.b <= outer.b + tolerance;
  const totalLength = (geom: SVGGeometryElement): number => {
    try {
      return geom.getTotalLength();
    } catch {
      return 0;
    }
  };
  const scaleOf = (ctm: DOMMatrixReadOnly | null): number =>
    ctm === null ? 1 : Math.sqrt(Math.abs(ctm.a * ctm.d - ctm.b * ctm.c));
  const transform = (x: number, y: number, ctm: DOMMatrixReadOnly | null): Pt => {
    if (ctm === null) return { x, y };
    const p = new DOMPoint(x, y).matrixTransform(ctm);
    return { x: p.x, y: p.y };
  };

  // 矩形どうしの符号つき距離。離れていれば隙間の長さ、重なっていれば食い込みの深さを負で返す。
  const rectRect = (a: Box, c: Box): number => {
    const dx = Math.max(c.l - a.r, a.l - c.r);
    const dy = Math.max(c.t - a.b, a.t - c.b);
    if (dx > 0 || dy > 0) return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    return Math.max(dx, dy);
  };
  const pointRect = (p: Pt, r: Box): number => rectRect(box(p.x, p.y, p.x, p.y), r);
  const pointSegment = (c: Pt, p: Pt, q: Pt): number => {
    const vx = q.x - p.x;
    const vy = q.y - p.y;
    const len2 = vx * vx + vy * vy;
    const t =
      len2 === 0 ? 0 : Math.max(0, Math.min(1, ((c.x - p.x) * vx + (c.y - p.y) * vy) / len2));
    return Math.hypot(c.x - (p.x + t * vx), c.y - (p.y + t * vy));
  };
  // 線分が矩形を横切るかを Liang–Barsky 法で判定する。線分の媒介変数の範囲 [t0, t1] を辺ごとに狭める。
  const segmentHits = (p: Pt, q: Pt, r: Box): boolean => {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const edges: readonly (readonly [number, number])[] = [
      [-dx, p.x - r.l],
      [dx, r.r - p.x],
      [-dy, p.y - r.t],
      [dy, r.b - p.y],
    ];
    const clipped = edges.reduce<Readonly<{ t0: number; t1: number; ok: boolean }>>(
      (acc, [pp, qq]) => {
        if (!acc.ok) return acc;
        if (pp === 0) return qq >= 0 ? acc : { ...acc, ok: false };
        const t = qq / pp;
        if (pp < 0) return t > acc.t1 ? { ...acc, ok: false } : { ...acc, t0: Math.max(acc.t0, t) };
        return t < acc.t0 ? { ...acc, ok: false } : { ...acc, t1: Math.min(acc.t1, t) };
      },
      { t0: 0, t1: 1, ok: true },
    );
    return clipped.ok;
  };
  const cornersOf = (r: Box): readonly Pt[] => [
    { x: r.l, y: r.t },
    { x: r.r, y: r.t },
    { x: r.r, y: r.b },
    { x: r.l, y: r.b },
  ];
  const segmentRect = (p: Pt, q: Pt, r: Box): number => {
    if (segmentHits(p, q, r)) return 0;
    return Math.min(
      pointRect(p, r),
      pointRect(q, r),
      ...cornersOf(r).map((c) => pointSegment(c, p, q)),
    );
  };

  const hasSkippedAncestor = (el: Element): boolean => {
    const parent = el.parentElement;
    return parent !== null && (SKIP_ANCESTORS.has(parent.localName) || hasSkippedAncestor(parent));
  };
  /** el から stop まで（stop を含む。stop が祖先でなければ文書の根まで）の祖先の並び。 */
  const chainTo = (el: Element, stop: Element): readonly Element[] => {
    const parent = el.parentElement;
    return el === stop || parent === null ? [el] : [el, ...chainTo(parent, stop)];
  };

  // 計算済みの色は rgb() のほか oklab() などでも返る。1 画素の canvas に塗って RGBA に直す。
  // 同じ色を何度も変換するため、関数の中に閉じたキャッシュ（可変の Map）に結果を覚える。
  const colorCache = new Map<string, Readonly<{ r: number; g: number; b: number; a: number }>>();
  const toRgba = (
    paint: string,
  ): Readonly<{ r: number; g: number; b: number; a: number }> | null => {
    if (paint === "" || paint === "none" || paint.startsWith("url(") || pixel === null) return null;
    const cached = colorCache.get(paint);
    if (cached !== undefined) return cached;
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = "#000";
    pixel.fillStyle = paint;
    pixel.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = pixel.getImageData(0, 0, 1, 1).data;
    const color = { r, g, b, a: a / 255 };
    colorCache.set(paint, color);
    return color;
  };
  const paintVisible = (paint: string): boolean => {
    if (paint === "" || paint === "none") return false;
    if (paint.startsWith("url(")) return true;
    const c = toRgba(paint);
    return c === null || c.a > 0;
  };
  const toHex = (paint: string): string => {
    const c = toRgba(paint);
    if (c === null) return paint;
    const hex = [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");
    return c.a < 1
      ? `#${hex}${Math.round(c.a * 255)
          .toString(16)
          .padStart(2, "0")}`
      : `#${hex}`;
  };
  const fillAlpha = (el: Element, svg: Element, cs: CSSStyleDeclaration): number =>
    chainTo(el, svg).reduce(
      (alpha, a) => alpha * Number.parseFloat(getComputedStyle(a).opacity),
      (toRgba(cs.fill)?.a ?? 1) * Number.parseFloat(cs.fillOpacity),
    );

  // clip-path と mask は図の部品が矩形で作る（プロット範囲のクリップ、ラベルの下の線の切り抜き）。
  // 見えない標本を障害物から外すため、祖先が参照する矩形を画面座標で集める。
  const refTarget = (value: string | null): Element | null => {
    const m = /url\(["']?#([^"')]+)["']?\)/.exec(value ?? "");
    return m === null ? null : document.getElementById(m[1] ?? "");
  };
  const userBox = (el: Element): Box | null => {
    try {
      if (el instanceof SVGRectElement) {
        return box(
          el.x.baseVal.value,
          el.y.baseVal.value,
          el.x.baseVal.value + el.width.baseVal.value,
          el.y.baseVal.value + el.height.baseVal.value,
        );
      }
      if (!(el instanceof SVGGraphicsElement)) return null;
      const b = el.getBBox();
      return box(b.x, b.y, b.x + b.width, b.y + b.height);
    } catch {
      return null;
    }
  };
  const transformBox = (b: Box, ctm: DOMMatrixReadOnly): Box =>
    unionAll(
      cornersOf(b).map((p) => {
        const q = transform(p.x, p.y, ctm);
        return box(q.x, q.y, q.x, q.y);
      }),
    );
  // 祖先ごとの clip・mask の矩形。同じ祖先を何度もたどるため、関数の中に閉じたキャッシュに覚える。
  const filterCache = new Map<
    Element,
    Readonly<{ clip: readonly Box[] | null; holes: readonly Box[] }>
  >();
  const ownFilter = (
    a: Element,
  ): Readonly<{ clip: readonly Box[] | null; holes: readonly Box[] }> => {
    const cached = filterCache.get(a);
    if (cached !== undefined) return cached;
    const cs = getComputedStyle(a);
    const ctm = a instanceof SVGGraphicsElement ? a.getScreenCTM() : null;
    const clipEl = refTarget(cs.clipPath) ?? refTarget(a.getAttribute("clip-path"));
    const maskEl =
      refTarget(cs.maskImage) ??
      refTarget(cs.getPropertyValue("mask")) ??
      refTarget(a.getAttribute("mask"));
    const clip =
      clipEl === null || ctm === null
        ? null
        : [...clipEl.children].flatMap((child) => {
            const b = userBox(child);
            return b === null ? [] : [transformBox(b, ctm)];
          });
    const holes =
      maskEl === null || ctm === null
        ? []
        : [...maskEl.children].flatMap((child) => {
            const c = toRgba(getComputedStyle(child).fill);
            // 輝度の低い（黒い）図形の部分が隠れる。
            if (c === null || 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b >= 128) return [];
            const b = userBox(child);
            return b === null ? [] : [transformBox(b, ctm)];
          });
    const result = { clip, holes };
    filterCache.set(a, result);
    return result;
  };
  const filtersOf = (el: Element, svg: Element): Filter => {
    const own = chainTo(el, svg).map(ownFilter);
    return {
      clips: own.flatMap((f) => (f.clip === null ? [] : [f.clip])),
      holes: own.flatMap((f) => f.holes),
    };
  };
  const visibleAt = (p: Pt, f: Filter): boolean =>
    f.clips.every((rs) => rs.some((r) => inside(p, r))) && !f.holes.some((r) => inside(p, r));

  // 破線の模様。stroke-dasharray と stroke-dashoffset から、1 周期の中の描画区間を求める。
  const dashOf = (cs: CSSStyleDeclaration): Dash | null => {
    const lengths = cs.strokeDasharray
      .split(/[\s,]+/)
      .filter((v) => v !== "" && v !== "none")
      .map((v) => Number.parseFloat(v));
    if (lengths.length === 0 || lengths.some((v) => !(v >= 0))) return null;
    // 奇数個の指定は、2 回繰り返して偶数個にする（SVG の仕様）。
    const even = lengths.length % 2 === 1 ? [...lengths, ...lengths] : lengths;
    const period = even.reduce((a, v) => a + v, 0);
    if (!(period > 0)) return null;
    const pairs = Array.from({ length: even.length / 2 }, (_, i) => ({
      on: even[2 * i] ?? 0,
      before: even.slice(0, 2 * i).reduce((a, v) => a + v, 0),
    }));
    return {
      dashes: pairs.map((p): readonly [number, number] => [p.before, p.before + p.on]),
      period,
      offset: Number.parseFloat(cs.strokeDashoffset) || 0,
    };
  };
  const inDash = (dash: Dash, s: number): boolean => {
    const t = (((s + dash.offset) % dash.period) + dash.period) % dash.period;
    return dash.dashes.some(([a, b]) => t >= a - 1e-6 && t <= b + 1e-6);
  };
  // 描画区間の両端の位置（線の始点からの長さ）。標本に加え、破線の端を正確に測る。
  const dashEnds = (dash: Dash, length: number): readonly number[] => {
    const first = Math.floor(dash.offset / dash.period) - 1;
    const last = Math.ceil((length + dash.offset) / dash.period) + 1;
    return Array.from({ length: last - first + 1 }, (_, i) => first + i)
      .flatMap((k) =>
        dash.dashes.flatMap(([a, b]) => [a, b].map((e) => k * dash.period + e - dash.offset)),
      )
      .filter((s) => s >= 0 && s <= length);
  };

  // 塗りの path を部分パス（M で始まる区切り）ごとの図形に分ける。ContourPlot は離れた矢じりの
  // 群を 1 本の path にまとめるため、全体の外接矩形では塗られない空間まで含んでしまう。
  // 部分パスは文書の外の path 要素に移して幾何を測る（座標系は元の要素と同じ）。
  const fillPieces = (el: SVGGeometryElement): readonly SVGGeometryElement[] => {
    if (el.localName !== "path") return [el];
    const d = el.getAttribute("d") ?? "";
    const parts = d
      .trim()
      .split(/(?=M)/)
      .filter((part) => part.trim() !== "");
    // 相対の m で始まる部分パスは前の部分パスの終点に依存するため、分けずに 1 つの図形として扱う。
    if (parts.length <= 1 || /m/.test(d.trim().slice(1))) return [el];
    return parts.map((part) => {
      const piece = document.createElementNS(SVG_NS, "path");
      piece.setAttribute("d", part);
      return piece;
    });
  };
  // 図形の輪郭を画面座標の点列にする。0.5px ごとに標本をとり、末尾に切れ目を置く。
  const outlineOf = (
    geom: SVGGeometryElement,
    ctm: DOMMatrixReadOnly | null,
    scale: number,
    f: Filter,
  ): readonly Sample[] => {
    const length = totalLength(geom);
    if (!(length > 0)) return [];
    const n = Math.min(400, Math.max(12, Math.ceil((length * scale) / 0.5) + 1));
    const pts = Array.from({ length: n }, (_, i): Sample => {
      const u = geom.getPointAtLength((length * i) / (n - 1));
      const p = transform(u.x, u.y, ctm);
      return { x: p.x, y: p.y, visible: visibleAt(p, f) };
    });
    return [...pts, BREAK];
  };
  const boundsOf = (pts: readonly Sample[]): Box | null => {
    const real = pts.filter((p) => p.brk !== true);
    return real.length === 0 ? null : unionAll(real.map((p) => box(p.x, p.y, p.x, p.y)));
  };
  /** 並びを、isBreak が真になる要素で区切った区間の並びにする（区切りの要素と空の区間は除く）。 */
  const splitAt = (items: readonly Sample[]): readonly (readonly Sample[])[] => {
    const cuts = items.flatMap((item, i) => (item.brk === true ? [i] : []));
    const bounds = [-1, ...cuts, items.length];
    return bounds
      .slice(1)
      .map((end, k) => items.slice((bounds[k] ?? -1) + 1, end))
      .filter((run) => run.length > 0);
  };
  // 点が輪郭の内側にあるかを、偶奇規則の半直線法で判定する。輪郭は切れ目ごとに閉じた図形とみなす。
  const insideOutline = (c: Pt, pts: readonly Sample[]): boolean =>
    splitAt(pts).reduce(
      (odd, run) =>
        run.reduce((o, a, i) => {
          const b = run[(i + 1) % run.length] ?? a;
          const crosses =
            a.y > c.y !== b.y > c.y && c.x < ((b.x - a.x) * (c.y - a.y)) / (b.y - a.y) + a.x;
          return crosses ? !o : o;
        }, odd),
      false,
    );

  // marker で描く矢じり（軸の矢印・FlowChart のエッジの矢じり）は DOM に図形の実体を持たない。
  // marker の定義と線の端点から、描かれる位置の輪郭を合成して障害物に加える。
  const MARKER_HOSTS: ReadonlySet<string> = new Set(["path", "line", "polyline", "polygon"]);
  const MARKER_OUTLINE_SAMPLES = 64;
  const parseAngle = (value: string): number => {
    const m = /^(-?[\d.]+(?:e-?\d+)?)\s*(deg|rad|grad|turn)?$/.exec(value);
    if (m === null) return 0;
    const v = Number(m[1]);
    if (m[2] === "rad") return v;
    if (m[2] === "grad") return (v * Math.PI) / 200;
    if (m[2] === "turn") return v * 2 * Math.PI;
    return (v * Math.PI) / 180;
  };
  // marker の中の図形の輪郭を、marker の座標系の点列で返す。図形の切れ目には null を挟む。
  // 描画されない marker の中の要素でも、幾何（getTotalLength・getPointAtLength）は取れる。
  // 同じ marker を多くの線が使うため、関数の中に閉じたキャッシュに覚える。
  const markerOutlineCache = new Map<Element, readonly (Pt | null)[]>();
  const markerOutline = (marker: SVGMarkerElement): readonly (Pt | null)[] => {
    const cached = markerOutlineCache.get(marker);
    if (cached !== undefined) return cached;
    const traced = [...marker.querySelectorAll<SVGGeometryElement>(SHAPES)].flatMap((child) => {
      const length = totalLength(child);
      if (!(length > 0)) return [];
      const points = Array.from({ length: MARKER_OUTLINE_SAMPLES + 1 }, (_, i): Pt => {
        const p = child.getPointAtLength((length * i) / MARKER_OUTLINE_SAMPLES);
        return { x: p.x, y: p.y };
      });
      return [...points, null];
    });
    // 輪郭を取れないときは、viewBox（無ければ marker の表示域）全体の矩形で近似する。
    const vb = marker.viewBox.baseVal;
    const b =
      vb.width > 0 && vb.height > 0
        ? box(vb.x, vb.y, vb.x + vb.width, vb.y + vb.height)
        : box(0, 0, marker.markerWidth.baseVal.value, marker.markerHeight.baseVal.value);
    const outline =
      traced.length > 0
        ? traced
        : [
            { x: b.l, y: b.t },
            { x: b.r, y: b.t },
            { x: b.r, y: b.b },
            { x: b.l, y: b.b },
            { x: b.l, y: b.t },
            null,
          ];
    markerOutlineCache.set(marker, outline);
    return outline;
  };
  const markerColor = (marker: SVGMarkerElement, cs: CSSStyleDeclaration): string => {
    const child = marker.querySelector(SHAPES);
    if (child === null) return toHex(cs.stroke);
    const ccs = getComputedStyle(child);
    const paint = paintVisible(ccs.fill) ? ccs.fill : ccs.stroke;
    if (paint === "context-stroke") return toHex(cs.stroke);
    if (paint === "context-fill") return toHex(cs.fill);
    return toHex(paint);
  };
  // viewBox から marker の表示域（markerWidth×markerHeight）への倍率。
  const markerScale = (marker: SVGMarkerElement): Readonly<{ sx: number; sy: number }> => {
    const vb = marker.viewBox.baseVal;
    if (!(vb.width > 0 && vb.height > 0)) return { sx: 1, sy: 1 };
    const sx = marker.markerWidth.baseVal.value / vb.width;
    const sy = marker.markerHeight.baseVal.value / vb.height;
    const par = marker.preserveAspectRatio.baseVal;
    if (par.align === SVGPreserveAspectRatio.SVG_PRESERVEASPECTRATIO_NONE) return { sx, sy };
    const s =
      par.meetOrSlice === SVGPreserveAspectRatio.SVG_MEETORSLICE_SLICE
        ? Math.max(sx, sy)
        : Math.min(sx, sy);
    return { sx: s, sy: s };
  };
  const markerObstacles = (
    el: SVGGeometryElement,
    cs: CSSStyleDeclaration,
    svg: Element,
  ): readonly Obstacle[] => {
    const ctm = el.getScreenCTM();
    if (ctm === null || !MARKER_HOSTS.has(el.localName)) return [];
    const length = totalLength(el);
    const at = (s: number): Pt => {
      const p = el.getPointAtLength(Math.max(0, Math.min(length, s)));
      return { x: p.x, y: p.y };
    };
    // 端の向きは、端点と少し手前の点の差で求める。
    const eps = Math.min(1, length / 2);
    const strokeWidth = Number.parseFloat(cs.strokeWidth) || 0;
    const ends: readonly (readonly ["start" | "end", string | null])[] = [
      ["start", cs.getPropertyValue("marker-start") || el.getAttribute("marker-start")],
      ["end", cs.getPropertyValue("marker-end") || el.getAttribute("marker-end")],
    ];
    return ends.flatMap(([which, value]): readonly Obstacle[] => {
      const marker = refTarget(value);
      if (!(marker instanceof SVGMarkerElement)) return [];
      const vertex = at(which === "start" ? 0 : length);
      const inner = at(which === "start" ? eps : length - eps);
      const dir =
        which === "start"
          ? Math.atan2(inner.y - vertex.y, inner.x - vertex.x)
          : Math.atan2(vertex.y - inner.y, vertex.x - inner.x);
      const orient = (marker.getAttribute("orient") ?? "0").trim();
      const angle =
        orient === "auto"
          ? dir
          : orient === "auto-start-reverse"
            ? which === "start"
              ? dir + Math.PI
              : dir
            : parseAngle(orient);
      // refX・refY は viewBox の座標で、端点に重なる点である。
      const { sx, sy } = markerScale(marker);
      const unit =
        marker.markerUnits.baseVal === SVGMarkerElement.SVG_MARKERUNITS_STROKEWIDTH
          ? strokeWidth
          : 1;
      const refX = marker.refX.baseVal.value;
      const refY = marker.refY.baseVal.value;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const f = filtersOf(el, svg);
      const samples = markerOutline(marker).map((p): Sample => {
        if (p === null) return BREAK;
        const lx = (p.x - refX) * sx * unit;
        const ly = (p.y - refY) * sy * unit;
        const q = transform(vertex.x + lx * cos - ly * sin, vertex.y + lx * sin + ly * cos, ctm);
        return { x: q.x, y: q.y, visible: visibleAt(q, f) };
      });
      const reach = boundsOf(samples.filter((p) => p.visible));
      if (reach === null) return [];
      // 点列は図形ごとに切れ目を挟むので、間隔による切れ目の判定は要らない。
      return [
        {
          kind: "marker",
          el,
          geom: el,
          ctm,
          scale: 1,
          half: 0,
          cap: "round",
          dash: null,
          solid: false,
          rect: reach,
          reach,
          node: el.closest("g.visx-network-node"),
          color: markerColor(marker, cs),
          samples,
        },
      ];
    });
  };

  // 字形を持つテキストノード（文書の順）。KaTeX の支柱の幅 0 の空白や、MathML（読み上げ用で描かれ
  // ない）は除く。
  const textNodes = (n: Node): readonly Text[] =>
    n instanceof Text ? [n] : [...n.childNodes].flatMap(textNodes);
  const glyphTextNodes = (el: Element): readonly Text[] =>
    textNodes(el).filter((n) => {
      const parent = n.parentElement;
      return (
        (n.nodeValue ?? "").replaceAll(ZERO_WIDTH_SPACE, "").trim() !== "" &&
        parent !== null &&
        parent.closest(".katex-mathml") === null
      );
    });
  // 基線の位置は、幅も高さも 0 の inline-block をテキストの直前に置き、その下端で測る（下端が基線に
  // そろう）。行の箱の高さと canvas の書体の寸法から求める方法は、両者の丸めが違って 1〜2px ずれる。
  // 挿入・計測・除去をまとめて行い、レイアウトの再計算を 1 回に抑える。字形の位置は変わらない。
  const measureBaselines = (nodes: readonly Text[]): ReadonlyMap<Text, number> => {
    const probes = nodes.map((n) => {
      const probe = document.createElement("span");
      probe.style.cssText =
        "display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline";
      n.parentNode?.insertBefore(probe, n);
      return probe;
    });
    const baselines = new Map(
      nodes.map((n, i) => [n, probes[i]?.getBoundingClientRect().bottom ?? 0]),
    );
    for (const probe of probes) probe.remove();
    return baselines;
  };
  // ラベルは foreignObject の箱ではなく、字形の実際の範囲（インク）で測る。テキストの行の箱（Range の
  // 矩形）は字形の上下に行の余白を含むため、canvas の measureText で字形の範囲に絞る。字形の並び
  // （テキストノード）ごとに矩形を分けて持ち、「−1」の字の間を通る線を重なりと誤らないようにする。
  const inkRects = (
    el: SVGGraphicsElement,
    baselines: ReadonlyMap<Text, number>,
  ): readonly Box[] => {
    if (el.localName === "text") {
      const d = el.getBoundingClientRect();
      return isEmpty(d) ? [] : [fromDom(d)];
    }
    // measureText は CSS px で返す。図 SVG が本文の幅に合わせて縮むと字形も縮むため、ラベルの
    // 座標系から画面への倍率を掛ける。
    const k = scaleOf(el.getScreenCTM());
    const glyphs = glyphTextNodes(el).flatMap((n): readonly Box[] => {
      range.selectNodeContents(n);
      const boxes = [...range.getClientRects()].filter((d) => !isEmpty(d));
      const first = boxes[0];
      if (first === undefined) return [];
      const baseline = baselines.get(n);
      // 1 行に収まるテキストだけ、canvas の measureText で字形の範囲に絞る。
      if (
        boxes.length === 1 &&
        ctx2d !== null &&
        baseline !== undefined &&
        n.parentElement !== null
      ) {
        ctx2d.font = getComputedStyle(n.parentElement).font;
        const m = ctx2d.measureText(n.nodeValue ?? "");
        return [
          box(
            first.left - m.actualBoundingBoxLeft * k,
            baseline - m.actualBoundingBoxAscent * k,
            first.left + m.actualBoundingBoxRight * k,
            baseline + m.actualBoundingBoxDescent * k,
          ),
        ];
      }
      return boxes.map(fromDom);
    });
    // 根号・矢印などの伸縮する字形は SVG、分数の横線などは罫線の span で描かれる。
    // 根号の SVG は幅 400em で、親の span が overflow で切り取るため、親の箱と重ねて測る。
    const stretchy = [...el.querySelectorAll(".katex-html svg")].flatMap((s) => {
      const d = s.getBoundingClientRect();
      const r = intersect(fromDom(d), fromDom(s.parentElement?.getBoundingClientRect() ?? d));
      return r.r > r.l && r.b > r.t ? [r] : [];
    });
    const rules = [
      ...el.querySelectorAll(
        ".katex-html :is(.frac-line, .overline-line, .underline-line, .hline, .hdashline, .rule)",
      ),
    ].flatMap((s) => {
      const d = s.getBoundingClientRect();
      return isEmpty(d) ? [] : [fromDom(d)];
    });
    return [...glyphs, ...stretchy, ...rules].filter((r) => r.r >= r.l && r.b >= r.t);
  };

  // ラベル名は KaTeX の TeX、地の文はそのままの文字列とし、両方を含むラベルは $...$ で区切る。
  const nameParts = (n: Node): readonly string[] => {
    if (n instanceof Text) return [n.nodeValue ?? ""];
    if (!(n instanceof Element)) return [];
    if (n.classList.contains("katex")) {
      const a = n.querySelector('annotation[encoding="application/x-tex"]');
      return [a === null ? (n.textContent ?? "") : `$${(a.textContent ?? "").trim()}$`];
    }
    const block = getComputedStyle(n).display.startsWith("inline") ? [] : [" "];
    return [...block, ...[...n.childNodes].flatMap(nameParts), ...block];
  };
  const labelName = (el: Element): string => {
    if (el.localName === "text") return (el.textContent ?? "").trim();
    const name = nameParts(el).join("").replace(/\s+/g, " ").trim();
    return /^\$[^$]*\$$/.test(name) ? name.slice(1, -1) : name;
  };

  const describe = (el: Element, kind: Obstacle["kind"]): Partner => {
    const cs = getComputedStyle(el);
    return {
      type: kind,
      tag: el.localName,
      stroke: toHex(cs.stroke),
      fill: toHex(cs.fill),
      className: el.getAttribute("class") ?? "",
    };
  };

  /** 1 つの図形を、線・小さな塗りの候補・marker の矢じり・板の候補に分ける。 */
  const classify = (
    el: SVGGeometryElement,
    svg: Element,
  ): Readonly<{
    lines: readonly Obstacle[];
    fills: readonly Obstacle[];
    markers: readonly Obstacle[];
    plates: readonly Plate[];
  }> => {
    const none = { lines: [], fills: [], markers: [], plates: [] };
    if (hasSkippedAncestor(el) || el.closest("g.visx-rows, g.visx-columns") !== null) return none;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return none;
    const cs = getComputedStyle(el);
    const markers = markerObstacles(el, cs, svg);
    const fillOn = paintVisible(cs.fill) && Number.parseFloat(cs.fillOpacity) > 0;
    const strokeWidth = Number.parseFloat(cs.strokeWidth) || 0;
    // SurfacePlot は、曲面の面どうしの継ぎ目に背景が透けないよう、面と同じ色の細い縁を付ける。
    // 継ぎ目は線ではなく塗りの一部とみなす。点（NumberLine の閉端点など）の同じ色の縁は、塗りの
    // 外へ広がる本物の線なので、線として数える。
    const seam =
      fillOn &&
      cs.stroke === cs.fill &&
      el.localName === "polygon" &&
      el.closest(".surface-plot") !== null;
    const strokeOn =
      !seam &&
      paintVisible(cs.stroke) &&
      strokeWidth > 0 &&
      Number.parseFloat(cs.strokeOpacity) > 0;
    const rect = fromDom(el.getBoundingClientRect());
    const node = el.closest("g.visx-network-node");
    const ctm = el.getScreenCTM();
    const scale = scaleOf(ctm);
    const alpha = fillOn ? fillAlpha(el, svg, cs) : 0;
    const small = (r: Box): boolean => r.r - r.l <= smallFill && r.b - r.t <= smallFill;
    const base = { el, geom: el, ctm, scale, cap: "round", dash: null, solid: false, node };
    if (strokeOn) {
      const half = (strokeWidth * scale) / 2;
      const line: Obstacle = {
        ...base,
        kind: "line",
        half,
        cap: cs.strokeLinecap,
        dash: dashOf(cs),
        // 塗りもある小さな図形（点）は、縁の線に加えて塗りの内側も重なりとして測る。
        solid: fillOn && alpha >= 0.5 && small(rect),
        rect,
        reach: box(rect.l - half, rect.t - half, rect.r + half, rect.b + half),
      };
      return { ...none, lines: [line], markers };
    }
    if (!fillOn) return { ...none, markers };
    // ラベルに敷く背景の板。部品が実際に板として描くのは FlowChart のエッジラベルとクラスタ見出しの
    // 背景チップ（Bar = rect）だけである。ラベルを丸ごと覆う不透明な rect は、ラベルの障害物では
    // なく、下に描かれた線を隠すものとして扱う。矢じりの群の path などは、外接矩形の中に塗られない
    // 空間を含むため板にしない。
    const plates = alpha >= 0.9 && el.localName === "rect" ? [{ el, rect }] : [];
    // 淡い塗り（分割の小長方形の強調など）は領域の塗りであり、矢じり・点ではない。
    if (alpha < 0.5) return { ...none, markers, plates };
    if (small(rect)) {
      return {
        ...none,
        markers,
        plates,
        fills: [{ ...base, kind: "fill", half: 0, rect, reach: rect }],
      };
    }
    // 全体が大きくても、部分パスごとに見れば矢じり・点の大きさのものがある。
    const pieces = fillPieces(el);
    if (pieces.length <= 1) return { ...none, markers, plates };
    const f = filtersOf(el, svg);
    const fills = pieces.flatMap((geom): readonly Obstacle[] => {
      const samples = outlineOf(geom, ctm, scale, f);
      const r = boundsOf(samples);
      if (r === null || !small(r)) return [];
      return [{ ...base, kind: "fill", geom, half: 0, samples, rect: r, reach: r }];
    });
    return { ...none, markers, plates, fills };
  };

  // 曲面の塗りは小さな面に分けて描かれる。接し合う小さな塗りの集まりが矢じり・点の大きさを
  // 超えるなら、1 つの大きな塗りとみなして障害物から外す。
  const dropTiles = (fills: readonly Obstacle[]): readonly Obstacle[] =>
    [...Map.groupBy(fills, (f) => f.el.parentElement).values()].flatMap((list) => {
      // 接し合う塗りを union-find でまとめる。親の表は、この関数の中だけで書き換える可変のバッファ
      // である（組の数の 2 乗の比較で、配列を作り直すと遅くなる）。
      const root = list.map((_, i) => i);
      const find = (i: number): number => {
        const parent = root[i] ?? i;
        return parent === i ? i : find(parent);
      };
      list.forEach((a, i) => {
        list.slice(i + 1).forEach((b, d) => {
          if (rectRect(a.rect, b.rect) <= 0.5) root[find(i)] = find(i + 1 + d);
        });
      });
      return [...Map.groupBy(list, (_, i) => find(i)).values()].flatMap((group) => {
        const u = unionAll(group.map((f) => f.rect));
        return u.r - u.l <= smallFill && u.b - u.t <= smallFill ? group : [];
      });
    });

  const measureSvg = (svg: SVGSVGElement): SvgResult => {
    const svgBox = fromDom(svg.getBoundingClientRect());
    const rel = (p: Pt): Pt => ({
      x: +(p.x - svgBox.l).toFixed(1),
      y: +(p.y - svgBox.t).toFixed(1),
    });
    const relBox = (r: Box): Box => ({
      l: +(r.l - svgBox.l).toFixed(1),
      t: +(r.t - svgBox.t).toFixed(1),
      r: +(r.r - svgBox.l).toFixed(1),
      b: +(r.b - svgBox.t).toFixed(1),
    });

    // --labels 用に、字形の矩形を図 SVG の座標系（viewBox の単位）でも返す。部品が見積もる
    // 文字幅と同じ単位で比べられるようにするためである。
    const svgCtm = svg.getScreenCTM();
    const toSvg = svgCtm === null ? null : svgCtm.inverse();
    const round2 = (v: number): number => Math.round(v * 100) / 100;
    const svgUserBox = (r: Box): Omit<LabelInfo, "name" | "fontSize"> => {
      if (toSvg === null) return {};
      const b = transformBox(r, toSvg);
      return {
        x: round2(b.l),
        y: round2(b.t),
        width: round2(b.r - b.l),
        height: round2(b.b - b.t),
      };
    };
    const fontSizeOf = (el: Element): number => {
      const target = el.localName === "text" ? el : (el.firstElementChild ?? el);
      return Number.parseFloat(getComputedStyle(target).fontSize);
    };

    const labelEls = [...svg.querySelectorAll<SVGGraphicsElement>("foreignObject, text")].filter(
      (el) => !hasSkippedAncestor(el) && el.closest('svg[role="img"]') === svg,
    );
    const baselines = measureBaselines(
      labelEls.filter((el) => el.localName === "foreignObject").flatMap(glyphTextNodes),
    );
    // FlowChart はノードのラベルをノードの g の外に描く（WebKit の不具合の回避）。
    // ラベルの中心を含むノードを、そのラベルの入れ物とみなす。
    const nodes = [...svg.querySelectorAll("g.visx-network-node")].map((g) => ({
      g,
      rect: fromDom(g.getBoundingClientRect()),
    }));
    const labels = labelEls.flatMap((el): readonly Label[] => {
      const rects = inkRects(el, baselines);
      if (rects.length === 0) return [];
      const rect = unionAll(rects);
      const c = { x: (rect.l + rect.r) / 2, y: (rect.t + rect.b) / 2 };
      const own = el.closest("g.visx-network-node");
      const containers = [
        ...nodes.filter((n) => inside(c, n.rect)).map((n) => n.g),
        ...(own === null ? [] : [own]),
      ];
      return [{ el, rects, rect, name: labelName(el), containers }];
    });

    const parts = [...svg.querySelectorAll<SVGGeometryElement>(SHAPES)].map((el) =>
      classify(el, svg),
    );
    const plates = parts
      .flatMap((p) => p.plates)
      .filter((p) => labels.some((label) => contains(p.rect, label.rect, 2)));
    const obstacles = [
      ...parts.flatMap((p) => p.lines),
      ...dropTiles(parts.flatMap((p) => p.fills)),
      ...parts.flatMap((p) => p.markers),
    ];

    // 標本は、どれかのラベルの近くにある線・図形だけを遅延して取る。結果は、この図 SVG の計測の
    // 間だけ使うキャッシュ（可変の Map）に覚える。
    const sampleCache = new Map<Obstacle, readonly Sample[]>();
    const lineSamples = (ob: Obstacle): readonly Sample[] => {
      const f = filtersOf(ob.el, svg);
      if (ob.kind === "fill") return outlineOf(ob.geom, ob.ctm, ob.scale, f);
      const length = totalLength(ob.el);
      const n = Math.min(maxSamples, Math.max(2, Math.ceil((length * ob.scale) / sampleStep) + 1));
      const positions = [
        ...Array.from({ length: n }, (_, i) => (length * i) / (n - 1)),
        ...(ob.dash === null ? [] : dashEnds(ob.dash, length)),
      ].toSorted((a, b) => a - b);
      // 後から描かれた背景の板の下にある部分は見えない。
      const covering = plates.filter(
        (p) => (ob.el.compareDocumentPosition(p.el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      );
      const pointAt = (s: number): Pt => {
        const u = ob.el.getPointAtLength(s);
        return transform(u.x, u.y, ob.ctm);
      };
      // clip・マスク・板で隠れる（切り取られる）か。破線の空白とは区別する。
      const cut = (p: Pt): boolean => !visibleAt(p, f) || covering.some((c) => inside(p, c.rect));
      const dashed = (s: number): boolean => ob.dash === null || inDash(ob.dash, s);
      const raw = positions.map((s): Sample => {
        const p = pointAt(s);
        const hidden = cut(p);
        return { x: p.x, y: p.y, s, cut: hidden, visible: !hidden && dashed(s) };
      });
      // 見える部分と切り取られる部分の境目を二分法で求め、境目にも標本を置く。境目は線端の形
      // （stroke-linecap）ではなく、まっすぐな切り口（edge）として扱う。
      return raw.flatMap((a, i): readonly Sample[] => {
        const b = raw[i + 1];
        if (b === undefined || a.cut === b.cut || a.s === undefined || b.s === undefined)
          return [a];
        if (Math.hypot(b.x - a.x, b.y - a.y) > (b.s - a.s) * ob.scale * 1.5 + 0.5) return [a];
        const [lo, hi] = Array.from({ length: 12 }).reduce<readonly [number, number]>(
          ([l, h]) => {
            const mid = (l + h) / 2;
            return cut(pointAt(mid)) === a.cut ? [mid, h] : [l, mid];
          },
          [a.s, b.s],
        );
        const edge = a.cut === true ? hi : lo;
        const pe = pointAt(edge);
        return [a, { x: pe.x, y: pe.y, s: edge, cut: false, edge: true, visible: dashed(edge) }];
      });
    };
    const samplesOf = (ob: Obstacle): readonly Sample[] => {
      const known = ob.samples ?? sampleCache.get(ob);
      if (known !== undefined) return known;
      const computed = lineSamples(ob);
      sampleCache.set(ob, computed);
      return computed;
    };
    // 隣り合う標本を線分でつなぐか。画面上で大きく飛ぶ箇所は部分パスの切れ目、間が破線の空白なら
    // 描かれていないので、どちらもつながない。
    const joins = (ob: Obstacle, p: Sample, q: Sample | undefined): boolean => {
      if (q === undefined || !q.visible) return false;
      if (p.s === undefined || q.s === undefined) return true;
      if (Math.hypot(q.x - p.x, q.y - p.y) > (q.s - p.s) * ob.scale * 1.5 + 0.5) return false;
      return ob.dash === null || inDash(ob.dash, (p.s + q.s) / 2);
    };
    // 中心線（線分）と矩形の符号つき距離。
    const centerDistance = (p: Pt, q: Pt, r: Box): number => {
      const a = pointRect(p, r);
      const b = pointRect(q, r);
      return a <= 0 || b <= 0 ? Math.min(a, b) : segmentRect(p, q, r);
    };
    // 凸多角形と矩形の距離。分離軸で交わりを判定し、交わるときは null を返す。
    const polygonRectDistance = (poly: readonly Pt[], r: Box): number | null => {
      const corners = cornersOf(r);
      const edges = poly.map((a, i): readonly [Pt, Pt] => [a, poly[(i + 1) % poly.length] ?? a]);
      const axes: readonly Pt[] = [
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        ...edges.map(([a, b]) => ({ x: a.y - b.y, y: b.x - a.x })),
      ];
      const separated = axes.some((ax) => {
        const pa = poly.map((v) => v.x * ax.x + v.y * ax.y);
        const pb = corners.map((v) => v.x * ax.x + v.y * ax.y);
        return Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa);
      });
      if (!separated) return null;
      return Math.min(
        ...poly.map((v) => pointRect(v, r)),
        ...corners.flatMap((c) => edges.map(([a, b]) => pointSegment(c, a, b))),
      );
    };
    // 線端が butt・square の線分の太さを含む形（向きのある長方形）と矩形の距離。ext は線端から
    // 外へ延ばす長さで、butt は 0、square は線幅の半分である。
    const capBoxDistance = (
      p: Pt,
      q: Pt,
      ends: Readonly<{ half: number; extP: number; extQ: number }>,
      r: Box,
    ): number | null => {
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len === 0) return null;
      const { half, extP, extQ } = ends;
      const ux = (q.x - p.x) / len;
      const uy = (q.y - p.y) / len;
      const a = { x: p.x - ux * extP, y: p.y - uy * extP };
      const b = { x: q.x + ux * extQ, y: q.y + uy * extQ };
      const nx = -uy * half;
      const ny = ux * half;
      const d = polygonRectDistance(
        [
          { x: a.x + nx, y: a.y + ny },
          { x: b.x + nx, y: b.y + ny },
          { x: b.x - nx, y: b.y - ny },
          { x: a.x - nx, y: a.y - ny },
        ],
        r,
      );
      return d === null ? Math.min(centerDistance(p, q, r) - half, 0) : d;
    };
    /** 候補の距離が今の最短より短ければ、新しい最短を返す。 */
    const better = (best: Hit | null, d: number | null, p: Pt): Hit | null =>
      d !== null && (best === null || d < best.distance) ? { distance: d, at: p } : best;
    /** 見える標本がつながる区間（run）に分ける。 */
    const runsOf = (ob: Obstacle, pts: readonly Sample[]): readonly (readonly Sample[])[] => {
      const linked = pts.map((p, i) => p.visible && joins(ob, p, pts[i + 1]));
      const starts = pts.flatMap((p, i) => (p.visible && !(i > 0 && linked[i - 1]) ? [i] : []));
      return starts.map((s) => {
        const stop = linked.indexOf(false, s);
        return pts.slice(s, (stop === -1 ? pts.length - 1 : stop) + 1);
      });
    };
    // butt・square の線端のすぐ内側の標本は除く。残すと、その標本で測る線幅の半分の円が線端の外へ
    // はみ出し、round の線端と同じ形になってしまう。区間には少なくとも 2 点を残す。
    const pruneEnds = (
      run: readonly Sample[],
      half: number,
      trimStart: boolean,
      trimEnd: boolean,
    ): readonly Sample[] => {
      const far = (a: Sample, b: Sample): boolean => Math.hypot(a.x - b.x, a.y - b.y) >= half;
      const first = run[0];
      const fromStart =
        !trimStart || run.length <= 2 || first === undefined
          ? run
          : [
              first,
              ...run.slice(
                Math.min(
                  run.findIndex((p, i) => i >= 1 && far(first, p)) === -1
                    ? run.length - 1
                    : run.findIndex((p, i) => i >= 1 && far(first, p)),
                  run.length - 1,
                ),
              ),
            ];
      const last = fromStart.at(-1);
      if (!trimEnd || fromStart.length <= 2 || last === undefined) return fromStart;
      const keep = fromStart.findLastIndex((p, i) => i <= fromStart.length - 2 && far(last, p));
      return [...fromStart.slice(0, Math.max(keep + 1, 1)), last];
    };
    // 線（太さを含む）とラベルの距離。見える標本がつながる区間ごとに測り、区間の両端では線端の形
    // （stroke-linecap）を使う。中心線からの距離から線幅の半分を引くと、線端が round の形になる。
    // butt・square の線端と、切り取られた端（edge）は、向きのある長方形で測る。
    const lineDistance = (ob: Obstacle, rects: readonly Box[]): Hit | null => {
      const capped = ob.kind === "line" && ob.half > 0;
      const capOf = (p: Sample): string => (!capped ? "round" : p.edge === true ? "butt" : ob.cap);
      return runsOf(ob, samplesOf(ob)).reduce<Hit | null>((acc, whole) => {
        const first = whole[0];
        const last = whole.at(-1);
        if (first === undefined || last === undefined) return acc;
        // 始点に戻る区間（円・閉じた多角形）には線端が無い。
        const closed = whole.length > 2 && Math.hypot(last.x - first.x, last.y - first.y) < 0.01;
        const startCap = closed ? "round" : capOf(first);
        const endCap = closed ? "round" : capOf(last);
        const run = pruneEnds(whole, ob.half, startCap !== "round", endCap !== "round");
        return rects.reduce<Hit | null>((best, r) => {
          if (run.length === 1) {
            if (startCap === "round") return better(best, pointRect(first, r) - ob.half, first);
            if (startCap !== "square") return best;
            const h = ob.half;
            return better(
              best,
              rectRect(box(first.x - h, first.y - h, first.x + h, first.y + h), r),
              first,
            );
          }
          return run.slice(0, -1).reduce<Hit | null>((b, p, k) => {
            const q = run[k + 1] ?? p;
            const freeP = k === 0 && startCap !== "round";
            const freeQ = k + 2 === run.length && endCap !== "round";
            if (!freeP && !freeQ) return better(b, centerDistance(p, q, r) - ob.half, p);
            const ends = {
              half: ob.half,
              extP: freeP && startCap === "square" ? ob.half : 0,
              extQ: freeQ && endCap === "square" ? ob.half : 0,
            };
            // 線端でない側の端点は、隣の線分または round の線端の円で覆われる。
            const boxed = better(b, capBoxDistance(p, q, ends, r), p);
            const withP = freeP ? boxed : better(boxed, pointRect(p, r) - ob.half, p);
            return freeQ ? withP : better(withP, pointRect(q, r) - ob.half, q);
          }, best);
        }, acc);
      }, null);
    };
    const rectsDistance = (as: readonly Box[], bs: readonly Box[]): number =>
      Math.min(...as.flatMap((a) => bs.map((b) => rectRect(a, b))));
    // 塗りの図形（点・矢じり・marker の矢じり）との距離。外接矩形ではなく輪郭の標本で測り、
    // 輪郭から離れていてもラベルが図形の内側にあれば重なりとする。
    const shapeDistance = (ob: Obstacle, rects: readonly Box[]): Hit | null => {
      const hit = lineDistance(ob, rects);
      if (hit === null || hit.distance <= 0) return hit;
      const pts = samplesOf(ob);
      const enclosed = rects.some((r) =>
        insideOutline({ x: (r.l + r.r) / 2, y: (r.t + r.b) / 2 }, pts),
      );
      return enclosed ? { distance: -hit.distance, at: hit.at } : hit;
    };

    const kindOf = (d: number): Kind => (d <= 0 ? "overlap" : "near");
    const raw = labels.flatMap((label, li): readonly RawFinding[] => {
      const r = label.rect;
      const base = { label: label.name, labelBox: relBox(r) };
      const overflow = Math.max(svgBox.l - r.l, r.r - svgBox.r, svgBox.t - r.t, r.b - svgBox.b);
      const outside: readonly RawFinding[] =
        overflow > 0
          ? [
              {
                key: `${li}|svg`,
                finding: {
                  ...base,
                  partner: { type: "svg" },
                  distance: -overflow,
                  kind: "outside",
                },
              },
            ]
          : [];
      const ownPlates = plates.filter((p) => contains(p.rect, r, 2)).map((p) => p.el);
      const touching = obstacles.flatMap((ob): readonly RawFinding[] => {
        // ノードの中のラベルは、ノードの塗りとは比べない。枠線（stroke）との接触は測る。
        if (ob.kind === "fill" && ob.node !== null && label.containers.includes(ob.node)) return [];
        if (ownPlates.includes(ob.el) || rectRect(r, ob.reach) >= near) return [];
        // 外接矩形は候補の絞り込みにだけ使い、距離は実際の図形で求める。
        const hit =
          ob.kind === "line" && !ob.solid
            ? lineDistance(ob, label.rects)
            : shapeDistance(ob, label.rects);
        if (hit === null || hit.distance >= near) return [];
        const described = describe(ob.el, ob.kind);
        const partner = ob.kind === "marker" ? { ...described, fill: ob.color } : described;
        return [
          {
            key: `${li}|${partner.type}|${partner.tag}|${partner.stroke}|${partner.fill}|${partner.className}`,
            finding: {
              ...base,
              partner,
              distance: hit.distance,
              kind: kindOf(hit.distance),
              at: rel(hit.at),
            },
          },
        ];
      });
      const crowded = labels.slice(li + 1).flatMap((other, d): readonly RawFinding[] => {
        if (rectRect(r, other.rect) >= near) return [];
        const dist = rectsDistance(label.rects, other.rects);
        if (dist >= near) return [];
        return [
          {
            key: `${li}|label|${li + 1 + d}`,
            finding: {
              ...base,
              partner: { type: "label", name: other.name, labelBox: relBox(other.rect) },
              distance: dist,
              kind: kindOf(dist),
            },
          },
        ];
      });
      return [...outside, ...touching, ...crowded];
    });
    // 同じラベルと同じ見た目の相手（メッシュの網目など）の組は、最短の 1 件にまとめて件数を添える。
    const findings = [...Map.groupBy(raw, (f) => f.key).values()]
      .map((group): Finding => {
        const closest = group.reduce((a, c) => (c.finding.distance < a.finding.distance ? c : a));
        return {
          ...closest.finding,
          distance: Math.round(closest.finding.distance * 10) / 10,
          count: group.length,
        };
      })
      .toSorted((a, b) => a.distance - b.distance);
    return {
      className: svg.getAttribute("class") ?? "",
      labels: labels.length,
      findings,
      labelList: labels.map((l) => ({
        name: l.name,
        fontSize: fontSizeOf(l.el),
        ...svgUserBox(l.rect),
      })),
    };
  };

  return [...document.querySelectorAll(".sl-markdown-content figure")].map((fig, i) => ({
    figure: i + 1,
    svgs: [...fig.querySelectorAll<SVGSVGElement>('svg[role="img"]')]
      .filter((s) => s.closest("foreignObject") === null && s.closest("figure") === fig)
      .map(measureSvg),
  }));
}

/* oxlint-enable unicorn/consistent-function-scoping */

/** Markdown の表のセル用に値をエスケープする。 */
const cell = (s: string): string => s.replaceAll("|", "\\|");

/** 検出の相手の表示名を返す（件数は含めない）。 */
function partnerName(p: Partner): string {
  if (p.type === "label") return `ラベル「${p.name ?? ""}」`;
  if (p.type === "svg") return "図の表示範囲";
  if (p.type === "marker") return `marker 矢じり（${p.tag ?? ""}・${p.fill ?? ""}）`;
  const paint = p.type === "fill" ? `fill=${p.fill ?? ""}` : `stroke=${p.stroke ?? ""}`;
  const className = (p.className ?? "").trim();
  const cls = className === "" ? "" : ` .${className.split(/\s+/).join(".")}`;
  return `${p.tag ?? ""} ${paint}${cls}`;
}

/** 検出の相手を、まとめた件数つきの 1 行で返す。 */
const partnerText = (f: Finding): string =>
  `${partnerName(f.partner)}${f.count > 1 ? ` ×${f.count}` : ""}`;

/** 所見の表を Markdown の行の並びで返す。 */
const findingTable = (findings: readonly Finding[]): readonly string[] => [
  "| ラベル | 相手 | 距離(px) | 種別 |",
  "| --- | --- | ---: | --- |",
  ...findings.map(
    (f) => `| ${cell(f.label)} | ${cell(partnerText(f))} | ${f.distance.toFixed(1)} | ${f.kind} |`,
  ),
];

/** 図の情報を添えた所見。 */
type Located = Readonly<{
  route: string;
  figure: number;
  svg: number;
  heading: string;
  finding: Finding;
}>;

/** ページ・図ごとの所見を、図の情報を添えた平らな並びにする。 */
function flattenFindings(pages: readonly PageResult[]): readonly Located[] {
  return pages.flatMap(({ route, figures }) =>
    figures.flatMap((fig) =>
      fig.svgs.flatMap((svg, si) => {
        const suffix = fig.svgs.length > 1 ? `・SVG ${si + 1}` : "";
        return svg.findings.map((finding) => ({
          route,
          figure: fig.figure,
          svg: si + 1,
          heading: `${svg.className}${suffix}`,
          finding,
        }));
      }),
    ),
  );
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 照合のキー。ラベルどうしの所見は、どちらのラベルが DOM で先に現れたかに依らない組にする。 */
function matchKey(item: Located): string {
  const f = item.finding;
  const who =
    f.partner.type === "label"
      ? ["ラベルの組", ...[f.label, f.partner.name ?? ""].toSorted(byName)]
      : [f.label, partnerName(f.partner)];
  return JSON.stringify([item.route, item.figure, item.svg, ...who, f.kind]);
}

/**
 * 基準の所見と今回の所見を照合し、増えた所見と消えた所見を返す。
 *
 * 照合のキーはページ・図番号・図の中の SVG の番号・ラベル名・相手の表示名・種別とし、距離と
 * まとめた件数は含めない。距離のわずかな変化で別の所見と誤らないためである。同じキーが複数ある
 * ときは件数で突き合わせる。今回検査しなかったページの基準の所見は、消えたとは数えない。
 */
function compareFindings(
  basePages: readonly PageResult[],
  pages: readonly PageResult[],
): Readonly<{ added: readonly Located[]; removed: readonly Located[] }> {
  const routes: ReadonlySet<string> = new Set(pages.map((p) => p.route));
  const before = Map.groupBy(
    flattenFindings(basePages.filter((p) => routes.has(p.route))),
    matchKey,
  );
  const after = Map.groupBy(flattenFindings(pages), matchKey);
  return {
    added: [...after.entries()].flatMap(([key, items]) =>
      items.slice(before.get(key)?.length ?? 0),
    ),
    removed: [...before.entries()].flatMap(([key, items]) =>
      items.slice(0, Math.max(0, items.length - (after.get(key)?.length ?? 0))),
    ),
  };
}

/** 増えた所見と消えた所見を、ページ・図・SVG ごとの Markdown の行にする。 */
function comparisonLines(
  added: readonly Located[],
  removed: readonly Located[],
): readonly string[] {
  const tagged = [
    ...added.map((item) => ({ item, added: true })),
    ...removed.map((item) => ({ item, added: false })),
  ];
  const groups = [
    ...Map.groupBy(tagged, ({ item }) =>
      JSON.stringify([item.route, item.figure, item.svg]),
    ).values(),
  ].toSorted((ga, gb) => {
    const a = ga[0]?.item;
    const b = gb[0]?.item;
    if (a === undefined || b === undefined) return 0;
    if (a.route !== b.route) return a.route < b.route ? -1 : 1;
    return a.figure === b.figure ? a.svg - b.svg : a.figure - b.figure;
  });
  return groups.flatMap((group, gi) => {
    const head = group[0]?.item;
    if (head === undefined) return [];
    const previous = groups[gi - 1]?.[0]?.item;
    const plus = group.filter((g) => g.added).map((g) => g.item.finding);
    const minus = group.filter((g) => !g.added).map((g) => g.item.finding);
    return [
      ...(previous?.route === head.route ? [] : [`## ${head.route}`, ""]),
      `### 図 ${head.figure}（${head.heading}）`,
      "",
      ...(plus.length > 0 ? ["増えた所見:", "", ...findingTable(plus), ""] : []),
      ...(minus.length > 0 ? ["消えた所見:", "", ...findingTable(minus), ""] : []),
    ];
  });
}

/** 基準の JSON（--json の出力）の形。 */
type Baseline = Readonly<{ near: number; pages: readonly PageResult[] }>;

const isBaseline = (data: unknown): data is Baseline =>
  typeof data === "object" &&
  data !== null &&
  "pages" in data &&
  Array.isArray(data.pages) &&
  "near" in data &&
  typeof data.near === "number";

/** 基準の JSON（--json の出力）を読む。 */
function readBaseline(file: string): Baseline {
  const data = ((): unknown => {
    try {
      return JSON.parse(readFileSync(path.resolve(file), "utf8"));
    } catch (error) {
      throw new UsageError(
        `基準の JSON を読めない: ${file}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  })();
  if (!isBaseline(data)) {
    throw new UsageError(`基準の JSON に pages が無い（--json の出力を指定する）: ${file}`);
  }
  return data;
}

/** 失敗とみなす所見の数を返す。overlap は outside も含み、near はすべてを含む。 */
function countFailing(findings: readonly Finding[], failOn: string | undefined): number {
  if (failOn === "overlap") return findings.filter((f) => f.kind !== "near").length;
  if (failOn === "near") return findings.length;
  return 0;
}

/** JSON を書き出し、表示用のパスを返す。 */
function writeJson(file: string, data: unknown): string {
  const resolved = path.resolve(file);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(data, null, 2)}\n`);
  return displayPath(resolved);
}

/** 件数の合計。 */
type Totals = Readonly<{
  pages: number;
  figures: number;
  labels: number;
  overlap: number;
  near: number;
  outside: number;
}>;

function totalsOf(pages: readonly PageResult[]): Totals {
  const figures = pages.flatMap((p) => p.figures);
  const svgs = figures.flatMap((f) => f.svgs);
  const findings = svgs.flatMap((s) => s.findings);
  const count = (kind: Kind): number => findings.filter((f) => f.kind === kind).length;
  return {
    pages: pages.length,
    figures: figures.length,
    labels: svgs.reduce((sum, s) => sum + s.labels, 0),
    overlap: count("overlap"),
    near: count("near"),
    outside: count("outside"),
  };
}

/** ページごとの所見の表（図ごとの Markdown の行）。 */
function pageLines(page: PageResult): readonly string[] {
  const blocks = page.figures.flatMap((fig) =>
    fig.svgs.flatMap((svg, si) => {
      if (svg.findings.length === 0) return [];
      const suffix = fig.svgs.length > 1 ? `・SVG ${si + 1}` : "";
      return [
        `### 図 ${fig.figure}（${svg.className}${suffix}）`,
        "",
        ...findingTable(svg.findings),
        "",
      ];
    }),
  );
  return blocks.length === 0 ? [] : [`## ${page.route}`, "", ...blocks];
}

/** 件数の多い図の上位 10 件。 */
function topFigures(pages: readonly PageResult[]): readonly string[] {
  return pages
    .flatMap(({ route, figures }) =>
      figures.flatMap((fig) =>
        fig.svgs.flatMap((svg, si) => {
          if (svg.findings.length === 0) return [];
          const suffix = fig.svgs.length > 1 ? `・SVG ${si + 1}` : "";
          return [{ name: `${route} 図 ${fig.figure}${suffix}`, count: svg.findings.length }];
        }),
      ),
    )
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((t) => `- ${t.name}: ${t.count} 件`);
}

/** 1 ページを開いて計測する。 */
async function measurePage(
  context: BrowserContext,
  baseUrl: string,
  route: string,
  options: MeasureOptions,
): Promise<PageResult> {
  const url = pageUrl(baseUrl, route);
  const page = await openPage(context, url, "light");
  try {
    return { route, url, figures: await page.evaluate(measureFigures, options) };
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseCli(OPTIONS, USAGE);
  const near = parsePositive(values.near, "near");
  const failOn = values["fail-on"];
  if (failOn !== undefined && failOn !== "overlap" && failOn !== "near") {
    throw new UsageError(`--fail-on は overlap か near: ${failOn}`);
  }
  if (positionals.length === 0 && !values.all) {
    throw new UsageError(`検査するページを指定するか、--all を付ける。\n\n${USAGE}`);
  }
  const baseline = values.compare === undefined ? null : readBaseline(values.compare);
  if (baseline !== null && baseline.near !== near) {
    console.warn(
      `警告: 基準の近接の閾値（${baseline.near}px）と今回の閾値（${near}px）が違う。near の増減は閾値の差を含む。`,
    );
  }
  // ページの指定はサーバを立てる前に解決し、誤りなら何も起動せずに終える。
  const routes = resolvePages(positionals, { distDir: distDirOf(values), all: values.all });
  const options: MeasureOptions = {
    near,
    sampleStep: SAMPLE_STEP,
    maxSamples: MAX_SAMPLES,
    smallFill: SMALL_FILL,
  };

  const target = await openTarget(values);
  const pages = await withBrowser([target], async (browser) => {
    const context = await newThemedContext(browser, { theme: "light", scale: 1 });
    try {
      return await mapSeries(routes, async (route) =>
        measurePage(context, target.baseUrl, route, options),
      );
    } finally {
      await context.close();
    }
  });

  const totals = totalsOf(pages);
  const summary = [
    `ページ ${totals.pages}・図 ${totals.figures}・ラベル ${totals.labels} を検査した（近接の閾値 ${near}px）。`,
    `overlap ${totals.overlap} 件・near ${totals.near} 件・outside ${totals.outside} 件`,
  ];
  const comparison = baseline === null ? null : compareFindings(baseline.pages, pages);
  if (comparison === null) {
    for (const page of pages) {
      const lines = pageLines(page);
      if (lines.length > 0) console.log(lines.join("\n"));
    }
    const top = topFigures(pages);
    console.log(
      ["## 合計", "", ...summary, ...(top.length > 0 ? ["", "件数の多い図:", ...top] : [])].join(
        "\n",
      ),
    );
  } else {
    const lines = comparisonLines(comparison.added, comparison.removed);
    if (lines.length > 0) console.log(lines.join("\n"));
    console.log(
      [
        "## 合計",
        "",
        `基準: ${values.compare ?? ""}（近接の閾値 ${baseline?.near ?? near}px）`,
        `増えた所見 ${comparison.added.length} 件・消えた所見 ${comparison.removed.length} 件`,
        "",
        ...summary,
      ].join("\n"),
    );
  }

  if (values.json !== undefined) {
    // labelList は --labels 専用の情報なので、--json の詳細には含めない。
    const detail = pages.map((p) => ({
      ...p,
      figures: p.figures.map((fig) => ({
        ...fig,
        svgs: fig.svgs.map((svg) => ({
          className: svg.className,
          labels: svg.labels,
          findings: svg.findings,
        })),
      })),
    }));
    const written = writeJson(values.json, {
      baseUrl: target.baseUrl,
      near,
      totals,
      pages: detail,
    });
    console.log(`\n詳細を書き出した: ${written}`);
  }
  if (values.labels !== undefined) {
    const labels = pages.flatMap(({ route, figures }) =>
      figures.flatMap((fig) =>
        fig.svgs.flatMap((svg, si) =>
          (svg.labelList ?? []).map((l) => ({
            page: route,
            figure: fig.figure,
            svg: si + 1,
            component: svg.className,
            ...l,
          })),
        ),
      ),
    );
    const written = writeJson(values.labels, { baseUrl: target.baseUrl, labels });
    console.log(`\nラベルの寸法を書き出した: ${written}（${labels.length} 件）`);
  }

  const failing = countFailing(
    comparison === null
      ? flattenFindings(pages).map((item) => item.finding)
      : comparison.added.map((item) => item.finding),
    failOn,
  );
  if (failing > 0) process.exitCode = 1;
}

runMain(main);
