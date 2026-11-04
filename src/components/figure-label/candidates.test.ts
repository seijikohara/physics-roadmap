import { describe, expect, it } from "vitest";
import {
  aroundPoint,
  aroundVector,
  besideCurve,
  besideSegment,
  centeredAt,
  fixedPosition,
  insideRegion,
  onLine,
  positionsAround,
} from "./candidates";
import { boxesOverlap, inflate } from "./geometry";
import { glyphBox, type GlyphSize } from "./label-box";
import { tracedLine } from "./obstacles";
import { lineReach } from "./placer";
import { LABEL_POLICY } from "./policy";

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

  it('"center" は基準点をそのまま KatexLabel の中心にする', () => {
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

  it("向きを指定すると、各位置で 1 か所だけを候補にする", () => {
    const cands = besideCurve(visible, size, 10, "above");
    expect(cands).toHaveLength(1);
    expect(cands[0].box.y1).toBeLessThan(50);
  });

  it("指定が無ければ曲線の後半を優先する", () => {
    const cands = besideCurve(visible, size, undefined);
    const score = (x: number) => cands.find((c) => c.value.x === x)?.score?.(0) ?? Infinity;
    expect(score(170)).toBeLessThan(score(10));
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
