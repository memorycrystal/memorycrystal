# Memory Crystal Docs

Mintlify documentation site for [docs.memorycrystal.ai](https://docs.memorycrystal.ai).

## Setup

1. Connect the public mirror on [mintlify.com/dashboard](https://mintlify.com/dashboard)
2. Set the docs root to `apps/docs`
3. The private repo mirrors to the public repo, and the mirror job triggers a Mintlify deploy through the API

The mirror force-pushes one orphan commit, so Mintlify's GitHub check finds no changed files. After a push to `main` or a manual `workflow_dispatch` sync on `main`, `.github/workflows/sync-public-mirror.yml` calls `POST /v1/project/update/{projectId}`.

One-time setup on the private repo `illumin8ca/memorycrystal`:

- Admin API key (dashboard → Settings → Organization → API keys), stored as the secret `MINTLIFY_ADMIN_API_KEY`
- Project id, stored as the variable `MINTLIFY_PROJECT_ID`

```bash
gh secret set MINTLIFY_ADMIN_API_KEY -R illumin8ca/memorycrystal
gh variable set MINTLIFY_PROJECT_ID -R illumin8ca/memorycrystal --body <id>
```

`gh secret set` prompts for the key, so it never enters chat or shell history. When either value is missing the mirror job logs a skip notice and stays green. When the API call fails it logs a warning and stays green. The Deploy button in the Mintlify dashboard is the manual fallback.

## Custom Domain

Configure `docs.memorycrystal.ai` as a custom domain in the Mintlify dashboard.

## Local Preview

```bash
npx mintlify dev
```

No build step is required -- Mintlify hosts and builds the site via their CDN.
