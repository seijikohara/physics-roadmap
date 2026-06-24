# Design: Astro Starlight docs with GitHub Pages CI deployment

Date: 2026-06-23
Status: Approved

## Goal

Stand up an Astro Starlight documentation site and deploy it to GitHub Pages
automatically via GitHub Actions on every push to `main`. The first milestone is
a working CI deployment of a minimal site, not the documentation content itself.

## Decisions

| Topic                  | Choice                                           |
| ---------------------- | ------------------------------------------------ |
| Framework              | Astro + Starlight (latest)                       |
| Package manager        | pnpm                                             |
| Node version           | 24 (default of `withastro/action`)               |
| Documentation language | Japanese only (`lang: 'ja'`)                     |
| Deployment             | GitHub Actions (official `withastro/action`)     |
| Public URL             | `https://seijikohara.github.io/physics-roadmap/` |

## Repository layout (minimal scaffold)

```
.
├── .github/workflows/deploy.yml   # CI deployment
├── .gitignore                     # node_modules, dist, .astro, etc.
├── .nvmrc                         # Node 24 for local consistency
├── astro.config.mjs               # site/base + starlight integration
├── package.json                   # packageManager pinned to pnpm
├── pnpm-lock.yaml                 # required for withastro/action to detect pnpm
├── tsconfig.json
└── src/
    ├── content.config.ts          # docs collection (Starlight default)
    └── content/docs/
        └── index.mdx              # placeholder home page
```

## Configuration details

### astro.config.mjs

- `site: 'https://seijikohara.github.io'`
- `base: '/physics-roadmap'` — required because this is a project page, not a
  user/organization page.
- `integrations: [starlight({ title: 'Physics Roadmap', lang: 'ja' })]`
- Starlight resolves internal links against `base` automatically, so no extra
  link handling is needed.

### .github/workflows/deploy.yml

Based on the official Astro GitHub Pages guide.

- Triggers: `push` to `main` and `workflow_dispatch`.
- Permissions: `contents: read`, `pages: write`, `id-token: write`.
- `build` job:
  - `actions/checkout@v6`
  - `withastro/action@v6` — pnpm is auto-detected from `pnpm-lock.yaml`.
- `deploy` job:
  - depends on `build`
  - `environment: github-pages`
  - `actions/deploy-pages@v5`

## Out of scope (YAGNI)

- Internationalization (i18n).
- Real roadmap content.
- Custom theming, search customization, test framework.

The milestone is an empty/placeholder site that deploys successfully.

## Manual step (owner action required)

After the workflow runs, the repository owner must set GitHub Pages source to
"GitHub Actions" in the repository settings. This cannot be automated from the
working environment.

## References

- Astro — Deploy to GitHub Pages:
  https://docs.astro.build/en/guides/deploy/github/
- Starlight — Getting Started:
  https://starlight.astro.build/getting-started/
