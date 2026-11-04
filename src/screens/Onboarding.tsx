import { Activity, useEffect, useState, type ReactNode } from "react";

import { useAction, useAiCatalog, useConfig } from "../api/hooks";
import { openExternal } from "../api/transport";
import type { AiCatalog, Config, ProviderConf, UserProfile } from "../api/types";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { useProfileForm, useProfiles } from "../components/Profiles";
import { Loading } from "../components/ui";
import { useKeys } from "../lib/keys";
import { useNav } from "../lib/nav";
import { useStored } from "../lib/stored";
import { DictationKeys, GitHosts, PhoneCard, ThemeChoices, TicketConnections } from "./Settings";

/** How a step moves on; no `back` on the first one. `name`: the profile being set up, when not the first launch's. */
type Steps = { back?: () => void; next: () => void; name?: string };

const STEPS = [ThemeStep, AgentStep, ProfileStep, GitHostStep, TicketsStep, ExtrasStep];

/**
 * First launch, and each fresh profile: theme, agent, profile, Git host, tickets, extras. Only the agent
 * can't be skipped; it also shows alone at launch while no agent has answered (App's Shell).
 * The first project is added after, on Welcome.
 */
export function Onboarding() {
  const { list, active } = useProfiles();
  // Another profile exists: the New profile dialog made this one and already asked its name and identity.
  const [added] = useState(() => list.length > 1);
  const steps = added ? STEPS.filter((s) => s !== ProfileStep) : STEPS;
  const ready = agentReady(useConfig().data!);
  // Saved for a restart (the phone card asks for one) to come back to the same step. Read once: a config
  // refetch started by a step's own save can land after the new step was saved, with the one before.
  // Never past the agent step without an agent, e.g. a setup left further on before that step existed.
  const [saved, save] = useStored("onboarding.step", 0);
  const [at, go] = useState(() => Math.min(saved, steps.length - 1, ready ? Infinity : steps.indexOf(AgentStep)));
  const setAt = (i: number) => {
    go(i);
    save(i);
  };
  const finish = useAction("ui.set", { invalidate: [["config"]] });
  return (
    <Page>
      <div className="onboard-dots" role="img" aria-label={`Step ${at + 1} of ${steps.length}`}>
        {steps.map((_, i) => <i key={i} data-on={i <= at || undefined} />)}
      </div>
      {/* Kept while hidden: Back finds a step as it was left. */}
      {steps.map((Step, i) => (
        <Activity key={i} mode={i === at ? "visible" : "hidden"}>
          <Step back={i ? () => setAt(i - 1) : undefined} next={() => (i < steps.length - 1 ? setAt(i + 1) : finish.mutate({ onboarding: false }))} name={added ? active?.name : undefined} />
        </Activity>
      ))}
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <main className="scroll" style={{ flex: 1, display: "flex", justifyContent: "center", padding: "56px 24px 0" }}>
      <div className="col" style={{ width: "100%", maxWidth: 640, gap: 28 }}>{children}</div>
    </main>
  );
}

function Head({ title, tag, children }: { title: string; tag?: string; children: ReactNode }) {
  return (
    <div className="welcome-hero">
      <Logo size={56} />
      <div className="col" style={{ gap: 8 }}>
        {tag && <span className="tag accent" style={{ alignSelf: "flex-start" }}>{tag}</span>}
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

/** Where each agent CLI is installed from. */
const INSTALL: Record<string, string> = {
  claude: "https://code.claude.com/docs/en/quickstart",
  codex: "https://learn.chatgpt.com/docs/codex/cli",
  gemini: "https://antigravity.google/download",
  copilot: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
  ollama: "https://ollama.com/download",
};

/** A provider whose CLI answered a test: agents only run through a CLI. */
const cliOk = (c?: ProviderConf | null) => !!c?.connected && c.method === "cli";

/** Whether an agent CLI answered a test. Without one, the app opens on Agent setup. */
export const agentReady = (cfg: Config) => Object.values(cfg.ai.providers).some(cliOk);

/** Agent setup on its own, at launch, for a profile past its first-run setup without an agent. */
export function AgentSetup({ onDone }: { onDone: () => void }) {
  return (
    <Page>
      <AgentStep next={onDone} />
    </Page>
  );
}

/** The one required step: an agent CLI that answers. */
function AgentStep(s: Steps) {
  const ai = useAiCatalog();
  const cat = ai.data;
  const ready = agentReady(useConfig().data!);
  const setMain = useAction("ai.setDefault", { invalidate: [["ai"], ["config"]] });
  // Back from installing or signing in, in another window: the query's own refetch only follows the page's visibility.
  useEffect(() => {
    const check = () => void ai.refetch();
    addEventListener("focus", check);
    return () => removeEventListener("focus", check);
  }, [ai.refetch]);
  const clis = cat?.providers.filter((p) => p.info.bin) ?? [];
  const mainOk = cliOk(cat?.providers.find((p) => p.info.id === cat.defaultProvider)?.conf);
  return (
    <>
      <Head title="Agent setup" tag="The only required step">
        Gitnetix works through an AI coding agent's CLI on this computer. It writes your commits, branch names, pull requests and release notes, fixes conflicts, and builds features in their
        own worktrees. Connect at least one to start. Everything after this step is optional.
      </Head>
      {cat ? (
        // One grid for all rows (card | Sign in | Test or Install) so every card gets the same width.
        <div role="radiogroup" aria-label="Main agent" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", alignItems: "center", rowGap: 6 }}>
          {clis.map((p) => {
            const main = cat.defaultProvider === p.info.id;
            const pick = () => setMain.mutate({ id: p.info.id, routeAll: true });
            // While the main one can't run (Claude, on a first launch without it), the first agent that answers takes its place.
            return <AiRow key={p.info.id} p={p} main={main} onPick={pick} onWorks={main || mainOk ? undefined : pick} />;
          })}
          <span className="hint" style={{ gridColumn: "1 / -1" }}>Install one, sign in with it, then press Test. API keys and a model per task: Settings › AI setup.</span>
        </div>
      ) : (
        <Loading />
      )}
      <Foot {...s} entered ready={ready} onNext={s.next} />
    </>
  );
}

function AiRow({ p, main, onPick, onWorks }: { p: AiCatalog["providers"][number]; main: boolean; onPick: () => void; onWorks?: () => void }) {
  const { id, name, mono, bin } = p.info;
  const inv = [["ai"], ["config"]];
  const toCli = useAction("ai.saveProvider", { invalidate: inv });
  const test = useAction<{ ms: number }>("ai.test", { invalidate: inv, success: (r) => `${name} responded in ${(r.ms / 1000).toFixed(1)} s` });
  const signIn = useAction("ai.signIn", { success: "Opened a terminal — sign in there, then press Test" });
  const found = !!p.status?.cliPath;
  const install = INSTALL[id];
  // Agents need the CLI: a provider set up with an API key moves to it before the test.
  const check = () => {
    const run = () => test.mutate({ id }, { onSuccess: onWorks });
    if (p.conf?.method === "api") toCli.mutate({ id, method: "cli" }, { onSuccess: run });
    else run();
  };
  const busy = test.isPending || toCli.isPending;
  return (
    <>
      <button className="radio-card" role="radio" aria-checked={main} disabled={!found} style={{ gridColumn: 1, alignItems: "center", minWidth: 0 }} onClick={onPick}>
        <span className="radio-dot" />
        <span className="mono-badge">{mono}</span>
        <span className="col" style={{ gap: 2, minWidth: 0 }}>
          <span style={{ fontWeight: 500 }}>{name}</span>
          {cliOk(p.conf) ? (
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
      {found ? (
        <button className="btn btn-md" style={{ gridColumn: 3, marginLeft: 8 }} disabled={busy} onClick={check}>
          {busy && <span className="spinner" />}
          Test
        </button>
      ) : (
        install && (
          <button className="btn btn-md" style={{ gridColumn: 3, marginLeft: 8 }} data-tip={install} onClick={() => openExternal(install)}>
            <Icon name="external" size={12} />
            Install
          </button>
        )
      )}
    </>
  );
}

function TicketsStep(s: Steps) {
  const cfg = useConfig().data!;
  const i = cfg.integrations;
  return (
    <>
      <Head title="Connect Jira, Trello or Asana">Your tickets show in Tickets, linked to their branch and release.</Head>
      <div className="col" style={{ gap: 12 }}>
        <TicketConnections cfg={cfg} />
      </div>
      <Foot {...s} entered={i.jira.length + i.trello.length + i.asana.length > 0} onNext={s.next} />
    </>
  );
}

function GitHostStep(s: Steps) {
  const cfg = useConfig().data!;
  return (
    <>
      <Head title="Connect your Git provider">GitHub, Azure DevOps, GitLab, Bitbucket or Gitea, to open pull requests, read reviews and publish releases. Tokens go to your OS keychain.</Head>
      <ul className="list">
        <GitHosts cfg={cfg} />
      </ul>
      <Foot {...s} entered={[cfg.integrations.githubConnected, cfg.integrations.azureConnected, cfg.integrations.gitlab.connected, cfg.integrations.bitbucket.connected, cfg.integrations.gitea.connected].some(Boolean)} onNext={s.next} />
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
