# LINZ Data Browser

Static web app (no build step) for querying the LINZ Data Service. See README.md.

## Workflow

- Commit and push straight to `main`; don't open pull requests. Pushing to
  `main` deploys the site to GitHub Pages.
- Run `npm test` (Node's built-in test runner, no dependencies) before pushing.
- Never commit an LDS API key.
