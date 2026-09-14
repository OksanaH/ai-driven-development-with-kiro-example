---
inclusion: manual
description: "Stages and commits all changes with a git commit message generated from the changes made."
---

Stage and commit the current changes:
1. Run `git status --short` to see what changed. If there are no changes, report that there is nothing to commit and stop.
2. Stage the changed files with `git add`, preferring specific file names over `git add .`. Do NOT stage files that look like they contain secrets (.env, credentials, keys, tokens).
3. Commit with `git commit -m "<message>"` where the message is a concise summary of the changes, written in conventional-commits style (e.g. "feat: add pagination to users endpoint"). Use the imperative mood, keep the subject under 70 characters, and add a short body listing key changes if there is more than one.
4. Do not push. Report the commit hash and message when done.
