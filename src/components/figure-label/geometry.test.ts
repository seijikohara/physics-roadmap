import { describe, expect, it } from "vitest";
import {
  bboxOf,
  boxesOverlap,
  clamp,
  cumulativeLength,
  distanceToSegment,
  farPartHitsBox,
  inflate,
  lerpAt,
  nearestOnPolyline,
  pointAtLength,
  pointInPolygon,
  polylineHitsBox,
  segmentHitsBox,
  turnAngle,
  type Box,
  type XY,
} from "./geometry";

/** 左上 (0,0)・右下 (10,10) の正方形。 */
const UNIT: Box = { x0: 0, x1: 10, y0: 0, y1: 10 };

describe("bboxOf", () => {
  it("点列を囲む最小の矩形を返す", () => {
    expect(
      bboxOf([
        { x: 3, y: -1 },
        { x: -2, y: 4 },
        { x: 5, y: 2 },
      ]),
    ).toEqual({ x0: -2, x1: 5, y0: -1, y1: 4 });
  });

  it("点が無ければ空の矩形（下限が上限より大きい）を返す", () => {
    expect(bboxOf([])).toEqual({ x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
  });
});

describe("pointInPolygon", () => {
  // 右上の 1/4 を欠いた L 字の凹多角形。
  const lShape: readonly XY[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 5 },
    { x: 5, y: 5 },
    { x: 5, y: 10 },
    { x: 0, y: 10 },
  ];

  it("凸多角形の内側と外側を見分ける", () => {
    const square: readonly XY[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
  });

  it("凹多角形の欠けた部分を外側とみなす", () => {
    expect(pointInPolygon({ x: 2, y: 8 }, lShape)).toBe(true);
    expect(pointInPolygon({ x: 8, y: 2 }, lShape)).toBe(true);
    expect(pointInPolygon({ x: 8, y: 8 }, lShape)).toBe(false);
  });
});

describe("segmentHitsBox", () => {
  it("矩形を横切る線分を検出する", () => {
    expect(segmentHitsBox({ x: -5, y: 5 }, { x: 15, y: 5 }, UNIT)).toBe(true);
  });

  it("矩形の外を通る線分を交わらないとみなす", () => {
    expect(segmentHitsBox({ x: -5, y: -5 }, { x: 15, y: -1 }, UNIT)).toBe(false);
  });

  it("外接矩形は重なるが角の外を斜めに通る線分を交わらないとみなす", () => {
    expect(segmentHitsBox({ x: 8, y: -5 }, { x: 15, y: 2 }, UNIT)).toBe(false);
  });

  it("矩形の辺に端点が接する線分を交わるとみなす", () => {
    expect(segmentHitsBox({ x: 10, y: 5 }, { x: 20, y: 5 }, UNIT)).toBe(true);
  });

  it("矩形の辺に沿う線分を交わるとみなす", () => {
    expect(segmentHitsBox({ x: 2, y: 0 }, { x: 8, y: 0 }, UNIT)).toBe(true);
  });

  it("長さ 0 の線分は、点が矩形の内側にあるときだけ交わる", () => {
    expect(segmentHitsBox({ x: 3, y: 3 }, { x: 3, y: 3 }, UNIT)).toBe(true);
    expect(segmentHitsBox({ x: 13, y: 3 }, { x: 13, y: 3 }, UNIT)).toBe(false);
  });
});

describe("polylineHitsBox", () => {
  it("いずれかの線分が矩形と交われば真を返す", () => {
    const pts: readonly XY[] = [
      { x: -10, y: -10 },
      { x: -10, y: 5 },
      { x: 5, y: 5 },
    ];
    expect(polylineHitsBox(pts, UNIT)).toBe(true);
    expect(polylineHitsBox(pts.slice(0, 2), UNIT)).toBe(false);
  });

  it("1 点だけの折れ線は交わらない", () => {
    expect(polylineHitsBox([{ x: 5, y: 5 }], UNIT)).toBe(false);
  });
});

describe("farPartHitsBox", () => {
  // y = 5 を x = 0 から 40 まで進む折れ線（4 本の線分、各長さ 10）。矩形に入るのは 1 本目の線分
  // （中点の弧長 5）だけである。
  const line: readonly XY[] = [0, 10, 20, 30, 40].map((x) => ({ x, y: 5 }));
  const cum = cumulativeLength(line);
  const box: Box = { x0: 2, x1: 8, y0: 0, y1: 10 };

  it("弧長の窓の内側の線分は無視する", () => {
    expect(farPartHitsBox(line, cum, 5, 6, false, box)).toBe(false);
  });

  it("弧長の窓の外側の線分は交差を数える", () => {
    expect(farPartHitsBox(line, cum, 35, 6, false, box)).toBe(true);
  });

  it("閉じた線では一周の長さで巻き戻して距離を測る", () => {
    // 一周 40 の閉じた線とみなすと、弧長 38 と 1 本目の線分の中点 5 の距離は 7 になる。
    expect(farPartHitsBox(line, cum, 38, 8, true, box)).toBe(false);
    expect(farPartHitsBox(line, cum, 38, 8, false, box)).toBe(true);
  });
});

describe("distanceToSegment", () => {
  it("線分の内側への垂線の長さを返す", () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
  });

  it("垂線の足が線分の外なら端点までの距離を返す", () => {
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it("長さ 0 の線分では点までの距離を返す", () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe("cumulativeLength と pointAtLength", () => {
  const pts: readonly XY[] = [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 3, y: 4 },
  ];
  const cum = cumulativeLength(pts);

  it("各頂点までの累積の長さを返す", () => {
    expect(cum).toEqual([0, 3, 7]);
    expect(cumulativeLength([{ x: 1, y: 1 }])).toEqual([0]);
  });

  it("弧長の位置を辺の上で補間する", () => {
    expect(pointAtLength(pts, cum, 1.5, false)).toEqual({ x: 1.5, y: 0 });
    expect(pointAtLength(pts, cum, 5, false)).toEqual({ x: 3, y: 2 });
  });

  it("開いた線では範囲外の弧長を端に丸める", () => {
    expect(pointAtLength(pts, cum, -2, false)).toEqual({ x: 0, y: 0 });
    expect(pointAtLength(pts, cum, 99, false)).toEqual({ x: 3, y: 4 });
  });

  it("閉じた線では範囲外の弧長を一周の長さで巻き戻す", () => {
    expect(pointAtLength(pts, cum, 8.5, true)).toEqual({ x: 1.5, y: 0 });
    expect(pointAtLength(pts, cum, -2, true)).toEqual({ x: 3, y: 2 });
  });
});

describe("turnAngle", () => {
  it("直進は 0、直角は π/2、折り返しは π を返す", () => {
    const a = { x: 0, y: 0 };
    const p = { x: 1, y: 0 };
    expect(turnAngle(a, p, { x: 2, y: 0 })).toBe(0);
    expect(turnAngle(a, p, { x: 1, y: 1 })).toBeCloseTo(Math.PI / 2);
    expect(turnAngle(a, p, { x: 0, y: 0 })).toBeCloseTo(Math.PI);
  });
});

describe("inflate と boxesOverlap", () => {
  it("矩形を四方へ広げる", () => {
    expect(inflate(UNIT, 2)).toEqual({ x0: -2, x1: 12, y0: -2, y1: 12 });
  });

  it("重なる矩形を検出し、辺で接するだけの矩形は重ならないとみなす", () => {
    expect(boxesOverlap(UNIT, { x0: 5, x1: 15, y0: 5, y1: 15 })).toBe(true);
    expect(boxesOverlap(UNIT, { x0: 10, x1: 20, y0: 0, y1: 10 })).toBe(false);
    expect(boxesOverlap(UNIT, inflate({ x0: 10, x1: 20, y0: 0, y1: 10 }, 0.5))).toBe(true);
  });
});

describe("clamp と lerpAt", () => {
  it("値を範囲に丸める", () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(2, 0, 1)).toBe(1);
  });

  it("2 点を内分・外分する", () => {
    const p = { x: 0, y: 0 };
    const q = { x: 10, y: 20 };
    expect(lerpAt(p, q, 0.25)).toEqual({ x: 2.5, y: 5 });
    expect(lerpAt(p, q, 1.5)).toEqual({ x: 15, y: 30 });
  });
});

describe("nearestOnPolyline", () => {
  const path = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];

  it("辺の内側の最も近い点と距離を返す", () => {
    expect(nearestOnPolyline(path, { x: 5, y: 3 })).toEqual({ point: { x: 5, y: 0 }, distance: 3 });
  });

  it("端点が最も近いときは端点を返す", () => {
    expect(nearestOnPolyline(path, { x: -3, y: -4 })).toEqual({
      point: { x: 0, y: 0 },
      distance: 5,
    });
  });
});
