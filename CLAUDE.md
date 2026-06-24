# CLAUDE.md

本リポジトリの開発ガイドは`AGENTS.md`に集約する。Claude Code は AGENTS.md を直接読まないため、次の行で取り込む。

@AGENTS.md

## Claude Code 固有の指針

- 解説の章を書くときは`chapter-writer`サブエージェントを使う。`chapter-writer`が 4 つの検証（数式`math-verifier`・論理飛躍`logic-leap-verifier`・視覚表現`visual-verifier`・書式`markdown-verifier`）を呼ぶ。
- 成果物・コミットメッセージ・PR・チャット応答は日本語で書く。
- 複数コミットにわたる開発は、メインの作業ツリーを汚さないよう worktree で隔離する。
