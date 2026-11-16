import { useEffect, useState } from "react";

import { useTicketFile, useTicketFiles } from "../api/hooks";
import { downloadDataUrl, isLocal } from "../api/transport";
import type { Ticket, TicketFile } from "../api/types";
import { bytes } from "../lib/format";
import { toast } from "../lib/toast";
import { Arrows, peek, Preview, TEXT_CAP, useArrows } from "./AgentLog";
import { Icon } from "./Icon";
import { isImage } from "./ImageDiff";
import { ErrorBox, Modal } from "./ui";

/** The ticket's files, one chip each as in an agent's log; none, no section. A click opens one full size, to download.
 * `pictures`: the project shows pictures, so a picture's chip has its thumbnail and previews on hover or focus. */
export function TicketFiles({ t, pictures }: { t: Ticket; pictures: boolean }) {
  const q = useTicketFiles(t);
  const [open, setOpen] = useState<number>();
  const files = q.data ?? [];
  if (!q.error && !files.length) return null;
  return (
    <section className="section">
      <h2>Files {files.length > 0 && <span className="faint" style={{ fontWeight: 400 }}>{files.length}</span>}</h2>
      {q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        <span className="ag-files">
          {files.map((f, i) => (
            <Chip key={f.id} t={t} f={f} pictures={pictures} onOpen={() => setOpen(i)} />
          ))}
        </span>
      )}
      {open !== undefined && open < files.length && <Peek t={t} files={files} at={open} onStep={setOpen} onClose={() => setOpen(undefined)} />}
    </section>
  );
}

/** File `f`: its icon, or with `pictures` a picture's thumbnail, which previews large on hover or focus; then its name
 * and size. A picture named with no extension gets its thumbnail once opened. */
function Chip({ t, f, pictures, onOpen }: { t: Ticket; f: TicketFile; pictures: boolean; onOpen: () => void }) {
  const loaded = useTicketFile(t, f, pictures && isImage(f.name)).data;
  // Opened, any file's data is here: only a picture's is a thumbnail.
  const data = pictures && loaded?.startsWith("data:image/") ? loaded : undefined;
  const [at, setAt] = useState<HTMLElement | null>(null);
  // Placed once: it hides on scroll.
  useEffect(() => {
    if (!at) return;
    const off = () => setAt(null);
    window.addEventListener("scroll", off, true);
    return () => window.removeEventListener("scroll", off, true);
  }, [at]);
  const hover = (e: { currentTarget: HTMLElement }) => data && setAt(e.currentTarget);
  return (
    <button type="button" className="ag-file" title={data ? undefined : f.name} onClick={onOpen} onPointerEnter={hover} onPointerLeave={() => setAt(null)} onFocus={hover} onBlur={() => setAt(null)}>
      {data ? <img src={data} alt="" /> : <Icon name={isImage(f.name) ? "image" : "file"} size={15} />}
      <span className="ellipsis">{f.name}</span>
      {f.size !== undefined && <span className="faint">{bytes(f.size)}</span>}
      {at && data && (
        <Preview at={at}>
          <img src={data} alt={f.name} />
        </Preview>
      )}
    </button>
  );
}

/** A data: URL's bytes, as a file named `name`. */
function fileOf(data: string, name: string) {
  const [head, b64 = ""] = data.split(",", 2);
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return new File([buf], name, { type: /^data:([^;,]*)/.exec(head)?.[1] ?? "" });
}

/** Saves file `name`, a data: URL, in Downloads on the desktop, else lets the browser download it. A name gets no
 * character a Windows file name can't hold, and a picture's extension when it has none (a GitHub upload's "Image"). */
async function save(name: string, data: string) {
  const ext = /^data:image\/(\w+)/.exec(data)?.[1].replace("jpeg", "jpg");
  const base = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_") || "file";
  const file = /\.\w{1,5}$/.test(base) || !ext ? base : `${base}.${ext}`;
  try {
    if (isLocal) return toast(`Saved to ${await downloadDataUrl(file, data)}`, "ok");
    const a = document.createElement("a");
    a.href = data;
    a.download = file;
    a.click();
  } catch (e) {
    toast(`Could not save ${name}: ${e}`, "error");
  }
}

type Peeked = Awaited<ReturnType<typeof peek>>;

/** The ticket's `files` full size from the `at`th: pictures, text files' text, else "No preview". The arrows and ←/→
 * `onStep` through them, round; Download saves the one shown. */
function Peek({ t, files, at, onStep, onClose }: { t: Ticket; files: TicketFile[]; at: number; onStep: (i: number) => void; onClose: () => void }) {
  const f = files[at];
  const n = files.length;
  const q = useTicketFile(t, f);
  const [shown, setShown] = useState<{ id: string; p: Peeked }>();
  useEffect(() => {
    if (!q.data) return;
    let live = true;
    let url = "";
    peek(fileOf(q.data, f.name)).then(
      (p) => {
        if ("url" in p) url = p.url;
        if (live) setShown({ id: f.id, p });
        else if (url) URL.revokeObjectURL(url);
      },
      (e) => live && setShown({ id: f.id, p: { none: `Could not read ${f.name}: ${e}` } }),
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [q.data, f.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const p = shown?.id === f.id ? shown.p : q.error ? { none: `Could not load ${f.name}: ${q.error.message}` } : undefined;
  const step = (d: number) => onStep((at + d + n) % n);
  useArrows(n, step);
  const sub = [n > 1 && `${at + 1} / ${n}`, f.size !== undefined && bytes(f.size), p && "cut" in p && p.cut && `First ${bytes(TEXT_CAP)} shown`].filter(Boolean).join(" · ");
  return (
    <Modal
      title={f.name}
      sub={sub}
      onClose={onClose}
      actions={
        <button type="button" className="btn btn-ghost btn-icon" aria-label={`Download ${f.name}`} data-tip={isLocal ? "Save to Downloads" : "Download"} disabled={!q.data} onClick={() => q.data && save(f.name, q.data)}>
          <Icon name="download" />
        </button>
      }
    >
      <div className="ag-shot">
        {!p ? (
          <span className="spinner" />
        ) : "url" in p ? (
          <img src={p.url} alt={f.name} onError={() => setShown({ id: f.id, p: { none: `Could not show ${f.name}` } })} />
        ) : "text" in p ? (
          <pre className="ag-peek-text">{p.text}</pre>
        ) : (
          <span className="faint">{p.none}</span>
        )}
        {n > 1 && <Arrows what="file" step={step} />}
      </div>
    </Modal>
  );
}
