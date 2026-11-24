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
- on Windows, on Linux and in WSL, where there is no app, the page in a browser gets the token from `forchetta open`: the address holds a code good once, for two minutes, never the token, which would stay in the history of the browser, and the page keeps the token for its tab only. In WSL the page may be at `localhost` too. On Linux, where every user can read the arguments of the programs of the others, the code is good only from a program of your user. On a Mac there is none of this;
- on Windows, on Linux and in WSL the page opens, with Edge, Chrome, Chromium or Brave, in a profile of its own, without extensions: one that may read every site would read the terminals and could type in them. With another browser it opens in the usual one, and `forchetta open` says so. The page asks the browser not to translate it nor to check its spelling, which some do on a server of theirs;
- the hooks of Claude Code talk to it on a Unix socket in the data folder (`hooks.sock`), which is readable only by you: no other user can send it events, ask its guard, or answer a permission prompt, and nobody can stand in its place when it is off (from the first start of a daemon that has the socket; until then the hooks still talk to an older daemon on its port);
- on Windows there are no such sockets: the hooks, and the hosts of the sessions, talk to it on pipes with a name made at random and a key, both in the data folder. The two ends prove to each other that they have the key, without sending it, before anything else passes (`src/shared/pipe.ts`): a program that takes the name of a pipe gets nothing, and one that connects to it neither;
- the data folder and its files are private to you (`0700` and `0600`). On Windows it is in your user folder, which other users cannot open; elsewhere (`FORCHETTA_VAR`) Forchetta closes it when it makes it. On Linux and in WSL, where a folder may be on a disk with no permissions (a drive of Windows, say), Forchetta looks, and does not start there.

It does **not** keep out programs that run as you, the Claude sessions included: they can read your files, the token of the daemon among them, as they can read the rest of your home folder. That boundary is the one of the system, between users.

On Windows itself, the sessions Forchetta starts run in hosts of their own, as your user, and go on without it. The guard reads the commands of Bash and of PowerShell as a person would read the line, not what a script or a program does by itself. Of programs, the archive has only the console of Microsoft (`OpenConsole.exe`, `conpty.dll`, signed) and the two libraries of node-pty (not signed): the rest is code for Node.js.

Inside WSL 2, Windows forwards its `localhost` to Forchetta: the other programs of Windows can reach its port, as those of a Mac can, and need the token all the same. The files of WSL are readable by the Windows user who owns it. A session in WSL can start programs of Windows (`powershell.exe`, `cmd.exe`): the guard does not see what they change.

Skills: Forchetta fetches the skills of its catalog at a commit fixed in the catalog. A skill of yours, or one that a team file brings, comes only when you ask for it, at the commit it names; a skill whose folder leaves the repository, or holds symbolic links, is refused.

## What you install on Linux and Windows

The archives for Windows and for Linux (WSL 2 too) are made by GitHub from a commit of this repository (`.github/workflows/linux-archive.yml`), and no file in them comes from the computer of a person. The actions that make it are at a fixed commit, and the packages are those of `pnpm-lock.yaml`, each checked against its hash there; the versions of Node.js 22, of pnpm and of the compiler are those GitHub gives that day. The page and the daemon are built and packed twice, and must come out the same.

Its attestation, signed by GitHub and in a public log, says which commit, tag and workflow it comes from. With the [GitHub CLI](https://cli.github.com) signed in you can check it, and the installer does too:

```sh
gh attestation verify forchetta-<version>-windows.tar.gz --repo alessiodonato/forchetta \
  --signer-workflow alessiodonato/forchetta/.github/workflows/linux-release.yml --source-ref refs/tags/v<version>
```

The `install.ps1` and the `install.sh` of a release have an attestation as well, and each holds the checksum of its archive: it takes no other, unless you ask it for another version (`FORCHETTA_VERSION`). Those at forchetta.dev hold none, and take the checksum from the release. A Node.js it downloads comes from nodejs.org and must be the one its list says.

## Versions

Fixes go into the latest release. Update with `brew upgrade forchetta`, then `forchetta setup`; on Windows, on Linux and in WSL, with the installer again.
