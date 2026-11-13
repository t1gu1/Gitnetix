import { useState } from "react";

import { Avatar } from "./Avatar";
import { ContextMenu, SEARCH_ABOVE } from "./ContextMenu";
import { Icon } from "./Icon";

export interface Author {
  /** Lowercased, the first of `emails`: the key authors are told apart by. */
  email: string;
  /** Lowercased, every email this person authored under. */
  emails: string[];
  name: string;
}

/** Everyone who authored one of `items`, once per person: authors sharing an email or a name are merged, named by all their names ("T1Gu1 / Guillaume Huard Hughes"). */
export function authorsOf(items: { author: string; email: string }[]): Author[] {
  const seen = new Set<string>();
  let people: { emails: string[]; names: string[] }[] = [];
  for (const it of items) {
    const email = it.email.toLowerCase();
    if (!email || seen.has(`${email}\n${it.author}`)) continue;
    seen.add(`${email}\n${it.author}`);
    const same = people.filter((p) => p.emails.includes(email) || (!!it.author && p.names.includes(it.author)));
    people = people.filter((p) => !same.includes(p));
    people.push({ emails: [...new Set([...same.flatMap((p) => p.emails), email])], names: [...new Set([...same.flatMap((p) => p.names), it.author])] });
  }
  return people
    .map((p) => {
      const emails = p.emails.sort();
      return { email: emails[0], emails, name: p.names.filter(Boolean).join(" / ") };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Dropdown of checkboxes picking the authors to show (their emails in `who`), every one checked while none is picked.
 * Unchecking one leaves the others checked; unchecking "All" clears the boxes until one is checked, the filter staying
 * as it was. Hidden with fewer than two authors.
 */
export function AuthorFilter({ authors, who, onChange, tip, className = "btn btn-sm" }: { authors: Author[]; who: string[]; onChange: (who: string[]) => void; tip: string; className?: string }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // "All" unchecked: no box shows checked, nothing applied yet.
  const [cleared, setCleared] = useState(false);
  if (authors.length < 2) return null;
  const picked = authors.filter((a) => who.includes(a.email));
  const all = picked.length === 0;
  const on = (a: Author) => !cleared && (all || picked.includes(a));
  const checked = authors.filter(on);
  const pick = (next: Author[]) => {
    setCleared(false);
    onChange(next.length === authors.length ? [] : next.map((a) => a.email));
  };
  return (
    <>
      <button
        className={className}
        style={{ flex: "0 0 auto", maxWidth: 120 }}
        aria-haspopup="menu"
        aria-label="Filter by author"
        data-tip={tip}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.right, y: r.bottom + 2 });
          setCleared(false);
        }}
      >
        <span className="ellipsis">{all ? "All" : picked.length === 1 ? picked[0].name : `${picked.length} authors`}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          label="Filter by author"
          search={authors.length > SEARCH_ABOVE ? "Filter authors" : undefined}
          onClose={() => setMenu(null)}
          items={[
            { id: "all", label: "All", icon: null, checked: all && !cleared, keep: true, run: () => (all && !cleared ? setCleared(true) : pick(authors)) },
            "sep",
            ...authors.map((a) => ({
              id: a.email,
              label: (
                <span className="row" style={{ gap: 8, minWidth: 0, margin: 0, padding: "4px 0" }}>
                  <Avatar name={a.name} email={a.email} size={20} />
                  <span className="col" style={{ minWidth: 0, gap: 0, lineHeight: 1.25 }}>
                    <span className="ellipsis">{a.name}</span>
                    <span className="faint ellipsis" style={{ fontSize: 11 }}>{a.emails.join(", ")}</span>
                  </span>
                </span>
              ),
              text: `${a.name} ${a.emails.join(" ")}`,
              icon: null,
              checked: on(a),
              // The last one checked stays: picking no one would show nothing.
              disabled: on(a) && checked.length === 1,
              why: "Check another author first",
              keep: true,
              run: () => pick(on(a) ? checked.filter((x) => x !== a) : [...checked, a]),
            })),
          ]}
        />
      )}
    </>
  );
}
