// Stroke icons lifted from the design canvas (16×16 grid).

const PATHS: Record<string, { d: string[]; fill?: boolean; circles?: [number, number, number][] }> = {
  menu: { d: ["M2.5 4.5h11M2.5 8h11M2.5 11.5h11"] },
  plus: { d: ["M8 3v10M3 8h10"] },
  minus: { d: ["M3 8h10"] },
  undo: { d: ["M5.5 3.5L2.5 6.5l3 3M2.5 6.5H10a3.5 3.5 0 0 1 0 7H6.5"] },
  close: { d: ["M4 4l8 8M12 4l-8 8"] },
  back: { d: ["M10 3L5 8l5 5"] },
  chevronDown: { d: ["M4 6l4 4 4-4"] },
  chevronUp: { d: ["M4 10l4-4 4 4"] },
  tag: { d: ["M2 2.5h5.5L14 9l-5 5-6.5-6.5z"], circles: [[5.3, 5.3, 1]] },
  ship: { d: ["M8 13.5V3M4 7l4-4 4 4M3 14h10"] },
  push: { d: ["M8 13V3M4 7l4-4 4 4"] },
  stash: { d: ["M2.5 9.5v3.5h11V9.5", "M8 2.5v7M5 6.5l3 3 3-3"] },
  unstash: { d: ["M2.5 9.5v3.5h11V9.5", "M8 9.5v-7M5 5.5l3-3 3 3"] },
  box: { d: ["M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7z", "M2.5 4.5L8 7.5l5.5-3M8 7.5v7"] },
  layers: { d: ["M8 2l6 3-6 3-6-3zM2 8.5l6 3 6-3M2 11.5l6 3 6-3"] },
  terminal: { d: ["M3 4l4 4-4 4M8.5 12H13"] },
  sun: { d: ["M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9L13 13M3 13l1.1-1.1M11.9 4.1L13 3"], circles: [[8, 8, 3]] },
  moon: { d: ["M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1z"] },
  folder: { d: ["M2 4.5A1 1 0 0 1 3 3.5h3l1.4 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"] },
  sparkle: { d: ["M8 1l1.7 4.6L14.5 7.3 9.7 9 8 13.6 6.3 9 1.5 7.3l4.8-1.7z"], fill: true },
  refresh: { d: ["M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"] },
  swap: { d: ["M3 5.5h10M10.5 3L13 5.5 10.5 8M13 10.5H3M5.5 8L3 10.5 5.5 13"] },
  copy: { d: ["M5.5 5.5h7v8h-7z", "M3.5 10.5v-8h7"] },
  edit: { d: ["M11 2.5l2.5 2.5L6 12.5H3.5V10z"] },
  check: { d: ["M3 8.5l3 3 7-7"] },
  external: { d: ["M9 3h4v4M13 3L7 9M11 9.5V13H3V5h3.5"] },
  search: { d: ["M11 11l3 3"], circles: [[7, 7, 4.5]] },
  branch: { d: ["M5 3v10M11 6.5c0 3-3 3.5-6 4"], circles: [[5, 3, 1.5], [5, 13, 1.5], [11, 5, 1.5]] },
  merged: { d: ["M4 4.5v1c0 2.5 4 3 4 5.5v.5", "M12 4.5v1c0 2.5-4 3-4 5.5"], circles: [[4, 3, 1.5], [12, 3, 1.5], [8, 13, 1.5]] },
  sidebar: { d: ["M2.5 3.5h11v9h-11zM6.5 3.5v9"] },
  commit: { d: ["M8 1.5v4M8 10.5v4"], circles: [[8, 8, 2.5]] },
  pr: { d: ["M5 4.5v7M11 11.5V7a2 2 0 0 0-2-2H7M8.5 3.5L7 5l1.5 1.5"], circles: [[5, 3, 1.5], [5, 13, 1.5], [11, 13, 1.5]] },
  ticket: { d: ["M2.5 4.5h11v2a1.5 1.5 0 0 0 0 3v2h-11v-2a1.5 1.5 0 0 0 0-3z"] },
  chart: { d: ["M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5"] },
  phone: { d: ["M5 1.5h6a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM7 12.5h2"] },
  pause: { d: ["M5.5 3.5v9M10.5 3.5v9"] },
  play: { d: ["M5 3.5l7 4.5-7 4.5z"] },
  stop: { d: ["M4 4h8v8H4z"] },
  trash: { d: ["M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"] },
  brush: { d: ["M13.7 2.3L10.8 5.2", "M9.1 3.4l3.5 3.5-1.8 1.8-3.5-3.5z", "M7.3 5.2L2.3 8.7l5 5 3.5-5", "M6.2 8.4L3.9 10.3M7.6 9.8L5.7 12.1"] },
  smile: { d: ["M5.8 9.6a2.8 2.8 0 0 0 4.4 0M6 6.5h.01M10 6.5h.01"], circles: [[8, 8, 6]] },
  gear: { d: ["M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"] },
  more: { d: [], circles: [[3.5, 8, 0.7], [8, 8, 0.7], [12.5, 8, 0.7]] },
  home: { d: ["M2.5 7.5L8 3l5.5 4.5V13h-11z"] },
};

export function Icon({ name, size = 14, stroke = 1.5, className, label }: { name: keyof typeof PATHS | string; size?: number; stroke?: number; className?: string; label?: string }) {
  const p = PATHS[name] ?? PATHS.plus;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={p.fill ? "currentColor" : "none"}
      stroke={p.fill ? "none" : "currentColor"}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      {p.d.map((d) => (
        <path key={d} d={d} />
      ))}
      {p.circles?.map(([cx, cy, r]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" />
      ))}
    </svg>
  );
}
