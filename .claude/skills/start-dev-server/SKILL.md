---
name: start-dev-server
description: physics-roadmap サイト（Astro と Starlight）のローカル開発サーバを起動し、ブラウザでページを確認できるようにする。章やサイトをローカルで表示・プレビューしたいとき、見た目を確認したいとき、ドキュメントをレンダリングしたいとき、開発サーバを立ち上げたいときに使う。「ローカルで見たい」「ブラウザで開いて」「章の表示を確認したい」のように開発サーバと明示されない依頼でも積極的に使う。
---

# ローカル開発サーバの起動

サイトは Astro と Starlight で構築する。開発サーバは`pnpm dev`（`astro dev`）で動かす。`astro dev`はデーモンとして常駐し、コマンドは即座に戻る。設定の`base`は`/physics-roadmap`、既定ポートは 4321 である。

## 手順

1. リポジトリのルートで開発サーバを起動する。デーモン化するが、セッションを止めないようバックグラウンドジョブとして起動する。

   ```bash
   pnpm dev
   ```

   起動後、ログに`Dev server running at http://localhost:4321`が出る。常駐するため、停止・状態・ログは`astro dev stop`・`astro dev status`・`astro dev logs`で管理する。

2. サーバが応答するまで待ち、到達を確認する。URL には base パス`/physics-roadmap`が必ず付く。

   ```bash
   curl --retry 30 --retry-delay 1 --retry-connrefused -sS -o /dev/null -w "%{http_code}\n" http://localhost:4321/physics-roadmap/
   ```

   `200`が返れば起動済みである。

3. 開く URL をユーザに伝える。ページの URL は`src/content/docs/`配下のパスに base 接頭辞を付けた形になる。

   - トップ: `http://localhost:4321/physics-roadmap/`
   - `src/content/docs/`配下のページ: `http://localhost:4321/physics-roadmap/<パス>/`
   - 例: `src/content/docs/math/set/sets-and-elements.mdx`は`http://localhost:4321/physics-roadmap/math/set/sets-and-elements/`

## 注意

- ポート 4321 が使用中の場合、サーバは既に起動している可能性が高い。`pnpm exec astro dev status`で確認してから起動する。
- 確認が終わったら、対になるスキル`/stop-dev-server`で停止する。
