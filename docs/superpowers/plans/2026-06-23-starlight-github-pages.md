# Astro Starlight + GitHub Pages CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold a minimal Astro Starlight site and deploy it to GitHub Pages automatically via GitHub Actions on every push to `main`.

**Architecture:** A standard Astro + Starlight project at the repository root. The site is configured with `site`/`base` for a GitHub project page. A GitHub Actions workflow builds the static site with the official `withastro/action` and publishes it with `actions/deploy-pages`.

**Tech Stack:** Astro 7, @astrojs/starlight 0.40, pnpm, Node 24 (CI), GitHub Actions.

## Global Constraints

- Package manager: pnpm. A `pnpm-lock.yaml` must be committed so `withastro/action` auto-detects pnpm.
- Public URL: `https://seijikohara.github.io/physics-roadmap/`. Therefore `site: 'https://seijikohara.github.io'` and `base: '/physics-roadmap'`.
- Documentation language: Japanese only, via Starlight root locale (`locales.root.lang: 'ja'`). There is no top-level `lang` option.
- Node version in CI: 24 (default of `withastro/action`).
- All deliverable files (config, comments, commit messages) are written in English; documentation page content is Japanese.
- Scope is a placeholder site that builds and deploys. No i18n, no real content, no custom theming.

---

### Task 1: Scaffold a buildable Starlight site

**Files:**

- Create: `package.json`
- Create: `.gitignore`
- Create: `.nvmrc`
- Create: `tsconfig.json`
- Create: `astro.config.mjs`
- Create: `src/content.config.ts`
- Create: `src/content/docs/index.mdx`

**Interfaces:**

- Consumes: nothing (first task; empty repository with only the committed spec).
- Produces: a project that builds with `pnpm build`, emitting static HTML to `dist/`. Produces a committed `pnpm-lock.yaml` that Task 2's CI relies on for pnpm detection. Defines npm scripts `dev`, `build`, `preview`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "physics-roadmap",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.8.0",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview"
  },
  "dependencies": {
    "@astrojs/starlight": "^0.40.0",
    "astro": "^7.0.0",
    "sharp": "^0.34.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```gitignore
# build output
dist/

# generated types
.astro/

# dependencies
node_modules/

# logs
npm-debug.log*
pnpm-debug.log*
yarn-debug.log*
yarn-error.log*

# environment variables
.env
.env.production

# macOS
.DS_Store
```

- [ ] **Step 3: Create `.nvmrc`**

```
24
```

- [ ] **Step 4: Create `tsconfig.json`**

```json
{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"]
}
```

- [ ] **Step 5: Create `astro.config.mjs`**

```js
// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  site: "https://seijikohara.github.io",
  base: "/physics-roadmap",
  integrations: [
    starlight({
      title: "Physics Roadmap",
      // Monolingual Japanese site: override the default English root locale.
      locales: {
        root: {
          label: "日本語",
          lang: "ja",
        },
      },
    }),
  ],
});
```

- [ ] **Step 6: Create `src/content.config.ts`**

```ts
import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
```

- [ ] **Step 7: Create `src/content/docs/index.mdx`**

```mdx
---
title: Physics Roadmap
description: 物理学の学習ロードマップ
---

Physics Roadmap のドキュメントサイトへようこそ。

このサイトは現在準備中です。
```

- [ ] **Step 8: Install dependencies and generate the lockfile**

Run: `pnpm install`
Expected: dependencies resolve, `pnpm-lock.yaml` and `node_modules/` are created, exit code 0.

- [ ] **Step 9: Build the site to verify it compiles**

Run: `pnpm build`
Expected: build completes with a "Complete!" message and no errors. `dist/index.html` exists.

Verify the base path is applied:
Run: `ls dist/index.html`
Expected: the file exists (Starlight emits the root page at `dist/index.html`; links inside it are prefixed with `/physics-roadmap/`).

- [ ] **Step 10: Commit**

```bash
git add package.json .gitignore .nvmrc tsconfig.json astro.config.mjs src pnpm-lock.yaml
git commit -m "feat: scaffold minimal Astro Starlight site"
```

---

### Task 2: Add GitHub Actions deployment workflow

**Files:**

- Create: `.github/workflows/deploy.yml`

**Interfaces:**

- Consumes: `pnpm-lock.yaml` and the buildable project from Task 1 (`withastro/action` runs `pnpm install` and `pnpm build`).
- Produces: a workflow that, on push to `main`, builds the site and deploys it to GitHub Pages.

- [ ] **Step 1: Create `.github/workflows/deploy.yml`**

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

# Allow this job to clone the repo and create a page deployment.
permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout your repository using git
        uses: actions/checkout@v6
      - name: Install, build, and upload your site
        uses: withastro/action@v6

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v5
```

- [ ] **Step 2: Validate the workflow YAML locally**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml')); print('valid')"`
Expected: prints `valid` (confirms the YAML parses).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: deploy Starlight site to GitHub Pages"
```

- [ ] **Step 4: Push and verify the CI run**

```bash
git push -u origin main
```

Then verify the workflow run:
Run: `gh run list --workflow=deploy.yml --limit 1`
Expected: a run appears. Wait for it to finish with `gh run watch` and confirm `completed success`.

> **Manual owner step (cannot be automated here):** In the GitHub repository,
> open **Settings → Pages** and set **Source** to **GitHub Actions**. If Pages
> has never been enabled, the first deploy job may fail until this is set; in
> that case re-run the workflow after switching the source. After a successful
> deploy, confirm the site loads at `https://seijikohara.github.io/physics-roadmap/`.

---

## Self-Review

**Spec coverage:**

- Astro + Starlight, pnpm, Node 24, Japanese, GitHub Actions, project-page URL — Task 1 (scaffold/config) + Task 2 (workflow). ✓
- Repository layout from the spec — all listed files are created across Task 1 and Task 2. ✓
- `site`/`base` for the project page — Task 1 Step 5. ✓
- Manual "set Pages source to GitHub Actions" step — documented in Task 2 Step 4. ✓
- Out-of-scope items (i18n, real content, theming) — excluded. ✓

**Placeholder scan:** No TBD/TODO; every code/config step contains full content. ✓

**Type/name consistency:** `pnpm build` script name is consistent between Task 1 (defined) and Task 2 (used by the action default). `pnpm-lock.yaml` produced in Task 1 Step 8 and consumed in Task 2. ✓
