import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Triangle from "./Triangle";
import UnitCircle from "./UnitCircle";

/** 描いたラベルの数。 */
const labelCount = (html: string): number => html.match(/<foreignObject/g)?.length ?? 0;

/** ラベルの基準点の x・y の並び。 */
const labelFrames = (html: string): readonly string[] =>
  [...html.matchAll(/<foreignObject x="([^"]+)" y="([^"]+)"/g)].map((m) => `${m[1]},${m[2]}`);

const circle = (props: Partial<ComponentProps<typeof UnitCircle>>): string =>
  renderToStaticMarkup(createElement(UnitCircle, { angleDeg: 50, ariaLabel: "図", ...props }));

describe("UnitCircle のラベル", () => {
  it("軸名 2 つ・余弦・正弦・角の 5 つを描く", () => {
    expect(labelCount(circle({}))).toBe(5);
  });

  it("先端のラベルを足す", () => {
    expect(labelCount(circle({ pointLabel: "P" }))).toBe(6);
  });

  it("射影を描かない図は、余弦と正弦のラベルを描かない", () => {
    expect(labelCount(circle({ showProjections: false }))).toBe(3);
  });

  it("角を描かない図は、角のラベルを描かない", () => {
    expect(labelCount(circle({ showAngle: false }))).toBe(4);
  });

  it("どの象限の角でもラベルを描く", () => {
    for (const angleDeg of [50, 130, 230, 310, -40, 90, 180]) {
      expect(labelCount(circle({ angleDeg, pointLabel: "P" }))).toBe(6);
    }
  });
});

describe("Triangle のラベル", () => {
  const vertices: ComponentProps<typeof Triangle>["vertices"] = [
    { x: 0, y: 0, label: "A" },
    { x: 4, y: 0, label: "B" },
    { x: 4, y: 3, label: "C" },
  ];
  const triangle = (props: Partial<ComponentProps<typeof Triangle>>): string =>
    renderToStaticMarkup(createElement(Triangle, { vertices, ariaLabel: "図", ...props }));

  it("頂点・辺・角・高さ・足のラベルを描く", () => {
    const html = triangle({
      edges: [{ from: 0, to: 1, label: "c" }],
      angles: [
        { at: 0, label: "\\theta" },
        { at: 1, right: true },
      ],
      perpendiculars: [
        {
          from: { x: 4, y: 3 },
          foot: { x: 4, y: 0 },
          toward: { x: 0, y: 0 },
          label: "h",
          footLabel: "H",
        },
      ],
    });
    expect(labelCount(html)).toBe(7);
  });

  it("名前の無い頂点にはラベルを描かない", () => {
    const html = triangle({
      vertices: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 3 },
      ],
    });
    expect(labelCount(html)).toBe(0);
  });

  it("頂点の labelDir で向きを固定する", () => {
    const fixed = (labelDir: "left" | "right"): string =>
      triangle({
        vertices: [{ x: 0, y: 0, label: "A", labelDir }, vertices[1], vertices[2]],
      });
    expect(labelFrames(fixed("left"))[0]).not.toBe(labelFrames(fixed("right"))[0]);
  });

  it("辺の labelDir で向きを固定する", () => {
    const fixed = (labelDir: "above" | "below"): string =>
      triangle({ edges: [{ from: 0, to: 1, label: "c", labelDir }] });
    expect(labelFrames(fixed("above")).at(-1)).toBeDefined();
    expect(labelFrames(fixed("above"))).not.toEqual(labelFrames(fixed("below")));
  });
});
