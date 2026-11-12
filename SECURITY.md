# Security

Forchetta runs hooks inside Claude Code, answers permission prompts and types into your sessions, so a security problem in it matters. Thanks for reporting one.

## How to report

Please don't open a public issue. Report it privately on GitHub: **Security → [Report a vulnerability](https://github.com/alessiodonato/forchetta/security/advisories/new)**.

Say what you found, how to make it happen, and what someone could do with it. You'll get an answer within a week.

## What counts

For example:
- another process or another user on the Mac talking to the daemon, or reading its token or its data;
- a way to answer a permission prompt, or to type into a session, without you;
- a hook that slows down, breaks, or changes what a Claude Code session does;
- a change to `~/.claude/settings.json` that Forchetta did not show you first;
- data leaving the Mac, other than the optional summaries you turned on.

## Versions

Fixes go into the latest release. Update with `brew upgrade forchetta`, then `forchetta setup`.
