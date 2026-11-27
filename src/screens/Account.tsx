import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAction, useConfig } from "../api/hooks";
import { openExternal, rpc } from "../api/transport";
import type { Project } from "../api/types";
import { Icon } from "../components/Icon";
import { MenuChoice } from "../components/AgentPicker";
import { day } from "../components/Charts";
import { SheetBox, SheetLabel, SheetLink, SheetRow, SheetSwitch } from "../components/Sheet";
import { ago, Confirm, ErrorBox, Loading, Modal, Seg } from "../components/ui";
import { bytes } from "../lib/format";
import { copyToClipboard, toast } from "../lib/toast";
import { DeviceSignIn } from "./Connections";
import { CloneModal } from "./Welcome";

/* The Gitnetix account: sign-in, plan, the encryption key that keeps the server blind, sync, and enterprises.
   The engine does the work (crates/core/src/account.rs); these pages show where things stand and ask. */

type Role = "owner" | "admin" | "member" | "viewer";
export interface AccountStatus {
  signedIn: boolean;
  server: string;
  user?: { id: string; login: string; name: string | null; avatarUrl: string | null };
  plan?: { id: "free" | "pro" | "team" };
  billing?: { plan: string; status: string | null; seats: number | null; currentPeriodEnd: string | null };
  enterprises?: { id: string; name: string; role: Role }[];
  /** none: no key made yet; waiting: another install must approve this one; changed: the account shows a key this install never trusted. */
  keys?: "none" | "waiting" | "unlocked" | "changed" | "lost";
  fingerprint?: string;
  accountFingerprint?: string | null;
  pending?: { id: string; userAgent: string; createdAt: string; publicKey: string; fingerprint: string }[];
}
interface Synced { missing: { id: string; name: string; remote: string }[] }
interface Invitation { id: string; enterpriseId: string; enterpriseName: string; role: Role }
interface Member { userId: string; login: string; name: string | null; role: Role; publicKey?: string }
/** What the enterprise asks of each member's Gitnetix on its projects (crates/core/src/account.rs `Policies`). All off by default. */
interface Policies {
  protectedBranches: boolean;
  signedCommits: boolean;
  /** None: any type. */
  branchTypes: string[];
  /** null: any agent; [] none. */
  agents: string[] | null;
  agentsAsk: boolean;
}
interface EnterpriseView {
  id: string;
  name: string;
  role: Role;
  members: Member[];
  invitations: { id: string; login?: string; email?: string; role: Role }[];
  projects: { id: string; name?: string; remote?: string; here?: boolean; locked?: boolean }[];
  /** This computer's projects already on the list. */
  onList: string[];
  waiting: { userId: string; login: string; publicKey: string; fingerprint: string; keysCreatedAt: string }[];
  policies: Policies;
  seats: number;
  billing: { plan: string; status: string | null };
  keyEpoch: number;
  rotateKey: boolean;
  hasKey: boolean;
}

// Not on focus: offline, each try would only log one more failure. Actions on the account refresh it, and so does coming back to its pages.
export const useAccount = () => useQuery({ queryKey: ["account"], queryFn: () => rpc<AccountStatus>("account.status"), staleTime: 30_000, retry: 1, refetchOnWindowFocus: false });

/** Back from Stripe's checkout or billing portal in the browser, the plan shows at once: the queries' own refetch only follows the page's visibility. */
function useRefreshOnFocus() {
  const qc = useQueryClient();
  useEffect(() => {
    const back = () => {
      void qc.invalidateQueries({ queryKey: ["account"] });
      void qc.invalidateQueries({ queryKey: ["enterprise"] });
    };
    addEventListener("focus", back);
    return () => removeEventListener("focus", back);
  }, [qc]);
}

/** Keeps this install in step with the account: on start, every 5 minutes, back on the window, and 5 s after a settings change. */
export function useAccountSync() {
  const qc = useQueryClient();
  const a = useAccount().data;
  const on = a?.keys === "unlocked" && a.plan?.id !== "free";
  const cfg = useConfig().data;
  const q = useQuery({ queryKey: ["accountSync"], queryFn: () => rpc<Synced>("account.sync"), enabled: on, refetchInterval: 5 * 60_000, staleTime: 60_000, retry: 1 });
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => qc.invalidateQueries({ queryKey: ["accountSync"] }), 5_000);
    return () => clearTimeout(t);
  }, [cfg, on, qc]);
  return q;
}

/** The server's address without its scheme, as the row shows it. */
const host = (url: string) => url.replace(/^https?:\/\//, "");

export function AccountPage({ open }: { open: (id: string, title?: string) => void }) {
  const qc = useQueryClient();
  const a = useAccount();
  useRefreshOnFocus();
  if (a.isPending) return <Loading />;
  if (a.error) return <ErrorBox error={a.error} />;
  const s = a.data;
  if (!s.signedIn)
    return (
      <>
        <p className="hint conn-intro">
          Gitnetix works without an account. With Pro, an account keeps your project list and settings on every computer and backs up your data. Reaching your computer from your phone anywhere is coming soon. Team adds
          a shared project list for your company. Your lists, settings and backups are encrypted on your devices, so the Gitnetix server can't read them. The first 7 days are free.
        </p>
        <DeviceSignIn method="account" name="GitHub" site="GitHub" onDone={() => qc.invalidateQueries({ queryKey: ["account"] })} />
        <p className="hint conn-intro">Server: <span className="mono">{host(s.server)}</span></p>
      </>
    );
  return (
    <div className="conn-grid">
      <AccountBox s={s} open={open} />
      <KeysBox s={s} />
      {s.keys === "unlocked" && s.plan?.id !== "free" && <SyncBox />}
      {s.plan?.id !== "free" && <LiveBox />}
      {s.keys === "unlocked" && <BackupsBox paid={s.plan?.id !== "free"} />}
      <EnterprisesBox s={s} open={open} />
    </div>
  );
}

function AccountBox({ s, open }: { s: AccountStatus; open: (id: string, title?: string) => void }) {
  const signOut = useAction("account.signOut", { invalidate: [["account"], ["accountSync"], ["live"], ["backups"]] });
  const checkout = useAction<{ url: string }>("account.checkout");
  const portal = useAction<{ url: string }>("account.portal");
  const plan = s.plan?.id ?? "free";
  const own = s.billing?.plan && s.billing.plan !== "free";
  const end = s.billing?.currentPeriodEnd && day(s.billing.currentPeriodEnd, { month: "long", day: "numeric", year: "numeric" });
  return (
    <SheetBox className="conn-box" title="Gitnetix account" sub={`@${s.user?.login}`} aside={<button className="btn btn-sm" disabled={signOut.isPending} onClick={() => signOut.mutate({})}>Sign out</button>}>
      <div className="sheet-col">
        <SheetRow label="Plan" tip="Free is the app alone; Pro adds sync and backups, and soon your phone anywhere; Team is bought for an enterprise and covers its members">
          <span className="sheet-v">
            {plan === "free" ? "Free" : plan === "pro" ? "Pro" : own ? "Team" : "Team, through your enterprise"}
            {s.billing?.status === "trialing" && ", free trial"}
          </span>
        </SheetRow>
        {own && end && (
          <SheetRow label={s.billing?.status === "trialing" ? "Trial ends" : "Renews"}>
            <span className="sheet-v">{end}</span>
          </SheetRow>
        )}
        {plan === "free" ? (
          <SheetRow label="Pro" tip="Sync and backups, and soon your phone anywhere. The first subscription starts with 7 free days">
            <button className="btn btn-sm btn-primary" disabled={checkout.isPending} onClick={() => checkout.mutate({ plan: "pro" }, { onSuccess: (r) => openExternal(r.url) })}>
              Subscribe
            </button>
          </SheetRow>
        ) : (
          own && (
            <SheetRow label="Billing" tip="Card, invoices, plan changes and cancelling, on Stripe">
              <button className="btn btn-sm" disabled={portal.isPending} onClick={() => portal.mutate({}, { onSuccess: (r) => openExternal(r.url) })}>
                Manage
                <Icon name="external" size={12} />
              </button>
            </SheetRow>
          )
        )}
        <SheetRow label="Server" tip="Where the account lives. GITNETIX_API_URL points Gitnetix at another one">
          <span className="sheet-v mono">{host(s.server)}</span>
        </SheetRow>
        <SheetLink label="Security log" tip="Sign-ins, approved installs, devices and plan changes on this account" value="Last year" onClick={() => open("accountLog")} />
      </div>
    </SheetBox>
  );
}

/** The key every install of the account shares, never the server: made once, then given to each new install by one that has it. */
function KeysBox({ s }: { s: AccountStatus }) {
  const [shown, setShown] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [resetting, setResetting] = useState(false);
  const setup = useAction<{ recoveryKey: string }>("account.setup", { invalidate: [["account"]] });
  const reset = useAction<{ recoveryKey: string }>("account.reset", { invalidate: [["account"], ["accountSync"]] });
  const recover = useAction("account.recover", { invalidate: [["account"]], success: "Unlocked with your recovery key" });
  const approve = useAction("account.approve", { invalidate: [["account"]], success: "Approved: that install now opens your data" });
  const trust = useAction("account.trustNewKey", { invalidate: [["account"]] });
  return (
    <SheetBox className="conn-box" title="Encryption" sub={s.keys === "unlocked" ? "On" : s.keys === "none" ? "Not set up" : "Locked here"}>
      <div className="sheet-col">
        {s.keys === "none" && (
          <>
            <p className="hint">Your project list, settings and backups are encrypted with a key only your devices hold. Set it up once; you get a recovery key to keep.</p>
            <SheetRow label="Key" tip="Made on this computer and never sent in clear">
              <button className="btn btn-sm btn-primary" disabled={setup.isPending} onClick={() => setup.mutate({}, { onSuccess: (r) => setShown(r.recoveryKey) })}>
                Set up encryption
              </button>
            </SheetRow>
          </>
        )}
        {s.keys === "waiting" && (
          <>
            <p className="hint">
              Approve this computer from one where you are signed in: Settings, Gitnetix account. Approve it only if that screen shows the same code: <span className="mono">{s.fingerprint}</span>
            </p>
            <SheetLabel tip="If no other install can approve this one">Or use your recovery key</SheetLabel>
            <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (typed.trim()) recover.mutate({ recoveryKey: typed.trim() }, { onSuccess: () => setTyped("") }); }}>
              <input className="input mono" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" aria-label="Recovery key" data-no-mic value={typed} onChange={(e) => setTyped(e.target.value)} />
              <button type="submit" className="btn btn-sm" disabled={!typed.trim() || recover.isPending}>Unlock</button>
            </form>
            <SheetRow label="Lost them all" tip="Every computer and the recovery key are gone: start over with a new key. What the old key encrypted can't be read again, so it is deleted">
              <button className="btn btn-sm btn-ghost" onClick={() => setResetting(true)}>Start over</button>
            </SheetRow>
          </>
        )}
        {s.keys === "lost" && <p className="hint">This computer lost its own key, so it can't open the account key it was given. Sign out, sign in again, and approve it from another computer.</p>}
        {s.keys === "changed" && (
          <>
            <p className="hint">
              Your account shows a different key than the one this computer trusted. If you started over on another computer, trust the new key, then approve this computer from there. If you didn't, someone may be
              trying to read your data: don't.
            </p>
            <SheetRow label="New key" tip="Its code, to compare with the computer that made it">
              <span className="sheet-v mono">{s.accountFingerprint}</span>
              <button className="btn btn-sm" onClick={() => trust.mutate({})}>Trust it</button>
            </SheetRow>
          </>
        )}
        {s.keys === "unlocked" && (
          <>
            <SheetRow label="Account key" tip="Its code: a teammate's admin compares it before giving you an enterprise's key">
              <span className="sheet-v mono">{s.accountFingerprint}</span>
            </SheetRow>
            {!!s.pending?.length && <SheetLabel tip="Approve one only if its screen shows the same code">Waiting for approval</SheetLabel>}
            {s.pending?.map((p) => (
              <SheetRow key={p.id} label={p.userAgent || "Another install"} tip={`Signed in ${ago(p.createdAt)}`}>
                <span className="sheet-v mono">{p.fingerprint}</span>
                <button className="btn btn-sm btn-primary" disabled={approve.isPending} onClick={() => approve.mutate({ sessionId: p.id, publicKey: p.publicKey })}>Approve</button>
              </SheetRow>
            ))}
          </>
        )}
      </div>
      {shown && (
        <Modal
          title="Your recovery key"
          sub="Shown once"
          footer={<button className="btn btn-md btn-primary" onClick={() => setShown(null)}>I saved it</button>}
        >
          <div className="col" style={{ gap: 12 }}>
            <p className="m-text">Keep it in a password manager or on paper. If you lose every computer, it is the only way back to your encrypted data: Gitnetix can't recover it for you.</p>
            <div className="row" style={{ gap: 8 }}>
              <span className="mono" style={{ fontSize: 18, letterSpacing: 1 }}>{shown}</span>
              <button className="btn btn-sm" onClick={() => copyToClipboard(shown)}>
                <Icon name="copy" size={12} />
                Copy
              </button>
            </div>
          </div>
        </Modal>
      )}
      {resetting && (
        <Confirm
          title="Start over with a new key?"
          action="Start over"
          busy={reset.isPending}
          onBack={() => setResetting(false)}
          onConfirm={() => reset.mutate({}, { onSuccess: (r) => { setResetting(false); setShown(r.recoveryKey); } })}
        >
          Your synced project list and settings are deleted from the account, since nothing can open them any more. Your enterprises' admins give you their keys again. Projects on this computer stay.
        </Confirm>
      )}
    </SheetBox>
  );
}

function SyncBox() {
  const q = useAccountSync();
  const projects = useConfig().data?.projects ?? [];
  const [cloning, setCloning] = useState<string | null>(null);
  const forget = useAction("account.forgetProject", { invalidate: [["accountSync"]] });
  const missing = q.data?.missing ?? [];
  return (
    <SheetBox
      className="conn-box"
      title="Sync"
      sub={q.isFetching ? "Syncing…" : q.error ? "Failed" : "On"}
      aside={<button className="btn btn-sm" disabled={q.isFetching} onClick={() => q.refetch()}>Sync now</button>}
    >
      <div className="sheet-col">
        {q.error && <ErrorBox error={q.error} />}
        <SheetRow label="What syncs" tip="Every project with an origin and its settings, your theme and language, AI templates and routing, worktree paths. Never tokens: each computer signs in to its Git hosts itself">
          <span className="sheet-v">Projects, settings</span>
        </SheetRow>
        {!!missing.length && <SheetLabel tip="Projects on your other computers">Not on this computer</SheetLabel>}
        {missing.map((m) => (
          <SheetRow key={m.id} label={m.name} tip={m.remote}>
            <button className="btn btn-sm" onClick={() => setCloning(m.remote)}>Clone</button>
            <button className="btn btn-sm btn-ghost" title="Forget it on the account; a computer that has it adds it back" disabled={forget.isPending} onClick={() => forget.mutate({ id: m.id })}>Forget</button>
          </SheetRow>
        ))}
      </div>
      {cloning && <CloneModal base={projects[0]?.path.replace(/[\\/][^\\/]+$/, "") || "~"} url={cloning} onClose={() => setCloning(null)} onDone={() => { setCloning(null); q.refetch(); }} />}
    </SheetBox>
  );
}

function EnterprisesBox({ s, open }: { s: AccountStatus; open: (id: string, title?: string) => void }) {
  const invites = useQuery({ queryKey: ["invitations"], queryFn: () => rpc<Invitation[]>("account.invitations") });
  const accept = useAction("account.acceptInvite", { invalidate: [["invitations"], ["account"]], success: "Joined" });
  const decline = useAction("account.declineInvite", { invalidate: [["invitations"]] });
  const create = useAction<{ id: string; name: string }>("account.createEnterprise", { invalidate: [["account"]] });
  const [name, setName] = useState<string | null>(null);
  const unlocked = s.keys === "unlocked";
  return (
    <SheetBox
      className="conn-box"
      title="Enterprises"
      sub="shared project lists"
      aside={<button className="btn btn-sm" disabled={!unlocked} title={unlocked ? undefined : "Set up encryption first"} onClick={() => setName("")}>New</button>}
    >
      <div className="sheet-col">
        {invites.data?.map((i) => (
          <SheetRow key={i.id} label={i.enterpriseName} tip={`Invites you as ${i.role}`}>
            <button className="btn btn-sm btn-primary" disabled={accept.isPending} onClick={() => accept.mutate({ id: i.id })}>Join</button>
            <button className="btn btn-sm btn-ghost" disabled={decline.isPending} onClick={() => decline.mutate({ id: i.id })}>Decline</button>
          </SheetRow>
        ))}
        {s.enterprises?.map((e) => <SheetLink key={e.id} label={e.name} value={roleName(e.role)} onClick={() => open(`enterprise:${e.id}`, e.name)} />)}
        {!s.enterprises?.length && !invites.data?.length && <p className="hint">None yet. An enterprise shares a project list with your team; it needs the Team plan.</p>}
      </div>
      {name !== null && (
        <Modal
          title="New enterprise"
          onClose={() => setName(null)}
          footer={
            <button type="submit" form="enterprise-form" className="btn btn-md btn-primary" disabled={!name.trim() || create.isPending}>
              {create.isPending && <span className="spinner" />}
              Create
            </button>
          }
        >
          <form id="enterprise-form" className="field" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate({ name: name.trim() }, { onSuccess: (r) => { setName(null); open(`enterprise:${r.id}`, r.name); } }); }}>
            <label htmlFor="enterprise-name">Name</label>
            <input id="enterprise-name" className="input" autoFocus data-no-mic value={name} onChange={(e) => setName(e.target.value)} />
            <p className="hint">You own it. Its own key is made on this computer, and the server can't read its project list.</p>
          </form>
        </Modal>
      )}
    </SheetBox>
  );
}

const ROLES = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
  { value: "viewer", label: "Viewer" },
];
const rank = (r: Role) => ({ viewer: 0, member: 1, admin: 2, owner: 3 })[r];
const roleName = (r: Role) => r[0].toUpperCase() + r.slice(1);

export function EnterprisePage({ id, project, back, open }: { id: string; project?: Project; back: () => void; open: (id: string, title?: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["enterprise", id], queryFn: () => rpc<EnterpriseView>("account.enterprise", { id }) });
  useRefreshOnFocus();
  const me = useAccount().data?.user?.id;
  const refresh = { invalidate: [["enterprise", id], ["account"]] };
  const invite = useAction("account.invite", { ...refresh, success: "Invited: they accept it from their Gitnetix account" });
  const revoke = useAction("account.revokeInvite", refresh);
  const setRole = useAction("account.setRole", refresh);
  const remove = useAction("account.removeMember", refresh);
  const share = useAction("account.shareKey", { ...refresh, success: "Key given" });
  const rotate = useAction("account.rotateKey", { ...refresh, success: "New key made; the list was encrypted again" });
  const add = useAction("account.addTeamProject", refresh);
  const drop = useAction("account.removeTeamProject", refresh);
  const checkout = useAction<{ url: string }>("account.checkout");
  const portal = useAction<{ url: string }>("account.portal");
  const del = useAction("account.deleteEnterprise", { invalidate: [["account"]] });
  const projects = useConfig().data?.projects ?? [];
  const [who, setWho] = useState("");
  const [role, setNewRole] = useState<Role>("member");
  const [giving, setGiving] = useState<EnterpriseView["waiting"][number] | null>(null);
  const [cloning, setCloning] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [seats, setSeats] = useState(5);
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const e = q.data;
  const admin = rank(e.role) >= 2;
  const team = e.billing.plan === "team";
  const sendInvite = () => {
    const v = who.trim().replace(/^@/, "");
    if (v) invite.mutate({ enterpriseId: id, ...(v.includes("@") ? { email: v } : { login: v }), role }, { onSuccess: () => setWho("") });
  };
  return (
    <div className="conn-grid">
      <SheetBox
        className="conn-box"
        title="Team projects"
        sub={e.hasKey ? `${e.projects.length}` : "Locked"}
        aside={project && !e.onList.includes(project.id) && e.hasKey && rank(e.role) >= 1 && team && <button className="btn btn-sm" disabled={add.isPending} onClick={() => add.mutate({ enterpriseId: id, projectId: project.id })}>Add {project.name}</button>}
      >
        <div className="sheet-col">
          {!e.hasKey && <p className="hint">An admin gives you this enterprise's key once they checked your account key's code. Until then its list stays locked.</p>}
          {admin && e.rotateKey && (
            <SheetRow label="Someone left" tip="Make a new key so they can't open what is added from now on; the list is encrypted again with it">
              <button className="btn btn-sm btn-primary" disabled={rotate.isPending} onClick={() => rotate.mutate({ enterpriseId: id })}>New key</button>
            </SheetRow>
          )}
          {e.projects.map((p) =>
            p.locked ? (
              <SheetRow key={p.id} label="Locked project" tip="Encrypted with a key you don't have" />
            ) : (
              <SheetRow key={p.id} label={p.name ?? ""} tip={p.remote}>
                {p.here ? <span className="sheet-v">On this computer</span> : <button className="btn btn-sm" onClick={() => setCloning(p.remote ?? "")}>Clone</button>}
                {rank(e.role) >= 1 && <button className="btn btn-sm btn-ghost" aria-label={`Remove ${p.name} from the team list`} onClick={() => drop.mutate({ enterpriseId: id, id: p.id })}><Icon name="trash" size={12} /></button>}
              </SheetRow>
            ),
          )}
          {e.hasKey && !e.projects.length && <p className="hint">No projects yet.{project && " Add the open project from here."}</p>}
        </div>
      </SheetBox>

      <SheetBox className="conn-box" title="Members" sub={`${e.members.length} of ${e.seats}`}>
        <div className="sheet-col">
          {e.members.map((m) =>
            admin && m.role !== "owner" && m.userId !== me && rank(e.role) > rank(m.role) ? (
              <SheetRow key={m.userId} label={`@${m.login}`}>
                <MenuChoice className="sheet-val" alignRight label={`Role of @${m.login}`} value={m.role} options={ROLES.filter((r) => rank(r.value as Role) <= rank(e.role))} onChange={(v) => setRole.mutate({ enterpriseId: id, userId: m.userId, role: v })} />
                <button className="btn btn-sm btn-ghost" aria-label={`Remove @${m.login}`} onClick={() => remove.mutate({ enterpriseId: id, userId: m.userId })}><Icon name="trash" size={12} /></button>
              </SheetRow>
            ) : (
              <SheetRow key={m.userId} label={`@${m.login}`}>
                <span className="sheet-v">{roleName(m.role)}</span>
                {m.userId === me && m.role !== "owner" && <button className="btn btn-sm btn-ghost" onClick={() => remove.mutate({ enterpriseId: id, userId: m.userId }, { onSuccess: back })}>Leave</button>}
              </SheetRow>
            ),
          )}
          {admin && (
            <>
              <SheetLabel tip="By GitHub login or email; they accept it from their own Gitnetix account">Invite</SheetLabel>
              <form className="row" style={{ gap: 8 }} onSubmit={(ev) => { ev.preventDefault(); sendInvite(); }}>
                <input className="input" placeholder="GitHub login or email" aria-label="GitHub login or email" data-no-mic value={who} onChange={(ev) => setWho(ev.target.value)} />
                <button type="submit" className="btn btn-sm" disabled={!who.trim() || invite.isPending}>Invite</button>
              </form>
              <Seg label="Invited as" value={role} options={ROLES.filter((r) => rank(r.value as Role) <= rank(e.role)) as { value: Role; label: string }[]} onChange={setNewRole} />
              {e.invitations.map((i) => (
                <SheetRow key={i.id} label={i.login ? `@${i.login}` : (i.email ?? "")} tip="Invited, not joined yet">
                  <span className="sheet-v">{roleName(i.role)}</span>
                  <button className="btn btn-sm btn-ghost" onClick={() => revoke.mutate({ enterpriseId: id, id: i.id })}>Cancel</button>
                </SheetRow>
              ))}
            </>
          )}
        </div>
      </SheetBox>

      {e.hasKey && <PoliciesBox id={id} policies={e.policies} admin={admin} project={project} />}

      {admin && !!e.waiting.length && (
        <SheetBox className="conn-box" title="Waiting for the key" sub={`${e.waiting.length}`}>
          <div className="sheet-col">
            {e.waiting.map((w) => (
              <SheetRow key={w.userId} label={`@${w.login}`} tip="Give the key once they read you the same code from their Gitnetix account">
                <span className="sheet-v mono">{w.fingerprint}</span>
                <button className="btn btn-sm btn-primary" onClick={() => setGiving(w)}>Give key</button>
              </SheetRow>
            ))}
          </div>
        </SheetBox>
      )}

      <SheetBox className="conn-box" title="Plan" sub={team ? `Team, ${e.seats} seats` : "No plan"}>
        <div className="sheet-col">
          {!team && admin && (
            <SheetRow label="Team" tip="Per seat and month. Members get the Pro features too. The first subscription starts with 7 free days">
              <input className="input" type="number" min={Math.max(1, e.members.length)} aria-label="Seats" style={{ width: 70 }} value={seats} onChange={(ev) => setSeats(Number(ev.target.value))} />
              <button className="btn btn-sm btn-primary" disabled={checkout.isPending} onClick={() => checkout.mutate({ plan: "team", enterpriseId: id, seats }, { onSuccess: (r) => openExternal(r.url) })}>Subscribe</button>
            </SheetRow>
          )}
          {team && admin && (
            <SheetRow label="Billing" tip="Seats, card, invoices and cancelling, on Stripe">
              <button className="btn btn-sm" onClick={() => portal.mutate({ enterpriseId: id }, { onSuccess: (r) => openExternal(r.url) })}>
                Manage
                <Icon name="external" size={12} />
              </button>
            </SheetRow>
          )}
          {!admin && <p className="hint">{team ? "Paid by the enterprise." : "An admin subscribes the enterprise to Team."}</p>}
          {admin && team && <SheetLink label="Log" tip="Who did what in the enterprise: members, roles, keys, policies, projects" value="Last year" onClick={() => open(`enterpriseLog:${id}`, `${e.name} log`)} />}
          {e.role === "owner" && (
            <SheetRow label="Delete" tip="Deletes the enterprise, its list and its key for everyone, and ends its subscription">
              <button className="btn btn-sm btn-danger" onClick={() => setDeleting(true)}>Delete enterprise</button>
            </SheetRow>
          )}
        </div>
      </SheetBox>

      {giving && (
        <Modal
          title={`Give @${giving.login} the key?`}
          onClose={() => setGiving(null)}
          footer={
            <>
              <button className="btn btn-md" onClick={() => setGiving(null)}>Back</button>
              <button className="btn btn-md btn-primary" disabled={share.isPending} onClick={() => share.mutate({ enterpriseId: id, userId: giving.userId, publicKey: giving.publicKey }, { onSuccess: () => setGiving(null) })}>Codes match, give it</button>
            </>
          }
        >
          <div className="col" style={{ gap: 12 }}>
            <p className="m-text">Ask @{giving.login} to read you the code of their account key, from Settings, Gitnetix account. Give the key only if it is this one:</p>
            <span className="mono" style={{ fontSize: 18, letterSpacing: 1 }}>{giving.fingerprint}</span>
            {Date.now() - Date.parse(giving.keysCreatedAt) < 7 * 86_400_000 && <p className="hint">Their key is less than a week old: check it by voice, not by message.</p>}
          </div>
        </Modal>
      )}
      {cloning !== null && <CloneModal base={projects[0]?.path.replace(/[\\/][^\\/]+$/, "") || "~"} url={cloning} onClose={() => setCloning(null)} onDone={() => { setCloning(null); qc.invalidateQueries({ queryKey: ["enterprise", id] }); }} />}
      {deleting && (
        <Confirm title={`Delete ${e.name}?`} action="Delete enterprise" busy={del.isPending} onBack={() => setDeleting(false)} onConfirm={() => del.mutate({ enterpriseId: id }, { onSuccess: back })}>
          Its project list, its key and every membership go, for everyone, and its subscription ends. The repositories themselves stay where they are.
        </Confirm>
      )}
    </div>
  );
}

const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "agy", label: "Antigravity" },
  { id: "copilot", label: "Copilot" },
  { id: "ollama", label: "Ollama" },
];

/** The enterprise's policies: admins turn them on, members see what applies. Each member's Gitnetix enforces them on the projects of the list. */
function PoliciesBox({ id, policies: p, admin, project }: { id: string; policies: Policies; admin: boolean; project?: Project }) {
  const save = useAction("account.setPolicies", { invalidate: [["enterprise", id], ["accountSync"]], success: "Saved: each member's Gitnetix applies it at its next sync" });
  const set = (patch: Partial<Policies>) => save.mutate({ enterpriseId: id, policies: { ...p, ...patch } });
  const shown = p.branchTypes.join(" ");
  const [types, setTypes] = useState(shown);
  useEffect(() => setTypes(shown), [shown]);
  const saveTypes = () => {
    const list = types.split(/[\s,]+/).filter(Boolean);
    if (list.join(" ") !== shown) set({ branchTypes: list });
  };
  // Turned on, the list starts from the open project's own types.
  const firstTypes = project?.branchTypes.list.map((t) => t.id).filter((t) => t !== "release") ?? ["feat", "fix", "chore"];
  const on = [p.protectedBranches, p.signedCommits, p.branchTypes.length > 0, p.agents !== null, p.agentsAsk].filter(Boolean).length;
  const off = !admin || save.isPending;
  return (
    <SheetBox className="conn-box" title="Policies" sub={on ? `${on} on` : "None"}>
      <div className="sheet-col">
        <p className="hint">Rules every member's Gitnetix follows on this list's projects. {admin ? "None is on until you turn it on." : "Admins set them."}</p>
        <SheetSwitch label="Protected branches" tip="No push straight to the default branch or a release branch: changes reach them through pull requests" on={p.protectedBranches} disabled={off} flip={() => set({ protectedBranches: !p.protectedBranches })} />
        <SheetSwitch label="Signed commits" tip="Gitnetix signs every commit. Members without a signing key can't commit until they turn on Sign commits in their profile" on={p.signedCommits} disabled={off} flip={() => set({ signedCommits: !p.signedCommits })} />
        <SheetSwitch label="Branch types" tip="New branches of these types only: the new branch dialogs offer just these" on={p.branchTypes.length > 0} disabled={off} flip={() => set({ branchTypes: p.branchTypes.length ? [] : firstTypes })} />
        {p.branchTypes.length > 0 && (
          <form className="sheet-row sub" onSubmit={(ev) => { ev.preventDefault(); saveTypes(); }}>
            <input className="input mono" style={{ flex: 1, marginLeft: 14 }} aria-label="Branch types, separated by spaces" data-no-mic disabled={off} value={types} onChange={(ev) => setTypes(ev.target.value)} onBlur={saveTypes} />
          </form>
        )}
        <SheetSwitch label="Agents" tip="Agents of the providers turned on below only" on={p.agents !== null} disabled={off} flip={() => set({ agents: p.agents ? null : ["claude"] })} />
        {p.agents &&
          AGENTS.map((a) => (
            <SheetSwitch key={a.id} sub label={a.label} on={p.agents!.includes(a.id)} disabled={off} flip={() => set({ agents: p.agents!.includes(a.id) ? p.agents!.filter((x) => x !== a.id) : [...p.agents!, a.id] })} />
          ))}
        <SheetSwitch label="No Bypass" tip="Agents ask before acting, or let their own safety check decide (Auto). Only Claude Code and Copilot can, so other agents don't run" on={p.agentsAsk} disabled={off} flip={() => set({ agentsAsk: !p.agentsAsk })} />
      </div>
    </SheetBox>
  );
}

interface Live { on: boolean; connected: boolean; projects: { id: string; name: string; live: boolean; error: string | null }[] }

/** Live updates: GitHub webhooks for this computer's projects, brought by the relay. Off until turned on: it adds webhooks on GitHub. */
function LiveBox() {
  const q = useQuery({ queryKey: ["live"], queryFn: () => rpc<Live>("account.live") });
  const set = useAction<Live>("account.setLive", { invalidate: [["live"]], success: (r) => (r.on ? "Live updates on" : "Live updates off: the webhooks are removed") });
  const l = q.data;
  return (
    <SheetBox className="conn-box" title="Live updates" sub={!l?.on ? "Off" : l.connected ? "Connected" : "Connecting…"}>
      <div className="sheet-col">
        <SheetSwitch
          label="Live updates"
          tip="Pull requests, checks and pushes show as they happen, without waiting for the next check. Gitnetix adds a webhook to each GitHub repository you administer, and removes them when you turn this off"
          on={!!l?.on}
          disabled={!l || set.isPending}
          flip={() => set.mutate({ on: !l?.on })}
        />
        {set.isPending && <p className="hint">Adding webhooks on GitHub…</p>}
        {l?.on &&
          l.projects.map((p) => (
            <SheetRow key={p.id} label={p.name} tip={p.error ?? "A webhook brings its changes"}>
              <span className={`sheet-v${p.live ? "" : " none"}`}>{p.live ? "Live" : "Checked as before"}</span>
            </SheetRow>
          ))}
      </div>
    </SheetBox>
  );
}

interface AuditEntry { at: string; type: string; actorLogin?: string; target?: string; ip?: string }

/** What each logged action reads as (the server's audit types). */
const AUDIT: Record<string, string> = {
  signed_in: "Signed in",
  session_revoked: "Signed out an install",
  keys_created: "Made the account key",
  install_approved: "Approved an install",
  recovery_used: "Used the recovery key",
  keys_reset: "Started over with a new key",
  device_added: "Added a computer",
  device_paired: "Paired a phone",
  device_removed: "Removed a device",
  plan_changed: "Plan changed",
  enterprise_deleted: "Deleted an enterprise",
  enterprise_created: "Created the enterprise",
  enterprise_renamed: "Renamed the enterprise",
  member_invited: "Invited someone",
  invitation_revoked: "Cancelled an invitation",
  member_joined: "Joined",
  member_role_changed: "Changed a role",
  member_removed: "Removed a member",
  member_left: "Left",
  ownership_transferred: "Gave ownership",
  key_shared: "Gave the key",
  key_rotated: "Made a new key",
  member_keys_reset: "Started over with new keys",
  config_saved: "Changed a setting",
  config_removed: "Removed a setting",
  project_saved: "Saved a project",
  project_removed: "Removed a project",
};

/** A log, newest first, 100 at a time: the account's own (security), or an enterprise's for its admins. */
export function AuditPage({ enterpriseId }: { enterpriseId?: string }) {
  const q = useInfiniteQuery({
    queryKey: ["audit", enterpriseId ?? "me"],
    queryFn: ({ pageParam }) => rpc<AuditEntry[]>(enterpriseId ? "account.enterpriseAudit" : "account.audit", { enterpriseId, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1].at : undefined),
  });
  // The server knows a team project by id only: its name comes from the list this account can open.
  const ent = useQuery({ queryKey: ["enterprise", enterpriseId], queryFn: () => rpc<EnterpriseView>("account.enterprise", { id: enterpriseId }), enabled: !!enterpriseId });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const names = new Map((ent.data?.projects ?? []).filter((p) => p.name).map((p) => [p.id, p.name!]));
  const policies = (e: AuditEntry) => e.type === "config_saved" && e.target === "policies";
  const what = (e: AuditEntry) => (policies(e) ? undefined : e.type.startsWith("project_") ? (names.get(e.target ?? "") ?? "a project no longer listed") : e.target);
  const all = q.data.pages.flat();
  return (
    <div className="conn-grid">
      <SheetBox className="conn-box" title={enterpriseId ? "Log" : "Security log"} sub="kept a year">
        <div className="sheet-col">
          {all.map((e, i) => (
            <SheetRow key={i} label={policies(e) ? "Changed the policies" : (AUDIT[e.type] ?? e.type)} tip={new Date(e.at).toLocaleString("en-US")}>
              <span className="sheet-v">{[enterpriseId && e.actorLogin && `@${e.actorLogin}`, what(e), e.ip, ago(e.at)].filter(Boolean).join(" · ")}</span>
            </SheetRow>
          ))}
          {!all.length && <p className="hint">Nothing yet.</p>}
          {q.hasNextPage && (
            <button className="btn btn-sm" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
              Older
            </button>
          )}
        </div>
      </SheetBox>
    </div>
  );
}

interface Backups { used: number; quota: number; maxBackups: number; daily: boolean; backups: { id: string; name: string; size: number; createdAt: string }[] }
type Backup = Backups["backups"][number];

/** Save points of this computer's Gitnetix data on the account, encrypted with the account key, and their restore. */
function BackupsBox({ paid }: { paid: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["backups"], queryFn: () => rpc<Backups>("account.backups") });
  const now = useAction("account.backupNow", { invalidate: [["backups"]], success: "Backed up" });
  const daily = useAction("account.setDailyBackup", { invalidate: [["backups"]] });
  const del = useAction("account.deleteBackup", { invalidate: [["backups"]] });
  const restore = useAction<{ files: number; kept: string }>("account.restore");
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [deleting, setDeleting] = useState<Backup | null>(null);
  const b = q.data;
  const when = (x: Backup) => new Date(x.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  return (
    <SheetBox
      className="conn-box"
      title="Backups"
      sub={b ? `${bytes(b.used)} of ${bytes(b.quota)}` : undefined}
      aside={<button className="btn btn-sm" disabled={!paid || now.isPending} title={paid ? undefined : "Backing up needs the Pro or Team plan"} onClick={() => now.mutate({})}>{now.isPending ? "Backing up…" : "Back up now"}</button>}
    >
      <div className="sheet-col">
        {q.error && <ErrorBox error={q.error} />}
        {paid && <SheetSwitch label="Daily" tip={`Once a day while Gitnetix is open, when your data changed. The newest ${b?.maxBackups ?? 100} are kept`} on={!!b?.daily} disabled={!b || daily.isPending} flip={() => daily.mutate({ on: !b?.daily })} />}
        {b?.backups.map((x) => (
          <SheetRow key={x.id} label={x.name} tip={`${when(x)}, ${bytes(x.size)}`}>
            <span className="sheet-v">{ago(x.createdAt)}</span>
            <button className="btn btn-sm" onClick={() => setRestoring(x)}>Restore</button>
            <button className="btn btn-sm btn-ghost" aria-label={`Delete the backup from ${x.name}, ${when(x)}`} onClick={() => setDeleting(x)}><Icon name="trash" size={12} /></button>
          </SheetRow>
        ))}
        {b && !b.backups.length && <p className="hint">None yet. A backup holds your settings, profiles, projects and agent sessions, encrypted with your account key. Never your tokens.</p>}
      </div>
      {restoring && (
        <Modal
          title={`Restore the backup from ${restoring.name}?`}
          sub={when(restoring)}
          onClose={() => !restore.isPending && setRestoring(null)}
          footer={
            <>
              <button className="btn btn-md" disabled={restore.isPending} onClick={() => setRestoring(null)}>Back</button>
              <button
                className="btn btn-md btn-primary"
                disabled={restore.isPending}
                onClick={() =>
                  restore.mutate({ id: restoring.id }, {
                    onSuccess: (r) => {
                      setRestoring(null);
                      qc.invalidateQueries();
                      toast(`Restored. Your previous files are in ${r.kept}. Restart Gitnetix to see every restored agent session.`, "ok", 12_000);
                    },
                  })
                }
              >
                {restore.isPending && <span className="spinner" />}
                Restore
              </button>
            </>
          }
        >
          <p className="m-text">
            This computer's settings, profiles, projects and agent sessions are replaced by the backup's. The current ones are kept in a folder next to them, so you can go back. Tokens aren't in backups: sign in to your Git hosts and AI tools again if this computer never was.
          </p>
        </Modal>
      )}
      {deleting && (
        <Confirm title={`Delete the backup from ${deleting.name}?`} sub={when(deleting)} action="Delete backup" busy={del.isPending} onBack={() => setDeleting(null)} onConfirm={() => del.mutate({ id: deleting.id }, { onSuccess: () => setDeleting(null) })}>
          It is deleted from your account for good.
        </Confirm>
      )}
    </SheetBox>
  );
}
