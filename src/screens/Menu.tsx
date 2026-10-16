import { useState } from "react";

import { useAction, useConfig } from "../api/hooks";
import { currentRemote, isLocal, saveRemote } from "../api/transport";
import type { GitProfile } from "../api/types";
import { Icon } from "../components/Icon";
import { Seg } from "../components/ui";
import { useNav, type Route } from "../lib/nav";

const TOOLS: { glyph: string; title: string; sub: string; route: Route }[] = [
  { glyph: "RN", title: "Release notes", sub: "Generate notes between two tags or branches.", route: { name: "notes" } },
  { glyph: "PR", title: "Pull requests", sub: "Open, review and update PRs on GitHub.", route: { name: "prs" } },
  { glyph: "TK", title: "Tickets", sub: "Jira, Trello and Asana items, linked to their branches.", route: { name: "tickets" } },
  { glyph: "WT", title: "Worktrees & agents", sub: "Every agent session across projects, live.", route: { name: "worktrees" } },
  { glyph: "AT", title: "AI templates", sub: "How AI writes commits, PRs and release notes.", route: { name: "templates" } },
  { glyph: "ST", title: "Analytics & stats", sub: "Release cadence, lead time and AI activity.", route: { name: "analytics" } },
];

const LANGS = [
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
];

export function Menu({ onUnpair }: { onUnpair: () => void }) {
  const nav = useNav();
  const cfg = useConfig().data;
  const project = cfg?.projects.find((p) => p.id === nav.projectId);
  const inv = [["config"]];
  const setLang = useAction("projects.setGenLang", { invalidate: inv });
  const setProfile = useAction("projects.setProfile", { invalidate: inv });
  const saveProfile = useAction<GitProfile>("profiles.save", { invalidate: inv });
  const setUi = useAction("ui.set", { invalidate: inv });
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ label: "", name: "", email: "", sign: true });
  const close = () => nav.go(nav.projectId ? { name: "workspace" } : { name: "home" });

  return (
    <>
      <header className="hdr">
        <button className="hdr-icon" aria-label="Close menu" onClick={close}>
          <Icon name="close" size={16} />
        </button>
        <div className="hdr-title">
          <strong>Gitnetix</strong>
          {project && (
            <>
              <span className="faint">·</span>
              <span className="muted">{project.name}</span>
            </>
          )}
        </div>
      </header>
      <div className="menu-wrap">
        <nav aria-label="Main menu" className="menu">
          {project && (
            <>
              <div className="row" style={{ justifyContent: "space-between", padding: "4px 10px 8px" }}>
                <h1 className="label">For this project</h1>
                <span className="mono faint" style={{ fontSize: 11.5 }}>{project.name}</span>
              </div>
              <div className="col card" style={{ gap: 12, padding: 14 }}>
                <div className="col" style={{ gap: 2 }}>
                  <span style={{ fontWeight: 500 }}>Generation language</span>
                  <span className="hint">The language the AI writes in for this project. Templates stay the same.</span>
                </div>
                {(
                  [
                    ["commit", "Commit summary & message"],
                    ["pr", "PR title & description"],
                    ["release", "Release notes"],
                  ] as const
                ).map(([k, label]) => (
                  <div key={k} className="row wrap" style={{ justifyContent: "space-between" }}>
                    <span className="muted" id={`gen-${k}`}>{label}</span>
                    <Seg label={label} value={project.genLang[k]} options={LANGS} onChange={(v) => setLang.mutate({ projectId: project.id, [k]: v })} />
                  </div>
                ))}
                <div style={{ borderTop: "1px solid var(--line)", margin: "4px -14px 0" }} />
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div className="col" style={{ gap: 2 }}>
                    <span style={{ fontWeight: 500 }} id="menu-profile">Git profile</span>
                    <span className="hint">Author name, email and signing key used for commits in this project.</span>
                  </div>
                  {!adding && (
                    <button className="btn btn-sm" onClick={() => setAdding(true)}>
                      <Icon name="plus" size={12} />
                      Add profile
                    </button>
                  )}
                </div>
                <div role="radiogroup" aria-labelledby="menu-profile" className="col" style={{ gap: 6 }}>
                  <button className="radio-card" role="radio" aria-checked={!project.profileId} onClick={() => setProfile.mutate({ projectId: project.id, profileId: null })}>
                    <span className="radio-dot" />
                    <span className="col" style={{ gap: 2 }}>
                      <span style={{ fontWeight: 500 }}>Repository config</span>
                      <span className="hint">Whatever user.name / user.email git already uses here</span>
                    </span>
                  </button>
                  {(cfg?.profiles ?? []).map((p) => (
                    <button key={p.id} className="radio-card" role="radio" aria-checked={project.profileId === p.id} onClick={() => setProfile.mutate({ projectId: project.id, profileId: p.id })}>
                      <span className="radio-dot" />
                      <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                        <span style={{ fontWeight: 500 }}>{p.label}</span>
                        <span className="hint ellipsis">{p.name} &lt;{p.email}&gt;</span>
                      </span>
                      <span className={`pill ${p.sign ? "c-add" : "faint"}`}>{p.sign ? "Signed" : "Unsigned"}</span>
                    </button>
                  ))}
                </div>
                {adding && (
                  <form
                    className="col note-box"
                    style={{ gap: 10 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveProfile.mutate(
                        { profile: draft },
                        {
                          onSuccess: (p) => {
                            setProfile.mutate({ projectId: project.id, profileId: p.id });
                            setAdding(false);
                            setDraft({ label: "", name: "", email: "", sign: true });
                          },
                        },
                      );
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>New profile</span>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
                      {(
                        [
                          ["label", "Profile name", "Client work"],
                          ["name", "Author name", "Your name"],
                          ["email", "Email", "you@client.com"],
                        ] as const
                      ).map(([k, l, ph]) => (
                        <div key={k} className="field">
                          <label htmlFor={`np-${k}`}>{l}</label>
                          <input id={`np-${k}`} className="input" type={k === "email" ? "email" : "text"} placeholder={ph} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                        </div>
                      ))}
                    </div>
                    <label className="check">
                      <input type="checkbox" checked={draft.sign} onChange={() => setDraft({ ...draft, sign: !draft.sign })} />
                      <span>Sign commits with my SSH key</span>
                    </label>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
                      <button className="btn btn-primary" disabled={!draft.label.trim() || !draft.email.trim()}>Save and use</button>
                    </div>
                  </form>
                )}
              </div>
            </>
          )}

          <h2 className="label" style={{ padding: "20px 10px 4px" }}>Tools</h2>
          {TOOLS.map((t) => (
            <button key={t.glyph} className="tool-link" onClick={() => nav.go(t.route)} disabled={!nav.projectId && t.route.name !== "worktrees" && t.route.name !== "templates" && t.route.name !== "analytics"}>
              <span className="mono-badge">{t.glyph}</span>
              <span className="col" style={{ gap: 2 }}>
                <span style={{ fontWeight: 500 }}>{t.title}</span>
                <span className="hint">{t.sub}</span>
              </span>
            </button>
          ))}

          <h2 className="label" style={{ padding: "20px 10px 4px" }}>App</h2>
          <button className="tool-link" onClick={() => nav.go({ name: "ai" })}>
            <span className="mono-badge"><Icon name="sparkle" size={13} /></span>
            <span className="col" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>AI setup</span>
              <span className="hint">Providers, models and task routing</span>
            </span>
          </button>
          <button className="tool-link" onClick={() => nav.go({ name: "settings" })}>
            <span className="mono-badge"><Icon name="gear" size={14} /></span>
            <span className="col" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>Settings</span>
              <span className="hint">Git providers, integrations, companion &amp; MCP</span>
            </span>
          </button>
          <div className="row wrap" style={{ justifyContent: "space-between", padding: "10px" }}>
            <span>Language</span>
            <Seg label="Language" value={cfg?.ui.language ?? "en"} options={LANGS} onChange={(v) => setUi.mutate({ language: v })} />
          </div>
          <div className="row wrap" style={{ justifyContent: "space-between", padding: "10px" }}>
            <span>Theme</span>
            <Seg
              label="Theme"
              value={nav.themePref}
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
              onChange={nav.setThemePref}
            />
          </div>
          <button className="tool-link" onClick={() => nav.go({ name: "settings", section: "companion" })}>
            <span className="mono-badge"><Icon name="phone" size={13} /></span>
            <span className="col grow" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>{isLocal ? "Companion & MCP" : "Connected desktop"}</span>
              <span className="hint">
                {isLocal
                  ? cfg?.server.enabled
                    ? `Running on port ${cfg.server.port} · ${cfg.server.lan ? "LAN" : "this computer only"} · every action exposed`
                    : "Off"
                  : currentRemote()?.url}
              </span>
            </span>
            {cfg?.server.enabled && <span className="pulse" style={{ background: "var(--add-fg)", animation: "none" }} />}
          </button>
          {!isLocal && (
            <button
              className="btn btn-danger"
              style={{ margin: "8px 10px" }}
              onClick={() => {
                saveRemote(null);
                onUnpair();
              }}
            >
              Disconnect from this desktop
            </button>
          )}
        </nav>
        <div className="menu-scrim" onClick={close} aria-hidden="true" />
      </div>
    </>
  );
}
