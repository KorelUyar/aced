#!/bin/zsh
# Builds the text recognition helper (native/ocr.swift) for Apple Silicon and Intel Macs,
# as one file: build/bin/aced-ocr. Needs Xcode's command line tools.
# (A developer build that can also save the page pictures, or use only the fast recogniser:
# add -D DEBUG to the swiftc line.)
# The same source gives the same file, byte for byte. That matters: macOS builds the models of
# its accurate recogniser once for every new version of this file (about a minute, see
# native/ocr.swift), so a rebuild without changes costs nothing.
set -e
cd "$(dirname "$0")/.."
mkdir -p build/bin
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for arch in arm64 x86_64; do
  # No debug information and no source paths in the file that is shipped.
  xcrun swiftc -O -gnone -file-prefix-map "$PWD=." -target "$arch-apple-macos12.0" native/ocr.swift -o "$tmp/ocr-$arch"
  strip -x "$tmp/ocr-$arch"
done
lipo -create "$tmp/ocr-arm64" "$tmp/ocr-x86_64" -output build/bin/aced-ocr
codesign --force --sign - build/bin/aced-ocr
lipo -info build/bin/aced-ocr
