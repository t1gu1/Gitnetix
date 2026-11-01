import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";

import { useAction, useConfig } from "../api/hooks";
import { rpc } from "../api/transport";
import type { GitProfile, ProjectSummary, UserProfile } from "../api/types";
import { plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { otherMode, resolveTheme } from "../lib/themes";
import { toast } from "../lib/toast";
import { useGravatar } from "./Avatar";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Icon } from "./Icon";
import { Confirm, Modal, Seg } from "./ui";

/** Avatars to pick from, after the default one. */
const EMOJIS = ["🦊", "🐙", "🐼", "🦉", "🐳", "🐝", "🦄", "🐢", "🌵", "🍀", "🌙", "🔥", "⚡", "🚀", "🎨", "🎧", "🧪", "💼", "🏠", "☕", "👾", "🎮", "📚", "🌊"];
/** Colors to pick from by hue, after the theme's accent. */
const HUES = [350, 22, 48, 145, 178, 205, 235, 270, 310];

/** A profile's avatar is "gravatar:" and an email, a photo as an image data URL, an emoji, or "" for the default one. */
const GRAVATAR = "gravatar:";
const PHOTO = "data:image/";
const EMAIL = /^\S+@\S+\.\S+$/;

type Look = Pick<UserProfile, "avatar" | "hue">;

/** A profile's round picture: its photo, Gravatar or emoji, else the default silhouette, on its color. */
export function ProfileAvatar({ profile, size = 24 }: { profile?: Look; size?: number }) {
  const hue = profile?.hue;
  const a = profile?.avatar ?? "";
  const [gravatar, failed] = useGravatar(a.startsWith(GRAVATAR) ? a.slice(GRAVATAR.length) : undefined, size);
  const src = a.startsWith(PHOTO) ? a : gravatar;
  return (
    <span
      className="profile-avatar"
      data-hue={hue != null || undefined}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55), "--p-hue": hue ?? undefined } as CSSProperties}
      aria-hidden
    >
      {src ? (
        <img src={src} alt="" width={size} height={size} onError={failed} />
      ) : a && !a.startsWith(GRAVATAR) ? (
        a
      ) : (
        <svg viewBox="0 0 32 32" width="100%" height="100%">
          <circle cx="16" cy="12.5" r="5.75" />
          <path d="M4.5 31c1-6.4 5.6-10.2 11.5-10.2S26.5 24.6 27.5 31z" />
        </svg>
      )}
    </span>
  );
}

/** `file` center-cropped to a `px` square JPEG data URL: small enough to keep in profiles.json. */
async function squarePhoto(file: File, px = 192) {
  const img = new Image();
  img.src = URL.createObjectURL(file);
  try {
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement("canvas");
    c.width = c.height = px;
    const g = c.getContext("2d")!;
    // JPEG has no transparency: a see-through picture sits on white.
    g.fillStyle = "#fff";
    g.fillRect(0, 0, px, px);
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, px, px);
    return c.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(img.src);
  }
}

/** The profile the app opens on after a switch, greeted once by ProfileSplash. `menu`: the settings were open, open them again. */
let arriving: { profile: UserProfile; menu: boolean } | null = null;

/** The profiles, the active one, and moving the whole app over to another. */
export function useProfiles() {
  const qc = useQueryClient();
  const cfg = useConfig().data;
  const list = cfg?.userProfiles ?? [];
  const active = list.find((p) => p.id === cfg?.activeProfile);
  /** Once the engine is on `p`: drop all that was on screen, the other profile's, and start over on `p` (App keys the screens by profile). */
  const arrive = async (p: UserProfile, menu = false) => {
    arriving = { profile: p, menu };
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "config" });
    // Its project tabs then show with the first frame instead of popping in.
    await qc.prefetchQuery({ queryKey: ["projects"], queryFn: () => rpc<ProjectSummary[]>("projects.list") });
    await qc.refetchQueries({ queryKey: ["config"] });
  };
  // Not a mutation: it goes on after the screens it started from are gone.
  const switchTo = async (p: UserProfile, menu = false) => {
    try {
      await rpc("userProfiles.switch", { id: p.id });
    } catch (e) {
      return toast((e as Error).message, "error");
    }
    await arrive(p, menu);
  };
  return { list, active, switchTo, arrive };
}

/** The active profile's avatar at the right end of the top bar. Its menu switches profiles, makes new ones and opens the settings. */
export function ProfileButton() {
  const nav = useNav();
  const cfg = useConfig().data;
  const { list, active, switchTo } = useProfiles();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [creating, setCreating] = useState(false);
  if (!active) return null;
  const dark = nav.theme === "dark";
  const others = list.filter((p) => p.id !== active.id);
  const items: (MenuItem | { heading: ReactNode })[] = [
    {
      heading: (
        <span className="profile-head">
          <ProfileAvatar profile={active} size={34} />
          <span className="col" style={{ gap: 1, minWidth: 0 }}>
            <strong className="ellipsis">{active.name}</strong>
            <span>{plural(cfg?.projects.length ?? 0, "project")}</span>
          </span>
        </span>
      ),
    },
    "sep",
    ...(others.length ? [{ heading: "Switch to" }] : []),
    ...others.map(
      (p): MenuItem => ({
        id: p.id,
        icon: null,
        text: p.name,
        label: (
          <span className="ctx-profile">
            <ProfileAvatar profile={p} size={18} />
            <span className="ellipsis">{p.name}</span>
          </span>
        ),
        run: () => void switchTo(p),
      }),
    ),
    { id: "new", label: "New profile…", icon: "plus", run: () => setCreating(true) },
    "sep",
    { id: "settings", label: "Settings", icon: "gear", run: () => nav.go({ name: "menu" }) },
    { id: "theme", label: dark ? "Light mode" : "Dark mode", icon: dark ? "sun" : "moon", run: () => nav.setThemePref(otherMode(resolveTheme(nav.themePref, nav.theme))) },
  ];
  return (
    <>
      <button
        className="profile-btn"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        aria-label={`Profile ${active.name}, settings`}
        data-tip={menu ? undefined : active.name}
        onClick={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          setMenu({ x: b.right - 6, y: b.bottom + 4 });
        }}
      >
        <ProfileAvatar profile={active} size={26} />
      </button>
      {menu && <ContextMenu {...menu} alignRight label="Profile" items={items} onClose={() => setMenu(null)} />}
      {creating && <ProfileDialog onClose={() => setCreating(false)} />}
    </>
  );
}

/**
 * Name, Git identity, avatar and color fields, starting from `init`, and what they make.
 * `ready`: the email and the chosen kind of avatar are complete. `touched`: something differs from `init`.
 */
export function useProfileForm(init: { name: string; avatar: string; hue: number | null; git?: GitProfile }) {
  const [name, setName] = useState(init.name);
  const old = init.avatar;
  // One email for commits and Gravatar: a Gravatar picked before identities were part of profiles fills it when empty.
  const start = { name: init.git?.name ?? "", email: init.git?.email || (old.startsWith(GRAVATAR) ? old.slice(GRAVATAR.length) : ""), sign: !!init.git?.sign, signingKey: init.git?.signingKey ?? "" };
  const [git, setGit] = useState(start);
  const [kind, setKind] = useState<"emoji" | "photo" | "gravatar">(old.startsWith(PHOTO) ? "photo" : old.startsWith(GRAVATAR) ? "gravatar" : "emoji");
  const [emoji, setEmoji] = useState(kind === "emoji" ? old : "");
  const [photo, setPhoto] = useState(kind === "photo" ? old : "");
  const chooser = useRef<HTMLInputElement>(null);
  const email = git.email.trim();
  const avatar = kind === "photo" ? photo : kind === "gravatar" ? GRAVATAR + email : emoji;
  const pictured = kind === "photo" ? !!photo : kind === "emoji" || EMAIL.test(email);
  const badEmail = !!email && !EMAIL.test(email);
  const [hue, setHue] = useState(init.hue);
  const fields = (
    <>
      <div className="profile-form-top">
        {/* An email still being typed would ask Gravatar about each keystroke. */}
        <ProfileAvatar profile={{ avatar: pictured ? avatar : "", hue }} size={72} />
        <div className="field grow">
          <label htmlFor="profile-name">Profile name</label>
          <input id="profile-name" className="input" autoFocus maxLength={40} placeholder="Work, Personal, a client…" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <span className="flabel">Git identity</span>
        <div className="profile-git">
          <input className="input" aria-label="Author name" placeholder="Author name" autoComplete="name" value={git.name} onChange={(e) => setGit({ ...git, name: e.target.value })} />
          <input className="input" type="email" aria-label="Email" aria-invalid={badEmail || undefined} placeholder="Email" autoComplete="email" value={git.email} onChange={(e) => setGit({ ...git, email: e.target.value })} />
        </div>
        {/* Wrapped: a label right under .field takes the field-label look. */}
        <div>
          <label className="check">
            <input type="checkbox" checked={git.sign} onChange={() => setGit({ ...git, sign: !git.sign })} />
            <span>Sign commits with my SSH key</span>
          </label>
        </div>
        {git.sign && (
          <input
            className="input mono"
            aria-label="SSH public key"
            // Left empty, the first of id_ed25519, id_ecdsa, id_rsa in ~/.ssh.
            placeholder="~/.ssh/id_ed25519.pub"
            value={git.signingKey}
            onChange={(e) => setGit({ ...git, signingKey: e.target.value })}
          />
        )}
        {/* Agents and the terminal run git themselves: their commits follow the Git config. */}
        <span className="hint">{badEmail ? "Finish the email to save." : "On the commits Gitnetix makes in this profile's projects. Left empty, your Git config decides."}</span>
      </div>
      <div className="field">
        <span className="flabel">
          Avatar
          <Seg
            label="Avatar"
            value={kind}
            onChange={setKind}
            options={[
              { value: "emoji", label: "Emoji" },
              { value: "photo", label: "Photo" },
              { value: "gravatar", label: "Gravatar" },
            ]}
          />
        </span>
        {kind === "emoji" && (
          <div className="profile-avatars" role="radiogroup" aria-label="Emoji">
            {["", ...EMOJIS].map((a) => (
              <button key={a || "default"} type="button" role="radio" aria-checked={emoji === a} aria-label={a || "Default avatar"} onClick={() => setEmoji(a)}>
                {a || <ProfileAvatar profile={{ avatar: "", hue }} size={24} />}
              </button>
            ))}
          </div>
        )}
        {kind === "photo" && (
          <div className="profile-photo">
            <button type="button" className="btn" onClick={() => chooser.current?.click()}>
              <Icon name="image" size={13} />
              {photo ? "Choose another photo…" : "Choose a photo…"}
            </button>
            <span className="hint">Cropped to a circle, kept on this computer.</span>
            <input
              ref={chooser}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) squarePhoto(f).then(setPhoto, () => toast("That file isn't a picture Gitnetix can read", "error"));
              }}
            />
          </div>
        )}
        {kind === "gravatar" && <span className="hint">The picture set for the email above on gravatar.com. Without one, the default avatar shows.</span>}
      </div>
      <div className="field">
        <span className="flabel" id="profile-color">Color</span>
        <div className="profile-hues" role="radiogroup" aria-labelledby="profile-color">
          {[null, ...HUES].map((h) => (
            <button
              key={h ?? "accent"}
              type="button"
              role="radio"
              aria-checked={hue === h}
              aria-label={h === null ? "Theme accent" : `Hue ${h}`}
              data-tip={h === null ? "Theme accent" : undefined}
              data-hue={h !== null || undefined}
              style={{ "--p-hue": h ?? undefined } as CSSProperties}
              onClick={() => setHue(h)}
            />
          ))}
        </div>
      </div>
    </>
  );
  return {
    name: name.trim(),
    avatar,
    hue,
    git: { name: git.name.trim(), email, sign: git.sign, signingKey: git.signingKey.trim() || null },
    ready: pictured && !badEmail,
    touched: name !== init.name || avatar !== old || hue !== init.hue || JSON.stringify(git) !== JSON.stringify(start),
    fields,
  };
}

/**
 * Make a profile, fresh or a copy of profile `from`, then switch to it; or edit `profile`'s name and looks.
 * `menu`: opened from the settings, which open again on the new profile.
 */
export function ProfileDialog({ profile, from, menu, onClose }: { profile?: UserProfile; from?: string; menu?: boolean; onClose: () => void }) {
  const cfg = useConfig().data;
  const { list, switchTo } = useProfiles();
  const source = list.find((p) => p.id === from);
  const f = useProfileForm({
    name: profile?.name ?? (source ? `${source.name} copy` : ""),
    avatar: profile?.avatar ?? "",
    // A new profile gets a color no other one has.
    hue: profile ? (profile.hue ?? null) : (HUES.find((h) => !list.some((p) => p.hue === h)) ?? null),
    // Editing or copying the profile in use: its identity, the only one loaded. A new profile starts without.
    git: (profile?.id ?? from) === cfg?.activeProfile ? cfg?.profiles[0] : undefined,
  });
  const [start, setStart] = useState(from ?? "");
  const save = useAction<UserProfile>("userProfiles.save", { invalidate: [["config"]] });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!f.name || !f.ready) return;
    save.mutate(
      { id: profile?.id, name: f.name, avatar: f.avatar, hue: f.hue, git: f.git, from: profile ? undefined : start || undefined },
      {
        onSuccess: (p) => {
          onClose();
          if (!profile) void switchTo(p, menu);
        },
      },
    );
  };
  return (
    <Modal
      title={profile ? "Edit profile" : "New profile"}
      sub={profile ? undefined : "Its own Git identity, projects, connections, AI setup and settings"}
      onClose={onClose}
      width={500}
      footer={
        <>
          <button type="button" className="btn btn-md" onClick={onClose}>Cancel</button>
          <button type="submit" form="profile-form" className="btn btn-md btn-primary" disabled={!f.name || !f.ready || save.isPending}>
            {save.isPending && <span className="spinner" />}
            {profile ? "Save" : "Create and switch"}
          </button>
        </>
      }
    >
      <form id="profile-form" className="profile-form" onSubmit={submit}>
        {f.fields}
        {!profile && (
          <div className="field">
            <span className="flabel" id="profile-start">Start with</span>
            <div role="radiogroup" aria-labelledby="profile-start" className="col" style={{ gap: 6 }}>
              {[undefined, ...list].map((p) => (
                <button key={p?.id ?? ""} type="button" className="radio-card" role="radio" aria-checked={start === (p?.id ?? "")} style={{ alignItems: "center" }} onClick={() => setStart(p?.id ?? "")}>
                  <span className="radio-dot" />
                  {p && <ProfileAvatar profile={p} size={22} />}
                  <span className="col" style={{ gap: 2, minWidth: 0 }}>
                    <span className="ellipsis" style={{ fontWeight: 500 }}>{p ? `A copy of ${p.name}` : "A fresh start"}</span>
                    <span className="hint">{p ? "Its projects, connections and tokens, AI setup and settings" : "No projects or connections yet, default settings"}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}

/** Asks before deleting `profile`. The active one hands over to another, and the settings open again there. */
export function DeleteProfile({ profile, onClose }: { profile: UserProfile; onClose: () => void }) {
  const qc = useQueryClient();
  const { list, active, arrive } = useProfiles();
  const del = useAction("userProfiles.delete");
  const next = profile.id === active?.id ? list.find((p) => p.id !== profile.id) : undefined;
  return (
    <Confirm
      title="Delete profile"
      sub={profile.name}
      action="Delete profile"
      busy={del.isPending}
      onBack={onClose}
      onConfirm={() =>
        del.mutate(
          { id: profile.id },
          {
            onSuccess: () => {
              if (next) return void arrive(next, true);
              qc.invalidateQueries({ queryKey: ["config"] });
              onClose();
            },
          },
        )
      }
    >
      Gitnetix forgets its project list, connections and saved tokens, AI setup and settings. The repositories stay on disk.
      {next && ` You go on with ${next.name}.`}
    </Confirm>
  );
}

/** Right after a switch: the profile's avatar and name, a moment, over the app it opened on. */
export function ProfileSplash() {
  const nav = useNav();
  const [shown] = useState(() => arriving);
  const [on, setOn] = useState(!!shown);
  useEffect(() => {
    arriving = null;
    if (!shown) return;
    if (shown.menu) nav.go({ name: "menu" });
    const t = setTimeout(() => setOn(false), 1400);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!on || !shown) return null;
  const p = shown.profile;
  return createPortal(
    <div className="profile-splash" role="status" data-hue={p.hue != null || undefined} style={{ "--p-hue": p.hue ?? undefined } as CSSProperties}>
      <ProfileAvatar profile={p} size={88} />
      <strong>{p.name}</strong>
      <span>Profile switched</span>
    </div>,
    document.body,
  );
}
