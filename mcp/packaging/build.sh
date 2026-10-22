#!/usr/bin/env bash
# Builds the SerieX extension for Claude Desktop and the MCP Registry entry.
#
# Usage: mcp/packaging/build.sh <version> [outdir]
#   version  the release version without "v", for example 2026.10.3
#   outdir   where the files are written (default: mcp/dist)
#
# Writes seriex-<version>-darwin-universal.mcpb (one program for Apple silicon
# and Intel Macs), seriex-<version>-windows-amd64.mcpb and server.json (for
# mcp-publisher), and prints the size and SHA-256 of each .mcpb file. Needs Go,
# zip and lipo (macOS), so run it on a Mac.
#
# Release order: build from the clean release commit, upload both .mcpb files
# to the GitHub release v<version> (for example:
#   gh release upload v<version> <outdir>/seriex-<version>-*.mcpb --repo CapitalFee/SerieX
# ), and only then publish server.json with mcp-publisher: the registry checks
# that the download addresses work.
set -euo pipefail

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: $0 <version> [outdir]" >&2
  exit 2
fi
version=$1
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "The version must look like 2026.10.3 (no leading v), not \"$version\"." >&2
  exit 2
fi

packaging=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mcp=$(dirname "$packaging")
outdir=${2:-$mcp/dist}
for tool in go zip lipo; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is needed to build the packages." >&2
    exit 1
  fi
done
mkdir -p "$outdir"
outdir=$(cd "$outdir" && pwd)

work=$(mktemp -d "${TMPDIR:-/tmp}/seriex-mcpb.XXXXXX")
trap 'rm -rf "$work"' EXIT

# Same time, owner and permissions in every build, and no git details in the
# programs (-buildvcs=false), so the same sources and Go version give the same
# files and SHA-256 values.
export TZ=UTC
stamp=202001010000.00

cd "$mcp"
build() { # build <goos> <goarch> <output>
  echo "Building seriex-mcp $version for $1-$2"
  CGO_ENABLED=0 GOOS=$1 GOARCH=$2 go build -trimpath -buildvcs=false \
    -ldflags "-s -w -X main.version=$version" -o "$3" ./cmd/seriex-mcp
}

packages=()
for target in darwin/universal windows/amd64; do
  goos=${target%/*}
  arch=${target#*/}
  if [ "$goos" = windows ]; then
    binary=seriex-mcp.exe
    platform=win32
  else
    binary=seriex-mcp
    platform=darwin
  fi
  stage=$work/$goos-$arch
  mkdir -p "$stage/server"

  if [ "$arch" = universal ]; then
    # one program that runs on Apple silicon and on Intel Macs, so a Mac can
    # never install a package it cannot run
    build darwin arm64 "$work/seriex-mcp-arm64"
    build darwin amd64 "$work/seriex-mcp-amd64"
    lipo -create -output "$stage/server/$binary" "$work/seriex-mcp-arm64" "$work/seriex-mcp-amd64"
  else
    build "$goos" "$arch" "$stage/server/$binary"
  fi
  go run ./packaging/gen.go manifest -version "$version" -platform "$platform" \
    -binary "$binary" -out "$stage/manifest.json"
  cp "$packaging/icon.png" "$stage/icon.png"

  chmod 755 "$stage/server" "$stage/server/$binary"
  chmod 644 "$stage/manifest.json" "$stage/icon.png"
  touch -t "$stamp" "$stage/manifest.json" "$stage/icon.png" "$stage/server" "$stage/server/$binary"

  file=$outdir/seriex-$version-$goos-$arch.mcpb
  rm -f "$file"
  (cd "$stage" && zip -q -X -9 "$file" manifest.json icon.png "server/$binary")
  packages+=("$file")
done

echo
echo "SHA-256 of the packages:"
go run ./packaging/gen.go server-json -version "$version" -out "$outdir/server.json" "${packages[@]}"
echo
echo "Written to $outdir:"
ls -l "$outdir"
