/**
 * Windows Terminal pane launcher for visual agent monitoring.
 *
 * Detects wt.exe availability and launches split panes per agent,
 * each tailing the agent's stdout.log via PowerShell Get-Content -Wait.
 *
 * Fire-and-forget: opens panes, user watches manually.
 * Graceful fallback: if wt not found, prints manual tail commands.
 */

import { join } from "node:path";
import { IS_WINDOWS } from "../platform.ts";
import type { AgentSession } from "../types.ts";

/**
 * Check if Windows Terminal (wt.exe) is available.
 */
async function isWtAvailable(): Promise<boolean> {
	if (!IS_WINDOWS) return false;
	try {
		const proc = Bun.spawn(["where", "wt"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		return exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Build the wt.exe command line for launching split panes per agent.
 *
 * Layout: first agent gets a new tab, each subsequent agent splits the
 * existing pane vertically (alternating horizontal for balance).
 */
function buildWtCommand(agents: Array<{ name: string; logPath: string }>, title: string): string[] {
	if (agents.length === 0) return [];

	const args: string[] = ["wt", "--title", title];

	for (let i = 0; i < agents.length; i++) {
		const agent = agents[i];
		if (!agent) continue;

		// PowerShell command to tail the log file
		const tailCmd = `Get-Content -Path '${agent.logPath}' -Wait -Tail 50`;
		const pwshArgs = ["pwsh", "-NoProfile", "-Command", tailCmd];

		if (i === 0) {
			// First agent: new tab
			args.push("new-tab", "--title", agent.name, ...pwshArgs);
		} else {
			// Subsequent agents: split pane (alternate vertical/horizontal for balance)
			const splitDir = i % 2 === 1 ? "--vertical" : "--horizontal";
			args.push(";", "split-pane", splitDir, "--title", agent.name, ...pwshArgs);
		}
	}

	return args;
}

/**
 * Launch Windows Terminal panes for monitoring active agents.
 *
 * Each pane tails the agent's stdout.log file using PowerShell's
 * Get-Content -Wait (the Windows equivalent of `tail -f`).
 *
 * @param agents - Active agent sessions
 * @param overstoryDir - Path to .overstory/ directory
 * @returns true if WT was launched, false if fallback was printed
 */
export async function launchAgentPanes(
	agents: AgentSession[],
	overstoryDir: string,
): Promise<boolean> {
	if (!IS_WINDOWS) {
		process.stdout.write("--launch-terminals is only supported on Windows\n");
		return false;
	}

	if (agents.length === 0) {
		process.stdout.write("No active agents to monitor\n");
		return false;
	}

	// Build agent list with log paths
	const agentInfos = agents.map((a) => ({
		name: a.agentName,
		logPath: join(overstoryDir, "logs", a.agentName, "stdout.log"),
	}));

	const wtAvailable = await isWtAvailable();

	if (wtAvailable) {
		const args = buildWtCommand(agentInfos, "Overstory Agent Monitor");

		try {
			const proc = Bun.spawn(args, {
				stdout: "pipe",
				stderr: "pipe",
			});
			// Fire-and-forget — don't wait for WT to close
			void proc.exited;
			process.stdout.write(
				`Launched Windows Terminal with ${agents.length} pane${agents.length === 1 ? "" : "s"}\n`,
			);
			return true;
		} catch {
			process.stdout.write("Failed to launch Windows Terminal\n");
		}
	}

	// Fallback: print manual commands
	process.stdout.write(
		"Windows Terminal (wt.exe) not found. Use these commands to tail agent logs:\n\n",
	);
	for (const info of agentInfos) {
		process.stdout.write(`  pwsh -Command "Get-Content -Path '${info.logPath}' -Wait -Tail 50"\n`);
	}
	process.stdout.write("\n");
	return false;
}
