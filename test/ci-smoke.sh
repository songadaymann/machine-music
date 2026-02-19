#!/bin/bash
set -euo pipefail

if [[ -z "${PORT:-}" ]]; then
  PORT="$((20000 + (RANDOM % 20000)))"
fi
API_BASE="http://localhost:${PORT}/api"
SERVER_LOG="$(mktemp -t synthmob-server.XXXXXX.log)"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

PORT="$PORT" bun run --env-file /dev/null server/index.ts >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

ready=0
for _ in {1..80}; do
  if curl -fsS "${API_BASE}/composition" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server exited before readiness."
    cat "$SERVER_LOG"
    exit 1
  fi
  sleep 0.25
done

if [[ "$ready" -ne 1 ]]; then
  echo "Server did not become ready in time."
  cat "$SERVER_LOG"
  exit 1
fi

API="$API_BASE" TEST_SUFFIX="ci-$(date +%s)" bash test/curl-test.sh
