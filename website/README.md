# Gitnetix website

Astro static site with React components (`src/components/*.tsx`, rendered to HTML at build time, no React in the browser), deployed to GitHub Pages by `.github/workflows/website.yml`.
It is rebuilt after every release (called from `release.yml`) and on pushes to `main` that touch `website/`.

```sh
pnpm install --ignore-workspace
pnpm dev
```

- Release notes come from the repo's `CHANGELOG.md` (dated sections only), one page per version.
- `src/data/stories.json` adds a title, story and highlights to a version. Optional: without it the
  title is the first changelog line.
- Download links point at the latest GitHub release, with the file names `release.yml` uploads.
- `public/og.png` is the social card, rendered from the design canvas.
