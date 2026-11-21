#!/bin/zsh
# Builds the text recognition helper (native/ocr.swift) for Apple Silicon and Intel Macs,
# as one file: build/bin/spurt-ocr. Needs Xcode's command line tools.
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
lipo -create "$tmp/ocr-arm64" "$tmp/ocr-x86_64" -output build/bin/spurt-ocr
codesign --force --sign - build/bin/spurt-ocr
lipo -info build/bin/spurt-ocr
