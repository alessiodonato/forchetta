# Contributing to Forchetta

Thanks for wanting to help. Forchetta is a young project with one maintainer, so for anything bigger than a small fix, open an issue or a discussion first: a short exchange before the work saves time on both sides.

- **Found a bug?** Open an [issue](https://github.com/alessiodonato/forchetta/issues/new/choose) with the bug template.
- **Have an idea, or a question?** Start a [discussion](https://github.com/alessiodonato/forchetta/discussions).
- **Want to write code?** Issues labeled [good first issue](https://github.com/alessiodonato/forchetta/labels/good%20first%20issue) are a good place to start.
- **Found a security problem?** Don't open an issue: see [SECURITY.md](SECURITY.md).

## Set up

You need macOS 12 or later, Node.js 22 or later, pnpm, tmux (`brew install tmux`) and the Xcode Command Line Tools.

```sh
git clone https://github.com/alessiodonato/forchetta.git
cd forchetta
pnpm install
pnpm test        # typecheck + tests (vitest)
pnpm build       # dist/: CLI, daemon and page
pnpm build:app   # build/Forchetta.app
```

In a clone, Forchetta keeps its data in `var/` inside the clone, so it never touches the data of an installed copy.

## Try your change without real sessions

`bin/forchetta setup` and `bin/forchetta hooks install` change your `~/.claude/settings.json`. To try a change you don't need them: the repository has a simulation, with a test daemon on another port, 12 simulated sessions and a scripted Claude Code that spends no tokens. See [Development](README.md#development) in the README.

Screenshots for a pull request come from the simulation too, so they show no personal paths and no real project names.

## What every change keeps true

These are promises Forchetta makes to the people who install it:

- **Hooks never get in the way of a session.** The hook scripts in `bin/` print nothing, always exit with 0, and run in the background for frequent events. With the daemon off, a session behaves exactly as without Forchetta.
- **Nothing leaves the Mac.** The daemon listens on `127.0.0.1` only, with a token. The one outside call is the optional summary from the Claude API, off by default. No telemetry.
- **`~/.claude/settings.json` is changed only on request:** by `forchetta hooks install` and `uninstall`, after showing every change and asking, with a backup.
- **Commands go into a session only when it's safe:** the session is idle, nobody is typing, the prompt is empty.
- **It stays light.** At rest, the app, the page and the daemon together stay under 1% of CPU, and with Reduce Motion on nothing moves.
- **Colors mean one thing each.** Amber, green and red only ever show a state; Claude orange marks what you can act on.

## The code

| Folder | What's in it |
|---|---|
| `src/cli` | the `forchetta` command: `run`, `ls`, `setup`, `hooks`, `daemon` |
| `src/daemon` | the local daemon: hooks, sessions, tmux, teams, permissions, conflicts |
| `src/mcp` | the MCP server that gives the tools of a team to its sessions |
| `src/ui` | the page of the app (Preact) |
| `src/shared` | what the others share: paths, settings, tmux |
| `native` | the macOS app (Swift, AppKit and WebKit) |
| `bin` | the shell scripts Claude Code runs as hooks |
| `test` | the tests (vitest) |
| `scripts/dev` | the simulation |

- TypeScript with Node.js 22 (ESM), bundled with esbuild; Swift for the app, built with `swiftc` alone.
- A change in behavior comes with a test. `pnpm test` must pass, and the CI runs it on every pull request.
- Comments say why, not what.
- Text in the app and in the docs: plain English, short sentences. A new feature goes in `README.md` and in `docs/manual.html`; `README.it.md` can be left to the maintainer.

## Pull requests

- One change per pull request, with what it does, why, and how you tried it.
- For a change you can see, add a screenshot from the simulation.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), like the rest of Forchetta.
