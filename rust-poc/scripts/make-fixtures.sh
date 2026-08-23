#!/usr/bin/env bash
# Genera fixture Git deterministiche per i golden test dei parser (rust-poc/PLAN.md M1).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURES="$ROOT/rust-poc/crates/gittree-core/tests/fixtures"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export GIT_AUTHOR_NAME="Ada Lovelace"
export GIT_AUTHOR_EMAIL="ada@example.com"
export GIT_COMMITTER_NAME="Ada Lovelace"
export GIT_COMMITTER_EMAIL="ada@example.com"
export GIT_AUTHOR_DATE="2026-01-02T03:04:05+00:00"
export GIT_COMMITTER_DATE="2026-01-02T03:04:05+00:00"

git -c init.defaultBranch=main init -q "$TMP/repo"
cd "$TMP/repo"
git config user.name "Ada Lovelace"
git config user.email "ada@example.com"

cat > file.txt <<'EOF'
alpha
bravo
charlie
delta
echo
EOF
git add file.txt
git commit -qm "add file"

cat > file.txt <<'EOF'
alpha
bravo!
charlie
delta
echo
foxtrot
EOF
GIT_AUTHOR_DATE="2026-01-03T03:04:05+00:00" \
GIT_COMMITTER_DATE="2026-01-03T03:04:05+00:00" \
  git commit -qam "edit bravo and add foxtrot"

printf '\x00\x01\x02binary' > blob.bin
git add blob.bin
git commit -qm "add binary blob"

printf 'tail' > tail.txt
git add tail.txt
git commit -qm "add tail without newline"

# Modifica staged + modifiche unstaged sovrapposte sullo stesso file.
sed -i 's/^charlie$/CHARLIE/' file.txt
git add file.txt
sed -i 's/^delta$/delta?/' file.txt
printf 'golf\n' >> file.txt

printf '\x00\x09\x08other' > blob.bin
printf 'tail!' > tail.txt

mkdir -p "$FIXTURES"
git diff HEAD > "$FIXTURES/unified-all.patch"
git diff -- file.txt > "$FIXTURES/worktree-file.patch"
git diff --cached -- file.txt > "$FIXTURES/staged-file.patch"
git blame --porcelain -- file.txt > "$FIXTURES/blame.porcelain"

echo "Fixture scritte in $FIXTURES"
