#!/bin/zsh
# Installs Spurt on a Mac. Once Spurt is published:
#
#   curl --proto '=https' --tlsv1.2 -fsSL https://github.com/KorelUyar/spurt/releases/latest/download/install.sh | zsh
#
# Spurt is not notarised by Apple (that needs a paid developer account).
# Installing it this way skips the "cannot be opened" warning that macOS
# shows for apps downloaded with a browser.
#
# For a zip you already have:   SPURT_ZIP=/path/to/Spurt-macOS.zip zsh install.sh
# Other folder, without opening: SPURT_DEST=/some/folder SPURT_NO_OPEN=1 zsh install.sh

# Everything runs inside a function, so a download of this script that was cut off
# halfway does nothing at all.
install_spurt() {
  set -e
  local name="Spurt"
  local url="${SPURT_ZIP_URL:-https://github.com/KorelUyar/spurt/releases/latest/download/$name-macOS.zip}"
  local tmp; tmp="$(mktemp -d)"
  # The folder's name is written into the trap now: by the time the trap runs, this
  # function's variables are gone, and the download would stay behind.
  trap "rm -rf ${(q)tmp}" EXIT

  if [ -n "$SPURT_ZIP" ]; then
    cp "$SPURT_ZIP" "$tmp/$name.zip"
  else
    echo "Downloading $name…"
    curl --proto '=https' --tlsv1.2 -fL --progress-bar "$url" -o "$tmp/$name.zip"
  fi
  ditto -x -k "$tmp/$name.zip" "$tmp"
  if [ ! -d "$tmp/$name.app" ]; then
    echo "The download does not contain $name.app." >&2
    exit 1
  fi

  local dest="${SPURT_DEST:-/Applications}"
  [ -n "$SPURT_DEST" ] || [ -w "$dest" ] || dest="$HOME/Applications"
  mkdir -p "$dest"

  # Copy next to the old version first; replace it only once the copy is complete.
  rm -rf "$dest/$name.app.new"
  ditto "$tmp/$name.app" "$dest/$name.app.new"
  xattr -dr com.apple.quarantine "$dest/$name.app.new" 2>/dev/null || true

  # A running copy is asked to quit first. Only if there is one: asking for an app that is
  # not installed makes macOS show a dialog.
  if [ -z "$SPURT_NO_OPEN" ] && pgrep -xq "$name"; then
    osascript -e 'tell application id "com.koreluyar.spurt" to quit' >/dev/null 2>&1 || true
    for i in {1..20}; do pgrep -xq "$name" || break; sleep 0.5; done
  fi

  rm -rf "$dest/$name.app"
  mv "$dest/$name.app.new" "$dest/$name.app"

  if [ -n "$SPURT_NO_OPEN" ]; then
    echo "Installed in $dest."
  else
    echo "Installed in $dest. Opening $name…"
    open "$dest/$name.app"
  fi
}

install_spurt
