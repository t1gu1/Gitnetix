import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, type MouseEvent, createContext, useContext, useState } from "react";
import { downloadDataUrl, isLocal } from "../api/transport";
import { toast } from "../lib/toast";
import { Zoom } from "./Zoom";

/** Where pictures that need a sign-in load from: the screen's Git host or tracker, through the app. `key` tells apart
 * two screens' pictures of the same name (Jira attachments go by name). */
export const PictureSource = createContext<{ key: string; load: (src: string) => Promise<string>; hidden?: boolean } | null>(null);

/** Inside a link: its pictures open the link, not full screen (a README's badges). */
export const Linked = createContext(false);

/** A picture from the web: an https one loads straight, with no referrer. One that fails (a private repository's, an
 * Azure DevOps attachment), a relative link (GitLab and Gitea uploads) or a Jira attachment's name then loads through
 * the app with the sign-in, where the screen gives a `PictureSource`. Else its alt text shows. A `hidden` source
 * keeps every picture as its alt text until the project allows them.
 * Out of a link, a click or Enter opens it full screen to zoom into, as an agent's images; ←/→ step through the other
 * pictures of the same text, and Download saves the one shown. */
export function Picture({ src, alt, ...rest }: { src: string; alt?: string; [attr: string]: unknown }) {
  const source = useContext(PictureSource);
  const linked = useContext(Linked);
  const direct = /^https:\/\//i.test(src);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState<{ pics: HTMLImageElement[]; at: number } | null>(null);
  const viaApp = !!source && !source.hidden && (!direct || failed);
  const q = useQuery({
    queryKey: ["picture", source?.key, src],
    queryFn: () => source!.load(src),
    enabled: viaApp,
    staleTime: Infinity,
    retry: false,
  });
  if (!(viaApp && q.data) && (viaApp || !direct || source?.hidden)) return <>{alt || null}</>;
  const open = (e: MouseEvent<HTMLImageElement> | KeyboardEvent<HTMLImageElement>) => {
    // Not also a click on what holds the text.
    e.stopPropagation();
    const img = e.currentTarget;
    // The text's other pictures, as they show now (one loaded through the app is a data: URL).
    const pics = [...(img.closest(".md")?.querySelectorAll<HTMLImageElement>("img.zoomable") ?? [])];
    setZoom(pics.includes(img) ? { pics, at: pics.indexOf(img) } : { pics: [img], at: 0 });
  };
  const zoomable = !linked && {
    className: "zoomable",
    role: "button",
    tabIndex: 0,
    "aria-label": `Zoom into ${alt || "the picture"}`,
    onClick: open,
    onKeyDown: (e: KeyboardEvent<HTMLImageElement>) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open(e)),
  };
  const shown = zoom && zoom.pics[zoom.at];
  return (
    <>
      {viaApp ? <img {...rest} {...zoomable} data-src={src} alt={alt} src={q.data} /> : <img {...rest} {...zoomable} data-src={src} alt={alt} src={src} referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
      {shown && (
        <Zoom
          name={shown.alt || "Picture"}
          onStep={zoom.pics.length > 1 ? (d) => setZoom({ ...zoom, at: (zoom.at + d + zoom.pics.length) % zoom.pics.length }) : undefined}
          onDownload={() => save(shown, source?.load)}
          onClose={() => {
            setZoom(null);
            shown.focus();
          }}
        >
          <img src={shown.currentSrc || shown.src} alt={shown.alt} referrerPolicy="no-referrer" />
        </Zoom>
      )}
    </>
  );
}

/** The picture's contents as a data: URL: as shown, else through the screen's sign-in, else straight from its host
 * (which must allow it). */
async function contents(url: string, load?: (src: string) => Promise<string>) {
  if (url.startsWith("data:")) return url;
  if (load) {
    try {
      return await load(url);
    } catch {
      // Not the screen's host: its own.
    }
  }
  const r = await fetch(url, { referrerPolicy: "no-referrer" });
  if (!r.ok) throw new Error(`its host answered ${r.status}`);
  const blob = await r.blob();
  return new Promise<string>((ok, no) => {
    const f = new FileReader();
    f.onload = () => ok(f.result as string);
    f.onerror = () => no(f.error);
    f.readAsDataURL(blob);
  });
}

/** A file name for picture `src` (a link, or a Jira attachment's name) with contents `data`: the link's last part, else
 * its alt text, with an extension from its type when it has none. No character a file name can't hold on Windows. */
function fileName(src: string, alt: string, data: string) {
  let base = src.split(/[?#]/)[0].split("/").pop() ?? "";
  try {
    base = decodeURIComponent(base);
  } catch {
    // Kept as written.
  }
  base = (base.trim() || alt.trim() || "picture").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
  const ext = /^data:image\/(\w+)/.exec(data)?.[1].replace("jpeg", "jpg");
  return /\.\w{2,5}$/.test(base) || !ext ? base : `${base}.${ext}`;
}

/** Saves picture `img` in Downloads on the desktop, else lets the browser download it. */
async function save(img: HTMLImageElement, load?: (src: string) => Promise<string>) {
  const src = img.dataset.src ?? img.src;
  try {
    const data = await contents(img.currentSrc || img.src, load);
    const name = fileName(src, img.alt, data);
    if (isLocal) return toast(`Saved to ${await downloadDataUrl(name, data)}`, "ok");
    const a = document.createElement("a");
    a.href = data;
    a.download = name;
    a.click();
  } catch (e) {
    toast(`Could not download ${img.alt || "the picture"}: ${e instanceof Error ? e.message : e}`, "error");
  }
}
