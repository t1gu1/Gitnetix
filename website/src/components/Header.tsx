import { REPO, u } from '../lib/changelog';
import { THEMES } from '../../../src/lib/themes';
import { Logo } from '../../../src/components/Logo';
import ThemePicker from './ThemePicker';

export type Page = 'home' | 'releases' | 'download' | 'compare' | 'pricing';

/** [label, href, the page it marks as current] */
const nav = [
  ['The map', u('#map')],
  ['Publish', u('#ship')],
  ['Agents', u('#agents')],
  ['Releases', u('releases/'), 'releases'],
  ['Compare', u('compare/'), 'compare'],
  ['Pricing', u('pricing/'), 'pricing'],
  ['FAQ', u('#faq')],
];

export default function Header({ page }: { page?: Page }) {
  return (
    <header className="site-hdr">
    <nav aria-label="Main" style={{ maxWidth: '1240px', margin: '0 auto', padding: '14px 24px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px 28px' }}>
    <a href={u()} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontWeight: '600', fontSize: '18px', letterSpacing: '-0.01em' }} aria-label="Gitnetix home">
    <Logo size={30} />
    <span>Gitnetix</span>
    </a>
    <div className="muted-links" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 22px', fontSize: '15px', fontWeight: '500', flex: '1 1 auto' }}>
    {nav.map(([label, href, key]) => {
      const on = key !== undefined && key === page;
      return <a key={label} href={href} aria-current={on ? 'page' : undefined} style={on ? { color: 'var(--fg)' } : undefined}>{label}</a>;
    })}
    </div>
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
    {/* a native popover: opens, light-dismisses and closes on Esc without JS; Base.astro's script runs the picks */}
    <button type="button" className="hdr-btn icon" popoverTarget="theme-pop" aria-label="Theme" title="Theme">
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4.5 4H15a2 2 0 0 0-1.5 3.3A1.6 1.6 0 0 1 12 22Z"></path><circle cx="7.5" cy="10.5" r="1"></circle><circle cx="12" cy="7.5" r="1"></circle><circle cx="16.5" cy="10.5" r="1"></circle></svg>
    </button>
    <div id="theme-pop" popover="auto" className="theme-pop" role="dialog" aria-label="Theme">
    <p className="eyebrow" style={{ margin: '0 0 14px' }}>{THEMES.length} themes</p>
    <ThemePicker />
    </div>
    <a className="hdr-btn" href={REPO}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"></path></svg>
    <span>GitHub</span>
    </a>
    <a className="btn-p" href={u('download/')} aria-current={page === 'download' ? 'page' : undefined}>Download</a>
    </div>
    </nav>
    </header>
  );
}
