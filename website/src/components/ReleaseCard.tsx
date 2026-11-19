import { REPO, inline, slug, u, type Release } from '../lib/changelog';

/** Hue only where the kind means it: added, removed (and security), deprecated; the rest stay neutral. */
const COLORS: Record<string, string> = {
  Added: 'var(--add)', Removed: 'var(--del)', Security: 'var(--del)', Deprecated: 'var(--warn)',
};

type Props = { r: Release; latest: boolean; heading: 'h1' | 'h2' };

/** A section's kind: "Added (App)" is an Added section of the App project. */
const kind = (label: string) => label.split(' (')[0];

/** One release: story, highlights and the full changelog section. */
export default function ReleaseCard({ r, latest, heading: H }: Props) {
  const big = r.story && r.highlights.length > 0;
  const id = slug(r.version);
  const page = u(`releases/${r.version}/`);
  const counts = new Map<string, number>();
  for (const s of r.sections) counts.set(kind(s.label), (counts.get(kind(s.label)) ?? 0) + s.items.length);
  return (
    <article aria-labelledby={`${id}-h`} style={{ minWidth: 0, background: 'var(--panel)', border: `1px solid ${latest ? 'var(--line2)' : 'var(--line)'}`, borderRadius: '3px', padding: 'clamp(20px, 3vw, 32px)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <H id={`${id}-h`} className={H === 'h1' ? 'display' : undefined} style={H === 'h1' ? { fontSize: 'clamp(40px, 5vw, 64px)' } : { margin: 0, fontSize: big ? 'clamp(24px, 2.6vw, 30px)' : '21px', fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.015em', textWrap: 'balance' }}>
        {H === 'h1' ? r.title : <a href={page}>{r.title}</a>}
      </H>
      {r.story && <p style={{ margin: 0, color: 'var(--muted)', fontSize: '17px', maxWidth: '760px', textWrap: 'pretty' }}>{r.story}</p>}
      {r.highlights.length > 0 && (
        <ul aria-label="Highlights" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {r.highlights.map((h) => (
            <li key={h} className="chip">{h}</li>
          ))}
        </ul>
      )}
      <div style={{ borderTop: '1px solid var(--line)', paddingTop: '4px' }}>
        <p style={{ margin: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 16px', padding: '12px 0', fontSize: '15px', color: 'var(--muted)' }}>
          <span style={{ color: 'var(--fg)', fontWeight: 500 }}>{r.count === 1 ? '1 change' : `All ${r.count} changes`}</span>
          {[...counts].map(([k, n]) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span aria-hidden="true" style={{ width: '7px', height: '7px', borderRadius: '50%', background: COLORS[k] ?? 'var(--muted)' }}></span>
              {n} {k.toLowerCase()}
            </span>
          ))}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', padding: '8px 0 6px' }}>
          {r.sections.map((s) => (
            <section key={s.label} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <h3 style={{ margin: 0, fontSize: '12px', letterSpacing: '.14em', fontWeight: 600, textTransform: 'uppercase', color: COLORS[kind(s.label)] ?? 'var(--muted)' }}>{s.label}</h3>
              <ul style={{ margin: 0, padding: 0, columns: '320px 2', columnGap: '40px', fontSize: '15px', color: 'var(--muted)' }}>
                {s.items.map((it, i) => <li key={i} style={{ marginLeft: '18px', paddingBottom: '6px', breakInside: 'avoid' }} dangerouslySetInnerHTML={{ __html: inline(it) }} />)}
              </ul>
            </section>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', fontSize: '14px' }}>
        <a href={`${REPO}/releases/tag/v${r.version}`} style={{ fontWeight: 600, display: 'flex', alignItems: 'center', minHeight: '32px' }}>Download v{r.version} →</a>
        {H === 'h2' && <a className="faint" href={page} style={{ display: 'flex', alignItems: 'center', minHeight: '32px' }}>Release page</a>}
      </div>
    </article>
  );
}
