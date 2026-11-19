// node --test website/src/lib/scopeCss.test.mjs: the app's rules, scoped to the demo's root (scopeCss.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scopeCss } from './scopeCss.ts';

const t = (css) => scopeCss(css).trim();

test('the root and the theme conditions', () => {
  assert.equal(t(':root, .ag { --bg: #000; }'), '.hd,.hd .ag{--bg: #000;}');
  assert.equal(t('[data-theme="light"], [data-theme="light"] .ag { --bg: #fff; }'), '[data-theme="light"] .hd,[data-theme="light"] .hd .ag{--bg: #fff;}');
  assert.equal(t(':root[data-anim-off~="lists"] :is(.a, .b) > .c { x: y; }'), ':root[data-anim-off~="lists"] .hd :is(.a, .b) > .c{x: y;}');
  assert.equal(t('[data-palette^="gitnetix-bw"] :is(.sx-k, .sx-t) { font-weight: 600; }'), '[data-palette^="gitnetix-bw"] .hd :is(.sx-k, .sx-t){font-weight: 600;}');
});

test('rules about the page itself are dropped', () => {
  assert.equal(t('html, body, #root { height: 100%; }'), '');
  assert.equal(t('body { font-size: 13px; }'), '.hd{font-size: 13px;}');
  assert.equal(t('body.resizing .term, .x { a: b; }'), '.hd .x{a: b;}');
  assert.equal(t('@font-face { font-family: X; src: url("a.ttf"); } .a::after { content: "}{"; }'), '.hd .a::after{content: "}{";}');
});

test('phone and desktop layouts follow the demo, not the window', () => {
  assert.equal(t('@media (max-width: 900px) and (pointer: coarse), (max-width: 480px) { .ws { a: b; } }'), '.hd.hd-phone .ws{a: b;}');
  assert.equal(t('@media (min-width: 901px), (min-width: 481px) and (not (pointer: coarse)) { .ws { a: b; } }'), '.hd:not(.hd-phone) .ws{a: b;}');
  assert.equal(t('@media (max-width: 720px) { .map-bar { a: b; } }'), '@container hd (max-width: 720px){.hd .map-bar{a: b;}\n}');
  assert.equal(t('@keyframes spin { to { transform: rotate(360deg); } }'), '@keyframes spin{to { transform: rotate(360deg); }}');
});
