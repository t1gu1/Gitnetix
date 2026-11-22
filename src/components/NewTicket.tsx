import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAction, useConfig, useTemplates } from "../api/hooks";
import { rpc } from "../api/transport";
import type { AgentSession, TicketPlace } from "../api/types";
import { blocks } from "../lib/agentLog";
import { useNav } from "../lib/nav";
import { closeNewTicket, openNewTicket, ticketDraft, useTicketAsk, type TicketAsk } from "../lib/newTicket";
import { useStored } from "../lib/stored";
import { toast } from "../lib/toast";
import { MenuChoice } from "./AgentPicker";
import { Icon } from "./Icon";
import { Confirm, ErrorBox, LANGS, Loading, Markdown, Modal, Seg } from "./ui";

const placeKey = (p: { source: string; conn: string; id: string }) => `${p.source}|${p.conn}|${p.id}`;

/** Where a ticket of `projectId` can go. Kept a few minutes: every tracker is asked, some once per board or project. */
const useTicketPlaces = (projectId: string) =>
  useQuery({ queryKey: ["ticketPlaces", projectId], queryFn: () => rpc<{ places: TicketPlace[]; errors: string[] }>("tickets.places", { projectId }), staleTime: 5 * 60_000 });

// A template's name and the tracker kinds its words point to: "Bug / Issue" files as a Jira Bug, "Feature" as a Story.
const WORDS: [RegExp, RegExp][] = [
  [/bug|issue|defect|incident|bogue/i, /bug|defect|incident|bogue|issue/i],
  [/feature|story|enhancement|improvement|fonctionnalit/i, /story|feature|enhancement|improvement|fonctionnalit/i],
  [/task|chore|t[aâ]che/i, /task|chore|t[aâ]che|to.?do/i],
];

/** The kind a ticket written with `template` (its name) is filed as in `place`: the one of the same name, else the first its
 *  words point to, else none (Jira's first type, since Jira needs one). */
function kindFor(template: string, place: TicketPlace | undefined): string {
  const kinds = place?.kinds ?? [];
  const same = kinds.find((k) => k.name.toLowerCase() === template.trim().toLowerCase());
  if (same) return same.id;
  for (const [t, k] of WORDS) {
    const hit = t.test(template) ? kinds.find((x) => k.test(x.name)) : undefined;
    if (hit) return hit.id;
  }
  return place?.kindRequired ? (kinds[0]?.id ?? "") : "";
}

/** The new ticket dialog, opened from a branch's menu, the Tickets screen or a ticket study's draft (see `openNewTicket`). */
export function NewTicket() {
  const ask = useTicketAsk();
  if (!ask) return null;
  return <TicketForm key={`${ask.projectId}:${ask.branch ?? ""}:${ask.study?.id ?? ""}`} {...ask} />;
}

function TicketForm({ projectId, branch, study }: TicketAsk) {
  const nav = useNav();
  const cfg = useConfig().data;
  const project = cfg?.projects.find((p) => p.id === projectId);
  const others = (cfg?.projects ?? []).filter((p) => p.id !== projectId && !p.hidden);
  const templateList = useTemplates().data?.templates;
  const templates = (templateList ?? []).filter((t) => t.kind === "ticket" && (t.scope === "all" || t.scope === projectId));
  const places = useTicketPlaces(projectId);
  const list = places.data?.places ?? [];
  const [lastPlace, setLastPlace] = useStored(`ticket.place.${projectId}`, "");
  const [template, setTemplate] = useState(study?.to.template ?? "");
  const tpl = templates.find((t) => t.id === template) ?? templates.find((t) => t.isDefault) ?? templates[0];
  const [picked, setPicked] = useState(study ? placeKey({ source: study.to.source, conn: study.to.conn, id: study.to.place }) : "");
  const place = list.find((p) => placeKey(p) === (picked || lastPlace)) ?? list[0];
  // Null until picked by hand: the kind follows the template meanwhile.
  const [kindPicked, setKind] = useState<string | null>(study ? (study.to.kind ?? "") : null);
  const kind = kindPicked ?? kindFor(tpl?.name ?? "", place);
  const [request, setRequest] = useState("");
  const [studyOn, setStudyOn] = useState(true);
  const [more, setMore] = useState<string[]>([]);
  const [lang, setLangHere] = useState(project?.genLang.ticket ?? "en");
  const [step, setStep] = useState<"form" | "draft">(study ? "draft" : "form");
  const [title, setTitle] = useState(study?.title ?? "");
  const [body, setBody] = useState(study?.body ?? "");
  const [view, setView] = useState<"write" | "preview">("write");
  const saveLang = useAction("projects.setGenLang", { invalidate: [["config"], ["projects"]] });
  const draft = useAction<{ title: string; body: string }>("tickets.draft");
  const start = useAction<AgentSession>("tickets.study", { invalidate: [["agents"], ["worktrees"]] });
  const create = useAction<{ key: string; id: string; url: string }>("tickets.create", { invalidate: [["tickets", projectId], ["overview", projectId], ["agents"], ["worktrees"]] });
  const busy = draft.isPending || start.isPending || create.isPending;
  const fromText = !branch && !study;
  const studying = fromText && studyOn;
  const placeOk = !!place && (!place.kindRequired || !!kind);
  const close = () => !busy && closeNewTicket();
  // Something typed would be lost: Escape and a click outside leave it open, the close button still closes.
  const typed = step === "draft" || !!request.trim();

  const pickPlace = (k: string) => {
    setPicked(k);
    setLastPlace(k);
    setKind(null);
  };
  const setLang = (v: string) => {
    setLangHere(v);
    saveLang.mutate({ projectId, ticket: v });
  };
  const write = () =>
    draft.mutate(
      { projectId, template: tpl?.id, branch, request, language: lang },
      {
        onSuccess: (d) => {
          setTitle(d.title);
          setBody(d.body);
          setView("write");
          setStep("draft");
        },
      },
    );
  const startStudy = () =>
    place &&
    start.mutate(
      { projectId, request, template: tpl?.id, projects: more, source: place.source, conn: place.conn, place: place.id, kind, language: lang },
      {
        onSuccess: (s) => {
          closeNewTicket();
          toast("Ticket study started. The ticket shows under the agent's reply once written", "ok");
          nav.go({ name: "worktrees", key: s.cwd });
        },
      },
    );
  const submit = () =>
    place &&
    create.mutate(
      { projectId, source: place.source, conn: place.conn, place: place.id, kind, title, body, branch, study: study?.id },
      {
        onSuccess: (r) => {
          closeNewTicket();
          toast(branch ? `Created ${r.key} and linked it to ${branch}` : `Created ${r.key}`, "ok");
          if (branch) return;
          if (nav.projectId !== projectId) nav.setProject(projectId);
          nav.go({ name: "tickets", key: r.key });
        },
      },
    );

  const heading = study ? "Review ticket" : branch ? "New ticket from branch" : "New ticket";
  const sub = study ? (
    "Written by the ticket study. Edit it, then create it"
  ) : branch ? (
    <>AI writes it from the work on <span className="mono">{branch}</span>, and the branch gets it</>
  ) : step === "draft" ? (
    "Check what AI wrote before it goes to the tracker"
  ) : (
    "Say what it should ask for. AI writes the title, the description and the acceptance criteria"
  );

  if (!templateList) {
    return (
      <Modal title={heading} sub={sub} width={640} onClose={close}>
        <Loading />
      </Modal>
    );
  }
  if (places.data && !list.length) {
    return (
      <Modal
        title={heading}
        width={520}
        onClose={close}
        footer={
          <button
            className="btn btn-md btn-primary"
            onClick={() => {
              closeNewTicket();
              nav.go({ name: "menu", section: "tools" });
            }}
          >
            Connect a tracker
          </button>
        }
      >
        <p style={{ margin: 0, lineHeight: 1.55 }}>
          No tracker takes tickets for {project?.name ?? "this project"} yet. Connect Jira, Linear, Trello or Asana, or sign in to GitHub for the issues of a GitHub repository.
        </p>
        {!!places.data?.errors.length && <span className="hint">{places.data.errors.join(" · ")}</span>}
      </Modal>
    );
  }

  const kindLabel = place?.source === "jira" || place?.kinds[0]?.id.startsWith("type:") ? "Issue type" : "Label";
  // Each tracker is asked, some once per board or project: the rest of the form can be filled meanwhile.
  const destination = places.isLoading ? (
    <div className="field">
      <span className="flabel">Goes to</span>
      <div className="select menu-select faint" aria-busy="true">
        <span className="ellipsis">Asking your trackers…</span>
        <span className="spinner" />
      </div>
    </div>
  ) : places.error ? (
    <div className="field">
      <span className="flabel">Goes to</span>
      <ErrorBox error={places.error} />
      <button className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => places.refetch()}>
        Retry
      </button>
    </div>
  ) : (
    <div className="col" style={{ gap: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: place?.kinds.length ? "minmax(0, 3fr) minmax(0, 2fr)" : "minmax(0, 1fr)", gap: 12 }}>
        <div className="field">
          <label htmlFor="nt-place">Goes to</label>
          <MenuChoice id="nt-place" className="select menu-select" label="Goes to" value={place ? placeKey(place) : ""} options={list.map((p) => ({ value: placeKey(p), label: p.name }))} onChange={pickPlace} />
        </div>
        {!!place?.kinds.length && (
          <div className="field">
            <label htmlFor="nt-kind">{kindLabel}</label>
            <MenuChoice
              id="nt-kind"
              className="select menu-select"
              label={kindLabel}
              value={kind}
              options={[...(place.kindRequired ? [] : [{ value: "", label: "None" }]), ...place.kinds.map((k) => ({ value: k.id, label: k.name }))]}
              onChange={setKind}
            />
          </div>
        )}
      </div>
      {!!places.data?.errors.length && <span className="hint">Left out: {places.data.errors.join(" · ")}</span>}
    </div>
  );

  const footer =
    step === "form" ? (
      <button className="btn btn-primary btn-md" disabled={!placeOk || !tpl || (fromText && !request.trim()) || busy} onClick={studying ? startStudy : write}>
        {busy ? <span className="spinner" /> : <Icon name="sparkle" size={12} />}
        {studying ? "Start study" : "Write ticket"}
      </button>
    ) : (
      <>
        {!study && (
          <button className="btn btn-md" disabled={busy} onClick={() => setStep("form")}>
            Back
          </button>
        )}
        <button className="btn btn-primary btn-md" disabled={!placeOk || !title.trim() || busy} onClick={submit}>
          {create.isPending && <span className="spinner" />}
          Create ticket
        </button>
      </>
    );

  return (
    <Modal title={heading} sub={sub} width={640} onClose={close} onDismiss={typed ? () => {} : close} footer={footer}>
      {step === "form" ? (
        <>
          <div className="field">
            <span className="flabel" id="nt-type">Type</span>
            <Seg grid label="Type" value={tpl?.id ?? ""} onChange={setTemplate} options={templates.map((t) => ({ value: t.id, label: t.name }))} />
          </div>
          {destination}
          {branch ? (
            <div className="field">
              <label htmlFor="nt-request">
                <span>Notes for AI</span>
                <span className="faint" style={{ fontWeight: 400 }}>optional</span>
              </label>
              <textarea id="nt-request" className="textarea" rows={3} autoFocus placeholder="What the commits don't say: who asked for it, the goal, a link…" value={request} onChange={(e) => setRequest(e.target.value)} />
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="nt-request">What should the ticket ask for?</label>
                <textarea id="nt-request" className="textarea" rows={5} autoFocus placeholder="Let people export the monthly report as CSV from the Reports screen…" value={request} onChange={(e) => setRequest(e.target.value)} />
              </div>
              <label className="check">
                <input type="checkbox" checked={studyOn} onChange={() => setStudyOn(!studyOn)} />
                <span>Study the code before writing</span>
              </label>
              {studyOn && (
                <div className="field">
                  <span className="flabel">Projects to study</span>
                  <div className="col" style={{ gap: 2 }}>
                    <label className="check">
                      <input type="checkbox" checked disabled />
                      <span>
                        {project?.name} <span className="faint">this project</span>
                      </span>
                    </label>
                    {others.map((o) => (
                      <label key={o.id} className="check">
                        <input type="checkbox" checked={more.includes(o.id)} onChange={() => setMore((m) => (m.includes(o.id) ? m.filter((x) => x !== o.id) : [...m, o.id]))} />
                        <span>{o.name}</span>
                      </label>
                    ))}
                  </div>
                  <span className="hint">
                    An agent reads a throwaway checkout of each project's default branch, runs the app or its tests when that helps, and asks you what is unclear. You
                    review the ticket before it is created. The checkouts are deleted after.
                  </span>
                </div>
              )}
            </>
          )}
          <div className="row">
            <span className="muted" id="nt-lang">Write in</span>
            <Seg label="Write in" value={lang} onChange={setLang} options={[...LANGS, { value: "spoken", label: "Spoken" }]} />
          </div>
        </>
      ) : (
        <>
          {destination}
          <div className="field">
            <label htmlFor="nt-title">Title</label>
            <input id="nt-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <label htmlFor="nt-body">Description</label>
              <Seg label="Description view" value={view} onChange={setView} options={[{ value: "write", label: "Write" }, { value: "preview", label: "Preview" }]} />
            </div>
            {view === "write" ? (
              <textarea id="nt-body" className="textarea" rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
            ) : (
              <div className="nt-preview">{body.trim() ? <Markdown text={body} /> : <span className="faint">No description.</span>}</div>
            )}
            <span className="hint">Markdown. Each "- [ ]" line becomes {place?.source === "trello" ? "a checklist item" : "an acceptance criterion"}.</span>
          </div>
        </>
      )}
    </Modal>
  );
}

/** Under a ticket study's log: where its ticket goes, then the draft the agent ended its reply with, to review and create. */
export function TicketStudyCard({ session: s }: { session: AgentSession }) {
  const st = s.study;
  const cfg = useConfig().data;
  const places = useTicketPlaces(s.projectId).data?.places;
  const remove = useAction("agents.remove", { invalidate: [["agents"], ["worktrees"]], success: "Discarded the ticket study" });
  const [discarding, setDiscarding] = useState(false);
  const draft = useMemo(() => {
    const last = blocks(s.lines).filter((b) => b.kind === "ai").at(-1);
    return last?.kind === "ai" ? ticketDraft(last.text) : null;
  }, [s.lines]);
  if (!st) return null;
  const running = s.status === "running" || s.status === "paused";
  const where = places?.find((p) => p.source === st.source && p.conn === st.conn && p.id === st.place)?.name;
  const names = st.checkouts.map((c) => cfg?.projects.find((p) => p.id === c.projectId)?.name ?? c.projectId).join(", ");
  return (
    <div className="ag-finish">
      {draft && !running ? (
        <div className="col" style={{ gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>Ticket ready{where ? ` for ${where}` : ""}</span>
          <strong style={{ fontWeight: 600, lineHeight: 1.4 }}>{draft.title}</strong>
        </div>
      ) : (
        <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
          {running ? `The agent is studying ${names}.` : "The last reply holds no ticket yet: answer the agent, or ask it to write the ticket."} The ticket shows here once
          written{where ? `, for ${where}` : ""}.
        </p>
      )}
      <div className="ag-finish-foot">
        <button className="btn btn-md btn-danger" disabled={remove.isPending} onClick={() => setDiscarding(true)}>
          Discard study
        </button>
        <button className="btn btn-md btn-primary" disabled={!draft || running} onClick={() => draft && openNewTicket({ projectId: s.projectId, study: { id: s.id, to: st, ...draft } })}>
          Review and create…
        </button>
      </div>
      {discarding && (
        <Confirm title="Discard ticket study" sub={names} action="Discard study" busy={remove.isPending} onBack={() => setDiscarding(false)} onConfirm={() => remove.mutate({ id: s.id }, { onSuccess: () => setDiscarding(false) })}>
          The agent stops, and its session and its checkouts of {names} are deleted.
        </Confirm>
      )}
    </div>
  );
}
