import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { MenuChoice } from "./AgentPicker";
import { Icon } from "./Icon";

/* The settings sheet's pieces: boxes of short-label rows, each a value, a switch, or the arrow of a page. The settings panel's home and its pages share them. */

/**
 * A short label, the full sentence when it leaves words out: shown on hover and on the row's keyboard focus, under the label on a touch screen.
 * `restates`: the sentence only repeats the label in more words, so a touch screen leaves it out.
 */
export function SheetKey({ label, tip, restates }: { label: string; tip?: string; restates?: boolean }) {
  return (
    <span className="sheet-k" data-tip-overflow={tip ? undefined : ""}>
      {label}
      {tip && !restates && <span className="sheet-tip">{tip}</span>}
    </span>
  );
}

/** A path under the user's home folder starts with ~. */
export const tilde = (path: string) => path.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/, "~");

/** A box of settings for one scope: this project, the app, AI and connections. */
export function SheetBox({ title, sub, path, aside, className = "", children }: { title: string; sub?: ReactNode; path?: string; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`sheet-box ${className}`} aria-label={title}>
      <header className="sheet-h">
        <h2 className="ellipsis">{title}</h2>
        {sub && <span className="hint">{sub}</span>}
        {/* Cut from its start: the end of a path names the project. */}
        {path && (
          <span className="mono faint sheet-path" title={path}>
            <bdi>{tilde(path)}</bdi>
          </span>
        )}
        {/* The box's own actions, at the right of its title. */}
        {aside && <span className="sheet-aside">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

/** A group's name; `tip` says what its settings do, on hover and keyboard focus, under the name on a touch screen. */
export function SheetLabel({ children, tip }: { children: ReactNode; tip?: string }) {
  return (
    <>
      <h3 className="label sheet-lab" data-tip={tip} tabIndex={tip ? 0 : undefined}>
        {children}
      </h3>
      {tip && <p className="hint sheet-lab-tip">{tip}</p>}
    </>
  );
}

/** On or off, flipped in place: the whole row is the switch's label. */
export function SheetSwitch({ label, tip, restates, on, flip, disabled }: { label: string; tip?: string; restates?: boolean; on: boolean; flip: () => void; disabled?: boolean }) {
  return (
    <label className="sheet-row" data-tip={tip}>
      <SheetKey label={label} tip={tip} restates={restates} />
      <input type="checkbox" role="switch" className="switch" aria-label={tip ?? label} checked={on} disabled={disabled} onChange={flip} />
    </label>
  );
}

/** One of a few values, picked from a menu under it. */
export function SheetChoice({ label, tip, restates, value, options, onChange, sub, mono }: { label: string; tip?: string; restates?: boolean; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; sub?: boolean; mono?: boolean }) {
  return (
    <div className={`sheet-row${sub ? " sub" : ""}`} data-tip={tip}>
      <SheetKey label={label} tip={tip} restates={restates} />
      <MenuChoice className={`sheet-val${mono && value === "branch" ? " mono" : ""}`} alignRight label={tip ?? label} value={value} options={options} onChange={onChange} />
    </div>
  );
}

/** A setting with a page of its own, opened in place: its current value, and the arrow of a row that opens. */
export function SheetLink({ label, tip, restates, value, mono, none, onClick }: { label: string; tip?: string; restates?: boolean; value?: ReactNode; mono?: boolean; none?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="sheet-row sheet-link" data-tip={tip} onClick={onClick}>
      <SheetKey label={label} tip={tip} restates={restates} />
      {value != null && <span className={`sheet-v${mono ? " mono" : ""}${none ? " none" : ""}`}>{value}</span>}
      <Icon name="chevronRight" size={12} />
    </button>
  );
}

/** A setting whose right side is its own: key caps, a status, buttons. */
export function SheetRow({ label, tip, restates, className = "", children }: { label: string; tip?: string; restates?: boolean; className?: string; children?: ReactNode }) {
  return (
    <div className={`sheet-row ${className}`} data-tip={tip}>
      <SheetKey label={label} tip={tip} restates={restates} />
      {children}
    </div>
  );
}

/** Where a settings page puts its own actions: the panel header, at its right. Menu.tsx provides it. */
export const PageToolsSlot = createContext<HTMLElement | null>(null);

/** A page's own actions (Reset all, Copy all…), shown in the panel header beside its title. */
export function PageTools({ children }: { children: ReactNode }) {
  const slot = useContext(PageToolsSlot);
  return slot ? createPortal(children, slot) : null;
}
