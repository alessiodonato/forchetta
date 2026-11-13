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

### Use it from a clone

To run Forchetta from source instead of Homebrew, after `pnpm install` and `pnpm build`, run `bin/forchetta setup`: it puts the app in `~/Applications` and installs the hooks. For the `forchetta` command in your terminal, add `alias forchetta=/path/to/forchetta/bin/forchetta` to `~/.zshrc`.

**The Desktop permission.** In a clone on the Desktop or in Documents, the first time you open the app macOS asks whether Forchetta may access the files in that folder: allow it, or the app cannot find the daemon. macOS remembers the answer by the signature of the app, and an ad-hoc signature changes with every `pnpm build:app`. To be asked only once more:

```sh
sh scripts/make-signing-cert.sh
```

It creates the certificate "Forchetta (firma locale)" in the login keychain, usable only by `codesign`; from then on `pnpm build:app` signs with it. Apple does not recognize it, and it signs only your own builds. Remove it from Keychain Access.

## Try your change without real sessions

`bin/forchetta setup` and `bin/forchetta hooks install` change your `~/.claude/settings.json`. To try a change you don't need them: the repository has a simulation, with a test daemon on another port and its state in `var/sim`. It runs 12 simulated sessions and a fake arricurdAI; sessions and teams started from the app run `scripts/dev/fake-agent.mjs`, a scripted Claude Code that takes requests, sends the hooks of a real session and, as the lead of a team, gives work to its members. It needs no Claude and spends no tokens:

```sh
sh scripts/dev/sim.sh                                       # test daemon on port 47822
node scripts/dev/simulate.mjs --port 47822 --scenario mix   # mix | rest | busy, --loop N
FORCHETTA_VAR="$PWD/var/sim" build/Forchetta.app/Contents/MacOS/Forchetta
FORCHETTA_VAR="$PWD/var/sim" node dist/cli.js daemon stop  # when done
```

The demo of the website, [forchetta.dev/demo](https://forchetta.dev/demo/), is the page of the app with a daemon that runs in the browser: the real modules of `src/daemon` (sessions, guard, queue of commands, permissions, teams) around a fake tmux and a scripted Claude Code, in `src/demo`. `node scripts/build-demo.mjs` builds it into `docs/demo/`; build it again when you change the page or one of those modules.

`scripts/dev/cpu.mjs` measures the average CPU of some processes over an interval. `scripts/package-release.sh` builds the archive of a release, the one the Homebrew formula installs, and prints its sha256.

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
| `src/demo` | the demo of the website: the daemon in the browser, a fake tmux, a scripted Claude Code, the tour |
| `native` | the macOS app (Swift, AppKit and WebKit) |
| `bin` | the shell scripts Claude Code runs as hooks |
| `test` | the tests (vitest) |
| `scripts/dev` | the simulation |

- TypeScript with Node.js 22 (ESM), bundled with esbuild; Swift for the app, built with `swiftc` alone.
- A change in behavior comes with a test. `pnpm test` must pass, and the CI runs it on every pull request.
- Comments say why, not what.
- Text in the app and in the docs: plain English, short sentences. A new feature goes in `docs/manual.html`. `README.md` stays short: it changes only when the feature belongs in its list of what Forchetta does. `README.it.md` can be left to the maintainer.

## Pull requests

- One change per pull request, with what it does, why, and how you tried it.
- For a change you can see, add a screenshot from the simulation.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), like the rest of Forchetta.
