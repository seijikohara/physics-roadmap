---
name: stop-dev-server
description: physics-roadmap サイトのローカル開発サーバ（Astro の astro dev）を停止し、ポート 4321 を解放する。開発サーバやプレビューサーバを止めたい、終了したい、シャットダウンしたい、ポートを解放したいときに使う。
---

# ローカル開発サーバの停止

開発サーバ（`astro dev`）はデーモンとして常駐する。Astro の停止コマンドで止める。

## 手順

1. リポジトリのルートでデーモンを停止する。

   ```bash
   pnpm exec astro dev stop
   ```

2. 停止を確認する。状態表示か、ポートが応答しないことで確かめる。

   ```bash
   pnpm exec astro dev status
   ```

   ```bash
   curl -sS -o /dev/null -w "%{http_code}\n" --max-time 3 http://localhost:4321/physics-roadmap/ || echo stopped
   ```

## 注意

- `astro dev stop`が「起動中のサーバなし」と返す場合、サーバは既に停止している。
- 再度起動するには、対になるスキル`/start-dev-server`を使う。
