import { describe, expect, it } from "vitest";
import {
  KATEX_FONT_SCALE,
  isFullWidth,
  labelWidthMargin,
  measureLabel,
  measureTex,
  measureText,
} from "./measure";

/** 組版の木を最後までたどれる（approximate にならない）式。 */
const KNOWN_TEX = [
  "x",
  "x^2",
  "x_{n+1}",
  "\\frac{a}{b}",
  "\\dfrac{\\pi}{2}",
  "\\sqrt{2}",
  "\\vec{F}",
  "\\overline{z}",
  "\\lvert x-a\\rvert",
  "\\sin\\theta",
  "\\mathrm{d}x",
  "\\iint_D f\\,dA",
  "\\oiint_S\\vec{F}\\cdot d\\vec{S}",
  "\\left(\\dfrac{1}{2}\\right)",
  "f(x)=2x^3-5x^2",
  "\\text{漢字}",
] as const;

describe("measureTex", () => {
  it("同じ入力に同じ寸法を返す", () => {
    expect(measureTex("\\dfrac{\\partial f}{\\partial x}", 12)).toEqual(
      measureTex("\\dfrac{\\partial f}{\\partial x}", 12),
    );
  });

  it.each(KNOWN_TEX)("%s を組版の木から見積もり、フォントサイズに比例させる", (tex) => {
    const small = measureTex(tex, 10);
    const large = measureTex(tex, 20);
    expect(small.approximate).toBe(false);
    expect(small.width).toBeGreaterThan(0);
    expect(large.width).toBeCloseTo(small.width * 2, 9);
    expect(large.height).toBeCloseTo(small.height * 2, 9);
    expect(large.depth).toBeCloseTo(small.depth * 2, 9);
  });

  it("字の多い式ほど幅を大きく見積もる", () => {
    expect(measureTex("x", 12).width).toBeLessThan(measureTex("xx", 12).width);
  });

  it("KaTeX がまとめた字の並び（数字の列）を 1 字ずつ数える", () => {
    expect(measureTex("123", 10).width).toBeCloseTo(measureTex("1", 10).width * 3, 9);
  });

  it("\\dfrac の高さと深さの和を \\frac より大きく見積もる", () => {
    const d = measureTex("\\dfrac{a}{b}", 12);
    const t = measureTex("\\frac{a}{b}", 12);
    expect(d.height + d.depth).toBeGreaterThan(t.height + t.depth);
  });

  it("全角の字を 1 字 1em（数式の大きさ、外側の 1.21 倍）と数える", () => {
    expect(measureTex("\\text{漢字}", 10).width).toBeCloseTo(2 * 10 * KATEX_FONT_SCALE, 9);
  });

  it("二重・三重の積分記号を、フォントの送り幅で単一の積分記号より広く見積もる", () => {
    const single = measureTex("\\int", 10).width;
    const double = measureTex("\\iint", 10).width;
    const triple = measureTex("\\iiint", 10).width;
    // KaTeX の寸法の表は ∫ を 0.47222em とし、∬・∭ にも同じ値を当てる。フォント（KaTeX_Size1）の
    // 送り幅は ∬ 0.819em・∭ 1.166em である。
    expect(double - single).toBeCloseTo((0.819 - 0.47222) * 10 * KATEX_FONT_SCALE, 9);
    expect(triple - double).toBeCloseTo((1.166 - 0.819) * 10 * KATEX_FONT_SCALE, 9);
  });

  it("字の大きさを変えるコマンドの中の字に、字の大きさの倍率を掛ける", () => {
    const x = measureTex("x", 10).width;
    // KaTeX の sizingMultiplier は \large が 1.2 倍、\scriptstyle（文中では段 3）が 0.7 倍である。
    expect(measureTex("\\large x", 10).width).toBeCloseTo(x * 1.2, 9);
    expect(measureTex("{\\scriptstyle x}", 10).width).toBeCloseTo(x * 0.7, 9);
    expect(measureTex("{\\scriptstyle xy}", 10).approximate).toBe(false);
  });

  it("KaTeX が寸法を持たない字を幅 0 と数えず、旧来の見積もりで代用する", () => {
    const m = measureTex("\\text{aθ}", 10);
    expect(m.approximate).toBe(true);
    expect(m.width).toBeGreaterThan(measureTex("\\text{a}", 10).width);
  });

  it("表（mtable）は木から見積もらず、旧来の見積もりで代用して approximate を返す", () => {
    const m = measureTex("\\begin{matrix}a&b\\end{matrix}", 10);
    expect(m.approximate).toBe(true);
    // 旧来の見積もりは 24px を下限とする。
    expect(m.width).toBeGreaterThanOrEqual(24);
  });

  it("組版に失敗した式は approximate を返す", () => {
    expect(measureTex("\\frac{", 10).approximate).toBe(true);
  });
});

describe("measureText", () => {
  it("全角の字を 1 字 1em と数える（数式と違い 1.21 倍しない）", () => {
    expect(measureText("漢字かな", 10)).toBe(40);
    expect(measureText("（・）", 10)).toBe(30);
  });

  it("欧文を Latin Modern Roman 10（cmr10 と同じ送り幅）の値で数える", () => {
    // cmr10 の数字は 0.5em、x は 0.528em である。
    expect(measureText("12", 10)).toBeCloseTo(10, 9);
    expect(measureText("x", 10)).toBeCloseTo(5.2778, 3);
    // Latin Modern Roman 10 の空白は 0.333em（KaTeX_Main の 0.25em より広い）である。
    expect(measureText(" ", 12)).toBeCloseTo(0.333 * 12, 9);
  });

  it("フォントサイズに比例させる", () => {
    expect(measureText("Ab 漢", 26)).toBeCloseTo(measureText("Ab 漢", 13) * 2, 9);
  });

  it("KaTeX が寸法を持たない字（θ・²）を 1em と数える", () => {
    expect(measureText("θ", 10)).toBe(10);
    expect(measureText("m²", 10)).toBeCloseTo(measureText("m", 10) + 10, 9);
  });
});

describe("isFullWidth", () => {
  it("和文の字と全角記号を全角とみなし、欧文と記号を半角とみなす", () => {
    expect(["漢", "か", "カ", "（", "・", "、"].every(isFullWidth)).toBe(true);
    expect(["a", "1", "(", "→", "×"].some(isFullWidth)).toBe(false);
  });
});

describe("measureLabel", () => {
  it("幅を行の幅の最大、高さを行の高さの和にする", () => {
    const m = measureLabel("ab\n漢字かな", 10, 15);
    expect(m.width).toBe(40);
    expect(m.height).toBe(30);
    expect(m.approximate).toBe(false);
  });

  it("行の幅を、地の文と数式の幅の和にする", () => {
    const m = measureLabel("判別式 $D$", 10, 15);
    expect(m.width).toBeCloseTo(measureText("判別式 ", 10) + measureTex("D", 10).width, 9);
  });

  it("行の両端の空白と、連続する空白の詰めを HTML と同じに扱う", () => {
    expect(measureLabel("  a   b  ", 10, 15).width).toBeCloseTo(measureText("a b", 10), 9);
  });

  it("行の高さより高い数式の行は、数式の高さと深さの和を行の高さにする", () => {
    const frac = measureTex("\\dfrac{1}{2}", 10);
    const m = measureLabel("a\n$\\dfrac{1}{2}$", 10, 12);
    expect(frac.height + frac.depth).toBeGreaterThan(12);
    expect(m.height).toBeCloseTo(12 + frac.height + frac.depth, 9);
  });
});

describe("labelWidthMargin", () => {
  it("幅の 3% を足し、短いラベルでも 1px は空ける", () => {
    expect(labelWidthMargin(10)).toBe(1);
    expect(labelWidthMargin(200)).toBeCloseTo(6, 9);
  });
});

// ブラウザでの実測との照合。actual は、main（6191fbd）をビルドした結果を Chrome で開き、
// `pnpm run figures:lint -- --dist .figures/base --all --labels` で測った字形の幅（図 SVG の px）
// である。部品・種類・式の形（分数・根号・アクセント・積分・絶対値・和文の混じる複数行）が
// 重ならないように選んだ。
//
// 許容幅は全 4806 件の誤差の分布から決める。
// - 過小側（実測 − 見積もり）は 0.5px まで。全件の最大は 0.43px（イタリックの p の字形が送り幅の
//   左へはみ出す分）である。
// - 過大側（見積もり − 実測）は数式の 0.25em まで。見積もりは送り幅を、実測は字形のインクを測る
//   ため、分数の左右の空の区切り（0.12em ずつ）や括弧・縦棒の左右の余白の分だけ見積もりが広く
//   なる。全角の括弧で始まる・終わる行は余白が 1em 近くになるので、表に入れない。
const MEASURED = [
  { source: "$x$", fontSize: 13, actual: 7.66 },
  { source: "$a^2$", fontSize: 13, actual: 12.75 },
  { source: "$\\dfrac12$", fontSize: 11, actual: 6.66 },
  { source: "$\\frac12$", fontSize: 14, actual: 5.94 },
  { source: "$\\sqrt{2}$", fontSize: 13, actual: 20.97 },
  { source: "$\\vec{i}$", fontSize: 12, actual: 6.83 },
  { source: "$\\overline{A} \\cap \\overline{B}$", fontSize: 12, actual: 38.77 },
  { source: "$\\lvert x-a\\rvert$", fontSize: 12, actual: 38.36 },
  { source: "$|\\vec{b}|\\sin\\theta$", fontSize: 12, actual: 41.96 },
  { source: "$p = 1$ か", fontSize: 13, actual: 53.81 },
  {
    source: "発散定理\n$\\iiint_V\\nabla\\cdot\\vec{F}\\,dV=\\oiint_S\\vec{F}\\cdot d\\vec{S}$",
    fontSize: 13,
    actual: 176.67,
  },
  {
    source: "$y=f(u)$ が\nおよそ $f'(u)\\,g'(x)\\,\\Delta x$ 変わる",
    fontSize: 13,
    actual: 178.19,
  },
] as const;

describe("ブラウザでの実測との照合", () => {
  it.each(MEASURED)("$source（$fontSize px）", ({ source, fontSize, actual }) => {
    const { width, approximate } = measureLabel(source, fontSize, 0);
    expect(approximate).toBe(false);
    expect(actual - width).toBeLessThanOrEqual(0.5);
    expect(width - actual).toBeLessThanOrEqual(0.25 * fontSize * KATEX_FONT_SCALE);
  });
});
