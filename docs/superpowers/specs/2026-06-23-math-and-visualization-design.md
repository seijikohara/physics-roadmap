# Design: Math and rich visualization support

Date: 2026-06-23
Status: Superseded by [2026-06-24-visualization-stack-design.md](./2026-06-24-visualization-stack-design.md) (2026-06-24)

> **Note**: This document is a point-in-time record of the original decision. The
> 2D visualization standard later moved from Mafs/Chart.js to build-time static
> SVG with visx (`@visx/*`), and Mermaid diagrams to a build-time `FlowChart`
> component (`@dagrejs/dagre` + `@visx/network`); see the superseding document.
> The Mafs/Chart.js choices, Mermaid, and the
> `FunctionPlot`/`InteractivePlot`/`VectorFieldPlot`/`DataChart` components and
> `showcase.mdx` described below have since been removed. The text is kept
> unchanged as history.

## Goal

Add math (LaTeX) rendering and rich, interactive visualization to the Astro
Starlight site so it can host physics and mathematics learning content. The
"approach B" stack is chosen: introduce React to use Mafs for polished,
interactive math plots. A single showcase page exercises every feature so the
build and a visual check confirm everything works.

## Version baseline (verified empirically)

`astro@7.0.0` + `@astrojs/starlight@0.40.0` are already installed, built, and
deployed in this repository (the live site returns HTTP 200). They are kept as
is. An earlier research claim that Starlight 0.40 requires Astro 6 is
contradicted by this working install and is rejected.

## Decisions

| Purpose                                   | Package(s)                                                                               | Notes                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| React integration                         | `@astrojs/react`@6, `react`@19, `react-dom`@19, `@types/react`@19, `@types/react-dom`@19 | Requires Node >= 22.12 (CI Node 24, local Node 26 satisfy it).                                    |
| Math                                      | `remark-math`@6, `rehype-katex`@7, `katex`                                               | Build-time rendering. KaTeX CSS loaded globally.                                                  |
| Diagrams                                  | `astro-mermaid`@2, `mermaid`@11, `@mermaid-js/layout-elk`@0.2                            | Client-side render, light/dark theme follow. Must be listed before `starlight` in `integrations`. |
| Function plots / geometry / vector fields | `mafs`@0.21                                                                              | React island. Peer `react >=18`, works with React 19.                                             |
| Data charts                               | `react-chartjs-2`@5, `chart.js`@4                                                        | React island. Lightweight canvas charts.                                                          |

Exact patch versions are resolved at install time; the major/minor pins above
are the compatibility floor. KaTeX's exact version is whatever `rehype-katex`@7
resolves; it is verified at install.

## Architecture

Each capability is an isolated unit with a clear authoring interface.

### Math (build-time)

- Authors write `$...$` (inline) and `$$...$$` (block) in `.md`/`.mdx`.
- `remark-math` parses the math; `rehype-katex` renders it to HTML at build
  time. No client JS is shipped for math.
- KaTeX CSS is loaded on every page via Starlight's `customCss` option, which
  points at `src/styles/global.css`; that file `@import`s the KaTeX stylesheet.

### Diagrams (client-side)

- Authors write Mermaid in fenced code blocks (mermaid language fences).
- `astro-mermaid` renders them in the browser and follows the Starlight
  light/dark theme. It is added to `integrations` before `starlight`.

### Function plots, geometry, vector fields (React islands, Mafs)

Reusable React components live in `src/components/`:

- `FunctionPlot.tsx` — renders `<Mafs>` with `<Coordinates.Cartesian />` and one
  or more `<Plot.OfX y={fn} />`. The function is passed from MDX as a real JS
  function prop (`fn={(x) => Math.sin(x)}`); no string `eval`.
  - Props: `fn: (x: number) => number` (or an array of such), optional
    `domain`/`viewBox` numeric bounds, optional `height`.
- `InteractivePlot.tsx` — demonstrates a parameter slider: plain React
  `useState` + `<input type="range">` outside `<Mafs>` feeding a value into a
  `Plot.OfX` (e.g. amplitude of a sine wave). Mafs ships no slider widget, so
  this is the idiomatic pattern.
- `VectorFieldPlot.tsx` — demonstrates `<Plot.VectorField xy={...} />` and a
  draggable point via `useMovablePoint`.

Authors use these in MDX with a client directive, e.g.
`<FunctionPlot client:visible fn={(x) => Math.sin(x)} />`. `client:visible`
keeps the JS off the critical path for below-the-fold plots.

### Data charts (React island, Chart.js)

- `DataChart.tsx` wraps `react-chartjs-2`'s `Line`/`Bar`/`Scatter` selected by a
  `type` prop, with `data` and `options` props.
  - It registers the needed Chart.js elements once via
    `ChartJS.register(...registerables)` (or an explicit subset).
- Used in MDX as `<DataChart client:visible type="line" data={...} />`.

## Island constraints (accepted)

- React Context does not cross island boundaries. Cross-island shared state is
  out of scope (YAGNI); if needed later, use nanostores.
- Scoped `<style>` cannot target inside an island wrapper. Mafs and KaTeX styles
  come from their own stylesheets, so this does not affect this work.

## Showcase / verification page

`src/content/docs/showcase.mdx` exercises every feature on one page and serves
as both the verification artifact and the authoring reference:

1. Inline and block math (e.g. `$E = mc^2$`, an integral, a matrix).
2. A Mermaid diagram (a small flow/graph).
3. A static `FunctionPlot` (e.g. `y = sin(x)`).
4. An `InteractivePlot` with a slider (e.g. amplitude of a sine wave).
5. A `VectorFieldPlot` with a draggable point.
6. A `DataChart` (a line or bar chart with sample data).

## Testing

This is a static site with no unit-test framework. Verification is build- and
output-based:

- `pnpm build` succeeds.
- Grep the built `dist/` output for expected markers from the showcase page:
  - a KaTeX element (`class="katex"`),
  - a React island wrapper (`<astro-island`),
  - the mermaid container/code that `astro-mermaid` emits.
- Final manual check: `pnpm preview`, open the showcase page, confirm the math,
  diagram, plots, slider interaction, and chart render and behave.
- CI deploy continues to run on push; the showcase page must build there too.

## Out of scope (YAGNI)

- nanostores cross-island state, 3D plots, Desmos integration, custom theming.

## References

- Astro — Markdown math (remark-math + rehype-katex):
  https://docs.astro.build/en/guides/markdown-content/
- Astro — React integration: https://docs.astro.build/en/guides/integrations-guide/react/
- Mafs: https://mafs.dev/
- astro-mermaid: https://www.npmjs.com/package/astro-mermaid
- react-chartjs-2: https://react-chartjs-2.js.org/
