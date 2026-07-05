#!/bin/sh
# Fails if any secret-bearing file is staged (plan/06_iac.md §1). Runs as pre-commit hook.
set -eu

staged=$(git diff --cached --name-only)
bad=""

for f in $staged; do
  base=$(basename "$f")
  case "$base" in
    secrets.txt|.env|.env.*|*.local|local.settings.json)
      bad="$bad  $f\n"
      ;;
  esac
  case "$f" in
    .azure/*)
      bad="$bad  $f\n"
      ;;
  esac
done

if [ -n "$bad" ]; then
  printf 'COMMIT BLOCKED — secret-bearing files staged:\n%b' "$bad" >&2
  printf 'Unstage them (git restore --staged <file>) before committing.\n' >&2
  exit 1
fi
