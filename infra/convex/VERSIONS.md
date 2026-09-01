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

## Patched backend for Railway production

The patched backend source is managed separately in `infra/convex/backend-cache/`.

**Current build context:**
- Upstream revision: `4ac3025d0d15b765181e0fc120d9d1323ead752c` (precompiled-2026-08-18-4ac3025)
- Patches:
  - `archive-cache.patch` (SHA-256: `342d198c6f8449eaba0784627ddc2a68ff652c8af2f78ec54aca0a7bb5cf4368`)
  - `searchlight-coordination.patch` (SHA-256: `cfd4c95a563f5dbb30076a82e347ef87d97af74b2b50ca58d6b3cc095ec6c609`)
- No production deployment yet; this is a rebase + coordination patch

Prepare a build context with:
```bash
infra/convex/backend-cache/prepare-context.sh /tmp/convex-backend-build
```

Build with the upstream `self-hosted/docker-build/Dockerfile.backend`. The production
Railway service will remain on the existing qualified image until a new build is tested
and promoted following the migration runbook.

**searchlight-coordination.patch** addresses upstream issue #525:
- Reference-counted cleanup (Arc-wrapped IndexTempDirWithSize)
- Text segment identity keying (ObjectKey-based LRU keys)
- Held Arc<IndexMeta> references prevent premature directory deletion
