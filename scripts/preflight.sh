#!/bin/bash
# Gate before anything becomes public (push to this public repository). Run in a trusted environment only.
# Copied from mouse9527/skills (scripts/preflight.sh); keep the two in step.
#   scripts/preflight.sh [BASE]        BASE defaults to origin/main (what is already public)
# 1. working tree clean (what is checked = what is committed)  2. scripts/validate.py (public rules, as in CI)
# 3. scripts/pii_scan.py: final tree + every commit in BASE..HEAD with the generic rules and the PRIVATE term list
#    ($PII_TERMS, else $SKILLS_PII_TERMS, default ~/.config/assistant-config/pii-terms.txt; 0600; outside every
#    repository). Missing / too open / empty term list = failure. Nothing here prints a matched text or a term.
# Image build / smoke tests are left to CI (.github/workflows/image.yml).
# On success records HEAD in .git/preflight-ok; the pre-push hook (scripts/hooks/pre-push) refuses anything else.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
PY=${PYTHON:-python3}
BASE=${1:-origin/main}
TERMS=${PII_TERMS:-${SKILLS_PII_TERMS:-$HOME/.config/assistant-config/pii-terms.txt}}

git fetch -q origin
if [ -n "$(git status --porcelain)" ]; then
  echo "preflight: working tree not clean (commit first)" >&2; exit 1
fi
"$PY" -I scripts/validate.py
"$PY" -I scripts/pii_scan.py --terms "$TERMS" --range "$BASE..HEAD"
git rev-parse HEAD > "$(git rev-parse --git-dir)/preflight-ok"
echo "preflight ok: $(git rev-parse HEAD)"
