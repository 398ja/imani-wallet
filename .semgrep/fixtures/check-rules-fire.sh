#!/usr/bin/env bash
# Every rule in .semgrep/ must still match its known-vulnerable shape.
#
# `semgrep --validate` proves the rules PARSE. It does not prove they still MATCH: a pattern
# broken by a Semgrep upgrade, a metavariable typo, or an over-eager path exclusion produces a
# ruleset that reports clean forever and looks exactly like a healthy one. This is the check
# that tells those two apart.
#
# The fixtures are .txt so no build tool ever compiles them.
set -euo pipefail

FIXTURES="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for f in "$FIXTURES"/*.java.txt;  do [ -e "$f" ] && cp "$f" "$WORK/$(basename "${f%.txt}")"; done
for f in "$FIXTURES"/*.yml.txt;   do [ -e "$f" ] && cp "$f" "$WORK/$(basename "${f%.txt}")"; done
for f in "$FIXTURES"/*.ts.txt;    do [ -e "$f" ] && cp "$f" "$WORK/$(basename "${f%.txt}")"; done

declared=$(grep -hoE '^\s+- id: \S+' .semgrep/*.yml | awk '{print $3}' | sort -u)
fired=$(semgrep --config .semgrep/ "$WORK" --quiet --json 2>/dev/null \
        | python3 -c 'import json,sys; print("\n".join(sorted({r["check_id"].split(".")[-1] for r in json.load(sys.stdin)["results"]})))')

silent=$(comm -23 <(echo "$declared") <(echo "$fired"))
if [ -n "$silent" ]; then
  echo "FAIL: these rules matched nothing in the fixtures, so they are no longer protecting anything:"
  echo "$silent" | sed 's/^/  - /'
  echo
  echo "Either the rule broke, or its fixture was removed. Both need fixing, not silencing."
  exit 1
fi
echo "OK: all $(echo "$declared" | wc -l | tr -d ' ') rules still fire on their vulnerable fixtures."
