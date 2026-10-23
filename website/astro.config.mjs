import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// GitHub Pages project site. With a custom domain: set `site` to it and `base` to '/'.
export default defineConfig({
  site: 'https://t1gu1.github.io',
  base: '/Gitnetix/',
  trailingSlash: 'always',
  integrations: [react(), sitemap({ filter: (page) => !page.endsWith('/404/') })],
});
