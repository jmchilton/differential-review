#!/bin/sh
# Regenerates view-fixtures/: implementation; rebase + amend + new commit (hardening); pure rebase (polishing).
# Needs `make diff-review-build`; macOS (BSD `sed -i ''`). Usage: make-view-fixtures.sh [scratch dir]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cli="$here/../../../bin/differential-review"
scratch=${1:-$(mktemp -d)}
repo="$scratch/repo"
record="$scratch/vault/repositories/demo/branches/active/feature"
rm -rf "$repo" "$scratch/vault"
mkdir -p "$repo" "$record"
printf -- '---\nupstream_base_branch: main\n---\n# feature\n' > "$record/index.md"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.org \
  GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.org GIT_EDITOR=true
at() { export GIT_AUTHOR_DATE="2026-10-26T00:0$1:00Z" GIT_COMMITTER_DATE="2026-10-26T00:0$1:00Z"; }
cd "$repo"
git init -q -b main
git config commit.gpgsign false

at 0
seq 1 40 | sed 's/^/line /' > app.py
printf 'def helper():\n    return 1\n' > util.py
printf '# Demo\n\nUsage: run it.\n' > README.md
printf 'name: demo\nlevel: 1\n' > config.yml
git add -A && git commit -qm "Base"

git checkout -qb feature
at 1
sed -i '' -e 's/^line 5$/line 5 greeting = "hi"/' -e 's/^line 30$/line 30 print(greeting)/' app.py
printf 'def helper():\n    return 1\n\n\ndef greet(name):\n    """Return a friendly greeting."""\n    prefix = "hi"\n    punctuation = "!"\n    return f"{prefix} {name}{punctuation}"\n' > util.py
git commit -qam "Add greeting helper"
at 2
printf '# Demo\n\nUsage: run it with a name.\n' > README.md
git commit -qam "Document greeting usage"
at 3
git mv config.yml settings.yml
git commit -qm "Rename config to settings"

"$cli" snapshot --phase implementation --record "$record" >/dev/null
sleep 1

# Upstream moves (shifts app.py), feature rebases, the greeting commit is amended, and hardening adds a commit.
git checkout -q main
at 4
{ printf 'import sys\nimport os\n'; cat app.py; } > app.tmp && mv app.tmp app.py
git commit -qam "Upstream: imports"
git checkout -q feature
at 5
git rebase -q main
first=$(git rev-list --reverse main..feature | head -1)
git checkout -q -b rewrite main
git cherry-pick "$first" >/dev/null
sed -i '' 's/^line 30 print(greeting)$/line 30 print(greeting.upper())/' app.py
git commit -q --amend -a --no-edit
git cherry-pick $(git rev-list --reverse main..feature | sed -n 2,3p) >/dev/null
git branch -qf feature rewrite
git checkout -q feature
git branch -qD rewrite
at 6
printf 'def helper():\n    return 1\n\n\ndef greet(name):\n    """Return a friendly greeting."""\n    if not name:\n        raise ValueError("name required")\n    prefix = "hi"\n    punctuation = "!"\n    return f"{prefix} {name}{punctuation}"\n' > util.py
git commit -qam "Validate greeting name"

"$cli" snapshot --phase hardening --record "$record" >/dev/null
sleep 1

# A pure rebase onto a shifted upstream: nothing for the reviewer to re-look at.
git checkout -q main
at 7
{ printf '#!/usr/bin/env python\n'; cat app.py; } > app.tmp && mv app.tmp app.py
git commit -qam "Upstream: shebang"
git checkout -q feature
at 8
git rebase -q main
"$cli" snapshot --phase polishing --record "$record" >/dev/null

out="$here/view-fixtures"
rm -rf "$out"
mkdir -p "$out"
cp "$record"/differential-review/snapshots/*.json "$out/"
ls "$out"
