<div align="center">

<img src="docs/img/logo.svg" alt="" width="96" height="96">

# Forchetta

### Every Claude Code session on your Mac, in one window.

Forchetta finds the Claude Code sessions you have running and shows, live, what each one is doing, what it is waiting for and what it has cost. Open up to four side by side, answer permission prompts from their box, get a notification when one needs you, and start teams of agents that work together.

[![macOS 12+](https://img.shields.io/badge/macOS-12+-d97757?style=flat-square&logo=apple&logoColor=white)](#install)
[![Homebrew](https://img.shields.io/badge/brew-alessiodonato%2Ftap%2Fforchetta-d97757?style=flat-square&logo=homebrew&logoColor=white)](#install)
[![For Claude Code](https://img.shields.io/badge/for-Claude%20Code-d97757?style=flat-square)](https://code.claude.com)
[![Runs locally](https://img.shields.io/badge/runs-locally-46c48a?style=flat-square)](#uninstall)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-8b867d?style=flat-square)](LICENSE)
[![Website](https://img.shields.io/badge/website-forchetta-d97757?style=flat-square)](https://alessiodonato.github.io/forchetta/)

[Install](#install) ·
[What it does](#what-it-does) ·
[Teams of agents](#teams-of-agents) ·
[arricurdAI](#works-with-arricurdai) ·
[Manual](https://alessiodonato.github.io/forchetta/manual.html) ·
[Uninstall](#uninstall) ·
[🇮🇹 Italiano](README.it.md)

<br>

<img src="docs/img/demo.gif" alt="A team of agents in Forchetta: a team is created from a template, its four terminals open, the lead gets a goal, gives work to developer, then to reviewer and tester, collects their answers and reports back." width="100%">

<sub>A team of agents at work. Recorded in the simulation of this repository (<code>scripts/dev</code>): the sessions are scripted stand-ins for Claude Code, the app, the daemon and the queue are the real ones.</sub>

</div>

## What it does

Version 0.8.1:
- finds the Claude Code sessions that are running and shows a box for each one, with its state, current action, summary, context, cache and cost;
- opens up to 4 sessions side by side, in real terminals attached to tmux;
- sends `/btw`, `/compact` and `/clear` to one session or to several, only when it is safe;
- answers permission prompts from the box (once or "always"), notifies waits, stalls and errors, and warns when two sessions work on the same files;
- starts **teams of agents**: a lead (a Claude session, or you) and up to 6 members, each a Claude Code session, that pass each other requests, answers and questions; each member answers its lead (⇄) or only executes (→), and can work in a git worktree of its own;
- shows the changes of each session and the artifacts it published on claude.ai, starts new sessions, organizes sessions in groups and roles, and searches earlier sessions with arricurdAI;
- lives in the menu bar, with the shortcut ⌃⌥F.

Everything runs on your Mac. The one outside service, optional and off by default, is the Claude API for the summaries.

## Install

```sh
brew install alessiodonato/tap/forchetta
forchetta setup
```

Homebrew brings Node.js and tmux with it. `forchetta setup`:
- builds the app on your Mac and puts it in `~/Applications`. It uses the Xcode Command Line Tools, which Homebrew has already installed: no Xcode, no Apple account. Built on your Mac, the app opens with no warning from macOS;
- adds the hooks of Forchetta to Claude Code, showing you first every change to `~/.claude/settings.json`, and the whole diff if you want it (see [Claude Code hooks](#claude-code-hooks));
- tells you where your data is.

Then open Forchetta from `~/Applications`. Sessions already running appear on their own. To open the terminal of a session in the app, start it with `forchetta run claude`, or with **new session** in the app.

After `brew upgrade forchetta`, run `forchetta setup` again: it builds the app again only when it changed.

You need macOS 12 or later and Claude Code (tested with 2.1.322). Optional: [arricurdAI](#works-with-arricurdai).

**Where your data is.** Forchetta keeps everything it writes in `~/Library/Application Support/Forchetta`, readable only by you: the token of the daemon, the socket of tmux, the state of the sessions, the logs, the backups, the settings in `config.json`. In a clone it is `var/` inside the clone. Below, `var/` stands for this folder.

### From source

```sh
git clone https://github.com/alessiodonato/forchetta.git
cd forchetta
pnpm install          # also makes the spawn-helper of node-pty executable
pnpm build            # CLI, daemon and the page of the app in dist/
bin/forchetta setup   # the app in ~/Applications, and the hooks
```

You need Node.js 22 or later, pnpm and tmux (`brew install tmux`). `pnpm build:app` builds the app in `build/` instead, for development. For the `forchetta` command in your terminal, add to `~/.zshrc`:

```sh
alias forchetta=/path/to/forchetta/bin/forchetta
```

## Works with arricurdAI

[arricurdAI](https://github.com/alessiodonato/arricurdai) keeps the context of Claude Code small and shows where your tokens go. Forchetta works without it; with it, Forchetta also shows:
- the context of each session, and the countdown of its prompt cache;
- the `guard` badge, when arricurdAI will stop the next prompt;
- the cost and the tokens of today, for every session (see [Cost and tokens](#cost-and-tokens));
- **search**: earlier sessions of a project, with secrets hidden (`arricurdai recall`);
- before a `/clear` from the box, a note for the new session, so it starts where the old one left off (arricurdAI 0.5.0 or later).

Its menu bar icon replaces the SwiftBar plugin of arricurdAI. Forchetta finds arricurdAI in the PATH or in its hooks.

## Claude Code hooks

Forchetta knows what your sessions do through the hooks of Claude Code. `forchetta setup` installs them; on their own:

```sh
forchetta hooks install
```

The command:
- lists every change to `~/.claude/settings.json` and asks before it writes: answer `d` to see the whole diff first, or pass `--diff`;
- also puts `bin/forchetta-statusline` in front of your status line, for the cost of each session (see [Cost and tokens](#cost-and-tokens));
- keeps a copy of the file in `var/backups/`;
- adds its hooks **next to** the ones you have, those of arricurdAI for example, without changing them;
- works for sessions already open too, because Claude Code reads the hooks again by itself.

Every event goes through `bin/forchetta-hook`, a small `sh` + `curl` script that forwards it to the local daemon. The script:
- prints nothing;
- always exits with 0, even when the daemon is off: sessions never show an error and are never slowed down;
- runs in the background for frequent events, so Claude does not wait for it.

`SessionStart` and `SessionEnd` are synchronous instead: they take about 30 ms.

`PermissionRequest` goes through `bin/forchetta-permission`, which waits for the answer of the box (see [Permissions from the box](#permissions-from-the-box)). The dialog in the Terminal shows up anyway, at once. With the daemon off, the script exits at once and prints nothing. The same happens with `claude -p` and with the SDK, which have no dialog.

## Usage

```sh
forchetta run claude [claude arguments]   # like `claude`, but inside tmux
forchetta ls                              # the sessions and their state
forchetta ls --json                       # the same, as JSON for scripts and jq
forchetta daemon start|stop|status
```

`forchetta run claude` starts Claude Code in a private tmux server of Forchetta (`var/tmux.sock`, configured in `config/tmux.conf` of Forchetta) and attaches the current terminal. You use it like `claude`, with a few differences:

- **Closing the Terminal window does not end the session:** it only detaches it. Claude goes on working and Forchetta goes on showing it. To end the session, use `/exit`.
- To detach without closing the window: `Ctrl-b d`.
- To attach again from a terminal: `tmux -S "$HOME/Library/Application Support/Forchetta/tmux.sock" attach -t fk-xxxxxxxx` (in a clone, `var/tmux.sock`). You find the name of the session with `tmux -S "$HOME/Library/Application Support/Forchetta/tmux.sock" ls`.

Sessions started with plain `claude` show up in `forchetta ls` too, but **read only**: Forchetta cannot send them commands.

The daemon starts by itself with `forchetta run`. Stopping it stops no session.

### Optional alias: `claude` → `forchetta run claude`

To go through Forchetta every time you type `claude`, add to `~/.zshrc` (after the `forchetta` alias, in a clone):

```sh
alias claude='forchetta run claude'
```

`forchetta run` uses the full path of `claude` saved in `var/config.json`, so there is no loop. To run the original `claude` once: `command claude`.

## The app

<img src="docs/img/overview.png" alt="The Forchetta window: twelve sessions, each in a box with its state, what it is doing, a summary, its context and its cost. Two wait for you, in amber." width="100%">

One box per session. It shows up by itself when the session starts and fades when it ends; 10 minutes later it goes away. Each box shows:
- the project and the state;
- the current action, `Edit src/api.ts` or `Bash npm test` for example, or what the session is asking you;
- a short summary, taken from the events;
- the context: a bar and the tokens;
- the countdown of the prompt cache, and the `guard` badge when arricurdAI will stop the next prompt;
- the time since the last event, and whether you can send commands to the session (`tmux`) or it is read only.

**You can tell the states from across the room:**
- **working**: the border pulses slowly;
- **waiting** for you (a permission, a question, a plan to approve): amber, with a breath;
- **turn finished**: green for a moment, with a check;
- **error**: red, with a single shake;
- **compacting**: the context bar squeezes.

Amber, green and red only ever mean a state. Claude orange marks what you can act on: the buttons that start something, what you have chosen, the pane you are typing in.

**Performance and accessibility.** With "Reduce motion" on (System Preferences → Accessibility → Display), the states stay recognizable but still. When the window is minimized, hidden or covered, nothing moves and the daemon stops reading arricurdAI.

On an Intel Mac every animation at 60 fps costs WindowServer about a quarter of a core. So the endless animations run smoothly only for the first seconds after each change of state; then they go on all together, at 12 steps per second. At rest the app, the page and the daemon together stay under 1% of CPU.

**Context and cache come from `arricurdai status`**: Forchetta shows the same numbers and does not compute them again. arricurdAI is found in the PATH or in its hooks, or you set it in `var/config.json` (`"arricurdai": ["/path/to/arricurdai"]`). The percentage is an estimate (`≈`): arricurdAI gives the tokens, not the window of the model. The windows are in `var/config.json`, under `contextWindows`: 1M by default, 200k for Haiku 4.5, Sonnet 4.6 and Opus 4.6.

### Names, groups and roles

<img src="docs/img/org-chart.png" alt="The org chart: the team checkout, its lead above and its three members below, each with what it is working on; the sessions with no group at the end." width="100%">

When you hover a box, **✎** appears. It lets you give the session:
- a **name**, shown in place of the folder (the folder stays next to it, smaller);
- a **group**;
- a **role** (free text, "review" or "tests" for example);
- the mark **lead of the group**.

The choice is kept for its folder too (`var/teams.json`): a session that starts again in the same folder, the next day maybe, finds its place again. **Remove** clears it all.

When there is at least one group, **grid / org chart** appears at the top. In the org chart each group has its own section, with its leads above and the others below, linked; sessions with no group are at the end. The name you chose shows up everywhere: in the column on the left, in the panes, in the notifications and in the conflict warnings.

A team of agents (next section) is a group too: its sessions get their name, group and role when they start.

### Teams of agents

<img src="docs/img/new-team.png" alt="The new team panel: the template feature squad, a Claude lead with its role, three members with theirs, two that answer and a tester that executes only, each in its own worktree." width="100%">

A team is a group of Claude Code sessions that work together: a **lead** gives the requests, the **members** carry them out. The lead is a Claude session, or you. **new team**, at the top, opens the panel:
- **Start from**: a template that fills the panel in one click: *developer + reviewer*, *feature squad* (frontend, backend, tester), *research + writing*, and the ones you saved;
- the **name** of the team, which is also its group in the org chart, and its **folder**;
- the **lead**: **Claude**, with a name, a role, a model and a permission mode, or **you**;
- the **members**, up to 6: a name and, in a sentence, what each one does. **more** holds the model, the permissions and the worktree of that member;
- how each member talks with its lead:
  - **⇄ answers**: when it finishes a request, its final message goes back to the lead. If it cannot go on, it can ask the lead a question;
  - **→ executes**: it does the work and sends nothing back;
- **members in own worktree**, on by default: each member works in a git worktree of its own, so the members never touch each other's files (see below).

**Create team** (⌘↩) starts every session in the tmux of Forchetta, the lead first. From its system prompt each one knows who it is, its role, its lead and the other members; its name shows in its box, in its pane and in Claude Code (`--name`). **Save as template** keeps the team without its folder (in `var/crew-templates.json`), to start it again elsewhere.

**How the work goes.** You give the goal to the lead: from the **team** panel, or in its terminal. A Claude lead splits it with the tools of the team, an MCP server called `forchetta` that only the sessions of the team get, with no permission to ask:
- `send_request` gives work to one member, to some or to all. The request gets a number and reaches each member as a new prompt, "Request #3 from lead:", as soon as its session is free. Until then it waits in the queue of the member, like the commands of the box and with the same checks;
- the final message of a member that answers reaches the lead as a new prompt: "Answer from developer to request #2:";
- `wait_for_answers` lets the lead wait for the answers it needs, up to 10 minutes, and get them all at once in the same turn, instead of one prompt each;
- `ask_lead` lets a member that answers ask the lead about its request. The answer comes back as a new request;
- `team` shows the lead its members, what each one does, what it is working on and where its worktree is.

When you are the lead, the answers and the questions of the members come to you, in the team panel.

<img src="docs/img/team.png" alt="The panel of the team checkout: the thread of requests, answers and questions between the lead and its members, then the field to write a new request." width="100%">

**The team panel.** **team**, at the top, appears when there is at least one team. It shows the thread of the team, oldest first:
- each request, with who sent it, to whom, and how it goes for each one: in the queue, working, done;
- the answers, and where they went: delivered to the lead, collected by its wait, for you, or not sent back (a member that executes only, or one that asked a question instead);
- the questions of the members.

Below the thread you write a request yourself: to the lead, to one member or to all of them. It reaches them as "Request #n from the user:". The boxes of the team say what each session works on ("#4 from lead: write the tests…"), and the box of a Claude lead says which requests it is still waiting for.

**edit team** changes the team while it works:
- **→ / ⇄** of a member: it applies from its next request, which tells the member;
- **remove** takes a member out of the team: its requests still in the queue are cancelled and its box leaves the group, but its session goes on (`/exit` ends it);
- **+ member** adds a member, started like the others;
- **Save as template**.

A Claude lead learns of every change with its next prompt.

**Worktrees and merging.** With **own worktree**, Claude Code creates a git worktree for the member (`--worktree`, in `.claude/worktrees/` of the repository), on a branch of its own. The member commits its work at the end of each request. The lead stays in the folder of the team: its system prompt tells it to merge the branches of the members with git when their work is good, or to tell you that it is ready.
- The folder must be in a git repository: otherwise the members share it.
- Claude Code makes a worktree only in a folder it trusts. If you never opened that folder with `claude`, only the first session starts: answer the trust dialog in its terminal, and the others start, each in its worktree.

**Limits.** At most 6 members per team, and 20 requests open at once in a team: a lead cannot hand out more work than you can follow. A request is at most 20,000 characters; a long one shows in the terminal of the member as `[Pasted text #1 +N lines]`, as when you paste it yourself. The teams are kept in `var/crews/`, one file each, and come back when the daemon restarts.

### Cost and tokens

- **At the top, the total of today**: "today ≈ $46.20 · 142M tokens". It counts every call of every session since midnight, closed ones too, at API prices. It comes from `arricurdai status`, like the context and the cache; hover it to read the number of calls too, and the calls left out because their model has no known price.
- **In each box, the cost of the session** since it started (in the footer: "≈ $0.42"). Claude Code computes it, as for `/cost`, and it comes through the status line with every message. A session open for days can cost more than the total of today.
- **The tokens of the session** are those of the context, next to the bar: "≈36% · 357k". With an arricurdAI that gives the share of today of each session (`sessions[].today` in `status --json`), the footer adds the tokens of today, subagents included: "≈ $0.42 · today 1.2M tok". The tooltip explains the two sources; the boxes add up to the total at the top.

For the cost of the session, `forchetta hooks install` puts `bin/forchetta-statusline` in front of your status line:
- your command is saved in `var/statusline-command` and runs with the same input, so the line at the bottom stays the same;
- with the daemon off, the status line does not change;
- `forchetta hooks uninstall` puts your command back.

The status line of Claude Code gives tokens too, but those of the last call, not the total of the session, and Forchetta does not use them.

### The changes of a session

When a session has written files, its box shows "3 files" in the footer; the same button is in the header of an open pane. A click opens a panel with the files the session wrote, the most recent first, and two views:
- **by this session**: only what the session itself changed, change by change ("edit · 3 min ago", "file created"), as Claude Code reported it. Changes to the same file by other sessions, or by you, do not show up here. They are kept in `var/patches/` (readable only by you) and deleted when the session leaves the list;
- **since the last commit**: the diff of its repository (`git diff HEAD`), that is the file as it is now. A new file shows up whole.

More details:
- Esc or a click outside closes the panel; **refresh** reads the changes again;
- a file outside git has no diff;
- a file already committed says "no difference since the last commit";
- the view since the last commit includes changes made to the same file by others too: to know who else touched it, there is the conflict warning;
- the list includes only what was written with `Edit` and `Write`, as for conflicts;
- the diff is read only when you open the panel;
- `git` works read only, with no external diff, textconv or fsmonitor.

### Artifacts of claude.ai

When a session publishes an artifact on claude.ai, or opens one, its box shows "1 artifact" in the footer, next to "3 files"; the same button is in the header of an open pane. With one artifact, a click opens it in your browser. With more, a click shows the list, newest first: each one with its title, whether the session published or opened it, and when, and **copy** for its link.

- Forchetta takes the link and the title from the hook of the Artifact tool of Claude Code, and nothing else of its result. For a session that was already running, it reads them once from its transcript.
- The links are private: they open in your default browser, where you are signed in to claude.ai, and stay in the data folder of Forchetta.
- A box keeps the last 20.

### Conflicts between sessions

If two live sessions wrote the same file in the last hour, both boxes say so: "⚠ same file as beta: src/api.ts". If they wrote different files in the same repository, the warning is softer: "⚠ same repo as beta (app)". In the column on the left a "⚠ same file" or "⚠ same repo" tag appears; hover it to read all the files.

- What counts is what `Edit`, `Write`, `MultiEdit` and `NotebookEdit` wrote successfully. The hooks do not see what a Bash command changes (`sed -i`, `git checkout`, a formatter).
- The repository is the working folder with `.git`: two worktrees of the same repository are two different places and never conflict.
- The warning goes away after an hour with no shared writes, or when the other session ends.
- The writes stay even if the daemon restarts (in `var/state.json`).

### Stalled sessions

If a session is "working" but has sent no event for 10 minutes, its box says so: "◷ no event for 12 min · Bash npm test running". In the column on the left, "◷ stuck?" appears.

Before the warning shows up, Forchetta has already asked `claude agents --json` how the session really is (it does so when the hooks fall quiet): if it has finished meanwhile, or waits for you, it is no longer "working". What is left is a long command, a long answer or a stuck session, and the command in progress helps to tell which. A cost going up counts as a sign of life too. Change the threshold in `var/config.json` with `"stallMin": 10`.

### Menu bar icon and shortcut

While the app is open, there is a fork in the menu bar, with the number of sessions that wait for you next to it. Its menu shows:
- how many sessions wait for you, and the cost of today;
- every session, those that wait for you first, with its state and what it asks, or its context, the time left on its cache and its cost. A click brings Forchetta back on that session;
- **Show Forchetta**, **New session…** and **Quit Forchetta**.

It replaces the SwiftBar plugin of arricurdAI (`arricurdai.1m.sh` in the plugin folder of SwiftBar): it shows the same numbers, because they come from `arricurdai status`, plus the state of the sessions. Forchetta touches neither SwiftBar nor the plugin: remove them yourself if you like.

**⌃⌥F**, from any app, shows Forchetta, or hides it if it is already in front. It uses the system hot keys, so it does not ask for the Accessibility permission. Change it in `var/config.json`, with `"hotkey": "ctrl+alt+space"` or `"cmd+shift+f"` for example (letters, digits or `space`, with at least one modifier); `""` turns it off. If another app already uses the same combination, the menu does not show it. The shortcut is read when the app starts.

**The Desktop permission.** In a clone on the Desktop (or in Documents), the first time you open the app from the Finder or the Dock, macOS asks whether Forchetta may access the files in that folder: allow it, or the app cannot find the daemon. You manage it in System Settings → Privacy & Security → Files and Folders.

macOS remembers the permission by the signature of the app. With an ad-hoc signature the fingerprint changes with every `pnpm build:app`, and you have to allow it again. To avoid that, once:

```sh
sh scripts/make-signing-cert.sh
```

The script creates the signing certificate "Forchetta (firma locale)" in the login keychain, usable only by `codesign`, and from then on `pnpm build:app` signs with it: after one last "Allow", macOS remembers the app across every build. Apple does not recognize the certificate, and it only signs your own builds; remove it from Keychain Access.

**Closing the window hides it**: the app stays active in the menu bar, with its notifications and badge. To really quit: Quit Forchetta (⌘Q). The Dock icon, the menu bar icon or ⌃⌥F open the window again.

### Notifications and badge

A macOS notification also comes when a session **seems stuck** ("alpha seems stuck · no event for 10 min · Bash npm test running", with the same threshold as the box) and when a turn **ends with an error** ("alpha: error · rate_limit · …"). These two stay in Notification Center until you clear them.

When a session has been waiting for you (a permission, a question, a plan to approve) for at least 5 seconds:
- the Forchetta icon in the Dock shows how many sessions wait for you: the same number as "wait for you" at the top;
- a macOS notification comes, with the session and what it asks, "alpha waits for you · Permission: Bash npm test" for example. A click brings Forchetta to the front, with the terminal of that session open.

The 5 seconds keep it from bothering you when you answer at once in the Terminal; Claude Code does the same with its own alerts.

More details:
- each wait gets a single notification, and a new wait of the same session replaces the previous one;
- when the session no longer waits, the notification leaves Notification Center;
- with the Forchetta window in front, no banner shows up, because the box already shows it;
- the first time, macOS asks whether Forchetta may send notifications. Change sound and style in System Settings → Notifications → Forchetta;
- notifications and badge work as long as the app is open, even with its window closed (it stays in the menu bar);
- no notification comes for sessions that were already waiting when the daemon started.

### The terminals

<img src="docs/img/workspace.png" alt="Three terminals open side by side, the other sessions in a column on the left; the large one waits for a permission." width="100%">

A click on a box opens the terminal of the session in the work area. It works only for sessions started with `forchetta run`; the others are read only, and hovering them tells you why. The boxes become a column on the left.

**The layouts:**
- 1 open: the whole work area;
- 2 open: side by side;
- 3 open: the one activated last large on the left, the other two stacked on the right;
- 4 open: two by two.

Panes open, close and move with spring transitions.

**The fifth click** replaces the pane used longest ago: opened, clicked or typed in the longest time ago. If you would rather choose every time, write `"panes": { "replace": "chiedi" }` in `var/config.json`. Typing in a pane does not move it: in the layout of 3, the large one stays the one you activated. And it does not move the keyboard either: it stays in the pane you are typing in, even while Claude answers in another one.

**The ✕ closes the pane only.** Claude goes on working in tmux and stays in the column, ready to open again. If the session ends while its pane is open, the pane says so and shows the last screen.

**Inside the terminal:**
- you type as in the Terminal, with the same keys as Claude Code: Esc interrupts, Shift+Return starts a new line in the prompt;
- Option stays Option: on an Italian keyboard it types @, # and the square brackets;
- the wheel scrolls the history of tmux, which puts the pane in tmux copy mode: from then on the keys go to tmux, not to Claude. The pane says so under its header, with **back to the end**; pressing q, or scrolling to the end, works too;
- to select text: Option + drag, in the Terminal too, because the tmux of Forchetta has the mouse on;
- ⌘-click on a link opens it in your browser: https anywhere, http only on this Mac;
- macOS 12 has the ⏺ symbol of Claude Code only as a color emoji, two cells wide: in the panes it shows as ●. Only the drawing changes, not what Claude receives.

### The commands: `/btw`, `/compact`, `/clear`

Hovering a box shows **btw…**, **compact** and **clear**; in the header of an open pane they are always there. They work only for sessions started with `forchetta run`.

- **btw…** opens a field for the question; Return sends it.
- **compact** goes at once.
- **clear** always asks first. The confirmation says how many tokens will be emptied and what arricurdAI does:
  - from 0.5.0, which has `handoff --prepare` (see [the proposal](docs/proposta-arricurdai.md), in Italian), it first writes a note for the new session;
  - earlier versions cannot: the transcript stays on disk, and `recall` finds it.

**When a command goes.** Forchetta types the command into the session as you would, only when it is safe:
- **the session waits for a new prompt.** If Claude is working, or waits for your answer (a permission, a question), the command stays queued and the box shows it: "queued: /compact · waiting for the turn to end". It never types into a dialog: a key could answer in your place;
- **nobody typed in the session in the last 10 seconds**, from the Terminal or from a pane;
- **the terminal is not scrolled back** (tmux copy mode, after the wheel): the keys would go to tmux, not to Claude. The box says so: scroll to the end, or press q in the pane;
- **the prompt is empty.** A draft of yours is never touched: the command stays "blocked" until you delete or send it, then goes by itself. An answer of `/btw` still open blocks it too, until you close it with Esc;
- **the pane still belongs to the right session**, checked with the pid of Claude before each send. After typing the command, Forchetta presses Return only if the prompt shows exactly that text.

**How it is confirmed.**
- `/compact`: by the `PostCompact` hook. If Claude gives up ("Not enough messages to compact", for example), the box says so.
- `/clear`: by the hooks of the end and the start of the session. The box stays the same, with a new conversation.
- A command still queued can be cancelled.

**The answer of `/btw` cannot be captured, so it does not show in the box.** Claude Code shows it only in a box over the terminal: it enters neither the conversation nor the transcript, and no hook receives it (tried with `MessageDisplay` too). The box says "the answer is in the terminal", and "open" takes you to the pane of the session.

### Permissions from the box

<img src="docs/img/permission.png" alt="A box waiting for a permission: the command in full, Allow, Deny, and the lasting choice Always allow Bash(npm run build:*), in this project, only for you." width="480">

When a session asks for a permission (a command, a change to a file, an address), its box shows what it asks, in full, with **Allow** and **Deny**. In the column on the left, with panes open, only the buttons show; hover the line to read the whole request. It works for every interactive session, those started outside Forchetta too.

- **Allow** works once, like "Yes" in the Terminal.
- **always…** shows the lasting choices, the same Claude Code offers for that request: a rule for the command, a folder to add, a mode ("accept edits" for example). Each choice says where it applies: "only in this session", or in the project, "only for you" (`.claude/settings.local.json`) or "for everyone who shares it" (`.claude/settings.json`). It takes two clicks: **always…**, then the choice. Claude Code writes the rule. The box does not show the choices that apply to every project (they would write to your `~/.claude/settings.json`), nor the one that skips every permission: those stay in the Terminal. The rule Claude Code sends to the box can be narrower than the one in the Terminal: for that exact command, for example, instead of every `python3 …`.
- **Deny** stops Claude, like "No" in the Terminal. Claude reads "The user denied this request from Forchetta." and waits for your next prompt.
- The dialog stays in the Terminal too, and **whoever answers first wins**. Claude Code ignores an answer that comes later.
- The buttons wake up 0.7 s after the request appears, so that a click meant for something else does not answer it by mistake.
- **Before it sends the answer, Forchetta asks `claude agents --json` whether the session still waits.** If you answered in the Terminal meanwhile, the box says "Already answered in the terminal" and sends nothing. That is why a click takes about half a second.
- If you answer in the Terminal, the box notices:
  - with "Yes", when the command ends;
  - with "No" or Esc, at once.
- **No buttons for:**
  - questions (`AskUserQuestion`) and the approval of a plan, because they are not a yes or a no;
  - `claude -p` and SDK sessions, because there a waiting hook would block the run.
- **A request stays in the box for an hour at most,** then only in the Terminal. If the daemon stops, requests go on in the Terminal.

### Search earlier sessions

**search**, at the top, opens a panel: choose the project among the folders of the sessions known, type the words (Return searches), and the passages of earlier sessions that talk about them show up, with their date and the request they answered. arricurdAI searches (`arricurdai recall`) and hides secrets; Forchetta shows only what it finds. The search runs only when you ask.

### New session from the app

<img src="docs/img/new-session.png" alt="The new session panel: a folder, the model, the permission mode, a new worktree and the first prompt." width="480">

**new session**, at the top, opens a panel. Type the folder (`~/` works), pick it among those of recent sessions, or use **Choose…**, which opens the macOS panel. The first prompt is optional: ⌘↩ starts.

**Options** (for that session only, they are options of `claude`):
- **model**: Opus, Sonnet, Haiku, Fable (`--model`). Unlike `/model`, it does not change your default model;
- **permissions**: asks every time, accepts edits, auto, plan (`--permission-mode`). "Skip all permissions" stays in the Terminal;
- **new worktree**, with an optional name: Claude Code creates a git worktree for the session alone (`--worktree`), so several agents in the same repository do not touch the same files. It needs a folder in a git repository that Claude Code trusts: if you never opened it with `claude` and accepted the trust dialog, Claude exits at once and the panel tells you.

The session starts in the tmux of Forchetta, as with `forchetta run claude`, and its terminal opens at once: a folder never used before asks there whether you trust its files. Claude starts through your login shell (`zsh -l -i`), so it has the PATH and the variables of a new Terminal tab, even when the app was opened from the Finder.

The prompt goes through neither tmux nor a shell: it goes into the private environment file of the pane, deleted at start, and reaches Claude as a single argument after `--`, whatever characters it holds (a leading `-` too). If Claude exits right after it starts, the panel says so instead of opening an empty pane.

### One command to several sessions

<img src="docs/img/several-sessions.png" alt="The panel of a command to several sessions: /compact, chosen for three sessions, with their context." width="480">

With at least two sessions you can send commands to, **command to several** appears at the top. The panel lets you:
- choose `/compact`, `/clear` or `/btw` (with its question);
- choose the sessions: one by one, or "context ≥ 80%" (the first choice), "all" and "none".

Each session gets its own command as if it came from its box: with the same queue, the same checks (empty prompt, no dialog, nobody typing) and the same confirmations, which the box shows. For `/clear` the panel asks first, with the total of the tokens that will be emptied. Before each `/clear`, arricurdAI saves the note of the session, if its version can (see above). `/compact` needs nothing: the transcript stays whole and `recall` finds it.

### Summary by Haiku (optional, off)

In place of the summary taken from the events, the box can show a line written by `claude-haiku-5-5`:
- only when the state changes;
- at most once every 30 seconds per session.

**What leaves your computer.** To write it, Forchetta sends the Claude API the last request, the recent actions and the last reply of the session. It is the one outside service Forchetta uses.

**To turn it on:**
1. In `var/config.json`, write `"summaries": { "haiku": true }`.
2. In a terminal, export the key as `FORCHETTA_ANTHROPIC_API_KEY`, not `ANTHROPIC_API_KEY`: the Claude Code sessions would inherit that one.
3. From the same terminal, restart the daemon: `forchetta daemon stop && forchetta daemon start`.

## Uninstall

1. Remove the hooks: `forchetta hooks uninstall`. It shows what it changes, asks, keeps a copy, and removes **only** the hooks of Forchetta.
2. Stop the daemon: `forchetta daemon stop`.
3. Sessions started with `forchetta run` go on running until you end them with `/exit`. To see them: `tmux -S "$HOME/Library/Application Support/Forchetta/tmux.sock" ls`.
4. Remove Forchetta: `brew uninstall forchetta` and `brew untap alessiodonato/tap`. From a clone: delete its folder, and the `forchetta` and `claude` aliases from `~/.zshrc` if you added them.
5. Delete the app, `~/Applications/Forchetta.app`, and the data folder, `~/Library/Application Support/Forchetta`.

Besides the app and its data folder, Forchetta writes a single file: `~/.claude/settings.json`, only with `hooks install` and `hooks uninstall`, and only after you confirm. The app keeps no web cache and no window state. Everything else is in its data folder, which only your user can read:
- the token of the daemon;
- the socket of tmux;
- the state of the sessions;
- the logs;
- the backups.

## Development

```sh
pnpm test        # typecheck + tests (vitest)
pnpm build       # dist/: CLI, daemon and page (esbuild)
pnpm build:app   # build/Forchetta.app (swiftc of the Command Line Tools)
```

To try the app without real sessions there is a test daemon, on another port and with its state in `var/sim`. It runs 12 simulated sessions and a fake arricurdAI; sessions and teams started from the app run `scripts/dev/fake-agent.mjs`, a scripted Claude Code that takes requests, sends the hooks of a real session and, as the lead of a team, gives work to its members and waits for their answers. It needs no Claude and spends no tokens:

```sh
sh scripts/dev/sim.sh                                       # test daemon on port 47822
node scripts/dev/simulate.mjs --port 47822 --scenario mix   # mix | rest | busy, --loop N
FORCHETTA_VAR="$PWD/var/sim" build/Forchetta.app/Contents/MacOS/Forchetta
FORCHETTA_VAR="$PWD/var/sim" node dist/cli.js daemon stop  # when done
```

`scripts/dev/cpu.mjs` measures the average CPU of some processes over an interval. `scripts/package-release.sh` builds the archive of a release, the one the Homebrew formula installs, and prints its sha256.

## License

Apache 2.0: see [LICENSE](LICENSE).

The terminals of the app use [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), under the SIL Open Font License 1.1: see [src/ui/fonts/OFL.txt](src/ui/fonts/OFL.txt).
