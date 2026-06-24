import { useId } from "react";
import type { ReactNode } from "react";

/**
 * Static, build-time Venn diagram rendered as inline SVG.
 *
 * Each `variant` shades the region that names a single set operation or
 * relation, so the figure carries its own legend instead of relying on
 * interaction. The component ships no client JavaScript: Astro renders it to
 * HTML at build time (no client directive, no hydration). Colors and text read
 * on both light and dark themes — labels follow the theme text color and the
 * KaTeX math font through CSS (see .venn-figure in src/styles/global.css).
 */

type Variant =
  | "plain" // two labeled circles in U, no shading or region labels
  | "regions" // base diagram: the four regions of two overlapping sets
  | "intersection" // A∩B
  | "union" // A∪B
  | "complement" // Ā
  | "subset" // A⊂B
  | "disjoint" // A∩B=∅
  | "equal" // A=B
  | "universal" // A=U
  | "nonempty" // A≠∅
  | "subset-complement"; // B̄⊂Ā (the contrapositive side of A⊂B)

type VennDiagramProps = {
  variant: Variant;
  /** Accessible description read by assistive technology. */
  ariaLabel: string;
  /** Single-character set names. Defaults to 'A' and 'B'. */
  labels?: { a?: string; b?: string };
};

const STROKE_A = "#3b82f6";
const STROKE_B = "#ef4444";
const HIGHLIGHT = "#f59e0b";
const FRAME = "#94a3b8";

// Two overlapping circles inside the universal-set rectangle. Radii and centers
// leave a clear margin to the frame on every side. Shared by every variant
// except `subset` and `disjoint`, which use their own geometry.
const U = { x: 10, y: 8, w: 300, h: 184 };
const A = { cx: 128, cy: 104, r: 58 };
const B = { cx: 192, cy: 104, r: 58 };

/** Render text with an overline, the notation for a complement (e.g. B̄). */
function Ov({ children }: { children: string }) {
  return <tspan style={{ textDecoration: "overline" }}>{children}</tspan>;
}

// Centered SVG text helpers. Kept at module scope: they capture no component
// state, so they are defined once instead of on every render.
const label = (cls: string, x: number, y: number, text: ReactNode) => (
  <text className={cls} x={x} y={y} textAnchor="middle" dominantBaseline="central">
    {text}
  </text>
);
const name = (x: number, y: number, text: string) => label("venn-name", x, y, text);
const region = (x: number, y: number, text: ReactNode) => label("venn-region", x, y, text);

export default function VennDiagram({ variant, ariaLabel, labels }: VennDiagramProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const clipA = `vennClipA-${uid}`;
  const maskNotA = `vennMaskNotA-${uid}`;
  const maskNotB = `vennMaskNotB-${uid}`;

  // Set names. Default to A/B to preserve backward compatibility.
  const a = labels?.a ?? "A";
  const b = labels?.b ?? "B";

  const body: ReactNode = ((): ReactNode => {
    switch (variant) {
      case "intersection":
        return (
          <>
            <defs>
              <clipPath id={clipA}>
                <circle cx={A.cx} cy={A.cy} r={A.r} />
              </clipPath>
            </defs>
            <circle cx={A.cx} cy={A.cy} r={A.r} fill="none" stroke={STROKE_A} strokeWidth={1.8} />
            <circle cx={B.cx} cy={B.cy} r={B.r} fill="none" stroke={STROKE_B} strokeWidth={1.8} />
            <circle
              cx={B.cx}
              cy={B.cy}
              r={B.r}
              fill={HIGHLIGHT}
              fillOpacity={0.55}
              clipPath={`url(#${clipA})`}
            />
            {name(110, 70, a)}
            {name(210, 70, b)}
            {region(160, 112, `${a}∩${b}`)}
          </>
        );
      case "union":
        return (
          <>
            <circle
              cx={A.cx}
              cy={A.cy}
              r={A.r}
              fill={HIGHLIGHT}
              fillOpacity={0.4}
              stroke={STROKE_A}
              strokeWidth={1.8}
            />
            <circle
              cx={B.cx}
              cy={B.cy}
              r={B.r}
              fill={HIGHLIGHT}
              fillOpacity={0.4}
              stroke={STROKE_B}
              strokeWidth={1.8}
            />
            {name(110, 70, a)}
            {name(210, 70, b)}
            {region(160, 180, `${a}∪${b}`)}
          </>
        );
      case "complement":
        return (
          <>
            <defs>
              <mask id={maskNotA}>
                <rect x={U.x} y={U.y} width={U.w} height={U.h} fill="#fff" />
                <circle cx={A.cx} cy={A.cy} r={A.r} fill="#000" />
              </mask>
            </defs>
            <rect
              x={U.x}
              y={U.y}
              width={U.w}
              height={U.h}
              fill={HIGHLIGHT}
              fillOpacity={0.45}
              mask={`url(#${maskNotA})`}
            />
            <circle cx={A.cx} cy={A.cy} r={A.r} fill="none" stroke={STROKE_A} strokeWidth={1.8} />
            {name(128, 104, a)}
            {region(248, 70, <Ov>{a}</Ov>)}
          </>
        );
      case "subset": {
        const bb = { cx: 176, cy: 104, r: 72 };
        const aa = { cx: 150, cy: 104, r: 32 };
        return (
          <>
            <circle
              cx={bb.cx}
              cy={bb.cy}
              r={bb.r}
              fill={STROKE_B}
              fillOpacity={0.06}
              stroke={STROKE_B}
              strokeWidth={1.8}
            />
            <circle
              cx={aa.cx}
              cy={aa.cy}
              r={aa.r}
              fill={STROKE_A}
              fillOpacity={0.16}
              stroke={STROKE_A}
              strokeWidth={1.8}
            />
            {name(150, 104, a)}
            {name(176, 52, b)}
          </>
        );
      }
      case "disjoint": {
        const ad = { cx: 80, cy: 104, r: 46 };
        const bd = { cx: 240, cy: 104, r: 46 };
        return (
          <>
            <circle
              cx={ad.cx}
              cy={ad.cy}
              r={ad.r}
              fill={STROKE_A}
              fillOpacity={0.1}
              stroke={STROKE_A}
              strokeWidth={1.8}
            />
            <circle
              cx={bd.cx}
              cy={bd.cy}
              r={bd.r}
              fill={STROKE_B}
              fillOpacity={0.1}
              stroke={STROKE_B}
              strokeWidth={1.8}
            />
            {name(80, 104, a)}
            {name(240, 104, b)}
            {region(160, 104, `${a}∩${b}=∅`)}
          </>
        );
      }
      case "equal":
        // Two nearly coincident circles: the sets share every element (A=B).
        return (
          <>
            <circle cx={160} cy={104} r={60} fill={HIGHLIGHT} fillOpacity={0.12} />
            <circle cx={160} cy={104} r={66} fill="none" stroke={STROKE_A} strokeWidth={1.8} />
            <circle cx={160} cy={104} r={60} fill="none" stroke={STROKE_B} strokeWidth={1.8} />
            {region(160, 104, `${a}=${b}`)}
          </>
        );
      case "universal":
        // The set fills the whole universal set (A=U): shade U entirely.
        return (
          <>
            <rect
              x={U.x}
              y={U.y}
              width={U.w}
              height={U.h}
              fill={HIGHLIGHT}
              fillOpacity={0.4}
              rx={4}
            />
            {region(160, 104, `${a}=U`)}
          </>
        );
      case "nonempty": {
        // A single set holding at least one element (A≠∅): one dot marks an element.
        const an = { cx: 160, cy: 104, r: 58 };
        return (
          <>
            <circle
              cx={an.cx}
              cy={an.cy}
              r={an.r}
              fill={HIGHLIGHT}
              fillOpacity={0.25}
              stroke={STROKE_A}
              strokeWidth={1.8}
            />
            <circle cx={an.cx} cy={an.cy} r={3.5} fill="currentColor" />
            {name(an.cx, 60, a)}
            {region(an.cx, 132, `${a}≠∅`)}
          </>
        );
      }
      case "subset-complement": {
        // Contrapositive of A⊂B: the outside of B sits inside the outside of A
        // (B̄⊂Ā). Same nested geometry as `subset`; shade B's exterior via a mask.
        const bb = { cx: 176, cy: 104, r: 72 };
        const aa = { cx: 150, cy: 104, r: 32 };
        return (
          <>
            <defs>
              <mask id={maskNotB}>
                <rect x={U.x} y={U.y} width={U.w} height={U.h} fill="#fff" />
                <circle cx={bb.cx} cy={bb.cy} r={bb.r} fill="#000" />
              </mask>
            </defs>
            <rect
              x={U.x}
              y={U.y}
              width={U.w}
              height={U.h}
              fill={HIGHLIGHT}
              fillOpacity={0.45}
              mask={`url(#${maskNotB})`}
            />
            <circle
              cx={bb.cx}
              cy={bb.cy}
              r={bb.r}
              fill="none"
              stroke={STROKE_B}
              strokeWidth={1.8}
            />
            <circle
              cx={aa.cx}
              cy={aa.cy}
              r={aa.r}
              fill={STROKE_A}
              fillOpacity={0.16}
              stroke={STROKE_A}
              strokeWidth={1.8}
            />
            {name(150, 104, a)}
            {name(176, 52, b)}
            {region(50, 176, <Ov>{b}</Ov>)}
          </>
        );
      }
      case "plain":
        return (
          <>
            <circle
              cx={A.cx}
              cy={A.cy}
              r={A.r}
              fill={STROKE_A}
              fillOpacity={0.08}
              stroke={STROKE_A}
              strokeWidth={1.8}
            />
            <circle
              cx={B.cx}
              cy={B.cy}
              r={B.r}
              fill={STROKE_B}
              fillOpacity={0.08}
              stroke={STROKE_B}
              strokeWidth={1.8}
            />
            {name(110, 104, a)}
            {name(210, 104, b)}
          </>
        );
      case "regions":
      default:
        return (
          <>
            <circle
              cx={A.cx}
              cy={A.cy}
              r={A.r}
              fill={STROKE_A}
              fillOpacity={0.08}
              stroke={STROKE_A}
              strokeWidth={1.8}
            />
            <circle
              cx={B.cx}
              cy={B.cy}
              r={B.r}
              fill={STROKE_B}
              fillOpacity={0.08}
              stroke={STROKE_B}
              strokeWidth={1.8}
            />
            {name(110, 70, a)}
            {name(210, 70, b)}
            {region(160, 112, `${a}∩${b}`)}
            {region(
              90,
              112,
              <>
                {a}∩<Ov>{b}</Ov>
              </>,
            )}
            {region(
              230,
              112,
              <>
                <Ov>{a}</Ov>∩{b}
              </>,
            )}
            {region(
              48,
              178,
              <>
                <Ov>{a}</Ov>∩<Ov>{b}</Ov>
              </>,
            )}
          </>
        );
    }
  })();

  return (
    <svg className="venn-figure" viewBox="0 0 320 200" role="img" aria-label={ariaLabel}>
      {body}
      <rect
        x={U.x}
        y={U.y}
        width={U.w}
        height={U.h}
        fill="none"
        stroke={FRAME}
        strokeWidth={1.5}
        rx={4}
      />
      <text className="venn-u" x={U.x + 10} y={U.y + 16} dominantBaseline="central">
        U
      </text>
    </svg>
  );
}
