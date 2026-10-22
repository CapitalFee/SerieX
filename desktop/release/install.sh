#!/usr/bin/env bash
# Installs or updates SerieX (SerieX Books and SerieX Payroll) on a Mac.
#
#   curl -fsSL https://github.com/CapitalFee/SerieX/releases/latest/download/install.sh | bash
#
# Options (add them after "bash -s --" when piping):
#   --uninstall        remove the SerieX app (your company files are kept)
#   --version <tag>    install a specific release, for example v2026.10.3
#
# Environment:
#   SERIEX_INSTALL_DIR  folder to install SerieX.app into (default: /Applications when you can
#                       write to it, else ~/Applications)
#   SERIEX_NO_LAUNCH=1  do not open SerieX when the installation is done
#
# The script never uses sudo and never touches your company files, which are kept in
# ~/Library/Application Support/SerieX.

set -euo pipefail

REPO_URL="https://github.com/CapitalFee/SerieX"
APP_NAME="SerieX.app"
DATA_DIR="${SERIEX_DATA_DIR:-$HOME/Library/Application Support/SerieX}" # the app reads SERIEX_DATA_DIR too

WORK_DIR=""
STAGING_DIR=""

say() { printf '%s\n' "$*"; }

# Removes the "downloaded from the internet" mark from the app, its files and its symlinks (-s).
# Uses the system xattr: another one (for example from Python) may come first in PATH and lacks -r.
remove_quarantine() {
  /usr/bin/xattr -drs com.apple.quarantine "$1" >/dev/null 2>&1 || true
}
fail() {
  printf 'SerieX setup stopped: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi
  if [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then rm -rf "$STAGING_DIR"; fi
}

usage() {
  say "Usage: install.sh [--uninstall] [--version <tag>]"
  say "  --uninstall        remove the SerieX app (your company files are kept)"
  say "  --version <tag>    install a specific release, for example v2026.10.3"
}

# True when a SerieX app (from any folder) is running.
serie_running() {
  pgrep -x SerieX >/dev/null 2>&1
}

# Asks a running SerieX to quit the normal way (it saves its settings and stops its servers),
# and waits up to 15 seconds. Stops the setup if SerieX is still open, for example because a
# window has unsaved changes.
quit_serie() {
  serie_running || return 0
  say "SerieX is open. Asking it to quit..."
  if ! osascript -e 'if application "SerieX" is running then tell application "SerieX" to quit' </dev/null >/dev/null 2>&1; then
    # Without permission to send it a quit command, the TERM signal asks it to quit the same way.
    pkill -TERM -x SerieX >/dev/null 2>&1 || true
  fi
  local waited=0
  while [ "$waited" -lt 30 ]; do
    serie_running || return 0
    sleep 0.5
    waited=$((waited + 1))
  done
  fail "SerieX is still open (a window may have unsaved changes). Save your work, quit SerieX, and run this again."
}

# Folder SerieX.app goes into.
install_dir() {
  if [ -n "${SERIEX_INSTALL_DIR:-}" ]; then
    printf '%s\n' "${SERIEX_INSTALL_DIR%/}"
  elif [ -w /Applications ]; then
    printf '%s\n' /Applications
  else
    printf '%s\n' "$HOME/Applications"
  fi
}

uninstall() {
  quit_serie
  local dirs=() d removed=0
  if [ -n "${SERIEX_INSTALL_DIR:-}" ]; then
    dirs=("${SERIEX_INSTALL_DIR%/}")
  else
    dirs=(/Applications "$HOME/Applications")
  fi
  for d in "${dirs[@]}"; do
    [ -d "$d/$APP_NAME" ] || continue
    if [ -w "$d" ] && [ -w "$d/$APP_NAME" ] && rm -rf "${d:?}/$APP_NAME" 2>/dev/null && [ ! -e "$d/$APP_NAME" ]; then
      say "Removed $d/$APP_NAME"
      removed=1
    else
      say "Could not remove $d/$APP_NAME (it belongs to another user). Drag it to the Trash in Finder."
    fi
  done
  [ "$removed" = 1 ] || say "SerieX is not installed in ${dirs[*]}."
  say "Your company files were not touched. They are kept in:"
  say "  $DATA_DIR"
  say "Delete that folder only if you no longer need your SerieX company files."
}

install() {
  local tag="$1" arch base asset dest zip sums expected actual app old

  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) fail "this Mac has an unknown processor ($(uname -m))." ;;
  esac
  if [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64 # the terminal runs under Rosetta on an Apple silicon Mac
  fi

  if [ -n "$tag" ]; then
    base="$REPO_URL/releases/download/$tag"
  else
    base="$REPO_URL/releases/latest/download"
  fi
  asset="SerieX-mac-$arch.zip"
  dest="$(install_dir)"

  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/seriex-setup.XXXXXX")"
  zip="$WORK_DIR/$asset"
  sums="$WORK_DIR/SHA256SUMS"

  say "Downloading SerieX${tag:+ $tag} for $([ "$arch" = arm64 ] && echo 'Apple silicon' || echo 'Intel') Macs..."
  curl -fL --progress-bar --retry 3 -o "$zip" "$base/$asset" || fail "could not download $base/$asset"
  curl -fsSL --retry 3 -o "$sums" "$base/SHA256SUMS" || fail "could not download $base/SHA256SUMS"

  say "Checking the download..."
  expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print tolower($1); exit }' "$sums")"
  [ -n "$expected" ] || fail "SHA256SUMS does not list $asset."
  actual="$(shasum -a 256 "$zip" | awk '{ print tolower($1) }')"
  [ "$expected" = "$actual" ] || fail "the download is damaged (its SHA-256 checksum does not match). Please try again."

  quit_serie

  mkdir -p "$dest" || fail "could not create the folder $dest"
  [ -w "$dest" ] || fail "you cannot write to $dest. Set SERIEX_INSTALL_DIR to a folder you own."

  # Unpack next to the final place, so putting the new app in place is a quick rename.
  STAGING_DIR="$(mktemp -d "$dest/.seriex-install.XXXXXX")"
  ditto -x -k "$zip" "$STAGING_DIR" || fail "could not unpack $asset"
  [ -x "$STAGING_DIR/$APP_NAME/Contents/MacOS/SerieX" ] || fail "$asset does not contain $APP_NAME"
  remove_quarantine "$STAGING_DIR/$APP_NAME"

  app="$dest/$APP_NAME"
  if [ -e "$app" ]; then
    old="$STAGING_DIR/old-$APP_NAME"
    mv "$app" "$old" || fail "could not replace the SerieX in $dest (it may belong to another user). Drag it to the Trash and run this again."
    if ! mv "$STAGING_DIR/$APP_NAME" "$app"; then
      if mv "$old" "$app"; then
        fail "could not put the new SerieX in $dest; the older one was kept."
      fi
      STAGING_DIR="" # keep the older copy: it is still in the folder named below
      fail "could not put the new SerieX in $dest. The older one is in $old"
    fi
    say "Replaced the older SerieX in $dest"
  else
    mv "$STAGING_DIR/$APP_NAME" "$app" || fail "could not put SerieX in $dest"
  fi
  remove_quarantine "$app"

  local version
  version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || echo '')"
  say "SerieX ${version:+$version }is installed in $app"
  if [ -z "${SERIEX_INSTALL_DIR:-}" ] && [ "$dest" != /Applications ] && [ -d "/Applications/$APP_NAME" ]; then
    say "Note: an older SerieX is still in /Applications. You can drag it to the Trash."
  fi
  say "Your company files are kept in: $DATA_DIR"

  if [ "${SERIEX_NO_LAUNCH:-}" != 1 ]; then
    say "Opening SerieX..."
    open "$app" || say "Open SerieX from $dest."
  fi
}

main() {
  local mode=install tag=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --uninstall) mode=uninstall ;;
      --version)
        [ $# -ge 2 ] && [ -n "$2" ] || fail "--version needs a release tag, for example v2026.10.3"
        tag="$2"
        shift
        ;;
      --version=*) tag="${1#--version=}" ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        usage >&2
        fail "unknown option $1"
        ;;
    esac
    shift
  done

  if [ "$(uname -s)" != Darwin ]; then
    say "This installer is for macOS. SerieX is available for macOS and Windows."
    say "On Windows, run this in PowerShell:"
    say "  irm $REPO_URL/releases/latest/download/install.ps1 | iex"
    exit 1
  fi
  if [ "$(id -u)" = 0 ]; then
    fail "please run this as yourself, without sudo."
  fi

  case "$tag" in
    [0-9]*) tag="v$tag" ;; # 2026.10.3 means the release v2026.10.3
  esac

  trap cleanup EXIT
  trap 'exit 130' INT TERM
  if [ "$mode" = uninstall ]; then
    uninstall
  else
    install "$tag"
  fi
}

main "$@"
