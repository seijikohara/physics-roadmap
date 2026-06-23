// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

// https://astro.build/config
export default defineConfig({
  site: 'https://seijikohara.github.io',
  base: '/physics-roadmap',
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
  },
  integrations: [
    starlight({
      title: 'Physics Roadmap',
      customCss: ['./src/styles/global.css'],
      // Monolingual Japanese site: override the default English root locale.
      locales: {
        root: {
          label: '日本語',
          lang: 'ja',
        },
      },
    }),
  ],
});
