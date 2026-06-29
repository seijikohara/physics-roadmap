// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import react from "@astrojs/react";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

// https://astro.build/config
export default defineConfig({
  site: "https://seijikohara.github.io",
  base: "/physics-roadmap",
  markdown: {
    // GFM と SmartyPants は既定で有効のまま、独自プラグインを追記する。
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
    // GFM が自動生成する脚注の見出しと戻りリンクを日本語へ差し替える。
    // footnoteBackContent は字形表示の矢印（U+FE0E）を強制し、既定の "↩" のように
    // カラー絵文字として描画されるのを防ぐ。
    remarkRehype: {
      footnoteLabel: "脚注",
      footnoteBackLabel: "本文へ戻る",
      footnoteBackContent: "↩︎",
    },
  },
  integrations: [
    react(),
    starlight({
      title: "Physics Roadmap",
      // 原子（核と楕円軌道）のロゴ。テーマごとに light/dark を切り替える。SVG は src/assets/ に置き、
      // Astro が import 解決する。タイトル文字は併記する（replacesTitle は付けない）。
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        alt: "Physics Roadmap",
      },
      // favicon は public/ 直下の SVG を指す（ルート相対）。Astro が base を補う。
      favicon: "/favicon.svg",
      customCss: ["./src/styles/global.css"],
      // 日本語モノリンガルのサイト。既定の英語ルートロケールを上書きする。
      locales: {
        root: {
          label: "日本語",
          lang: "ja",
        },
      },
      // トラック > カテゴリの階層で構成する日本語サイドバー。
      // 各カテゴリは対応するコンテンツディレクトリを指す。章の追加に合わせて項目を増やす。
      sidebar: [
        // 単一のトップレベルリンク。ラベルはページタイトルを既定で使う。
        { slug: "prerequisites/knowledge" },
        {
          label: "数学",
          items: [
            {
              label: "数学の言葉",
              items: [{ autogenerate: { directory: "math/set" } }],
            },
            {
              label: "代数",
              items: [{ autogenerate: { directory: "math/algebra" } }],
            },
            {
              label: "初等関数",
              items: [{ autogenerate: { directory: "math/functions" } }],
            },
            {
              label: "ベクトル",
              items: [{ autogenerate: { directory: "math/vectors" } }],
            },
            {
              label: "座標幾何",
              items: [{ autogenerate: { directory: "math/coordinate-geometry" } }],
            },
            {
              label: "複素数",
              items: [{ autogenerate: { directory: "math/complex-numbers" } }],
            },
            {
              label: "数列と級数",
              items: [{ autogenerate: { directory: "math/sequences-and-series" } }],
            },
          ],
        },
      ],
    }),
  ],
});
