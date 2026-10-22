#!/usr/bin/env bash
# Installs or updates SerieX (SerieX Books and SerieX Payroll) on a Mac or on Ubuntu Linux.
#
#   Mac:     curl -fsSL https://github.com/CapitalFee/SerieX/releases/latest/download/install.sh | bash
#   Ubuntu:  wget -qO- https://github.com/CapitalFee/SerieX/releases/latest/download/install.sh | bash
#
# Options (add them after "bash -s --" when piping):
#   --uninstall        remove the SerieX app (your company files are kept)
#   --version <tag>    install a specific release, for example v2026.10.3
#
# Environment:
#   SERIEX_INSTALL_DIR  Mac only: folder to install SerieX.app into (default: /Applications when
#                       you can write to it, else ~/Applications)
#   SERIEX_NO_LAUNCH=1  do not open SerieX when the installation is done
#   SERIEX_RELEASE_URL  Ubuntu, for testing: a web folder with the release files to use instead
#                       of GitHub
#
# On a Mac the script never uses sudo. On Ubuntu it installs the SerieX package with apt, and only
# that step runs with sudo, which asks for your password. Your company files are never touched;
# they are kept in ~/Library/Application Support/SerieX (Mac) or ~/.config/SerieX (Ubuntu).

set -euo pipefail

REPO_URL="https://github.com/CapitalFee/SerieX"
APP_NAME="SerieX.app"
# The app reads SERIEX_DATA_DIR too. The same rule as desktop/src/main.js, mcp/seriexmcp/locate.go
# and skills/seriex/scripts/seriex.py.
case "$(uname -s)" in
  Darwin) DATA_DIR="${SERIEX_DATA_DIR:-$HOME/Library/Application Support/SerieX}" ;;
  *) DATA_DIR="${SERIEX_DATA_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/SerieX}" ;;
esac
# Ubuntu: these match deb.packageName and linux.executableName in desktop/scripts/build.mjs.
LINUX_PACKAGE="seriex"
LINUX_APP="/opt/SerieX/seriex"
LINUX_ARCHS="amd64 arm64"
LINUX_FIRST="2026.10.4" # the first release with Ubuntu packages

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

# ---- Ubuntu ----

# Downloads $1 into $2, with a progress bar when $3 is set. wget first: Ubuntu has it, and a curl
# installed as a snap cannot write to /tmp.
fetch() {
  local url="$1" out="$2" progress="${3:-}" opts=(-q --tries=3)
  if command -v wget >/dev/null 2>&1; then
    if [ -n "$progress" ]; then
      case "$(wget --help 2>&1 || true)" in *--show-progress*) opts+=(--show-progress) ;; esac
    fi
    wget "${opts[@]}" -O "$out" "$url"
  elif command -v curl >/dev/null 2>&1; then
    if [ -n "$progress" ]; then
      curl -fL --progress-bar --retry 3 -o "$out" "$url"
    else
      curl -fsSL --retry 3 -o "$out" "$url"
    fi
  else
    fail "wget and curl are both missing. Install wget with: sudo apt install wget"
  fi
}

linux_checks() {
  if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
    say "This is Linux inside Windows (WSL). Install SerieX for Windows instead. In PowerShell, run:"
    say "  irm $REPO_URL/releases/latest/download/install.ps1 | iex"
    exit 1
  fi
  { command -v apt-get && command -v dpkg; } >/dev/null 2>&1 ||
    fail "this Linux has no apt (Ubuntu's app installer). SerieX for Linux is made for Ubuntu 22.04 or later."
  command -v sudo >/dev/null 2>&1 || fail "sudo is missing, so this setup cannot ask for permission to install SerieX."
  command -v pgrep >/dev/null 2>&1 || fail "pgrep is missing. Install it with: sudo apt install procps"
  [ -z "${SERIEX_INSTALL_DIR:-}" ] ||
    fail "SERIEX_INSTALL_DIR works on a Mac only. On Ubuntu, SerieX always goes into /opt/SerieX. Run the command without it."
  # shellcheck disable=SC1091 # /etc/os-release is read on the user's computer
  case "$(. /etc/os-release 2>/dev/null; printf '%s %s' "${ID:-}" "${VERSION_ID:-}")" in
    "ubuntu 2"[2-9].* | "ubuntu "[3-9][0-9].*) ;;
    *) say "Note: SerieX is made for Ubuntu 22.04 or later. It may not work on $(. /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-this Linux}")." ;;
  esac
}

# amd64 or arm64, the name part of SerieX-linux-<name>.deb.
linux_arch() {
  local a
  a="$(dpkg --print-architecture)"
  case " $LINUX_ARCHS " in
    *" $a "*) printf '%s\n' "$a" ;;
    *) fail "SerieX for Linux needs a 64-bit processor (Intel or AMD, or 64-bit ARM); this computer is $a." ;;
  esac
}

linux_status() { dpkg-query -W -f='${Status}' "$LINUX_PACKAGE" 2>/dev/null || true; }

# This user's SerieX main processes. Its helper processes have the same name and a --type= option.
# A helper rewrites its command line as one text with spaces ("/opt/SerieX/seriex --type=zygote"),
# so the option is looked for anywhere in it. A process that is already gone is skipped.
serie_pids_linux() {
  local pid args
  for pid in $(pgrep -u "$(id -u)" -x "${LINUX_APP##*/}" 2>/dev/null || true); do
    args="$(tr '\0' ' ' 2>/dev/null <"/proc/$pid/cmdline")" || continue
    case " $args" in
      *" --type="*) ;;
      *) printf '%s\n' "$pid" ;;
    esac
  done
}

# Asks a running SerieX to quit the normal way (the TERM signal: it asks about unsaved changes and
# stops its servers after their backup), and waits up to 15 seconds. Stops the setup if SerieX is
# still open, or if another user of this computer has it open. Only the main process counts:
# helper processes that a crashed SerieX left behind do not keep the setup from going on.
quit_serie_linux() {
  local exe="${LINUX_APP##*/}" me pid waited=0
  me="$(id -u)"
  # another user's main SerieX process (helpers that a crashed SerieX left behind do not count)
  if ps -C "$exe" -o uid=,args= 2>/dev/null | awk -v me="$me" '$1 != me && $0 !~ / --type=/ { found = 1 } END { exit !found }'; then
    fail "SerieX is open for another user of this computer. Ask them to save their work and quit SerieX, then run this again."
  fi
  [ -n "$(serie_pids_linux)" ] || return 0
  say "SerieX is open. Asking it to quit..."
  for pid in $(serie_pids_linux); do kill -TERM "$pid" 2>/dev/null || true; done
  while [ "$waited" -lt 30 ]; do
    [ -n "$(serie_pids_linux)" ] || return 0
    sleep 0.5
    waited=$((waited + 1))
  done
  fail "SerieX is still open (a window may have unsaved changes). Save your work, quit SerieX, and run this again."
}

# Asks for the password once ($1: install or remove). sudo reads it from the terminal itself; this
# script never sees it.
linux_sudo() {
  sudo -n true 2>/dev/null && return 0
  { : </dev/tty; } 2>/dev/null || fail "run this command in the Terminal app, so that it can ask for your password."
  say "To $1 SerieX, Ubuntu needs your password (the one you use to log in to this computer)."
  say "Type it and press Enter. You may not see anything while you type; that is normal."
  # shellcheck disable=SC2024 # on purpose: sudo itself reads the password from the terminal
  sudo -v </dev/tty ||
    fail "Ubuntu did not allow it. Check the password and run the command again. If your account is not an administrator of this computer, ask the person who manages it."
}

# Runs apt-get as administrator; its messages go to the log file $1.
apt_logged() {
  local log="$1"
  shift
  # shellcheck disable=SC2024 # on purpose: the log file belongs to the user
  sudo env DEBIAN_FRONTEND=noninteractive apt-get -y -q -o DPkg::Lock::Timeout=120 "$@" </dev/null >>"$log" 2>&1
}

install_linux() {
  local tag="$1" arch base asset deb sums log expected actual version
  arch="$(linux_arch)"
  if [ -n "${SERIEX_RELEASE_URL:-}" ]; then
    base="${SERIEX_RELEASE_URL%/}"
  elif [ -n "$tag" ]; then
    base="$REPO_URL/releases/download/$tag"
  else
    base="$REPO_URL/releases/latest/download"
  fi
  asset="SerieX-linux-$arch.deb"

  linux_sudo install # before the download: someone who cannot install learns it at once

  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/seriex-setup.XXXXXX")"
  chmod 755 "$WORK_DIR" # apt reads the package as its own _apt user
  deb="$WORK_DIR/$asset"
  sums="$WORK_DIR/SHA256SUMS"
  log="$WORK_DIR/apt.log"

  say "Downloading SerieX${tag:+ $tag} for Ubuntu..."
  fetch "$base/$asset" "$deb" progress ||
    fail "could not download $base/$asset${tag:+ (releases before SerieX $LINUX_FIRST have no Ubuntu version)}"
  chmod 644 "$deb"
  fetch "$base/SHA256SUMS" "$sums" || fail "could not download $base/SHA256SUMS"

  say "Checking the download..."
  expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print tolower($1); exit }' "$sums")"
  [ -n "$expected" ] || fail "SHA256SUMS does not list $asset."
  actual="$(sha256sum "$deb" | awk '{ print tolower($1) }')"
  [ "$expected" = "$actual" ] || fail "the download is damaged (its SHA-256 checksum does not match). Please try again."

  quit_serie_linux
  linux_sudo install # again: sudo forgets the password after 15 minutes (a slow download)

  say "Installing SerieX. This can take a minute..."
  # --reinstall: running the command again repairs SerieX; --allow-downgrades: --version can go back;
  # --no-remove: stop rather than remove another package to make room for SerieX
  if ! apt_logged "$log" install --no-remove --reinstall --allow-downgrades "$deb"; then
    say "Updating the list of Ubuntu packages and trying again..."
    apt_logged "$log" update || true
    if ! apt_logged "$log" install --no-remove --reinstall --allow-downgrades "$deb"; then
      tail -n 15 "$log" >&2
      fail "Ubuntu could not install SerieX (its messages are above). If Ubuntu is installing updates right now, wait until it is done and run this again."
    fi
  fi

  version="$(dpkg-query -W -f='${Version}' "$LINUX_PACKAGE" 2>/dev/null || echo '')"
  say "SerieX ${version:+$version }is installed. To open it later, press the Super (Windows) key and type SerieX."
  say "Your company files are kept in: $DATA_DIR"

  if [ "${SERIEX_NO_LAUNCH:-}" != 1 ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    say "Opening SerieX..."
    # setsid: SerieX keeps running when this Terminal window is closed
    setsid -f "$LINUX_APP" </dev/null >/dev/null 2>&1 || say "Open SerieX from your apps."
  fi
}

uninstall_linux() {
  local log
  quit_serie_linux
  case "$(linux_status)" in
    "" | *not-installed | *config-files) say "SerieX is not installed." ;;
    *)
      linux_sudo remove
      WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/seriex-setup.XXXXXX")"
      log="$WORK_DIR/apt.log"
      say "Removing SerieX..."
      if ! apt_logged "$log" remove "$LINUX_PACKAGE"; then
        tail -n 15 "$log" >&2
        fail "Ubuntu could not remove SerieX (its messages are above)."
      fi
      say "SerieX was removed."
      ;;
  esac
  say "Your company files were not touched. They are kept in:"
  say "  $DATA_DIR"
  say "Delete that folder only if you no longer need your SerieX company files."
}

main() {
  local mode=install tag="" os
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

  case "$(uname -s)" in
    Darwin) os=mac ;;
    Linux) os=linux ;;
    *)
      say "This installer is for macOS and Ubuntu Linux."
      say "On Windows, run this in PowerShell:"
      say "  irm $REPO_URL/releases/latest/download/install.ps1 | iex"
      exit 1
      ;;
  esac
  if [ "$(id -u)" = 0 ]; then
    if [ "$os" = linux ]; then
      fail "please run this as yourself, without sudo. It asks for your password when it needs it."
    fi
    fail "please run this as yourself, without sudo."
  fi
  [ "$os" = mac ] || linux_checks

  case "$tag" in
    [0-9]*) tag="v$tag" ;; # 2026.10.3 means the release v2026.10.3
  esac

  trap cleanup EXIT
  trap 'exit 130' INT TERM
  if [ "$os" = linux ]; then
    if [ "$mode" = uninstall ]; then
      uninstall_linux
    else
      install_linux "$tag"
    fi
  elif [ "$mode" = uninstall ]; then
    uninstall
  else
    install "$tag"
  fi
}

main "$@"
