#!/bin/sh
# Run: sh scripts/dsh-runtime-smoke/run.sh [--ledger-only|--automatic-only|--slow-infer-only] [--compare-<version> version.tgz]... [path/to/.app]
# No npm install, profile patch, launched GUI, HTTP listener, or real provider.
set -eu
export PATH=/usr/bin:/bin
umask 077
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo=$(CDPATH= cd -- "$here/../.." && pwd -P)
legacy= legacy_host= legacy_routing= legacy_auto= legacy_slow= only=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ledger-only) only=ledger; shift ;;
    --automatic-only) only=automatic; shift ;;
    --slow-infer-only) only=slow-infer; shift ;;
    --repro-0.2.1) only=slow-infer-0.2.1; legacy_slow=${2:?pass the original 0.2.1 tgz}; shift 2 ;;
    --compare-0.2.1) legacy_slow=${2:?pass the original 0.2.1 tgz}; shift 2 ;;
    --compare-0.2.0) legacy_auto=${2:?pass the original 0.2.0 tgz}; shift 2 ;;
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
if [ "$only" != slow-infer-0.2.1 ]; then cp "$repo/lib/client.js" "$root/current.cjs"; fi
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
if [ -n "$legacy_auto" ]; then
  tar -xOzf "$legacy_auto" package/lib/client.js > "$root/legacy-automatic.cjs"
  tar -xOzf "$legacy_auto" package/package.json > "$root/legacy-automatic.json"
fi
if [ -n "$legacy_slow" ]; then
  tar -xOzf "$legacy_slow" package/lib/client.js > "$root/legacy-slow.cjs"
  mkdir "$root/legacy-slow-host"
  for entry in index contract recover-empty; do
    tar -xOzf "$legacy_slow" "package/src/host/$entry.mjs" > "$root/legacy-slow-host/$entry.mjs"
  done
  tar -xOzf "$legacy_slow" package/package.json > "$root/legacy-slow-host/package.json"
fi
if [ -n "$legacy_host" ]; then
  mkdir "$root/old-host"
  for entry in index contract; do
    tar -xOzf "$legacy_host" "package/src/host/$entry.mjs" > "$root/old-host/$entry.mjs"
  done
  tar -xOzf "$legacy_host" package/package.json > "$root/old-host/package.json"
fi
if [ "$only" != slow-infer-0.2.1 ]; then
  cp "$repo/src/host/"*.mjs "$root/host/"
  cp "$repo/src/dsh/"*.mjs "$root/dsh-client/"
fi
# Never inherit the caller's DSH variables, keys, proxies, PATH or Node hooks.
# Isolate even a misbehaving plugin: kernel-denied network (incl. listen), no
# reads under the real user home, no writes outside the disposable root.
phase() (
state=$root
case "$1" in
  slow-infer|slow-infer-0.2.1)
    # Identical empty profiles and opaque workspace basenames for both arms.
    state="$root/$1"; mkdir "$state" "$state/home" "$state/dsh" "$state/work" "$state/tmp" ;;
esac
cd "$state/work"
/usr/bin/env -i HOME="$state/home" DSH_HOME="$state/dsh" TMPDIR="$state/tmp" PATH=/usr/bin:/bin \
  DSH_SMOKE_PHASE="$1" \
  ELECTRON_RUN_AS_NODE=1 DSH_BUNDLE="$app/Contents/Resources/app.asar/dsh" \
  /usr/bin/sandbox-exec -D "REAL_HOME=$HOME" -D "SCRATCH=$root" -p '
    (version 1) (allow default) (deny network*)
    (deny file-read* (subpath (param "REAL_HOME")))
    (deny file-write*) (allow file-write* (subpath (param "SCRATCH")))' \
  "$app/Contents/MacOS/DeepSeek Harness" --expose-internals "$root/probe.mjs"
)
slow_infer() {
  if [ -n "$legacy_slow" ]; then phase slow-infer-0.2.1; fi
  phase slow-infer
}
# For a genuine cold restore, only disk survives between two Electron PIDs.
if [ -z "$only" ]; then
  if [ -n "$legacy_host" ]; then phase old-host-seed; fi
  phase current
  # Independent deployment: host inherits PTC, can explicitly create standard.
  phase routing
  phase routing-cold
  phase ledger
  phase automatic
  slow_infer
elif [ "$only" = slow-infer ]; then
  slow_infer
else
  phase "$only"
fi
