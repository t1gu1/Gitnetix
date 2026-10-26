import { useState } from "react";

import { Avatar } from "./Avatar";
import { ContextMenu } from "./ContextMenu";
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
                    <span className="faint ellipsis" style={{ fontSize: 11 }}>{a.emails.join(", ")}</span>
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
