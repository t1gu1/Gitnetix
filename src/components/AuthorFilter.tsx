import { useState } from "react";

import { Avatar } from "./Avatar";
import { ContextMenu } from "./ContextMenu";
import { Icon } from "./Icon";

export interface Author {
  /** Lowercased: the key authors are told apart by. */
  email: string;
  name: string;
}

/** Everyone who authored one of `items`, once per email, by name. */
export function authorsOf(items: { author: string; email: string }[]): Author[] {
  const by = new Map<string, string>();
  for (const it of items) if (it.email && !by.has(it.email.toLowerCase())) by.set(it.email.toLowerCase(), it.author);
  return [...by].map(([email, name]) => ({ email, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Dropdown picking the authors to show (their emails in `who`); none picked = all. Hidden with fewer than two authors. */
export function AuthorFilter({ authors, who, onChange, tip }: { authors: Author[]; who: string[]; onChange: (who: string[]) => void; tip: string }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (authors.length < 2) return null;
  const picked = authors.filter((a) => who.includes(a.email));
  return (
    <>
      <button
        className="btn btn-sm"
        style={{ flex: "0 0 auto", maxWidth: 120 }}
        aria-haspopup="menu"
        aria-label="Filter by author"
        data-tip={tip}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.right, y: r.bottom + 2 });
        }}
      >
        <span className="ellipsis">{picked.length === 0 ? "All" : picked.length === 1 ? picked[0].name : `${picked.length} authors`}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          label="Filter by author"
          onClose={() => setMenu(null)}
          items={[
            { id: "all", label: "All", icon: null, hint: picked.length === 0 && <Icon name="check" size={13} />, keep: true, run: () => onChange([]) },
            "sep",
            ...authors.map((a) => ({
              id: a.email,
              label: (
                <span className="row" style={{ gap: 8, minWidth: 0, padding: "4px 0" }}>
                  <Avatar name={a.name} email={a.email} size={20} />
                  <span className="col" style={{ minWidth: 0, gap: 0, lineHeight: 1.25 }}>
                    <span className="ellipsis">{a.name}</span>
                    <span className="faint ellipsis" style={{ fontSize: 11 }}>{a.email}</span>
                  </span>
                </span>
              ),
              icon: null,
              hint: who.includes(a.email) && <Icon name="check" size={13} />,
              keep: true,
              run: () => onChange(who.includes(a.email) ? who.filter((e) => e !== a.email) : [...who, a.email]),
            })),
          ]}
        />
      )}
    </>
  );
}
