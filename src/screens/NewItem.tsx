import { useEffect, useState } from "react";

import { useAction, useOverview } from "../api/hooks";
import { rpc } from "../api/transport";
import { Icon } from "../components/Icon";
import { Modal, releaseTagLabel, Seg } from "../components/ui";
import { KINDS, kindNoun, kindOfBranch, withPrefix, type Kind } from "../lib/kinds";
import { useNav, type NewItemDraft } from "../lib/nav";

export function NewItem({ draft, onClose }: { draft: NewItemDraft; onClose: () => void }) {
  const nav = useNav();
  const pid = nav.projectId!;
  const ov = useOverview(pid);
  const open = (ov.data?.releases ?? []).filter((r) => r.open);
  // Where it can branch off: open releases first, then the trunks (default and dev branches),
  // plus the work branch it was opened from ("Create a branch from here" on a feature).
  const bases = (ov.data?.branches ?? [])
    .filter((b) => b.exists && (b.role === "release" || b.role === "trunk" || b.name === draft.from))
    .sort((a, b) => (a.role === b.role ? 0 : a.role === "release" ? -1 : b.role === "release" ? 1 : a.role === "trunk" ? -1 : 1));
  const firstBase = () =>
    (draft.release && open.find((r) => r.version === draft.release)?.branch) || draft.from || open[0]?.branch || ov.data?.defaultBranch || "";
  const [kind, setKind] = useState<Kind | "release">(draft.kind ?? "feat");
  const [relKind, setRelKind] = useState<"next" | "hotfix">("next");
  const [version, setVersion] = useState("");
  const [desc, setDesc] = useState(draft.description ?? "");
  const [from, setFrom] = useState(firstBase);
  const [ticket, setTicket] = useState(draft.ticket ?? "");
  const [where, setWhere] = useState<"switch" | "worktree">("switch");
  const [agent, setAgent] = useState(false);
  const [name, setName] = useState("");
  const [named, setNamed] = useState<"ai" | "auto" | "you" | null>(null);
  const [naming, setNaming] = useState(false);

  useEffect(() => {
    if (!from && ov.data) setFrom(firstBase());
  }, [ov.data, from]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ask AI for a branch name once the description settles.
  useEffect(() => {
    if (!agent || named === "you" || desc.trim().length < 6) return;
    const t = setTimeout(async () => {
      setNaming(true);
      try {
        const r = await rpc<{ name: string; ai: boolean }>("items.suggestName", { projectId: pid, kind, description: desc, ticket });
        setName(r.name.replace(/\s/g, "-"));
        setNamed(r.ai ? "ai" : "auto");
      } catch {
        /* keep whatever is there */
      } finally {
        setNaming(false);
      }
    }, 700);
    return () => clearTimeout(t);
  }, [agent, desc, kind, ticket, pid]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = useAction<{ branch: string; worktree?: string; agentSession?: string }>("items.create", {
    invalidate: [["overview", pid], ["agents"], ["worktrees"]],
    success: (r) => `Created ${r.branch}${r.worktree ? ` in ${r.worktree}` : ""}${r.agentSession ? " · agent started" : ""}`,
  });
  const v = version.replace(/^v/, "");
  const createRelease = useAction("releases.create", { invalidate: [["overview", pid], ["projects"]], success: `Release v${v} created` });
  const base = bases.find((b) => b.name === from);
  const rel = open.find((r) => r.branch === from);
  const types = [...KINDS.map((k) => ({ value: k.id as Kind | "release", label: k.label })), { value: "release" as const, label: "Release" }];

  // Switching type rewrites a known type prefix (feature/x → fix/x); a custom prefix is left alone.
  const pickKind = (k: Kind | "release") => {
    setKind(k);
    if (k !== "release" && kindOfBranch(name)) setName(`${k}/${name.slice(name.indexOf("/") + 1)}`);
  };

  if (kind === "release") {
    return (
      <Modal
        title="New release"
        sub={relKind === "next" ? "Branches off your default branch" : "Branches off the latest tag"}
        onClose={onClose}
        footer={
          <>
            <button className="btn btn-md" onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary btn-md"
              disabled={!v || createRelease.isPending}
              onClick={() =>
                createRelease.mutate(
                  { projectId: pid, version: v, kind: relKind },
                  {
                    onSuccess: () => {
                      nav.selectBranch(`release/${v}`);
                      nav.go({ name: "workspace" });
                      onClose();
                    },
                  },
                )
              }
            >
              {createRelease.isPending && <span className="spinner" />}
              Create release/{v || "x.y.z"}
            </button>
          </>
        }
      >
        <Seg grid cols={6} size="lg" label="Type" value={kind} onChange={pickKind} options={types} />
        <Seg grid size="lg" label="Release type" value={relKind} onChange={setRelKind} options={[{ value: "next", label: "Next release" }, { value: "hotfix", label: "Hotfix" }]} />
        <div className="field">
          <label htmlFor="ni-version">Version</label>
          <input id="ni-version" className="input mono" placeholder="2.4.0" value={version} onChange={(e) => setVersion(e.target.value.trim())} autoFocus />
        </div>
      </Modal>
    );
  }

  const label = kindNoun(kind);
  const branch = withPrefix(name, kind);

  return (
    <Modal
      title={rel ? `New in v${rel.version}` : base ? `New branch off ${base.name}` : "New feature or fix"}
      sub={base ? <>Branches off <span className="mono">{base.name}</span> and merges back into it</> : "Pick where it starts"}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary btn-md"
            disabled={!base || (agent ? !desc.trim() : !name.trim()) || create.isPending}
            onClick={() =>
              create.mutate(
                { projectId: pid, release: rel?.version ?? "", from: rel ? undefined : from, kind, description: agent ? desc : "", branchName: branch || undefined, ticket: ticket || undefined, where, startAgent: agent },
                {
                  onSuccess: (r) => {
                    nav.selectBranch(r.branch);
                    nav.go({ name: "workspace" });
                    onClose();
                  },
                },
              )
            }
          >
            {create.isPending && <span className="spinner" />}
            Create {label}
          </button>
        </>
      }
    >
      <Seg grid cols={6} size="lg" label="Type" value={kind} onChange={pickKind} options={types} />
      <div className="field">
        <label htmlFor="ni-branch">
          <span>Branch name</span>
          <span className="row c-acc" style={{ gap: 5, fontWeight: 400 }}>
            {naming ? <span className="spinner" /> : named === "ai" ? <><Icon name="sparkle" size={11} />Named by AI</> : named === "auto" ? "From description" : null}
          </span>
        </label>
        <input
          id="ni-branch"
          className="input mono"
          style={{ fontSize: 12.5 }}
          value={name}
          placeholder={`${kind}/…`}
          autoFocus
          onChange={(e) => {
            // Git names can't hold spaces: each one becomes a dash as you type.
            const v = e.target.value.replace(/\s/g, "-");
            setName(v);
            setNamed("you");
            const k = kindOfBranch(v);
            if (k) setKind(k);
          }}
        />
        {branch && branch !== name.trim() && (
          <span className="faint" style={{ fontSize: 12 }}>Creates <span className="mono">{branch}</span></span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
        <div className="field">
          <label htmlFor="ni-rel">Branches off</label>
          <select id="ni-rel" className="select" value={from} onChange={(e) => setFrom(e.target.value)}>
            {bases.map((b) => {
              const r = open.find((x) => x.branch === b.name);
              return (
                <option key={b.name} value={b.name}>{r ? `v${r.version} — ${releaseTagLabel(r.tag)}` : b.name}</option>
              );
            })}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ni-ticket">Ticket <span className="faint" style={{ fontWeight: 400 }}>optional</span></label>
          <input id="ni-ticket" className="input mono" placeholder="ATL-212" value={ticket} onChange={(e) => setTicket(e.target.value)} />
        </div>
      </div>
      <fieldset className="col" style={{ margin: 0, padding: 0, border: 0, gap: 6 }}>
        <legend className="muted" style={{ padding: "0 0 6px", fontSize: 12, fontWeight: 500 }}>Where to work</legend>
        {(
          [
            ["switch", "Switch to the new branch", "Your uncommitted changes come along"],
            ["worktree", "Open in a new worktree", "Runs alongside your current branch — good for parallel AI work"],
          ] as const
        ).map(([v, t, s]) => (
          <button key={v} type="button" className="radio-card" aria-pressed={where === v} onClick={() => setWhere(v)}>
            <span className="radio-dot" />
            <span className="col" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>{t}</span>
              <span className="muted" style={{ fontSize: 12 }}>{s}</span>
            </span>
          </button>
        ))}
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={agent} onChange={() => setAgent(!agent)} />
        <span>Start an AI agent on it right away</span>
      </label>
      {agent && (
        <div className="field">
          <label htmlFor="ni-desc">Describe it</label>
          <textarea id="ni-desc" className="textarea" rows={3} style={{ resize: "none" }} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Let users sign in with Google and GitHub." autoFocus />
        </div>
      )}
    </Modal>
  );
}
