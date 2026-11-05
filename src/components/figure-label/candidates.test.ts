import { describe, expect, it } from "vitest";
import {
  anchoredCandidates,
  aroundPoint,
  aroundVector,
  avoidingBands,
  besideCurve,
  besideSegment,
  besideSegmentCandidates,
  besideVectorCandidates,
  centeredAt,
  fixedPosition,
  insideRegion,
  lineLabelCandidates,
  linePositions,
  nearestCurvePoint,
  onLine,
  onLineNear,
  pointLabelCandidates,
  pointPositions,
  positionsAround,
  preferringOwnMark,
  stubPenalty,
  widelyAroundPoint,
  withPenalty,
  type PointMark,
} from "./candidates";
import { boxGap, boxesOverlap, distanceToBox, inflate, type Box, type XY } from "./geometry";
import { glyphBox, type GlyphSize, type LabelPos } from "./label-box";
import { lineObstacle, tracedLine, type LineObstacle, type TracedLine } from "./obstacles";
import { createPlacer, lineReach, type Candidate } from "./placer";
import { LABEL_POLICY, OBSTACLE_WEIGHT } from "./policy";

const size: GlyphSize = { width: 20, top: -6, bottom: 4 };

describe("centeredAt", () => {
  it("字形の矩形の中心を指定の点に合わせる", () => {
    const b = glyphBox(centeredAt(100, 50, size), size);
    expect((b.x0 + b.x1) / 2).toBeCloseTo(100, 9);
    expect((b.y0 + b.y1) / 2).toBeCloseTo(50, 9);
  });
});

describe("aroundPoint", () => {
  const p = { x: 100, y: 100 };
  const reach = 4;
  const gap = LABEL_POLICY.lineClearance + LABEL_POLICY.glyphSlack;
  const cands = aroundPoint(p, size, reach);

  it("真上の候補は箱の下辺を印の端からすきまだけ離す", () => {
    expect(glyphBox(cands.above, size).y1).toBeCloseTo(p.y - reach - gap, 9);
  });

  it("真下の候補は箱の上辺を印の端からすきまだけ離す", () => {
    expect(glyphBox(cands.below, size).y0).toBeCloseTo(p.y + reach + gap, 9);
  });

  it("真横の候補は箱の中心の高さを点にそろえる", () => {
    const b = glyphBox(cands.right, size);
    expect(b.x0).toBeCloseTo(p.x + reach + gap, 9);
    expect((b.y0 + b.y1) / 2).toBeCloseTo(p.y, 9);
  });

  it("斜めの候補は箱の角を印の端からすきまだけ離す", () => {
    const b = glyphBox(cands["above-right"], size);
    expect(Math.hypot(b.x0 - p.x, b.y1 - p.y)).toBeCloseTo(reach + gap, 9);
  });

  it("字の大きさによらず、箱の縁からの距離が変わらない", () => {
    const tall: GlyphSize = { width: 8, top: -14, bottom: 13 };
    const b = glyphBox(aroundPoint(p, tall, reach).above, tall);
    expect(b.y1).toBeCloseTo(p.y - reach - gap, 9);
  });
});

describe("fixedPosition", () => {
  const p = { x: 100, y: 100 };

  it('"center" は基準点を KatexLabel の中心にする', () => {
    expect(fixedPosition(p, "center", size, 4)).toEqual({ x: 100, y: 100, align: "center" });
  });

  it("8 方位は aroundPoint の同じ向きの位置を返す", () => {
    expect(fixedPosition(p, "below-left", size, 4)).toEqual(aroundPoint(p, size, 4)["below-left"]);
  });

  it("すきまの指定の分だけ箱の縁を離す", () => {
    const near = glyphBox(fixedPosition(p, "above", size, 4, 2), size);
    const far = glyphBox(fixedPosition(p, "above", size, 4, 10), size);
    expect(near.y1 - far.y1).toBeCloseTo(8, 9);
  });
});

describe("positionsAround", () => {
  it("基準点を最初に試し、続いて 8 方向を試す", () => {
    const p = { x: 100, y: 100 };
    const positions = positionsAround(p, size, 0);
    expect(positions).toHaveLength(9);
    expect(positions[0]).toEqual({ x: 100, y: 100, align: "center" });
  });
});

describe("besideCurve", () => {
  const visible = Array.from({ length: 21 }, (_, i) => ({ x: i * 10, y: 50, t: i }));

  it("at があれば媒介変数に最も近い標本の両側だけを候補にする", () => {
    const cands = besideCurve(visible, size, 10.2);
    expect(cands).toHaveLength(2);
    expect(cands[0].value.x).toBeCloseTo(100, 9);
  });

  describe("at のある曲線の線の側", () => {
    const bounds = { x0: -500, x1: 500, y0: -500, y1: 500 };
    // 右へ進む線の候補は、線の進む向きの右側（画面の下）が先である。下側の箱の縦の範囲は
    // y = 56.25 から 66.25 である。
    const own = lineObstacle("own", visible, 6);
    const side = (extra: readonly LineObstacle[]) => {
      const pos = createPlacer([...own, ...extra]).place(besideCurve(visible, size, 10), {
        placed: [],
        bounds,
      }).item;
      return (pos?.y ?? 0) > 50 ? "below" : "above";
    };

    it("何も無ければ線の下に置く", () => {
      expect(side([])).toBe("below");
    });

    it("すきまの帯に入るだけなら側を保つ", () => {
      // 重み 6 と 3 の線が箱の下 3px ほどを通る。帯の罰点は合計 2.25 である。
      expect(side([...across(69.5, 6), ...across(70, 3)])).toBe("below");
    });

    it("右側の罰点が反対側を fixedSide より大きく上回れば反対側へ移る", () => {
      expect(side(across(67, 3))).toBe("above");
    });
  });

  it("at が無ければ、線の反対側の候補の罰点は同点を分けるだけの大きさである", () => {
    const cands = besideCurve(visible, size, undefined);
    expect((cands[1].score?.(0) ?? 0) - (cands[0].score?.(0) ?? 0)).toBeCloseTo(
      LABEL_POLICY.otherSide,
      9,
    );
  });

  it("向きを指定すると、各位置で 1 か所だけを候補にする", () => {
    const cands = besideCurve(visible, size, 10, "above");
    expect(cands).toHaveLength(1);
    expect(cands[0].box.y1).toBeLessThan(50);
  });

  it("at が無くても向きの指定が効く", () => {
    const cands = besideCurve(visible, size, undefined, "above");
    expect(cands.length).toBeGreaterThan(1);
    expect(cands.every((c) => c.box.y1 < 50)).toBe(true);
  });

  it("指定が無ければ曲線の後半を優先する", () => {
    const cands = besideCurve(visible, size, undefined);
    const score = (x: number) => cands.find((c) => c.value.x === x)?.score?.(0) ?? Infinity;
    expect(score(170)).toBeLessThan(score(10));
  });
});

/** 点 (100, 100) を中心とする、傾き deg 度の線分の両端。 */
function lineAt(deg: number): readonly [XY, XY] {
  const t = (deg * Math.PI) / 180;
  return [
    { x: 100 - 80 * Math.cos(t), y: 100 - 80 * Math.sin(t) },
    { x: 100 + 80 * Math.cos(t), y: 100 + 80 * Math.sin(t) },
  ];
}

describe("線の傾きによらない候補", () => {
  const angles = [0, 1, 2, 3, 10, 30, 45, 60, 80, 89, 90, 135];
  const bounds = { x0: -500, x1: 500, y0: -500, y1: 500 };

  it.each(angles)("%d 度の線分のそばの候補は、自分の線を除かなくても罰点が 0 である", (deg) => {
    const [a, b] = lineAt(deg);
    const placer = createPlacer(lineObstacle("own", [a, b], 6));
    for (const pos of besideSegment(a, b, size)) {
      expect(placer.penalty(glyphBox(pos, size), { placed: [], bounds })).toBe(0);
    }
  });

  it.each(angles)("%d 度の線のそばの曲線の候補は、自分の線に近いと数えられない", (deg) => {
    const [a, b] = lineAt(deg);
    const pts = Array.from({ length: 41 }, (_, i) => ({
      x: a.x + ((b.x - a.x) * i) / 40,
      y: a.y + ((b.y - a.y) * i) / 40,
      t: i,
    }));
    const placer = createPlacer(lineObstacle("own", pts, 6));
    for (const c of besideCurve(pts, size, 20)) {
      expect(placer.penalty(c.box, { placed: [], bounds })).toBe(0);
    }
  });
});

describe("besideSegment", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };

  it("線分の両側に、線の判定に触れない位置を返す", () => {
    const line = { x0: 0, x1: 100, y0: 0, y1: 0 };
    for (const pos of besideSegment(a, b, size)) {
      expect(boxesOverlap(inflate(glyphBox(pos, size), lineReach), line)).toBe(false);
    }
  });
});

describe("besideSegment の割合", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };
  const midX = (pos: LabelPos) => {
    const box = glyphBox(pos, size);
    return (box.x0 + box.x1) / 2;
  };

  it("既定は中点の両側の 2 か所である", () => {
    const xs = besideSegment(a, b, size).map(midX);
    expect(xs).toHaveLength(2);
    expect(xs[0]).toBeCloseTo(50, 9);
    expect(xs[1]).toBeCloseTo(50, 9);
  });

  it("割合の順に、各割合の両側を返す", () => {
    const xs = besideSegment(a, b, size, undefined, [0.8, 0.2]).map(midX);
    expect(xs[0]).toBeCloseTo(80, 9);
    expect(xs[1]).toBeCloseTo(80, 9);
    expect(xs[2]).toBeCloseTo(20, 9);
    expect(xs[3]).toBeCloseTo(20, 9);
  });

  it("a から b へ進む向きの右側を先に返す", () => {
    const [first, second] = besideSegment(a, b, size);
    expect(glyphBox(first, size).y0).toBeGreaterThan(0);
    expect(glyphBox(second, size).y1).toBeLessThan(0);
  });

  it("両端の位置を入れ替えると先に返す側が変わる", () => {
    const [first] = besideSegment(b, a, size);
    expect(glyphBox(first, size).y1).toBeLessThan(0);
  });
});

describe("besideSegmentCandidates", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };

  it("割合ごとに線分の両側を返す", () => {
    expect(besideSegmentCandidates(a, b, size, undefined, [0.5, 0.2])).toHaveLength(4);
  });

  it("中点の候補には罰点を足さない", () => {
    const [first] = besideSegmentCandidates(a, b, size, undefined, [0.5]);
    expect(first.score?.(3)).toBe(3);
  });

  it("中点から離れるほど罰点を足す", () => {
    const cands = besideSegmentCandidates(a, b, size, undefined, [0.35, 0.8]);
    expect(cands[0].score?.(0)).toBeCloseTo(0.15 * LABEL_POLICY.offCenter, 9);
    expect(cands[2].score?.(0)).toBeCloseTo(0.3 * LABEL_POLICY.offCenter, 9);
  });

  it("すきまを besideSegment と同じに扱う", () => {
    const [first] = besideSegmentCandidates(a, b, size, 9, [0.5]);
    expect(first.value).toEqual(besideSegment(a, b, size, 9)[0]);
  });
});

describe("besideVectorCandidates", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 100, y: 0 };
  const cands = besideVectorCandidates(from, to, size, 3.6, undefined, [0.5, 0.35]);

  it("線の脇を先に試し、続いて aroundVector の中点の脇を除いた位置を試す", () => {
    const around = aroundVector(from, to, size, 3.6);
    expect(cands.slice(0, 2).map((c) => c.value)).toEqual(besideSegment(from, to, size));
    expect(cands.slice(4).map((c) => c.value)).toEqual(around.slice(2));
  });

  it("先端と根元のまわりには vectorEnd の罰点を足す", () => {
    expect(cands[4].score?.(1)).toBe(1 + LABEL_POLICY.vectorEnd);
    expect(cands.at(-1)?.score?.(0)).toBe(LABEL_POLICY.vectorEnd);
  });

  it("割合の順に線の脇の位置を返す", () => {
    expect(cands.slice(2, 4).map((c) => c.value)).toEqual(
      besideSegment(from, to, size, undefined, [0.35]),
    );
  });

  it("すきまを線の脇と先端のまわりの両方に使う", () => {
    const wide = besideVectorCandidates(from, to, size, 3.6, 9, [0.5]);
    expect(wide.slice(0, 2).map((c) => c.value)).toEqual(besideSegment(from, to, size, 9));
    expect(wide.slice(2).map((c) => c.value)).toEqual(
      aroundVector(from, to, size, 3.6, 9).slice(2),
    );
  });

  it("線の脇の候補の罰点は先端の候補より軽い", () => {
    expect(cands[2].score?.(0)).toBeLessThan(LABEL_POLICY.vectorEnd);
  });
});

describe("avoidingBands", () => {
  const pos: LabelPos = { x: 50, y: 50, align: "center" };
  const inside: Box = { x0: 0, x1: 100, y0: 40, y1: 60 };
  const elsewhere: Box = { x0: 0, x1: 100, y0: 200, y1: 220 };
  const cand: Candidate<LabelPos> = { box: glyphBox(pos, size), value: pos };

  it("重なる帯の本数だけ罰点を足す", () => {
    const [one] = avoidingBands([cand], [inside, inside], 3);
    expect(one.score?.(1)).toBe(7);
  });

  it("重ならない帯は数えない", () => {
    const [one] = avoidingBands([cand], [elsewhere], 3);
    expect(one.score?.(1)).toBe(1);
  });

  it("候補の元の罰点を保つ", () => {
    const scored: Candidate<LabelPos> = { ...cand, score: (penalty) => penalty + 2 };
    const [one] = avoidingBands([scored], [inside], 3);
    expect(one.score?.(1)).toBe(6);
  });

  it("候補の矩形と値を変えない", () => {
    const [one] = avoidingBands([cand], [inside], 3);
    expect(one.box).toEqual(cand.box);
    expect(one.value).toEqual(cand.value);
  });
});

describe("pointPositions", () => {
  const p = { x: 100, y: 100 };

  it("自動なら 8 方向を返す", () => {
    expect(pointPositions(p, size, 4)).toEqual(Object.values(aroundPoint(p, size, 4)));
    expect(pointPositions(p, size, 4, "auto")).toHaveLength(8);
  });

  it("向きの指定があればその 1 か所を返す", () => {
    expect(pointPositions(p, size, 4, "left")).toEqual([aroundPoint(p, size, 4).left]);
  });

  it("すきまを自動の 8 方向にも使う", () => {
    expect(pointPositions(p, size, 4, "auto", 9)).toEqual(
      Object.values(aroundPoint(p, size, 4, 9)),
    );
  });

  it("すきまを向きの指定にも使う", () => {
    expect(pointPositions(p, size, 4, "left", 9)).toEqual([aroundPoint(p, size, 4, 9).left]);
  });
});

function rounded(values: readonly number[]) {
  return values.map((v) => Math.round(v * 1e6) / 1e6);
}

function signed(values: readonly number[]) {
  return values.flatMap((v) => [v, -v]);
}

function same(a: number, b: number) {
  return Math.abs(a - b) < 1e-9;
}

function preference(cand: Candidate<LabelPos>) {
  return cand.score?.(0);
}

describe("widelyAroundPoint", () => {
  const p = { x: 100, y: 100 };
  const reach = 4;
  const cands = widelyAroundPoint(p, size, reach);
  const near = (cand: Candidate<LabelPos>) => distanceToBox(p, cand.box);
  const step = LABEL_POLICY.farRing;
  const clearance = reach + LABEL_POLICY.lineClearance + LABEL_POLICY.glyphSlack;

  it("先頭は aroundPoint の 8 方向で、上側を先に試す", () => {
    const eight = aroundPoint(p, size, reach);
    expect(cands.slice(0, 6).map((c) => c.value)).toEqual([
      eight.above,
      eight["above-right"],
      eight["above-left"],
      eight.below,
      eight["below-right"],
      eight["below-left"],
    ]);
    expect(cands.slice(6, 8).map((c) => c.value)).toEqual([eight.right, eight.left]);
  });

  it("どの候補も点の印と重ならない", () => {
    for (const cand of cands) {
      expect(near(cand)).toBeGreaterThan(reach);
    }
  });

  it("輪が 1 つ遠くなるごとに罰点が増える", () => {
    const scores = [...new Set(cands.map(preference))];
    expect(scores).toEqual([0, 1, 2].map((k) => k * LABEL_POLICY.farRingPenalty));
  });

  it("罰点は元の罰点に足す", () => {
    const far = cands.at(-1);
    expect(far?.score?.(5)).toBe(5 + 2 * LABEL_POLICY.farRingPenalty);
  });

  const ringOf = (k: number, from = cands) =>
    from.filter((c) => preference(c) === k * LABEL_POLICY.farRingPenalty);

  it.each([
    [0, [4, 5], [4, 8, 10]],
    [1, [4, 8, 11], [4, 8, 12, 16]],
    [2, [4, 8, 12, 16, 17], [4, 8, 12, 16, 20, 22]],
  ])("輪 %i は 4 辺に沿って、辺の範囲と輪のぶんだけずらす", (k, vertical, horizontal) => {
    const r = clearance + k * step;
    const slid = ringOf(k)
      .slice(8)
      .map((c) => c.box);
    const offsetY = (b: Box) => (b.y0 + b.y1) / 2 - p.y;
    const offsetX = (b: Box) => (b.x0 + b.x1) / 2 - p.x;
    expect(rounded(slid.filter((b) => same(b.x0, p.x + r)).map(offsetY))).toEqual(signed(vertical));
    expect(rounded(slid.filter((b) => same(b.x1, p.x - r)).map(offsetY))).toEqual(signed(vertical));
    expect(rounded(slid.filter((b) => same(b.y1, p.y - r)).map(offsetX))).toEqual(
      signed(horizontal),
    );
    expect(rounded(slid.filter((b) => same(b.y0, p.y + r)).map(offsetX))).toEqual(
      signed(horizontal),
    );
  });

  it.each([0, 1, 2])("輪 %i の 8 方向は、その輪のすきまの aroundPoint である", (k) => {
    const gap = LABEL_POLICY.lineClearance + k * step;
    expect(
      ringOf(k)
        .slice(0, 8)
        .map((c) => c.value),
    ).toEqual(expect.arrayContaining(Object.values(aroundPoint(p, size, reach, gap))));
  });

  it.each([0, 1, 2])("指定のすきまを輪 %i にも足す", (k) => {
    const wide = widelyAroundPoint(p, size, reach, 10);
    expect(
      ringOf(k, wide)
        .slice(0, 8)
        .map((c) => c.value),
    ).toEqual(expect.arrayContaining(Object.values(aroundPoint(p, size, reach, 10 + k * step))));
  });

  it("近い輪は箱の辺の範囲でずらし、点と箱の縁の距離を保つ", () => {
    const first = cands.filter((c) => preference(c) === 0).slice(8);
    expect(first.length).toBeGreaterThan(0);
    for (const cand of first) {
      expect(near(cand)).toBeCloseTo(clearance, 9);
    }
  });

  it("遠い輪は箱の辺の範囲の外までずらす", () => {
    const third = cands.filter((c) => preference(c) === 2 * LABEL_POLICY.farRingPenalty);
    const r = clearance + 2 * step;
    const toLeftOfPoint = third.filter((c) => c.box.x1 < p.x && c.box.y0 >= p.y + r - 1e-9);
    const inSpan = third.filter((c) => c.box.x0 <= p.x && c.box.x1 >= p.x);
    expect(toLeftOfPoint.length).toBeGreaterThan(0);
    expect(inSpan.length).toBeGreaterThan(0);
  });

  it("すきまを全部の輪に足す", () => {
    const wide = widelyAroundPoint(p, size, reach, 10);
    expect(wide).toHaveLength(cands.length);
    expect(near(wide[0])).toBeCloseTo(reach + 10 + LABEL_POLICY.glyphSlack, 9);
  });

  it("同じ入力から同じ候補を返す", () => {
    expect(widelyAroundPoint(p, size, reach).map((c) => c.value)).toEqual(
      cands.map((c) => c.value),
    );
  });
});

describe("aroundVector", () => {
  it("終点の横の候補を中点の横の候補より矢じりの半幅だけ離す", () => {
    const cands = aroundVector({ x: 0, y: 0 }, { x: 100, y: 0 }, size, 3.6);
    const side = Math.abs((glyphBox(cands[0], size).y0 + glyphBox(cands[0], size).y1) / 2);
    const head = Math.abs((glyphBox(cands[5], size).y0 + glyphBox(cands[5], size).y1) / 2);
    expect(head - side).toBeCloseTo(3.6 - LABEL_POLICY.lineHalfWidth, 9);
  });
});

describe("insideRegion", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it("領域の外へ出る候補に範囲外の罰点を与える", () => {
    const cands = insideRegion({ x: 2, y: 50 }, square, size);
    const outside = cands.find((c) => c.value.x < 0);
    expect(outside?.score?.(0)).toBeGreaterThanOrEqual(LABEL_POLICY.outside);
  });

  it("領域の内側の候補には範囲外の罰点を与えない", () => {
    const cands = insideRegion({ x: 50, y: 50 }, square, size);
    expect(cands[0].score?.(0)).toBeLessThan(LABEL_POLICY.outside);
  });
});

describe("onLine", () => {
  const straight = tracedLine(
    [
      { x: 0, y: 50 },
      { x: 200, y: 50 },
    ],
    false,
  );

  it("字形の中心を線の上に置く", () => {
    const c = onLine([straight], size, 5)[0];
    expect((c.box.y0 + c.box.y1) / 2).toBeCloseTo(50, 9);
  });

  it("線を切り抜く矩形を字形の矩形から gapPad だけ広げる", () => {
    const c = onLine([straight], size, 5)[0];
    expect(c.value.cut).toEqual(inflate(c.value.glyph, 5));
  });

  it("ラベルが収まらない短い線には候補を作らない", () => {
    const short = tracedLine(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      false,
    );
    expect(onLine([short], size, 5)).toHaveLength(0);
  });

  it("線の中ほどの候補を端の候補より好む", () => {
    const cands = onLine([straight], size, 5);
    const scores = cands.map((c) => c.score?.(0) ?? 0);
    const middle = scores[Math.floor(scores.length / 2)];
    expect(middle).toBeLessThan(scores[0]);
  });
});

/** 高さ y を横切る線の障害物。 */
function across(y: number, weight: number): readonly LineObstacle[] {
  return lineObstacle(
    "other",
    [
      { x: 60, y },
      { x: 140, y },
    ],
    weight,
  );
}

/** 右端で折り返し、offset だけ下を戻る線。 */
function hairpinAt(offset: number): TracedLine {
  return tracedLine(
    [
      { x: 0, y: 50 },
      { x: 300, y: 50 },
      { x: 300, y: 50 + offset },
      { x: 200, y: 50 + offset },
    ],
    false,
  );
}

/** 矩形の中心の x。 */
function centerX(b: Box): number {
  return (b.x0 + b.x1) / 2;
}

/** 点 (100, 100) を中心とする半径 r の閉じた線。 */
function ring(r: number): TracedLine {
  return tracedLine(
    Array.from({ length: 61 }, (_, i) => {
      const t = (i * 2 * Math.PI) / 60;
      return { x: 100 + r * Math.cos(t), y: 100 + r * Math.sin(t) };
    }),
    true,
  );
}

/** 線のそばの候補の代わりに、受け取ったすきまを x に写した位置を返す。 */
function auto(offset?: number): readonly LabelPos[] {
  return [{ x: offset ?? -1, y: 0, align: "center" }];
}

describe("onLine の採点", () => {
  // 候補の中心の x が cx に最も近い候補の罰点。
  const scoreNear = (line: TracedLine, cx: number) => {
    const near = onLine([line], size, 5).reduce((m, c) =>
      Math.abs(centerX(c.box) - cx) < Math.abs(centerX(m.box) - cx) ? c : m,
    );
    return near.score?.(0) ?? 0;
  };

  it("折り返す線の離れた部分が重なる候補に、自分の線の罰点を与える", () => {
    // 右端で折り返し、x = 200 まで 4px 下を戻る線。戻る部分の上の候補だけが重なる。
    const hairpin = tracedLine(
      [
        { x: 0, y: 50 },
        { x: 300, y: 50 },
        { x: 300, y: 54 },
        { x: 200, y: 54 },
      ],
      false,
    );
    expect(scoreNear(hairpin, 250) - scoreNear(hairpin, 100)).toBeGreaterThan(5);
  });

  it("頂点の数によらず、同じ形の線の採点が一致する", () => {
    const sparse = tracedLine(
      [
        { x: 0, y: 100 },
        { x: 300, y: 100 },
      ],
      false,
    );
    const dense = tracedLine(
      Array.from({ length: 301 }, (_, i) => ({ x: i, y: 100 })),
      false,
    );
    for (const x of [60, 100, 150, 200, 240]) {
      expect(scoreNear(sparse, x)).toBeCloseTo(scoreNear(dense, x), 9);
    }
  });

  it("長い線分の上の候補に、乗っている線の罰点を与えない", () => {
    const sparse = tracedLine(
      [
        { x: 0, y: 100 },
        { x: 300, y: 100 },
      ],
      false,
    );
    expect(scoreNear(sparse, 100)).toBeLessThan(1);
  });

  describe("戻る部分までの距離による段階的な罰点", () => {
    // 箱は線の上下へ 5px 広がる。
    // 行きの部分の候補の中心は 17 から 4px おきに並ぶ。x = 249 は行きの部分の候補にちょうど重なる。
    const scoreAt = (offset: number) => scoreNear(hairpinAt(offset), 249);
    const baseline = scoreAt(30);

    it("戻る部分に触れる候補に罰点の全部を与える", () => {
      expect(scoreAt(6) - baseline).toBeCloseTo(LABEL_POLICY.ownLine, 0);
    });

    it("すきまが足りない候補に罰点の一部を与える", () => {
      const partial = LABEL_POLICY.ownLine * LABEL_POLICY.nearLine;
      expect(scoreAt(9) - baseline).toBeCloseTo(partial, 0);
    });

    it("すきまの帯の外縁の近くまで数える", () => {
      const partial = LABEL_POLICY.ownLine * LABEL_POLICY.nearLine;
      expect(scoreAt(5 + lineReach - 0.25) - baseline).toBeCloseTo(partial, 0);
    });

    it("すきまの帯の外の候補には罰点を与えない", () => {
      expect(scoreAt(5 + lineReach + 1) - baseline).toBeCloseTo(0, 0);
    });
  });

  it("線の曲がり角の候補に、曲がり具合の罰点を与える", () => {
    const corner = tracedLine(
      [
        { x: 0, y: 200 },
        { x: 150, y: 200 },
        { x: 150, y: 50 },
      ],
      false,
    );
    // 角は線の中ほどにあるので、曲がり具合の罰点が無ければ角の候補が最良になる。
    expect(scoreNear(corner, 150)).toBeGreaterThan(scoreNear(corner, 75));
  });

  it("閉じた線では右上の候補を好む", () => {
    const center = { x: 100, y: 100 };
    const circle = tracedLine(
      Array.from({ length: 241 }, (_, i) => {
        const t = (i * 2 * Math.PI) / 240;
        return { x: center.x + 60 * Math.cos(t), y: center.y - 60 * Math.sin(t) };
      }),
      true,
    );
    const best = onLine([circle], size, 5).reduce((m, c) =>
      (c.score?.(0) ?? 0) < (m.score?.(0) ?? 0) ? c : m,
    );
    const cx = (best.box.x0 + best.box.x1) / 2;
    const cy = (best.box.y0 + best.box.y1) / 2;
    expect(Math.atan2(center.y - cy, cx - center.x)).toBeCloseTo(Math.PI / 4, 0);
  });

  it("一周がラベルの幅より短い閉じた線には候補を作らない", () => {
    // 切り抜きの幅は 20 + 2 × 5 = 30 なので、一周が 38 未満なら収まらない。
    expect(onLine([ring(5)], size, 5)).toHaveLength(0);
    expect(onLine([ring(8)], size, 5).length).toBeGreaterThan(0);
  });
});

/** 長さ 300 の開いた線の上の x の、線の中ほどの好みの罰点。 */
function midPref(x: number): number {
  return Math.abs(x / 300 - 0.5) * 2;
}

describe("onLine の切れ端の罰点", () => {
  const line = tracedLine(
    [
      { x: 0, y: 100 },
      { x: 300, y: 100 },
    ],
    false,
  );
  // 切り抜きの幅は 30 なので、中心が x のとき切れ目の左端は x − 15 である。
  const scoreAt = (cx: number, marks: readonly PointMark[] = []) => {
    const near = onLine([line], size, 5, [], marks).reduce((m, c) =>
      Math.abs(centerX(c.box) - cx) < Math.abs(centerX(m.box) - cx) ? c : m,
    );
    return near.score?.(0) ?? 0;
  };
  const stub = LABEL_POLICY.stub;

  it("線の端との間に短い切れ端が残る候補に罰点を与える", () => {
    expect(scoreAt(19) - midPref(19)).toBeCloseTo(stub, 1);
    expect(scoreAt(281) - midPref(281)).toBeCloseTo(stub, 1);
  });

  it("線の端まで十分に線が残る候補には罰点を与えない", () => {
    expect(scoreAt(35) - midPref(35)).toBeCloseTo(0, 1);
  });

  it("閉じた線には線の端の切れ端の罰点を与えない", () => {
    // 弧長 12〜20 の候補の切れ目は、始点の手前 12 以内で終わる。開いた線なら切れ端に当たる。
    const circle = ring(60);
    const open = tracedLine(circle.pts, false);
    [12, 16, 20].forEach((s) => {
      const { cut } = onLine([circle], size, 5)[s / 4].value;
      expect(stubPenalty(circle, s, cut, 40, [], [])).toBe(0);
      expect(stubPenalty(open, s, cut, 40, [], [])).toBe(stub);
    });
  });

  it("切れ端しか残らない短い線にも候補を作る", () => {
    const short = tracedLine(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
      ],
      false,
    );
    expect(onLine([short], size, 5).length).toBeGreaterThan(0);
  });

  describe("線の上の点の印", () => {
    const mark = { x: 150, y: 100, reach: 4 };

    it("切れ目が印に届く候補に罰点を与える", () => {
      expect(scoreAt(150, [mark]) - scoreAt(150)).toBeCloseTo(stub, 9);
    });

    it("印との間に短い切れ端が残る候補に罰点を与える", () => {
      // 切れ目の右端は 120 で、印の端 146 まで 26 残る。x = 125 なら 6 しか残らない。
      expect(scoreAt(125, [mark]) - scoreAt(125)).toBeCloseTo(stub, 9);
      expect(scoreAt(175, [mark]) - scoreAt(175)).toBeCloseTo(stub, 9);
    });

    it("印から十分に離れた候補には罰点を与えない", () => {
      expect(scoreAt(100, [mark]) - scoreAt(100)).toBeCloseTo(0, 9);
      expect(scoreAt(200, [mark]) - scoreAt(200)).toBeCloseTo(0, 9);
    });
  });

  it("線の外の点の印に切れ目が届く候補に罰点を与える", () => {
    // 切れ目の矩形の下端は y = 100 + 5 + 5 付近にある。
    const below = { x: 150, y: 112, reach: 4 };
    expect(scoreAt(150, [below]) - scoreAt(150)).toBeCloseTo(stub, 9);
  });

  it("閉じた線でも印までの残りを始点をまたいで測る", () => {
    // 円の始点（角 0）の印を、始点の後ろ側の候補からも見つける。弧長 352 の候補の切れ目は印に届かず、
    // 印の端まで弧長で 12 以内に迫る。弧長 336 の候補の切れ目は印の端まで 12 より離れる。
    const circle = ring(60);
    const start = { x: 160, y: 100, reach: 4 };
    const plain = onLine([circle], size, 5);
    const marked = onLine([circle], size, 5, [], [start]);
    const extra = (s: number): number =>
      (marked[s / 4].score?.(0) ?? 0) - (plain[s / 4].score?.(0) ?? 0);
    expect(distanceToBox(start, plain[352 / 4].value.cut)).toBeGreaterThan(start.reach);
    expect(extra(352)).toBeCloseTo(stub, 9);
    expect(extra(336)).toBeCloseTo(0, 9);
  });

  it("印までの残りは、印の中心ではなく印の端から測る", () => {
    // 印の中心は弧長 150、印の端は 154 である。線は切れ目の左端を 165 と 169 で出るので、残りは 11 と 15 である。
    const flat = tracedLine(
      [
        { x: 0, y: 100 },
        { x: 300, y: 100 },
      ],
      false,
    );
    const stops = [{ arc: 150, reach: 4 }];
    const near: Box = { x0: 165.5, x1: 195.5, y0: 90, y1: 110 };
    const far: Box = { x0: 169.5, x1: 199.5, y0: 90, y1: 110 };
    expect(stubPenalty(flat, 181, near, 40, stops, [])).toBe(stub);
    expect(stubPenalty(flat, 185, far, 40, stops, [])).toBe(0);
  });

  it("別の線の上の点の印には反応しない", () => {
    // 印は線から 25 離れる。線に下ろした足は切れ目の右端の近くにあるが、線の上の印ではない。
    const aside = { x: 125, y: 125, reach: 4 };
    expect(scoreAt(100, [aside]) - scoreAt(100)).toBeCloseTo(0, 9);
  });

  it("縦の線でも線の端の切れ端に罰点を与える", () => {
    // 切り抜きの高さは 20 なので、中心が y のとき切れ目の上端は y − 10 である。
    const upright = tracedLine(
      [
        { x: 100, y: 0 },
        { x: 100, y: 300 },
      ],
      false,
    );
    const cands = onLine([upright], size, 5);
    const at = (s: number): number =>
      stubPenalty(upright, s, cands[(s - 17) / 4].value.cut, 40, [], []);
    expect(at(17)).toBe(stub);
    expect(at(25)).toBe(0);
    expect(at(281)).toBe(stub);
  });

  it("切れ端しか残らない短い線でも、罰点が範囲の外の罰点より小さく、ラベルが残る", () => {
    const short = tracedLine(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
      ],
      false,
    );
    const bounds: Box = { x0: -50, x1: 100, y0: -50, y1: 50 };
    const best = createPlacer([]).place(onLine([short], size, 5), { placed: [], bounds });
    expect(best.item).not.toBeNull();
    expect(best.score).toBeGreaterThanOrEqual(stub);
    expect(best.score).toBeLessThan(LABEL_POLICY.outside);
  });
});

/** 縦の線をまたぐ、幅の広い切れ目。 */
function verticalCut(y0: number, y1: number): Box {
  return { x0: 40, x1: 60, y0, y1 };
}

describe("stubPenalty の線の端", () => {
  // 上から下へ進む長さ 100 の縦の線。線の端の丸みは線幅の半分だけ先へ出る。
  const line = tracedLine(
    [
      { x: 50, y: 0 },
      { x: 50, y: 100 },
    ],
    false,
  );
  const penalty = (s: number, y0: number, y1: number): number =>
    stubPenalty(line, s, verticalCut(y0, y1), 40, [], []);
  const hw = LABEL_POLICY.lineHalfWidth;
  const stub = LABEL_POLICY.stub;

  it("線の端が切れ目の中でも、縁から線幅の半分の上限より近い候補に罰点を与える", () => {
    expect(penalty(6, -0.27, 14)).toBe(stub);
    expect(penalty(94, 86, 100.27)).toBe(stub);
    expect(penalty(6, -hw + 0.01, 14)).toBe(stub);
    expect(penalty(94, 86, 100 + hw - 0.01)).toBe(stub);
  });

  it("線の端が切れ目の横の縁に近い候補にも罰点を与える", () => {
    const flat = tracedLine(
      [
        { x: 0, y: 50 },
        { x: 100, y: 50 },
      ],
      false,
    );
    const near: Box = { x0: -0.27, x1: 14, y0: 40, y1: 60 };
    const deep: Box = { x0: -hw - 0.01, x1: 14, y0: 40, y1: 60 };
    expect(stubPenalty(flat, 6, near, 40, [], [])).toBe(stub);
    expect(stubPenalty(flat, 6, deep, 40, [], [])).toBe(0);
  });

  it("残りの弧長が stubLength より短い候補だけに罰点を与える", () => {
    // 線は y = 11 と y = 12 で切れ目を出るので、線の端までの残りは 11 と 12 である。
    expect(penalty(20, 11.5, 30)).toBe(stub);
    expect(penalty(20, 12.5, 30)).toBe(0);
  });

  it("線の端が切れ目のすぐ外にある候補に罰点を与える", () => {
    expect(penalty(6, 0.3, 14)).toBe(stub);
    expect(penalty(94, 86, 99.7)).toBe(stub);
  });

  it("線の端が切れ目の奥にある候補には罰点を与えない", () => {
    expect(penalty(6, -hw - 0.01, 14)).toBe(0);
    expect(penalty(94, 86, 100 + hw + 0.01)).toBe(0);
  });

  it("線の全体が切れ目の中にあるなら、何も残らず罰点を与えない", () => {
    expect(stubPenalty(line, 50, verticalCut(-10, 110), 60, [], [])).toBe(0);
  });

  it("探す範囲で線が切れ目を出なくても、線の端が切れ目の奥にあれば罰点を与えない", () => {
    // 探す範囲は 40 なので、線の端まで 10 を残して打ち切る。
    expect(stubPenalty(line, 50, verticalCut(-10, 110), 40, [], [])).toBe(0);
  });

  it("線の端が切れ目の奥へ戻っても、切れ目の外の短い線は切れ端である", () => {
    // 線は切れ目の上端 y = 10 の外へ出て、すぐに切れ目の奥の端へ戻る。
    const hook = tracedLine(
      [
        { x: 50, y: 11.5 },
        { x: 50, y: 8 },
        { x: 53, y: 8 },
        { x: 53, y: 100 },
      ],
      false,
    );
    expect(stubPenalty(hook, 23.5, verticalCut(10, 40), 40, [], [])).toBe(stub);
  });
});

/** 同心円のラベルを内側の円から順に置き、最良の候補の字形の矩形を返す。 */
function stackRings(radii: readonly number[]): readonly Box[] {
  return radii.reduce<readonly Box[]>((placed, r) => {
    const best = onLine([ring(r)], size, 5, placed).reduce((m, c) =>
      (c.score?.(0) ?? 0) < (m.score?.(0) ?? 0) ? c : m,
    );
    return [...placed, best.box];
  }, []);
}

describe("定数の釣り合い", () => {
  it("同心円のラベルは同じ扇形に積み上がらず、先のラベルから離れる", () => {
    const [inner, outer] = stackRings([60, 80]);
    const center = 100;
    const angle = (b: Box): number => Math.atan2(center - (b.y0 + b.y1) / 2, centerX(b) - center);
    expect(Math.abs(angle(inner) - angle(outer))).toBeGreaterThan(Math.PI / 8);
    expect(boxGap(inner, outer)).toBeGreaterThan(LABEL_POLICY.labelSpacing);
  });

  it("切れ端の罰点は、主役の線に触れる罰点より軽い", () => {
    expect(LABEL_POLICY.stub).toBeLessThan(OBSTACLE_WEIGHT.line);
  });

  it("線の反対側の罰点は、最も軽い線のすきまの罰点より小さい", () => {
    expect(LABEL_POLICY.otherSide).toBeGreaterThan(0);
    expect(LABEL_POLICY.otherSide).toBeLessThan(OBSTACLE_WEIGHT.thinLine * LABEL_POLICY.nearLine);
  });
});

describe("labelOffset の受け渡し", () => {
  const near = 2;
  const far = 10;
  const moved = far - near;

  it("positionsAround", () => {
    const p = { x: 100, y: 100 };
    const above = (offset: number) => glyphBox(positionsAround(p, size, 0, offset)[1], size).y1;
    expect(above(near) - above(far)).toBeCloseTo(moved, 9);
  });

  it("besideSegment", () => {
    const a = { x: 0, y: 50 };
    const b = { x: 100, y: 50 };
    const side = (offset: number) => glyphBox(besideSegment(a, b, size, offset)[0], size).y0;
    expect(side(far) - side(near)).toBeCloseTo(moved, 9);
  });

  it("aroundVector", () => {
    const a = { x: 0, y: 50 };
    const b = { x: 100, y: 50 };
    const side = (offset: number) => glyphBox(aroundVector(a, b, size, 3.6, offset)[0], size).y0;
    expect(side(far) - side(near)).toBeCloseTo(moved, 9);
  });

  it("besideCurve の線の両側", () => {
    const pts = Array.from({ length: 21 }, (_, i) => ({ x: i * 10, y: 50, t: i }));
    const side = (offset: number) => besideCurve(pts, size, 10, "auto", offset)[0].box.y0;
    expect(side(far) - side(near)).toBeCloseTo(moved, 9);
  });

  it("besideCurve の向きの指定", () => {
    const pts = Array.from({ length: 21 }, (_, i) => ({ x: i * 10, y: 50, t: i }));
    const above = (offset: number) => besideCurve(pts, size, 10, "above", offset)[0].box.y1;
    expect(above(near) - above(far)).toBeCloseTo(moved, 9);
  });
});

describe("linePositions", () => {
  const a = { x: 0, y: 50 };
  const b = { x: 100, y: 50 };
  const at = { x: 30, y: 80 };
  const none = { at: undefined, dir: undefined, offset: undefined };

  it("labelAt だけなら基準点に固定する", () => {
    expect(linePositions({ ...none, at }, a, b, size, auto)).toEqual([
      { x: 30, y: 80, align: "center" },
    ]);
  });

  it('labelAt と "auto" なら基準点のまわりの候補を返す', () => {
    expect(linePositions({ ...none, at, dir: "auto" }, a, b, size, auto)).toHaveLength(9);
  });

  it("labelAt と向きなら基準点から向きへ固定する", () => {
    const [pos] = linePositions({ ...none, at, dir: "above" }, a, b, size, auto);
    expect(glyphBox(pos, size).y1).toBeLessThan(at.y);
  });

  it("基準点からの向きは基準点からの距離で離し、すきまを渡す", () => {
    const [pos] = linePositions({ ...none, at, dir: "above", offset: 10 }, a, b, size, auto);
    expect(glyphBox(pos, size).y1).toBeCloseTo(at.y - 10 - LABEL_POLICY.glyphSlack, 9);
  });

  it("基準点のまわりの候補にもすきまを渡す", () => {
    const positions = linePositions({ ...none, at, dir: "auto", offset: 10 }, a, b, size, auto);
    expect(glyphBox(positions[1], size).y1).toBeCloseTo(at.y - 10 - LABEL_POLICY.glyphSlack, 9);
  });

  it("線の中点からの向きは線の太さの半分も足して離す", () => {
    const [pos] = linePositions({ ...none, dir: "above", offset: 10 }, a, b, size, auto);
    const gap = LABEL_POLICY.lineHalfWidth + 10 + LABEL_POLICY.glyphSlack;
    expect(glyphBox(pos, size).y1).toBeCloseTo(50 - gap, 9);
  });

  it("指定が無ければ線のそばの候補を返し、すきまを渡す", () => {
    expect(linePositions({ ...none, offset: 7 }, a, b, size, auto)).toEqual(auto(7));
  });

  it("向きだけなら線の中点を基準点にする", () => {
    const [pos] = linePositions({ ...none, dir: "center" }, a, b, size, auto);
    expect(pos).toEqual({ x: 50, y: 50, align: "center" });
  });
});

describe("onLine の others", () => {
  const line = tracedLine(
    [
      { x: 0, y: 50 },
      { x: 300, y: 50 },
    ],
    false,
  );
  const plain = onLine([line], size, 5);
  const mid = Math.floor(plain.length / 2);
  const scoreOf = (others: readonly Box[], k: number) =>
    onLine([line], size, 5, others)[k].score?.(0) ?? 0;

  it("先に置いたラベルに重なる候補に最大の罰点を与える", () => {
    const here = [plain[mid].box];
    expect(scoreOf(here, mid) - scoreOf([], mid)).toBeCloseTo(LABEL_POLICY.crowd, 9);
  });

  it("すきまに応じて罰点をなめらかに減らす", () => {
    const b = plain[mid].box;
    const gap = LABEL_POLICY.crowdRadius / 4;
    const beside: readonly Box[] = [{ ...b, x0: b.x1 + gap, x1: b.x1 + gap + 10 }];
    expect(scoreOf(beside, mid) - scoreOf([], mid)).toBeCloseTo(0.75 * LABEL_POLICY.crowd, 9);
  });

  it("縦のすきまも同じように数える", () => {
    const b = plain[mid].box;
    const gap = LABEL_POLICY.crowdRadius / 2;
    const under: readonly Box[] = [{ ...b, y0: b.y1 + gap, y1: b.y1 + gap + 10 }];
    expect(scoreOf(under, mid) - scoreOf([], mid)).toBeCloseTo(0.5 * LABEL_POLICY.crowd, 9);
  });

  it("半径の外の候補には罰点を与えない", () => {
    const b = plain[mid].box;
    const x0 = b.x1 + LABEL_POLICY.crowdRadius + 1;
    const far: readonly Box[] = [{ ...b, x0, x1: x0 + 10 }];
    expect(scoreOf(far, mid)).toBe(scoreOf([], mid));
  });

  it("先に置いたラベルの数だけ罰点を足す", () => {
    const here = [plain[mid].box, plain[mid].box];
    expect(scoreOf(here, mid) - scoreOf([], mid)).toBeCloseTo(2 * LABEL_POLICY.crowd, 9);
  });
});

describe("onLineNear", () => {
  const horizontal = tracedLine(
    [
      { x: 0, y: 50 },
      { x: 200, y: 50 },
    ],
    false,
  );
  const vertical = tracedLine(
    [
      { x: 150, y: 0 },
      { x: 150, y: 40 },
    ],
    false,
  );

  it("線の上で指定の点に最も近い 1 点へ吸着する", () => {
    const cands = onLineNear([horizontal, vertical], size, 5, { x: 60, y: 70 });
    expect(cands).toHaveLength(1);
    expect((cands[0].box.x0 + cands[0].box.x1) / 2).toBeCloseTo(60, 9);
    expect((cands[0].box.y0 + cands[0].box.y1) / 2).toBeCloseTo(50, 9);
  });

  it("線の組の中で最も近い線を選ぶ", () => {
    const [c] = onLineNear([horizontal, vertical], size, 5, { x: 152, y: 10 });
    expect((c.box.x0 + c.box.x1) / 2).toBeCloseTo(150, 9);
    expect((c.box.y0 + c.box.y1) / 2).toBeCloseTo(10, 9);
  });

  it("線が無ければ候補を作らない", () => {
    expect(onLineNear([], size, 5, { x: 0, y: 0 })).toHaveLength(0);
  });
});

describe("anchoredCandidates", () => {
  const anchor = { x: 50, y: 50 };

  it("向きの指定が無ければ、基準点に続けて 8 方向を試す", () => {
    const cands = anchoredCandidates(anchor, size);
    expect(cands).toHaveLength(9);
    expect(cands[0].value).toEqual({ x: 50, y: 50, align: "center" });
  });

  it("向きを自動で選ぶときも、すきまを 8 方向へ渡す", () => {
    const [, above] = anchoredCandidates(anchor, size, "auto", 7);
    expect(above.value).toEqual(aroundPoint(anchor, size, 0, 7).above);
  });

  it("向きを指定すると 1 か所に固定する", () => {
    const [only, ...rest] = anchoredCandidates(anchor, size, "right", 7);
    expect(rest).toEqual([]);
    expect(only.value).toEqual(fixedPosition(anchor, "right", size, 0, 7));
  });

  it("center は基準点を中心にする", () => {
    const cands = anchoredCandidates(anchor, size, "center");
    expect(cands.map((c) => c.value)).toEqual([{ x: 50, y: 50, align: "center" }]);
  });
});

/** 受けたすきまを x に写した候補を 1 つ返す。 */
const offsetEcho = (offset: number | undefined): readonly Candidate<LabelPos>[] => [
  { box: { x0: 0, x1: 1, y0: 0, y1: 1 }, value: { x: offset ?? -1, y: 0, align: "center" } },
];

describe("lineLabelCandidates", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };
  it("位置も向きも指定が無ければ auto の候補を使う", () => {
    const spec = { at: undefined, dir: undefined, offset: 9 };
    expect(lineLabelCandidates(spec, a, b, size, offsetEcho)[0].value.x).toBe(9);
    const autoDir = { at: undefined, dir: "auto" as const, offset: undefined };
    expect(lineLabelCandidates(autoDir, a, b, size, offsetEcho)[0].value.x).toBe(-1);
  });

  it("基準点があれば、既定で基準点を中心にする", () => {
    const spec = { at: { x: 30, y: 40 }, dir: undefined, offset: undefined };
    const cands = lineLabelCandidates(spec, a, b, size, offsetEcho);
    expect(cands.map((c) => c.value)).toEqual([{ x: 30, y: 40, align: "center" }]);
  });

  it("基準点と向きの指定には、すきまを渡す", () => {
    const spec = { at: { x: 30, y: 40 }, dir: "above" as const, offset: 7 };
    const [only] = lineLabelCandidates(spec, a, b, size, offsetEcho);
    expect(only.value).toEqual(fixedPosition({ x: 30, y: 40 }, "above", size, 0, 7));
  });

  it("基準点と auto は、基準点のまわりから選ぶ", () => {
    const spec = { at: { x: 30, y: 40 }, dir: "auto" as const, offset: undefined };
    const cands = lineLabelCandidates(spec, a, b, size, offsetEcho);
    expect(cands).toHaveLength(9);
    expect(cands[0].value).toEqual({ x: 30, y: 40, align: "center" });
  });

  it("向きだけの指定は線の中点から測る", () => {
    const spec = { at: undefined, dir: "above" as const, offset: undefined };
    const [only] = lineLabelCandidates(spec, a, b, size, offsetEcho);
    expect(only.value.x).toBe(50);
    expect(only.value.y).toBeLessThan(0);
  });
});

describe("withPenalty", () => {
  const box = { x0: 0, x1: 1, y0: 0, y1: 1 };
  const value: LabelPos = { x: 0, y: 0, align: "center" };

  it("候補の全部に罰点を足し、元の罰点を保つ", () => {
    const [plain, scored] = withPenalty(
      [
        { box, value },
        { box, value, score: (penalty) => penalty + 2 },
      ],
      3,
    );
    expect(plain.score?.(10)).toBe(13);
    expect(scored.score?.(10)).toBe(15);
  });
});

describe("preferringOwnMark", () => {
  const near: Candidate<LabelPos> = {
    box: { x0: 10, x1: 20, y0: 0, y1: 10 },
    value: { x: 15, y: 5, align: "center" },
  };
  const own = { x: 0, y: 0 };

  it("自分の印より他の印に近い候補に罰点を足す", () => {
    const [cand] = preferringOwnMark([near], own, [{ x: 25, y: 5 }], 12);
    expect(cand.score?.(1)).toBe(13);
  });

  it("自分の印のほうが近い候補はそのまま返す", () => {
    const [cand] = preferringOwnMark([near], own, [{ x: 100, y: 100 }], 12);
    expect(cand).toBe(near);
  });

  it("自分の印と同じ位置の印は、丸めの差があっても数えない", () => {
    const [cand] = preferringOwnMark([near], own, [{ x: 1e-13, y: 0 }], 12);
    expect(cand).toBe(near);
  });

  it("候補の元の罰点を保つ", () => {
    const scored = { ...near, score: (penalty: number) => penalty + 2 };
    const [cand] = preferringOwnMark([scored], own, [{ x: 25, y: 5 }], 12);
    expect(cand.score?.(1)).toBe(15);
  });
});

describe("pointLabelCandidates", () => {
  const p = { x: 50, y: 50 };
  const autoCandidates = (): readonly Candidate<LabelPos>[] => offsetEcho(undefined);

  it("指定が無ければ auto の候補を使う", () => {
    const spec = { at: undefined, dir: undefined, offset: undefined };
    expect(pointLabelCandidates(spec, p, size, 4, autoCandidates)[0].value.x).toBe(-1);
    const autoDir = { at: undefined, dir: "auto" as const, offset: undefined };
    expect(pointLabelCandidates(autoDir, p, size, 4, autoCandidates)[0].value.x).toBe(-1);
  });

  it("基準点があれば基準点を中心にする", () => {
    const spec = { at: { x: 10, y: 20 }, dir: undefined, offset: undefined };
    const [only] = pointLabelCandidates(spec, p, size, 4, autoCandidates);
    expect(only.value).toEqual({ x: 10, y: 20, align: "center" });
  });

  it("向きだけの指定は、印の端から測る", () => {
    const spec = { at: undefined, dir: "right" as const, offset: 7 };
    const [only] = pointLabelCandidates(spec, p, size, 4, autoCandidates);
    expect(only.value).toEqual(aroundPoint(p, size, 4, 7).right);
  });
});

describe("besideCurve の空の標本", () => {
  it("標本が無ければ候補を返さない", () => {
    expect(besideCurve([], size, 0.5)).toEqual([]);
    expect(besideCurve([], size, undefined)).toEqual([]);
  });
});

describe("nearestCurvePoint", () => {
  const samples = [
    { x: 0, y: 0, t: 0 },
    { x: 1, y: 0, t: 1 },
    { x: 2, y: 0, t: 2 },
  ];

  it("媒介変数が最も近い標本の添字を返す", () => {
    expect(nearestCurvePoint(samples, 1.2)).toBe(1);
    expect(nearestCurvePoint(samples, 5)).toBe(2);
    expect(nearestCurvePoint(samples, -1)).toBe(0);
  });
});
