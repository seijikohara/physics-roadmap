// katex の型定義（node_modules/katex/types/katex.d.ts）に無い内部 API のうち、図のラベルの寸法の
// 見積もり（measure.ts）が使う範囲だけを宣言する。節点の形は katex 0.17.0 の dist/katex.mjs の
// class Span・Anchor・SymbolNode・SvgNode・PathNode・LineNode に合わせる。
// import を置くとファイルがモジュールになり、declare module が katex の宣言への追加（拡張）になる。
// 内部 API の名前の先頭の下線は KaTeX が決めたものなので、no-underscore-dangle を外す。
/* oxlint-disable no-underscore-dangle */
import type { KatexOptions } from "katex";

declare module "katex" {
  /**
   * 組版の設定のうち、ラベルの寸法の見積もりで使うもの。KatexOptions は書き換えられる入れ子の
   * オブジェクト（macros など）や関数を含むため、読み取り専用の引数の型には値が真偽・文字列の
   * 設定だけを取り出して使う。
   */
  export type KatexTreeOptions = Readonly<
    Pick<KatexOptions, "displayMode" | "throwOnError" | "output"> & {
      trust?: boolean;
      strict?: boolean | "ignore" | "warn" | "error";
    }
  >;

  /** 節点の inline style。値は "0.2222em" のような CSS の文字列で、指定の無いキーは持たない。 */
  export type KatexCssStyle = Readonly<Record<string, string | undefined>>;

  /** 組版の木の節点に共通する形。節点の種類は、__domTree のクラスとの instanceof で見分ける。 */
  export type KatexHtmlNode = Readonly<{
    classes?: readonly string[];
    children?: readonly KatexHtmlNode[];
    style?: KatexCssStyle;
    /** 基線より上の高さ（em）。 */
    height?: number;
    /** 基線より下の深さ（em）。 */
    depth?: number;
  }>;

  /** span と a の要素（Span・Anchor）。 */
  export type KatexSpanNode = KatexHtmlNode &
    Readonly<{
      classes: readonly string[];
      children: readonly KatexHtmlNode[];
      style: KatexCssStyle;
      height: number;
      depth: number;
    }>;

  /**
   * 字の並び（SymbolNode）。KaTeX は同じクラスの字を 1 つの節点にまとめるが、width は先頭の字の
   * 送り幅のままにする。italic は最後の字のイタリック補正で、正のときだけ margin-right として描く。
   */
  export type KatexSymbolNode = KatexHtmlNode &
    Readonly<{
      text: string;
      width: number;
      italic: number;
      classes: readonly string[];
      style: KatexCssStyle;
      height: number;
      depth: number;
    }>;

  /** __domTree が公開する節点のクラス。instanceof の判定にだけ使う。 */
  type KatexNodeClass<T> = abstract new (...args: never[]) => T;

  /** 組版の木の節点のクラス（内部 API）。 */
  export const __domTree: Readonly<{
    Span: KatexNodeClass<KatexSpanNode>;
    Anchor: KatexNodeClass<KatexSpanNode>;
    SymbolNode: KatexNodeClass<KatexSymbolNode>;
    SvgNode: KatexNodeClass<KatexHtmlNode>;
    PathNode: KatexNodeClass<KatexHtmlNode>;
    LineNode: KatexNodeClass<KatexHtmlNode>;
  }>;

  /** 数式を HTML の組版の木（文字列にする前の節点の木）にする（内部 API）。 */
  export function __renderToHTMLTree(expression: string, options?: KatexTreeOptions): KatexSpanNode;
}
