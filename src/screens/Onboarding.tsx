import { Activity, useState, type ReactNode } from "react";

import { useAction, useAiCatalog, useConfig } from "../api/hooks";
import type { AiCatalog, UserProfile } from "../api/types";
import { Logo } from "../components/Logo";
import { useProfileForm, useProfiles } from "../components/Profiles";
import { Loading } from "../components/ui";
import { useKeys } from "../lib/keys";
import { useNav } from "../lib/nav";
import { useStored } from "../lib/stored";
import { DictationKeys, GitHosts, JiraConnections, PhoneCard, ThemeChoices } from "./Settings";

/** How a step moves on; no `back` on the first one. `name`: the profile being set up, when not the first launch's. */
type Steps = { back?: () => void; next: () => void; name?: string };

const STEPS = [ThemeStep, ProfileStep, AiStep, GitHostStep, JiraStep, ExtrasStep];

/**
 * First launch, and each fresh profile: theme, profile, AI, Git host, Jira, extras, each skippable.
 * The first project is added after, on Welcome.
 */
export function Onboarding() {
  const { list, active } = useProfiles();
  // Another profile exists: the New profile dialog made this one and already asked its name and identity.
  const [added] = useState(() => list.length > 1);
  const steps = added ? STEPS.filter((s) => s !== ProfileStep) : STEPS;
  // Saved for a restart (the phone card asks for one) to come back to the same step. Read once: a config
  // refetch started by a step's own save can land after the new step was saved, with the one before.
  const [saved, save] = useStored("onboarding.step", 0);
  const [at, go] = useState(() => Math.min(saved, steps.length - 1));
  const setAt = (i: number) => {
    go(i);
    save(i);
  };
  const finish = useAction("ui.set", { invalidate: [["config"]] });
  return (
    <main className="scroll" style={{ flex: 1, display: "flex", justifyContent: "center", padding: "56px 24px 0" }}>
      <div className="col" style={{ width: "100%", maxWidth: 640, gap: 28 }}>
        <div className="onboard-dots" role="img" aria-label={`Step ${at + 1} of ${steps.length}`}>
          {steps.map((_, i) => <i key={i} data-on={i <= at || undefined} />)}
        </div>
        {/* Kept while hidden: Back finds a step as it was left. */}
        {steps.map((Step, i) => (
          <Activity key={i} mode={i === at ? "visible" : "hidden"}>
            <Step back={i ? () => setAt(i - 1) : undefined} next={() => (i < steps.length - 1 ? setAt(i + 1) : finish.mutate({ onboarding: false }))} name={added ? active?.name : undefined} />
          </Activity>
        ))}
      </div>
    </main>
  );
}

function Head({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="welcome-hero">
      <Logo size={56} />
      <div className="col" style={{ gap: 8 }}>
        <h1>{title}</h1>
        <p className="muted">{children}</p>
      </div>
    </div>
  );
}

/** Skip while nothing was entered; Continue once something was, which is kept. */
function Foot({ back, entered, ready = true, busy, onNext }: Steps & { entered: boolean; ready?: boolean; busy?: boolean; onNext: () => void }) {
  return (
    <div className="row onboard-foot">
      {back && <button type="button" className="btn btn-md btn-ghost" onClick={back}>Back</button>}
      <span className="grow" />
      <button type="button" className={`btn btn-md${entered ? " btn-primary" : ""}`} disabled={busy || (entered && !ready)} onClick={onNext}>
        {busy && <span className="spinner" />}
        {entered ? "Continue" : "Skip"}
      </button>
    </div>
  );
}

function ThemeStep(s: Steps) {
  const nav = useNav();
  const [start] = useState(nav.themePref);
  return (
    <>
      <Head title={s.name ? `Set up ${s.name}` : "Welcome to Gitnetix"}>Pick your colors first: each theme shows right away. Every choice in this setup can change later in Settings.</Head>
      <ThemeChoices />
      <Foot {...s} entered={nav.themePref !== start} onNext={s.next} />
    </>
  );
}

function ProfileStep(s: Steps) {
  const active = useProfiles().active!;
  // The identity saved here, when Back led to this step again.
  const mine = useConfig().data?.profiles[0];
  // Left empty, the profile keeps its name: Default on a first launch.
  const f = useProfileForm({ name: "", avatar: active.avatar, hue: active.hue ?? null, git: mine });
  const save = useAction<UserProfile>("userProfiles.save", { invalidate: [["config"]] });
  const go = () => (f.touched ? save.mutate({ id: active.id, name: f.name || active.name, avatar: f.avatar, hue: f.hue, git: f.git }, { onSuccess: s.next }) : s.next());
  return (
    <>
      <Head title="Create your profile">Your commit name and email, projects, connections and settings live in it. Left empty, it stays Default; add others later, for work or a client.</Head>
      <form
        className="profile-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!f.touched || f.ready) go();
        }}
      >
        {f.fields}
      </form>
      <Foot {...s} entered={f.touched} ready={f.ready} busy={save.isPending} onNext={go} />
    </>
  );
}

function AiStep(s: Steps) {
  const cat = useAiCatalog().data;
  const [picked, setPicked] = useState(false);
  const setMain = useAction("ai.setDefault", { invalidate: [["ai"], ["config"]] });
  // Agents run through a CLI. API keys and per-task models stay in Settings.
  const clis = cat?.providers.filter((p) => p.info.bin) ?? [];
  const entered = picked || clis.some((p) => p.status?.status === "connected");
  return (
    <>
      <Head title="Connect your AI">
        It writes your commits, branch names, PRs and release notes, resolves conflicts and runs agents, through the CLIs you already use. Pick the one that does it all.
      </Head>
      {cat ? (
        // One grid for all rows (card | Sign in | Test) so every card gets the same width.
        <div role="radiogroup" aria-label="Main AI" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", alignItems: "center", rowGap: 6 }}>
          {clis.map((p) => (
            <AiRow
              key={p.info.id}
              p={p}
              main={cat.defaultProvider === p.info.id}
              onPick={() => {
                setPicked(true);
                setMain.mutate({ id: p.info.id, routeAll: true });
              }}
            />
          ))}
          <span className="hint" style={{ gridColumn: "1 / -1" }}>API keys, Mistral and a model per task: Settings › AI setup.</span>
        </div>
      ) : (
        <Loading />
      )}
      <Foot {...s} entered={entered} onNext={s.next} />
    </>
  );
}

function AiRow({ p, main, onPick }: { p: AiCatalog["providers"][number]; main: boolean; onPick: () => void }) {
  const { id, name, mono, bin } = p.info;
  const test = useAction<{ ms: number }>("ai.test", { invalidate: [["ai"], ["config"]], success: (r) => `${name} responded in ${(r.ms / 1000).toFixed(1)} s` });
  const signIn = useAction("ai.signIn", { success: "Opened a terminal — sign in there, then press Test" });
  const found = !!p.status?.cliPath;
  return (
    <>
      <button className="radio-card" role="radio" aria-checked={main} disabled={!found} style={{ gridColumn: 1, alignItems: "center", minWidth: 0 }} onClick={onPick}>
        <span className="radio-dot" />
        <span className="mono-badge">{mono}</span>
        <span className="col" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontWeight: 500 }}>{name}</span>
          {p.status?.status === "connected" ? (
            <span className="c-add" style={{ fontSize: 12 }}>Connected</span>
          ) : found ? (
            <span className="hint">Found on this computer</span>
          ) : (
            <span className="hint">
              Install <span className="mono">{bin}</span> to use it
            </span>
          )}
        </span>
      </button>
      {/* Margins, not column-gap: an empty column must take no space. */}
      {test.isError && <button className="btn btn-md" style={{ gridColumn: 2, marginLeft: 8 }} onClick={() => signIn.mutate({ id })}>Sign in</button>}
      {found && (
        <button className="btn btn-md" style={{ gridColumn: 3, marginLeft: 8 }} disabled={test.isPending} onClick={() => test.mutate({ id })}>
          {test.isPending && <span className="spinner" />}
          Test
        </button>
      )}
    </>
  );
}

function JiraStep(s: Steps) {
  const cfg = useConfig().data!;
  return (
    <>
      <Head title="Connect Jira">Your tickets show in Tickets, linked to their branch and release. Trello and Asana are in Settings.</Head>
      <div className="col" style={{ gap: 12 }}>
        <JiraConnections cfg={cfg} />
      </div>
      <Foot {...s} entered={cfg.integrations.jira.length > 0} onNext={s.next} />
    </>
  );
}

function GitHostStep(s: Steps) {
  const cfg = useConfig().data!;
  return (
    <>
      <Head title="Connect GitHub or Azure DevOps">To open pull requests, read reviews and publish releases. Tokens go to your OS keychain.</Head>
      <ul className="list">
        <GitHosts cfg={cfg} />
      </ul>
      <Foot {...s} entered={cfg.integrations.githubConnected || cfg.integrations.azureConnected} onNext={s.next} />
    </>
  );
}

function ExtrasStep(s: Steps) {
  const cfg = useConfig().data!;
  const keys = useKeys().dictation;
  const [start] = useState({ keys, lan: cfg.server.lan });
  return (
    <>
      <Head title="A few last touches">Each one optional, and all in Settings later.</Head>
      <section className="section">
        <div className="col" style={{ gap: 2 }}>
          <h2>Voice dictation</h2>
          <span className="hint">Speak into any text box instead of typing. The words turn into text on this computer.</span>
        </div>
        <ul className="list">
          <DictationKeys />
        </ul>
      </section>
      <PhoneCard server={cfg.server} />
      <Foot {...s} entered={keys !== start.keys || cfg.server.lan !== start.lan} onNext={s.next} />
    </>
  );
}
