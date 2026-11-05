import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { labelWidthMargin, measureLabel } from "./figure-label/measure";
import FlowChart, { diamondHeight, routeAroundNodes, type PlacedNode } from "./FlowChart";

const node = (id: string, x: number, y: number, width = 60, height = 30): PlacedNode => ({
  id,
  label: id,
  shape: "rect",
  width,
  height,
  labelW: width,
  labelH: height,
  x,
  y,
});

const render = (props: Partial<ComponentProps<typeof FlowChart>>): string =>
  renderToStaticMarkup(createElement(FlowChart, { ariaLabel: "図", nodes: [], ...props }));

/** 最初の foreignObject の幅。 */
const firstLabelWidth = (html: string): number =>
  Number(/<foreignObject[^>]*width="([\d.]+)"/.exec(html)?.[1]);

describe("diamondHeight", () => {
  it("ラベルの角が輪郭から 4px 内側に収まる", () => {
    const contentW = 120;
    const contentH = 40;
    const width = contentW * 1.5 + 28;
    const height = diamondHeight(contentW, contentH, width);
    expect((contentW + 8) / width + (contentH + 8) / height).toBeCloseTo(1);
  });

  it("小さなラベルでは、高さの下限を使う", () => {
    expect(diamondHeight(30, 20, 400)).toBeCloseTo(20 * 1.7 + 24);
  });
});

describe("routeAroundNodes", () => {
  const from = node("from", 200, 0);
  const to = node("to", 0, 100);
  const neighbor = node("neighbor", 100, 0);

  it("隣の箱を横切る始点を、ノードの下の辺の中央へ移す", () => {
    const points = [
      { x: 170, y: 3 },
      { x: 0, y: 40 },
      { x: 10, y: 85 },
    ];
    const routed = routeAroundNodes(points, from, to, [from, to, neighbor], "TB");
    expect(routed).toEqual([{ x: 200, y: 15 }, points[1], points[2]]);
  });

  it("箱を横切らない経路はそのまま返す", () => {
    const points = [
      { x: 195, y: 15 },
      { x: 150, y: 50 },
      { x: 10, y: 85 },
    ];
    expect(routeAroundNodes(points, from, to, [from, to, neighbor], "TB")).toEqual(points);
  });

  it("終点の線分だけが箱を横切るときは、終点だけをノードの上の辺の中央へ移す", () => {
    const target = node("target", 200, 100);
    const source = node("source", 0, 0);
    const box = node("box", 110, 90);
    const points = [
      { x: 5, y: 15 },
      { x: 0, y: 40 },
      { x: 170, y: 96 },
    ];
    const routed = routeAroundNodes(points, source, target, [source, target, box], "TB");
    expect(routed).toEqual([points[0], points[1], { x: 200, y: 85 }]);
  });

  it("横向きの図では、ノードの右の辺の中央から出す", () => {
    const left = node("left", 0, 200);
    const right = node("right", 100, 0);
    const blocker = node("blocker", 10, 100);
    const points = [
      { x: 3, y: 170 },
      { x: 40, y: 0 },
      { x: 70, y: 0 },
    ];
    const routed = routeAroundNodes(points, left, right, [left, right, blocker], "LR");
    expect(routed[0]).toEqual({ x: 30, y: 200 });
  });

  it("横向きの図では、ノードの左の辺の中央へ入れる", () => {
    const left = node("left", 0, 0);
    const right = node("right", 200, 100);
    const blocker = node("blocker", 150, 60);
    const points = [
      { x: 30, y: 0 },
      { x: 60, y: 0 },
      { x: 170, y: 98 },
    ];
    const routed = routeAroundNodes(points, left, right, [left, right, blocker], "LR");
    expect(routed.at(-1)).toEqual({ x: 170, y: 100 });
  });

  it("逆向きの経路では、次の点の側の辺から出す", () => {
    const lower = node("lower", 200, 200);
    const upper = node("upper", 0, 0);
    const blocker = node("blocker", 100, 170);
    const points = [
      { x: 170, y: 197 },
      { x: 60, y: 150 },
      { x: 0, y: 15 },
    ];
    const routed = routeAroundNodes(points, lower, upper, [lower, upper, blocker], "TB");
    expect(routed[0]).toEqual({ x: 200, y: 185 });
  });

  it("移した線分もまだ箱に当たるときは、ランクの方向へ進んでから折れる", () => {
    const tall = node("tall", 100, 40, 60, 120);
    const points = [
      { x: 170, y: 3 },
      { x: 0, y: 40 },
      { x: 10, y: 85 },
    ];
    const routed = routeAroundNodes(points, from, to, [from, to, tall], "TB");
    expect(routed.slice(0, 3)).toEqual([{ x: 200, y: 15 }, { x: 200, y: 40 }, points[1]]);
  });
});

describe("FlowChart のラベルの寸法", () => {
  const nodes = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ];

  it("エッジのチップは、字の幅に見積もりの余白と左右の余白を足した幅である", () => {
    const html = render({ nodes, edges: [{ from: "a", to: "b", label: "f" }] });
    const { width } = measureLabel("f", 12, 12 * 1.4);
    expect(firstLabelWidth(html)).toBeCloseTo(width + labelWidthMargin(width) + 10);
  });

  it("短いラベルのノードは、字 2 個分の幅を下限にする", () => {
    const html = render({ nodes: [{ id: "a", label: "A" }] });
    expect(html).toContain(`width="${13 * 2 + 28}"`);
  });

  it("菱形は diamondHeight の高さで描く", () => {
    const label = "長いラベルの判断";
    const html = render({ nodes: [{ id: "a", label, shape: "diamond" }] });
    const { width, height } = measureLabel(label, 13, 13 * 1.5);
    const w = width + labelWidthMargin(width);
    const expected = diamondHeight(w, height, w * 1.5 + 28);
    const points = /<polygon[^>]*points="([^"]+)"/.exec(html)?.[1] ?? "";
    const ys = points.split(" ").map((p) => Number(p.split(",")[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(expected, 1);
  });
});
