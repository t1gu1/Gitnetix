// Gitnetix's mark: a faceted G on a 64 grid, in one color shaded facet by facet, so it takes each theme's accent.

/** Each facet's corners, and the white (> 0) or black (< 0) laid over it, as an opacity. Light comes from the top left. */
const FACETS: [string, number][] = [
  // upper arm, cut toward the bar
  ["42,8 52,18 45,25.1", 0.15],
  ["42,8 45,25.1 37.9,18", -0.25],
  // top
  ["22,8 42,8 37.9,18", 0.35],
  ["22,8 37.9,18 26.1,18", 0.05],
  // upper left
  ["8,22 22,8 26.1,18", 0.45],
  ["8,22 26.1,18 18,26.1", 0.15],
  // left
  ["8,42 8,22 18,26.1", 0.2],
  ["8,42 18,26.1 18,37.9", -0.1],
  // lower left
  ["22,56 8,42 18,37.9", -0.05],
  ["22,56 18,37.9 26.1,46", -0.3],
  // bottom
  ["42,56 22,56 26.1,46", -0.2],
  ["42,56 26.1,46 37.9,46", -0.4],
  // lower right
  ["56,42 42,56 37.9,46", -0.35],
  ["56,42 37.9,46 44.9,39", -0.15],
  // the bar, a pyramid
  ["33,31 56,31 46,35", 0.3],
  ["56,31 56,42 46,35", -0.1],
  ["56,42 44.9,39 46,35", -0.3],
  ["44.9,39 33,39 46,35", -0.45],
  ["33,39 33,31 46,35", 0.1],
];

/** The mark in `color` on a tile tinted with it: the inside of a `viewBox="0 0 64 64"` svg. */
export const logoBody = (color: string) =>
  `<rect width="64" height="64" rx="14" fill="${color}" fill-opacity=".14"/>` +
  `<g fill="${color}">${FACETS.map(([p]) => `<polygon points="${p}"/>`).join("")}</g>` +
  FACETS.map(([p, s]) => `<polygon points="${p}" fill="${s > 0 ? "#fff" : "#000"}" fill-opacity="${Math.abs(s)}"/>`).join("");

/** The mark as an SVG file, its tile over `panel`: for favicons and the app icons, which can't read the page's colors. */
export const logoSvg = (accent: string, panel: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${panel}"/>${logoBody(accent)}</svg>`;
