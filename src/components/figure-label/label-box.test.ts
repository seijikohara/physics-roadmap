import { describe, expect, it } from "vitest";
import { glyphBox, glyphCenterOffset, glyphSizeOf } from "./label-box";
import { labelWidthMargin, measureTex } from "./measure";

/**
 * Chrome で測った字形の上端と下端（基準点の y からの差、px）。`figures:lint` の `--labels` の字形の
 * 矩形と配置の枠から求めた。字の大きさは ContourPlot が KatexLabel に渡す値である。
 */
const MEASURED: readonly (readonly [string, number, number, number])[] = [
  ["x", 13, -2.89, 4.24],
  ["y", 13, -2.89, 7.29],
  ["1", 11, -5.85, 3.01],
  ["3", 11, -5.84, 3.3],
  ["-1", 11, -5.85, 3.01],
  ["2\\pi", 11, -5.85, 3.16],
  ["c=1", 11, -5.85, 3.16],
  ["f=1", 11, -6.37, 5.74],
  ["D", 12, -6.12, 3.8],
  ["\\mathrm{O}", 12, -5.94, 4.62],
  ["(1,1)", 12, -6.6, 7.92],
  ["\\nabla f", 12, -6.44, 6.77],
  ["\\vec{u}", 12, -6.06, 4.46],
  ["\\sqrt2", 11, -9.05, 5.31],
  ["\\dfrac{3\\pi}{2}", 11, -13.64, 13.35],
  ["山頂", 12, -7.2, 5.96],
];

describe("glyphSizeOf", () => {
  it.each(MEASURED)(
    "%s（%dpx）の字形が見積もりの外へ 1px より大きくはみ出さない",
    (tex, px, t, b) => {
      const { top, bottom } = glyphSizeOf(tex, px);
      expect(top - t).toBeLessThanOrEqual(1);
      expect(b - bottom).toBeLessThanOrEqual(1);
    },
  );

  it("マイナス記号を除けば、上端と下端の誤差が 1px 以内である", () => {
    const plain = MEASURED.filter(([tex]) => !tex.includes("-"));
    const errors = plain.flatMap(([tex, px, t, b]) => {
      const { top, bottom } = glyphSizeOf(tex, px);
      return [Math.abs(top - t), Math.abs(bottom - b)];
    });
    expect(Math.max(...errors)).toBeLessThanOrEqual(1);
  });

  it("幅に安全の余白を含める", () => {
    const measured = measureTex("c=1", 11).width;
    expect(glyphSizeOf("c=1", 11).width).toBeCloseTo(measured + labelWidthMargin(measured), 9);
  });

  it("低い字ほど、字形の中心が基準点より下に寄る", () => {
    expect(glyphCenterOffset(glyphSizeOf("x", 13))).toBeGreaterThan(
      glyphCenterOffset(glyphSizeOf("D", 13)),
    );
    expect(glyphCenterOffset(glyphSizeOf("x", 13))).toBeGreaterThan(0);
  });
});

describe("glyphBox", () => {
  const size = { width: 20, top: -6, bottom: 4 };

  it("中央寄せは基準点の左右へ半分ずつ広げる", () => {
    expect(glyphBox({ x: 100, y: 50, align: "center" }, size)).toEqual({
      x0: 90,
      x1: 110,
      y0: 44,
      y1: 54,
    });
  });

  it("左寄せは基準点を左端とする", () => {
    expect(glyphBox({ x: 100, y: 50, align: "left" }, size).x0).toBe(100);
    expect(glyphBox({ x: 100, y: 50, align: "left" }, size).x1).toBe(120);
  });

  it("右寄せは基準点を右端とする", () => {
    expect(glyphBox({ x: 100, y: 50, align: "right" }, size).x0).toBe(80);
    expect(glyphBox({ x: 100, y: 50, align: "right" }, size).x1).toBe(100);
  });
});
