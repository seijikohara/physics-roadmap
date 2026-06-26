# AGENTS.md

物理学の学習ロードマップを公開するドキュメントサイトの開発ガイドである。コーディングエージェントと人間の開発者の双方が従う。

## プロジェクト概要

- Astro と Starlight で構築した、物理学の学習ロードマップの静的サイトである。
- GitHub Pages へ自動デプロイする。公開 URL は`https://seijikohara.github.io/physics-roadmap`である。
- 数式・概念図・関数グラフ・データグラフを章中で表現できる。

## 第一言語は日本語

- 本リポジトリの第一言語は日本語とする。
- 章・ドキュメント・コミットメッセージ・PR・コードコメントを、原則として日本語で書く。
- サイトのコンテンツは日本語モノリンガルである（Starlight のルートロケール`lang: 'ja'`）。

## 技術スタック

- フレームワーク: Astro 7、Starlight 0.40
- UI アイランド: React 19
- 数式: remark-math、rehype-katex、KaTeX
- 図・グラフ: visx（`@visx/*`）によるビルド時生成の静的 SVG。すべての図を visx で描く。
  - 座標・スケール: `@visx/scale`。描画: `@visx/shape`・`@visx/group`・`@visx/grid`・`@visx/marker`・`@visx/clip-path`。凡例: `@visx/legend`。
  - 概念図（フローチャート）: `@visx/network` ＋ `@dagrejs/dagre`（ビルド時のレイアウト）。`FlowChart`コンポーネントで描く。
  - 2D 図（関数・幾何・ベクトル・ベン図・数直線）: 各図コンポーネント（`FunctionGraph`・`UnitCircle`・`Triangle`・`NumberLine`・`VennDiagram`・`AreaModel`）。
  - データグラフ: visx を標準とする。高水準の図が要るときは`@visx/xychart`を導入する。データ図が必要な章で導入する。
- パッケージマネージャ: pnpm

## ディレクトリ構成

- `src/content/docs/`: 章（`.md`/`.mdx`）
- `src/components/`: React アイランドのコンポーネント
- `src/styles/`: スタイル
- `.claude/agents/`: 執筆と検証のサブエージェント定義
- `docs/`: 設計と計画のドキュメント

## 開発コマンド

- `pnpm dev`: 開発サーバを起動する。
- `pnpm build`: 本番ビルドを生成する。
- `pnpm preview`: ビルド結果をプレビューする。
- `pnpm run lint`: JS/TS を oxlint で検証する（型認識・警告もエラー扱い）。
- `pnpm run lint:fix`: oxlint で自動修正できる箇所を修正する。
- `pnpm run format`: oxfmt でコードとドキュメントを整形する。
- `pnpm run format:check`: oxfmt で整形済みかを検査する。
- `pnpm run lint:text`: 全ドキュメントを textlint で校正する。
- `pnpm run lint:text:fix`: textlint で自動修正できる箇所を修正する。
- `pnpm run check`: format:check・lint・lint:text をまとめて実行する。

## 対象読者

- 本ロードマップが前提とする知識を持つ読者を対象とする。前提は最初の章[前提とする知識](src/content/docs/prerequisites/knowledge.mdx)に明記する。
- 標準模型のラグランジアンと一般相対性理論の数式理解を最終到達目標とする。経路は学部から大学院初年度の場の量子論と一般相対論に及ぶ。
- 前提と到達目標の差は章内で埋める。微積分・三角関数・ベクトルなど、前提とする知識に含まれない数学は、使う前に基礎から導入する。

## 学習ロードマップ

全体設計は`docs/roadmap-design.md`に定める。執筆の唯一の正とする。章は依存順に書く。

- **自己完結**: 一連の章のみでゴールへ到達できる構成とする。説明の論理を外部資料に委ねない。「詳細は専門書を参照」と書かない。
- **演習による習得**: 各章に例題と演習問題を置く。演習には解答を付ける。
- **参考文献セクション**: さらに学ぶための一次資料・データ出典は、章末の独立した「参考文献」セクションに箇条書きでまとめる。参考文献は信頼できる一次資料に限る。
- **脚注の役割**: 脚注は本来の補足説明に充てる。記法の由来、暗黙の前提や成立条件、細かい例外、上位概念、先の章への布石などを、厳選して置く。脚注を読まなくても本文が完結するよう、論理の鎖の一部にはしない。

## ドキュメント執筆規約

日本語テクニカルライティングの文体に準拠する。`.textlintrc.json`の規則に通ることが必須要件である。

- 指示代名詞を使わない。「これ」「それ」「この」「その」などを避け、具体的な名詞で書く。
- 一文を短くする。一文一意とし、長い一文を避ける。一文は 120 文字以下を目安とする。
- 長い一文より Markdown 書式で読みやすくする。箇条書き・見出し・表・コードブロック・数式ブロックに分解する。
- 文体を統一する。である調とです・ます調を混在させない。
- 能動態・現在形を基本とし、主語を明示する。
- 略語と専門用語は初出時に定義する。

## 表現手段

- 数式は KaTeX で書く。インラインは`$...$`、ブロックは`$$ ... $$`とする。
- すべての図・グラフは visx（`@visx/*`）でビルド時に静的 SVG を生成する。実装は`src/components/`にあり、クライアント JS を載せない。MDX から各コンポーネントを import して使う。
- 概念図（フローチャート）は`FlowChart`コンポーネントで描く。`@dagrejs/dagre`がビルド時にノード配置・エッジ経路・クラスタ境界を計算し、`@visx/network`で描く。ノード・エッジを宣言的な props で渡す。次の規約に従う。
  - ラベルは改行を`\n`、数式を`$...$`で表す（例: `"判別式 $D = b^2 - 4ac$\nを計算する"`）。数式部分は KaTeX で組版し、日本語の地の文は本文と同じシステムフォントで描く。数式でない語を`\text{}`で囲まない。
  - JSX の文字列リテラルでは LaTeX のバックスラッシュを 2 重にする（`\gt`は`"\\gt"`、`\mathbb{R}`は`"\\mathbb{R}"`）。不等号は`\lt`・`\gt`で書く。
  - 形状は`shape: "diamond"`で菱形（判断）、既定は矩形。エッジは`dashed: true`で破線。サブグラフは`clusters`（入れ子可）で表す。方向は`direction: "TB" | "LR"`。
- 2D 図（関数グラフ・幾何・ベクトル・ベン図・数直線）は、対応する各コンポーネント（`FunctionGraph`・`UnitCircle`・`Triangle`・`NumberLine`・`VennDiagram`・`AreaModel`）で描く。
  - 図中ラベルの数式は`KatexLabel`が SVG の foreignObject に KaTeX を埋め込む。根号などの伸縮グリフは foreignObject 内で高さ 0 に潰れるため、`src/styles/global.css`で各図の`.katex svg`に`height: 100%`を与えて復元している。新たな伸縮グリフを使うときは、ビルドして実機で確認する。
  - 図中の日本語は本文と同じシステムフォントにそろえる（`global.css`で KaTeX の`.cjk_fallback`を本文フォントへ上書き済み）。各図は表示倍率 1.0（`max-width`＝viewBox 幅）で描き、フォントサイズを図をまたいでそろえる。
- ドラッグやスライダーなど双方向性が必要な図のみ、クライアントアイランドで読み込む。
- データグラフは visx を標準とする。高水準の図が要るときは`@visx/xychart`を導入する。データ図が必要な章で導入する。双方向性が要る場合は、その時点で描画手段を選定する。

## 品質ゲート

- コミット前に lefthook の pre-commit フックが、oxfmt（整形）→ oxlint（型認識・警告もエラー扱い）→ textlint（校正）を順に実行する。エラーがあればコミットを中断する。
- CI（GitHub Actions）の lint ワークフローでも、oxfmt の整形検査・oxlint・textlint を実行する。エラーがあればチェックを失敗させる。
- フックは`pnpm install`時の`prepare`スクリプト（`lefthook install`）で有効化する。

## コミット規約

- Conventional Commits 形式で書く。
- description は命令形・現在形で簡潔に書く。
- body には「何を」「なぜ」変更したかを書く。
- 本文は日本語で書く。
- Claude の署名や帰属テキストを付与しない。

## サブエージェント

`.claude/agents/`に執筆と検証のサブエージェントを定義する。

- `chapter-writer`: 解説の章を執筆する。最終化の前に必ず 4 つの検証を通す。
- `math-verifier`: 数式・導出・単位・係数の正しさを検証する。
- `logic-leap-verifier`: 論理の飛躍・暗黙の前提・根拠のない結論、および記号・記法の初出の導入を検証する。
- `visual-verifier`: 視覚表現（図・ダイアグラム・グラフ）が十分か、可視化方針に沿うかを検証する。
- `markdown-verifier`: Markdown 書式の活用（構造化・見出し・表・数式の使い分け）が十分かを検証する。

章を書くときは`chapter-writer`を使う。`chapter-writer`が 4 つの検証サブエージェントを呼ぶ。
