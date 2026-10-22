#!/usr/bin/env python3
"""Compressed size of a GHCR image, per platform, from its manifest digest.

Arguments, or the environment when no arguments are given:
  image name   IMAGE_NAME       ghcr.io/<path>
  digest       IMAGE_DIGEST     sha256:<64 hex>
  limit in MB  SIZE_LIMIT_MB    positive integer

IMAGE_SIZE_FIXTURE_DIR, when set, reads <dir>/<digest>.json and never calls
docker. Otherwise each manifest is read with
`docker buildx imagetools inspect --raw`, as a list-form subprocess.
"""

import json
import os
import re
import subprocess
import sys
import unicodedata

IMAGE_RE = re.compile(r"^ghcr\.io/[a-z0-9._/-]+$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
MIB = 1024 * 1024
ATTESTATION_ANNOTATION = "vnd.docker.reference.type"


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_limit(raw):
    text = str(raw).strip()
    if not re.fullmatch(r"[0-9]+", text):
        fail("invalid size limit")
    value = int(text)
    if value < 1:
        fail("invalid size limit")
    return value


def resolve_inputs():
    if len(sys.argv) == 4:
        image, digest, limit = sys.argv[1], sys.argv[2], sys.argv[3]
    elif len(sys.argv) == 1:
        image = os.environ.get("IMAGE_NAME", "")
        digest = os.environ.get("IMAGE_DIGEST", "")
        limit = os.environ.get("SIZE_LIMIT_MB", "")
    else:
        fail("usage: image-compressed-size.py [image digest limit_mb]")
    image = str(image).strip()
    digest = str(digest).strip()
    if not image or not digest or str(limit).strip() == "":
        fail("image name, digest, and limit are required")
    if not IMAGE_RE.fullmatch(image):
        fail("invalid image name")
    if not DIGEST_RE.fullmatch(digest):
        fail("invalid image digest")
    return image, digest, parse_limit(limit)


def format_mb(size_bytes):
    thousandths = (size_bytes * 1000 + MIB // 2) // MIB
    whole, frac = divmod(thousandths, 1000)
    return f"{whole}.{frac:03d}"


def load_fixture(fixture_dir, digest):
    path = os.path.join(fixture_dir, digest + ".json")
    if not os.path.isfile(path):
        fail(f"missing fixture for {digest}")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError):
        fail(f"malformed manifest JSON for {digest}")
    if not isinstance(data, dict):
        fail(f"malformed manifest JSON for {digest}")
    return data


def docker_stderr_excerpt(raw):
    """First stderr line, control characters removed, at most 200 characters."""
    if isinstance(raw, (bytes, bytearray)):
        text = raw.decode("utf-8", errors="replace")
    else:
        text = str(raw or "")
    lines = text.splitlines()
    first = lines[0] if lines else ""
    cleaned = "".join(ch for ch in first if unicodedata.category(ch)[0] != "C")
    return cleaned[:200]


def load_docker(image, digest):
    ref = image + "@" + digest
    try:
        completed = subprocess.run(
            ["docker", "buildx", "imagetools", "inspect", "--raw", ref],
            check=False,
            capture_output=True,
            shell=False,
        )
    except OSError:
        fail(f"docker inspect failed for {digest}")
    if completed.returncode != 0:
        excerpt = docker_stderr_excerpt(completed.stderr)
        if excerpt:
            fail(f"docker inspect failed for {digest}: {excerpt}")
        fail(f"docker inspect failed for {digest}")
    try:
        data = json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        fail(f"malformed manifest JSON for {digest}")
    if not isinstance(data, dict):
        fail(f"malformed manifest JSON for {digest}")
    return data


def load_manifest(image, digest):
    fixture_dir = os.environ.get("IMAGE_SIZE_FIXTURE_DIR", "")
    if fixture_dir:
        return load_fixture(fixture_dir, digest)
    return load_docker(image, digest)


def is_attestation(entry):
    platform = entry.get("platform")
    if isinstance(platform, dict):
        if platform.get("os") == "unknown" and platform.get("architecture") == "unknown":
            return True
    annotations = entry.get("annotations")
    if isinstance(annotations, dict):
        for key in annotations:
            if key == ATTESTATION_ANNOTATION or str(key).endswith("/" + ATTESTATION_ANNOTATION):
                return True
    return False


def platform_label(platform):
    if not isinstance(platform, dict):
        return "single"
    os_name = platform.get("os") or "unknown"
    arch = platform.get("architecture") or "unknown"
    label = f"{os_name}/{arch}"
    variant = platform.get("variant")
    if variant:
        label = f"{label}/{variant}"
    return label


def require_size(value, what):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        fail(f"malformed manifest JSON: {what}")
    return value


def platform_bytes(manifest, label):
    layers = manifest.get("layers")
    if not isinstance(layers, list) or len(layers) == 0:
        fail(f"platform {label} has zero layers")
    config = manifest.get("config")
    if not isinstance(config, dict):
        fail(f"malformed manifest JSON: {label} config")
    total = require_size(config.get("size"), f"{label} config size")
    for index, layer in enumerate(layers):
        if not isinstance(layer, dict):
            fail(f"malformed manifest JSON: {label} layer {index}")
        total += require_size(layer.get("size"), f"{label} layer {index} size")
    return total


def is_index(data):
    return isinstance(data.get("manifests"), list)


def collect_platforms(image, digest):
    root = load_manifest(image, digest)
    if is_index(root):
        manifests = root["manifests"]
        if len(manifests) == 0:
            fail("empty image index")
        platforms = []
        for entry in manifests:
            if not isinstance(entry, dict):
                fail("malformed manifest JSON: index entry")
            if is_attestation(entry):
                continue
            child = entry.get("digest")
            if not isinstance(child, str) or not DIGEST_RE.fullmatch(child):
                fail("missing digest in image index")
            label = platform_label(entry.get("platform"))
            child_manifest = load_manifest(image, child)
            if is_index(child_manifest):
                fail(f"malformed manifest JSON: {label} is not an image manifest")
            platforms.append((label, platform_bytes(child_manifest, label)))
        if not platforms:
            fail("empty image index")
        return platforms
    if "layers" in root or "config" in root:
        label = platform_label(root.get("platform")) if isinstance(root.get("platform"), dict) else "single"
        return [(label, platform_bytes(root, label))]
    fail("malformed manifest JSON: unrecognized manifest")


def write_summary(path, platforms, limit_mb, limit_bytes):
    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("## Compressed image size\n\n")
            handle.write("| Platform | Size (MB) | Limit (MB) | Result |\n")
            handle.write("| --- | --- | --- | --- |\n")
            for label, size_bytes in platforms:
                result = "fail" if size_bytes > limit_bytes else "pass"
                handle.write(f"| {label} | {format_mb(size_bytes)} | {limit_mb} | {result} |\n")
            handle.write("\n")
    except OSError:
        fail("could not write the job summary")


def main():
    image, digest, limit_mb = resolve_inputs()
    platforms = collect_platforms(image, digest)
    limit_bytes = limit_mb * MIB
    exceeded = []
    for label, size_bytes in platforms:
        mb = format_mb(size_bytes)
        print(f"{label} {mb} MB limit {limit_mb} MB")
        if size_bytes > limit_bytes:
            exceeded.append(f"{label} is {mb} MB")
    summary = os.environ.get("GITHUB_STEP_SUMMARY", "")
    if summary:
        write_summary(summary, platforms, limit_mb, limit_bytes)
    if exceeded:
        fail("; ".join(exceeded) + f"; exceeds limit of {limit_mb} MB")


if __name__ == "__main__":
    main()
