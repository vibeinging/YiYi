#!/usr/bin/env bash
# Convenience wrapper for the eval runner.
#
# Usage:
#   ./evals/runner/run.sh            # all fixture-mode cases (via cargo test)
#   ./evals/runner/run.sh --live     # live mode — not implemented yet
#   ./evals/runner/run.sh <slug>     # single case by id slug
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ "${1-}" = "--live" ]; then
  echo "live mode not implemented yet — see evals/runner/README.md" >&2
  exit 2
fi

pushd app/src-tauri > /dev/null
if [ -n "${1-}" ]; then
  cargo test --features test-support --test evals_runner -- "$1"
else
  cargo test --features test-support --test evals_runner
fi
popd > /dev/null
