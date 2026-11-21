#!/bin/zsh
# Installs the latest Aced on a Mac:
#
#   curl --proto '=https' --tlsv1.2 -fsSL https://github.com/KorelUyar/aced/releases/latest/download/install.sh | zsh
#
# Aced is not notarised by Apple (that needs a paid developer account).
# Installing it this way skips the "cannot be opened" warning that macOS
# shows for apps downloaded with a browser.
#
# Aced used to be called Spurt. The install line of Spurt leads here too, and this script
# replaces Spurt with Aced: your exams, ticks and books move over when Aced first starts.
#
# For a zip you already have:   ACED_ZIP=/path/to/Aced-macOS.zip zsh install.sh
# Other folder, without opening: ACED_DEST=/some/folder ACED_NO_OPEN=1 zsh install.sh
# (The names SPURT_ZIP, SPURT_ZIP_URL, SPURT_DEST and SPURT_NO_OPEN still work.)

# Everything runs inside a function, so a download of this script that was cut off
# halfway does nothing at all.
install_aced() {
  set -e
  local name="Aced"
  local zip="${ACED_ZIP:-$SPURT_ZIP}"
  local url="${ACED_ZIP_URL:-${SPURT_ZIP_URL:-https://github.com/KorelUyar/aced/releases/latest/download/$name-macOS.zip}}"
  local to="${ACED_DEST:-$SPURT_DEST}"
  local quiet="${ACED_NO_OPEN:-$SPURT_NO_OPEN}"
  local tmp; tmp="$(mktemp -d)"
  # The folder's name is written into the trap now: by the time the trap runs, this
  # function's variables are gone, and the download would stay behind.
  trap "rm -rf ${(q)tmp}" EXIT

  if [ -n "$zip" ]; then
    cp "$zip" "$tmp/$name.zip"
  else
    echo "Downloading $name…"
    curl --proto '=https' --tlsv1.2 -fL --progress-bar "$url" -o "$tmp/$name.zip"
  fi
  ditto -x -k "$tmp/$name.zip" "$tmp"
  if [ ! -d "$tmp/$name.app" ]; then
    echo "The download does not contain $name.app." >&2
    exit 1
  fi

  local dest="${to:-/Applications}"
  [ -n "$to" ] || [ -w "$dest" ] || dest="$HOME/Applications"
  mkdir -p "$dest"

  # Copy next to the old version first; replace it only once the copy is complete.
  rm -rf "$dest/$name.app.new"
  ditto "$tmp/$name.app" "$dest/$name.app.new"
  xattr -dr com.apple.quarantine "$dest/$name.app.new" 2>/dev/null || true

  # A running copy is asked to quit first. Only if there is one: asking for an app that is
  # not installed makes macOS show a dialog.
  if [ -z "$quiet" ] && pgrep -xq "$name"; then
    osascript -e 'tell application id "com.koreluyar.aced" to quit' >/dev/null 2>&1 || true
    for i in {1..20}; do pgrep -xq "$name" || break; sleep 0.5; done
  fi

  rm -rf "$dest/$name.app"
  mv "$dest/$name.app.new" "$dest/$name.app"

  # Spurt, the app's earlier name: so that nobody ends up with two apps, a Spurt.app in the
  # same folder (or in the two Applications folders) is quit and removed. Only if it really
  # is that app: its bundle id is checked first. Its data is not touched: Aced moves it.
  local old
  for old in "$dest/Spurt.app" "/Applications/Spurt.app" "$HOME/Applications/Spurt.app"; do
    [ -n "$to" ] && [ "$old" != "$dest/Spurt.app" ] && continue
    [ -d "$old" ] || continue
    [ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$old/Contents/Info.plist" 2>/dev/null)" = "com.koreluyar.spurt" ] || continue
    if [ -z "$quiet" ] && pgrep -xq "Spurt"; then
      osascript -e 'tell application id "com.koreluyar.spurt" to quit' >/dev/null 2>&1 || true
      for i in {1..20}; do pgrep -xq "Spurt" || break; sleep 0.5; done
    fi
    rm -rf "$old" && echo "Removed $old (Spurt is now called $name; your exams move over when $name starts)."
  done

  if [ -n "$quiet" ]; then
    echo "Installed in $dest."
  else
    echo "Installed in $dest. Opening $name…"
    open "$dest/$name.app"
  fi
}

install_aced
