/**
 * Windows session backend: detached processes with PID tracking.
 *
 * Replaces tmux on Windows by:
 * - Spawning Claude Code via Bun.spawn with stdout/stderr to log files
 * - Tracking sessions in a SQLite table (win_sessions)
 * - Using taskkill /F /T for process tree cleanup
 * - Falling back to the mail system for sendKeys (agents already poll mail)
 * - Reading stdout log files for captureOutput
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
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

		// Use Bun.file() handles as spawn stdout/stderr targets
		const stdoutFile = Bun.file(stdoutPath);
		const stderrFile = Bun.file(stderrPath);

		// Resolve overstory binary path for PATH injection
		const overstoryBinDir = await this.detectBinDir();

		// Build environment with PATH augmentation
		const spawnEnv: Record<string, string | undefined> = {
			...process.env,
			...env,
		};
		if (overstoryBinDir) {
			const existingPath = process.env.PATH ?? "";
			spawnEnv.PATH = `${overstoryBinDir};${existingPath}`;
		}

		// Parse command string into args array
		// Claude Code command format: "claude --model <model> --dangerously-skip-permissions"
		const args = command.split(/\s+/).filter((s) => s.length > 0);

		const proc = Bun.spawn(args, {
			cwd,
			stdout: stdoutFile,
			stderr: stderrFile,
			env: spawnEnv,
			// On Windows, stdin must be provided for the process to not inherit
			stdin: "ignore",
		});

		const pid = proc.pid;

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
		// On Windows, there is no tmux to send keys to.
		// For empty keys (the "follow-up Enter" pattern), this is a no-op.
		if (keys.trim().length === 0) return;

		// For non-empty keys (nudge messages), send via the mail system.
		// Agents poll mail on every hook invocation (UserPromptSubmit, PostToolUse).
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
