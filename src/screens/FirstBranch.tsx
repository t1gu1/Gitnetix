import { useState } from "react";
import { createPortal } from "react-dom";

import { useAction, useConfig, useFiles } from "../api/hooks";
import type { Overview } from "../api/types";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { Busy, EnterHint } from "../components/ui";
import { plural } from "../lib/format";

const NAMES = [
  { value: "main", note: "The name GitHub and GitLab give new repositories." },
  { value: "master", note: "Git’s built-in name. Older projects and tools often expect it." },
];
// The folder's files listed under the checkbox; past this many, a count of the rest.
const SHOWN = 8;

/** A repository with no commit yet, in place of the branch map: its first branch is named here and made with its first
 *  commit (git has no branch before one). Beside it, the map as it will look. */
export function FirstBranch({ pid, o, bar }: { pid: string; o: Overview; bar: HTMLElement | null }) {
  const [pick, setPick] = useState("main");
  const [custom, setCustom] = useState("");
  const [withFiles, setWithFiles] = useState(true);
  const me = useConfig().data?.profiles[0];
  const listed = useFiles(pid, o.currentBranch ?? undefined, "wip");
  const files = [...new Set((listed.data ?? []).map((f) => f.path))];
  const create = useAction<unknown, { projectId: string; name: string; files: boolean }>("workspace.firstBranch", {
    invalidate: [["overview", pid], ["files", pid]],
    success: (_, v) => `Created ${v.name}`,
  });
  const name = (pick === "custom" ? custom : pick).trim();
  const ready = !!name && !create.isPending;
  const submit = () => ready && create.mutate({ projectId: pid, name, files: withFiles });

  return (
    <div
      className="first-branch"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
          e.preventDefault();
          submit();
        }
      }}
    >
      {bar &&
        createPortal(
          <div className="map-bar first-bar">
            <h2 className="map-title">Branch map</h2>
          </div>,
          bar,
        )}
      <form
        className="first-branch-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2>Name the first branch</h2>
        <p className="first-branch-lede">
          <span className="mono">{o.project.name}</span> has no commit yet. Git makes the branch with its first commit.
        </p>
        <div role="radiogroup" aria-label="First branch name" className="first-opts">
          {NAMES.map((n) => (
            <label key={n.value} className="check first-opt">
              <input type="radio" name="first-branch" checked={pick === n.value} onChange={() => setPick(n.value)} />
              <span className="first-opt-text">
                <span className="first-opt-name">{n.value}</span>
                <span className="first-opt-note">{n.note}</span>
              </span>
            </label>
          ))}
          <label className="check first-opt">
            <input type="radio" name="first-branch" checked={pick === "custom"} onChange={() => setPick("custom")} />
            <span className="first-opt-text">
              <span className="first-opt-custom">
                <span>Custom</span>
                <input
                  className="input mono"
                  aria-label="Branch name"
                  placeholder="trunk, develop…"
                  value={custom}
                  onFocus={() => setPick("custom")}
                  // Git names can't hold spaces: each one becomes a dash as you type.
                  onChange={(e) => setCustom(e.target.value.replace(/\s/g, "-"))}
                />
              </span>
              <span className="first-opt-note">
                Spaces become dashes. Git refuses <span className="mono">~ ^ : ? * [ \</span> and <span className="mono">..</span>
              </span>
            </span>
          </label>
        </div>
        {/* Said empty only once listed: while the list loads, or when it failed, the files still go in. */}
        {listed.isSuccess && !files.length ? (
          <p className="first-opt-note">The folder is empty: the first commit holds no file.</p>
        ) : (
          !listed.isPending && (
            <label className="check first-files">
              <input type="checkbox" checked={withFiles} onChange={() => setWithFiles(!withFiles)} />
              <span className="first-opt-text">
                <span>Commit the {files.length ? plural(files.length, "file") : "files"} in this folder</span>
                {files.length > 0 && (
                  <span className="mono faint first-files-list">
                    {files.slice(0, SHOWN).join("  ")}
                    {files.length > SHOWN && `  +${files.length - SHOWN} more`}
                  </span>
                )}
              </span>
            </label>
          )
        )}
        <div className="first-branch-go">
          <button type="submit" className="btn btn-primary btn-md" disabled={!ready}>
            <Busy on={create.isPending}><Icon name="branch" /></Busy>
            <span className="ellipsis">Create {name || "branch"}</span>
          </button>
          <span className="modal-hint">
            <EnterHint verb="create" />
          </span>
        </div>
      </form>
      <div className="first-preview" aria-hidden="true">
        <span className="muted">Your map after Create</span>
        <div className="first-preview-map">
          <div className="map-layer">
            <span className="map-col" style={{ left: 20 }}>Trunk</span>
            <svg className="map-edges" width="350" height="190">
              <path className="map-trunk-line" d="M26 74V174" />
              <path className="map-trunk-line" d="M16 164l20 20" />
              <path d="M26 74H46" data-line="head" />
            </svg>
            <span className="map-stn" data-main="" style={{ left: 26, top: 74 }} />
            <div className="map-tile" data-role="trunk" data-trunk="true" data-sel="true" data-head="true" style={{ left: 46, top: 48, width: 280, height: 74 }}>
              <div className="map-tile-in">
                <span className="map-row">
                  <span className={`map-ver ellipsis${name ? "" : " faint"}`}>{name || "name"}</span>
                </span>
                <span className="map-foot">
                  <span className="map-info">just now</span>
                </span>
              </div>
            </div>
            <div className="map-float" style={{ left: 60, top: 128, width: 266 }}>
              <span className="map-crow" data-on="true">
                <Avatar name={me?.name ?? ""} email={me?.email ?? ""} size={12} />
                <span className="ellipsis">Initial commit</span>
                <i>now</i>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
