# CLAUDE.md

本リポジトリの開発ガイドは`AGENTS.md`に集約する。Claude Code は AGENTS.md を直接読まないため、次の行で取り込む。

@AGENTS.md

## Claude Code 固有の指針

- 解説記事を書くときは`article-writer`サブエージェントを使う。`article-writer`が数式検証（`math-verifier`）と論理飛躍検証（`logic-leap-verifier`）を呼ぶ。
- 成果物・コミットメッセージ・PR・チャット応答は日本語で書く。
- 複数コミットにわたる開発は、メインの作業ツリーを汚さないよう worktree で隔離する。
