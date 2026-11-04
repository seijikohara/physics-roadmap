// KatexLabel に渡す基準点と、ラベルの字形が画面で占める矩形の関係を表す。
//
// KatexLabel は枠の中で .katex の箱を上下の中央へ置く。字形の矩形の中心は基準点の y と一致せず、
// x のような低い字は枠の中心より下に寄る。配置器・等高線の切れ目・格子線の切り抜きは、同じ字形の
// 矩形を使う。

import type { Box, XY } from "./geometry";
import { KATEX_FONT_SCALE, labelWidthMargin, measureTex } from "./measure";

/** ラベルの配置先。KatexLabel に渡す基準点（中心・左端・右端）と横の寄せ方である。 */
export type LabelPos = XY & Readonly<{ align: "center" | "left" | "right" }>;

/**
 * ラベルの字形の寸法（px）。width は安全の余白を含む幅である。top・bottom は、基準点の y から
 * 字形の上端・下端までの符号付きの差で、下向きが正である。
 */
export type GlyphSize = Readonly<{ width: number; top: number; bottom: number }>;

// .katex の行の箱の、基線より上と下の長さの下限（数式の 1em を単位とする）。字が下限の範囲に収まる
// とき、基線は箱の中心から (LINE_ABOVE − LINE_BELOW) / 2 だけ下にある。字が範囲を超えると箱が広がり、
// 基線も動く。値は Chrome で字の大きさ 11〜13px のラベルを測って当てはめた。
// 実測の基線は字の大きさと書体ごとに 0.5px ほどばらつくので、字形は見積もりの外へ 1px 近く出ることがある。
const LINE_ABOVE = 0.83;
const LINE_BELOW = 0.31;

/** 字形の寸法を見積もる。fontSize は KatexLabel に渡す値である。 */
export function glyphSizeOf(tex: string, fontSize: number): GlyphSize {
  const m = measureTex(tex, fontSize);
  const em = fontSize * KATEX_FONT_SCALE;
  const baseline = (Math.max(m.height, LINE_ABOVE * em) - Math.max(m.depth, LINE_BELOW * em)) / 2;
  return {
    width: m.width + labelWidthMargin(m.width),
    top: baseline - m.height,
    bottom: baseline + m.depth,
  };
}

/** 基準点と寸法から、字形が占める矩形を求める。 */
export function glyphBox(pos: LabelPos, size: GlyphSize): Box {
  const x0 =
    pos.align === "left"
      ? pos.x
      : pos.align === "right"
        ? pos.x - size.width
        : pos.x - size.width / 2;
  return { x0, x1: x0 + size.width, y0: pos.y + size.top, y1: pos.y + size.bottom };
}

/** 字形の矩形の中心が基準点の y からどれだけ下にあるか（px）。線の上に字形を置くときに引く。 */
export function glyphCenterOffset(size: GlyphSize): number {
  return (size.top + size.bottom) / 2;
}
