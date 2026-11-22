// Mock helpers: <div class="panel" data-title="Appearance" data-tools="html"> gets the panel header;
// <i data-i="name" data-s="12"> becomes a stroke icon. body[data-ready] once done (the shot script waits for it).
const P = {
  back: "M10 3 5 8l5 5", close: "M4 4l8 8M12 4l-8 8", chevR: "M6 4l4 4-4 4", chevD: "M4 6l4 4 4-4", chevU: "M4 10l4-4 4 4",
  plus: "M8 3v10M3 8h10", minus: "M3 8h10", check: "M3.5 8.5l3 3 6-7", trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5",
  copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7", edit: "M3 13l1-3.5 6.5-6.5 2.5 2.5L6.5 12z", pin: "M6 2.5h4l-.5 4 2 2v1h-7v-1l2-2zM8 9.5V14",
  grip: "M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01", search: "M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.5 10.5 14 14",
  play: "M5 3.5v9l7-4.5z", pause: "M5.5 3.5v9M10.5 3.5v9", mic: "M8 2a2 2 0 0 1 2 2v4a2 2 0 0 1-4 0V4a2 2 0 0 1 2-2zM4.5 7.5a3.5 3.5 0 0 0 7 0M8 11v3",
  key: "M6 10a3 3 0 1 1 2.6-1.5L14 14h-2v-1.5h-1.5V11L8.6 8.5", link: "M7 9a3 3 0 0 0 4.2 0l2-2A3 3 0 0 0 9 2.8l-.8.8M9 7a3 3 0 0 0-4.2 0l-2 2A3 3 0 0 0 7 13.2l.8-.8",
  file: "M4 2h5l3 3v9H4zM9 2v3h3", folder: "M2 4.5h4.5L8 6h6v7H2z", ext: "M9 3h4v4M13 3 7 9M11.5 9.5V13h-8.5V4.5H7", refresh: "M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3",
  sparkle: "M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z", brush: "M10 2.5l3.5 3.5-5 5L5 7.5zM5 7.5 3 13l5.5-2", keyboard: "M2 4.5h12v7H2zM4.5 7h.01M7 7h.01M9.5 7h.01M12 7h.01M5 9.5h6",
  layers: "M8 2.5 14 6l-6 3.5L2 6zM2 9.5 8 13l6-3.5", terminal: "M2.5 3.5h11v9h-11zM5 7l2 1.5L5 10M8.5 10.5H11", phone: "M5 1.5h6v13H5zM7.5 12.5h1",
  pr: "M4.5 5.5v6M4.5 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 14.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 14.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 11.5V6.5L9.5 4.5H8",
  ticket: "M2 5V3.5h12V5a1.5 1.5 0 0 0 0 3v4.5H2V8a1.5 1.5 0 0 0 0-3zM10 3.5v9", branch: "M5 3v10M5 6.5c0 2 6 1 6 4.5M11 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 3a1 1 0 1 0 0-.01",
  dots: "M4 8h.01M8 8h.01M12 8h.01", info: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 7.5V11M8 5h.01", warn: "M8 2.5 14 13H2zM8 6.5V9.5M8 11.5h.01",
  eye: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z", lock: "M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5",
  sun: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1", moon: "M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z",
  monitor: "M2 3h12v8H2zM6 14h4M8 11v3", globe: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12", arrowR: "M3 8h10M9 4l4 4-4 4",
  reset: "M3 8a5 5 0 1 0 1.5-3.5M3 2.5v3h3", clock: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 4.5V8l2.5 1.5", filter: "M2.5 3.5h11L9.5 8.5v4l-3 1.5v-5.5z", download: "M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10",
};
const svg = (n, s) => `<svg class="i${s ? " s" + s : ""}" viewBox="0 0 16 16" aria-hidden="true"><path d="${P[n] || P.dots}"/></svg>`;
document.querySelectorAll(".panel[data-title]").forEach((p) => {
  const h = document.createElement("header");
  h.className = "hdr";
  h.innerHTML = `<button class="hdr-icon" aria-label="Back"><i data-i="back" data-s="16"></i></button><div class="hdr-title">${p.dataset.crumb ? `<span class="crumb">${p.dataset.crumb}</span><i data-i="chevR" data-s="12"></i>` : ""}<strong>${p.dataset.title}</strong>${p.dataset.sub ? `<span class="hint">${p.dataset.sub}</span>` : ""}</div>${p.dataset.tools ? `<div class="hdr-tools">${p.dataset.tools}</div>` : ""}`;
  p.prepend(h);
});
document.querySelectorAll("i[data-i]").forEach((e) => (e.outerHTML = svg(e.dataset.i, e.dataset.s)));
document.fonts.ready.then(() => document.body.setAttribute("data-ready", ""));
