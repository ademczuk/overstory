/**
 * Unix session backend: delegates to tmux.ts functions.
 *
 * This is a thin adapter that wraps the existing tmux.ts exports
 * to implement the SessionBackend interface. The underlying tmux.ts
 * remains unchanged.
 */

import type { SessionBackend } from "./session-backend.ts";
import {
	createSession,
	getCurrentSessionName,
	getDescendantPids,
	getPanePid,
	isProcessAlive,
	isSessionAlive,
	killProcessTree,
	killSession,
	listSessions,
	sendKeys,
} from "./tmux.ts";

export class TmuxBackend implements SessionBackend {
	createSession = createSession;
	killSession = killSession;
	isSessionAlive = isSessionAlive;
	sendKeys = sendKeys;
	getPanePid = getPanePid;
	getDescendantPids = getDescendantPids;
	listSessions = listSessions;
	getCurrentSessionName = getCurrentSessionName;
	isProcessAlive = isProcessAlive;
	killProcessTree = killProcessTree;

	async captureOutput(name: string, lines = 30): Promise<string | null> {
		const proc = Bun.spawn(["tmux", "capture-pane", "-t", name, "-p", "-S", `-${lines}`], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) return null;
		const output = await new Response(proc.stdout).text();
		return output.trim() || null;
	}

	attachSession(name: string): void {
		Bun.spawnSync(["tmux", "attach-session", "-t", name], {
			stdio: ["inherit", "inherit", "inherit"],
		});
	}
}
