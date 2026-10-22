# anesa

*anesa* (Amharic አነሣ): "lifted up, cleared away".

What takes the space in a folder, what can be thrown away and rebuilt, and
what is still running from inside it. Plus `clean`, which stops what runs from
a finished folder, keeps it from restarting, and deletes it.

macOS and Linux. Needs only Node 18 or newer; no dependencies, nothing to install.

```sh
npx anesa --human              # report on the current folder
npx anesa --human ~/Projects   # or any folder
npx anesa clean ./old-checkout # stop, unload, delete (asks first)
```

Output is JSON by default, for agents and scripts. Add `--human` to read it
yourself. Sizes are bytes in JSON and `du -h` style (`2.3G`) with `--human`.

## The report

```sh
npx anesa --human /Volumes/Projects/claude
```

```
/Volumes/Projects/claude  94G in 379,892 files, 61,032 folders (88.3 s)
reclaimable: 84G in 216 junk folders (.target 71G, target 5.0G, .next 3.9G, node_modules 1.9G, .tmp 1.5G, .open-next 442M, …)

• simien-runtime  50G
      |--->   50G  simien-runtime/.target  [junk: .target]
      |--->   39M  simien-runtime/.git
      |--->  6.0M  simien-runtime/crates
      |--->  2.6M  simien-runtime/.tmp  [junk: .tmp]
      |--->  1.1M  simien-runtime/vendor
      …
      ⚠ running: zsh (pid 68524) in simien-runtime
…
```

For each folder here: its size, then what is inside it, biggest first. Then
every process whose working directory or program is inside it, with its pid.

| option | does |
|---|---|
| `--depth <n>` | how many levels down to show (default 2) |
| `--biggest <n>` | also list the n biggest folders, files and junk folders anywhere below |
| `--min-size <size>` | hide entries smaller than this below the top level, e.g. `500M` (default 4K) |
| `--all-filesystems` | also walk into other disks mounted inside (default: stay on one, like `du -x`) |
| `--no-processes` | skip the process lookup |
| `--nopretty` | compact JSON |

### Finding where 189 GB went

Start wide, then follow the space down:

```sh
# 1. The biggest folders and files anywhere under home, and what is junk.
npx anesa --human --biggest 30 --depth 1 ~

# 2. Drill into the biggest one, hiding the small stuff.
npx anesa --human --depth 3 --min-size 1G ~/Library

# 3. The one-line answer to "how much can I get back by deleting build output":
npx anesa --human ~/Projects | sed -n 2p
```

`--biggest` lists every folder by its whole size, so the parents of a big
folder show up above it: read it top-down until the size stops dropping with
each step, and that is where the data actually is. A single huge file (a
VM disk image, a database) shows under "biggest files".

Folders the scan can't read (permissions) are counted and listed, not
guessed; on macOS, give the terminal Full Disk Access to see inside
`~/Library` and other protected places.

### Junk

A folder counts as regenerable junk when it is named one of
`node_modules target .target .next .nuxt .svelte-kit .open-next dist build
.turbo .cache .parcel-cache .wrangler DerivedData .gradle __pycache__ .venv
.pytest_cache .mypy_cache .ruff_cache .tmp coverage`, or when it holds a
`CACHEDIR.TAG` file (cargo and many other tools mark their caches with one).
A junk folder inside another (a `node_modules` in a `node_modules`) counts
once, in the outer one. `dist` and `build` are usually output but not always:
look before deleting.

### How sizes are counted

Like `du`: the space allocated on disk (blocks), not the file length, so
sparse and compressed files count what they really take. Symlinks are never
followed. A file with several hard links counts once. Other disks mounted
inside are listed but not walked unless `--all-filesystems` is given.

### Processes

On Linux, from `/proc/<pid>/cwd` and `/proc/<pid>/exe` (falling back to
`lsof` when there is no `/proc`). On macOS, from `lsof` (working directory
and program; programs include libraries a process loaded from there). Only
processes you can see are listed: run as root to see everyone's.

## clean

```sh
npx anesa clean <folder> [--yes]
```

1. Shows its plan: each process it will stop, each launch agent / systemd
   unit it will disable, the git repos whose worktree records it will prune,
   the folder it will delete. Then asks. `--yes` skips the question; with no
   terminal and no `--yes` it changes nothing.
2. Stops every process whose working directory or program is inside the
   folder: TERM, then KILL after 10 s. Never the shared `sccache` server, and
   never itself or the shell that started it.
3. Keeps them from restarting:
   - macOS: a launch agent in `~/Library/LaunchAgents` that mentions the
     folder is unloaded (`launchctl bootout`) and its plist renamed to
     `*.plist.disabled-by-clean`, so it can be undone. One in
     `/Library/LaunchAgents` or `/Library/LaunchDaemons` needs sudo: `clean`
     stops and says so, touching nothing.
   - Linux: a user systemd unit (`~/.config/systemd/user`) that mentions the
     folder is disabled and stopped.
4. Waits 3 s and checks nothing came back. If something did, it stops and
   deletes nothing.
5. Deletes the folder with `find <folder> -delete` (never `rm -rf`; symlinks
   inside are removed, never followed), then prunes git's records of any
   worktrees that were inside it.

It refuses `/`, every top-level folder (`/Users`, `/Volumes`, `/home`,
`/tmp` …), whole disks (`/Volumes/X`, `/mnt/X`, `/media/X`), your home and
anything above it, anyone's home folder, system folders (`/System/…`,
`/Library/X`, `/usr/X`, `/opt/X` …) and anything that isn't a folder.

`clean` deletes everything in the folder, uncommitted work and unpushed
branches included. Commit and push first.

## Output and colour

The same rules as zega's CLI. JSON is the default, for agents: pretty-printed
and coloured on a terminal (keys cyan, strings green, numbers yellow,
punctuation dim), one compact uncoloured line when piped. `--nopretty` gives
the compact line on a terminal too. `--human` is the one switch to readable
text; only there does the terminal matter, for the spinner on stderr during a
long scan, and the anesa mark on `--human --help`.

Colour follows chalk's rules: `FORCE_COLOR=0` turns it off and `FORCE_COLOR=1`
(2, 3) forces it, even into a pipe; otherwise `NO_COLOR` turns it off, and it
needs a terminal whose `TERM` isn't `dumb`.

## Errors and exit codes

Exit code is 0 or 1. Mistakes on the command line are one line of JSON on
stderr: `{"ok":false,"error":{"code":"usage","message":"…","hint":"anesa --help"}}`.
Other error codes: `not_a_folder`, `refused`, `system_agents`, `needs_yes`,
`declined`, `restarted`, `delete_failed`. `--help` is JSON; `--human --help`
is text.

## Development

```sh
npm test                  # node:test, no dependencies
npm pack && npx ./anesa-*.tgz --human
```
