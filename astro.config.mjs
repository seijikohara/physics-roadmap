// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import react from "@astrojs/react";
import mermaid from "astro-mermaid";
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
    // astro-mermaid はコードブロックを変換するため、starlight より前に置く。
    // forceLegacyMathML: true で、図中の `$$...$$` 数式を KaTeX で描く。既定の MathML
    // 任せは OS・ブラウザ間で字形が不安定なため、KaTeX 組版に固定して本文の数式と字形を
    // そろえる。KaTeX のスタイルは global.css の `@import "katex/dist/katex.min.css"` が供給する。
    mermaid({
      autoTheme: true,
      mermaidConfig: {
        forceLegacyMathML: true,
        // 図中の地の文（ラベルの日本語）を、サイト本文と同じシステムフォントで描く。
        // Mermaid の既定（trebuchet）は本文と字形が異なるため、本文のフォントスタックに合わせる。
        fontFamily:
          '-apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif',
      },
    }),
    starlight({
      title: "Physics Roadmap",
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
          ],
        },
      ],
    }),
  ],
});
