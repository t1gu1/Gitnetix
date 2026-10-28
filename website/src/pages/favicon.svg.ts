import type { APIRoute } from 'astro';
import { logoSvg } from '../../../src/lib/logo';
import { resolveTheme } from '../../../src/lib/themes';

// The logo in the default theme; Base.astro's script redraws it in the theme in use.
export const GET: APIRoute = () => {
  const t = resolveTheme('system', 'dark');
  return new Response(logoSvg(t.accent, t.panel), { headers: { 'Content-Type': 'image/svg+xml' } });
};
