import type { APIRoute } from 'astro';
import { resolveTheme } from '../../../src/lib/themes';

// Built from BASE_URL, like robots.txt, so it follows a move to a custom domain.
export const GET: APIRoute = () => {
  const base = import.meta.env.BASE_URL;
  const bg = resolveTheme('system', 'dark').bg;
  return new Response(
    JSON.stringify({
      name: 'Gitnetix',
      short_name: 'Gitnetix',
      description: 'A release-centric Git client: branches as a tree, releases as a button, an agent on every branch.',
      start_url: base,
      scope: base,
      display: 'browser',
      background_color: bg,
      theme_color: bg,
      icons: [
        { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png' },
        { src: `${base}apple-touch-icon.png`, sizes: '180x180', type: 'image/png' },
      ],
    }),
    { headers: { 'Content-Type': 'application/manifest+json' } },
  );
};
