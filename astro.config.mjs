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
    // GFM and SmartyPants stay enabled by default; custom plugins are appended.
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
    // Localize the auto-generated GFM footnotes heading and back-link to Japanese.
    // footnoteBackContent forces a text-presentation arrow (U+FE0E) so it does not
    // render as a color emoji like the default "↩".
    remarkRehype: {
      footnoteLabel: "脚注",
      footnoteBackLabel: "本文へ戻る",
      footnoteBackContent: "↩︎",
    },
  },
  integrations: [
    react(),
    // astro-mermaid must come BEFORE starlight so it can transform code blocks.
    mermaid({ autoTheme: true }),
    starlight({
      title: "Physics Roadmap",
      customCss: ["./src/styles/global.css"],
      // Monolingual Japanese site: override the default English root locale.
      locales: {
        root: {
          label: "日本語",
          lang: "ja",
        },
      },
      // Explicit Japanese sidebar grouped by track > category.
      // Each category points at its content directory; add entries as chapters land.
      sidebar: [
        // Single top-level link; label defaults to the page title.
        { slug: "prerequisites/knowledge" },
        {
          label: "数学",
          items: [
            {
              label: "数学の言葉",
              items: [{ autogenerate: { directory: "math/set" } }],
            },
          ],
        },
      ],
    }),
  ],
});
