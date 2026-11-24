import { useId } from 'react';
import { ansi, DEFAULT_THEME, original, THEMES, type Theme } from '../../../src/lib/themes';

/** The app's theme swatch (src/screens/Settings.tsx): its panel, with dots for its text, accent and added / deleted / warning / changed colors. */
function Swatch({ t }: { t: Theme }) {
  const a = ansi(t);
  return (
    <span aria-hidden="true" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 8px)', gap: '3px', padding: '5px', borderRadius: '2px', border: '1px solid var(--line)', background: t.panel }}>
      {[t.fg, t.accent, a[10], a[9], a[11], a[12]].map((c, i) => <i key={i} style={{ width: '8px', height: '8px', borderRadius: '50%', background: c }} />)}
    </span>
  );
}

/** The app's themes, as in its Appearance settings, one swatch each. Static: Base.astro's script saves a click for every page, repaints the site and the demo, and checks the pick in every picker. */
export default function ThemePicker() {
  const id = useId();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div role="radiogroup" aria-label="Theme" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {([['Gitnetix Original themes', THEMES.filter(original)], ['Other popular themes', THEMES.filter((t) => !original(t))]] as const).map(([label, list], i) => (
          <div key={label} role="group" aria-labelledby={`${id}-${i}`} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <p id={`${id}-${i}`} style={{ margin: '0', fontSize: '13px', color: 'var(--faint)' }}>{label}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {/* Unchecked until that script knows the pick, so no wrong ring shows first. */}
              {list.map((t) => <button key={t.id} type="button" className="theme-opt" role="radio" aria-checked="false" aria-label={t.name} data-pick={t.id}><Swatch t={t} /></button>)}
            </div>
          </div>
        ))}
      </div>
      <p style={{ margin: '0', fontSize: '14px', color: 'var(--faint)' }}>Showing <strong data-pick-name style={{ color: 'var(--fg)', fontWeight: '600' }}>{THEMES.find((t) => t.id === DEFAULT_THEME)?.name}</strong></p>
    </div>
  );
}
