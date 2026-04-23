#!/usr/bin/env bash
# Convenience wrapper for the eval runner.
#
# Fixture mode (deterministic, no network):
#   ./evals/runner/run.sh                   # all cases
#   ./evals/runner/run.sh 002-no-double     # single case by id substring
#
# Live mode (real LLM):
#   export DASHSCOPE_API_KEY=sk-...         # required
#   ./evals/runner/run.sh --live            # all cases, real LLM
#   ./evals/runner/run.sh --live 002        # one case by id substring
#   YIYI_EVAL_MODEL=qwen-plus ./evals/runner/run.sh --live  # override model
set -euo pipefail

cd "$(dirname "$0")/../.."
pushd app/src-tauri > /dev/null

if [ "${1-}" = "--live" ]; then
  shift
  if [ -z "${DASHSCOPE_API_KEY:-}${YIYI_EVAL_API_KEY:-}" ]; then
    echo "ERROR: live mode requires DASHSCOPE_API_KEY (or YIYI_EVAL_API_KEY) in env." >&2
    echo "  export DASHSCOPE_API_KEY=sk-..." >&2
    echo "  ./evals/runner/run.sh --live [case_slug]" >&2
    popd > /dev/null
    exit 2
  fi
  export YIYI_EVAL_LIVE=1
  : "${YIYI_EVAL_MODEL:=qwen-max}"
  export YIYI_EVAL_MODEL
  if [ -n "${1-}" ]; then
    export YIYI_EVAL_ONLY="$1"
  fi
  cargo test --features test-support --test evals_runner live_cases -- --nocapture
elif [ -n "${1-}" ]; then
  cargo test --features test-support --test evals_runner -- "$1"
else
  cargo test --features test-support --test evals_runner
fi

popd > /dev/null
