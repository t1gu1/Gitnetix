import { useEffect, useState } from "react";

import { useAction, useOverview } from "../api/hooks";
import { rpc } from "../api/transport";
import { Icon } from "../components/Icon";
import { Modal, Seg } from "../components/ui";
import { useNav, type NewItemDraft } from "../lib/nav";

export function NewItem({ draft, onClose }: { draft: NewItemDraft; onClose: () => void }) {
  const nav = useNav();
  const pid = nav.projectId!;
  const ov = useOverview(pid);
  const open = (ov.data?.releases ?? []).filter((r) => r.open);
  const [kind, setKind] = useState<"feat" | "fix">(draft.kind ?? "feat");
  const [desc, setDesc] = useState(draft.description ?? "");
  const [release, setRelease] = useState(draft.release ?? open[0]?.version ?? "");
  const [ticket, setTicket] = useState(draft.ticket ?? "");
  const [where, setWhere] = useState<"switch" | "worktree">("worktree");
  const [agent, setAgent] = useState(true);
  const [name, setName] = useState("");
  const [named, setNamed] = useState<"ai" | "auto" | "you" | null>(null);
  const [naming, setNaming] = useState(false);

  useEffect(() => {
    if (!release && open[0]) setRelease(open[0].version);
  }, [open, release]);

  // Ask AI for a branch name once the description settles.
  useEffect(() => {
    if (named === "you" || desc.trim().length < 6) return;
    const t = setTimeout(async () => {
      setNaming(true);
      try {
        const r = await rpc<{ name: string; ai: boolean }>("items.suggestName", { projectId: pid, kind, description: desc, ticket });
        setName(r.name);
        setNamed(r.ai ? "ai" : "auto");
      } catch {
        /* keep whatever is there */
      } finally {
        setNaming(false);
      }
    }, 700);
    return () => clearTimeout(t);
  }, [desc, kind, ticket, pid]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = useAction<{ branch: string; worktree?: string; agentSession?: string }>("items.create", {
    invalidate: [["overview", pid], ["agents"], ["worktrees"]],
    success: (r) => `Created ${r.branch}${r.worktree ? ` in ${r.worktree}` : ""}${r.agentSession ? " · agent started" : ""}`,
  });
  const rel = open.find((r) => r.version === release);
  const label = kind === "feat" ? "feature" : "fix";

  return (
    <Modal
      title={rel ? `New in v${rel.version}` : "New feature or fix"}
      sub={rel ? <>Branches off <span className="mono">{rel.branch}</span></> : "Create a release first"}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary btn-md"
            disabled={!rel || !desc.trim() || create.isPending}
            onClick={() =>
              create.mutate(
                { projectId: pid, release, kind, description: desc, branchName: name || undefined, ticket: ticket || undefined, where, startAgent: agent },
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
      <Seg grid size="lg" label="Type" value={kind} onChange={setKind} options={[{ value: "feat", label: "Feature" }, { value: "fix", label: "Fix" }]} />
      <div className="field">
        <label htmlFor="ni-desc">Describe it</label>
        <textarea id="ni-desc" className="textarea" rows={3} style={{ resize: "none" }} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Let users sign in with Google and GitHub." autoFocus />
      </div>
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
          onChange={(e) => {
            setName(e.target.value);
            setNamed("you");
          }}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
        <div className="field">
          <label htmlFor="ni-rel">Release</label>
          <select id="ni-rel" className="select" value={release} onChange={(e) => setRelease(e.target.value)}>
            {open.map((r) => (
              <option key={r.version} value={r.version}>v{r.version} — {r.tag === "next" ? "Next" : "Hotfix"}</option>
            ))}
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
    </Modal>
  );
}
