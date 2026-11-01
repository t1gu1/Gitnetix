import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";

import { useAction, useConfig } from "../api/hooks";
import { rpc } from "../api/transport";
import type { ProjectSummary, UserProfile } from "../api/types";
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
 * Make a profile, fresh or a copy of profile `from`, then switch to it; or edit `profile`'s name and looks.
 * `menu`: opened from the settings, which open again on the new profile.
 */
export function ProfileDialog({ profile, from, menu, onClose }: { profile?: UserProfile; from?: string; menu?: boolean; onClose: () => void }) {
  const { list, switchTo } = useProfiles();
  const identity = useConfig().data?.profiles[0]?.email ?? "";
  const source = list.find((p) => p.id === from);
  const [name, setName] = useState(profile?.name ?? (source ? `${source.name} copy` : ""));
  const old = profile?.avatar ?? "";
  const [kind, setKind] = useState<"emoji" | "photo" | "gravatar">(old.startsWith(PHOTO) ? "photo" : old.startsWith(GRAVATAR) ? "gravatar" : "emoji");
  const [emoji, setEmoji] = useState(kind === "emoji" ? old : "");
  const [photo, setPhoto] = useState(kind === "photo" ? old : "");
  const [email, setEmail] = useState(kind === "gravatar" ? old.slice(GRAVATAR.length) : identity);
  const chooser = useRef<HTMLInputElement>(null);
  const avatar = kind === "photo" ? photo : kind === "gravatar" ? GRAVATAR + email.trim() : emoji;
  const ready = kind === "photo" ? !!photo : kind === "emoji" || EMAIL.test(email.trim());
  // A new profile gets a color no other one has.
  const [hue, setHue] = useState<number | null>(profile ? (profile.hue ?? null) : (HUES.find((h) => !list.some((p) => p.hue === h)) ?? null));
  const [start, setStart] = useState(from ?? "");
  const save = useAction<UserProfile>("userProfiles.save", { invalidate: [["config"]] });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !ready) return;
    save.mutate(
      { id: profile?.id, name: name.trim(), avatar, hue, from: profile ? undefined : start || undefined },
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
      sub={profile ? undefined : "Its own projects, connections, AI setup and settings"}
      onClose={onClose}
      width={500}
      footer={
        <>
          <button type="button" className="btn btn-md" onClick={onClose}>Cancel</button>
          <button type="submit" form="profile-form" className="btn btn-md btn-primary" disabled={!name.trim() || !ready || save.isPending}>
            {save.isPending && <span className="spinner" />}
            {profile ? "Save" : "Create and switch"}
          </button>
        </>
      }
    >
      <form id="profile-form" className="profile-form" onSubmit={submit}>
        <div className="profile-form-top">
          {/* An email still being typed would ask Gravatar about each keystroke. */}
          <ProfileAvatar profile={{ avatar: ready ? avatar : "", hue }} size={72} />
          <div className="field grow">
            <label htmlFor="profile-name">Name</label>
            <input id="profile-name" className="input" autoFocus maxLength={40} placeholder="Work, Personal, a client…" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
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
          {kind === "gravatar" && (
            <>
              <input className="input" type="email" aria-label="Gravatar email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <span className="hint">The picture set for this email on gravatar.com. Without one, the default avatar shows.</span>
            </>
          )}
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
