/**
 * CLI command: overstory bridge status|sync|reset
 *
 * Manages the Claude Code Task bridge, which projects Overstory protocol
 * mail events into Claude Code's native Task UI for human operator visibility.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { BridgeStore, createTaskBridge, resolveBridgeTeamName } from "../bridge/task-bridge.ts";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { getHomeDir } from "../platform.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { Capability } from "../types.ts";

/**
 * Show bridge status: team name, task count, mapping table.
 */
async function bridgeStatus(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");
	const dbPath = join(overstoryDir, "bridge.db");

	let store: BridgeStore;
	try {
		store = new BridgeStore(dbPath);
	} catch {
		if (json) {
			process.stdout.write(`${JSON.stringify({ enabled: false, reason: "no bridge.db" })}\n`);
		} else {
			process.stdout.write("Bridge is not initialized (no bridge.db)\n");
		}
		return;
	}

	try {
		const teamName = store.getTeamName();
		const tasks = store.getAll();
		const projectionStats = store.getProjectionStats();

		const status = {
			enabled: config.bridge.enabled,
			teamName: teamName ?? resolveBridgeTeamName(config.project.name, config.bridge.teamName),
			taskCount: tasks.length,
			projections: projectionStats,
			tasks: tasks.map((t) => ({
				beadId: t.bead_id,
				ccTaskId: t.cc_task_id,
				agentName: t.agent_name,
				status: t.status,
				createdAt: t.created_at,
			})),
		};

		if (json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			process.stdout.write(`Bridge: ${config.bridge.enabled ? "enabled" : "disabled"}\n`);
			process.stdout.write(`  Team:   ${status.teamName}\n`);
			process.stdout.write(`  Tasks:  ${status.taskCount}\n`);

			process.stdout.write(
				`  Projections: ${projectionStats.total} total (${projectionStats.successful} ok, ${projectionStats.failed} failed)\n`,
			);
			if (projectionStats.lastProjectedAt) {
				process.stdout.write(`  Last projected: ${projectionStats.lastProjectedAt}\n`);
			}

			if (tasks.length > 0) {
				process.stdout.write("\n  Bead → CC Task mappings:\n");
				for (const t of tasks) {
					const agent = t.agent_name ?? "unassigned";
					process.stdout.write(
						`    ${t.bead_id} → task #${t.cc_task_id} (${agent}, ${t.status})\n`,
					);
				}
			}
		}
	} finally {
		store.close();
	}
}

/**
 * One-shot sync: read all active sessions and create/update CC tasks.
 */
async function bridgeSync(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");
	const teamName = resolveBridgeTeamName(config.project.name, config.bridge.teamName);

	const bridge = createTaskBridge(overstoryDir, teamName);

	try {
		// Ensure team exists
		await bridge.createTeam({
			projectName: config.project.name,
			projectRoot: config.project.root,
		});

		// Read active sessions and create tasks for each
		const { store } = openSessionStore(overstoryDir);
		try {
			const sessions = store.getAll();
			const active = sessions.filter((s) => s.state !== "completed" && s.state !== "zombie");

			let created = 0;
			for (const session of active) {
				const existing = bridge.getStore().getByBead(session.beadId);
				if (!existing && session.beadId) {
					await bridge.onDispatch(
						{
							beadId: session.beadId,
							specPath: "",
							capability: session.capability as Capability,
							fileScope: [],
						},
						session.parentAgent ?? "orchestrator",
						session.agentName,
					);
					created++;
				}

				// Add as team member
				await bridge.addTeamMember({
					name: session.agentName,
					agentType: session.capability,
					cwd: session.worktreePath,
				});
			}

			const result = { synced: true, sessionsFound: active.length, tasksCreated: created };

			if (json) {
				process.stdout.write(`${JSON.stringify(result)}\n`);
			} else {
				process.stdout.write(
					`Bridge synced: ${active.length} active sessions, ${created} tasks created\n`,
				);
				process.stdout.write(`  Team: ${teamName}\n`);
			}
		} finally {
			store.close();
		}
	} finally {
		bridge.getStore().close();
	}
}

/**
 * Reset bridge: clear bridge.db and remove CC team directory.
 */
async function bridgeReset(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, ".overstory");
	const teamName = resolveBridgeTeamName(config.project.name, config.bridge.teamName);
	const dbPath = join(overstoryDir, "bridge.db");

	let purged = 0;

	// Clean bridge.db
	try {
		const store = new BridgeStore(dbPath);
		try {
			purged = store.purge();
		} finally {
			store.close();
		}
	} catch {
		// DB may not exist
	}

	// Remove CC team and task directories
	const claudeDir = join(getHomeDir(), ".claude");
	const teamDir = join(claudeDir, "teams", teamName);
	const taskDir = join(claudeDir, "tasks", teamName);

	try {
		await rm(teamDir, { recursive: true, force: true });
	} catch {
		// May not exist
	}
	try {
		await rm(taskDir, { recursive: true, force: true });
	} catch {
		// May not exist
	}

	if (json) {
		process.stdout.write(`${JSON.stringify({ reset: true, purged, teamName })}\n`);
	} else {
		process.stdout.write(`Bridge reset: ${purged} mappings cleared\n`);
		process.stdout.write(`  Removed: ~/.claude/teams/${teamName}/\n`);
		process.stdout.write(`  Removed: ~/.claude/tasks/${teamName}/\n`);
	}
}

const BRIDGE_HELP = `overstory bridge — Manage the Claude Code Task bridge

Usage: overstory bridge <subcommand> [flags]

Subcommands:
  status                   Show bridge state (team, task mappings)
  sync                     One-shot sync: create CC tasks for active sessions
  reset                    Clear bridge.db and remove CC team directory

General options:
  --json                   Output as JSON
  --help, -h               Show this help

The bridge projects Overstory protocol mail events (dispatch, assign,
worker_done, merge_ready, etc.) into Claude Code Task files, giving
the human operator native Task UI visibility into agent coordination.

Enable in .overstory/config.yaml:
  bridge:
    enabled: true`;

/**
 * Entry point for `overstory bridge <subcommand>`.
 */
export async function bridgeCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${BRIDGE_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "status":
			await bridgeStatus(subArgs);
			break;
		case "sync":
			await bridgeSync(subArgs);
			break;
		case "reset":
			await bridgeReset(subArgs);
			break;
		default:
			throw new ValidationError(
				`Unknown bridge subcommand: ${subcommand}. Run 'overstory bridge --help' for usage.`,
				{ field: "subcommand", value: subcommand },
			);
	}
}
