# 可視化スタック設計

物理学学習ロードマップ（Astro + Starlight、静的サイト生成、MDX、React、KaTeX）の図解に用いる可視化ライブラリの選定と、chapter-writer が使うコンポーネント方針を定める。

## 改訂

- 2026-06-24: 2D 標準を JSXGraph から D3 へ改めた。サイトは GitHub Pages の静的サイトであり、ベン図など教示用の図ではドラッグの利得が希薄なため、ビルド時に静的 SVG を焼き込む方式を既定とする。JSXGraph と `jsxgraph` 依存は撤去した。
- 2026-06-26: 2D 標準を D3 から visx（`@visx/*`）へ改めた（PR #9）。visx は D3 を基盤とする React 向けの高レベルコンポーネント群で、宣言的に SVG を組める。あわせて概念図を Mermaid から `FlowChart` コンポーネント（`@dagrejs/dagre` ＋ `@visx/network`）へ置き換え、`mermaid`・`astro-mermaid`・`d3-scale` 依存を撤去した。空間ベクトル用に、軸測投影の静的 SVG を描く `SpaceVectorDiagram` を追加した。

## 方針

- **ビルド時静的 SVG を既定**とする。図はビルド時に SVG を生成して HTML へ焼き込み、クライアント JS を載せない。静的サイト（GitHub Pages）で読み込みが速く、アクセシビリティと堅牢性が高い。
- **2D は visx に統一**する。関数・幾何・ベクトル・ベン図・数直線・データグラフを、visx のモジュール（`@visx/scale`・`@visx/shape`・`@visx/group`・`@visx/grid`・`@visx/marker`・`@visx/clip-path`・`@visx/legend` など）で計算し、静的 SVG として出力する。図ごとの追加依存（venn.js など）は使わない。
- **概念図は `FlowChart` に統一**する。`@dagrejs/dagre` がビルド時にノード配置・エッジ経路・クラスタ境界を計算し、`@visx/network` で描く。Mermaid は使わない。
- **双方向性は例外**とする。ドラッグやスライダーが本当に要る図のみ、React のクライアントアイランドとしてハイドレートする。
- **宣言的コンポーネント中心**とする。再利用可能な React コンポーネントを用意し、chapter-writer は MDX から JSON シリアライズ可能な props で呼ぶ。
- **3D は別枠**とする。数学段階の空間ベクトルは、軸測投影の静的 SVG（`SpaceVectorDiagram`）で表す。曲面・3D ベクトル場・時空など真の 3D は、物理段階で react-three-fiber を導入する。

## 層とライブラリ

| 層                                                    | 採用                                                       | 導入時期               |
| ----------------------------------------------------- | ---------------------------------------------------------- | ---------------------- |
| 2D 数学・幾何（関数・幾何・ベクトル・ベン図・数直線） | visx（ビルド時静的 SVG。自作の宣言的コンポーネント）       | 今                     |
| データグラフ                                          | visx（ビルド時静的 SVG。高水準が要る図は `@visx/xychart`） | データ図が必要な章から |
| 概念図・フロー                                        | `FlowChart`（`@dagrejs/dagre` ＋ `@visx/network`）         | 今                     |
| 空間ベクトル（数学段階の擬似 3D）                     | `SpaceVectorDiagram`（軸測投影のビルド時静的 SVG）         | 今                     |
| 3D（曲面・3D ベクトル場・時空）                       | react-three-fiber + drei                                   | 物理段階               |
| 数式                                                  | KaTeX（現用）                                              | 継続                   |

## 選定根拠（2026 時点）

- visx: D3 を基盤とする React 向けの可視化プリミティブ群で、`scale`・`shape`・`group`・`grid`・`marker`・`clip-path`・`legend`・`network` などのモジュールを宣言的に組み合わせて SVG を作る。サーバ側で描けば出力は静的 SVG となりクライアント JS を載せない。低レベルな D3 を React コンポーネントで隠蔽し、ビルド時生成と相性がよい。
- データグラフ: 静的なデータ図は visx の静的 SVG で描く。高水準の図が要るときは `@visx/xychart` を導入する。ツールチップなど双方向性が要るデータ図が必要になった時点で、描画手段を選定する。
- `@dagrejs/dagre` ＋ `@visx/network`: 有向グラフのレイアウト（dagre）と描画（visx）を分離し、ビルド時にノード配置・エッジ経路・クラスタ境界を計算して静的 SVG を焼く。LLM からは宣言的な props（ノード・エッジ）で量産できる。
- react-three-fiber: JSX が Three.js に 1 対 1 で対応する宣言的レンダラで、React 19 に対応し活発に保守される。真の 3D のみで導入する。
- 不採用: JSXGraph・Mafs（2D を visx に統一）、Mermaid（概念図を `FlowChart` に統一）、venn.js・chartjs-chart-venn（面積比例のデータ駆動図で教示用途に不向き）、Chart.js・Plotly・ECharts（データグラフは visx の静的 SVG で賄う。双方向性が必要になった時点で選定する）。

## コンポーネント設計

- 各図は **意味的な高レベルコンポーネント**として提供する。実在するもの: `FunctionGraph`・`FlowChart`・`SpaceVectorDiagram`・`UnitCircle`・`Triangle`・`NumberLine`・`AreaModel`・`VennDiagram`・`KatexLabel`。
- visx 系コンポーネントはビルド時に静的 SVG を生成する。`@visx/scale`・`@visx/shape`・`@visx/group` などで座標とパスを計算し、React で SVG 要素を返す。`client:only`は付けない。
- 図中ラベルの数式は `KatexLabel` が SVG の `foreignObject` に KaTeX を埋め込み、本文のインライン数式と同一の字形にそろえる。
- **双方向性**: ドラッグやスライダーが要る図のみ、React のクライアントアイランドとしてハイドレートする。
- **テーマ追従**: Starlight の light/dark に合わせ、SVG のラベルを CSS で `currentColor` 基調に整える。補助線の色は CSS 変数（`--fig-axis`・`--fig-grid` など）でテーマに追従する。ラベルのフォントは KaTeX に合わせる。
- **アクセシビリティ**: 各 SVG に `aria-label` を付ける。
- 各コンポーネントは「1 つの明確な役割・明示的な props インターフェース・独立して理解可能」を満たす単位に分割する。

## 移行

- 2D を visx に統一済み（PR #9）。`FunctionGraph`・`UnitCircle`・`Triangle`・`NumberLine`・`AreaModel`・`VennDiagram` を visx で実装し、`KatexLabel` で図中の数式を組版する。
- 概念図を `FlowChart`（`@dagrejs/dagre` ＋ `@visx/network`）に統一済み（PR #9）。`mermaid`・`astro-mermaid`・`@mermaid-js/layout-elk` 依存と astro-mermaid 連携を撤去した。
- 旧スタックの撤去: `jsxgraph`・`d3-scale`・`chart.js`・`react-chartjs-2` と、未使用の `DataChart` を撤去済み（YAGNI。データ図が必要になった時点で `@visx/xychart` を導入する）。
- 空間ベクトル（数学段階）は `SpaceVectorDiagram`（軸測投影の静的 SVG）で描く。
- react-three-fiber の依存追加と利用は、真の 3D が必要な物理段階まで保留する。
