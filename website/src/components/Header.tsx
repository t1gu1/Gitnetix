import { REPO, u } from '../lib/changelog';

export type Page = 'home' | 'releases' | 'download' | 'compare';

/** [label, href, the page it marks as current] */
const nav = [
  ['The tree', u('#tree')],
  ['Ship', u('#ship')],
  ['Agents', u('#agents')],
  ['Releases', u('releases/'), 'releases'],
  ['Compare', u('compare/'), 'compare'],
  ['FAQ', u('#faq')],
];

export default function Header({ page }: { page?: Page }) {
  return (
    <header className="site-hdr">
    <nav aria-label="Main" style={{ maxWidth: '1240px', margin: '0 auto', padding: '16px 24px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px 28px' }}>
    <a href={u()} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontWeight: '700', fontSize: '19px', letterSpacing: '-0.01em' }} aria-label="Gitnetix home">
    <img src={u('favicon.png')} alt="" width="32" height="32" style={{ width: '32px', height: '32px', borderRadius: '8px' }} />
    <span>Gitnetix</span>
    </a>
    <div className="muted-links" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 22px', fontSize: '15px', flex: '1 1 auto' }}>
    {nav.map(([label, href, key]) => {
      const on = key !== undefined && key === page;
      return <a key={label} href={href} aria-current={on ? 'page' : undefined} style={on ? { color: 'var(--fg)', fontWeight: 600 } : undefined}>{label}</a>;
    })}
    </div>
    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
    <a className="btn-s" href={REPO} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', padding: '9px 14px', border: '1px solid var(--line)', borderRadius: '10px', minHeight: '24px' }}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"></path></svg>
    <span>GitHub</span>
    </a>
    <a className="btn-p" href={u('download/')} aria-current={page === 'download' ? 'page' : undefined} style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: '600', fontSize: '14px', padding: '10px 16px', borderRadius: '10px' }}>Download</a>
    </div>
    </nav>
    </header>
  );
}
