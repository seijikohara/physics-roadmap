import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 既定の対象（全階層の *.test.ts）は、メインの作業ツリーの .claude/worktrees/ の下にある別の
    // worktree のテストまで拾う。対象を本リポジトリの src と scripts の直下からの階層に限る。
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // 図の部品の純粋なモジュールだけを検査し、DOM を使わない。
    environment: "node",
  },
});
