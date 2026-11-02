// 図の中のラベルと線・点・他のラベルとの重なりと近接、図の外へのはみ出しを、ブラウザで計測して一覧にする。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  UsageError,
  closeAll,
  displayPath,
  launchBrowser,
  newThemedContext,
  openPage,
  openTarget,
  pageUrl,
  parseCli,
  parsePositive,
  resolvePages,
  runMain,
} from "./lib.mjs";

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
};

/** 線の標本の間隔（画面の px）と、1 要素あたりの標本数の上限。 */
const SAMPLE_STEP = 2;
const MAX_SAMPLES = 3000;
/** 矢じり・点とみなす小さな塗りの外接矩形の上限（画面の px）。 */
const SMALL_FILL = 24;

// page.evaluate はこの関数の本文だけをブラウザへ送るため、補助の関数も内側に置く必要がある。
/* oxlint-disable unicorn/consistent-function-scoping */
/**
 * 開いているページのすべての図 SVG について、ラベルごとの重なり・近接・はみ出しを計測する。
 *
 * ブラウザの中で実行する。page.evaluate へ渡すため、外側の変数を参照しない。
 * 座標はすべて画面の CSS px で扱う（getBoundingClientRect と getScreenCTM が同じ座標系を返す）。
 */
function measureFigures({ near, sampleStep, maxSamples, smallFill }) {
  const SKIP_ANCESTORS = new Set([
    "foreignObject",
    "defs",
    "clipPath",
    "mask",
    "marker",
    "pattern",
    "symbol",
  ]);
  const SHAPES = "path, line, polyline, polygon, circle, ellipse, rect";
  const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
  const ctx2d = document.createElement("canvas").getContext("2d");
  const pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const range = document.createRange();

  const box = (l, t, r, b) => ({ l, t, r, b });
  const fromDom = (d) => box(d.left, d.top, d.right, d.bottom);
  const isEmpty = (d) => d.width <= 0 && d.height <= 0;
  const unionAll = (rs) =>
    rs.reduce((a, c) =>
      box(Math.min(a.l, c.l), Math.min(a.t, c.t), Math.max(a.r, c.r), Math.max(a.b, c.b)),
    );
  const intersect = (a, c) =>
    box(Math.max(a.l, c.l), Math.max(a.t, c.t), Math.min(a.r, c.r), Math.min(a.b, c.b));
  const inside = (p, r) => p.x >= r.l && p.x <= r.r && p.y >= r.t && p.y <= r.b;
  const contains = (outer, r, tolerance) =>
    r.l >= outer.l - tolerance &&
    r.r <= outer.r + tolerance &&
    r.t >= outer.t - tolerance &&
    r.b <= outer.b + tolerance;

  // 矩形どうしの符号つき距離。離れていれば隙間の長さ、重なっていれば食い込みの深さを負で返す。
  const rectRect = (a, c) => {
    const dx = Math.max(c.l - a.r, a.l - c.r);
    const dy = Math.max(c.t - a.b, a.t - c.b);
    if (dx > 0 || dy > 0) return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    return Math.max(dx, dy);
  };
  const pointRect = (p, r) => rectRect(box(p.x, p.y, p.x, p.y), r);
  const pointSegment = (c, p, q) => {
    const vx = q.x - p.x;
    const vy = q.y - p.y;
    const len2 = vx * vx + vy * vy;
    const t =
      len2 === 0 ? 0 : Math.max(0, Math.min(1, ((c.x - p.x) * vx + (c.y - p.y) * vy) / len2));
    return Math.hypot(c.x - (p.x + t * vx), c.y - (p.y + t * vy));
  };
  // 線分が矩形を横切るかを Liang–Barsky 法で判定する。
  const segmentHits = (p, q, r) => {
    let t0 = 0;
    let t1 = 1;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const clip = (pp, qq) => {
      if (pp === 0) return qq >= 0;
      const t = qq / pp;
      if (pp < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
      return true;
    };
    return (
      clip(-dx, p.x - r.l) && clip(dx, r.r - p.x) && clip(-dy, p.y - r.t) && clip(dy, r.b - p.y)
    );
  };
  const segmentRect = (p, q, r) => {
    if (segmentHits(p, q, r)) return 0;
    const corners = [
      { x: r.l, y: r.t },
      { x: r.r, y: r.t },
      { x: r.l, y: r.b },
      { x: r.r, y: r.b },
    ];
    return Math.min(pointRect(p, r), pointRect(q, r), ...corners.map((c) => pointSegment(c, p, q)));
  };

  const hasSkippedAncestor = (el) => {
    for (let a = el.parentElement; a !== null; a = a.parentElement) {
      if (SKIP_ANCESTORS.has(a.localName)) return true;
    }
    return false;
  };

  // 計算済みの色は rgb() のほか oklab() などでも返る。1 画素の canvas に塗って RGBA に直す。
  const colorCache = new Map();
  const toRgba = (paint) => {
    if (!paint || paint === "none" || paint.startsWith("url(") || pixel === null) return null;
    const cached = colorCache.get(paint);
    if (cached !== undefined) return cached;
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = "#000";
    pixel.fillStyle = paint;
    pixel.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data;
    const color = { r, g, b, a: a / 255 };
    colorCache.set(paint, color);
    return color;
  };
  const paintVisible = (paint) => {
    if (!paint || paint === "none") return false;
    if (paint.startsWith("url(")) return true;
    const c = toRgba(paint);
    return c === null || c.a > 0;
  };
  const toHex = (paint) => {
    const c = toRgba(paint);
    if (c === null) return paint;
    const hex = [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");
    return c.a < 1
      ? `#${hex}${Math.round(c.a * 255)
          .toString(16)
          .padStart(2, "0")}`
      : `#${hex}`;
  };
  const fillAlpha = (el, svg, cs) => {
    let alpha = (toRgba(cs.fill)?.a ?? 1) * Number.parseFloat(cs.fillOpacity);
    for (let a = el; a !== null; a = a.parentElement) {
      alpha *= Number.parseFloat(getComputedStyle(a).opacity);
      if (a === svg) break;
    }
    return alpha;
  };

  // clip-path と mask は図の部品が矩形で作る（プロット範囲のクリップ、ラベルの下の線の切り抜き）。
  // 見えない標本を障害物から外すため、祖先が参照する矩形を画面座標で集める。
  const filterCache = new Map();
  const refTarget = (value) => {
    const m = /url\(["']?#([^"')]+)["']?\)/.exec(value ?? "");
    return m === null ? null : document.getElementById(m[1]);
  };
  const userBox = (el) => {
    try {
      if (el.localName === "rect") {
        return box(
          el.x.baseVal.value,
          el.y.baseVal.value,
          el.x.baseVal.value + el.width.baseVal.value,
          el.y.baseVal.value + el.height.baseVal.value,
        );
      }
      const b = el.getBBox();
      return box(b.x, b.y, b.x + b.width, b.y + b.height);
    } catch {
      return null;
    }
  };
  const transformBox = (b, ctm) => {
    const pts = [
      new DOMPoint(b.l, b.t),
      new DOMPoint(b.r, b.t),
      new DOMPoint(b.l, b.b),
      new DOMPoint(b.r, b.b),
    ].map((p) => p.matrixTransform(ctm));
    return box(
      Math.min(...pts.map((p) => p.x)),
      Math.min(...pts.map((p) => p.y)),
      Math.max(...pts.map((p) => p.x)),
      Math.max(...pts.map((p) => p.y)),
    );
  };
  const ownFilter = (a) => {
    if (filterCache.has(a)) return filterCache.get(a);
    const cs = getComputedStyle(a);
    const ctm = typeof a.getScreenCTM === "function" ? a.getScreenCTM() : null;
    const result = { clip: null, holes: [] };
    const clipEl = refTarget(cs.clipPath) ?? refTarget(a.getAttribute("clip-path"));
    if (clipEl !== null && ctm !== null) {
      result.clip = [...clipEl.children]
        .map(userBox)
        .filter(Boolean)
        .map((b) => transformBox(b, ctm));
    }
    const maskEl =
      refTarget(cs.maskImage) ??
      refTarget(cs.getPropertyValue("mask")) ??
      refTarget(a.getAttribute("mask"));
    if (maskEl !== null && ctm !== null) {
      for (const child of maskEl.children) {
        const c = toRgba(getComputedStyle(child).fill);
        // 輝度の低い（黒い）図形の部分が隠れる。
        if (c !== null && 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b < 128) {
          const b = userBox(child);
          if (b !== null) result.holes.push(transformBox(b, ctm));
        }
      }
    }
    filterCache.set(a, result);
    return result;
  };
  const filtersOf = (el, svg) => {
    const clips = [];
    const holes = [];
    for (let a = el; a !== null; a = a.parentElement) {
      const f = ownFilter(a);
      if (f.clip !== null) clips.push(f.clip);
      holes.push(...f.holes);
      if (a === svg) break;
    }
    return { clips, holes };
  };
  const visibleAt = (p, f) =>
    f.clips.every((rs) => rs.some((r) => inside(p, r))) && !f.holes.some((r) => inside(p, r));

  // marker で描く矢じり（軸の矢印・FlowChart のエッジの矢じり）は DOM に図形の実体を持たない。
  // marker の定義と線の端点から、描かれる位置の輪郭を合成して障害物に加える。
  const MARKER_HOSTS = new Set(["path", "line", "polyline", "polygon"]);
  const MARKER_OUTLINE_SAMPLES = 64;
  const parseAngle = (value) => {
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
  const markerOutlineCache = new Map();
  const markerOutline = (marker) => {
    const cached = markerOutlineCache.get(marker);
    if (cached !== undefined) return cached;
    const pts = [];
    for (const child of marker.querySelectorAll(SHAPES)) {
      let length = 0;
      try {
        length = child.getTotalLength();
      } catch {
        length = 0;
      }
      if (!(length > 0)) continue;
      for (let i = 0; i <= MARKER_OUTLINE_SAMPLES; i += 1) {
        const p = child.getPointAtLength((length * i) / MARKER_OUTLINE_SAMPLES);
        pts.push({ x: p.x, y: p.y });
      }
      pts.push(null);
    }
    if (pts.length === 0) {
      // 輪郭を取れないときは、viewBox（無ければ marker の表示域）全体の矩形で近似する。
      const vb = marker.viewBox.baseVal;
      const b =
        vb !== null && vb.width > 0 && vb.height > 0
          ? box(vb.x, vb.y, vb.x + vb.width, vb.y + vb.height)
          : box(0, 0, marker.markerWidth.baseVal.value, marker.markerHeight.baseVal.value);
      pts.push(
        { x: b.l, y: b.t },
        { x: b.r, y: b.t },
        { x: b.r, y: b.b },
        { x: b.l, y: b.b },
        { x: b.l, y: b.t },
        null,
      );
    }
    markerOutlineCache.set(marker, pts);
    return pts;
  };
  const markerColor = (marker, cs) => {
    const child = marker.querySelector(SHAPES);
    if (child === null) return toHex(cs.stroke);
    const ccs = getComputedStyle(child);
    const paint = paintVisible(ccs.fill) ? ccs.fill : ccs.stroke;
    if (paint === "context-stroke") return toHex(cs.stroke);
    if (paint === "context-fill") return toHex(cs.fill);
    return toHex(paint);
  };
  const markerObstacles = (el, cs, svg) => {
    const out = [];
    const ctm = el.getScreenCTM();
    if (ctm === null || !MARKER_HOSTS.has(el.localName)) return out;
    let length = 0;
    try {
      length = el.getTotalLength();
    } catch {
      return out;
    }
    const at = (s) => el.getPointAtLength(Math.max(0, Math.min(length, s)));
    // 端の向きは、端点と少し手前の点の差で求める。
    const eps = Math.min(1, length / 2);
    const strokeWidth = Number.parseFloat(cs.strokeWidth) || 0;
    const ends = [
      ["start", cs.getPropertyValue("marker-start") || el.getAttribute("marker-start")],
      ["end", cs.getPropertyValue("marker-end") || el.getAttribute("marker-end")],
    ];
    for (const [which, value] of ends) {
      const marker = refTarget(value);
      if (marker === null || marker.localName !== "marker") continue;
      const vertex = at(which === "start" ? 0 : length);
      const inner = at(which === "start" ? eps : length - eps);
      const dir =
        which === "start"
          ? Math.atan2(inner.y - vertex.y, inner.x - vertex.x)
          : Math.atan2(vertex.y - inner.y, vertex.x - inner.x);
      const orient = (marker.getAttribute("orient") ?? "0").trim();
      let angle = parseAngle(orient);
      if (orient === "auto") angle = dir;
      if (orient === "auto-start-reverse") angle = which === "start" ? dir + Math.PI : dir;
      // viewBox から marker の表示域（markerWidth×markerHeight）への倍率。refX・refY は viewBox の
      // 座標で、端点に重なる点である。
      let sx = 1;
      let sy = 1;
      const vb = marker.viewBox.baseVal;
      if (vb !== null && vb.width > 0 && vb.height > 0) {
        sx = marker.markerWidth.baseVal.value / vb.width;
        sy = marker.markerHeight.baseVal.value / vb.height;
        const par = marker.preserveAspectRatio.baseVal;
        if (par.align !== SVGPreserveAspectRatio.SVG_PRESERVEASPECTRATIO_NONE) {
          const s =
            par.meetOrSlice === SVGPreserveAspectRatio.SVG_MEETORSLICE_SLICE
              ? Math.max(sx, sy)
              : Math.min(sx, sy);
          sx = s;
          sy = s;
        }
      }
      const unit =
        marker.markerUnits.baseVal === SVGMarkerElement.SVG_MARKERUNITS_STROKEWIDTH
          ? strokeWidth
          : 1;
      const refX = marker.refX.baseVal.value;
      const refY = marker.refY.baseVal.value;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const f = filtersOf(el, svg);
      const samples = markerOutline(marker).map((p) => {
        if (p === null) return { x: Number.NaN, y: Number.NaN, visible: false };
        const lx = (p.x - refX) * sx * unit;
        const ly = (p.y - refY) * sy * unit;
        const q = new DOMPoint(
          vertex.x + lx * cos - ly * sin,
          vertex.y + lx * sin + ly * cos,
        ).matrixTransform(ctm);
        return { x: q.x, y: q.y, visible: visibleAt(q, f) };
      });
      const drawn = samples.filter((s) => s.visible);
      if (drawn.length === 0) continue;
      out.push({
        kind: "marker",
        el,
        samples,
        // 点列は図形ごとに切れ目（visible: false）を挟むので、間隔による切れ目の判定は要らない。
        gap: Infinity,
        half: 0,
        color: markerColor(marker, cs),
        reach: box(
          Math.min(...drawn.map((s) => s.x)),
          Math.min(...drawn.map((s) => s.y)),
          Math.max(...drawn.map((s) => s.x)),
          Math.max(...drawn.map((s) => s.y)),
        ),
        node: el.closest("g.visx-network-node"),
      });
    }
    return out;
  };

  // 字形を持つテキストノード。KaTeX の支柱の幅 0 の空白や、MathML（読み上げ用で描かれない）は除く。
  const glyphTextNodes = (el) => {
    const nodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const text = n.nodeValue ?? "";
      const parent = n.parentElement;
      if (text.replaceAll(ZERO_WIDTH_SPACE, "").trim() === "") continue;
      if (parent === null || parent.closest(".katex-mathml") !== null) continue;
      nodes.push(n);
    }
    return nodes;
  };
  // 基線の位置は、幅も高さも 0 の inline-block をテキストの直前に置き、その下端で測る（下端が基線に
  // そろう）。行の箱の高さと canvas の書体の寸法から求める方法は、両者の丸めが違って 1〜2px ずれる。
  // 挿入・計測・除去をまとめて行い、レイアウトの再計算を 1 回に抑える。字形の位置は変わらない。
  const measureBaselines = (nodes) => {
    const probes = nodes.map((n) => {
      const probe = document.createElement("span");
      probe.style.cssText =
        "display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline";
      n.parentNode.insertBefore(probe, n);
      return probe;
    });
    const baselines = new Map(nodes.map((n, i) => [n, probes[i].getBoundingClientRect().bottom]));
    for (const probe of probes) probe.remove();
    return baselines;
  };
  // ラベルは foreignObject の箱ではなく、字形の実際の範囲（インク）で測る。テキストの行の箱（Range の
  // 矩形）は字形の上下に行の余白を含むため、canvas の measureText で字形の範囲に絞る。字形の並び
  // （テキストノード）ごとに矩形を分けて持ち、「−1」の字の間を通る線を重なりと誤らないようにする。
  const inkRects = (el, baselines) => {
    if (el.localName === "text") {
      const d = el.getBoundingClientRect();
      return isEmpty(d) ? [] : [fromDom(d)];
    }
    // measureText は CSS px で返す。図 SVG が本文の幅に合わせて縮むと字形も縮むため、ラベルの
    // 座標系から画面への倍率を掛ける。
    const ctm = el.getScreenCTM();
    const k = ctm === null ? 1 : Math.sqrt(Math.abs(ctm.a * ctm.d - ctm.b * ctm.c));
    const rs = [];
    for (const n of glyphTextNodes(el)) {
      const text = n.nodeValue ?? "";
      range.selectNodeContents(n);
      const boxes = [...range.getClientRects()].filter((d) => !isEmpty(d));
      if (boxes.length === 0) continue;
      const baseline = baselines.get(n);
      // 1 行に収まるテキストだけ、canvas の measureText で字形の範囲に絞る。
      if (boxes.length === 1 && ctx2d !== null && baseline !== undefined) {
        ctx2d.font = getComputedStyle(n.parentElement).font;
        const m = ctx2d.measureText(text);
        const b = boxes[0];
        rs.push(
          box(
            b.left - m.actualBoundingBoxLeft * k,
            baseline - m.actualBoundingBoxAscent * k,
            b.left + m.actualBoundingBoxRight * k,
            baseline + m.actualBoundingBoxDescent * k,
          ),
        );
        continue;
      }
      rs.push(...boxes.map(fromDom));
    }
    // 根号・矢印などの伸縮する字形は SVG、分数の横線などは罫線の span で描かれる。
    // 根号の SVG は幅 400em で、親の span が overflow で切り取るため、親の箱と重ねて測る。
    for (const s of el.querySelectorAll(".katex-html svg")) {
      const d = s.getBoundingClientRect();
      const p = s.parentElement?.getBoundingClientRect() ?? d;
      const r = intersect(fromDom(d), fromDom(p));
      if (r.r > r.l && r.b > r.t) rs.push(r);
    }
    for (const s of el.querySelectorAll(
      ".katex-html :is(.frac-line, .overline-line, .underline-line, .hline, .hdashline, .rule)",
    )) {
      const d = s.getBoundingClientRect();
      if (!isEmpty(d)) rs.push(fromDom(d));
    }
    return rs.filter((r) => r.r >= r.l && r.b >= r.t);
  };

  // ラベル名は KaTeX の TeX、地の文はそのままの文字列とし、両方を含むラベルは $...$ で区切る。
  const labelName = (el) => {
    if (el.localName === "text") return (el.textContent ?? "").trim();
    const parts = [];
    const walk = (n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        parts.push(n.nodeValue ?? "");
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      if (n.classList.contains("katex")) {
        const a = n.querySelector('annotation[encoding="application/x-tex"]');
        parts.push(a === null ? (n.textContent ?? "") : `$${(a.textContent ?? "").trim()}$`);
        return;
      }
      const block = !getComputedStyle(n).display.startsWith("inline");
      if (block) parts.push(" ");
      for (const c of n.childNodes) walk(c);
      if (block) parts.push(" ");
    };
    walk(el);
    const name = parts.join("").replace(/\s+/g, " ").trim();
    return /^\$[^$]*\$$/.test(name) ? name.slice(1, -1) : name;
  };

  const describe = (el, kind) => {
    const cs = getComputedStyle(el);
    return {
      type: kind,
      tag: el.localName,
      stroke: toHex(cs.stroke),
      fill: toHex(cs.fill),
      className: el.getAttribute("class") ?? "",
    };
  };

  const measureSvg = (svg) => {
    const svgBox = fromDom(svg.getBoundingClientRect());
    const rel = (p) => ({ x: +(p.x - svgBox.l).toFixed(1), y: +(p.y - svgBox.t).toFixed(1) });
    const relBox = (r) => ({
      l: +(r.l - svgBox.l).toFixed(1),
      t: +(r.t - svgBox.t).toFixed(1),
      r: +(r.r - svgBox.l).toFixed(1),
      b: +(r.b - svgBox.t).toFixed(1),
    });

    // --labels 用に、字形の矩形を図 SVG の座標系（viewBox の単位）でも返す。部品が見積もる
    // 文字幅と同じ単位で比べられるようにするためである。
    const svgCtm = svg.getScreenCTM();
    const toSvg = svgCtm === null ? null : svgCtm.inverse();
    const round2 = (v) => Math.round(v * 100) / 100;
    const svgUserBox = (r) => {
      if (toSvg === null) return null;
      const b = transformBox(r, toSvg);
      return {
        x: round2(b.l),
        y: round2(b.t),
        width: round2(b.r - b.l),
        height: round2(b.b - b.t),
      };
    };
    const fontSizeOf = (el) => {
      const target = el.localName === "text" ? el : (el.firstElementChild ?? el);
      return Number.parseFloat(getComputedStyle(target).fontSize);
    };

    const labelEls = [...svg.querySelectorAll("foreignObject, text")].filter(
      (el) => !hasSkippedAncestor(el) && el.closest('svg[role="img"]') === svg,
    );
    const baselines = measureBaselines(
      labelEls.filter((el) => el.localName === "foreignObject").flatMap(glyphTextNodes),
    );
    const labels = [];
    for (const el of labelEls) {
      const rects = inkRects(el, baselines);
      if (rects.length === 0) continue;
      labels.push({ el, rects, rect: unionAll(rects), name: labelName(el) });
    }

    // FlowChart はノードのラベルをノードの g の外に描く（WebKit の不具合の回避）。
    // ラベルの中心を含むノードを、そのラベルの入れ物とみなす。
    const nodes = [...svg.querySelectorAll("g.visx-network-node")].map((g) => ({
      g,
      rect: fromDom(g.getBoundingClientRect()),
    }));
    for (const label of labels) {
      const c = { x: (label.rect.l + label.rect.r) / 2, y: (label.rect.t + label.rect.b) / 2 };
      label.containers = nodes.filter((n) => inside(c, n.rect)).map((n) => n.g);
      const own = label.el.closest("g.visx-network-node");
      if (own !== null) label.containers.push(own);
    }

    const lines = [];
    const fills = [];
    const markers = [];
    const plateCandidates = [];
    for (const el of svg.querySelectorAll(SHAPES)) {
      if (hasSkippedAncestor(el) || el.closest("g.visx-rows, g.visx-columns") !== null) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const cs = getComputedStyle(el);
      markers.push(...markerObstacles(el, cs, svg));
      const fillOn = paintVisible(cs.fill) && Number.parseFloat(cs.fillOpacity) > 0;
      const strokeWidth = Number.parseFloat(cs.strokeWidth) || 0;
      // 塗りと同じ色の縁（SurfacePlot が面の継ぎ目を埋める細い縁）は、線ではなく塗りの一部とみなす。
      const seam = fillOn && cs.stroke === cs.fill;
      const strokeOn =
        !seam &&
        paintVisible(cs.stroke) &&
        strokeWidth > 0 &&
        Number.parseFloat(cs.strokeOpacity) > 0;
      const rect = fromDom(el.getBoundingClientRect());
      const node = el.closest("g.visx-network-node");
      if (strokeOn) {
        const ctm = el.getScreenCTM();
        const scale = ctm === null ? 1 : Math.sqrt(Math.abs(ctm.a * ctm.d - ctm.b * ctm.c));
        const half = (strokeWidth * scale) / 2;
        lines.push({
          kind: "line",
          el,
          ctm,
          scale,
          half,
          reach: box(rect.l - half, rect.t - half, rect.r + half, rect.b + half),
          node,
        });
        continue;
      }
      if (!fillOn) continue;
      const alpha = fillAlpha(el, svg, cs);
      // 線の上のラベルに敷く背景の板（FlowChart のエッジラベルなど）。ラベルを丸ごと覆う不透明な
      // 塗りは、ラベルの障害物ではなく、下に描かれた線を隠すものとして扱う。
      if (alpha >= 0.9) plateCandidates.push({ el, rect });
      // 淡い塗り（分割の小長方形の強調など）は領域の塗りであり、矢じり・点ではない。
      if (alpha >= 0.5 && rect.r - rect.l <= smallFill && rect.b - rect.t <= smallFill) {
        fills.push({ kind: "fill", el, rect, reach: rect, node });
      }
    }

    // 曲面の塗りは小さな面に分けて描かれる。接し合う小さな塗りの集まりが矢じり・点の大きさを
    // 超えるなら、1 つの大きな塗りとみなして障害物から外す。
    const smallFills = [];
    const byParent = new Map();
    for (const f of fills)
      byParent.set(f.el.parentElement, [...(byParent.get(f.el.parentElement) ?? []), f]);
    for (const list of byParent.values()) {
      const root = list.map((_, i) => i);
      const find = (i) => {
        let k = i;
        while (root[k] !== k) k = root[k];
        return k;
      };
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          if (rectRect(list[i].rect, list[j].rect) <= 0.5) root[find(i)] = find(j);
        }
      }
      const groups = new Map();
      list.forEach((f, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), f]));
      for (const group of groups.values()) {
        const u = unionAll(group.map((f) => f.rect));
        if (u.r - u.l <= smallFill && u.b - u.t <= smallFill) smallFills.push(...group);
      }
    }

    const plates = plateCandidates.filter((p) =>
      labels.some((label) => contains(p.rect, label.rect, 2)),
    );
    const obstacles = [...lines, ...smallFills, ...markers];

    // 線の標本は、どれかのラベルの近くにある線だけを遅延して取る。
    const samplesOf = (ob) => {
      if (ob.samples !== undefined) return ob.samples;
      let length = 0;
      try {
        length = ob.el.getTotalLength();
      } catch {
        length = 0;
      }
      const n = Math.min(maxSamples, Math.max(2, Math.ceil((length * ob.scale) / sampleStep) + 1));
      const f = filtersOf(ob.el, svg);
      // 後から描かれた背景の板の下にある部分は見えない。
      const covering = plates.filter(
        (p) => ob.el.compareDocumentPosition(p.el) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const pts = [];
      for (let i = 0; i < n; i += 1) {
        const u = ob.el.getPointAtLength((length * i) / (n - 1));
        const p = ob.ctm === null ? u : new DOMPoint(u.x, u.y).matrixTransform(ob.ctm);
        const visible = visibleAt(p, f) && !covering.some((c) => inside(p, c.rect));
        pts.push({ x: p.x, y: p.y, visible });
      }
      ob.samples = pts;
      // 隣り合う標本の画面上の間隔。大きく飛ぶ箇所は部分パスの切れ目なので、線分でつながない。
      ob.gap = (length * ob.scale) / (n - 1) + 0.5;
      return pts;
    };
    const lineDistance = (ob, rects) => {
      const pts = samplesOf(ob);
      let best = Infinity;
      let at = null;
      for (let i = 0; i < pts.length; i += 1) {
        const p = pts[i];
        if (!p.visible) continue;
        const q = pts[i + 1];
        const joined =
          q !== undefined && q.visible && Math.hypot(q.x - p.x, q.y - p.y) <= ob.gap * 1.5;
        for (const r of rects) {
          const d = pointRect(p, r);
          const s = joined && d > 0 ? segmentRect(p, q, r) : d;
          if (Math.min(d, s) < best) {
            best = Math.min(d, s);
            at = p;
          }
        }
      }
      return at === null ? null : { distance: best - ob.half, at };
    };
    const rectsDistance = (as, bs) => Math.min(...as.flatMap((a) => bs.map((b) => rectRect(a, b))));

    // 同じラベルと同じ見た目の相手（メッシュの網目など）の組は、最短の 1 件にまとめて件数を添える。
    const merged = new Map();
    const add = (li, key, finding) => {
      const k = `${li}|${key}`;
      const prev = merged.get(k);
      if (prev === undefined) merged.set(k, { ...finding, count: 1 });
      else {
        prev.count += 1;
        if (finding.distance < prev.distance) Object.assign(prev, finding, { count: prev.count });
      }
    };
    const kindOf = (d) => (d <= 0 ? "overlap" : "near");
    labels.forEach((label, li) => {
      const r = label.rect;
      const base = { label: label.name, labelBox: relBox(r) };
      const overflow = Math.max(svgBox.l - r.l, r.r - svgBox.r, svgBox.t - r.t, r.b - svgBox.b);
      if (overflow > 0) {
        add(li, "svg", {
          ...base,
          partner: { type: "svg" },
          distance: -overflow,
          kind: "outside",
        });
      }
      const ownPlates = plates.filter((p) => contains(p.rect, r, 2)).map((p) => p.el);
      for (const ob of obstacles) {
        if (ob.node !== null && label.containers.includes(ob.node)) continue;
        if (ownPlates.includes(ob.el) || rectRect(r, ob.reach) >= near) continue;
        const hit =
          ob.kind === "fill"
            ? {
                distance: rectsDistance(label.rects, [ob.rect]),
                at: { x: ob.rect.l, y: ob.rect.t },
              }
            : lineDistance(ob, label.rects);
        if (hit === null || hit.distance >= near) continue;
        const partner = describe(ob.el, ob.kind);
        if (ob.kind === "marker") partner.fill = ob.color;
        add(
          li,
          `${partner.type}|${partner.tag}|${partner.stroke}|${partner.fill}|${partner.className}`,
          {
            ...base,
            partner,
            distance: hit.distance,
            kind: kindOf(hit.distance),
            at: rel(hit.at),
          },
        );
      }
      for (let lj = li + 1; lj < labels.length; lj += 1) {
        const other = labels[lj];
        if (rectRect(r, other.rect) >= near) continue;
        const d = rectsDistance(label.rects, other.rects);
        if (d >= near) continue;
        add(li, `label|${lj}`, {
          ...base,
          partner: { type: "label", name: other.name, labelBox: relBox(other.rect) },
          distance: d,
          kind: kindOf(d),
        });
      }
    });
    const findings = [...merged.values()]
      .map((f) => ({ ...f, distance: Math.round(f.distance * 10) / 10 }))
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
    svgs: [...fig.querySelectorAll('svg[role="img"]')]
      .filter((s) => s.closest("foreignObject") === null && s.closest("figure") === fig)
      .map(measureSvg),
  }));
}

/* oxlint-enable unicorn/consistent-function-scoping */

/** Markdown の表のセル用に値をエスケープする。 */
const cell = (s) => String(s).replaceAll("|", "\\|");

/** 検出の相手の表示名を返す（件数は含めない）。 */
function partnerName(p) {
  if (p.type === "label") return `ラベル「${p.name}」`;
  if (p.type === "svg") return "図の表示範囲";
  if (p.type === "marker") return `marker 矢じり（${p.tag}・${p.fill}）`;
  const paint = p.type === "fill" ? `fill=${p.fill}` : `stroke=${p.stroke}`;
  const cls = p.className.trim() === "" ? "" : ` .${p.className.trim().split(/\s+/).join(".")}`;
  return `${p.tag} ${paint}${cls}`;
}

/** 検出の相手を、まとめた件数つきの 1 行で返す。 */
const partnerText = (f) => `${partnerName(f.partner)}${f.count > 1 ? ` ×${f.count}` : ""}`;

/** 所見の表を Markdown の行の並びで返す。 */
const findingTable = (findings) => [
  "| ラベル | 相手 | 距離(px) | 種別 |",
  "| --- | --- | ---: | --- |",
  ...findings.map(
    (f) => `| ${cell(f.label)} | ${cell(partnerText(f))} | ${f.distance.toFixed(1)} | ${f.kind} |`,
  ),
];

/** ページ・図ごとの所見を、図の情報を添えた平らな並びにする。 */
function flattenFindings(pages) {
  const out = [];
  for (const { route, figures } of pages) {
    for (const fig of figures) {
      fig.svgs.forEach((svg, si) => {
        const suffix = fig.svgs.length > 1 ? `・SVG ${si + 1}` : "";
        for (const finding of svg.findings) {
          out.push({ route, figure: fig.figure, heading: `${svg.className}${suffix}`, finding });
        }
      });
    }
  }
  return out;
}

/**
 * 基準の所見と今回の所見を照合し、増えた所見と消えた所見を返す。
 *
 * 照合のキーはページ・図番号・ラベル名・相手の表示名・種別とし、距離とまとめた件数は含めない。
 * 距離のわずかな変化で別の所見と誤らないためである。同じキーが複数あるときは件数で突き合わせる。
 * 今回検査しなかったページの基準の所見は、消えたとは数えない。
 */
function compareFindings(basePages, pages) {
  const key = (item) =>
    JSON.stringify([
      item.route,
      item.figure,
      item.finding.label,
      partnerName(item.finding.partner),
      item.finding.kind,
    ]);
  const routes = new Set(pages.map((p) => p.route));
  const remaining = new Map();
  for (const item of flattenFindings(basePages.filter((p) => routes.has(p.route)))) {
    remaining.set(key(item), [...(remaining.get(key(item)) ?? []), item]);
  }
  const added = [];
  for (const item of flattenFindings(pages)) {
    const list = remaining.get(key(item));
    if (list !== undefined && list.length > 0) list.pop();
    else added.push(item);
  }
  return { added, removed: [...remaining.values()].flat() };
}

/** 増えた所見と消えた所見を、ページ・図ごとに Markdown で出す。 */
function printComparison(added, removed) {
  const groups = new Map();
  for (const [kind, items] of [
    ["added", added],
    ["removed", removed],
  ]) {
    for (const item of items) {
      const k = JSON.stringify([item.route, item.figure]);
      const g = groups.get(k) ?? { ...item, added: [], removed: [] };
      g[kind].push(item.finding);
      groups.set(k, g);
    }
  }
  const sorted = [...groups.values()].toSorted((a, b) =>
    a.route === b.route ? a.figure - b.figure : a.route < b.route ? -1 : 1,
  );
  let route = null;
  for (const g of sorted) {
    const lines = [];
    if (g.route !== route) {
      lines.push(`## ${g.route}`, "");
      route = g.route;
    }
    lines.push(`### 図 ${g.figure}（${g.heading}）`, "");
    if (g.added.length > 0) lines.push("増えた所見:", "", ...findingTable(g.added), "");
    if (g.removed.length > 0) lines.push("消えた所見:", "", ...findingTable(g.removed), "");
    console.log(lines.join("\n"));
  }
}

/** 基準の JSON（--json の出力）を読む。 */
function readBaseline(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    throw new UsageError(`基準の JSON を読めない: ${file}（${error.message}）`);
  }
  if (!Array.isArray(data?.pages)) {
    throw new UsageError(`基準の JSON に pages が無い（--json の出力を指定する）: ${file}`);
  }
  return data;
}

/** 失敗とみなす所見の数を返す。overlap は outside も含み、near はすべてを含む。 */
function countFailing(findings, failOn) {
  if (failOn === "overlap") return findings.filter((f) => f.kind !== "near").length;
  if (failOn === "near") return findings.length;
  return 0;
}

function writeJson(file, data) {
  const resolved = path.resolve(file);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(data, null, 2)}\n`);
  return displayPath(resolved);
}

async function main() {
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

  const target = await openTarget(values);
  let browser = null;
  const pages = [];
  try {
    const routes = resolvePages(positionals, { distDir: target.distDir, all: values.all });
    browser = await launchBrowser();
    const context = await newThemedContext(browser, { theme: "light", scale: 1 });
    for (const route of routes) {
      const url = pageUrl(target.baseUrl, route);
      const page = await openPage(context, url, "light");
      const figures = await page.evaluate(measureFigures, {
        near,
        sampleStep: SAMPLE_STEP,
        maxSamples: MAX_SAMPLES,
        smallFill: SMALL_FILL,
      });
      await page.close();
      pages.push({ route, url, figures });
    }
    await context.close();
  } finally {
    await closeAll(browser, target);
  }

  const totals = { pages: pages.length, figures: 0, labels: 0, overlap: 0, near: 0, outside: 0 };
  const perFigure = [];
  for (const { route, figures } of pages) {
    const blocks = [];
    for (const fig of figures) {
      totals.figures += 1;
      fig.svgs.forEach((svg, si) => {
        totals.labels += svg.labels;
        if (svg.findings.length === 0) return;
        for (const f of svg.findings) totals[f.kind] += 1;
        const suffix = fig.svgs.length > 1 ? `・SVG ${si + 1}` : "";
        perFigure.push({ name: `${route} 図 ${fig.figure}${suffix}`, count: svg.findings.length });
        blocks.push(
          `### 図 ${fig.figure}（${svg.className}${suffix}）`,
          "",
          ...findingTable(svg.findings),
          "",
        );
      });
    }
    // 比較のときは、増えた所見と消えた所見だけを出す。
    if (baseline === null && blocks.length > 0) {
      console.log([`## ${route}`, "", ...blocks].join("\n"));
    }
  }

  const summary = [
    `ページ ${totals.pages}・図 ${totals.figures}・ラベル ${totals.labels} を検査した（近接の閾値 ${near}px）。`,
    `overlap ${totals.overlap} 件・near ${totals.near} 件・outside ${totals.outside} 件`,
  ];
  let failing = countFailing(
    flattenFindings(pages).map((item) => item.finding),
    failOn,
  );
  if (baseline === null) {
    const top = perFigure.toSorted((a, b) => b.count - a.count).slice(0, 10);
    console.log(
      [
        "## 合計",
        "",
        ...summary,
        ...(top.length > 0
          ? ["", "件数の多い図:", ...top.map((t) => `- ${t.name}: ${t.count} 件`)]
          : []),
      ].join("\n"),
    );
  } else {
    const { added, removed } = compareFindings(baseline.pages, pages);
    printComparison(added, removed);
    console.log(
      [
        "## 合計",
        "",
        `基準: ${values.compare}（近接の閾値 ${baseline.near}px）`,
        `増えた所見 ${added.length} 件・消えた所見 ${removed.length} 件`,
        "",
        ...summary,
      ].join("\n"),
    );
    failing = countFailing(
      added.map((item) => item.finding),
      failOn,
    );
  }

  // labelList は --labels 専用の情報なので、--json の詳細には含めない。
  const pagesForJson = pages.map((p) => ({
    ...p,
    figures: p.figures.map((fig) => ({
      ...fig,
      svgs: fig.svgs.map(({ labelList: _labelList, ...rest }) => rest),
    })),
  }));
  if (values.json !== undefined) {
    const written = writeJson(values.json, {
      baseUrl: target.baseUrl,
      near,
      totals,
      pages: pagesForJson,
    });
    console.log(`\n詳細を書き出した: ${written}`);
  }
  if (values.labels !== undefined) {
    const labels = pages.flatMap(({ route, figures }) =>
      figures.flatMap((fig) =>
        fig.svgs.flatMap((svg, si) =>
          svg.labelList.map((l) => ({
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

  if (failing > 0) process.exitCode = 1;
}

runMain(main);
