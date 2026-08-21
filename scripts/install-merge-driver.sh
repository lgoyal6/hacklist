#!/bin/bash
# Register the union merge driver named by .gitattributes.
#
# .gitattributes says which files use `merge=hacklist-union`, but a merge driver
# is only half declarative: the command behind the name lives in git config,
# which is per-clone and cannot be committed. Without this, git finds the
# attribute, finds no driver, warns, and silently falls back to the text merge
# that caused the stranded-seeds incident in the first place.
#
# So every writer runs this before it pushes; the nightly local pass and the
# GitHub sweep both do. It is idempotent and cheap, which is why it is a plain
# `git config` rather than something that checks first.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

git config merge.hacklist-union.name \
  "union the generated discovery data instead of text-merging it"
git config merge.hacklist-union.driver \
  "node scripts/merge-seeds.mjs %O %A %B"
