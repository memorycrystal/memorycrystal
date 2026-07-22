# Local Convex version pins

These pins keep the Docker-primary local backend aligned with the Convex CLI used by this repo. Bump them together and rerun `npm run convex:local:doctor` plus `docker compose -f infra/convex/docker-compose.yml config`.

```yaml
backend_image: ghcr.io/get-convex/convex-backend@sha256:104b8bc70e29b31fa4a57551596090bfc9eedc3d1f27fd4b8cd8d0e782b9b070
dashboard_image: ghcr.io/get-convex/convex-dashboard@sha256:60b04b339d6cd6623057b03e5275329a20011051907ec5e689a38a401cfdc409
convex_npm: 1.41.0
tested_on: 2026-07-14
```

## Source evidence

- Official self-hosted compose source: https://github.com/get-convex/convex-backend/blob/main/self-hosted/docker/docker-compose.yml
- Official self-hosting guide: https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md
- Convex release observed at verification time: `precompiled-2026-07-11-63ad48b`.
- GHCR did not publish a matching commit tag, so the tested multi-architecture
  manifests are pinned by immutable digest instead of relying on `latest`.
- This official backend digest is qualified for local development and isolated
  restore drills, not Memory Crystal's full production dataset on Railway. The
  production Railway service uses the separately built, immutable patched
  backend image recorded in `docs/RAILWAY_CONVEX_MIGRATION.md`.

## Bump checklist

1. Replace both image tags in `infra/convex/docker-compose.yml` and above.
2. Update `convex_npm` after upgrading the repo's `convex` package.
3. Re-verify admin-key shape from `docker compose exec backend ./generate_admin_key.sh`; scripts currently accept `^[A-Za-z0-9._-]+\|[A-Za-z0-9]+$`.
4. Run `docker compose -f infra/convex/docker-compose.yml config` and `npm run convex:local:doctor` against a healthy local stack.
