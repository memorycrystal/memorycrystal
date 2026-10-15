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
  backend image described under "Backend image for Railway production" below.

## Bump checklist

1. Replace both image tags in `infra/convex/docker-compose.yml` and above.
2. Update `convex_npm` after upgrading the repo's `convex` package.
3. Re-verify admin-key shape from `docker compose exec backend ./generate_admin_key.sh`; scripts currently accept `^[A-Za-z0-9._-]+\|[A-Za-z0-9]+$`.
4. Run `docker compose -f infra/convex/docker-compose.yml config` and `npm run convex:local:doctor` against a healthy local stack.

## Backend image for Railway production

The custom backend source is managed separately in `infra/convex/backend-cache/`.

**Production since 2026-10-07 19:21Z (ILL-352 Part C):** the build below, `ghcr.io/illumin8ca/memorycrystal-convex-backend@sha256:3f7c7ec17913f5236fa8f08e757846708561499a42d016d3a2bcba7b4a989e6f` (Railway deployment `93236938`). Migrations 129 to 133 completed at 19:21:51Z.

**Before that:** the 2026-08-20 build of upstream `4ac3025d0d15b765181e0fc120d9d1323ead752c` (`DATABASE_VERSION` 128) with `archive-cache.patch`, `searchlight-coordination.patch`, and the ILL-238 `SHELL` overlay, digest `941c6660`, running on Railway by 2026-08-21. The ILL-349 `export-cleanup-notfound.patch` and the ILL-347 startup temp cleanup were added later and never ran in production.

**Current build context:**
- Upstream revision: `96d219cc87e438b945ab92925d26a60939f646cd` (precompiled-2026-10-07-96d219c)
- `DATABASE_VERSION` 133. Data migrations: 130 (backfill `persistenceIndexId` on Database indexes in `_index`, batches of 1,000) and 133 (delete legacy schema-validation progress docs with no `validation_id`, and drop `by_schema_id`). Migrations 127, 128, 129, 131, and 132 are empty.
- Patches: none. Archive-cache configuration, searchlight refcount coordination (upstream #57610 / issue #525), and expired-export NotFound handling (upstream `a16dada1`) are in this revision.
- Production archive-cache variable: `MAX_ARCHIVE_CACHE_SIZE_BYTES` (bytes; default `bytesize::mib(500)`, 524288000). It replaces `CONVEX_SEARCH_ARCHIVE_CACHE_MIB` (MiB). This repo records two budgets: 24576 MiB at the July 2026 Railway cutover and 4096 MiB in `backend-cache/FOLLOWUP-525.md`. Part C converts the live Railway value, MiB × 1048576: 4096 MiB is 4294967296 bytes, and 24576 MiB is 25769803776 bytes.
- In production since 2026-10-07 (ILL-352 Part C). The Part B rehearsal stopped before its upgrade stage, so production was upgraded directly, with Railway volume backups as the rollback point.

Prepare a build context with:
```bash
infra/convex/backend-cache/prepare-context.sh /tmp/convex-backend-build
```

Build with the upstream `self-hosted/docker-build/Dockerfile.backend`. The production
Railway service will remain on the existing qualified image until a new build is tested
and promoted following the migration runbook.

**Entrypoint overlays:**
- `prepare-context.sh` overlays `run_backend-tmp-cleanup.overlay.sh`
  onto `self-hosted/docker-build/run_backend.sh` (clears `$TMPDIR` before the
  backend is exec'd and logs the count removed; ILL-347).
- It then overlays `run_backend-search-warmer.overlay.sh` (a background loop
  that keeps the extracted search segments in the page cache; ILL-441). See
  `backend-cache/README.md`.
- It also keeps the Dockerfile.backend `SHELL` fail-fast overlay (ILL-238). At
  this revision the upstream file already has
  `SHELL ["/bin/bash", "-e", "-o", "pipefail", "-c"]`, so the overlay leaves
  that line in place.
- Candidate tag: `<revision[0:12]>-cache-<context_sha[0:12]>`. The
  `context_sha` hashes `sha256sum` lines for patches named by `git apply`
  lines in `prepare-context.sh`, in that order, then the `sha256sum` lines for
  `*.overlay.sh`, `prepare-context.sh` and `UPSTREAM_REVISION`, sorted by path.
  This revision has no apply lines. The CI provenance test checks that every
  recorded patch SHA-256 matches its file; with no patch files, `VERSIONS.md`
  records none.
- Registry digest: recorded in the PR and in Linear (ILL-352), never in this
  file. The workflow verifies
  `docker pull <image>@<digest>` and that the entrypoint contains the cleanup
  before it reports the digest.
- Not promoted. Before promotion (ILL-352): record the Railway start command
  (must be none) and confirm deployments of the volume-attached service do not
  overlap. See `docs/operations/backend-storage.md`.

Upstream #57610 keeps extracted search archives on disk while segment caches
hold `CachedArchive` (`Arc<IndexMeta>`) and keys those caches by storage keys.
