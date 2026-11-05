import { Bar, Line } from "@visx/shape";
import { useId } from "react";
import { aroundPoint } from "./figure-label/candidates";
import { glyphSizeOf } from "./figure-label/label-box";
import KatexLabel from "./KatexLabel";

/**
 * インライン SVG として描く、ビルド時生成の静的な面積図。
 *
 * 多項式の積を長方形の面積として表す。横の辺の和と縦の辺の和を分割し、分割でできる
 * 小長方形のそれぞれが積の 1 項に対応する。展開（積→和）と因数分解（和→積）の幾何的
 * な意味を可視化する。本コンポーネントはクライアント JavaScript を一切載せない。Astro
 * がビルド時に HTML へ描画する（クライアントディレクティブなし、ハイドレーションなし）。
 * ラベルは KatexLabel を介して KaTeX で組版し、本文のインライン数式と同一の字形にそろえる。
 */

/** 1 辺を分割する区切り。`length` は描画上の相対的な長さ、`label` は辺に添える数式。 */
type Segment = Readonly<{
  /** 区切りの相対的な長さ。同じ辺の中での比だけが意味を持つ。 */
  length: number;
  /** 辺に添える LaTeX 文字列（例: "a"、"b"）。 */
  label: string;
}>;

/** 小長方形に書き込む面積の表示。省略時は空欄にする。 */
type CellLabel = Readonly<{
  /** 横方向の何番目の区切りか（0 始まり）。 */
  col: number;
  /** 縦方向の何番目の区切りか（0 始まり）。 */
  row: number;
  /** セルに書く面積の LaTeX 文字列（例: "a^2"、"ab"）。 */
  label: string;
  /** 強調して塗るか。既定は false。 */
  highlight?: boolean;
}>;

type AreaModelProps = Readonly<{
  /** 横の辺の分割。左から順に並べる。 */
  columns: readonly Segment[];
  /** 縦の辺の分割。上から順に並べる。 */
  rows: readonly Segment[];
  /** 各セルに書く面積の表示。 */
  cells?: readonly CellLabel[];
  /**
   * 横と縦で 1 単位の長さを揃えるか。既定は false（描画領域いっぱいに広げる）。
   * true にすると、横の length の和と縦の length の和の比が、そのまま図の縦横比になる。
   * 例えば横の和と縦の和が等しいとき、図は正しく正方形になる。$(a+b)^2$ の図に使う。
   */
  equalScale?: boolean;
  /** 支援技術が読み上げるアクセシブルな説明。 */
  ariaLabel: string;
}>;

const FRAME = "#94a3b8";
const GRID = "#cbd5e1";
const HIGHLIGHT = "#f59e0b";

// 描画領域。正方形に近い図を中央へ収める。
const VIEW_W = 320;
const VIEW_H = 240;
// 辺のラベルの字の大きさ（KatexLabel の fontSize）。
const EDGE_FONT = 14;
const PAD_L = 40; // 縦の辺ラベルを左へ収める余白。
const PAD_T = 28; // 横の辺ラベルを上へ収める余白。
const PAD_R = 16;
const PAD_B = 16;

export default function AreaModel({
  columns,
  rows,
  cells = [],
  equalScale = false,
  ariaLabel,
}: AreaModelProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  // 利用できる最大の描画領域。
  const availW = VIEW_W - PAD_L - PAD_R;
  const availH = VIEW_H - PAD_T - PAD_B;

  // 相対的な長さの合計。
  const colTotal = columns.reduce((s, c) => s + c.length, 0);
  const rowTotal = rows.reduce((s, r) => s + r.length, 0);

  // 実際に描く長方形の寸法と原点。equalScale のときは横縦で 1 単位を揃え、
  // はみ出さないよう小さい方の倍率に合わせて中央へ寄せる。
  const unit = Math.min(availW / colTotal, availH / rowTotal);
  const boxW = equalScale ? unit * colTotal : availW;
  const boxH = equalScale ? unit * rowTotal : availH;
  const originX = PAD_L + (availW - boxW) / 2;
  const originY = PAD_T + (availH - boxH) / 2;

  // 各区切りの境界座標（累積）。
  const colEdges = cumulative(
    columns.map((c) => c.length),
    boxW,
    originX,
    colTotal,
  );
  const rowEdges = cumulative(
    rows.map((r) => r.length),
    boxH,
    originY,
    rowTotal,
  );

  const cellOf = (col: number, row: number) => cells.find((c) => c.col === col && c.row === row);

  // 列のラベルの行の高さ。行の中でいちばん低い字形も、枠から少なくともすきまの目標だけ離す。基線をそろえる
  // ので、ラベルごとには決めない。
  const columnY = columns
    .map((c) => aroundPoint({ x: 0, y: originY }, glyphSizeOf(c.label, EDGE_FONT), 0).above.y)
    .reduce((a, b) => Math.min(a, b), originY - 12);

  return (
    <svg
      className="area-model"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label={ariaLabel}
    >
      {/* 強調セルの塗り。グリッド線より先に描く。 */}
      {columns.map((_, ci) =>
        rows.map((__, ri) => {
          const cell = cellOf(ci, ri);
          if (!cell?.highlight) return null;
          return (
            <Bar
              key={`fill-${uid}-${ci}-${ri}`}
              className="area-model-highlight"
              x={colEdges[ci]}
              y={rowEdges[ri]}
              width={colEdges[ci + 1] - colEdges[ci]}
              height={rowEdges[ri + 1] - rowEdges[ri]}
              fill={HIGHLIGHT}
            />
          );
        }),
      )}

      {/* 内部の分割線。 */}
      {colEdges.slice(1, -1).map((cx, i) => (
        <Line
          key={`vg-${i}`}
          from={{ x: cx, y: originY }}
          to={{ x: cx, y: originY + boxH }}
          stroke={GRID}
          strokeWidth={1.2}
        />
      ))}
      {rowEdges.slice(1, -1).map((cy, i) => (
        <Line
          key={`hg-${i}`}
          from={{ x: originX, y: cy }}
          to={{ x: originX + boxW, y: cy }}
          stroke={GRID}
          strokeWidth={1.2}
        />
      ))}

      {/* 外枠。 */}
      <Bar
        x={originX}
        y={originY}
        width={boxW}
        height={boxH}
        fill="none"
        stroke={FRAME}
        strokeWidth={1.6}
      />

      {/* セルの面積ラベル。 */}
      {cells.map((c, i) => {
        const cx = (colEdges[c.col] + colEdges[c.col + 1]) / 2;
        const cy = (rowEdges[c.row] + rowEdges[c.row + 1]) / 2;
        return <KatexLabel key={`cell-${i}`} tex={c.label} x={cx} y={cy} fontSize={13} />;
      })}

      {/* 横の辺ラベル（上）。 */}
      {columns.map((c, ci) => {
        const cx = (colEdges[ci] + colEdges[ci + 1]) / 2;
        return (
          <KatexLabel key={`col-${ci}`} tex={c.label} x={cx} y={columnY} fontSize={EDGE_FONT} />
        );
      })}

      {/* 縦の辺ラベル（左）。 */}
      {rows.map((r, ri) => {
        const cy = (rowEdges[ri] + rowEdges[ri + 1]) / 2;
        // 高さは同じ行のセルのラベルとそろえ、基線を合わせる。
        const pos = aroundPoint({ x: originX, y: cy }, glyphSizeOf(r.label, EDGE_FONT), 0).left;
        return (
          <KatexLabel
            key={`row-${ri}`}
            tex={r.label}
            x={pos.x}
            y={cy}
            fontSize={EDGE_FONT}
            align={pos.align}
          />
        );
      })}
    </svg>
  );
}

/**
 * 相対長の配列から、開始座標を base とする累積境界座標を作る。
 *
 * 累積和は先頭から 1 つずつ足す。足す順を変えると浮動小数の丸めが変わり、座標がずれるため。
 */
function cumulative(
  lengths: readonly number[],
  span: number,
  base: number,
  total: number,
): readonly number[] {
  return lengths.reduce<Readonly<{ acc: number; edges: readonly number[] }>>(
    (state, len) => {
      const acc = state.acc + len;
      return { acc, edges: [...state.edges, base + (acc / total) * span] };
    },
    { acc: 0, edges: [base] },
  ).edges;
}
