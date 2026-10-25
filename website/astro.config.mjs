import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// GitHub Pages site served from the gitnetix.app custom domain (set in repo Settings → Pages).
export default defineConfig({
  site: 'https://gitnetix.app',
  base: '/',
  trailingSlash: 'always',
  integrations: [react(), sitemap({ filter: (page) => !page.endsWith('/404/') })],
});
