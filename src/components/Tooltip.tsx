import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/*
 * One delegated tooltip for the whole app. Any element opts in by markup alone:
 *
 *   data-tip="Text"            always shows on hover / keyboard focus
 *   data-tip-overflow          only shows when the element is truncated (text = data-tip or its own text)
 *   title="Text"               native titles are upgraded to this bubble
 *   aria-label on a button     shown for icon-only buttons (no visible text)
 *   class="ellipsis"           shows its full text when it is cut off
 *
 * data-tip-place="bottom" prefers below; default is above, flipping when there is no room.
 */

const SHOW_DELAY = 450;
/** After a tip hides, the next one within this window shows instantly. */
const WARM_WINDOW = 300;
const GAP = 6;
const EDGE = 8;

type Tip = { el: HTMLElement; text: string; place: "top" | "bottom" };

const truncated = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;

function resolve(start: Element | null): Tip | null {
  for (let el = start as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.dataset.tipOff !== undefined) return null;
    const place = el.dataset.tipPlace === "bottom" ? "bottom" : "top";
    if (el.dataset.tipOverflow !== undefined) {
      if (truncated(el)) return { el, text: el.dataset.tip || el.textContent?.trim() || "", place };
      continue;
    }
    const text = el.dataset.tip || el.getAttribute("title") || el.dataset.tipTitle;
    if (text) return { el, text, place };
    if (el.matches("button, [role=button], a") && el.getAttribute("aria-label") && !el.textContent?.trim()) {
      return { el, text: el.getAttribute("aria-label")!, place };
    }
    if (el.classList.contains("ellipsis") && truncated(el)) {
      const text = el.textContent?.trim();
      if (text) return { el, text, place };
    }
  }
  return null;
}

/** Native titles are parked while the pointer is on the element so the browser bubble never doubles ours. */
function park(el: HTMLElement) {
  if (!el.hasAttribute("title")) return;
  el.dataset.tipTitle = el.getAttribute("title") ?? "";
  el.removeAttribute("title");
}

function unpark(el: HTMLElement) {
  if (el.dataset.tipTitle === undefined) return;
  if (!el.hasAttribute("title")) el.setAttribute("title", el.dataset.tipTitle);
  delete el.dataset.tipTitle;
}

/** Mount once near the app root. */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; arrow: number; side: "top" | "bottom" } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(0);
  const lastHide = useRef(0);
  const current = useRef<Tip | null>(null);
  const parked = useRef<HTMLElement | null>(null);
  const shown = useRef(false);
  /** Element clicked while hovered: stays quiet until the pointer leaves it. */
  const muted = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      if (shown.current) lastHide.current = Date.now();
      shown.current = false;
      current.current = null;
      setTip(null);
    };
    const reveal = (t: Tip) => {
      shown.current = true;
      setTip(t);
    };
    const show = (next: Tip | null) => {
      if (next?.el === current.current?.el && next?.text === current.current?.text) return;
      window.clearTimeout(timer.current);
      if (parked.current && parked.current !== next?.el) {
        unpark(parked.current);
        parked.current = null;
      }
      if (muted.current && muted.current !== next?.el) muted.current = null;
      if (!next || next.el === muted.current) return hide();
      park(next.el);
      parked.current = next.el;
      const warm = shown.current || Date.now() - lastHide.current < WARM_WINDOW;
      current.current = next;
      if (warm) reveal(next);
      else {
        shown.current = false;
        setTip(null);
        timer.current = window.setTimeout(() => current.current === next && reveal(next), SHOW_DELAY);
      }
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      show(resolve(e.target as Element));
    };
    const out = (e: PointerEvent) => {
      const el = current.current?.el ?? muted.current ?? parked.current;
      if (el && !el.contains(e.relatedTarget as Node)) show(resolve(e.relatedTarget as Element | null));
    };
    const focus = (e: FocusEvent) => {
      const t = e.target as HTMLElement;
      if (t.matches?.(":focus-visible")) show(resolve(t));
    };
    const blur = (e: FocusEvent) => current.current?.el === e.target && hide();
    const key = (e: KeyboardEvent) => e.key === "Escape" && hide();
    const down = () => {
      muted.current = current.current?.el ?? null;
      hide();
    };

    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blur);
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      hide();
      if (parked.current) unpark(parked.current);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blur);
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Hide if the anchor leaves the DOM (row re-rendered, modal closed…).
  useEffect(() => {
    if (!tip) return;
    const id = window.setInterval(() => !tip.el.isConnected && setTip(null), 250);
    return () => window.clearInterval(id);
  }, [tip]);

  useLayoutEffect(() => {
    const box = ref.current;
    if (!tip || !box) return setPos(null);
    const a = tip.el.getBoundingClientRect();
    const { width, height } = box.getBoundingClientRect();
    const roomAbove = a.top - GAP - height >= EDGE;
    const roomBelow = a.bottom + GAP + height <= window.innerHeight - EDGE;
    const side = tip.place === "top" ? (roomAbove || !roomBelow ? "top" : "bottom") : roomBelow || !roomAbove ? "bottom" : "top";
    const center = a.left + a.width / 2;
    const left = Math.max(EDGE, Math.min(center - width / 2, window.innerWidth - width - EDGE));
    setPos({
      left,
      top: side === "top" ? a.top - GAP - height : a.bottom + GAP,
      arrow: Math.max(8, Math.min(center - left, width - 8)),
      side,
    });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={ref}
      className="tip"
      role="tooltip"
      data-side={pos?.side}
      style={pos ? { left: pos.left, top: pos.top, ["--tip-arrow" as string]: `${pos.arrow}px` } : { left: 0, top: 0, visibility: "hidden" }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
