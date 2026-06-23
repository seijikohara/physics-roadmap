# AGENTS.md

物理学の学習ロードマップを公開するドキュメントサイトの開発ガイドである。コーディングエージェントと人間の開発者の双方が従う。

## プロジェクト概要

- Astro と Starlight で構築した、物理学の学習ロードマップの静的サイトである。
- GitHub Pages へ自動デプロイする。公開 URL は`https://seijikohara.github.io/physics-roadmap`である。
- 数式・概念図・関数グラフ・データグラフを記事中で表現できる。

## 第一言語は日本語

- 本リポジトリの第一言語は日本語とする。
- 記事・ドキュメント・コミットメッセージ・PR・コードコメントを、原則として日本語で書く。
- サイトのコンテンツは日本語モノリンガルである（Starlight のルートロケール`lang: 'ja'`）。

## 技術スタック

- フレームワーク: Astro 7、Starlight 0.40
- UI アイランド: React 19
- 数式: remark-math、rehype-katex、KaTeX
- 概念図: astro-mermaid、Mermaid
- グラフ: Mafs、Chart.js（react-chartjs-2）
- パッケージマネージャ: pnpm

## ディレクトリ構成

- `src/content/docs/`: 記事（`.md` / `.mdx`）
- `src/components/`: React アイランドのコンポーネント
- `src/styles/`: スタイル
- `.claude/agents/`: 執筆と検証のサブエージェント定義
- `docs/`: 設計と計画のドキュメント

## 開発コマンド

- `pnpm dev`: 開発サーバを起動する。
- `pnpm build`: 本番ビルドを生成する。
- `pnpm preview`: ビルド結果をプレビューする。
- `pnpm run lint:text`: 全ドキュメントを textlint で校正する。
- `pnpm run lint:text:fix`: textlint で自動修正できる箇所を修正する。

## 対象読者

- 高校卒業程度の数学と物理を前提とする。
- 大学学部初年度レベルの内容を学ぶ読者。
- 前提を超える概念は、使う前に短く補う。

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
- 概念図は Mermaid のコードブロックで書く。
- 関数グラフとデータグラフは React アイランド（Mafs / Chart.js）で表現する。
- 各表現の動作例は`src/content/docs/showcase.mdx`にある。

## 品質ゲート

- コミット前に lefthook の pre-commit フックが textlint を実行する。エラーがあればコミットを中断する。
- CI（GitHub Actions）でも textlint を実行する。エラーがあればチェックを失敗させる。
- フックは`pnpm install`時の`prepare`スクリプト（`lefthook install`）で有効化する。

## コミット規約

- Conventional Commits 形式で書く。
- description は命令形・現在形で簡潔に書く。
- body には「何を」「なぜ」変更したかを書く。
- 本文は日本語で書く。
- Claude の署名や帰属テキストを付与しない。

## サブエージェント

`.claude/agents/`に執筆と検証のサブエージェントを定義する。

- `article-writer`: 解説記事を執筆する。最終化の前に必ず数式検証と論理検証を通す。
- `math-verifier`: 数式・導出・単位・係数の正しさを検証する。
- `logic-leap-verifier`: 論理の飛躍・暗黙の前提・根拠のない結論を検証する。

記事を書くときは`article-writer`を使う。`article-writer`が 2 つの検証サブエージェントを呼ぶ。
