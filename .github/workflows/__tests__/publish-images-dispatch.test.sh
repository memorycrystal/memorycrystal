#!/usr/bin/env bash
# The dispatch ref is optional and must match a stable vX.Y.Z tag.
# inputs.ref is passed only through env, then checked before checkout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/publish-selfhosted-images.yml"

if grep -F -q '[0-9]' "${WORKFLOW}"; then
  echo "    FAIL: a ref regex uses [0-9]" >&2
  exit 1
fi
ref_lines="$(grep -c '\[0123456789\]' "${WORKFLOW}" || true)"
if [[ "${ref_lines}" -ne 3 ]]; then
  echo "    FAIL: the three ref regexes must use [0123456789]" >&2
  exit 1
fi

echo "==> publish-images-dispatch.test.sh"
echo "    Workflow: ${WORKFLOW}"

SCRIPT="$(node --input-type=module -e '
import { readFileSync } from "node:fs";
import { parse } from "yaml";
const doc = parse(readFileSync(process.argv[1], "utf8"));
const input = doc.on.workflow_dispatch.inputs.ref;
if (!input || input.required !== false || input.type !== "string") {
  console.error("dispatch ref input is missing or not optional");
  process.exit(1);
}
const jobs = doc.jobs;
for (const job of Object.values(jobs)) {
  for (const step of job.steps ?? []) {
    if (typeof step.run === "string" && step.run.includes("inputs.ref")) {
      console.error("a run script interpolates inputs.ref");
      process.exit(1);
    }
  }
}
const steps = jobs.meta?.steps ?? [];
const validate = steps.find((step) => step.id === "dispatch_ref");
if (!validate || validate.name !== "Validate dispatch ref" || validate.env.DISPATCH_REF !== "${{ inputs.ref }}") {
  console.error("dispatch ref is not passed through DISPATCH_REF");
  process.exit(1);
}
for (const name of ["Compute version tag", "Determine whether to float :latest"]) {
  if (!steps.some((step) => step.name === name)) {
    console.error("missing step " + name);
    process.exit(1);
  }
}
const checkout = (jobs.build?.steps ?? []).find((step) => step.name === "Checkout dispatch tag");
if (!checkout || checkout.with.ref !== "${{ needs.meta.outputs.checkout_ref }}") {
  console.error("checkout ref does not use the validated output");
  process.exit(1);
}
if (String(checkout.with.ref).includes("inputs.ref")) {
  console.error("checkout ref reads inputs.ref");
  process.exit(1);
}
process.stdout.write(validate.run);
' "${WORKFLOW}")"

run_case() {
  local name="$1"
  local event_name="$2"
  local ref="$3"
  local expect="$4"
  local out
  out="$(mktemp)"
  set +e
  EVENT_NAME="${event_name}" DISPATCH_REF="${ref}" GITHUB_OUTPUT="${out}" bash -c "${SCRIPT}"
  local status=$?
  set -e
  local body
  body="$(cat "${out}")"
  rm -f "${out}"
  if [[ "${expect}" == "ok" ]]; then
    if [[ ${status} -ne 0 ]]; then
      echo "    FAIL: ${name} exited ${status}" >&2
      exit 1
    fi
  else
    if [[ ${status} -eq 0 ]]; then
      echo "    FAIL: ${name} was accepted" >&2
      exit 1
    fi
    if [[ "${body}" == *checkout_ref=* && "${body}" != "checkout_ref=" ]]; then
      echo "    FAIL: ${name} wrote a checkout ref" >&2
      exit 1
    fi
  fi
  printf '%s' "${body}"
}

body_file="$(mktemp)"
trap 'rm -f "${body_file}"' EXIT

run_case "stable tag" workflow_dispatch "v0.10.0" ok > "${body_file}"
good="$(cat "${body_file}")"
[[ "${good}" == *"checkout_ref=v0.10.0"* ]]
[[ "${good}" == *"version=0.10.0"* ]]
[[ "${good}" == *"float_latest=true"* ]]
echo "    PASS: v0.10.0 checks out that tag, sets VERSION, and floats latest"

run_case "another stable tag" workflow_dispatch "v10.20.30" ok > "${body_file}"
good="$(cat "${body_file}")"
[[ "${good}" == *"version=10.20.30"* ]]
echo "    PASS: v10.20.30"

run_case "omitted ref" workflow_dispatch "" ok > "${body_file}"
empty="$(cat "${body_file}")"
[[ "${empty}" == *"checkout_ref="* ]]
[[ "${empty}" == *"version="* ]]
[[ "${empty}" != *"float_latest=true"* ]]
echo "    PASS: an empty ref keeps the sha version path"

assert_idle_outputs() {
  local name="$1"
  local body="$2"
  local line
  local saw_checkout=0
  local saw_version=0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    case "${line}" in
      checkout_ref=) saw_checkout=1 ;;
      checkout_ref=*)
        echo "    FAIL: ${name} checkout_ref is not empty" >&2
        exit 1
        ;;
      version=) saw_version=1 ;;
      version=*)
        echo "    FAIL: ${name} version is not empty" >&2
        exit 1
        ;;
      float_latest=true)
        echo "    FAIL: ${name} floats latest" >&2
        exit 1
        ;;
    esac
  done <<< "${body}"
  if [[ ${saw_checkout} -ne 1 || ${saw_version} -ne 1 ]]; then
    echo "    FAIL: ${name} did not write empty checkout_ref and version" >&2
    exit 1
  fi
}

run_case "tag push ignores the input" push "v0.10.0" ok > "${body_file}"
assert_idle_outputs "tag push" "$(cat "${body_file}")"
echo "    PASS: a tag push leaves checkout_ref and version empty"

run_case "pull request ignores the input" pull_request "v0.10.0" ok > "${body_file}"
assert_idle_outputs "pull request" "$(cat "${body_file}")"
echo "    PASS: a pull request leaves checkout_ref and version empty"

bad_refs=(
  "v1.2"
  "v1.2.3-rc1"
  "v1.2.3; touch /tmp/ill411-pwned"
  'v1.2.3 && echo pwned'
  '$(id)'
  '`id`'
  "refs/tags/v1.2.3"
  " v0.10.0"
)
bad_refs+=($'v0.10.0\ncheckout_ref=evil')
for bad in "${bad_refs[@]}"; do
  run_case "reject" workflow_dispatch "${bad}" bad >/dev/null
done
echo "    PASS: short, pre-release, and injection-shaped refs are rejected"

arabic_locale="$(locale -a 2>/dev/null | grep -Ei '^en_US\.(utf-8|utf8)$' | head -n 1 || true)"
if [[ -n "${arabic_locale}" ]]; then
  arabic_out="$(mktemp)"
  set +e
  LC_ALL="${arabic_locale}" EVENT_NAME="workflow_dispatch" DISPATCH_REF="v١.٢.٣" GITHUB_OUTPUT="${arabic_out}" bash -c "${SCRIPT}"
  arabic_status=$?
  set -e
  rm -f "${arabic_out}"
  if [[ ${arabic_status} -eq 0 ]]; then
    echo "    FAIL: Arabic-Indic digits were accepted under ${arabic_locale}" >&2
    exit 1
  fi
  echo "    PASS: Arabic-Indic digits are rejected under ${arabic_locale}"
else
  echo "    SKIP: Arabic-Indic digits (en_US.UTF-8 is not installed)"
fi

if [[ -e /tmp/ill411-pwned ]]; then
  echo "    FAIL: an injection-shaped ref executed"
  rm -f /tmp/ill411-pwned
  exit 1
fi

echo "    All dispatch ref checks passed."
