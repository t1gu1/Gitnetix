import type { APIRoute } from 'astro';
import { THEMES, tokens } from '../../../src/lib/themes';

const vars = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `--${k}:${v}`).join(';');

// The app's themes (src/lib/themes.ts), switched on by Base.astro's data-palette: site.css's tokens on the page, app.css's on the demo (.hd).
// Gitnetix Dark / Light keep site.css's own colors, as the app keeps app.css's. html[…] outranks site.css's [data-theme=light] rules.
export const GET: APIRoute = () => {
  const css = THEMES.filter((t) => t.family !== 'Gitnetix').map((t) => {
    const a = tokens(t);
    // The redesign's steps a theme doesn't set are mixed from its ink, as app.css does.
    const site = {
      bg: a.bg, panel: a.panel, raised: a.raised, chip: a.sel, line: a.line, line2: a.line2 ?? `color-mix(in srgb, ${t.fg} 17%, ${t.panel})`,
      link: a.link ?? `color-mix(in srgb, ${t.fg} 22%, ${t.bg})`, ground: a.ground ?? `color-mix(in srgb, ${t.fg} 3%, ${t.bg})`,
      fg: a.fg, muted: a.muted, faint: a.faint, accent: a.accent, 'accent-ink': a['on-accent'], 'accent-fg': a['accent-fg'],
      add: a['add-fg'], warn: a['warn-fg'], del: a['del-fg'], term: a.term,
    };
    return `html[data-palette="${t.id}"]{${vars(site)}}\nhtml[data-palette="${t.id}"] .hd{${vars(a)}}`;
  });
  return new Response(css.join('\n'), { headers: { 'Content-Type': 'text/css' } });
};
