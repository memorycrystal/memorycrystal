#!/usr/bin/env bash
# Bash unit test for install.sh start_browser_auth (15h review US-7).
#
# Without the denied|revoked|cancelled exit, a denied poll response would
# loop for ~10 minutes (120 iterations × 5s sleep) before the timeout fail
# fires. With the fix the function exits immediately with a clear message.
#
# Strategy:
#   1. Spin up a Python HTTP stub on a random localhost port that always
#      returns {"status":"denied"} for /api/device/status and a valid
#      start payload for /api/device/start.
#   2. Extract start_browser_auth + json_field + helpers from install.sh
#      and rewrite them to bypass the [-r /dev/tty] / DRY_RUN / NONINTERACTIVE
#      early-exit guards (the test runs without a controlling tty).
#   3. Run the wrapper with a 30-second hard cap. The fix is verified iff
#      the wrapper exits in well under 30s (i.e. NOT the 10-minute loop)
#      with a message mentioning denied/cancelled.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_SH="$REPO_ROOT/apps/web/public/install.sh"
TMP_DIR="$(mktemp -d -t browser-auth-denied.XXXXXX)"
trap 'cleanup' EXIT

STUB_PID=""
cleanup() {
  if [ -n "$STUB_PID" ]; then kill "$STUB_PID" 2>/dev/null || true; fi
  rm -rf "$TMP_DIR"
}

# 1. Stub HTTP server.
cat >"$TMP_DIR/stub_server.py" <<'PY'
import http.server
import json
import socket
import sys
import threading

class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path == "/api/device/start":
            self._send({
                "device_code": "deny-test-device",
                "user_code": "DENY-1234",
                "verification_url": "http://localhost/verify",
            })
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path.startswith("/api/device/status"):
            self._send({"status": "denied"})
        else:
            self.send_error(404)

    def log_message(self, *a, **kw):
        pass

with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]

server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
sys.stdout.write(str(port) + "\n")
sys.stdout.flush()

# Park so the server keeps running until the test kills us.
import time
while True:
    time.sleep(60)
PY

python3 "$TMP_DIR/stub_server.py" >"$TMP_DIR/stub.port" 2>"$TMP_DIR/stub.err" &
STUB_PID=$!

# Wait briefly for the stub to publish its port.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -s "$TMP_DIR/stub.port" ]; then break; fi
  sleep 0.1
done
PORT="$(cat "$TMP_DIR/stub.port" | tr -d '\n')"
if [ -z "$PORT" ]; then
  echo "  [err] stub server did not publish a port"
  exit 1
fi

# 2. Build a wrapper that includes the helpers + start_browser_auth, but
# strips the early-exit guards so the function actually runs the loop.
python3 - "$INSTALL_SH" "$TMP_DIR/wrapper.sh" "$PORT" <<'PY'
import re, sys
src, dest, port = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(src).read()
def grab(name):
    m = re.search(r'(' + name + r'\(\) \{.*?\n\})', text, re.DOTALL)
    if not m: sys.exit("could not find function " + name)
    return m.group(1)
fns = "\n".join([grab("json_field"), grab("json_escape"), grab("redact"),
                 grab("start_browser_auth")])
# Strip the early-exit guards so the function exercises the polling case.
fns = re.sub(r'\[ "\$DRY_RUN" = "1" \] && return 1\n\s*', '', fns)
fns = re.sub(r'\[ "\$NONINTERACTIVE" = "1" \] && return 1\n\s*', '', fns)
fns = re.sub(r'\[ -r /dev/tty \] \|\| return 1\n\s*', '', fns)

wrapper = f"""#!/usr/bin/env bash
set -uo pipefail
CLOUD_CONVEX_URL="http://127.0.0.1:{port}"
DRY_RUN=0
NONINTERACTIVE=0
API_KEY=""
API_KEY_SOURCE=""
log() {{ printf '  %s\\n' "$*"; }}
ok() {{ printf '  [ok] %s\\n' "$*"; }}
warn() {{ printf '  (i) %s\\n' "$*"; }}
fail() {{ printf '  [err] %s\\n' "$*" >&2; exit 1; }}
open_url() {{ return 0; }}
{fns}
start_browser_auth
"""
open(dest, "w").write(wrapper)
PY

chmod +x "$TMP_DIR/wrapper.sh"

# 3. Run with a hard cap. With the fix, the function exits in ~5 seconds
# (one poll iteration). Without it, the loop would run for ~10 minutes.
START="$(date +%s)"
OUTPUT_FILE="$TMP_DIR/output.txt"
( "$TMP_DIR/wrapper.sh" 2>&1 ) >"$OUTPUT_FILE" &
WRAPPER_PID=$!

for _ in $(seq 1 30); do
  if ! kill -0 "$WRAPPER_PID" 2>/dev/null; then break; fi
  sleep 1
done

if kill -0 "$WRAPPER_PID" 2>/dev/null; then
  kill -9 "$WRAPPER_PID" 2>/dev/null || true
  echo "  [FAIL] wrapper did not exit within 30s — denied case is still in the 10-minute loop"
  exit 1
fi

wait "$WRAPPER_PID" 2>/dev/null
RC=$?
END="$(date +%s)"
ELAPSED=$((END - START))

OUTPUT="$(cat "$OUTPUT_FILE")"
echo "  [info] elapsed=${ELAPSED}s rc=$RC"
echo "  [info] output: $OUTPUT"

if [ "$ELAPSED" -ge 30 ]; then
  echo "  [FAIL] elapsed >= 30s; denied case did not short-circuit"
  exit 1
fi
if ! printf '%s' "$OUTPUT" | grep -qiE 'denied|cancel'; then
  echo "  [FAIL] expected denied/cancelled message in output"
  exit 1
fi
echo "  [ok] denied poll response exits start_browser_auth in ${ELAPSED}s"
