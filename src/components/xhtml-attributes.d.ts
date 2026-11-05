// SVG の foreignObject の中に置く HTML 要素は、XHTML の名前空間を xmlns で明示する。
// React の型は HTML 要素に xmlns を定義しないため、HTMLAttributes に加える。
// style に渡す CSS 変数も、React の型に名前を加える。
// import を置くとファイルがモジュールになり、declare module が React の宣言への追加になる。
import type { AriaAttributes } from "react";

declare module "react" {
  interface HTMLAttributes<T> extends AriaAttributes {
    xmlns?: string;
  }
  interface CSSProperties {
    "--edge"?: string;
  }
}
