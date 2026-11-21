#!/bin/zsh
# A stand-in for the `claude` command in tests, so that "not signed in" and "sign-in expired"
# can be played through without touching a real Claude Code login. It answers the three things
# Spurt asks of Claude Code the way the real one does (texts and exit codes taken from it):
#
#   auth status --json     auth login     -p … (a request, read from standard input)
#
# The state is one word in the file named by SPURT_STUB_STATE:
#   signedOut   no login                      expired   a login whose end date has passed
#   stale       a login that looks fine but is refused when used
#   ok          signed in
state_file="${SPURT_STUB_STATE:?SPURT_STUB_STATE is not set}"
state="$(cat "$state_file" 2>/dev/null || echo signedOut)"

if [ "$1" = auth ] && [ "$2" = status ]; then
  case "$state" in
    ok) echo '{"loggedIn":true,"authMethod":"claude.ai","loginExpiresAt":"2099-01-01T00:00:00.000Z"}'; exit 0 ;;
    stale) echo '{"loggedIn":true,"authMethod":"claude.ai","loginExpiresAt":"2098-01-01T00:00:00.000Z"}'; exit 0 ;;
    expired) echo '{"loggedIn":true,"authMethod":"claude.ai","loginExpiresAt":"2020-01-01T00:00:00.000Z"}'; exit 0 ;;
    *) echo '{"loggedIn":false,"authMethod":"none","loginExpiresAt":null}'; exit 1 ;;
  esac
fi

if [ "$1" = auth ] && [ "$2" = login ]; then
  sleep 1
  echo ok > "$state_file"
  echo "Login successful."
  exit 0
fi

cat > /dev/null
case "$state" in
  ok) echo '{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":{"ok":true},"usage":{"input_tokens":12,"output_tokens":5}}'; exit 0 ;;
  expired | stale) echo '{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed"}'; exit 1 ;;
  *) echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}'; exit 1 ;;
esac
