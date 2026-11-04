import { describe, expect, it } from "vitest";
import {
  aroundPoint,
  aroundVector,
  besideCurve,
  besideSegment,
  centeredAt,
  fixedPosition,
  insideRegion,
  linePositions,
  onLine,
  onLineNear,
  positionsAround,
  stubPenalty,
  type PointMark,
} from "./candidates";
import { boxGap, boxesOverlap, distanceToBox, inflate, type Box, type XY } from "./geometry";
import { glyphBox, type GlyphSize, type LabelPos } from "./label-box";
import { lineObstacle, tracedLine, type LineObstacle, type TracedLine } from "./obstacles";
import { createPlacer, lineReach } from "./placer";
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

    it("線に触れたら反対側へ移る", () => {
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
    // 弧長 20〜28 の候補の切れ目は、始点の手前 12 以内で終わる。開いた線なら切れ端に当たる。
    const circle = ring(60);
    const open = tracedLine(circle.pts, false);
    [20, 24, 28].forEach((s) => {
      const { cut } = onLine([circle], size, 5)[s / 4].value;
      expect(stubPenalty(circle, s, cut, 40, [], [])).toBe(0);
    });
    const { cut } = onLine([circle], size, 5)[5].value;
    expect(stubPenalty(open, 20, cut, 40, [], [])).toBe(stub);
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

  it("線の端が切れ目の中でも、縁から線幅の半分より近い候補に罰点を与える", () => {
    expect(penalty(6, -0.27, 14)).toBe(stub);
    expect(penalty(94, 86, 100.27)).toBe(stub);
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
