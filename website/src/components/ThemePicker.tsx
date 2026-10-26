import { ansi, THEMES, type Theme } from '../../../src/lib/themes';

/** The app's theme swatch (src/screens/Settings.tsx): its panel, with dots for its text, accent and added / deleted / warning / changed colors. */
function Swatch({ t }: { t: Theme }) {
  const a = ansi(t);
  return (
    <span aria-hidden="true" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 8px)', gap: '3px', padding: '5px', borderRadius: '4px', border: '1px solid var(--line)', background: t.panel }}>
      {[t.fg, t.accent, a[10], a[9], a[11], a[12]].map((c, i) => <i key={i} style={{ width: '8px', height: '8px', borderRadius: '4px', background: c }} />)}
    </span>
  );
}

/** The app's themes, as in its Appearance settings, one swatch each. Static: Base.astro's script saves a click for every page, repaints the site and the demo, and checks the pick in every picker. */
export default function ThemePicker() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div role="radiogroup" aria-label="Theme" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {/* Unchecked until that script knows the pick, so no wrong ring shows first. */}
        {THEMES.map((t) => <button key={t.id} type="button" className="theme-opt" role="radio" aria-checked="false" aria-label={t.name} data-pick={t.id}><Swatch t={t} /></button>)}
      </div>
      <p style={{ margin: '0', fontSize: '14px', color: 'var(--faint)' }}>Showing <strong data-pick-name style={{ color: 'var(--fg)', fontWeight: '600' }}>Gitnetix Dark</strong></p>
    </div>
  );
}
