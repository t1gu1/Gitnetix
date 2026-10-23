import type { APIRoute } from 'astro';
import { releases, inline, summary } from '../lib/changelog';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const GET: APIRoute = ({ site }) => {
  const url = (p: string) => new URL(import.meta.env.BASE_URL + p, site).href;
  const items = releases.map((r) => {
    const body = (r.story ? `<p>${esc(r.story)}</p>` : '') +
      r.sections.map((s) => `<h3>${esc(s.label)}</h3><ul>${s.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`).join('');
    return `<item><title>${esc(`Gitnetix ${r.version}: ${r.title}`)}</title><link>${url(`releases/${r.version}/`)}</link><guid>${url(`releases/${r.version}/`)}</guid><pubDate>${new Date(r.date + 'T12:00:00Z').toUTCString()}</pubDate><description>${esc(summary(r))}</description><content:encoded><![CDATA[${body}]]></content:encoded></item>`;
  });
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Gitnetix releases</title><link>${url('releases/')}</link><description>Every Gitnetix release, newest first.</description><language>en</language>${items.join('')}</channel></rss>`,
    { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } },
  );
};
