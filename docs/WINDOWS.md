# Overstory on Windows

Windows support for Overstory replaces tmux-based agent spawning with a custom **turn-runner relay daemon** (`win-relay.ts`). This guide covers the architecture, setup, usage, and troubleshooting specific to Windows.

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Bun](https://bun.sh) | 1.0+ | Runtime (runs TypeScript directly) |
| [Git for Windows](https://gitforwindows.org/) | Any | Provides bash shell (MSYS2) + git |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | 2.1+ | AI agent CLI |
| Windows Terminal | Recommended | Better process visibility |

Verify your setup:

```bash
bun --version          # Should be >= 1.0
claude --version       # Should be >= 2.1
git --version          # Any recent version
```

## Architecture Overview

On Unix, Overstory spawns agents in tmux sessions and uses `tmux send-keys` for communication. On Windows, tmux is unavailable, so a different approach is used:

```
                         ┌─────────────────────────────┐
                         │   Win-Relay Daemon (bun)     │
                         │   Polls inbox every 2s       │
                         └──────────┬──────────────────┘
                                    │
    inbox.ndjson ──write──>  Read new messages
                                    │
                         ┌──────────▼──────────────────┐
                         │   Spawn: claude -p           │
                         │   --input-format stream-json │
                         │   --output-format stream-json│
                         │   --resume <session_id>      │
                         └──────────┬──────────────────┘
                                    │
                         ┌──────────▼──────────────────┐
                         │   Claude Code processes turn │
                         │   Output → stdout.log.turn   │
                         └──────────┬──────────────────┘
                                    │
                         ┌──────────▼──────────────────┐
                         │   Relay detects result msg   │
                         │   Extracts session_id        │
                         │   Kills hung process (if any)│
                         │   Appends to stdout.log      │
                         │   Resumes polling             │
                         └──────────────────────────────┘
```

**Key insight:** Claude Code's `-p` (print) mode is always single-shot. Multi-turn conversations require spawning a new `claude -p --resume <session_id>` process for each turn. The relay daemon manages this lifecycle automatically.

## Quick Start

```bash
# 1. Initialize overstory in your project
cd /path/to/your/project
overstory init

# 2. Install hooks
overstory hooks install

# 3. Start the coordinator (no tmux attach on Windows)
overstory coordinator start --no-attach

# 4. Check status
overstory status

# 5. Tail the coordinator's output
tail -f .overstory/logs/overstory-*-coordinator/stderr.log

# 6. Send a task to the coordinator
overstory nudge coordinator "Run bun test and report results"
```

## How It Works

### File-Based IPC

Each agent gets a log directory under `.overstory/logs/{session-name}/`:

| File | Purpose |
|------|---------|
| `inbox.ndjson` | Append-only message queue. New messages are NDJSON lines. |
| `inbox.ndjson.pid` | PID of the relay daemon (or active Claude process during a turn) |
| `stdout.log` | Accumulated NDJSON output from all turns |
| `stdout.log.turn` | Output from the current/last turn (overwritten each turn) |
| `stderr.log` | Relay daemon log (timestamped diagnostic messages) |
| `stderr.log.claude` | Claude Code's stderr from the last turn |

### NDJSON Message Format

Messages to the inbox use Claude Code's stream-json protocol:

```json
{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"Your message here"}]},"parent_tool_use_id":null}
```

### Session Continuity

1. **First turn:** Relay spawns `claude -p` with the original args + `--input-format stream-json --output-format stream-json --verbose`
2. **Result extraction:** Relay polls stdout file for `{"type":"result",...}` and extracts `session_id`
3. **Subsequent turns:** Relay spawns `claude -p --resume <session_id>` with minimal flags
4. **Hang workaround:** After detecting the result, relay waits 5 seconds for clean exit, then force-kills if the process is still alive

### Process Tracking

The relay writes the active PID to `inbox.ndjson.pid`:
- During polling: relay daemon's own PID
- During a turn: Claude Code's PID
- After turn completion: reset to relay PID

Check the process with PowerShell (not `kill -0`, which is unreliable on Windows):

```powershell
Get-Process -Id (Get-Content .overstory/logs/overstory-*-coordinator/inbox.ndjson.pid)
```

## Key Differences from Unix

| Aspect | Unix (tmux) | Windows (win-relay) |
|--------|-------------|---------------------|
| Agent container | tmux session | Detached bun process |
| Message delivery | `tmux send-keys` | Append to `inbox.ndjson` |
| Output viewing | `tmux attach` | `tail -f stdout.log` |
| Multi-turn | Persistent stdin pipe | `--resume <session_id>` per turn |
| Process killing | `tmux kill-session` | `taskkill /F /T /PID` |
| Interactive attach | Yes (tmux attach) | No (read-only tail) |
| Agent isolation | tmux pane | Separate process tree |
| Nudge mechanism | `tmux send-keys` | Write to inbox file |

## Known Issues and Workarounds

### Claude Code Hang Bug (GitHub #25629)

After completing a turn, Claude Code sometimes hangs indefinitely instead of exiting. The relay handles this by polling stdout for the result message and killing the process after a 5-second grace period.

**Symptoms:** Relay logs show "Result received, waiting 5000ms for clean exit..." followed by "Process still alive after grace period, killing PID".

**Impact:** None in practice — the relay handles it transparently. Each turn completes normally.

### Bun.file() Stale Reads

`Bun.file(path).text()` may return stale or empty content on Windows when the file is being written by another process. The relay uses Node's `fs.readFile()` instead.

**If you're writing custom code that reads from agent log files**, use `readFile` from `node:fs/promises`, not `Bun.file().text()`.

### MSYS2 `kill -0` False Negatives

Git for Windows (MSYS2) bash's `kill -0 <pid>` does not reliably detect Windows processes. It reports alive processes as dead.

**Use PowerShell instead:**
```powershell
Get-Process -Id <pid> -ErrorAction SilentlyContinue
```

### Watchdog Conflict

The watchdog daemon (`overstory watch`) may kill the relay process. Start the coordinator without `--watchdog` until this is resolved:

```bash
overstory coordinator start --no-attach
# NOT: overstory coordinator start --watchdog --no-attach
```

### Turn Timeout

The relay has a 30-minute turn timeout (`TURN_TIMEOUT_MS`). Tasks that take longer (e.g., running a full test suite + fixing code) will be killed. For long-running tasks, break work into smaller turns by sending follow-up messages.

## Troubleshooting

### Check if the relay is alive

```powershell
# Read the PID file and check the process
$pid = Get-Content .overstory\logs\overstory-*-coordinator\inbox.ndjson.pid
Get-Process -Id $pid -ErrorAction SilentlyContinue
```

### Read relay diagnostics

```bash
# Relay log (most useful for debugging)
tail -f .overstory/logs/overstory-*-coordinator/stderr.log

# Claude Code's stderr from last turn
cat .overstory/logs/overstory-*-coordinator/stderr.log.claude
```

### Check what the coordinator is doing

```bash
# Size of current turn output (growing = active)
wc -c .overstory/logs/overstory-*-coordinator/stdout.log.turn

# Parse the last few actions
grep '"type":"assistant"' .overstory/logs/overstory-*-coordinator/stdout.log.turn | tail -3
```

### Force-kill a stuck coordinator

```powershell
# Kill all processes in the tree
$pid = Get-Content .overstory\logs\overstory-*-coordinator\inbox.ndjson.pid
Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue

# Also kill any orphaned claude processes
Get-Process -Name claude | Where-Object { $_.StartTime -gt (Get-Date).AddHours(-1) } | Stop-Process -Force
```

### Clean up and restart

```bash
overstory clean --sessions --mail --agents --logs
overstory coordinator start --no-attach
```

## Monitoring

### Dashboard

The dashboard works on Windows but can't display tmux pane content:

```bash
overstory dashboard
```

### Direct Log Tailing

The most reliable way to monitor agents on Windows:

```bash
# Relay progress (poll counts, turn starts/completions)
tail -f .overstory/logs/overstory-*-coordinator/stderr.log

# Coordinator output (NDJSON, can be large)
tail -f .overstory/logs/overstory-*-coordinator/stdout.log
```

### Process Tree

View the full process tree for the coordinator:

```powershell
$relayPid = Get-Content .overstory\logs\overstory-*-coordinator\inbox.ndjson.pid
Get-CimInstance Win32_Process |
  Where-Object { $_.ParentProcessId -eq $relayPid } |
  Select-Object ProcessId, Name, CommandLine
```

## Implementation Files

The Windows backend is implemented in two files:

- `src/worktree/win-process.ts` — `WinProcessBackend` class implementing `SessionBackend`. Manages session lifecycle, SQLite registration, inbox writes, process cleanup.
- `src/worktree/win-relay.ts` — Turn-runner daemon. Spawned as a background `bun` process. Handles the polling loop, Claude Code spawning, result detection, and hang-bug workaround.
- `src/worktree/session-backend.ts` — Platform-agnostic `SessionBackend` interface. `getSessionBackend()` returns `TmuxBackend` or `WinProcessBackend` based on `IS_WINDOWS`.
- `src/platform.ts` — Platform detection utilities (`IS_WINDOWS`, `whichCommand()`).
