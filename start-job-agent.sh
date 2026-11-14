#!/usr/bin/env bash
# Job Agent — macOS/Linux launcher.  Run:  ./start-job-agent.sh
# All launchers call the same cross-platform startup: `npm run app`
# (validate config -> migrate DB -> reuse a running dashboard or pick a port ->
# serve -> open browser). Dependency freshness, first-run config seeding and
# the browser check live in scripts/prepareLaunch.mjs so the launchers cannot
# drift apart.
set -euo pipefail
cd -- "$(dirname "$0")"

# 22.13 is the first 22.x where node:sqlite works without a flag.
node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'
}

# The script inherits the Node of the terminal it is run from. A terminal opened
# while nvm's default was an older Node failed here even though 22 was installed,
# so when nvm is present, switch to the version pinned in .nvmrc before giving up.
if ! node_ok; then
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # nvm.sh is not written for `set -eu`: it reads unset variables, and a
    # command failing inside it would end this script silently, before the
    # clear "requires Node 22.13" message below. Relax both while it runs.
    set +eu
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" --no-use >/dev/null 2>&1
    nvm use --silent >/dev/null 2>&1  # no-op if that version is not installed
    set -eu
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node 22.13+ from https://nodejs.org and run this again." >&2
  exit 1
fi

if ! node_ok; then
  echo "Job Agent requires Node.js 22.13 or newer. Found $(node --version)." >&2
  echo "With nvm, run:  nvm install 22 && nvm alias default 22" >&2
  exit 1
fi

# Installs/refreshes node_modules when package-lock.json changed (not merely
# when node_modules is missing), seeds missing personal config from the
# examples, and offers to download the form-filling browser.
node scripts/prepareLaunch.mjs

exec npm run app -- "$@"
