# Overstory

Inspired by: https://github.com/steveyegge/gastown/

[![CI](https://img.shields.io/github/actions/workflow/status/jayminwest/overstory/ci.yml?branch=main)](https://github.com/jayminwest/overstory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.0-orange)](https://bun.sh)
[![GitHub release](https://img.shields.io/github/v/release/jayminwest/overstory)](https://github.com/jayminwest/overstory/releases)

Multi-agent orchestration for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Overstory turns a single Claude Code session into a coordinated agent fleet — spawning workers in isolated git worktrees, routing messages through a custom SQLite mail system, and merging their work back with tiered conflict resolution. Zero runtime dependencies.

> **Warning: Agent swarms are not a universal solution.** Do not deploy Overstory without understanding the risks of multi-agent orchestration — compounding error rates, cost amplification, debugging complexity, and merge conflicts are the normal case, not edge cases. Read [STEELMAN.md](STEELMAN.md) for a full risk analysis and the [Agentic Engineering Book](https://github.com/jayminwest/agentic-engineering-book) ([web version](https://jayminwest.com/agentic-engineering-book)) before using this tool in production.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Architecture Deep Dive](#architecture-deep-dive)
- [Agent Types](#agent-types)
- [The Spawn Pipeline](#the-spawn-pipeline)
- [Mail System](#mail-system)
- [Merge Pipeline](#merge-pipeline)
- [Hook Enforcement](#hook-enforcement)
- [Observability Stack](#observability-stack)
- [Watchdog and Health Monitoring](#watchdog-and-health-monitoring)
- [Bridge to Claude Code Task UI](#bridge-to-claude-code-task-ui)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [CLI Reference](#cli-reference)
- [Tech Stack](#tech-stack)
- [Development](#development)
- [Project Structure](#project-structure)
- [License](#license)

---

## How It Works

Your Claude Code session **is** the orchestrator. There is no separate daemon or server. CLAUDE.md instructions + Claude Code hooks + the `overstory` CLI provide everything needed to coordinate a fleet of AI agents.

When you open Claude Code in a project with `.overstory/` initialized:

1. **SessionStart hook** runs `overstory prime` — loads config, recent activity, agent manifest, and mulch expertise into the orchestrator's context
2. **UserPromptSubmit hook** runs `overstory mail check --inject` — surfaces new messages from worker agents before each prompt
3. **PreToolUse hooks** mechanically block dangerous operations — file writes for read-only agents, `git push` for all agents, Claude Code native team tools that bypass Overstory coordination
4. **You use the CLI** to spawn agents, check status, read mail, merge branches, and monitor the fleet

Each spawned agent runs as an independent Claude Code session in its own git worktree, communicating exclusively through SQLite mail. Agents never share a context window — they are fully isolated processes that coordinate through structured message passing.

```
You (Claude Code session at project root)
  │
  ├── overstory sling task-1 --capability lead --name auth-lead
  │     └── Spawns Claude Code in .overstory/worktrees/auth-lead/
  │           ├── Reads overlay CLAUDE.md (base definition + task context)
  │           ├── Sends/receives mail via .overstory/mail.db
  │           └── Commits to branch overstory/auth-lead/task-1
  │
  ├── overstory mail check --inject
  │     └── Reads unread messages, prints them into your context
  │
  ├── overstory merge --branch overstory/auth-lead/task-1
  │     └── 4-tier conflict resolution → merged into canonical branch
  │
  └── overstory status / dashboard / inspect / trace / ...
        └── Observability across the entire fleet
```

---

## Architecture Deep Dive

### Orchestrator Model

Overstory follows a **hierarchical delegation model** with code-enforced depth limits:

```
Coordinator (depth 0, persistent, read-only)
  └── Lead / Supervisor (depth 1, can spawn sub-workers)
        ├── Scout (depth 2, read-only exploration)
        ├── Builder (depth 2, implementation)
        ├── Reviewer (depth 2, read-only validation)
        └── Merger (depth 2, branch merging)
```

The coordinator decomposes objectives into work streams and dispatches leads. Leads decompose further — spawning scouts to explore, writing specs from findings, spawning builders to implement, and spawning reviewers to validate. The hierarchy prevents runaway spawning (max depth is configurable, default 2).

### Two-Layer Agent Instructions

Every agent receives two instruction layers:

| Layer | Source | Content | Purpose |
|-------|--------|---------|---------|
| **Base (HOW)** | `agents/builder.md`, `agents/scout.md`, etc. | Workflow, constraints, tool lists, communication protocol, failure modes | Reusable across all tasks |
| **Overlay (WHAT)** | Generated by `overstory sling`, written to `.claude/CLAUDE.md` in worktree | Task ID, file scope, spec path, branch name, parent agent, mulch expertise | Specific to this task |

The base definition is embedded into the overlay automatically. Agents read their overlay at `.claude/CLAUDE.md` in their worktree to understand both HOW to work and WHAT to work on.

### Isolation via Git Worktrees

Each agent operates in an isolated git worktree at `.overstory/worktrees/{agent-name}/`. This means:

- **No file conflicts** between concurrent agents — each has their own working directory
- **Independent branches** — each agent commits to `overstory/{agent-name}/{task-id}`
- **Shared runtime state** — mail.db, sessions.db, events.db, metrics.db live in the main repo's `.overstory/` and are shared via SQLite WAL mode
- **Automatic resolution** — `resolveProjectRoot()` detects worktrees via `git rev-parse --git-common-dir` and resolves to the canonical root

### SQLite Everywhere

All persistent state uses `bun:sqlite` with WAL mode and busy timeouts for safe concurrent access from multiple agent processes:

| Database | Path | Purpose |
|----------|------|---------|
| `mail.db` | `.overstory/mail.db` | Inter-agent messaging (~1-5ms per query) |
| `sessions.db` | `.overstory/sessions.db` | Agent lifecycle tracking + orchestration runs |
| `events.db` | `.overstory/events.db` | Tool events, timelines, error aggregation |
| `metrics.db` | `.overstory/metrics.db` | Token usage, session durations, merge stats |
| `merge-queue.db` | `.overstory/merge-queue.db` | FIFO merge queue with status tracking |

---

## Agent Types

| Agent | Role | File Access | Can Spawn | Depth |
|-------|------|-------------|-----------|-------|
| **Coordinator** | Persistent orchestrator — decomposes objectives, dispatches leads, monitors fleet | Read-only | Leads only | 0 |
| **Supervisor** | Per-project team lead — manages worker lifecycle within a project | Read-only | Workers | 1 |
| **Lead** | Work stream coordinator — scouts, specs, builds, reviews | Read-write | Workers | 1 |
| **Scout** | Read-only exploration and research — gathers context for specs | Read-only | None | 2 |
| **Builder** | Implementation specialist — writes code, runs tests, delivers working software | Read-write (scoped) | None | 2 |
| **Reviewer** | Validation and quality review — reviews code, runs tests, reports findings | Read-only | None | 2 |
| **Merger** | Branch merge specialist — handles conflict resolution pipeline | Read-write | None | 2 |
| **Monitor** | Tier 2 continuous fleet patrol — tracks health patterns, sends progressive nudges | Read-only | None | 1 |

Each agent definition lives in `agents/{capability}.md` and contains: role description, available tools, communication protocol, workflow steps, constraints, named failure modes, cost awareness guidelines, and completion protocol.

### Propulsion Principle

All agents follow the **propulsion principle**: read assignment, execute immediately. No "propose a plan and wait for approval" pattern. Scouts start exploring within their first tool call. Builders start implementing within their first tool call. This maximizes throughput and minimizes token waste on coordination theater.

---

## The Spawn Pipeline

When you run `overstory sling <task-id> --capability builder --name my-builder`, a 14-step pipeline executes:

1. **Load config** — reads `.overstory/config.yaml`, resolves project root through worktrees
2. **Load agent manifest** — reads `.overstory/agent-manifest.json` for base definitions
3. **Validate hierarchy** — checks depth limit, verifies parent relationships (coordinators can only spawn leads, etc.)
4. **Validate bead** — confirms the task ID exists in the beads issue tracker
5. **Check for conflicts** — ensures no agent with the same name is already running
6. **Create worktree** — `git worktree add .overstory/worktrees/{name} -b overstory/{name}/{task-id}`
7. **Generate overlay** — fills `templates/overlay.md.tmpl` with task context, embeds base definition, writes to worktree's `.claude/CLAUDE.md`
8. **Deploy hooks** — writes `settings.local.json` with capability-appropriate PreToolUse/PostToolUse guards
9. **Create identity** — initializes persistent agent CV at `.overstory/agents/{name}/identity.yaml`
10. **Record session** — writes agent session to `sessions.db` with state "booting"
11. **Track run** — associates the session with the current orchestration run
12. **Spawn tmux session** — `tmux new-session -d -s overstory-{name}` running Claude Code with the overlay
13. **Emit spawn event** — logs the spawn to `events.db` for timeline visibility
14. **Bridge projection** — if bridge is enabled, projects the task to Claude Code's native Task UI

On Windows (where tmux is unavailable), agents spawn as detached processes with stdout/stderr redirected to log files.

---

## Mail System

Overstory uses a purpose-built SQLite mail system for inter-agent communication. This is **not** email — it's a typed protocol with structured payloads designed for machine-to-machine coordination.

### Why Not Use Claude Code's Native Messaging?

Claude Code's `SendMessage` tool works within a single process tree. Overstory agents are independent processes in separate worktrees. SQLite mail provides:
- **Cross-process communication** — any agent can message any other agent
- **Persistence** — messages survive agent restarts and compactions
- **Typed protocol** — structured payloads prevent ambiguity
- **Broadcast** — group addresses like `@all`, `@builders`, `@scouts`
- **Thread tracking** — replies maintain conversation chains
- **Priority routing** — urgent/high messages auto-nudge recipients

### Message Types

**Semantic types** (general purpose):
| Type | Use |
|------|-----|
| `status` | Progress updates |
| `question` | Asking for clarification |
| `result` | Delivering completed work |
| `error` | Reporting failures |

**Protocol types** (structured coordination):
| Type | Payload | Purpose |
|------|---------|---------|
| `worker_done` | `{beadId, branch, exitCode, filesModified}` | Builder signals task completion |
| `merge_ready` | `{branch, beadId, agentName, filesModified}` | Lead confirms branch is ready to merge |
| `merged` | `{branch, beadId, tier}` | Merger confirms successful merge |
| `merge_failed` | `{branch, beadId, conflictFiles, errorMessage}` | Merger reports merge failure |
| `escalation` | `{severity, beadId, context}` | Any agent escalates an issue |
| `health_check` | `{agentName, checkType}` | Watchdog probes liveness |
| `dispatch` | `{beadId, specPath, capability, fileScope}` | Coordinator assigns a work stream |
| `assign` | `{beadId, specPath, workerName, branch}` | Lead assigns a subtask |

### Mail Flow Example

```
Coordinator                  Lead                      Builder
    │                         │                          │
    ├── dispatch ────────────>│                          │
    │   (beadId, objective)   │                          │
    │                         ├── assign ───────────────>│
    │                         │   (beadId, fileScope)    │
    │                         │                          │
    │                         │<──────── worker_done ────┤
    │                         │   (branch, filesModified)│
    │                         │                          │
    │<──── merge_ready ───────┤                          │
    │   (branch, beadId)      │                          │
    │                                                    │
    ├── overstory merge                                  │
    │                                                    │
```

---

## Merge Pipeline

When agents complete their work, branches are merged through a FIFO queue with 4-tier conflict resolution:

| Tier | Name | Strategy | When Used |
|------|------|----------|-----------|
| **1** | Clean merge | `git merge --no-edit` | No conflicts detected |
| **2** | Auto-resolve | Parse conflict markers, keep incoming (agent) changes | Textual conflicts in non-overlapping sections |
| **3** | AI-resolve | Claude reads both versions, merges with intent preservation | Semantic conflicts requiring understanding (disabled by default) |
| **4** | Reimagine | Abort merge, reimplement from spec against current target state | Irreconcilable conflicts |

Every tier runs quality gates after merging (`bun test`, `biome check`, `tsc --noEmit`). If gates fail, the next tier is attempted. Conflict history is tracked per-file to skip historically-failing tiers and inform AI resolution prompts.

```bash
# Check for conflicts first
overstory merge --branch overstory/auth-builder/task-1 --dry-run

# Merge into the default target branch
overstory merge --branch overstory/auth-builder/task-1

# Merge all completed branches
overstory merge --all

# Merge into a specific branch
overstory merge --branch overstory/auth-builder/task-1 --into feature/auth
```

---

## Hook Enforcement

Overstory deploys Claude Code hooks (`settings.local.json`) to each agent's worktree that **mechanically enforce** capability boundaries. This is not advisory — hooks block tool execution before it happens.

### What Gets Blocked

| Capability | Write/Edit | Dangerous Bash | `git push` | Native Team Tools |
|------------|-----------|----------------|------------|-------------------|
| **Builder** | Scoped to FILE_SCOPE | Allowed in scope | Blocked | Blocked (or selective) |
| **Merger** | Allowed | Allowed | Blocked | Blocked |
| **Scout** | Blocked | Blocked | Blocked | Blocked |
| **Reviewer** | Blocked | Blocked | Blocked | Blocked |
| **Lead** | Blocked | Blocked | Blocked | Blocked |
| **Coordinator** | Blocked | Blocked | Blocked | Blocked |

### Selective Native Tool Unblocking

By default, all Claude Code Agent Teams tools (Task, SendMessage, TeamCreate, etc.) are blocked to prevent agents from bypassing Overstory's coordination. With `nativeTools.selective: true` in config, workers can use CC native tools for **local subtasks** (e.g., spawning in-process subagents) while fleet-level topology tools (TeamCreate, TeamDelete) remain always blocked.

### Bash Path Boundary Guards

Builder agents have their file writes restricted to their worktree directory via PreToolUse hooks that inspect `file_path` arguments in Write, Edit, and NotebookEdit tool calls. Any attempt to write outside the worktree is blocked with `"decision": "block"`.

---

## Observability Stack

Overstory provides 10+ CLI commands for monitoring the agent fleet, organized from high-level overview to deep investigation:

### Overview

| Command | Purpose | Use When |
|---------|---------|----------|
| `overstory status` | Fleet snapshot — all agents, worktrees, states | Quick check of what's running |
| `overstory dashboard` | Live TUI with auto-refresh — agents, mail, merge queue, metrics | Continuous monitoring during a swarm run |

### Agent Investigation

| Command | Purpose | Use When |
|---------|---------|----------|
| `overstory inspect <agent>` | Deep single-agent view — recent tool calls, tmux output, session state | Understanding what one agent is doing |
| `overstory trace <target>` | Chronological event timeline for an agent or bead task | Reconstructing what happened |
| `overstory replay` | Interleaved chronological replay across multiple agents | Understanding multi-agent interactions |

### Real-Time Streams

| Command | Purpose | Use When |
|---------|---------|----------|
| `overstory feed --follow` | Unified event stream across all agents (like `tail -f`) | Live-tailing fleet activity |
| `overstory logs --follow` | NDJSON log query with agent/level/time filters | Debugging specific log events |

### Analysis

| Command | Purpose | Use When |
|---------|---------|----------|
| `overstory errors` | Aggregated error view with stack traces across agents | Finding what went wrong |
| `overstory costs` | Token usage and cost breakdown by agent, capability, or run | Understanding spend |
| `overstory metrics` | Session statistics — durations, success rates, merge tier distribution | Post-run analysis |

### Diagnostics

| Command | Purpose | Use When |
|---------|---------|----------|
| `overstory doctor` | 9-category health check (dependencies, config, structure, databases, consistency, agents, merge, logs, version) | Something isn't working |

### Dashboard Layout

The TUI dashboard (`overstory dashboard`) renders zero-dependency ANSI panels with Unicode box-drawing:

```
┌─ Agents ──────────────────────────────────────────┐
│ ● auth-builder   builder   working   12m 34s      │
│ ● api-scout      scout     working    8m 12s      │
│ ◐ ui-builder     builder   booting    1m 02s      │
│ ✓ test-reviewer  reviewer  completed 25m 10s      │
├─ Mail (3 unread) ─────────┬─ Merge Queue ─────────┤
│ scout → orchestrator      │ pending: 1             │
│ builder → orchestrator    │ merging: 0             │
├───────────────────────────┴────────────────────────┤
│ Metrics: 15 sessions │ Avg: 18m │ builders: 8      │
└────────────────────────────────────────────────────┘
```

---

## Watchdog and Health Monitoring

Three tiers of health monitoring provide progressive failure detection:

### Tier 0: Mechanical Daemon (`overstory watch`)

A lightweight process that polls agent health at regular intervals (default 30s):
- Checks tmux session liveness
- Checks process PID liveness
- Detects stale agents (no activity for configurable threshold)
- Marks zombie agents when tmux/process is dead but session state says "working"

Follows the **ZFC Principle (Zero Failure Crash)**: observable state (tmux alive? pid alive?) is always trusted over recorded state (sessions.db claims). When signals conflict, trust what you can observe.

### Tier 1: AI-Assisted Triage (Ephemeral)

On-demand failure classification when a stalled agent is detected:
- Reads recent agent output and error logs
- Classifies the failure type (stuck in loop, waiting for input, build failure, etc.)
- Recommends action (nudge, restart, escalate)
- Ephemeral — spawned only when needed, not a persistent process

### Tier 2: Monitor Agent (`overstory monitor start`)

A persistent Claude Code agent (without a worktree) that continuously patrols the fleet:
- Tracks health patterns over time
- Sends **progressive nudges**: warn → nudge (2x) → escalate to coordinator → critical
- Resets nudge count on agent recovery
- Monitors mail throughput and merge queue health

---

## Bridge to Claude Code Task UI

When `bridge.enabled: true` in config, Overstory projects its events into Claude Code's native Task UI by writing task JSON files to `~/.claude/tasks/{team}/`. This gives the human operator native Task panel visibility into:

- Agent spawn events → Task creation
- Worker done signals → Task completion
- Dispatch/assign events → Task ownership
- Merge results → Task status updates

The bridge is **best-effort and never blocking** — if it fails, mail delivery still succeeds. A circuit breaker auto-disables after consecutive failures. An idempotent projection log prevents duplicate projections.

---

## Requirements

- [Bun](https://bun.sh) (v1.0+)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- git
- tmux (Unix/macOS) or Git for Windows (Windows)

> **Windows users:** Overstory replaces tmux with a custom turn-runner relay daemon. See [docs/WINDOWS.md](docs/WINDOWS.md) for platform-specific architecture, setup, and troubleshooting.

Optional:
- [beads](https://github.com/jayminwest/beads) (`bd`) — issue tracking integration
- [mulch](https://github.com/jayminwest/mulch) — structured expertise management

## Installation

```bash
# Clone the repository
git clone https://github.com/jayminwest/overstory.git
cd overstory

# Install dev dependencies
bun install

# Link the CLI globally
bun link
```

## Quick Start

```bash
# 1. Initialize overstory in your project
cd your-project
overstory init

# 2. Install hooks into .claude/settings.local.json
overstory hooks install

# 3. Check your setup
overstory doctor

# 4. Start a coordinator (persistent orchestrator)
overstory coordinator start

# --- Or spawn individual agents manually ---

# Spawn a builder agent for a specific task
overstory sling <task-id> --capability builder --name my-builder

# Spawn a scout for read-only exploration
overstory sling <task-id> --capability scout --name my-scout

# Check agent status
overstory status

# Live dashboard for monitoring
overstory dashboard

# Check mail from agents
overstory mail check --inject

# Nudge a stalled agent
overstory nudge <agent-name>

# Merge completed work
overstory merge --branch <agent-branch>
# or merge all completed branches
overstory merge --all
```

---

## CLI Reference

### Core Workflow

```
overstory init                          Initialize .overstory/ in current project

overstory sling <task-id>              Spawn a worker agent
  --capability <type>                    builder | scout | reviewer | lead | merger
                                         | coordinator | supervisor | monitor
  --name <name>                          Unique agent name
  --spec <path>                          Path to task spec file
  --files <f1,f2,...>                    Exclusive file scope
  --parent <agent-name>                  Parent (for hierarchy tracking)
  --depth <n>                            Current hierarchy depth
  --json                                 JSON output

overstory prime                         Load context for orchestrator/agent
  --agent <name>                         Per-agent priming
  --compact                              Restore from checkpoint (compaction)

overstory spec write <bead-id>         Write a task spec file
  --body <content>                       Spec content (or pipe via stdin)
```

### Coordination Agents

```
overstory coordinator start             Start persistent coordinator agent
  --attach / --no-attach                 TTY-aware tmux attach (default: auto)
  --watchdog                             Auto-start watchdog daemon
  --monitor                              Auto-start Tier 2 monitor agent
overstory coordinator stop              Stop coordinator
overstory coordinator status            Show coordinator state

overstory supervisor start              Start per-project supervisor agent
  --attach / --no-attach                 TTY-aware tmux attach (default: auto)
overstory supervisor stop               Stop supervisor
overstory supervisor status             Show supervisor state
```

### Messaging

```
overstory mail send                     Send a message
  --to <agent>  --subject <text>  --body <text>
  --to @all | @builders | @scouts ...    Broadcast to group addresses
  --type <status|question|result|error>
  --type <worker_done|merge_ready|dispatch|...>  Protocol types
  --priority <low|normal|high|urgent>    (urgent/high auto-nudges recipient)
  --payload <json>                       Structured JSON payload

overstory mail check                    Check inbox (unread messages)
  --agent <name>  --inject  --json
  --debounce <ms>                        Skip if checked within window

overstory mail list                     List messages with filters
  --from <name>  --to <name>  --unread

overstory mail read <id>                Mark message as read
overstory mail reply <id> --body <text> Reply in same thread
overstory mail purge                    Delete old messages

overstory nudge <agent> [message]       Send a text nudge to an agent
  --from <name>  --force  --json
```

### Merge

```
overstory merge                         Merge agent branches
  --branch <name>                        Specific branch
  --all                                  All completed branches
  --into <branch>                        Target branch (default: session-branch > canonicalBranch)
  --dry-run                              Check for conflicts only
  --json                                 JSON output
```

### Task Groups

```
overstory group create <name> <ids...>  Create a task group for batch tracking
overstory group status [name]           Show group progress (auto-closes when done)
overstory group add <name> <ids...>     Add issues to group
overstory group remove <name> <ids...>  Remove issues from group
overstory group list                    List all groups
```

### Observability

```
overstory status                        Fleet overview (agents, worktrees, states)
  --json  --verbose

overstory dashboard                     Live TUI dashboard with auto-refresh
  --interval <ms>                        Refresh interval (default: 2000)

overstory inspect <agent>               Deep per-agent inspection
  --follow                               Polling mode
  --interval <ms>  --limit <n>  --no-tmux  --json

overstory trace <target>               Chronological event timeline
  --since <ts>  --until <ts>  --limit <n>  --json

overstory replay                        Interleaved multi-agent replay
  --run <id>  --agent <name>  --since <ts>  --until <ts>  --limit <n>  --json

overstory feed                          Unified real-time event stream
  --follow, -f  --interval <ms>  --agent <name>  --run <id>  --json

overstory logs                          Query NDJSON logs across agents
  --agent <name>  --level <level>  --since <ts>  --follow  --json

overstory errors                        Aggregated error view
  --agent <name>  --run <id>  --since <ts>  --limit <n>  --json

overstory costs                         Token/cost analysis and breakdown
  --live  --agent <name>  --run <id>  --by-capability  --last <n>  --json

overstory metrics                       Session metrics
  --last <n>  --json

overstory run list                      List orchestration runs
overstory run show <id>                 Show run details
overstory run complete                  Mark current run complete
```

### Infrastructure

```
overstory hooks install                 Install hooks to .claude/settings.local.json
  --force                                Overwrite existing
overstory hooks uninstall               Remove hooks
overstory hooks status                  Check installation

overstory agents discover               Query agents by capability/state/parent
  --capability <type>  --state <state>  --parent <name>  --json

overstory worktree list                 List worktrees with status
overstory worktree clean                Remove completed worktrees
  --completed | --all

overstory watch                         Start watchdog daemon (Tier 0)
  --interval <ms>  --background

overstory monitor start/stop/status     Manage Tier 2 monitor agent

overstory doctor                        Run 9-category health checks
  --category <name>  --verbose  --json
  Categories: dependencies, config, structure, databases,
              consistency, agents, merge, logs, version

overstory clean                         Clean up runtime state
  --all | --mail | --sessions | --metrics | --logs
  --worktrees | --branches | --agents | --specs  --json

overstory log <event>                   Log a hook event (called by hooks)

Global Flags:
  --quiet, -q                            Suppress non-error output
  --completions <shell>                  Generate shell completions (bash, zsh, fish)
```

---

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) — runs TypeScript directly, no build step
- **Dependencies**: Zero runtime dependencies — only Bun built-in APIs (`bun:sqlite`, `Bun.spawn`, `Bun.file`)
- **Database**: SQLite via `bun:sqlite` (WAL mode for concurrent multi-agent access)
- **Linting**: [Biome](https://biomejs.dev/) (formatter + linter in one tool)
- **Testing**: `bun test` (1800+ tests across 74 files, colocated with source)
- **External CLIs**: `bd` (beads), `mulch`, `git`, `tmux` — invoked as subprocesses, never as npm imports

## Development

```bash
# Run tests
bun test

# Run a single test file
bun test src/config.test.ts

# Lint + format check
biome check .

# Type check
tsc --noEmit

# All quality gates
bun test && biome check . && tsc --noEmit
```

### Versioning

Version is maintained in two places that must stay in sync:

1. `package.json` — `"version"` field
2. `src/index.ts` — `VERSION` constant

Use the bump script to update both:

```bash
bun run version:bump <major|minor|patch>
```

Git tags are created automatically by GitHub Actions when a version bump is pushed to `main`.

---

## Project Structure

```
overstory/
  src/
    index.ts                      CLI entry point (command router, 29 commands)
    types.ts                      All shared types and interfaces
    config.ts                     Config loader + defaults + validation
    errors.ts                     Custom error types (extend OverstoryError)
    platform.ts                   Cross-platform detection (IS_WINDOWS, etc.)
    commands/                     One file per CLI subcommand
      init.ts                     Project initialization
      sling.ts                    Agent spawning (14-step pipeline)
      prime.ts                    Context priming (SessionStart hook target)
      status.ts                   Fleet status overview
      dashboard.ts                Live TUI dashboard (zero-dep ANSI)
      inspect.ts                  Deep per-agent inspection
      coordinator.ts              Persistent orchestrator lifecycle
      supervisor.ts               Team lead management
      mail.ts                     Inter-agent messaging
      nudge.ts                    Agent nudging (tmux send-keys)
      merge.ts                    Branch merging with 4-tier resolution
      group.ts                    Task group batch tracking
      hooks.ts                    Hook management (install/uninstall/status)
      watch.ts                    Watchdog daemon launcher
      monitor.ts                  Tier 2 monitor management
      trace.ts                    Event timeline viewing
      replay.ts                   Multi-agent interleaved replay
      feed.ts                     Unified real-time event stream
      logs.ts                     NDJSON log query
      errors.ts                   Aggregated error view
      costs.ts                    Token/cost analysis
      metrics.ts                  Session metrics summary
      run.ts                      Orchestration run lifecycle
      agents.ts                   Agent discovery and querying
      spec.ts                     Task spec management
      doctor.ts                   Health check runner (9 modules)
      clean.ts                    Runtime state cleanup
      worktree.ts                 Worktree management
      log.ts                      Hook event logging target
      completions.ts              Shell completion generation
      bridge.ts                   Claude Code Task UI bridge
    agents/                       Agent lifecycle management
      manifest.ts                 Agent registry (load + query capabilities)
      overlay.ts                  Dynamic CLAUDE.md overlay generator
      identity.ts                 Persistent agent identity (CVs)
      hooks-deployer.ts           Deploy hooks + tool enforcement to worktrees
      lifecycle.ts                Session handoff orchestration
      checkpoint.ts               Session checkpoint save/restore
    worktree/
      manager.ts                  Git worktree create/list/remove via Bun.spawn
      tmux.ts                     Tmux session management via Bun.spawn
      session-backend.ts          Cross-platform session backend (tmux or detached process)
      win-process.ts              Windows detached process spawning
    sessions/
      store.ts                    SQLite SessionStore + RunStore
      compat.ts                   Migration bridge from sessions.json to sessions.db
    events/
      store.ts                    SQLite EventStore (tool events, timelines, errors)
      tool-filter.ts              Smart argument filtering for event storage
    mail/
      store.ts                    SQLite mail storage (WAL mode)
      client.ts                   Mail operations (send/check/list/read/reply)
      broadcast.ts                Group address resolution (@all, @builders, etc.)
    merge/
      queue.ts                    FIFO merge queue (SQLite-backed)
      resolver.ts                 4-tier conflict resolution
    bridge/
      task-bridge.ts              Projects Overstory events to CC Task UI files
      bridged-client.ts           Mail client with automatic bridge projection
    watchdog/
      daemon.ts                   Tier 0 mechanical process monitoring
      triage.ts                   Tier 1 AI-assisted failure classification
      health.ts                   ZFC health check state machine
    logging/
      logger.ts                   Multi-format logger (human + NDJSON)
      sanitizer.ts                Secret redaction
      reporter.ts                 Console reporter (ANSI colors)
      color.ts                    Central color control (NO_COLOR, --quiet)
    metrics/
      store.ts                    SQLite metrics storage
      summary.ts                  Metrics reporting
      transcript.ts               Claude Code transcript JSONL parser + cost estimation
    doctor/                       9 modular health check categories
      dependencies.ts             External tool availability
      config-check.ts             Config validation
      structure.ts                Directory structure verification
      databases.ts                SQLite database integrity
      consistency.ts              Cross-store consistency checks
      agents.ts                   Agent state validation
      merge-queue.ts              Merge queue health
      logs.ts                     Log directory structure
      version.ts                  Version consistency
    insights/
      analyzer.ts                 Session insight analyzer for auto-expertise
    beads/
      client.ts                   bd CLI wrapper (--json parsing)
      molecules.ts                Molecule management helpers
    mulch/
      client.ts                   mulch CLI wrapper
    observability/
      win-terminal.ts             Windows Terminal pane launcher
  agents/                         Base agent definitions (.md files, 8 roles)
    scout.md, builder.md, reviewer.md, lead.md,
    merger.md, coordinator.md, supervisor.md, monitor.md
  templates/
    CLAUDE.md.tmpl                Template for orchestrator CLAUDE.md
    overlay.md.tmpl               Template for per-worker overlay
    hooks.json.tmpl               Template for settings.local.json
```

### What `overstory init` Creates

```
your-project/
  .overstory/
    config.yaml                   Project configuration
    agent-manifest.json           Agent registry
    hooks.json                    Central hooks config
    current-run.txt               Active run ID
    merge-queue.db                FIFO merge queue (SQLite)
    agents/{name}/                Per-agent state
      identity.yaml               Persistent agent CV
      checkpoint.json             Session checkpoint
    worktrees/{agent-name}/       Git worktrees (gitignored)
    specs/{bead-id}.md            Task specifications
    logs/{agent-name}/{ts}/       Agent logs (gitignored)
    mail.db                       SQLite mail (gitignored)
    sessions.db                   SQLite sessions + runs (gitignored)
    events.db                     SQLite events (gitignored)
    metrics.db                    SQLite metrics (gitignored)
```

---

## License

MIT
