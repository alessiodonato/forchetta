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

## What Forchetta protects, and what it does not

Forchetta keeps out **other users of the Mac** and **web pages**:
- the daemon listens on `127.0.0.1` only; every request to `/api` and to its WebSocket needs its token, and a request with the `Host` or `Origin` of another site is refused;
- the hooks of Claude Code talk to it on a Unix socket in the data folder (`hooks.sock`), which is readable only by you: no other user can send it events, ask its guard, or answer a permission prompt, and nobody can stand in its place when it is off (from the first start of a daemon that has the socket; until then the hooks still talk to an older daemon on its port);
- the data folder and its files are private to you (`0700` and `0600`).

It does **not** keep out programs that run as you, the Claude sessions included: they can read your files, the token of the daemon among them, as they can read the rest of your home folder. That boundary is the one of macOS, between users.

Skills: Forchetta fetches the skills of its catalog at a commit fixed in the catalog. A skill of yours, or one that a team file brings, comes only when you ask for it, at the commit it names; a skill whose folder leaves the repository, or holds symbolic links, is refused.

## Versions

Fixes go into the latest release. Update with `brew upgrade forchetta`, then `forchetta setup`.
