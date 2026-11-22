import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useAction, useAiCatalog, useAiModels, useConfig } from "../api/hooks";
import { isLocal } from "../api/transport";
import { Icon } from "../components/Icon";
import { PageTools, SheetBox, SheetLink, SheetRow, SheetSwitch } from "../components/Sheet";
import { Seg } from "../components/ui";
import { BUILT_IN, comboOf, DEFAULTS, keyCaps, SHORTCUTS, showKeys, usedBy, useKeys, useSetKeys } from "../lib/keys";
import { ANIMATIONS, useAnimations } from "../lib/motion";
import { useNav } from "../lib/nav";
import { ansi, original, otherMode, resolveTheme, THEMES, type Theme } from "../lib/themes";

/** App settings by group: id, label, icon. Their labels title the pages the settings sheet opens. */
export const GROUPS: [string, [string, string, string][]][] = [
  ["General", [["appearance", "Appearance", "brush"], ["animations", "Animations", "play"], ["terminal", "Terminal", "terminal"], ["worktrees", "Worktrees", "layers"], ["dictation", "Voice dictation", "mic"], ["shortcuts", "Shortcuts", "keyboard"]]],
  ["AI", [["ai", "AI setup", "sparkle"], ["templates", "Templates", "edit"]]],
  ["Git", [["git", "Git providers", "pr"]]],
  ["Integrations", [["tools", "Jira, Trello, Asana, Linear", "ticket"], ["companion", "Companion & MCP", "phone"]]],
];

/** Appearance: the theme on screen drawn large, with its name and mode, then every theme drawn as the app in its own colours. A pick applies at once. */
export function Appearance() {
  const nav = useNav();
  const [search, setSearch] = useState("");
  const shown = resolveTheme(nav.themePref, nav.theme);
  const system = nav.themePref === "system";
  // Dark and Light move within the shown theme's family, like the light / dark toggle.
  const setMode = (m: string) => nav.setThemePref(m === "system" ? "system" : (m === "light") === shown.light ? shown.id : otherMode(shown));
  const term = search.trim().toLowerCase();
  const list = THEMES.filter((t) => !term || t.name.toLowerCase().includes(term));
  return (
    <>
      <section className="thm-hero" aria-label="Theme on screen">
        <ThemePreview t={shown} />
        <div className="thm-now">
          <h2 className="thm-name">{shown.name}</h2>
          <p className="hint">For every project. System follows your computer's light or dark mode, in Gitnetix Black &amp; White or its light version.</p>
          <div className="thm-mode">
            <Seg label="Mode" value={system ? "system" : shown.light ? "light" : "dark"} onChange={setMode} options={[{ value: "system", label: "System" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
            <span className="hint">Dark and Light pick this theme's other version, or Black &amp; White's when it has none.</span>
          </div>
        </div>
      </section>
      <div className="thm-bar">
        <h3 className="label">All themes</h3>
        <label className="thm-search">
          <Icon name="search" size={12} />
          <input className="input" type="search" data-no-mic placeholder="Search" aria-label="Search themes" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>
      <div role="radiogroup" aria-label="Theme" className="thm-tiles">
        {list.map((t) => (
          <button key={t.id} className="thm-tile" role="radio" aria-checked={t.id === shown.id} onClick={() => nav.setThemePref(t.id)}>
            <ThemePreview t={t} />
            <span className="thm-tile-name">
              {t.id === shown.id && <Icon name="check" size={12} />}
              <span className="ellipsis">{t.name}</span>
            </span>
          </button>
        ))}
        {!list.length && <p className="hint">No theme matches “{search.trim()}”.</p>}
      </div>
    </>
  );
}

/** The app in small, in a theme's colours: its tab bar, a branch line with two stops, and a box with its rows, an added line and the accent button. */
function ThemePreview({ t }: { t: Theme }) {
  const style = { "--tb": t.bg, "--tp": t.panel, "--tf": t.fg, "--ta": t.accent, "--tadd": ansi(t)[10] } as CSSProperties;
  return (
    <span className="thm-pv" style={style} aria-hidden="true">
      <span className="thm-pv-top">
        <b />
        <b />
        <b />
      </span>
      <span className="thm-pv-body">
        <span className="thm-pv-map">
          <i className="thm-pv-ln" />
          <i className="thm-pv-ln2" />
          <i className="thm-pv-st" style={{ top: "14%" }} />
          <i className="thm-pv-lab" style={{ top: "15%" }} />
          <i className="thm-pv-st" style={{ top: "52%" }} />
          <i className="thm-pv-lab" style={{ top: "53%", width: "30%" }} />
          <i className="thm-pv-lab dim" style={{ top: "63%", width: "20%" }} />
        </span>
        <span className="thm-pv-box">
          <i />
          <i />
          <i />
          <i className="thm-pv-add" />
          <u />
        </span>
      </span>
    </span>
  );
}

/** Every theme with its colors, System first; a pick applies at once. Also the first step of the first-run setup. */
export function ThemeChoices() {
  const nav = useNav();
  const card = (id: string, label: string, preview: ReactNode) => (
    <button key={id} className="radio-card" role="radio" aria-checked={nav.themePref === id} style={{ alignItems: "center" }} onClick={() => nav.setThemePref(id)}>
      {preview}
      <span>{label}</span>
    </button>
  );
  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 };
  return (
    <div role="radiogroup" aria-label="Theme" className="col" style={{ gap: 20 }}>
      <section className="section">
        <h2>Gitnetix original</h2>
        <div style={grid}>
          {card(
            "system",
            "System",
            <span className="row" style={{ gap: 4, margin: 0 }}>
              {(["dark", "light"] as const).map((m) => <Swatch key={m} t={resolveTheme("system", m)} />)}
            </span>,
          )}
          {THEMES.filter(original).map((t) => card(t.id, t.name, <Swatch t={t} />))}
        </div>
      </section>
      <section className="section">
        <h2>More themes</h2>
        <div style={grid}>{THEMES.filter((t) => !original(t)).map((t) => card(t.id, t.name, <Swatch t={t} />))}</div>
      </section>
    </div>
  );
}

/** A theme in small: its panel, with dots for its text, accent and added / deleted / warning / changed colors. */
function Swatch({ t }: { t: Theme }) {
  const a = ansi(t);
  return (
    <span aria-hidden="true" style={{ display: "grid", gridTemplateColumns: "repeat(3, 8px)", gap: 3, padding: 5, flex: "none", borderRadius: "var(--r-sm)", border: "1px solid var(--line)", background: t.panel }}>
      {[t.fg, t.accent, a[10], a[9], a[11], a[12]].map((c, i) => (
        <i key={i} style={{ width: 8, height: 8, borderRadius: 4, background: c }} />
      ))}
    </span>
  );
}

/** Each animation acted out in small, by id: shapes standing for the part of the app that moves. */
const DEMOS: Record<string, ReactNode> = {
  path: <i className="anim-d-line" />,
  shine: (
    <span className="anim-d-name">
      <span className="mono">feat/undo-stack</span>
    </span>
  ),
  nudge: (
    <span className="anim-d-push">
      <span className="anim-d-btn">
        <Icon name="push" size={12} />
        Push 2
      </span>
    </span>
  ),
  wip: (
    <span className="anim-d-wip">
      <span>WIP 3</span>
    </span>
  ),
  activity: (
    <span className="anim-d-act">
      <i />
      Agent working
    </span>
  ),
  tabs: (
    <span className="anim-d-tabs">
      <b />
      <b />
      <b />
    </span>
  ),
  menu: <i className="anim-d-menu" />,
  pages: (
    <span className="anim-d-page">
      <b />
      <b />
      <b />
      <b />
    </span>
  ),
  lists: (
    <span className="anim-d-list">
      <b />
      <b />
      <b />
      <b />
    </span>
  ),
  dialogs: <i className="anim-d-dialog" />,
  minimize: <i className="anim-d-min" />,
  panes: (
    <span className="anim-d-panes">
      <b />
      <b />
    </span>
  ),
  seg: (
    <span className="anim-d-hl">
      <span>Workspace</span>
      <span>Tickets</span>
      <span>Releases</span>
    </span>
  ),
  tooltips: (
    <span className="anim-d-tip">
      <span>Copy the path</span>
      <b />
    </span>
  ),
  chevrons: (
    <span className="anim-d-fold">
      <Icon name="chevronRight" size={12} />3 commits
    </span>
  ),
  wave: (
    <span className="anim-d-wave">
      {Array.from({ length: 9 }, (_, i) => (
        <b key={i} />
      ))}
    </span>
  ),
};

/** Every animation playing in its own small stage, with its switch: a turned-off one stops and fades, so the page shows what you get. */
export function Animations() {
  const { off, toggle, setAll } = useAnimations();
  return (
    <>
      <div className="anim-bar">
        <p className="hint">For every project. With reduced motion on in your system settings, they all stay off.</p>
        <button className="btn" disabled={off.length === 0} onClick={() => setAll(true)}>Turn all on</button>
        <button className="btn" disabled={off.length === ANIMATIONS.length} onClick={() => setAll(false)}>Turn all off</button>
      </div>
      <div className="anim-grid">
        {ANIMATIONS.map((a) => {
          const on = !off.includes(a.id);
          return (
            <label key={a.id} className={`anim-card${on ? "" : " off"}`} data-tip={a.hint}>
              <span className="anim-stage" aria-hidden="true">
                {DEMOS[a.id]}
              </span>
              <span className="anim-row">
                <span className="anim-name">{a.label}</span>
                <input type="checkbox" role="switch" className="switch" aria-label={a.label} checked={on} onChange={() => toggle(a.id)} />
              </span>
              <span className="anim-hint">{a.hint}</span>
            </label>
          );
        })}
      </div>
    </>
  );
}

/** Voice dictation: how you dictate (shortcut, AI rewrite and what leaves the computer), then the speech model it runs. */
/** `open`: opens AI setup, where the AI that rewrites is picked. */
export function DictationSection({ open }: { open: (id: string) => void }) {
  const ui = useConfig().data?.ui;
  const polish = ui?.dictationPolish ?? true;
  const setUi = useAction("ui.set", { invalidate: [["config"]] });
  // The AI the "Voice dictation" task runs on: its route's, else the default, as the backend picks it.
  const ai = useAiCatalog().data;
  const route = ai?.routing.dictation;
  const provider = ai?.providers.find((p) => p.info.id === (route?.provider || ai.defaultProvider));
  const modelId = route?.model || provider?.conf?.model;
  const model = useAiModels(provider?.conf ? provider.info.id : undefined).data?.find((m) => m.id === modelId);
  const rewriter = provider?.conf ? (model ? `${provider.info.name} · ${model.label}` : provider.info.name) : "No AI set up";
  return (
    <>
      <p className="hint dict-lead">Speak into any text box. Press the shortcut or click the mic at the right of the box to start listening, then press either again or Stop to put the words in.</p>
      <div className="dict-grid">
        <SheetBox title="Dictating" sub="every project">
          <div className="sheet-col">
            <SheetRow label="Shortcut" tip="Click it, then press the new keys. They need Ctrl, Alt or ⌘. Esc keeps the current one.">
              <KeysButton id="dictation" />
            </SheetRow>
            <SheetSwitch
              label="Rewrite with AI"
              tip="AI turns what you said into clear, structured text, and fixes misheard names with the project's files, branch, ticket and recent commits. Sends the words and that context to the AI set for “Voice dictation” in AI setup (Ollama stays on this computer). Skipped when no AI is set up."
              on={polish}
              flip={() => setUi.mutate({ dictationPolish: !polish })}
            />
            <SheetLink label="AI that rewrites" tip="The AI set for “Voice dictation” in AI setup" value={rewriter} none={!provider?.conf} onClick={() => open("ai")} />
            <SheetRow label="Leaves the computer" tip="Without Rewrite with AI, nothing you say leaves the computer">
              <span className="sheet-v">{polish && provider?.conf && !provider.info.local ? "Your words, to rewrite them" : "Nothing"}</span>
            </SheetRow>
          </div>
        </SheetBox>
        <SheetBox title="Speech model" sub="on this computer">
          <div className="sheet-col">
            <SheetRow label="Model">
              <span className="sheet-v">Parakeet Ultra</span>
            </SheetRow>
            <SheetRow label="Languages" tip="English, French and 23 more European languages, even mixed in one sentence">
              <span className="sheet-v">English, French + 23 more</span>
            </SheetRow>
            <SheetRow label="Download" tip="The first dictation downloads the speech model">
              <span className="sheet-v">740 MB, the first time</span>
            </SheetRow>
            <SheetRow label="From">
              <span className="sheet-v">Hugging Face</span>
            </SheetRow>
          </div>
        </SheetBox>
      </div>
      <p className="hint dict-credit">
        Parakeet Ultra by Moondream, built on NVIDIA Parakeet TDT 0.6B v3, both under CC BY 4.0 (<span className="mono">creativecommons.org/licenses/by/4.0</span>), quantized to 8 bits for transcribe.cpp.
      </p>
    </>
  );
}

/** The dictation shortcut as a list row: click it, then press the new keys. Also in the first-run setup. */
export function DictationKeys() {
  return (
    <li className="list-row">
      <span className="col grow" style={{ gap: 2 }}>
        <span style={{ fontWeight: 500 }}>Shortcut</span>
        <span className="hint">Click it, then press the new keys. They need Ctrl, Alt or ⌘. Esc keeps the current one.</span>
      </span>
      <KeysButton id="dictation" />
    </li>
  );
}

/** A shortcut as key caps. */
export function Keys({ keys }: { keys: string }) {
  return (
    <span className="keys">
      {keyCaps(keys).map((k, i) => (
        <kbd key={i} className={/^\W$/.test(k) ? "keys-sym" : undefined}>
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** Shortcut `id`'s keys: click them, then press the new ones. Keys another shortcut has are refused, and Reset shows once changed. */
function KeysButton({ id }: { id: string }) {
  const keys = useKeys();
  const setKeys = useSetKeys();
  const [picking, setPicking] = useState(false);
  // What has the keys just pressed, while it keeps listening for others.
  const [taken, setTaken] = useState("");
  const label = SHORTCUTS.find((s) => s.id === id)?.label;
  const btn = useRef<HTMLButtonElement>(null);
  // Focused by hand: WebKit doesn't focus clicked buttons, and the keys must come here.
  const listen = (why = "") => {
    btn.current?.focus();
    setPicking(true);
    setTaken(why);
  };
  const stop = () => {
    setPicking(false);
    setTaken("");
  };
  // Another shortcut may have taken the default since: then Reset says so and listens for other keys instead.
  const reset = () => {
    const by = usedBy(DEFAULTS[id], id, keys);
    if (by) listen(`${showKeys(DEFAULTS[id])} is ${by}`);
    else setKeys(id, "");
  };
  return (
    <>
      {keys[id] !== DEFAULTS[id] && (
        <button className="btn btn-ghost btn-icon btn-sm keys-reset" aria-label={`Reset ${label} to ${showKeys(DEFAULTS[id])}`} data-tip={`Back to ${showKeys(DEFAULTS[id])}`} onClick={reset}>
          <Icon name="undo" size={12} />
        </button>
      )}
      <button
        ref={btn}
        data-keys-input
        className="keys-input"
        aria-pressed={picking}
        aria-label={picking ? taken || `Press the new keys for ${label}` : `${label}: ${showKeys(keys[id])}. Press to change`}
        onClick={() => listen()}
        onBlur={stop}
        onKeyDown={(e) => {
          if (!picking) return;
          // Kept here: Esc would also close the menu this can sit in.
          if (e.key === "Escape") {
            e.stopPropagation();
            return stop();
          }
          const combo = comboOf(e.nativeEvent);
          if (!combo) return;
          e.preventDefault();
          const by = usedBy(combo, id, keys);
          if (by) return setTaken(`${showKeys(combo)} is ${by}`);
          setKeys(id, combo);
          stop();
        }}
      >
        {picking ? (
          <span className={taken ? "keys-taken" : "keys-wait"}>
            {taken || (
              <>
                Press the new keys <span className="faint">Esc keeps {showKeys(keys[id])}</span>
              </>
            )}
          </span>
        ) : (
          <Keys keys={keys[id]} />
        )}
      </button>
    </>
  );
}

/** Every shortcut in a box per group, its keys at the right of its short name, changed in place; then the keys the app keeps as they are. */
export function ShortcutsSection() {
  const keys = useKeys();
  const setKeys = useSetKeys();
  const changed = SHORTCUTS.filter((s) => keys[s.id] !== DEFAULTS[s.id]);
  // Zoom is the desktop app's: a browser has its own.
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))].filter((g) => isLocal || g !== "Window");
  const box = (g: string) => (
    <SheetBox key={g} title={g}>
      <div className="sheet-col">
        {SHORTCUTS.filter((s) => s.group === g).map((s) => (
          <SheetRow key={s.id} label={s.label} tip={s.hint} className={keys[s.id] !== DEFAULTS[s.id] ? "kbs-changed" : undefined}>
            <KeysButton id={s.id} />
          </SheetRow>
        ))}
      </div>
    </SheetBox>
  );
  return (
    <>
      <div className="kbs-top">
        <p className="hint">For every project. Click a shortcut, then press the new keys: they need Ctrl, Alt or ⌘. Esc keeps the one it has.</p>
        <PageTools>
          <button className="btn btn-sm" disabled={!changed.length} onClick={() => changed.forEach((s) => setKeys(s.id, ""))}>
            <Icon name="undo" size={12} />
            Reset all
          </button>
        </PageTools>
      </div>
      <div className="kbs-grid">
        <div className="kbs-stack">
          {groups.slice(0, 2).map(box)}
          <p className="hint kbs-note">
            <Icon name="terminal" size={12} />
            <span>In a terminal, Ctrl or Alt with a letter stays the shell's, like Ctrl+W to delete a word: add Shift to use such a shortcut from there. In a text box, the arrows move the caret.</span>
          </p>
        </div>
        <div className="kbs-stack">
          {groups.slice(2).map(box)}
          <SheetBox title="Built in" sub="can't be changed">
            <div className="sheet-col">
              {BUILT_IN.map((b) => (
                <SheetRow key={b.label} label={b.label} tip={b.hint} className="kbs-lock">
                  <Keys keys={b.keys} />
                </SheetRow>
              ))}
            </div>
          </SheetBox>
        </div>
      </div>
    </>
  );
}
