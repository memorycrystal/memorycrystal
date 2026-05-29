# Local Convex version pins

These pins keep the Docker-primary local backend aligned with the Convex CLI used by this repo. Bump them together and rerun `npm run convex:local:doctor` plus `docker compose -f infra/convex/docker-compose.yml config`.

```yaml
backend_image: ghcr.io/get-convex/convex-backend:db5c4247c94474de92f1d75d7c15ff5641c3d18d
dashboard_image: ghcr.io/get-convex/convex-dashboard:db5c4247c94474de92f1d75d7c15ff5641c3d18d
convex_npm: 1.35.1
tested_on: 2026-04-25
```

## Source evidence

- Official self-hosted compose source: https://github.com/get-convex/convex-backend/blob/main/self-hosted/docker/docker-compose.yml
- Official self-hosting guide: https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md
- Convex release selected at implementation time: `precompiled-2026-04-24-db5c424`; image tag: `db5c4247c94474de92f1d75d7c15ff5641c3d18d`

## Bump checklist

1. Replace both image tags in `infra/convex/docker-compose.yml` and above.
2. Update `convex_npm` after upgrading the repo's `convex` package.
3. Re-verify admin-key shape from `docker compose exec backend ./generate_admin_key.sh`; scripts currently accept `^[A-Za-z0-9._-]+\|[A-Za-z0-9]+$`.
4. Run `docker compose -f infra/convex/docker-compose.yml config` and `npm run convex:local:doctor` against a healthy local stack.
