import type { APIRoute } from 'astro';
import app from '../../../src/styles/app.css?raw';
import { scopeCss } from '../lib/scopeCss';

// The demo's look: the app's own stylesheet, scoped to the demo (.hd). site.css adds what only the demo needs.
export const GET: APIRoute = () => new Response(scopeCss(app), { headers: { 'Content-Type': 'text/css' } });
