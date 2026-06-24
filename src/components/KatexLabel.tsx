import { renderToString } from "katex";

/**
 * SVG の中に KaTeX で組版した数式ラベルを置く部品。
 *
 * `<text>` に文字列を流し込む方式と違い、LaTeX の組版（上付き・下付き・分数・根号など）を
 * そのまま使える。図中のラベルを、本文のインライン数式 `$...$` と同一の字形・組版にそろえる。
 *
 * 仕組みはビルド時の埋め込みである。Astro がサーバ側で `katex.renderToString` を呼び、
 * 生成した HTML を SVG の `<foreignObject>` に収める。クライアント JavaScript は一切載せない。
 * KaTeX のスタイルとフォントは global.css の `@import "katex/dist/katex.min.css"` が供給する。
 *
 * 配置は、指定した点 (x, y) を中央に、幅 width・高さ height の枠へ中央寄せで描く。枠は当たり
 * 判定ではなく配置の基準にすぎず、内容がはみ出す場合に備えて overflow を可視にする。
 */

type KatexLabelProps = {
  /** 組版する LaTeX 文字列（例: "a^2"、"\\sqrt2"、"\\pi"）。 */
  tex: string;
  /** ラベルの中心の x 座標（SVG の viewBox 単位）。 */
  x: number;
  /** ラベルの中心の y 座標（SVG の viewBox 単位）。 */
  y: number;
  /** 配置基準の枠の幅。既定 72。 */
  width?: number;
  /** 配置基準の枠の高さ。既定 24。 */
  height?: number;
  /** フォントサイズ（viewBox 単位）。既定 14。 */
  fontSize?: number;
};

export default function KatexLabel({
  tex,
  x,
  y,
  width = 72,
  height = 24,
  fontSize = 14,
}: KatexLabelProps) {
  const html = renderToString(tex, { throwOnError: false, displayMode: false });
  return (
    <foreignObject
      x={x - width / 2}
      y={y - height / 2}
      width={width}
      height={height}
      style={{ overflow: "visible" }}
    >
      <div
        xmlns="http://www.w3.org/1999/xhtml"
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: `${fontSize}px`,
          lineHeight: 1,
          color: "currentColor",
        }}
        // KaTeX が生成した HTML を埋め込む。tex はソース内のリテラルのみを渡し、
        // 外部入力は受け取らないため、信頼できる組版結果である。
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </foreignObject>
  );
}
