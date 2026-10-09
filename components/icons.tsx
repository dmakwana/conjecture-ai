/**
 * A small hand-rolled icon set.
 *
 * A handful of glyphs is not worth a dependency, and inline SVG inherits
 * `currentColor` so each one takes the tone of whatever it sits in.
 */
type IconProps = { className?: string; title?: string };

const base = (className = "") =>
  `inline-block w-3.5 h-3.5 shrink-0 align-[-0.15em] ${className}`;

function Svg({
  className, title, children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={base(className)}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

export const IconInspect = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z" />
    <circle cx="8" cy="8" r="1.75" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.5v8" />
    <path d="M4.5 6.5 8 10l3.5-3.5" />
    <path d="M2 11.5v2h12v-2" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5 6.5 12 13 4.5" />
  </Svg>
);

export const IconChevron = ({ open, ...p }: IconProps & { open?: boolean }) => (
  <Svg {...p} className={`${p.className ?? ""} transition-transform ${open ? "rotate-90" : ""}`}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Svg>
);

export const IconCode = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 5 2 8l3.5 3M10.5 5 14 8l-3.5 3" />
  </Svg>
);

export const IconTable = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <path d="M2 6.5h12M6.5 6.5V13" />
  </Svg>
);

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.75 13 3.5v4c0 3-2.2 5.6-5 6.75C5.2 13.1 3 10.5 3 7.5v-4L8 1.75Z" />
  </Svg>
);

/** The GitHub mark is a filled glyph, so it skips the stroked Svg wrapper. */
export const IconGitHub = ({ className }: IconProps) => (
  <svg
    viewBox="0 0 16 16"
    fill="currentColor"
    className={base(className)}
    aria-hidden
  >
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
);
