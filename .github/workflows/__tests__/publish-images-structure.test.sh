#!/usr/bin/env bash
# Structural contract for the native per-platform publish workflow.
# Parses publish-selfhosted-images.yml. No docker, no network.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
WORKFLOW="${WORKFLOW:-${REPO_ROOT}/.github/workflows/publish-selfhosted-images.yml}"

echo "==> publish-images-structure.test.sh"
echo "    Workflow: ${WORKFLOW}"

cd "${REPO_ROOT}"
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const path = process.argv[1];
const text = readFileSync(path, "utf8");
const doc = parse(text);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (text.includes("setup-qemu-action")) fail("workflow still uses setup-qemu-action");
if (text.includes("linux/amd64,linux/arm64")) fail("workflow still builds both platforms in one step");

const prPaths = doc.on?.pull_request?.paths;
if (!Array.isArray(prPaths)) fail("pull_request paths are missing");
if (!prPaths.includes(".github/workflows/publish-selfhosted-images.yml")) fail("pull_request paths omit the workflow file");
if (!prPaths.includes(".github/scripts/**")) fail("pull_request paths omit workflow scripts");

const jobs = doc.jobs ?? {};
for (const id of ["repo-guard", "meta", "build", "merge"]) {
  if (!jobs[id]) fail("missing job " + id);
}
if (jobs["build-and-push"]) fail("build-and-push job is still present");

const needsOf = (job) => {
  const needs = job.needs;
  if (needs == null) return [];
  return (Array.isArray(needs) ? needs : [needs]).map(String).sort();
};
const same = (actual, expected, label) => {
  if (actual.join(",") !== expected.join(",")) fail(label + " needs are " + actual.join(","));
};
same(needsOf(jobs.meta), ["repo-guard"], "meta");
same(needsOf(jobs.build), ["meta"], "build");
same(needsOf(jobs.merge), ["build", "meta"], "merge");

if (jobs.build["timeout-minutes"] !== 30) fail("build timeout is not 30");
if (jobs.merge["timeout-minutes"] !== 15) fail("merge timeout is not 15");
if (jobs.merge.if !== "github.event_name != \u0027pull_request\u0027") fail("merge if is not the push condition");

const permPairs = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("permissions are not a mapping");
  return Object.keys(value).sort().map((key) => key + "=" + value[key]).join(",");
};
if (permPairs(doc.permissions) !== "contents=read") fail("workflow permissions are not contents: read");
if (permPairs(jobs["repo-guard"].permissions) !== "contents=read") fail("repo-guard permissions");
if (permPairs(jobs.meta.permissions) !== "contents=read") fail("meta permissions");
if (permPairs(jobs.build.permissions) !== "contents=read,packages=write") fail("build permissions");
if (permPairs(jobs.merge.permissions) !== "contents=read,id-token=write,packages=write") fail("merge permissions");

if (jobs.build["runs-on"] !== "${{ matrix.runner }}") fail("build runs-on is not the matrix runner");
const include = jobs.build.strategy?.matrix?.include;
if (!Array.isArray(include) || include.length !== 2) fail("build matrix does not have two entries");
const amd = include.find((entry) => entry.arch === "amd64");
const arm = include.find((entry) => entry.arch === "arm64");
if (!amd || !arm) fail("build matrix is missing amd64 or arm64");
if (amd.platform !== "linux/amd64" || arm.platform !== "linux/arm64") fail("platform does not match arch");
if (amd.image !== "mcp" || arm.image !== "mcp") fail("build matrix image is not mcp");
const plainRunner = (value) => typeof value === "string" && value.length > 0 && !value.includes("${{");
if (!plainRunner(amd.runner) || amd.runner.endsWith("-arm")) fail("amd64 runner is not a plain non-arm label");
if (!plainRunner(arm.runner) || !arm.runner.endsWith("-arm")) fail("arm64 runner is not a plain arm label");

const uses = (step) => String(step.uses ?? "");
const buildSteps = jobs.build.steps ?? [];
const pushSteps = buildSteps.filter((step) => uses(step).includes("docker/build-push-action"));
if (pushSteps.length !== 2) fail("build job does not have two build-push steps");
const prBuild = pushSteps.find((step) => step.if === "github.event_name == \u0027pull_request\u0027");
if (!prBuild || prBuild.with?.push !== false) fail("PR build push is not false");
for (const step of pushSteps) {
  if (step.with?.platforms !== "${{ matrix.platform }}") fail("build platforms are not the single matrix platform");
  if (step.with?.["cache-from"] !== "type=gha,scope=${{ matrix.image }}-${{ matrix.arch }}") {
    fail("cache-from is not the per-arch scope");
  }
  if (step.with?.["cache-to"] !== "type=gha,scope=${{ matrix.image }}-${{ matrix.arch }},mode=max") {
    fail("cache-to is not the per-arch scope");
  }
}
const digestPush = buildSteps.find((step) => step.id === "build");
if (!digestPush) fail("digest push step is missing");
const outputs = String(digestPush.with?.outputs ?? "");
for (const part of ["type=image", "push-by-digest=true", "name-canonical=true", "push=true"]) {
  if (!outputs.includes(part)) fail("digest outputs missing " + part);
}
const upload = buildSteps.find((step) => uses(step).includes("actions/upload-artifact"));
if (!upload) fail("digest upload is missing");
if (upload.with?.name !== "digests-${{ matrix.image }}-${{ matrix.arch }}") fail("digest artifact name");
if (upload.with?.["if-no-files-found"] !== "error") fail("digest upload does not fail when empty");
if (upload.with?.["retention-days"] !== 1) fail("digest retention is not 1 day");

const namesOf = (job) => (job.steps ?? []).map((step) => step.name);
const forbidden = ["Install cosign", "Sign image with cosign (keyless OIDC)", "Generate SBOM with syft", "Attach SBOM as cosign attestation", "Check compressed image size by digest"];
for (const id of ["repo-guard", "meta", "build"]) {
  for (const name of forbidden) {
    if (namesOf(jobs[id]).includes(name)) fail(id + " has merge-only step " + name);
  }
}
const mergeNames = namesOf(jobs.merge);
const sbom = mergeNames.indexOf("Attach SBOM as cosign attestation");
const size = mergeNames.indexOf("Check compressed image size by digest");
const summary = mergeNames.indexOf("Write job summary");
const sign = mergeNames.indexOf("Sign image with cosign (keyless OIDC)");
const syft = mergeNames.indexOf("Generate SBOM with syft");
if ([sign, syft, sbom, size, summary].some((index) => index < 0)) fail("merge is missing a signing step");
if (!(sign < syft && syft < sbom && sbom < size && size < summary)) fail("merge signing order is wrong");

const indexDigest = "${{ steps.index.outputs.digest }}";
const signStep = jobs.merge.steps[sign];
const attestStep = jobs.merge.steps[sbom];
const sizeStep = jobs.merge.steps[size];
if (signStep.env?.DIGEST !== indexDigest) fail("cosign sign does not use the index digest");
if (attestStep.env?.DIGEST !== indexDigest) fail("cosign attest does not use the index digest");
if (sizeStep.env?.IMAGE_DIGEST !== indexDigest) fail("size check does not use the index digest");
if (sizeStep.env?.IMAGE_NAME !== "${{ steps.image.outputs.name }}") fail("size check image env");
if (sizeStep.env?.SIZE_LIMIT_MB !== "${{ matrix.size_limit_mb }}") fail("size check limit env");
const syftStep = jobs.merge.steps[syft];
if (syftStep.with?.image !== "${{ steps.image.outputs.name }}@" + indexDigest) fail("SBOM image is not the index digest");
if (syftStep.with?.format !== "spdx-json") fail("SBOM format is not spdx-json");
const cosign = jobs.merge.steps.find((step) => uses(step).includes("cosign-installer"));
if (!cosign || cosign.with?.["cosign-release"] !== "v2.2.4") fail("cosign release is not v2.2.4");

for (const step of jobs.merge.steps ?? []) {
  if (typeof step.run === "string" && step.run.includes("${{")) fail("merge run script interpolates an expression: " + step.name);
}
const mergeCheckouts = (jobs.merge.steps ?? []).filter((step) => uses(step).startsWith("actions/checkout"));
if (mergeCheckouts.length !== 1) fail("merge must have exactly one checkout");
if (mergeCheckouts[0].with?.ref !== undefined || mergeCheckouts[0].if !== undefined) fail("merge must check out the workflow commit, not the dispatched ref");
const create = (jobs.merge.steps ?? []).find((step) => step.name === "Create image index");
const inspect = (jobs.merge.steps ?? []).find((step) => step.name === "Read index digest");
if (!create || !String(create.run).includes("docker buildx imagetools create")) fail("merge does not create the index");
if (!inspect || !String(inspect.run).includes("docker buildx imagetools inspect")) fail("merge does not inspect the index");
if (!String(create.run).includes("[0-9a-f]{64}")) fail("merge does not validate digest file names");
if (create.env?.PLATFORM_COUNT !== "${{ matrix.platform_count }}") fail("index creation does not take platform_count through env");
const download = (jobs.merge.steps ?? []).find((step) => uses(step).includes("actions/download-artifact"));
if (!download || download.with?.["merge-multiple"] !== true) fail("merge does not download digests with merge-multiple");
if (download.with?.pattern !== "digests-${{ matrix.image }}-*") fail("merge digest pattern");
const digestLocation = "${{ runner.temp }}/digests";
const directoryOf = (value) => String(value ?? "").replace(/\/\*$/, "");
const exportDigest = buildSteps.find((step) => step.name === "Export digest");
if (!exportDigest || exportDigest.env?.DIGEST_DIR !== digestLocation) fail("build DIGEST_DIR is not runner.temp/digests");
if (directoryOf(upload.with?.path) !== digestLocation) fail("upload path is not runner.temp/digests");
if (download.with?.path !== digestLocation) fail("download path is not runner.temp/digests");
if (create.env?.DIGEST_DIR !== digestLocation) fail("merge DIGEST_DIR is not runner.temp/digests");
if (directoryOf(upload.with?.path) !== download.with?.path) fail("upload and download directories disagree");
if (exportDigest.env.DIGEST_DIR !== create.env?.DIGEST_DIR) fail("DIGEST_DIR values disagree");
for (const step of jobs.merge.steps ?? []) {
  if (Object.prototype.hasOwnProperty.call(step, "continue-on-error")) {
    fail("merge step sets continue-on-error: " + (step.name ?? "unnamed"));
  }
}

const mergeInclude = jobs.merge.strategy?.matrix?.include;
if (!Array.isArray(mergeInclude) || mergeInclude.length !== 1) fail("merge matrix is not one image");
if (mergeInclude[0].image !== "mcp" || mergeInclude[0].size_limit_mb !== 80 || mergeInclude[0].platform_count !== 2) fail("merge matrix limit");
const summaryStep = jobs.merge.steps[summary];
if (summaryStep.env?.PLATFORM_COUNT !== "${{ matrix.platform_count }}") fail("summary does not take platform_count through env");
const listed = String(summaryStep.run).match(/linux\/(?:amd64|arm64)/g) ?? [];
if (listed.length !== mergeInclude[0].platform_count) fail("summary platform list does not match platform_count");
' "${WORKFLOW}"

echo "    PASS: native per-platform publish structure"
