/**
 * Platform-agnostic session backend interface.
 *
 * On Unix: implemented by TmuxBackend (tmux sessions).
 * On Windows: implemented by WinProcessBackend (detached Bun.spawn + log files).
 *
 * Commands that manage agent sessions import getSessionBackend() instead
 * of importing tmux.ts directly.
 */

import { IS_WINDOWS } from "../platform.ts";

export interface SessionBackend {
	/**
	 * Create a detached agent session running the given command.
	 *
	 * @param name - Session name (e.g., "overstory-myproject-auth-login")
	 * @param cwd - Working directory for the session
	 * @param command - Command string to execute
	 * @param env - Optional environment variables
	 * @returns The PID of the process inside the session
	 */
	createSession(
		name: string,
		cwd: string,
		command: string,
		env?: Record<string, string>,
	): Promise<number>;

	/** Kill a session by name, with process tree cleanup. */
	killSession(name: string): Promise<void>;

	/** Check whether a session is still alive. */
	isSessionAlive(name: string): Promise<boolean>;

	/**
	 * Send text input to a session.
	 *
	 * On Unix: tmux send-keys.
	 * On Windows: sends a high-priority mail message instead.
	 */
	sendKeys(name: string, keys: string): Promise<void>;

	/**
	 * Capture recent output from a session.
	 *
	 * On Unix: tmux capture-pane.
	 * On Windows: tail of the stdout log file.
	 *
	 * @returns Recent output text, or null if unavailable
	 */
	captureOutput(name: string, lines?: number): Promise<string | null>;

	/** Get the PID of the process running inside the session. */
	getPanePid(name: string): Promise<number | null>;

	/** Get all descendant PIDs of a process (for tree killing). */
	getDescendantPids(pid: number): Promise<number[]>;

	/** List all active overstory sessions. */
	listSessions(): Promise<Array<{ name: string; pid: number }>>;

	/**
	 * Detect the current session name (if running inside a managed session).
	 *
	 * On Unix: checks TMUX env var and queries tmux.
	 * On Windows: checks OVERSTORY_AGENT_NAME env var.
	 */
	getCurrentSessionName(): Promise<string | null>;

	/** Check if a process is alive by PID. */
	isProcessAlive(pid: number): boolean;

	/**
	 * Kill a process tree rooted at the given PID.
	 *
	 * @param rootPid - The root PID whose descendants should be killed
	 * @param gracePeriodMs - Time to wait between SIGTERM and SIGKILL (Unix only)
	 */
	killProcessTree(rootPid: number, gracePeriodMs?: number): Promise<void>;

	/**
	 * Attach to a session interactively (blocking).
	 *
	 * On Unix: `tmux attach-session -t <name>` (inherits stdio).
	 * On Windows: tails the agent's stdout log via `Get-Content -Wait`.
	 *
	 * @param name - Session name to attach to
	 */
	attachSession(name: string): void;
}

/** Lazy singleton. */
let _backend: SessionBackend | null = null;

/**
 * Get the platform-appropriate session backend.
 * Auto-detects platform on first call. Caches the result.
 */
export function getSessionBackend(): SessionBackend {
	if (_backend) return _backend;

	if (IS_WINDOWS) {
		// Dynamic import to avoid loading Windows code on Unix
		const { WinProcessBackend } = require("./win-process.ts");
		_backend = new WinProcessBackend() as SessionBackend;
	} else {
		const { TmuxBackend } = require("./tmux-backend.ts");
		_backend = new TmuxBackend() as SessionBackend;
	}
	return _backend;
}

/**
 * Override the session backend (for testing).
 */
export function setSessionBackend(backend: SessionBackend | null): void {
	_backend = backend;
}
