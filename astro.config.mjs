// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://seijikohara.github.io',
  base: '/physics-roadmap',
  integrations: [
    starlight({
      title: 'Physics Roadmap',
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
