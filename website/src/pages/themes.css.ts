import type { APIRoute } from 'astro';
import { THEMES, tokens } from '../../../src/lib/themes';

const vars = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `--${k}:${v}`).join(';');

// The app's themes (src/lib/themes.ts), switched on by Base.astro's data-palette: site.css's tokens on the page, app.css's on the demo (.hd).
// Gitnetix Dark / Light keep site.css's own colors, as the app keeps app.css's. html[…] outranks site.css's [data-theme=light] rules.
export const GET: APIRoute = () => {
  const css = THEMES.filter((t) => t.family !== 'Gitnetix').map((t) => {
    const a = tokens(t);
    const site = {
      bg: a.bg, panel: a.panel, raised: a.raised, chip: a.sel, line: a.line, rail: `color-mix(in srgb, ${t.fg} 20%, ${t.panel})`,
      fg: a.fg, muted: a.muted, faint: a.faint, accent: a.accent, 'accent-ink': a['on-accent'], 'accent-fg': a['accent-fg'],
      trunk: a['trunk-fg'], release: a['release-fg'], add: a['add-fg'], warn: a['warn-fg'], work: a['mod-fg'], del: a['del-fg'], term: a.term,
    };
    return `html[data-palette="${t.id}"]{${vars(site)}}\nhtml[data-palette="${t.id}"] .hd{${vars(a)}}`;
  });
  return new Response(css.join('\n'), { headers: { 'Content-Type': 'text/css' } });
};
