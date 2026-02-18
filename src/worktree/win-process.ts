/**
 * Windows session backend: detached processes with PID tracking.
 *
 * Replaces tmux on Windows by:
 * - Spawning Claude Code via a turn-runner relay daemon (win-relay.ts)
 *   that runs each turn as a separate `claude -p` process with
 *   `--resume <session_id>` for conversation continuity
 * - Using stdin pipe for NDJSON user messages (replaces tmux send-keys)
 * - Tracking sessions in a SQLite table (win_sessions)
 * - Using taskkill /F /T for process tree cleanup
 * - Falling back to the mail system for sendKeys when the in-process handle is unavailable
 * - Reading stdout log files for captureOutput
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { whichCommand } from "../platform.ts";
import type { SessionBackend } from "./session-backend.ts";

/** Row shape for win_sessions table. */
interface WinSessionRow {
	name: string;
	pid: number;
	stdout_path: string;
	stderr_path: string;
	cwd: string;
	started_at: string;
}

const CREATE_WIN_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS win_sessions (
  name TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  stdout_path TEXT NOT NULL,
  stderr_path TEXT NOT NULL,
  cwd TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/**
 * Get or create the win_sessions database.
 * Reuses the .overstory directory's sessions.db but in a separate table.
 */
function openWinSessionsDb(overstoryDir: string): Database {
	const dbPath = join(overstoryDir, "sessions.db");
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA busy_timeout=5000");
	db.exec(CREATE_WIN_SESSIONS_TABLE);
	return db;
}

/**
 * Detect the .overstory directory from environment or cwd.
 * Agents have OVERSTORY_PROJECT_ROOT set; orchestrator uses cwd.
 */
function findOverstoryDir(): string {
	const projectRoot = process.env.OVERSTORY_PROJECT_ROOT ?? process.cwd();
	return join(projectRoot, ".overstory");
}

/**
 * In-memory handle to a spawned process's stdin.
 * Needed because Bun.spawn stdin pipes can't be reopened from PID alone.
 * Falls back to mail-based sendKeys when the handle is unavailable
 * (e.g., process spawned by a different overstory invocation).
 */
const stdinHandles = new Map<string, { stdin: WritableStream<Uint8Array>; pid: number }>();

/**
 * In-memory map of session name -> inbox NDJSON file path.
 * Used by sendKeys() to write messages that the relay daemon forwards to stdin.
 * Works across process boundaries (unlike stdinHandles).
 */
const inboxPaths = new Map<string, string>();

/**
 * Parse a shell command string into an arguments array, respecting quotes.
 *
 * Handles single quotes (including the '\'' escape idiom used by coordinator.ts
 * for --append-system-prompt), double quotes, and backslash escaping.
 *
 * Examples:
 *   "claude --model opus" => ["claude", "--model", "opus"]
 *   "claude --flag 'hello world'" => ["claude", "--flag", "hello world"]
 *   "claude --text 'it'\\''s here'" => ["claude", "--text", "it's here"]
 */
function parseShellCommand(command: string): string[] {
	const args: string[] = [];
	let current = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let i = 0;

	while (i < command.length) {
		const ch = command.charAt(i);

		if (inSingleQuote) {
			if (ch === "'") {
				// Check for the '\'' idiom (end quote, escaped quote, start quote)
				if (command[i + 1] === "\\" && command[i + 2] === "'" && command[i + 3] === "'") {
					current += "'";
					i += 4;
					continue;
				}
				inSingleQuote = false;
				i++;
				continue;
			}
			current += ch;
			i++;
			continue;
		}

		if (inDoubleQuote) {
			if (ch === "\\") {
				const next = command[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					current += next;
					i += 2;
					continue;
				}
			}
			if (ch === '"') {
				inDoubleQuote = false;
				i++;
				continue;
			}
			current += ch;
			i++;
			continue;
		}

		// Outside quotes
		if (ch === "'") {
			inSingleQuote = true;
			i++;
			continue;
		}
		if (ch === '"') {
			inDoubleQuote = true;
			i++;
			continue;
		}
		if (ch === "\\") {
			const next = command[i + 1];
			if (next !== undefined) {
				current += next;
				i += 2;
				continue;
			}
		}
		if (/\s/.test(ch)) {
			if (current.length > 0) {
				args.push(current);
				current = "";
			}
			i++;
			continue;
		}
		current += ch;
		i++;
	}

	if (current.length > 0) {
		args.push(current);
	}

	return args;
}

/**
 * Format a user message as a stream-json NDJSON line for Claude Code stdin.
 *
 * Stream-json is Claude Code's purpose-built protocol for programmatic
 * multi-turn conversations over pipes (no TTY needed).
 */
function formatStreamJsonUserMessage(text: string): string {
	return JSON.stringify({
		type: "user",
		session_id: "",
		message: {
			role: "user",
			content: [{ type: "text", text }],
		},
		parent_tool_use_id: null,
	});
}

export class WinProcessBackend implements SessionBackend {
	async createSession(
		name: string,
		cwd: string,
		command: string,
		env?: Record<string, string>,
	): Promise<number> {
		const overstoryDir = findOverstoryDir();

		// Create log directory for this agent
		const logDir = join(overstoryDir, "logs", name);
		await mkdir(logDir, { recursive: true });

		const stdoutPath = join(logDir, "stdout.log");
		const stderrPath = join(logDir, "stderr.log");
		// Clear old log files from previous session
		await Bun.write(stdoutPath, "");
		await Bun.write(stderrPath, "");

		// Resolve overstory binary path for PATH injection
		const overstoryBinDir = await this.detectBinDir();

		// Build environment with PATH augmentation.
		// Unset CLAUDECODE so nested Claude Code sessions don't refuse to start
		// (Claude Code rejects launch when it detects it's inside another session).
		const spawnEnv: Record<string, string | undefined> = {
			...process.env,
			...env,
			CLAUDECODE: undefined,
		};
		if (overstoryBinDir) {
			const existingPath = process.env.PATH ?? "";
			spawnEnv.PATH = `${overstoryBinDir};${existingPath}`;
		}

		// Parse command string into args array, respecting shell quoting
		// (handles single-quoted --append-system-prompt content from coordinator.ts)
		const args = parseShellCommand(command);

		// Stream-json flags are injected by the relay daemon (win-relay.ts),
		// NOT here. The relay manages turn lifecycle: first turn uses the
		// original args + -p + stream-json, subsequent turns use --resume.
		// We pass the raw args to the relay which handles flag injection.

		// Spawn via the relay daemon so that sendKeys() works across process
		// boundaries. The relay holds Claude Code's stdin pipe and polls an
		// inbox NDJSON file for new messages to forward.
		const inboxPath = join(logDir, "inbox.ndjson");
		// Clear stale inbox from previous session (prevents replaying old messages)
		await Bun.write(inboxPath, "");
		// import.meta.dir is Bun-specific: returns the proper filesystem directory
		// path without the leading-slash issue that URL.pathname has on Windows.
		const relayScript = join(import.meta.dir, "win-relay.ts");

		// Build env as string pairs for the relay (filter out undefined values)
		const cleanEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(spawnEnv)) {
			if (v !== undefined) cleanEnv[k] = v;
		}

		const relayArgs = [
			"bun",
			"run",
			relayScript,
			inboxPath,
			stdoutPath,
			stderrPath,
			cwd,
			"--",
			...args,
		];

		// Log relay errors to a dedicated file for debugging
		const relayLogPath = join(logDir, "relay.log");
		const relayProc = Bun.spawn(relayArgs, {
			cwd,
			stdin: "ignore",
			stdout: "ignore",
			stderr: Bun.file(relayLogPath),
			env: cleanEnv,
		});

		// Wait briefly for relay to write Claude Code's PID
		await Bun.sleep(1_500);
		const pidFile = Bun.file(`${inboxPath}.pid`);
		let pid: number;
		if (await pidFile.exists()) {
			const pidText = await pidFile.text();
			pid = Number.parseInt(pidText.trim(), 10);
			if (Number.isNaN(pid)) pid = relayProc.pid;
		} else {
			// Relay hasn't written PID yet — use relay PID as fallback
			pid = relayProc.pid;
		}

		// Store inbox path so sendKeys() can write to it from any process
		inboxPaths.set(name, inboxPath);

		// Register in SQLite
		const db = openWinSessionsDb(overstoryDir);
		try {
			const stmt = db.prepare(
				"INSERT OR REPLACE INTO win_sessions (name, pid, stdout_path, stderr_path, cwd, started_at) VALUES (?, ?, ?, ?, ?, ?)",
			);
			stmt.run(name, pid, stdoutPath, stderrPath, cwd, new Date().toISOString());
		} finally {
			db.close();
		}

		return pid;
	}

	async killSession(name: string): Promise<void> {
		const overstoryDir = findOverstoryDir();
		const db = openWinSessionsDb(overstoryDir);

		let row: WinSessionRow | null = null;
		try {
			row = db
				.prepare("SELECT * FROM win_sessions WHERE name = ?")
				.get(name) as WinSessionRow | null;
		} finally {
			db.close();
		}

		if (!row) {
			return; // Session not found, nothing to kill
		}

		// Clean up stdin handle
		stdinHandles.delete(name);

		// taskkill /F /T kills the entire process tree in one call
		await this.killProcessTree(row.pid);

		// Remove from registry
		const db2 = openWinSessionsDb(overstoryDir);
		try {
			db2.prepare("DELETE FROM win_sessions WHERE name = ?").run(name);
		} finally {
			db2.close();
		}
	}

	async isSessionAlive(name: string): Promise<boolean> {
		const overstoryDir = findOverstoryDir();
		const db = openWinSessionsDb(overstoryDir);

		let row: WinSessionRow | null = null;
		try {
			row = db
				.prepare("SELECT * FROM win_sessions WHERE name = ?")
				.get(name) as WinSessionRow | null;
		} finally {
			db.close();
		}

		if (!row) return false;
		return this.isProcessAlive(row.pid);
	}

	async sendKeys(name: string, keys: string): Promise<void> {
		// In stream-json mode, empty keys (the "follow-up Enter" pattern) are
		// a no-op — there's no TUI input line to submit.
		if (keys.trim().length === 0) return;

		// Primary: write to the inbox NDJSON file for the relay daemon.
		// Works across process boundaries (any CLI invocation can send messages).
		const inbox = inboxPaths.get(name) ?? this.resolveInboxPath(name);
		if (inbox) {
			try {
				const ndjsonLine = formatStreamJsonUserMessage(keys);
				await appendFile(inbox, `${ndjsonLine}\n`);
				return;
			} catch {
				// Inbox write failed — fall through to mail
			}
		}

		// Secondary: in-process stdin handle (same process that spawned the session)
		const handle = stdinHandles.get(name);
		if (handle && this.isProcessAlive(handle.pid)) {
			try {
				const ndjsonLine = formatStreamJsonUserMessage(keys);
				const data = new TextEncoder().encode(`${ndjsonLine}\n`);
				const writer = (handle.stdin as unknown as { write(data: Uint8Array): number }).write;
				if (typeof writer === "function") {
					writer.call(handle.stdin, data);
				} else {
					const writable = handle.stdin.getWriter();
					await writable.write(data);
					writable.releaseLock();
				}
				return;
			} catch {
				stdinHandles.delete(name);
			}
		}

		// Fallback: no stdin handle or inbox available.

		// Send via the mail system — agents poll mail on every hook invocation.
		const overstoryDir = findOverstoryDir();
		const mailDbPath = join(overstoryDir, "mail.db");

		// Extract agent name from session name (format: overstory-{project}-{agentName})
		const parts = name.split("-");
		// Agent name is everything after the second hyphen
		const agentName = parts.length >= 3 ? parts.slice(2).join("-") : name;

		try {
			const store = createMailStore(mailDbPath);
			try {
				const client = createMailClient(store);
				client.send({
					from: "orchestrator",
					to: agentName,
					subject: "Nudge",
					body: keys,
					type: "status",
					priority: "high",
				});
			} finally {
				store.close();
			}
		} catch {
			// Mail system may not be initialized yet — silently ignore
		}
	}

	async captureOutput(name: string, lines = 30): Promise<string | null> {
		const overstoryDir = findOverstoryDir();
		const db = openWinSessionsDb(overstoryDir);

		let row: WinSessionRow | null = null;
		try {
			row = db
				.prepare("SELECT * FROM win_sessions WHERE name = ?")
				.get(name) as WinSessionRow | null;
		} finally {
			db.close();
		}

		if (!row) return null;

		try {
			const file = Bun.file(row.stdout_path);
			if (!(await file.exists())) return null;

			const text = await file.text();
			if (text.length === 0) return null;

			// Return last N lines
			const allLines = text.split("\n");
			const tail = allLines.slice(-lines);
			return tail.join("\n").trim() || null;
		} catch {
			return null;
		}
	}

	async getPanePid(name: string): Promise<number | null> {
		const overstoryDir = findOverstoryDir();
		const db = openWinSessionsDb(overstoryDir);

		try {
			const row = db.prepare("SELECT pid FROM win_sessions WHERE name = ?").get(name) as {
				pid: number;
			} | null;
			return row?.pid ?? null;
		} finally {
			db.close();
		}
	}

	async getDescendantPids(pid: number): Promise<number[]> {
		// Use wmic to find child processes recursively
		try {
			const proc = Bun.spawn(
				["wmic", "process", "where", `(ParentProcessId=${pid})`, "get", "ProcessId", "/format:csv"],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const exitCode = await proc.exited;
			if (exitCode !== 0) return [];

			const output = await new Response(proc.stdout).text();
			const childPids: number[] = [];

			for (const line of output.trim().split("\n")) {
				// CSV format: Node,ProcessId — skip header
				const parts = line.trim().split(",");
				const pidStr = parts[parts.length - 1];
				if (pidStr) {
					const childPid = Number.parseInt(pidStr.trim(), 10);
					if (!Number.isNaN(childPid) && childPid !== 0) {
						childPids.push(childPid);
					}
				}
			}

			// Recurse into each child (depth-first)
			const allDescendants: number[] = [];
			for (const childPid of childPids) {
				const grandchildren = await this.getDescendantPids(childPid);
				allDescendants.push(...grandchildren);
			}
			allDescendants.push(...childPids);
			return allDescendants;
		} catch {
			return [];
		}
	}

	async listSessions(): Promise<Array<{ name: string; pid: number }>> {
		const overstoryDir = findOverstoryDir();

		let db: Database;
		try {
			db = openWinSessionsDb(overstoryDir);
		} catch {
			return []; // DB may not exist yet
		}

		try {
			const rows = db.prepare("SELECT name, pid FROM win_sessions").all() as Array<{
				name: string;
				pid: number;
			}>;

			// Filter to only alive processes
			const alive: Array<{ name: string; pid: number }> = [];
			const dead: string[] = [];

			for (const row of rows) {
				if (this.isProcessAlive(row.pid)) {
					alive.push(row);
				} else {
					dead.push(row.name);
				}
			}

			// Clean up dead sessions
			if (dead.length > 0) {
				const placeholders = dead.map(() => "?").join(",");
				db.prepare(`DELETE FROM win_sessions WHERE name IN (${placeholders})`).run(...dead);
			}

			return alive;
		} finally {
			db.close();
		}
	}

	async getCurrentSessionName(): Promise<string | null> {
		// On Windows, agents have OVERSTORY_AGENT_NAME set in their environment.
		// The orchestrator doesn't run inside a managed session.
		return process.env.OVERSTORY_AGENT_NAME ?? null;
	}

	isProcessAlive(pid: number): boolean {
		try {
			// signal 0 checks process existence without sending a signal
			// Works on Windows in Bun/Node.js
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Resolve the inbox NDJSON file path for a session.
	 * Works even when called from a different process (no in-memory state needed).
	 *
	 * The log directory name is the full session name (e.g., "overstory-myproject-coordinator"),
	 * but callers often pass just the agent name ("coordinator"). We check the SQLite
	 * registry first, then try a glob pattern as fallback.
	 */
	private resolveInboxPath(name: string): string | null {
		const overstoryDir = findOverstoryDir();

		// Direct match first (caller passed the full session name)
		const directPath = join(overstoryDir, "logs", name, "inbox.ndjson");
		if (existsSync(directPath)) return directPath;

		// Query SQLite for sessions whose name contains the agent name
		try {
			const db = openWinSessionsDb(overstoryDir);
			try {
				const row = db
					.prepare(
						"SELECT name FROM win_sessions WHERE name LIKE ? ORDER BY started_at DESC LIMIT 1",
					)
					.get(`%${name}%`) as { name: string } | null;
				if (row) {
					const dbPath = join(overstoryDir, "logs", row.name, "inbox.ndjson");
					if (existsSync(dbPath)) return dbPath;
				}
			} finally {
				db.close();
			}
		} catch {
			// DB may not exist yet
		}

		// Glob fallback: find a directory matching *-{name}
		try {
			const logsDir = join(overstoryDir, "logs");
			const entries = readdirSync(logsDir);
			for (const entry of entries) {
				if (entry.endsWith(`-${name}`)) {
					const globPath = join(logsDir, entry, "inbox.ndjson");
					if (existsSync(globPath)) return globPath;
				}
			}
		} catch {
			// logs dir may not exist
		}

		return null;
	}

	async killProcessTree(rootPid: number, _gracePeriodMs?: number): Promise<void> {
		// taskkill /F /T /PID kills the entire tree in one call
		// /F = force, /T = tree (all children), /PID = target process
		try {
			const proc = Bun.spawn(["taskkill", "/F", "/T", "/PID", String(rootPid)], {
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;
			// Exit code doesn't matter — process may already be dead
		} catch {
			// taskkill may fail if process is already gone
		}
	}

	attachSession(name: string): void {
		const overstoryDir = findOverstoryDir();
		const db = openWinSessionsDb(overstoryDir);

		let row: WinSessionRow | null = null;
		try {
			row = db
				.prepare("SELECT * FROM win_sessions WHERE name = ?")
				.get(name) as WinSessionRow | null;
		} finally {
			db.close();
		}

		if (!row) {
			process.stderr.write(`Session "${name}" not found\n`);
			return;
		}

		// Tail the stdout log interactively (Ctrl+C to detach).
		// PowerShell's Get-Content -Wait is the Windows equivalent of `tail -f`.
		process.stdout.write(`Attaching to ${name} (tailing ${row.stdout_path})...\n`);
		process.stdout.write("Press Ctrl+C to detach.\n\n");
		Bun.spawnSync(
			["powershell", "-NoProfile", "-Command", `Get-Content -Wait -Tail 50 "${row.stdout_path}"`],
			{
				stdio: ["inherit", "inherit", "inherit"],
			},
		);
	}

	/** Detect the directory containing the overstory binary. */
	private async detectBinDir(): Promise<string | null> {
		try {
			const proc = Bun.spawn([whichCommand(), "overstory"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode === 0) {
				const output = await new Response(proc.stdout).text();
				// `where` on Windows may return multiple lines; take the first
				const binPath = output.trim().split("\n")[0]?.trim();
				if (binPath && binPath.length > 0) {
					return dirname(resolve(binPath));
				}
			}
		} catch {
			// Binary not found on PATH
		}

		const scriptPath = process.argv[1];
		if (scriptPath?.includes("overstory")) {
			const bunPath = process.argv[0];
			if (bunPath) {
				return dirname(resolve(bunPath));
			}
		}

		return null;
	}
}
