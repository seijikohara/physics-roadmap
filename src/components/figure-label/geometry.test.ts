import { describe, expect, it } from "vitest";
import {
  arrowHead,
  bboxOf,
  boxGap,
  boxesOverlap,
  clamp,
  cumulativeLength,
  distanceToBox,
  distanceToSegment,
  farPartBoxDistance,
  headInside,
  inflate,
  lerpAt,
  nearestOnPolyline,
  pointAtLength,
  pointInPolygon,
  polylineBoxDistance,
  segmentBoxDistance,
  segmentHitsBox,
  turnAngle,
  type Box,
  type ScreenArrow,
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

describe("polylineBoxDistance", () => {
  it("線分が矩形と交わるときは 0 を返す", () => {
    const pts: readonly XY[] = [
      { x: -10, y: -10 },
      { x: -10, y: 5 },
      { x: 5, y: 5 },
    ];
    expect(polylineBoxDistance(pts, UNIT, 100)).toBe(0);
  });

  it("線分が 1 本も無ければ Infinity を返す", () => {
    expect(polylineBoxDistance([{ x: 5, y: 5 }], UNIT, 100)).toBe(Infinity);
  });

  it("広げた範囲の外にある線分は調べない", () => {
    const far: readonly XY[] = [
      { x: 30, y: -5 },
      { x: 30, y: 15 },
    ];
    expect(polylineBoxDistance(far, UNIT, 5)).toBe(Infinity);
    expect(polylineBoxDistance(far, UNIT, 25)).toBe(20);
  });
});

describe("segmentBoxDistance", () => {
  it("線分が矩形を横切るときは 0 を返す", () => {
    expect(segmentBoxDistance({ x: -5, y: 5 }, { x: 15, y: 5 }, UNIT)).toBe(0);
  });

  it("矩形の隅から線分の内側までの距離を返す", () => {
    // 右上の隅 (10, 0) を通る 45 度の線を、外へ 3√2 だけずらした線。
    const a = { x: 0, y: -16 };
    const b = { x: 26, y: 10 };
    expect(segmentBoxDistance(a, b, UNIT)).toBeCloseTo((16 - 10) * Math.SQRT1_2, 9);
  });

  it("線分の端から矩形の辺までの距離を、どちらの端でも返す", () => {
    expect(segmentBoxDistance({ x: 5, y: 13 }, { x: 5, y: 30 }, UNIT)).toBe(3);
    expect(segmentBoxDistance({ x: 5, y: 30 }, { x: 5, y: 13 }, UNIT)).toBe(3);
  });

  it.each([
    ["左上", { x: 0, y: 0 }, -1, -1],
    ["右上", { x: 10, y: 0 }, 1, -1],
    ["左下", { x: 0, y: 10 }, -1, 1],
    ["右下", { x: 10, y: 10 }, 1, 1],
  ])("%s の隅に最も近い 45 度の線の距離を返す", (_, corner, sx, sy) => {
    // 隅から外へ 4px 離れた点を通り、隅を向く方向に直交する線分。
    const c = { x: corner.x + (sx * 4) / Math.SQRT2, y: corner.y + (sy * 4) / Math.SQRT2 };
    const a = { x: c.x + sy * 30, y: c.y - sx * 30 };
    const b = { x: c.x - sy * 30, y: c.y + sx * 30 };
    expect(segmentBoxDistance(a, b, UNIT)).toBeCloseTo(4, 9);
  });

  it("矩形を広げる方式と違い、45 度の線が角の先を通っても距離どおりに測る", () => {
    // 矩形の隅から 8px 離れた 45 度の線は、6px 広げた矩形の角 (16, 16) の内側を通る。
    const off = 8 * Math.SQRT2;
    const a = { x: 10 + off + 20, y: 10 - 20 };
    const b = { x: 10 + off - 20, y: 10 + 20 };
    expect(segmentHitsBox(a, b, { x0: -6, x1: 16, y0: -6, y1: 16 })).toBe(true);
    expect(segmentBoxDistance(a, b, UNIT)).toBeCloseTo(8, 9);
  });
});

describe("boxGap", () => {
  it("重なる矩形は 0 を返す", () => {
    expect(boxGap(UNIT, { x0: 5, x1: 15, y0: 5, y1: 15 })).toBe(0);
  });

  it("横に並ぶ矩形は横のすきまを返す", () => {
    expect(boxGap(UNIT, { x0: 13, x1: 20, y0: 0, y1: 10 })).toBe(3);
    expect(boxGap({ x0: 13, x1: 20, y0: 0, y1: 10 }, UNIT)).toBe(3);
  });

  it("縦に並ぶ矩形は縦のすきまを返す", () => {
    expect(boxGap(UNIT, { x0: 0, x1: 10, y0: 14, y1: 20 })).toBe(4);
    expect(boxGap({ x0: 0, x1: 10, y0: 14, y1: 20 }, UNIT)).toBe(4);
  });

  it("斜めに離れた矩形は隅どうしの距離を返す", () => {
    expect(boxGap(UNIT, { x0: 13, x1: 20, y0: 14, y1: 20 })).toBe(5);
  });
});

describe("distanceToBox", () => {
  it("内側の点は 0 を返す", () => {
    expect(distanceToBox({ x: 5, y: 5 }, UNIT)).toBe(0);
  });

  it("隅の外の点は隅までの距離を返す", () => {
    expect(distanceToBox({ x: 13, y: 14 }, UNIT)).toBe(5);
  });
});

describe("farPartBoxDistance", () => {
  // y = 5 を x = 0 から 40 まで進む折れ線（4 本の線分、各長さ 10）。矩形に入るのは 1 本目の線分
  // （中点の弧長 5）だけである。
  const line: readonly XY[] = [0, 10, 20, 30, 40].map((x) => ({ x, y: 5 }));
  const cum = cumulativeLength(line);
  const box: Box = { x0: 2, x1: 8, y0: 0, y1: 10 };

  it("弧長の窓の内側の線分は無視する", () => {
    expect(farPartBoxDistance(line, cum, 5, 6, false, box, 1)).toBe(Infinity);
  });

  it("弧長の窓の外側の線分は距離を数える", () => {
    expect(farPartBoxDistance(line, cum, 35, 6, false, box, 1)).toBe(0);
  });

  it("閉じた線では一周の長さで巻き戻して距離を測る", () => {
    // 矩形は x = 2 から 8 にある。一周 40 の閉じた線では、弧長 38 の窓 ±12 が弧長 10 までを覆う。
    expect(farPartBoxDistance(line, cum, 38, 12, true, box, 1)).toBe(Infinity);
    expect(farPartBoxDistance(line, cum, 38, 12, false, box, 1)).toBe(0);
  });

  it("長い線分を弧長の窓で切り、窓の外の部分だけを測る", () => {
    const long: readonly XY[] = [
      { x: 0, y: 5 },
      { x: 100, y: 5 },
    ];
    const longCum = cumulativeLength(long);
    const on: Box = { x0: 45, x1: 55, y0: 0, y1: 10 };
    // 窓の外の端は x = 40 と 60 で、矩形から 5 離れる。
    expect(farPartBoxDistance(long, longCum, 50, 10, false, on, 20)).toBe(5);
  });

  it("長い線分でも、窓が線分全体を覆えば数えない", () => {
    const short: readonly XY[] = [
      { x: 40, y: 5 },
      { x: 60, y: 5 },
    ];
    const on: Box = { x0: 45, x1: 55, y0: 0, y1: 10 };
    expect(farPartBoxDistance(short, cumulativeLength(short), 10, 15, false, on, 20)).toBe(
      Infinity,
    );
  });

  describe("窓が長い線分を 2 片に切るとき", () => {
    const long: readonly XY[] = [
      { x: 0, y: 5 },
      { x: 100, y: 5 },
    ];
    const longCum = cumulativeLength(long);

    it("矩形を左の片へ寄せると、左の片の距離を返す", () => {
      const left: Box = { x0: 10, x1: 20, y0: 8, y1: 12 };
      expect(farPartBoxDistance(long, longCum, 50, 10, false, left, 5)).toBe(3);
    });

    it("矩形を右の片へ寄せると、右の片の距離を返す", () => {
      const right: Box = { x0: 80, x1: 90, y0: 8, y1: 12 };
      expect(farPartBoxDistance(long, longCum, 50, 10, false, right, 5)).toBe(3);
    });
  });

  it("近い線分のあとに遠い線分が続いても、近い線分の距離を保つ", () => {
    // 矩形に近いのは 1 本目だけである。2 本目は窓で 2 片に切れ、どちらの片も矩形から遠い。
    const bent: readonly XY[] = [
      { x: 0, y: 5 },
      { x: 30, y: 5 },
      { x: 30, y: 100 },
    ];
    const above: Box = { x0: 10, x1: 20, y0: 8, y1: 12 };
    expect(farPartBoxDistance(bent, cumulativeLength(bent), 110, 5, false, above, 20)).toBe(3);
  });

  it("頂点が重なる線でも距離を測る", () => {
    // 2 本目の線分の長さは 0 である。弧長の比を求められないので、長さ 0 の線分を測らない。
    const doubled: readonly XY[] = [
      { x: 0, y: 5 },
      { x: 10, y: 5 },
      { x: 10, y: 5 },
      { x: 20, y: 5 },
    ];
    const above: Box = { x0: 12, x1: 18, y0: 8, y1: 12 };
    expect(farPartBoxDistance(doubled, cumulativeLength(doubled), 0, 1, false, above, 5)).toBe(3);
  });

  it("閉じた線の窓が始点をまたぐとき、長い線分の両端を切る", () => {
    // 一辺 40 の正方形。弧長 2 の窓 ±6 は、始点の前後の辺の一部だけを覆う。
    const square: readonly XY[] = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
      { x: 0, y: 40 },
      { x: 0, y: 0 },
    ];
    const near: Box = { x0: -1, x1: 3, y0: -1, y1: 3 };
    const cumSquare = cumulativeLength(square);
    // 窓の外で最も近いのは、上の辺の x = 8 と左の辺の y = 4 である。
    expect(farPartBoxDistance(square, cumSquare, 2, 6, true, near, 10)).toBeCloseTo(1, 9);
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

  it("辺の内側の最も近い点と距離と弧長を返す", () => {
    expect(nearestOnPolyline(path, { x: 5, y: 3 })).toEqual({
      point: { x: 5, y: 0 },
      distance: 3,
      arc: 5,
    });
  });

  it("後の辺の点の弧長は前の辺の長さを含む", () => {
    expect(nearestOnPolyline(path, { x: 13, y: 4 }).arc).toBe(14);
  });

  it("端点が最も近いときは端点を返す", () => {
    expect(nearestOnPolyline(path, { x: -3, y: -4 })).toEqual({
      point: { x: 0, y: 0 },
      distance: 5,
      arc: 0,
    });
  });
});

describe("arrowHead", () => {
  it("矢じりの根元と両端の点を返す", () => {
    const head = arrowHead({ from: { x: 0, y: 0 }, to: { x: 20, y: 0 } }, 6, 2.4);
    expect(head).toEqual({
      base: { x: 14, y: 0 },
      left: { x: 14, y: 2.4 },
      right: { x: 14, y: -2.4 },
    });
  });

  it("短い矢印では矢じりを矢印の 8 割に縮める", () => {
    const head = arrowHead({ from: { x: 0, y: 0 }, to: { x: 5, y: 0 } }, 6, 2.4);
    expect(head?.base.x).toBeCloseTo(1, 9);
    expect(head?.left.y).toBeCloseTo(1.6, 9);
  });

  it("長さ 0 の矢印には null を返す", () => {
    expect(arrowHead({ from: { x: 1, y: 1 }, to: { x: 1, y: 1 } }, 6, 2.4)).toBeNull();
  });
});

/** 先端が (x, 50) にある、長さ 30 の右向きの矢印。 */
function toX(x: number): ScreenArrow {
  return { from: { x: x - 30, y: 50 }, to: { x, y: 50 } };
}

describe("headInside", () => {
  const win: Box = { x0: 0, x1: 100, y0: 0, y1: 100 };

  it("矢じりが窓の中にあれば真を返す", () => {
    expect(headInside(toX(90), win, 6, 2.4)).toBe(true);
  });

  it("先端だけが窓から出る矢印を残す", () => {
    expect(headInside(toX(102), win, 6, 2.4)).toBe(true);
  });

  it("矢じりの中ほどが窓の外にある矢印を省く", () => {
    expect(headInside(toX(104), win, 6, 2.4)).toBe(false);
  });

  it("左・上・下の縁も同じように判定する", () => {
    const toLeft = { from: { x: 26, y: 50 }, to: { x: -4, y: 50 } };
    const toTop = { from: { x: 50, y: 26 }, to: { x: 50, y: -4 } };
    const toBottom = { from: { x: 50, y: 74 }, to: { x: 50, y: 104 } };
    expect(headInside(toLeft, win, 6, 2.4)).toBe(false);
    expect(headInside(toTop, win, 6, 2.4)).toBe(false);
    expect(headInside(toBottom, win, 6, 2.4)).toBe(false);
  });

  it("長さ 0 の矢印は残す", () => {
    expect(headInside({ from: { x: 50, y: 50 }, to: { x: 50, y: 50 } }, win, 6, 2.4)).toBe(true);
  });
});
