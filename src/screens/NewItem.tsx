import { useEffect, useState } from "react";

import { useAction, useAiOn, useOverview, useProjectPrefs, useSuggestedVersion } from "../api/hooks";
import { rpc } from "../api/transport";
import { RequestField, uploads, type Attachment } from "../components/AgentLog";
import { AgentPicker, MenuChoice, useAgentPick } from "../components/AgentPicker";
import { Icon } from "../components/Icon";
import { useTermView } from "../components/Shell";
import { Modal, releaseTagLabel, Seg } from "../components/ui";
import { KINDS, kindNoun, kindOfBranch, withPrefix, withTicket, type Kind } from "../lib/kinds";
import { useNav, type NewItemDraft } from "../lib/nav";
import { revealBranch } from "./BranchTree";

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
    (draft.release && open.find((r) => r.version === draft.release)?.branch) || draft.tag || draft.from || open[0]?.branch || ov.data?.defaultBranch || "";
  const [kind, setKind] = useState<Kind | "release">(draft.kind ?? "feat");
  const [relKind, setRelKind] = useState<"next" | "hotfix">("next");
  // Null until the user types their own; the suggestion shows meanwhile.
  const [typedVersion, setVersion] = useState<string | null>(null);
  const [desc, setDesc] = useState(draft.description ?? "");
  const [from, setFrom] = useState(firstBase);
  const [ticket, setTicket] = useState(draft.ticket ?? "");
  const { dialogs } = useProjectPrefs(pid);
  // An agent always gets its own worktree.
  const [where, setWhere] = useState<"switch" | "worktree">(dialogs.newWorktree || dialogs.newAgent ? "worktree" : "switch");
  const [agent, setAgent] = useState(dialogs.newAgent);
  const [pick, setPick] = useAgentPick(pid);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [, setTermView] = useTermView();
  const [name, setName] = useState("");
  const [named, setNamed] = useState<"ai" | "auto" | "you" | null>(null);
  const [naming, setNaming] = useState(false);

  useEffect(() => {
    if (!from && ov.data) setFrom(firstBase());
  }, [ov.data, from]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggested = useSuggestedVersion(pid, relKind, kind === "release" && typedVersion === null);
  const version = typedVersion ?? suggested.data?.version ?? "";

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
  const fromTag = !!draft.tag && from === draft.tag;
  const rel = open.find((r) => r.branch === from);
  const types = [...KINDS.map((k) => ({ value: k.id as Kind | "release", label: k.label })), { value: "release" as const, label: "Release" }];

  // A hook: called on every render, so above the release dialog's early return.
  const aiOn = useAiOn("branch");

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
                      revealBranch(pid, `release/${v}`);
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
  const branch = withTicket(withPrefix(name, kind), ticket);
  // Switching brings the uncommitted changes along: with no name, AI names the branch after them.
  const wip = ov.data?.branches.find((b) => b.name === ov.data?.currentBranch)?.wip ?? 0;
  const nameFromWip = aiOn && !agent && where === "switch" && wip > 0;
  const ready = !!(base || fromTag) && (agent ? !!desc.trim() : !!name.trim() || nameFromWip) && !create.isPending;
  const submit = async () => {
    const up = agent ? await uploads(files) : undefined;
    create.mutate(
      { projectId: pid, release: rel?.version ?? "", from: rel ? undefined : from, kind, description: agent ? desc : "", branchName: branch || undefined, ticket: ticket || undefined, where, startAgent: agent, files: up, ...(agent && pick) },
      {
        onSuccess: (r) => {
          // A new worktree opens on its agent, even if the shell was the last tab picked.
          if (where === "worktree") setTermView("agent");
          revealBranch(pid, r.branch);
          nav.selectBranch(r.branch);
          nav.go({ name: "workspace" });
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      title={rel ? `New in v${rel.version}` : base ? `New branch off ${base.name}` : fromTag ? `New branch off ${draft.tag}` : "New feature or fix"}
      sub={
        base ? <>Branches off <span className="mono">{base.name}</span> and merges back into it</>
        : fromTag ? <>Branches off tag <span className="mono">{draft.tag}</span> and merges into <span className="mono">{ov.data?.defaultBranch}</span></>
        : "Pick where it starts"
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-md" disabled={!ready} onClick={submit}>
            {create.isPending && <span className="spinner" />}
            Create {label}
          </button>
        </>
      }
    >
      <Seg grid cols={6} size="lg" label="Type" value={kind} onChange={pickKind} options={types} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
        <div className="field">
          <label htmlFor="ni-rel">Branches off</label>
          <MenuChoice
            id="ni-rel"
            className="select menu-select"
            label="Branches off"
            value={from}
            options={[
              ...(draft.tag ? [{ value: draft.tag, label: `${draft.tag} (tag)` }] : []),
              ...bases.map((b) => {
                const r = open.find((x) => x.branch === b.name);
                return { value: b.name, label: r ? `v${r.version} — ${releaseTagLabel(r.tag)}` : b.name };
              }),
            ]}
            onChange={setFrom}
          />
        </div>
        <div className="field">
          <label htmlFor="ni-ticket">Ticket <span className="faint" style={{ fontWeight: 400 }}>optional</span></label>
          <input id="ni-ticket" className="input mono" placeholder="ATL-212" value={ticket} onChange={(e) => setTicket(e.target.value)} />
        </div>
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
          placeholder={nameFromWip ? "Leave empty to let AI name it from your changes" : `${kind}/…`}
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
      <fieldset className="col" style={{ margin: 0, padding: 0, border: 0, gap: 6 }}>
        <legend className="muted" style={{ padding: "0 0 6px", fontSize: 12, fontWeight: 500 }}>Where to work</legend>
        {(
          [
            ["switch", "Switch to the new branch", "Your uncommitted changes come along"],
            ["worktree", "Open in a new worktree", "Runs alongside your current branch — good for parallel AI work"],
          ] as const
        ).map(([v, t, s]) => (
          <button key={v} type="button" className="radio-card" aria-pressed={where === v} disabled={agent && v === "switch"} onClick={() => setWhere(v)}>
            <span className="radio-dot" />
            <span className="col" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>{t}</span>
              <span className="muted" style={{ fontSize: 12 }}>{s}</span>
            </span>
          </button>
        ))}
      </fieldset>
      <label className="check">
        <input
          type="checkbox"
          checked={agent}
          onChange={() => {
            // An agent always gets its own worktree.
            if (!agent) setWhere("worktree");
            setAgent(!agent);
          }}
        />
        <span>Start an AI agent on it right away</span>
      </label>
      {agent && (
        <>
          <div className="field">
            <span>Agent</span>
            <AgentPicker value={pick} onChange={setPick} />
          </div>
          <RequestField value={desc} onChange={setDesc} files={files} onFiles={setFiles} onSubmit={() => ready && submit()} />
        </>
      )}
    </Modal>
  );
}
