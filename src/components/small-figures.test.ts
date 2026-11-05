import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AreaModel from "./AreaModel";
import NumberLine from "./NumberLine";
import Triangle from "./Triangle";
import UnitCircle from "./UnitCircle";

/** 描いたラベルの数。 */
const labelCount = (html: string): number => html.match(/<foreignObject/g)?.length ?? 0;

/** ラベルの枠の中心。枠の大きさは width・height の属性から求める。 */
const labelCenters = (html: string): readonly Readonly<{ x: number; y: number }>[] =>
  [
    ...html.matchAll(/<foreignObject x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g),
  ].map((m) => ({
    x: Number(m[1]) + Number(m[3]) / 2,
    y: Number(m[2]) + Number(m[4]) / 2,
  }));

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

  it("軸の上の角でも、ラベルを原点の軸の交点に置かない", () => {
    for (const angleDeg of [0, 90, 180, 270, -90]) {
      const centers = labelCenters(circle({ angleDeg }));
      expect(centers.some((c) => Math.hypot(c.x - 140, c.y - 140) < 8)).toBe(false);
    }
  });

  it("ラベルどうしの基準点は離れる", () => {
    for (const angleDeg of Array.from({ length: 12 }, (_, i) => i * 30)) {
      const centers = labelCenters(circle({ angleDeg, pointLabel: "P" }));
      const distinct = new Set(centers.map((c) => `${Math.round(c.x)},${Math.round(c.y)}`));
      expect(distinct.size).toBe(centers.length);
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
    expect(labelFrames(fixed("above"))).not.toEqual(labelFrames(fixed("below")));
  });

  it("頂点の labelOffset で点から離す", () => {
    const leftOf = (labelOffset: number): number =>
      Number(
        labelFrames(
          triangle({
            vertices: [
              { x: 0, y: 0, label: "A", labelDir: "left", labelOffset },
              vertices[1],
              vertices[2],
            ],
          }),
        )[0]?.split(",")[0],
      );
    expect(leftOf(14)).toBeCloseTo(leftOf(4) - 10);
  });

  it("高さのラベルは足の直角の印を避ける", () => {
    const html = triangle({
      vertices: [
        { x: 0, y: 0 },
        { x: 6, y: 0 },
        { x: 2, y: 0.5 },
      ],
      perpendiculars: [
        { from: { x: 2, y: 0.5 }, foot: { x: 2, y: 0 }, toward: { x: 0, y: 0 }, label: "h" },
      ],
    });
    expect(labelCount(html)).toBe(1);
  });
});

describe("行のラベルの基線", () => {
  it("NumberLine の目盛り数字は同じ高さに並ぶ", () => {
    const html = renderToStaticMarkup(
      createElement(NumberLine, {
        min: 0,
        max: 4,
        ariaLabel: "図",
        ticks: [
          { value: 1, label: "a" },
          { value: 2, label: "\\sqrt{2}" },
          { value: 3, label: "\\dfrac{1}{2}" },
        ],
      }),
    );
    expect(new Set(labelFrames(html).map((f) => f.split(",")[1])).size).toBe(1);
  });

  it("AreaModel の列のラベルは同じ高さに並ぶ", () => {
    const html = renderToStaticMarkup(
      createElement(AreaModel, {
        ariaLabel: "図",
        columns: [
          { label: "a", length: 1 },
          { label: "\\dfrac{1}{2}", length: 1 },
        ],
        rows: [{ label: "b", length: 1 }],
        cells: [],
      }),
    );
    const ys = labelFrames(html).map((f) => f.split(",")[1]);
    expect(ys[0]).toBe(ys[1]);
  });
});
