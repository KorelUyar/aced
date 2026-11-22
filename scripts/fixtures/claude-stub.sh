#!/bin/zsh
# A stand-in for the `claude` command in tests, so that every state a person can be in with
# Claude Code can be played through without touching a real login or sending anything. It
# answers the three things Aced asks of Claude Code the way the real one does (texts and exit
# codes taken from it), pictures of pages included:
#
#   auth status --json     auth login     -p … (a request, read from standard input)
#
# The state is one word in the file named by ACED_STUB_STATE:
#   signedOut   no login                      expired   a login whose end date has passed
#   stale       a login that looks fine but is refused when used
#   ok          signed in: a request is answered with the prepared answer for its task (stub/*.json)
#   slow        like ok, after half a minute (to look at a run under way, cancel it, quit during it)
#   usagelimit, offline, overloaded, badmodel, empty   signed in, and every request fails that way
state_file="${ACED_STUB_STATE:?ACED_STUB_STATE is not set}"
state="$(cat "$state_file" 2>/dev/null || echo signedOut)"
here="${0:A:h}/stub"

if [ "$1" = auth ] && [ "$2" = status ]; then
  case "$state" in
    stale) echo '{"loggedIn":true,"authMethod":"claude.ai","loginExpiresAt":"2098-01-01T00:00:00.000Z"}'; exit 0 ;;
    expired) echo '{"loggedIn":true,"authMethod":"claude.ai","loginExpiresAt":"2020-01-01T00:00:00.000Z"}'; exit 0 ;;
    signedOut) echo '{"loggedIn":false,"authMethod":"none","loginExpiresAt":null}'; exit 1 ;;
    *) echo '{"loggedIn":true,"authMethod":"claude.ai","loginExpiresAt":"2099-01-01T00:00:00.000Z"}'; exit 0 ;;
  esac
fi

if [ "$1" = auth ] && [ "$2" = login ]; then
  sleep 1
  echo ok > "$state_file"
  echo "Login successful."
  exit 0
fi

input="$(cat)"
fail() { printf '{"type":"result","subtype":"success","is_error":true,"result":%s}\n' "$1"; exit 1; }
case "$state" in
  expired | stale) fail '"Failed to authenticate: OAuth session expired and could not be refreshed"' ;;
  signedOut) fail '"Not logged in · Please run /login"' ;;
  usagelimit) fail '"Claude usage limit reached. Your limit will reset at 7pm (Europe/Zurich)."' ;;
  offline) fail '"API Error: Connection error."' ;;
  overloaded) fail '"API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"' ;;
  badmodel) fail '"There'"'"'s an issue with the selected model (claude-opus-5-5). It may not exist or you may not have access to it. Run /model to pick a different model."' ;;
esac
[ "$state" = slow ] && sleep 30

answer='{"ok":true}'
if [ "$state" = empty ]; then answer='{"approach":"","objectives":[],"topics":[]}'
else
  for task in "the study strategy:strategy" "the formula sheet:formulas" "the final exam:questions" "questions on one topic:questions" "mark results:marks" "answer the student:help"; do
    if [[ "$input" == *"Task: ${task%%:*}"* ]]; then answer="$(cat "$here/${task##*:}.json")"; break; fi
  done
  # A picture of a page, sent the way Aced sends pictures (--input-format stream-json): what is on it.
  if [[ "$input" == *"This is page "* && "$*" == *"--input-format stream-json"* ]]; then answer="$(cat "$here/see.json")"; fi
fi
printf '{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":%s,"usage":{"input_tokens":1200,"output_tokens":300}}\n' "$answer"
