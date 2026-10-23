import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import stories from '../data/stories.json';

export const REPO = 'https://github.com/t1gu1/Gitnetix';

/** A site path under the GitHub Pages base. */
export const u = (p = '') => import.meta.env.BASE_URL + p;

export type Section = { label: string; items: string[] };
export type Release = {
  version: string;
  date: string;
  title: string;
  story: string;
  highlights: string[];
  sections: Section[];
  count: number;
};

type Story = { title: string; story?: string; highlights?: string[] };

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline markdown of a changelog line (code, bold, links) to HTML. */
export const inline = (s: string) =>
  escape(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');

export const plain = (s: string) =>
  s.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

/** First sentence of a line, cut at a word boundary: a title for releases without a story. */
const headline = (s: string) => {
  const t = plain(s).split(/(?<=\.)\s/)[0].replace(/\.$/, '');
  return t.length <= 70 ? t : t.slice(0, t.lastIndexOf(' ', 67)) + '…';
};

function parse(md: string): Release[] {
  const out: Release[] = [];
  let cur: Release | null = null;
  for (const line of md.split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^## \[(\d[^\]]*)\] - (\d{4}-\d{2}-\d{2})/))) {
      const s = (stories as Record<string, Story>)[m[1]];
      cur = { version: m[1], date: m[2], title: s?.title ?? '', story: s?.story ?? '', highlights: s?.highlights ?? [], sections: [], count: 0 };
      out.push(cur);
    } else if (line.startsWith('## ')) cur = null; // Unreleased, or anything undated
    else if (!cur) continue;
    else if ((m = line.match(/^### (.+)/))) cur.sections.push({ label: m[1].trim(), items: [] });
    else if ((m = line.match(/^[-*] (.+)/))) cur.sections.at(-1)?.items.push(m[1]);
    else if (/^\s+\S/.test(line) && cur.sections.at(-1)?.items.length) {
      const items = cur.sections.at(-1)!.items;
      items[items.length - 1] += ' ' + line.trim();
    }
  }
  for (const r of out) {
    r.sections = r.sections.filter((s) => s.items.length);
    r.count = r.sections.reduce((n, s) => n + s.items.length, 0);
    r.title ||= r.sections[0] ? headline(r.sections[0].items[0]) : `Gitnetix ${r.version}`;
  }
  return out;
}

// The build runs from website/, the changelog sits at the repo root.
export const releases = parse(readFileSync(resolve('../CHANGELOG.md'), 'utf8'));
if (!releases.length) throw new Error('CHANGELOG.md has no dated release sections');

export const slug = (v: string) => 'v' + v.replace(/\./g, '-');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortDate = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return `${MONTHS[m - 1]} ${day}, ${y}`;
};
export const longDate = (d: string) =>
  new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** One-line summary of a release, for meta descriptions and feeds. */
export const summary = (r: Release) =>
  r.story || r.sections.flatMap((s) => s.items).slice(0, 3).map(plain).join(' ');

export type Download = { id: 'macos' | 'windows' | 'linux'; name: string; ext: string; file: string; url: string; desc: string };

let latest: Promise<{ version: string; downloads: Download[] }> | undefined;

/**
 * The newest published GitHub release, so download links work even when a tag was
 * pushed without a changelog section. Falls back to the newest changelog version offline.
 */
export function latestRelease() {
  return (latest ??= (async () => {
    let version = releases[0].version;
    try {
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const res = await fetch('https://api.github.com/repos/t1gu1/Gitnetix/releases/latest', { headers });
      if (res.ok) version = ((await res.json()) as { tag_name: string }).tag_name.replace(/^v/, '');
    } catch {
      // offline build: keep the changelog version
    }
    // File names match what .github/workflows/release.yml uploads.
    const dl = (id: Download['id'], name: string, ext: string, file: string, desc: string): Download => ({
      id, name, ext, file, desc, url: `${REPO}/releases/download/v${version}/${file}`,
    });
    return {
      version,
      downloads: [
        dl('macos', 'macOS', '.dmg', `Gitnetix_${version}_universal.dmg`, 'One universal build for Apple Silicon and Intel Macs. Drag to Applications.'),
        dl('windows', 'Windows', '-setup.exe', `Gitnetix_${version}_x64-setup.exe`, 'A standard installer. Run it, and Gitnetix keeps itself up to date.'),
        dl('linux', 'Linux', '.AppImage', `Gitnetix_${version}_amd64.AppImage`, 'A single AppImage. Make it executable and run it, no install step.'),
      ],
    };
  })());
}
