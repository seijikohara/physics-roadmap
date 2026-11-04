import { describe, expect, it } from "vitest";
import type { Box } from "./geometry";
import {
  boxObstacle,
  groupObstacle,
  lineObstacle,
  ownLinesBoxDistance,
  tracedLine,
  type LineObstacle,
} from "./obstacles";
import {
  NO_PLACEMENT,
  bestOf,
  createPlacer,
  lineReach,
  placeInOrder,
  type Candidate,
} from "./placer";
import { FIELD_PENALTY_CAP, LABEL_POLICY } from "./policy";

const bounds: Box = { x0: 0, x1: 200, y0: 0, y1: 200 };
const box = (x0: number, y0: number, w = 10, h = 10): Box => ({
  x0,
  x1: x0 + w,
  y0,
  y1: y0 + h,
});

/** 矩形の中を横切る、長さ 40 の水平線の両端。 */
const crossing = (b: Box) => [
  { x: b.x0 - 15, y: (b.y0 + b.y1) / 2 },
  { x: b.x1 + 15, y: (b.y0 + b.y1) / 2 },
];

describe("createPlacer の penalty", () => {
  const target = box(50, 50);

  it("障害物が無く範囲の内側なら 0 を返す", () => {
    expect(createPlacer([]).penalty(target, { placed: [], bounds })).toBe(0);
  });

  it("重なる矩形の障害物の重みを足し合わせる", () => {
    const placer = createPlacer([boxObstacle(box(52, 52), 8), boxObstacle(box(55, 55), 6)]);
    expect(placer.penalty(target, { placed: [], bounds })).toBe(14);
  });

  it("範囲の外へ出る矩形に範囲外の罰点を与える", () => {
    const placer = createPlacer([]);
    const options = { placed: [], bounds };
    expect(placer.penalty(box(195, 50), options)).toBe(LABEL_POLICY.outside);
    expect(placer.penalty(box(-1, 50), options)).toBe(LABEL_POLICY.outside);
    expect(placer.penalty(box(50, 195), options)).toBe(LABEL_POLICY.outside);
  });

  it("ラベルどうしのすきまより近い矩形に軽い罰点を与える", () => {
    const placer = createPlacer([boxObstacle(box(50 + 10 + 2, 50), 8)]);
    expect(placer.penalty(target, { placed: [], bounds })).toBe(LABEL_POLICY.near);
  });

  it("既出のラベルとの重なりと近さを罰する", () => {
    const placer = createPlacer([]);
    expect(placer.penalty(target, { placed: [box(55, 55)], bounds })).toBe(
      LABEL_POLICY.labelOverlap,
    );
    expect(placer.penalty(target, { placed: [box(62, 50)], bounds })).toBe(LABEL_POLICY.near);
  });

  it("線に触れる位置に線の重みを与える", () => {
    const placer = createPlacer(lineObstacle("a", crossing(target), 6));
    expect(placer.penalty(target, { placed: [], bounds })).toBe(6);
  });

  it("線に触れないがすきまが足りない位置に、線の重みの一部を与える", () => {
    const below = (dy: number) =>
      createPlacer(
        lineObstacle(
          "b",
          [
            { x: 40, y: target.y1 + dy },
            { x: 70, y: target.y1 + dy },
          ],
          6,
        ),
      ).penalty(target, { placed: [], bounds });
    expect(below(LABEL_POLICY.lineTouch / 2)).toBe(6);
    expect(below(lineReach - 1)).toBe(6 * LABEL_POLICY.nearLine);
    expect(below(lineReach + 1)).toBe(0);
  });

  it("線の傾きによらず、矩形からの距離で判定する", () => {
    // 45 度の線が矩形の隅から d だけ離れて通る。すきまの帯の外なら、矩形を広げた角の内側を通っても
    // 数えない。
    const diagonal = (d: number) => {
      const off = d * Math.SQRT2;
      return createPlacer(
        lineObstacle(
          "d",
          [
            { x: target.x1 + off + 40, y: target.y1 - 40 },
            { x: target.x1 + off - 40, y: target.y1 + 40 },
          ],
          6,
        ),
      ).penalty(target, { placed: [], bounds });
    };
    expect(diagonal(lineReach + 0.5)).toBe(0);
    expect(diagonal(lineReach - 0.5)).toBe(6 * LABEL_POLICY.nearLine);
    expect(diagonal(LABEL_POLICY.lineTouch - 0.5)).toBe(6);
  });

  it("淡い線はすきまの内側でも数えない", () => {
    const placer = createPlacer(
      lineObstacle(
        "g",
        [
          { x: 40, y: target.y1 + lineReach - 1 },
          { x: 70, y: target.y1 + lineReach - 1 },
        ],
        1,
        true,
      ),
    );
    expect(placer.penalty(target, { placed: [], bounds })).toBe(0);
  });

  it("id で除外した線を数えない", () => {
    const placer = createPlacer(lineObstacle("own", crossing(target), 6));
    expect(placer.penalty(target, { placed: [], bounds, exclude: "own" })).toBe(0);
    expect(placer.penalty(target, { placed: [], bounds, exclude: "other" })).toBe(6);
  });

  it("id で除外した矩形を数えない", () => {
    const placer = createPlacer([boxObstacle(box(55, 55), 12, "pt0")]);
    expect(placer.penalty(target, { placed: [], bounds, exclude: "pt0" })).toBe(0);
    expect(placer.penalty(target, { placed: [], bounds })).toBe(12);
  });

  it("線の上のラベルは淡い線と群を避けない", () => {
    const arrows = groupObstacle(lineObstacle("f", crossing(target), 1, true), FIELD_PENALTY_CAP);
    const placer = createPlacer([...lineObstacle("g", crossing(target), 1, true), arrows]);
    expect(placer.penalty(target, { placed: [], bounds })).toBe(2);
    expect(placer.penalty(target, { placed: [], bounds, avoidFaint: false })).toBe(0);
  });

  it("群の罰点を上限で打ち切る", () => {
    const lines = Array.from({ length: 10 }, (): readonly LineObstacle[] =>
      lineObstacle("f", crossing(target), 1, true),
    ).flat();
    const placer = createPlacer([groupObstacle(lines, FIELD_PENALTY_CAP)]);
    expect(placer.penalty(target, { placed: [], bounds })).toBe(FIELD_PENALTY_CAP);
  });

  it("群ごとに上限をかける", () => {
    const group = () => groupObstacle(lineObstacle("f", crossing(target), 1, true), 4);
    const placer = createPlacer([group(), group()]);
    expect(placer.penalty(target, { placed: [], bounds })).toBe(2);
  });

  it("上限は群ごとに別々に数える", () => {
    const group = () =>
      groupObstacle(
        Array.from({ length: 5 }, (): readonly LineObstacle[] =>
          lineObstacle("f", crossing(target), 1, true),
        ).flat(),
        4,
      );
    const placer = createPlacer([group(), group()]);
    expect(placer.penalty(target, { placed: [], bounds })).toBe(8);
  });

  it("淡い線も id で除外する", () => {
    const placer = createPlacer(lineObstacle("g", crossing(target), 1, true));
    expect(placer.penalty(target, { placed: [], bounds, exclude: "g" })).toBe(0);
    expect(placer.penalty(target, { placed: [], bounds })).toBe(1);
  });
});

describe("createPlacer の place", () => {
  const free = box(10, 10);
  const busy = box(50, 50);
  const placer = createPlacer([boxObstacle(busy, 8)]);
  const options = { placed: [], bounds };

  it("罰点の最も小さい候補の値と罰点を返す", () => {
    const result = placer.place(
      [
        { box: busy, value: "busy" },
        { box: free, value: "free" },
      ],
      options,
    );
    expect(result).toEqual({ item: "free", score: 0 });
  });

  it("同点なら前方の候補を選ぶ", () => {
    const result = placer.place(
      [
        { box: free, value: "first" },
        { box: box(30, 30), value: "second" },
      ],
      options,
    );
    expect(result.item).toBe("first");
  });

  it("候補の好みの罰点を障害物の罰点に足す", () => {
    const result = placer.place(
      [
        { box: free, value: "a", score: (p) => p + 3 },
        { box: box(30, 30), value: "b", score: (p) => p + 1 },
      ],
      options,
    );
    expect(result).toEqual({ item: "b", score: 1 });
  });

  it("最良に届かない候補の好みの計算を打ち切る", () => {
    // 呼ばれた候補を記録する（テストの中に閉じた可変のバッファ）。
    const called: string[] = [];
    const cands: readonly Candidate<string>[] = [
      { box: free, value: "a" },
      {
        box: busy,
        value: "b",
        score: (p) => {
          called.push("b");
          return p;
        },
      },
    ];
    expect(placer.place(cands, options).item).toBe("a");
    expect(called).toEqual([]);
  });

  it("好みの罰点を足すと負ける候補が、障害物の罰点が小さくても選ばれる", () => {
    const light = { box: free, value: "light", score: (p: number) => p + 10 };
    const heavy = { box: busy, value: "heavy" };
    expect(placer.place([light, heavy], options)).toEqual({ item: "heavy", score: 8 });
  });

  it("打ち切りは障害物の罰点が最良に届くときだけ行う", () => {
    // busy の罰点 8 は最良の 10 に届かないので、好みの罰点を足して 13 になり、選ばれない。
    const cands: readonly Candidate<string>[] = [
      { box: free, value: "a", score: (p) => p + 10 },
      { box: busy, value: "b", score: (p) => p + 5 },
    ];
    expect(placer.place(cands, options)).toEqual({ item: "a", score: 10 });
  });

  it("候補が無ければ null を返す", () => {
    expect(placer.place([], options).item).toBeNull();
  });
});

describe("ownLinesBoxDistance", () => {
  // 右へ進んで折り返し、始点の近くへ戻る線。
  const hairpin = tracedLine(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 6 },
      { x: 0, y: 6 },
    ],
    false,
  );
  const label: Box = { x0: 8, x1: 12, y0: -2, y1: 8 };

  it("弧長の窓の外にある自分の線を障害物に残す", () => {
    expect(ownLinesBoxDistance([hairpin], { line: 0, s: 10 }, 20, label, 5)).toBe(0);
  });

  it("弧長の窓の内側にある自分の線を外す", () => {
    const straight = tracedLine(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      false,
    );
    const onLine: Box = { x0: 40, x1: 60, y0: -5, y1: 5 };
    expect(ownLinesBoxDistance([straight], { line: 0, s: 50 }, 60, onLine, 5)).toBe(Infinity);
  });

  it("閉じた線では始点をまたいで弧長を測る", () => {
    const square = tracedLine(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 40 },
        { x: 0, y: 40 },
        { x: 0, y: 0 },
      ],
      true,
    );
    const nearStart: Box = { x0: -1, x1: 4, y0: -1, y1: 4 };
    expect(ownLinesBoxDistance([square], { line: 0, s: 2 }, 25, nearStart, 1)).toBe(Infinity);
  });

  it("同じ組の他の線は全体を調べる", () => {
    const other = tracedLine(
      [
        { x: 10, y: -10 },
        { x: 10, y: 10 },
      ],
      false,
    );
    const onHairpin: Box = { x0: 8, x1: 12, y0: -2, y1: 2 };
    expect(ownLinesBoxDistance([hairpin, other], { line: 0, s: 10 }, 20, onHairpin, 5)).toBe(0);
  });
});

describe("bestOf", () => {
  it("score に最良の罰点を渡す", () => {
    // 受け取った値を順に記録する（テストの中に閉じた可変のバッファ）。
    const seen: number[] = [];
    bestOf([3, 1, 2], (v, _, best) => {
      seen.push(best);
      return v;
    });
    expect(seen).toEqual([Infinity, 3, 1]);
  });

  it("Infinity の候補を選ばない", () => {
    expect(bestOf(["a"], () => Infinity).item).toBeNull();
  });
});

describe("placeInOrder", () => {
  it("置いた矩形を次のラベルへ渡し、置かなかったものを null にする", () => {
    const b1 = box(0, 0);
    const b2 = box(20, 0);
    // 受け取った矩形の数を順に記録する（テストの中に閉じた可変のバッファ）。
    const seen: number[] = [];
    const result = placeInOrder(["a", "skip", "b"], [], (s, i, placed) => {
      seen.push(placed.length);
      if (s === "skip") return NO_PLACEMENT;
      return { item: s, box: i === 0 ? b1 : b2 };
    });
    expect(result.items).toEqual(["a", null, "b"]);
    expect(result.placed).toEqual([b1, b2]);
    expect(seen).toEqual([0, 1, 1]);
  });
});
