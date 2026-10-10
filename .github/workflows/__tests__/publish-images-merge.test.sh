#!/usr/bin/env bash
# Create image index and Read index digest, extracted from the merge job.
# A stub docker records argv and prints imagetools inspect text. No network.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
WORKFLOW="${WORKFLOW:-${REPO_ROOT}/.github/workflows/publish-selfhosted-images.yml}"
IMAGE="ghcr.io/memorycrystal/mcp"
VERSION="0.10.0"
MARKER="/tmp/ill425-merge-pwned"

echo "==> publish-images-merge.test.sh"
echo "    Workflow: ${WORKFLOW}"

low="$(python3 -c 'print("0"*64)')"
high="$(python3 -c 'print("f"*64)')"
mid="$(python3 -c 'print("a"*64)')"
GOOD="sha256:$(python3 -c 'print("ab"*32)')"
DECOY="sha256:$(python3 -c 'print("cd"*32)')"
if [[ ! "${GOOD}" =~ ^sha256:[0-9a-f]{64}$ || ! "${DECOY}" =~ ^sha256:[0-9a-f]{64}$ || "${GOOD}" == "${DECOY}" ]]; then
  echo "    FAIL: fixture digests are not distinct sha256 values" >&2
  exit 1
fi

STUB_DIR="$(mktemp -d)"
ARGV_LOG="${STUB_DIR}/argv"
CREATE_SCRIPT="${STUB_DIR}/create.sh"
INSPECT_SCRIPT="${STUB_DIR}/inspect.sh"
trap 'rm -rf "${STUB_DIR}" "${PAIR_DIR:-}" "${ONE_DIR:-}" "${EMPTY_DIR:-}" "${THREE_DIR:-}" "${HOSTILE_DIR:-}"' EXIT
rm -f "${MARKER}"

cat > "${STUB_DIR}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "${DOCKER_ARGV_LOG}"
printf '\n' >> "${DOCKER_ARGV_LOG}"
if [[ "${1:-}" == "buildx" && "${2:-}" == "imagetools" && "${3:-}" == "inspect" ]]; then
  mode="${DOCKER_STUB_INSPECT:-ok}"
  if [[ "${mode}" == "bad" ]]; then
    printf 'Name:      %s\nMediaType: text/plain\nDigest:    sha256:not-a-digest\n' "${DOCKER_STUB_NAME:-image}"
    exit 0
  fi
  if [[ "${mode}" == "empty" ]]; then
    printf 'Name:      %s\nMediaType: application/vnd.oci.image.index.v1+json\n' "${DOCKER_STUB_NAME:-image}"
    exit 0
  fi
  printf 'Name:      %s\nMediaType: application/vnd.oci.image.index.v1+json\nDigest:    %s\n\nManifests:\n  Name:      %s@%s\n  MediaType: application/vnd.oci.image.manifest.v1+json\n  Platform:  linux/amd64\n  Digest:    %s\n' \
    "${DOCKER_STUB_NAME:-image}" "${DOCKER_STUB_DIGEST}" "${DOCKER_STUB_NAME:-image}" "${DOCKER_STUB_DECOY}" "${DOCKER_STUB_DECOY}"
  exit 0
fi
exit 0
EOF
chmod +x "${STUB_DIR}/docker"

WORKFLOW_PATH="${WORKFLOW}" CREATE_OUT="${CREATE_SCRIPT}" INSPECT_OUT="${INSPECT_SCRIPT}" \
  node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const doc = parse(readFileSync(process.env.WORKFLOW_PATH, "utf8"));
const steps = doc.jobs?.merge?.steps ?? [];
const create = steps.find((step) => step.name === "Create image index");
const inspect = steps.find((step) => step.name === "Read index digest");
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!create || typeof create.run !== "string") fail("Create image index script is missing");
if (!inspect || typeof inspect.run !== "string") fail("Read index digest script is missing");
if (create.env?.PLATFORM_COUNT !== "${{ matrix.platform_count }}") fail("platform count is not passed through env");
for (const step of [create, inspect]) {
  if (step.run.includes("${{")) fail(step.name + " interpolates an expression");
}
writeFileSync(process.env.CREATE_OUT, create.run);
writeFileSync(process.env.INSPECT_OUT, inspect.run);
JS

LAST_STATUS=0
LAST_OUT=""
LAST_ERR=""
CASE_NAME=""

run_script() {
  local script="$1"
  local expect="$2"
  shift 2
  local out err
  out="$(mktemp)"
  err="$(mktemp)"
  : > "${ARGV_LOG}"
  set +e
  env "$@" PATH="${STUB_DIR}:${PATH}" DOCKER_ARGV_LOG="${ARGV_LOG}" LC_ALL=C bash "${script}" >"${out}" 2>"${err}"
  LAST_STATUS=$?
  set -e
  LAST_OUT="$(cat "${out}")"
  LAST_ERR="$(cat "${err}")"
  rm -f "${out}" "${err}"
  if [[ -e "${MARKER}" ]]; then
    echo "    FAIL: ${CASE_NAME} created ${MARKER}" >&2
    rm -f "${MARKER}"
    exit 1
  fi
  if [[ "${expect}" == "ok" && "${LAST_STATUS}" -ne 0 ]]; then
    echo "    FAIL: ${CASE_NAME} exited ${LAST_STATUS}" >&2
    printf '%s\n' "${LAST_OUT}" "${LAST_ERR}" >&2
    exit 1
  fi
  if [[ "${expect}" == "fail" && "${LAST_STATUS}" -eq 0 ]]; then
    echo "    FAIL: ${CASE_NAME} was accepted" >&2
    printf '%s\n' "${LAST_OUT}" >&2
    exit 1
  fi
}

assert_no_docker() {
  if [[ -s "${ARGV_LOG}" ]]; then
    echo "    FAIL: ${CASE_NAME} called docker" >&2
    exit 1
  fi
}

assert_out_has() {
  local needle="$1"
  if [[ "${LAST_OUT}" != *"${needle}"* ]]; then
    echo "    FAIL: ${CASE_NAME} did not report ${needle}" >&2
    printf '    stdout: %s\n' "${LAST_OUT}" >&2
    exit 1
  fi
}

assert_one_line() {
  local lines
  lines="$(printf '%s\n' "${LAST_OUT}" | wc -l | tr -d ' ')"
  if [[ -z "${LAST_OUT}" || "${lines}" -ne 1 ]]; then
    echo "    FAIL: ${CASE_NAME} did not print one error line" >&2
    printf '    stdout: %s\n' "${LAST_OUT}" >&2
    exit 1
  fi
}

assert_sorted() {
  python3 - "${ARGV_LOG}" "$1" "$2" <<'PY'
import sys
text = open(sys.argv[1], encoding="utf-8").read()
low = text.find("sha256:" + sys.argv[2])
high = text.find("sha256:" + sys.argv[3])
if low < 0 or high < 0 or low > high:
    raise SystemExit(1)
PY
}

base_env() {
  printf '%s\n' \
    "IMAGE=${IMAGE}" \
    "VERSION=${VERSION}" \
    "FLOAT_LATEST=${1}" \
    "PLATFORM_COUNT=${2}" \
    "DIGEST_DIR=${3}" \
    "DOCKER_STUB_INSPECT=ok" \
    "DOCKER_STUB_NAME=${IMAGE}:${VERSION}" \
    "DOCKER_STUB_DIGEST=${GOOD}" \
    "DOCKER_STUB_DECOY=${DECOY}"
}

PAIR_DIR="$(mktemp -d)"
: > "${PAIR_DIR}/${low}"
: > "${PAIR_DIR}/${high}"

CASE_NAME="latest on"
mapfile -t env_args < <(base_env true 2 "${PAIR_DIR}")
run_script "${CREATE_SCRIPT}" ok "${env_args[@]}"
argv="$(cat "${ARGV_LOG}")"
if [[ "${argv}" != *"${IMAGE}:${VERSION}"* || "${argv}" != *"${IMAGE}:latest"* ]]; then
  echo "    FAIL: latest on argv is missing a tag" >&2
  printf '    argv: %s\n' "${argv}" >&2
  exit 1
fi
tag_count="$(grep -o -F -- '-t' <<<"${argv}" | wc -l | tr -d ' ')"
if [[ "${tag_count}" -ne 2 ]]; then
  echo "    FAIL: latest on did not pass two -t flags" >&2
  exit 1
fi
assert_sorted "${low}" "${high}"
echo "    PASS: :latest on tags the version and latest, with digests sorted"

CASE_NAME="latest off"
mapfile -t env_args < <(base_env false 2 "${PAIR_DIR}")
run_script "${CREATE_SCRIPT}" ok "${env_args[@]}"
argv="$(cat "${ARGV_LOG}")"
if [[ "${argv}" != *"${IMAGE}:${VERSION}"* || "${argv}" == *":latest"* ]]; then
  echo "    FAIL: latest off argv has the wrong tags" >&2
  printf '    argv: %s\n' "${argv}" >&2
  exit 1
fi
tag_count="$(grep -o -F -- '-t' <<<"${argv}" | wc -l | tr -d ' ')"
if [[ "${tag_count}" -ne 1 ]]; then
  echo "    FAIL: latest off did not pass one -t flag" >&2
  exit 1
fi
assert_sorted "${low}" "${high}"
echo "    PASS: :latest off omits the latest tag, with digests sorted"

CASE_NAME="invalid float_latest"
mapfile -t env_args < <(base_env "maybe" 2 "${PAIR_DIR}")
run_script "${CREATE_SCRIPT}" fail "${env_args[@]}"
assert_no_docker
assert_one_line
assert_out_has "float_latest is not true or false"
echo "    PASS: an invalid float_latest is rejected"

HOSTILE_DIR="$(mktemp -d)"
python3 - "${HOSTILE_DIR}" "${low}" <<'PY'
import os, sys
root, low = sys.argv[1:]
# A command substitution with no slash: one path component, rejected by the hex check.
open(os.path.join(root, low), "w").close()
open(os.path.join(root, "$(touch ill425-merge-pwned)"), "w").close()
PY
CASE_NAME="hostile digest name"
mapfile -t env_args < <(base_env false 2 "${HOSTILE_DIR}")
run_script "${CREATE_SCRIPT}" fail "${env_args[@]}"
assert_no_docker
assert_one_line
assert_out_has "digest file name"
if [[ -e "${MARKER}" || -e "${REPO_ROOT}/ill425-merge-pwned" || -e "ill425-merge-pwned" ]]; then
  echo "    FAIL: hostile digest name was executed" >&2
  rm -f "${MARKER}" "${REPO_ROOT}/ill425-merge-pwned" ill425-merge-pwned
  exit 1
fi
echo "    PASS: a hostile digest file name is rejected"

CASE_NAME="missing digest dir"
mapfile -t env_args < <(base_env false 2 "${STUB_DIR}/missing-digests")
run_script "${CREATE_SCRIPT}" fail "${env_args[@]}"
assert_no_docker
assert_one_line
assert_out_has "digest directory is missing"
echo "    PASS: a missing digest directory is rejected"

EMPTY_DIR="$(mktemp -d)"
CASE_NAME="empty digest dir"
mapfile -t env_args < <(base_env false 2 "${EMPTY_DIR}")
run_script "${CREATE_SCRIPT}" fail "${env_args[@]}"
assert_no_docker
assert_one_line
assert_out_has "expected 2 platform digests, found 0"
echo "    PASS: an empty digest directory is rejected"

ONE_DIR="$(mktemp -d)"
: > "${ONE_DIR}/${low}"
CASE_NAME="one platform digest"
mapfile -t env_args < <(base_env false 2 "${ONE_DIR}")
run_script "${CREATE_SCRIPT}" fail "${env_args[@]}"
assert_no_docker
assert_one_line
assert_out_has "expected 2 platform digests, found 1"
echo "    PASS: a single platform digest is rejected when the count is 2"

THREE_DIR="$(mktemp -d)"
: > "${THREE_DIR}/${low}"
: > "${THREE_DIR}/${mid}"
: > "${THREE_DIR}/${high}"
CASE_NAME="three platform digests"
mapfile -t env_args < <(base_env false 2 "${THREE_DIR}")
run_script "${CREATE_SCRIPT}" fail "${env_args[@]}"
assert_no_docker
assert_one_line
assert_out_has "expected 2 platform digests, found 3"
echo "    PASS: three platform digests are rejected when the count is 2"

CASE_NAME="count matches one digest"
mapfile -t env_args < <(base_env false 1 "${ONE_DIR}")
run_script "${CREATE_SCRIPT}" ok "${env_args[@]}"
argv="$(cat "${ARGV_LOG}")"
if [[ "${argv}" != *"sha256:${low}"* || "${argv}" == *"sha256:${high}"* ]]; then
  echo "    FAIL: count 1 did not pass the single digest" >&2
  exit 1
fi
echo "    PASS: platform count 1 accepts exactly one digest"

CASE_NAME="count 1 rejects two digests"
mapfile -t env_args < <(base_env false 1 "${PAIR_DIR}")
run_script "${CREATE_SCRIPT}" fail "${env_args[@]}"
assert_no_docker
assert_one_line
assert_out_has "expected 1 platform digests, found 2"
echo "    PASS: platform count 1 rejects two digests"

for bad_count in "" "0" "two" "02"; do
  CASE_NAME="invalid platform count ${bad_count:-empty}"
  mapfile -t env_args < <(base_env false "${bad_count}" "${PAIR_DIR}")
  run_script "${CREATE_SCRIPT}" fail "${env_args[@]}"
  assert_no_docker
  assert_one_line
  assert_out_has "platform count is not a positive integer"
done
echo "    PASS: an invalid platform count is rejected"

CASE_NAME="invalid image name"
mapfile -t env_args < <(base_env false 2 "${PAIR_DIR}")
env_args[0]="IMAGE=ghcr.io/memorycrystal/mcp;touch /tmp/ill425-merge-pwned"
run_script "${CREATE_SCRIPT}" fail "${env_args[@]}"
assert_no_docker
assert_one_line
assert_out_has "image name"
echo "    PASS: an invalid image name is rejected"

CASE_NAME="invalid version"
mapfile -t env_args < <(base_env false 2 "${PAIR_DIR}")
env_args[1]="VERSION=0.10.0;rm"
run_script "${CREATE_SCRIPT}" fail "${env_args[@]}"
assert_no_docker
assert_one_line
assert_out_has "version is not a docker tag"
echo "    PASS: an invalid version is rejected"

gout="${STUB_DIR}/github-output"
: > "${gout}"
CASE_NAME="index digest"
run_script "${INSPECT_SCRIPT}" ok \
  IMAGE="${IMAGE}" \
  VERSION="${VERSION}" \
  GITHUB_OUTPUT="${gout}" \
  DOCKER_STUB_INSPECT=ok \
  DOCKER_STUB_NAME="${IMAGE}:${VERSION}" \
  DOCKER_STUB_DIGEST="${GOOD}" \
  DOCKER_STUB_DECOY="${DECOY}"
digest_line="$(cat "${gout}")"
if [[ "${digest_line}" != "digest=${GOOD}" ]]; then
  echo "    FAIL: index digest parse yielded ${digest_line}" >&2
  exit 1
fi
if [[ "${digest_line}" == *"${DECOY}"* ]]; then
  echo "    FAIL: index digest parse kept a manifest digest" >&2
  exit 1
fi
echo "    PASS: imagetools inspect text yields sha256 and 64 hex characters"

for mode in bad empty; do
  : > "${gout}"
  CASE_NAME="malformed inspect ${mode}"
  run_script "${INSPECT_SCRIPT}" fail \
    IMAGE="${IMAGE}" \
    VERSION="${VERSION}" \
    GITHUB_OUTPUT="${gout}" \
    DOCKER_STUB_INSPECT="${mode}" \
    DOCKER_STUB_NAME="${IMAGE}:${VERSION}" \
    DOCKER_STUB_DIGEST="${GOOD}" \
    DOCKER_STUB_DECOY="${DECOY}"
  assert_one_line
  assert_out_has "index digest"
  if [[ -s "${gout}" ]]; then
    echo "    FAIL: malformed inspect wrote a digest" >&2
    exit 1
  fi
done
echo "    PASS: malformed inspect output is rejected"

CASE_NAME="inspect invalid image"
: > "${gout}"
run_script "${INSPECT_SCRIPT}" fail \
  IMAGE='ghcr.io/not a name' \
  VERSION="${VERSION}" \
  GITHUB_OUTPUT="${gout}"
assert_no_docker
assert_out_has "image name"
echo "    PASS: inspect rejects an invalid image name"

if [[ -e "${MARKER}" ]]; then
  echo "    FAIL: marker file exists at the end" >&2
  exit 1
fi

echo "    All merge job checks passed."
