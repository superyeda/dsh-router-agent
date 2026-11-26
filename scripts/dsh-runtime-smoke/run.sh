#!/bin/sh
# Run: sh scripts/dsh-runtime-smoke/run.sh [--compare-0.1.{0,1,2} version.tgz]... [path/to/.app]
# No npm install, profile patch, launched GUI, HTTP listener, or real provider.
set -eu
export PATH=/usr/bin:/bin
umask 077
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo=$(CDPATH= cd -- "$here/../.." && pwd -P)
legacy= legacy_host= legacy_routing=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --compare-0.1.0) legacy=${2:?pass the original 0.1.0 tgz}; shift 2 ;;
    --compare-0.1.1) legacy_host=${2:?pass the original 0.1.1 tgz}; shift 2 ;;
    --compare-0.1.2) legacy_routing=${2:?pass the original 0.1.2 tgz}; shift 2 ;;
    *) break ;;
  esac
done
app=${1:-/Applications/DeepSeek Harness.app}
app=$(CDPATH= cd -- "$app" && pwd -P)
[ -x /usr/bin/sandbox-exec ] || { echo 'macOS sandbox-exec is required (no unsandboxed fallback)' >&2; exit 1; }
root=$(/usr/bin/mktemp -d /private/tmp/dsh-router-smoke.XXXXXXXX)
# The only recursive cleanup is the verified directory made by this invocation.
case "$root" in /private/tmp/dsh-router-smoke.????????) ;; *) exit 1 ;; esac
trap 'rm -rf -- "${root:?}"' EXIT
trap 'exit 1' HUP INT TERM
mkdir "$root/home" "$root/dsh" "$root/work" "$root/tmp" "$root/host" "$root/dsh-client"
cp "$here/"*.mjs "$root/"
cp "$repo/lib/client.js" "$root/current.cjs"
# Optional archived controls: only fixed, explicitly named entries. Never
# install an old package or extract archive-supplied paths into a user profile.
if [ -n "$legacy" ]; then
  tar -xOzf "$legacy" package/lib/client.js > "$root/legacy.cjs"
  tar -xOzf "$legacy" package/package.json > "$root/legacy.json"
fi
if [ -n "$legacy_routing" ]; then
  tar -xOzf "$legacy_routing" package/lib/client.js > "$root/legacy-routing.cjs"
  tar -xOzf "$legacy_routing" package/package.json > "$root/legacy-routing.json"
fi
if [ -n "$legacy_host" ]; then
  mkdir "$root/old-host"
  for entry in index contract; do
    tar -xOzf "$legacy_host" "package/src/host/$entry.mjs" > "$root/old-host/$entry.mjs"
  done
  tar -xOzf "$legacy_host" package/package.json > "$root/old-host/package.json"
fi
cp "$repo/src/host/"*.mjs "$root/host/"
cp "$repo/src/dsh/"*.mjs "$root/dsh-client/"
cd "$root/work"
# Never inherit the caller's DSH variables, keys, proxies, PATH or Node hooks.
# Isolate even a misbehaving plugin: kernel-denied network (incl. listen), no
# reads under the real user home, no writes outside the disposable root.
phase() {
/usr/bin/env -i HOME="$root/home" DSH_HOME="$root/dsh" TMPDIR="$root/tmp" PATH=/usr/bin:/bin \
  DSH_SMOKE_PHASE="$1" \
  ELECTRON_RUN_AS_NODE=1 DSH_BUNDLE="$app/Contents/Resources/app.asar/dsh" \
  /usr/bin/sandbox-exec -D "REAL_HOME=$HOME" -D "SCRATCH=$root" -p '
    (version 1) (allow default) (deny network*)
    (deny file-read* (subpath (param "REAL_HOME")))
    (deny file-write*) (allow file-write* (subpath (param "SCRATCH")))' \
  "$app/Contents/MacOS/DeepSeek Harness" --expose-internals "$root/probe.mjs"
}
# For a genuine cold restore, only disk survives between two Electron PIDs.
if [ -n "$legacy_host" ]; then phase old-host-seed; fi
phase current
# Independent deployment: host inherits PTC, can explicitly create standard.
phase routing
phase routing-cold
