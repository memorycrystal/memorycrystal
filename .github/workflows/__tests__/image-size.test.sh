#!/usr/bin/env bash
# Compressed image size is config plus layers, per platform, from the digest.
# Fixture mode must not call docker. Values reach the publish step only through env.
set -euo pipefail

# Fixture tables stay off the real Validate summary. A case that wants a
# summary file sets GITHUB_STEP_SUMMARY for that command only.
CALLER_SUMMARY="${GITHUB_STEP_SUMMARY:-}"
CALLER_SUMMARY_BYTES=0
if [[ -n "${CALLER_SUMMARY}" && -f "${CALLER_SUMMARY}" ]]; then
  CALLER_SUMMARY_BYTES="$(wc -c < "${CALLER_SUMMARY}" | tr -d ' ')"
fi
unset GITHUB_STEP_SUMMARY

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
SCRIPT="${IMAGE_SIZE_SCRIPT:-${REPO_ROOT}/.github/scripts/image-compressed-size.py}"
WORKFLOW="${REPO_ROOT}/.github/workflows/publish-selfhosted-images.yml"
MARKER="/tmp/ill425-size-pwned"
IMAGE="ghcr.io/memorycrystal/mcp"

rm -f "${MARKER}"

if [[ ! -f "${SCRIPT}" ]]; then
  echo "    FAIL: size script is missing" >&2
  exit 1
fi

if grep -n -E 'shell[[:space:]]*=[[:space:]]*True|os\.system\(|os\.popen\(' "${SCRIPT}"; then
  echo "    FAIL: size script can run a shell command" >&2
  exit 1
fi
for piece in '"docker"' '"buildx"' '"imagetools"' '"inspect"' '"--raw"' 'shell=False'; do
  if ! grep -F -q "${piece}" "${SCRIPT}"; then
    echo "    FAIL: size script is missing ${piece}" >&2
    exit 1
  fi
done

echo "==> image-size.test.sh"
echo "    Script: ${SCRIPT}"

hex_digest() {
  python3 -c 'import sys; print("sha256:" + (sys.argv[1] * 64))' "$1"
}

INDEX="$(hex_digest a)"
AMD="$(hex_digest b)"
ARM="$(hex_digest c)"
ATT="$(hex_digest d)"
SINGLE="$(hex_digest e)"
ZERO="$(hex_digest 1)"
BAD_JSON="$(hex_digest 2)"
EMPTY="$(hex_digest 3)"
NO_DIGEST="$(hex_digest 4)"
MISSING="$(hex_digest f)"

FIXTURE_DIR="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "${FIXTURE_DIR}" "${FAKE_BIN}"' EXIT

cat > "${FAKE_BIN}/docker" <<EOF
#!/bin/sh
touch "${MARKER}"
exit 99
EOF
chmod +x "${FAKE_BIN}/docker"

python3 - "${FIXTURE_DIR}" "${INDEX}" "${AMD}" "${ARM}" "${ATT}" "${SINGLE}" "${ZERO}" "${BAD_JSON}" "${EMPTY}" "${NO_DIGEST}" <<'PY'
import json, os, sys
root, index, amd, arm, att, single, zero, bad, empty, no_digest = sys.argv[1:]
mib = 1024 * 1024

def dump(digest, obj):
    with open(os.path.join(root, digest + ".json"), "w", encoding="utf-8") as handle:
        json.dump(obj, handle)

def image(config, layer):
    return {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {
            "mediaType": "application/vnd.oci.image.config.v1+json",
            "digest": "sha256:" + ("9" * 64),
            "size": config,
        },
        "layers": [{
            "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
            "digest": "sha256:" + ("8" * 64),
            "size": layer,
        }],
    }

dump(amd, image(mib, 9 * mib))
dump(arm, image(mib, 4 * mib))
dump(att, image(mib, 500 * mib))
dump(single, image(mib, 2 * mib))
dump(zero, {
    "schemaVersion": 2,
    "mediaType": "application/vnd.oci.image.manifest.v1+json",
    "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "size": mib},
    "layers": [],
})
dump(index, {
    "schemaVersion": 2,
    "mediaType": "application/vnd.oci.image.index.v1+json",
    "manifests": [
        {
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "digest": amd,
            "size": 512,
            "platform": {"architecture": "amd64", "os": "linux"},
        },
        {
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "digest": arm,
            "size": 600,
            "platform": {"architecture": "arm64", "os": "linux"},
        },
        {
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "digest": att,
            "size": 999999,
            "platform": {"architecture": "unknown", "os": "unknown"},
            "annotations": {"vnd.docker.reference.type": "attestation-manifest"},
        },
    ],
})
with open(os.path.join(root, bad + ".json"), "w", encoding="utf-8") as handle:
    handle.write("{")
dump(empty, {
    "schemaVersion": 2,
    "mediaType": "application/vnd.oci.image.index.v1+json",
    "manifests": [],
})
dump(no_digest, {
    "schemaVersion": 2,
    "mediaType": "application/vnd.oci.image.index.v1+json",
    "manifests": [{
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "size": 512,
        "platform": {"architecture": "amd64", "os": "linux"},
    }],
})
PY

MIB_BYTES="$(python3 - "${SCRIPT}" <<'PY'
import ast
import sys

def evaluate(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, int) and not isinstance(node.value, bool):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Mult, ast.Add, ast.Sub)):
        left = evaluate(node.left)
        right = evaluate(node.right)
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Add):
            return left + right
        return left - right
    raise SystemExit("MIB is not a plain integer expression")

tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
value = None
for node in tree.body:
    if isinstance(node, ast.Assign):
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == "MIB":
                value = evaluate(node.value)
if value is None or value < 1:
    raise SystemExit("MIB is missing")
print(value)
PY
)"

AT_LIMIT="$(hex_digest 5)"
OVER_BYTE="$(hex_digest 6)"
MARK_INDEX="$(hex_digest 7)"
HUGE_PLATFORM="$(hex_digest 8)"
HUGE_ANNOTATION="$(hex_digest 9)"

python3 - "${FIXTURE_DIR}" "${MIB_BYTES}" "${AMD}" "${AT_LIMIT}" "${OVER_BYTE}" "${MARK_INDEX}" "${HUGE_PLATFORM}" "${HUGE_ANNOTATION}" <<'PY'
import json, os, sys
root, mib_text, amd, at_limit, over_byte, index, huge_platform, huge_annotation = sys.argv[1:]
mib = int(mib_text)

def dump(digest, obj):
    with open(os.path.join(root, digest + ".json"), "w", encoding="utf-8") as handle:
        json.dump(obj, handle)

def image(total):
    return {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {
            "mediaType": "application/vnd.oci.image.config.v1+json",
            "digest": "sha256:" + ("9" * 64),
            "size": 1,
        },
        "layers": [{
            "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
            "digest": "sha256:" + ("8" * 64),
            "size": total - 1,
        }],
    }

dump(at_limit, image(80 * mib))
dump(over_byte, image(80 * mib + 1))
dump(huge_platform, image(500 * mib))
dump(huge_annotation, image(500 * mib))
dump(index, {
    "schemaVersion": 2,
    "mediaType": "application/vnd.oci.image.index.v1+json",
    "manifests": [
        {
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "digest": amd,
            "size": 512,
            "platform": {"architecture": "amd64", "os": "linux"},
        },
        {
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "digest": huge_platform,
            "size": 999999,
            "platform": {"architecture": "unknown", "os": "unknown"},
        },
        {
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "digest": huge_annotation,
            "size": 999999,
            "platform": {"architecture": "arm64", "os": "linux"},
            "annotations": {"vnd.docker.reference.type": "attestation-manifest"},
        },
    ],
})
PY

LAST_STATUS=0
LAST_OUT=""
LAST_ERR=""

capture() {
  local out err
  out="$(mktemp)"
  err="$(mktemp)"
  set +e
  PATH="${FAKE_BIN}:${PATH}" IMAGE_SIZE_FIXTURE_DIR="${FIXTURE_DIR}" "$@" >"${out}" 2>"${err}"
  LAST_STATUS=$?
  set -e
  LAST_OUT="$(cat "${out}")"
  LAST_ERR="$(cat "${err}")"
  rm -f "${out}" "${err}"
  if [[ -e "${MARKER}" ]]; then
    echo "    FAIL: docker or a shell command created ${MARKER}" >&2
    rm -f "${MARKER}"
    exit 1
  fi
}

assert_one_error() {
  local lines
  lines="$(printf '%s\n' "${LAST_ERR}" | wc -l | tr -d ' ')"
  if [[ "${lines}" -ne 1 || "${LAST_ERR}" != error:* ]]; then
    echo "    FAIL: expected one stderr error line, got status=${LAST_STATUS}" >&2
    printf '    stderr: %s\n' "${LAST_ERR}" >&2
    exit 1
  fi
}

assert_stdout() {
  local expected="$1"
  if [[ "${LAST_OUT}" != "${expected}" ]]; then
    echo "    FAIL: stdout mismatch" >&2
    printf '    expected: %s\n' "${expected}" >&2
    printf '    actual:   %s\n' "${LAST_OUT}" >&2
    exit 1
  fi
}

# Index: two platforms plus an attestation. Descriptor sizes must not be the result.
capture env IMAGE_NAME="${IMAGE}" IMAGE_DIGEST="${INDEX}" SIZE_LIMIT_MB=80 python3 "${SCRIPT}"
if [[ "${LAST_STATUS}" -ne 0 || -n "${LAST_ERR}" ]]; then
  echo "    FAIL: two platforms under 80 MB exited ${LAST_STATUS}: ${LAST_ERR}" >&2
  exit 1
fi
assert_stdout $'linux/amd64 10.000 MB limit 80 MB\nlinux/arm64 5.000 MB limit 80 MB'
echo "    PASS: per-platform MB ignores the attestation entry and the descriptor sizes"

# Arguments win over a conflicting environment, same measurement.
capture env IMAGE_NAME="ghcr.io/memorycrystal/other" IMAGE_DIGEST="${MISSING}" SIZE_LIMIT_MB=1 \
  python3 "${SCRIPT}" "${IMAGE}" "${INDEX}" 80
if [[ "${LAST_STATUS}" -ne 0 ]]; then
  echo "    FAIL: argv form exited ${LAST_STATUS}: ${LAST_ERR}" >&2
  exit 1
fi
assert_stdout $'linux/amd64 10.000 MB limit 80 MB\nlinux/arm64 5.000 MB limit 80 MB'
echo "    PASS: argv form reports the same sizes"

capture env IMAGE_NAME="${IMAGE}" IMAGE_DIGEST="${INDEX}" SIZE_LIMIT_MB=4 python3 "${SCRIPT}"
if [[ "${LAST_STATUS}" -eq 0 ]]; then
  echo "    FAIL: both platforms over 4 MB were accepted" >&2
  exit 1
fi
assert_one_error
assert_stdout $'linux/amd64 10.000 MB limit 4 MB\nlinux/arm64 5.000 MB limit 4 MB'
if [[ "${LAST_ERR}" != *"linux/amd64"* || "${LAST_ERR}" != *"linux/arm64"* || "${LAST_ERR}" != *"exceeds limit of 4 MB" ]]; then
  echo "    FAIL: over-limit error did not name both platforms: ${LAST_ERR}" >&2
  exit 1
fi
echo "    PASS: both platforms over the limit fail"

capture env IMAGE_NAME="${IMAGE}" IMAGE_DIGEST="${INDEX}" SIZE_LIMIT_MB=8 python3 "${SCRIPT}"
if [[ "${LAST_STATUS}" -eq 0 ]]; then
  echo "    FAIL: a platform over 8 MB was accepted" >&2
  exit 1
fi
assert_one_error
assert_stdout $'linux/amd64 10.000 MB limit 8 MB\nlinux/arm64 5.000 MB limit 8 MB'
if [[ "${LAST_ERR}" != *"linux/amd64"* || "${LAST_ERR}" == *"linux/arm64"* ]]; then
  echo "    FAIL: mixed-limit error should name only linux/amd64: ${LAST_ERR}" >&2
  exit 1
fi
echo "    PASS: one platform over the limit fails while the other is under"

capture env IMAGE_NAME="${IMAGE}" IMAGE_DIGEST="${SINGLE}" SIZE_LIMIT_MB=80 python3 "${SCRIPT}"
if [[ "${LAST_STATUS}" -ne 0 || -n "${LAST_ERR}" ]]; then
  echo "    FAIL: single manifest exited ${LAST_STATUS}: ${LAST_ERR}" >&2
  exit 1
fi
assert_stdout 'single 3.000 MB limit 80 MB'
echo "    PASS: a single manifest is one platform"

capture env IMAGE_NAME="${IMAGE}" IMAGE_DIGEST="${AT_LIMIT}" SIZE_LIMIT_MB=80 python3 "${SCRIPT}"
if [[ "${LAST_STATUS}" -ne 0 || -n "${LAST_ERR}" ]]; then
  echo "    FAIL: exactly 80 MiB exited ${LAST_STATUS}: ${LAST_ERR}" >&2
  exit 1
fi
assert_stdout 'single 80.000 MB limit 80 MB'
EXACT_SUMMARY="${FIXTURE_DIR}/exact-summary.md"
capture env GITHUB_STEP_SUMMARY="${EXACT_SUMMARY}" IMAGE_NAME="${IMAGE}" IMAGE_DIGEST="${AT_LIMIT}" SIZE_LIMIT_MB=80 python3 "${SCRIPT}"
if [[ "${LAST_STATUS}" -ne 0 ]]; then
  echo "    FAIL: exactly 80 MiB summary run exited ${LAST_STATUS}: ${LAST_ERR}" >&2
  exit 1
fi
if [[ "$(cat "${EXACT_SUMMARY}")" != *'| single | 80.000 | 80 | pass |'* ]]; then
  echo "    FAIL: exactly 80 MiB summary is not a pass" >&2
  exit 1
fi
echo "    PASS: a platform exactly at 80 MiB passes"

OVER_SUMMARY="${FIXTURE_DIR}/over-summary.md"
printf 'preexisting\n' > "${OVER_SUMMARY}"
capture env GITHUB_STEP_SUMMARY="${OVER_SUMMARY}" IMAGE_NAME="${IMAGE}" IMAGE_DIGEST="${OVER_BYTE}" SIZE_LIMIT_MB=80 python3 "${SCRIPT}"
if [[ "${LAST_STATUS}" -eq 0 ]]; then
  echo "    FAIL: 1 byte over 80 MiB was accepted" >&2
  exit 1
fi
assert_one_error
assert_stdout 'single 80.000 MB limit 80 MB'
if [[ "${LAST_ERR}" != *"exceeds limit of 80 MB"* ]]; then
  echo "    FAIL: 1 byte over did not name the limit: ${LAST_ERR}" >&2
  exit 1
fi
over_summary="$(cat "${OVER_SUMMARY}")"
if [[ "${over_summary}" != preexisting*$'\n'* ]]; then
  echo "    FAIL: failing run overwrote the summary" >&2
  exit 1
fi
for row in \
  '| Platform | Size (MB) | Limit (MB) | Result |' \
  '| single | 80.000 | 80 | fail |'
do
  if [[ "${over_summary}" != *"${row}"* ]]; then
    echo "    FAIL: failing run summary is missing ${row}" >&2
    printf '    summary: %s\n' "${over_summary}" >&2
    exit 1
  fi
done
echo "    PASS: 1 byte over 80 MiB fails and still writes the summary table"

capture env IMAGE_NAME="${IMAGE}" IMAGE_DIGEST="${MARK_INDEX}" SIZE_LIMIT_MB=80 python3 "${SCRIPT}"
if [[ "${LAST_STATUS}" -ne 0 || -n "${LAST_ERR}" ]]; then
  echo "    FAIL: single-marker attestations exited ${LAST_STATUS}: ${LAST_ERR}" >&2
  exit 1
fi
assert_stdout 'linux/amd64 10.000 MB limit 80 MB'
if [[ "${LAST_OUT}" == *"unknown/unknown"* || "${LAST_OUT}" == *"linux/arm64"* ]]; then
  echo "    FAIL: a single-marker attestation was counted: ${LAST_OUT}" >&2
  exit 1
fi
echo "    PASS: attestations marked only by platform or only by annotation are skipped"

fail_closed() {
  local name="$1"
  shift
  capture "$@"
  if [[ "${LAST_STATUS}" -eq 0 ]]; then
    echo "    FAIL: ${name} was accepted" >&2
    exit 1
  fi
  if [[ -n "${LAST_OUT}" ]]; then
    echo "    FAIL: ${name} wrote stdout: ${LAST_OUT}" >&2
    exit 1
  fi
  assert_one_error
  echo "    PASS: ${name}"
}

fail_closed "malformed JSON" env IMAGE_NAME="${IMAGE}" IMAGE_DIGEST="${BAD_JSON}" SIZE_LIMIT_MB=80 python3 "${SCRIPT}"
if [[ "${LAST_ERR}" != *"malformed manifest JSON"* ]]; then
  echo "    FAIL: malformed JSON error was ${LAST_ERR}" >&2
  exit 1
fi

fail_closed "empty index" env IMAGE_NAME="${IMAGE}" IMAGE_DIGEST="${EMPTY}" SIZE_LIMIT_MB=80 python3 "${SCRIPT}"
if [[ "${LAST_ERR}" != *"empty image index"* ]]; then
  echo "    FAIL: empty index error was ${LAST_ERR}" >&2
  exit 1
fi

fail_closed "zero layers" env IMAGE_NAME="${IMAGE}" IMAGE_DIGEST="${ZERO}" SIZE_LIMIT_MB=80 python3 "${SCRIPT}"
if [[ "${LAST_ERR}" != *"zero layers"* ]]; then
  echo "    FAIL: zero-layer error was ${LAST_ERR}" >&2
  exit 1
fi

fail_closed "missing fixture" env IMAGE_NAME="${IMAGE}" IMAGE_DIGEST="${MISSING}" SIZE_LIMIT_MB=80 python3 "${SCRIPT}"
if [[ "${LAST_ERR}" != *"missing fixture"* ]]; then
  echo "    FAIL: missing fixture error was ${LAST_ERR}" >&2
  exit 1
fi

fail_closed "missing digest" env IMAGE_NAME="${IMAGE}" IMAGE_DIGEST="${NO_DIGEST}" SIZE_LIMIT_MB=80 python3 "${SCRIPT}"
if [[ "${LAST_ERR}" != *"missing digest"* ]]; then
  echo "    FAIL: missing digest error was ${LAST_ERR}" >&2
  exit 1
fi

fail_closed "invalid digest" python3 "${SCRIPT}" "${IMAGE}" 'sha256:$(touch /tmp/ill425-size-pwned)' 80
if [[ "${LAST_ERR}" != *"invalid image digest"* ]]; then
  echo "    FAIL: invalid digest error was ${LAST_ERR}" >&2
  exit 1
fi

fail_closed "injection-shaped image name" python3 "${SCRIPT}" 'ghcr.io/x;touch /tmp/ill425-size-pwned' "${INDEX}" 80
if [[ "${LAST_ERR}" != *"invalid image name"* ]]; then
  echo "    FAIL: injection name error was ${LAST_ERR}" >&2
  exit 1
fi

fail_closed "command-substitution image name" python3 "${SCRIPT}" 'ghcr.io/x$(touch /tmp/ill425-size-pwned)' "${INDEX}" 80
fail_closed "backtick image name" python3 "${SCRIPT}" 'ghcr.io/x`touch /tmp/ill425-size-pwned`' "${INDEX}" 80

SUMMARY="${FIXTURE_DIR}/summary.md"
printf 'preexisting\n' > "${SUMMARY}"
capture env GITHUB_STEP_SUMMARY="${SUMMARY}" IMAGE_NAME="${IMAGE}" IMAGE_DIGEST="${INDEX}" SIZE_LIMIT_MB=80 python3 "${SCRIPT}"
if [[ "${LAST_STATUS}" -ne 0 ]]; then
  echo "    FAIL: summary run exited ${LAST_STATUS}: ${LAST_ERR}" >&2
  exit 1
fi
summary_body="$(cat "${SUMMARY}")"
if [[ "${summary_body}" != preexisting*$'\n'* ]]; then
  echo "    FAIL: summary overwrote existing text" >&2
  exit 1
fi
for row in \
  '| Platform | Size (MB) | Limit (MB) | Result |' \
  '| linux/amd64 | 10.000 | 80 | pass |' \
  '| linux/arm64 | 5.000 | 80 | pass |'
do
  if [[ "${summary_body}" != *"${row}"* ]]; then
    echo "    FAIL: summary is missing ${row}" >&2
    exit 1
  fi
done
echo "    PASS: GITHUB_STEP_SUMMARY receives a table"

if grep -R -n --include='*.yml' -e 'workflow_run:' "${REPO_ROOT}/.github/workflows" >/dev/null; then
  echo "    FAIL: a workflow still uses workflow_run" >&2
  exit 1
fi
echo "    PASS: no workflow consumes another via workflow_run"

node --input-type=module -e '
import { readFileSync } from "node:fs";
import { parse } from "yaml";
const doc = parse(readFileSync(process.argv[1], "utf8"));
const steps = doc.jobs.merge.steps;
const names = steps.map((step) => step.name);
const sbom = names.indexOf("Attach SBOM as cosign attestation");
const size = names.indexOf("Check compressed image size by digest");
const summary = names.indexOf("Write job summary");
if (sbom < 0 || size < 0 || summary < 0 || !(sbom < size && size < summary)) {
  console.error("size step is not between the SBOM attestation and the job summary");
  process.exit(1);
}
const step = steps[size];
if (step.uses) {
  console.error("size step must run the script, not an action");
  process.exit(1);
}
if (step.if !== "github.event_name != \u0027pull_request\u0027") {
  console.error("size step condition is not the push condition");
  process.exit(1);
}
const expected = {
  IMAGE_NAME: "${{ steps.image.outputs.name }}",
  IMAGE_DIGEST: "${{ steps.index.outputs.digest }}",
  SIZE_LIMIT_MB: "${{ matrix.size_limit_mb }}",
};
const env = step.env ?? {};
const keys = Object.keys(env).sort();
const want = Object.keys(expected).sort();
if (keys.join(",") !== want.join(",")) {
  console.error("size step env keys are not the three values");
  process.exit(1);
}
for (const key of want) {
  if (env[key] !== expected[key]) {
    console.error("size step env " + key + " is not the expected expression");
    process.exit(1);
  }
}
const run = String(step.run ?? "").trim();
if (run !== "python3 .github/scripts/image-compressed-size.py") {
  console.error("size step does not run the script");
  process.exit(1);
}
if (run.includes("${{") || run.includes("steps.image") || run.includes("steps.build") || run.includes("matrix.size_limit")) {
  console.error("size step interpolates a value into the script");
  process.exit(1);
}
' "${WORKFLOW}"
echo "    PASS: publish step passes the three values only through env, after the SBOM attestation"

if [[ -e "${MARKER}" ]]; then
  echo "    FAIL: marker file exists at the end" >&2
  rm -f "${MARKER}"
  exit 1
fi

# docker buildx imagetools inspect failed: one stderr line, first docker line,
# control characters stripped, excerpt truncated to 200 characters.
DOCKER_ERR_BIN="$(mktemp -d)"
cat > "${DOCKER_ERR_BIN}/docker" <<'EOF'
#!/usr/bin/env python3
import os, sys
if os.environ["EXCERPT_CASE"] == "short":
    sys.stderr.write("inspect-failed \x01\x1b[31m\u0080\u202eZ\nsecond-line-must-stay-off\n")
else:
    sys.stderr.write("inspect-failed " + ("Z" * 240) + "\x01\x1b[31m\nsecond-line-must-stay-off\n")
sys.exit(4)
EOF
chmod +x "${DOCKER_ERR_BIN}/docker"
for excerpt_case in short long; do
docker_out="$(mktemp)"
docker_err="$(mktemp)"
set +e
env -u IMAGE_SIZE_FIXTURE_DIR -u GITHUB_STEP_SUMMARY \
  PATH="${DOCKER_ERR_BIN}:${PATH}" EXCERPT_CASE="${excerpt_case}" \
  python3 "${SCRIPT}" "${IMAGE}" "${INDEX}" 80 >"${docker_out}" 2>"${docker_err}"
docker_status=$?
set -e
python3 - "${docker_err}" "${docker_out}" "${docker_status}" "${excerpt_case}" <<'PY'
import pathlib, sys, unicodedata
err = pathlib.Path(sys.argv[1]).read_bytes()
out = pathlib.Path(sys.argv[2]).read_bytes()
status = int(sys.argv[3])
if status == 0:
    raise SystemExit("docker failure was accepted")
if out.strip():
    raise SystemExit("docker failure wrote stdout")
text = err.decode("utf-8")
lines = text.splitlines()
if len(lines) != 1:
    raise SystemExit("expected one stderr line, got %s" % len(lines))
line = lines[0]
if "second-line-must-stay-off" in line:
    raise SystemExit("excerpt kept a later stderr line")
if any(unicodedata.category(ch)[0] == "C" for ch in line):
    raise SystemExit("excerpt kept a control character")
marker = "inspect-failed "
if not line.startswith("error: docker inspect failed for ") or marker not in line:
    raise SystemExit("error line did not include the docker excerpt")
body = line[line.rfind(": ") + 2:]
if sys.argv[4] == "short" and body != marker + "[31mZ":
    raise SystemExit("short excerpt changed printable text")
if sys.argv[4] == "long" and (len(body) != 200 or not body.startswith(marker) or set(body[len(marker):]) != {"Z"}):
    raise SystemExit("excerpt length or shape is wrong: %s" % len(body))
PY
rm -f "${docker_out}" "${docker_err}"
done
rm -rf "${DOCKER_ERR_BIN}"
echo "    PASS: docker inspect failure prints one truncated stderr excerpt"

if [[ -n "${CALLER_SUMMARY}" && -f "${CALLER_SUMMARY}" ]]; then
  caller_now="$(wc -c < "${CALLER_SUMMARY}" | tr -d ' ')"
  if [[ "${caller_now}" != "${CALLER_SUMMARY_BYTES}" ]]; then
    echo "    FAIL: fixture tables were appended to the caller job summary" >&2
    exit 1
  fi
  echo "    PASS: caller job summary was left unchanged"
fi

echo "    All image size checks passed."
