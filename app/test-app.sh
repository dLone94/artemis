#!/usr/bin/env bash
# Drives the app binary's hidden CLI flags.
#
# XCTest needs Xcode, which isn't installed here, so the testable logic is
# exercised through the real binary rather than a unit-test target. These are
# the parts that fail silently in the field: finding node without a shell PATH,
# and correctly telling "Artemis is already running" apart from "something else
# is on that port" and "nothing is there".
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
BIN="$HERE/build/Artemis.app/Contents/MacOS/Artemis"
fails=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fails=$((fails+1)); }

if [ ! -x "$BIN" ]; then
  echo "FAIL ❌  no binary — run: bash app/build.sh"
  exit 1
fi

NODE="$("$BIN" --find-node 2>/dev/null || true)"
free_port() { "$NODE" -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

# 1) finds a node that actually runs
if [ -n "$NODE" ] && "$NODE" -e 'process.exit(0)' 2>/dev/null; then
  ok "finds a working node ($NODE)"
else
  bad "could not find a working node"
  echo "FAIL ❌  cannot continue without node"
  exit 1
fi

# 2) a closed port probes as 'none'
PORT=$(free_port); sleep 0.2
[ "$("$BIN" --probe "http://127.0.0.1:$PORT/api/status")" = "none" ] \
  && ok "closed port probes as none" || bad "closed port should probe as none"

# 3) a real Artemis probes as 'artemis'
DATA=$(mktemp -d)
PORT=$(free_port); sleep 0.2
( cd "$ROOT" && PORT=$PORT ARTEMIS_HOST=127.0.0.1 ARTEMIS_HTTPS= ARTEMIS_ACCESS_TOKEN= \
    STRIPE_SECRET_KEY= ARTEMIS_DATA_DIR="$DATA" "$NODE" server.js >"$DATA/out.log" 2>&1 &
  echo $! > "$DATA/pid" )
for _ in $(seq 1 60); do
  [ "$("$BIN" --probe "http://127.0.0.1:$PORT/api/status")" = "artemis" ] && break
  sleep 0.5
done
[ "$("$BIN" --probe "http://127.0.0.1:$PORT/api/status")" = "artemis" ] \
  && ok "a real Artemis probes as artemis" || bad "real Artemis should probe as artemis"
kill "$(cat "$DATA/pid")" 2>/dev/null

# 4) a non-Artemis HTTP server probes as 'foreign'
PORT=$(free_port); sleep 0.2
"$NODE" -e "require('http').createServer((q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end('{\"hello\":1}')}).listen($PORT,'127.0.0.1')" &
STRANGER=$!
sleep 1
[ "$("$BIN" --probe "http://127.0.0.1:$PORT/api/status")" = "foreign" ] \
  && ok "a stranger on the port probes as foreign" || bad "stranger should probe as foreign"
kill $STRANGER 2>/dev/null

# 5) an authenticated HTTPS Artemis — the real config on this machine — probes
#    as 'artemis'. Without the token this returns 401, and a probe that read
#    that as "nothing there" would try to spawn a second server on a busy port.
PORT=$(free_port); sleep 0.2
TOKEN="test-token-$RANDOM"
( cd "$ROOT" && PORT=$PORT ARTEMIS_HOST=0.0.0.0 ARTEMIS_HTTPS=1 ARTEMIS_ACCESS_TOKEN="$TOKEN" \
    STRIPE_SECRET_KEY= ARTEMIS_DATA_DIR="$DATA" "$NODE" server.js >"$DATA/tls.log" 2>&1 &
  echo $! > "$DATA/tlspid" )
for _ in $(seq 1 60); do
  [ "$("$BIN" --probe "https://127.0.0.1:$PORT/api/status?key=$TOKEN")" = "artemis" ] && break
  sleep 0.5
done
[ "$("$BIN" --probe "https://127.0.0.1:$PORT/api/status?key=$TOKEN")" = "artemis" ] \
  && ok "https + access token probes as artemis (self-signed cert trusted)" \
  || bad "https+token should probe as artemis (see $DATA/tls.log)"
# and without the token it must NOT look like a healthy Artemis
[ "$("$BIN" --probe "https://127.0.0.1:$PORT/api/status")" != "artemis" ] \
  && ok "the same server without a token does not read as ready" \
  || bad "unauthenticated probe should not report artemis"
kill "$(cat "$DATA/tlspid")" 2>/dev/null
rm -rf "$DATA"

[ $fails -eq 0 ] && echo "PASS ✅  app: node discovery, transport, and server probing" \
  || { echo "FAIL ❌  $fails check(s)"; exit 1; }
