# Security

Forchetta runs hooks inside Claude Code, answers permission prompts and types into your sessions, so a security problem in it matters. Thanks for reporting one.

## How to report

Please don't open a public issue. Report it privately on GitHub: **Security → [Report a vulnerability](https://github.com/alessiodonato/forchetta/security/advisories/new)**.

Say what you found, how to make it happen, and what someone could do with it. You'll get an answer within a week.

## What counts

For example:
- another process or another user of the computer talking to the daemon, or reading its token or its data;
- a way to answer a permission prompt, or to type into a session, without you;
- a hook that slows down, breaks, or changes what a Claude Code session does;
- a change to `~/.claude/settings.json` that Forchetta did not show you first;
- data leaving the computer, other than the optional summaries you turned on.

## What Forchetta protects, and what it does not

Forchetta keeps out **other users of the computer** and **web pages**:
- the daemon listens on `127.0.0.1` only; every request to `/api` and to its WebSocket needs its token, and a request with the `Host` or `Origin` of another site is refused;
- on Linux and in WSL, where there is no app, the page in a browser gets the token from `forchetta open`: the address holds a code good once, for two minutes, never the token, which would stay in the history of the browser, and the page keeps the token for its tab only. In WSL the page may be at `localhost` too. On Linux, where every user can read the arguments of the programs of the others, the code is good only from a program of your user. On a Mac there is none of this;
- on Linux and in WSL the page opens, with Edge, Chrome, Chromium or Brave, in a profile of its own, without extensions: one that may read every site would read the terminals and could type in them. With another browser it opens in the usual one, and `forchetta open` says so. The page asks the browser not to translate it nor to check its spelling, which some do on a server of theirs;
- the hooks of Claude Code talk to it on a Unix socket in the data folder (`hooks.sock`), which is readable only by you: no other user can send it events, ask its guard, or answer a permission prompt, and nobody can stand in its place when it is off (from the first start of a daemon that has the socket; until then the hooks still talk to an older daemon on its port);
- the data folder and its files are private to you (`0700` and `0600`). On Linux and in WSL, where a folder may be on a disk with no permissions (a drive of Windows, say), Forchetta looks, and does not start there.

It does **not** keep out programs that run as you, the Claude sessions included: they can read your files, the token of the daemon among them, as they can read the rest of your home folder. That boundary is the one of the system, between users.

On Windows, Forchetta runs inside WSL 2, which forwards `localhost` of Windows to it: the other programs of Windows can reach its port, as those of a Mac can, and need the token all the same. The files of WSL are readable by the Windows user who owns it. A session in WSL can start programs of Windows (`powershell.exe`, `cmd.exe`): the guard does not see what they change.

Skills: Forchetta fetches the skills of its catalog at a commit fixed in the catalog. A skill of yours, or one that a team file brings, comes only when you ask for it, at the commit it names; a skill whose folder leaves the repository, or holds symbolic links, is refused.

## Versions

Fixes go into the latest release. Update with `brew upgrade forchetta`, then `forchetta setup`; on Linux and in WSL, with the installer again.
