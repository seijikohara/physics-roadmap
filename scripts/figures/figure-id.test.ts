import { describe, expect, it } from "vitest";
import {
  compareFigureIds,
  extractFigures,
  figureFileStem,
  figureIds,
  parseFigureId,
} from "./figure-id.ts";

const page = (body: string): string =>
  `<html><div class="x"></div><div class="sl-markdown-content">${body}</div><svg role="img" id="foot"></svg></html>`;

const KATEX_SVG = '<svg width="1"><path d="M0"></path></svg>';
const LEGEND_SVG = '<svg width="24" aria-hidden="true"></svg>';

describe("parseFigureId", () => {
  it("数は figure の系列、s の付く形は figure の外の系列に読む", () => {
    expect(parseFigureId("3")).toBe(3);
    expect(parseFigureId(" s2 ")).toBe("s2");
  });

  it.each(["0", "s0", "s", "1.5", "-1", "2s", ""])("%s は図の番号ではない", (text) => {
    expect(parseFigureId(text)).toBeNull();
  });
});

describe("compareFigureIds", () => {
  it("figure の系列を先に、それぞれを番号の順に並べる", () => {
    const sorted = (["s10", 2, "s2", 10] as const).toSorted(compareFigureIds);
    expect(sorted).toEqual([2, 10, "s2", "s10"]);
  });
});

describe("figureIds", () => {
  it("figure → figure の外の順に番号を返す", () => {
    expect(figureIds(2, 2)).toEqual([1, 2, "s1", "s2"]);
    expect(figureIds(0, 0)).toEqual([]);
  });
});

describe("figureFileStem", () => {
  it("系列が分かる 2 桁の名前を返す", () => {
    expect(figureFileStem(3)).toBe("fig-03");
    expect(figureFileStem("s3")).toBe("fig-s03");
    expect(figureFileStem(12)).toBe("fig-12");
  });
});

describe("extractFigures", () => {
  it("figure の中の図は figure の系列だけに数える", () => {
    const fig = `<figure><svg role="img">${KATEX_SVG}</svg></figure>`;
    expect(extractFigures(page(fig))).toEqual({ figures: [fig], standalone: [] });
  });

  it("figure の外の図を、中の KaTeX の svg ごと切り出す", () => {
    const svg = `<svg class="unit-circle" role="img" aria-label="a"><foreignObject>${KATEX_SVG}</foreignObject></svg>`;
    expect(extractFigures(page(`<p>x</p>${svg}<p>y</p>`))).toEqual({
      figures: [],
      standalone: [svg],
    });
  });

  it("凡例の見本の svg と本文の外の svg は図に数えない", () => {
    expect(extractFigures(page(LEGEND_SVG))).toEqual({ figures: [], standalone: [] });
  });

  it("凡例の見本の後の図も切り出す", () => {
    const svg = '<svg role="img"></svg>';
    expect(extractFigures(page(`${LEGEND_SVG}${svg}`)).standalone).toEqual([svg]);
  });

  it("2 系列をそれぞれ文書の順に数える", () => {
    const a = '<svg role="img" id="a"></svg>';
    const b = '<figure><svg role="img" id="b"></svg></figure>';
    const c = '<svg role="img" id="c"></svg>';
    expect(extractFigures(page(`${a}${b}${c}`))).toEqual({ figures: [b], standalone: [a, c] });
  });

  it("入れ子の figure を開始タグの順に 1 つずつ数える", () => {
    const inner = "<figure>b</figure>";
    const outer = `<figure>a${inner}</figure>`;
    expect(extractFigures(page(outer)).figures).toEqual([outer, inner]);
  });

  it("記事本文が無いページは空を返す", () => {
    expect(extractFigures("<html></html>")).toEqual({ figures: [], standalone: [] });
  });
});
