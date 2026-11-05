import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SurfacePlot from "./SurfacePlot";

type Props = ComponentProps<typeof SurfacePlot>;

const render = (props: Partial<Props>): string =>
  renderToStaticMarkup(createElement(SurfacePlot, { ariaLabel: "図", ...props }));

/** 描いたラベルの数。軸名 3 つを含む。 */
const labelCount = (html: string): number => html.match(/<foreignObject/g)?.length ?? 0;

/** 原点のまわりの正方形の、不透明な水平面。 */
const OPAQUE_FLOOR: Props["planes"] = [
  {
    kind: "polygon",
    vertices: [
      { x: -2, y: -2, z: 1 },
      { x: 2, y: -2, z: 1 },
      { x: 2, y: 2, z: 1 },
      { x: -2, y: 2, z: 1 },
    ],
    opacity: 1,
  },
];

describe("SurfacePlot のラベル", () => {
  it("有限の標本が無い曲線のラベルは置かない", () => {
    const html = render({
      curves: [{ fn: () => ({ x: Number.NaN, y: 0, z: 0 }), t: [0, 1], label: "c" }],
    });
    expect(labelCount(html)).toBe(3);
  });

  it("描く点のラベルを置く", () => {
    const html = render({ points: [{ x: 1, y: 1, z: 1, label: "P" }] });
    expect(labelCount(html)).toBe(4);
  });

  it("面に隠れて描かない点のラベルは置かない", () => {
    const point = { x: 0, y: 0, z: 0, label: "P", hidden: "hide" } as const;
    const html = render({ planes: OPAQUE_FLOOR, points: [point] });
    expect(labelCount(html)).toBe(3);
  });

  it("白抜きの点は背景の色で塗る", () => {
    const html = render({ points: [{ x: 1, y: 1, z: 1, open: true }] });
    expect(html).toContain('fill="var(--sl-color-bg, #fff)"');
  });

  it("線分の向きを固定すると線分の中点の上に置く", () => {
    const segment = (labelDir: "above" | "below"): string =>
      render({
        segments: [{ from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 }, label: "s", labelDir }],
      });
    expect(segment("above")).not.toBe(segment("below"));
  });
});
