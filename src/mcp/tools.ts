/**
 * MCP tool definitions and handlers for Overstory.
 *
 * Each tool calls existing store/client modules directly — no CLI subprocess.
 * Handlers return McpToolResult with JSON-stringified data in text content.
 *
 * Tool selection follows the consensus: expose ~10 tools covering the operations
 * Claude Code would naturally invoke during a coding conversation. Interactive/
 * streaming commands (dashboard, feed, replay) stay CLI-only.
 */

import { join } from "node:path";
import { gatherStatus } from "../commands/status.ts";
import { loadConfig } from "../config.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import type { OverstoryConfig } from "../types.ts";
import { listWorktrees } from "../worktree/manager.ts";
import type { McpToolDefinition, McpToolResult, ToolHandler } from "./server.ts";

/** Cached config to avoid re-resolving project root on every call. */
let cachedConfig: OverstoryConfig | null = null;
let cachedProjectRoot: string | null = null;

async function _getConfig(projectRoot: string): Promise<OverstoryConfig> {
	if (cachedConfig && cachedProjectRoot === projectRoot) {
		return cachedConfig;
	}
	cachedConfig = await loadConfig(projectRoot);
	cachedProjectRoot = projectRoot;
	return cachedConfig;
}

function overstoryDir(root: string): string {
	return join(root, ".overstory");
}

function jsonResult(data: unknown): McpToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function textResult(text: string): McpToolResult {
	return { content: [{ type: "text", text }] };
}

function errorResult(message: string): McpToolResult {
	return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
	{
		name: "overstory_status",
		description:
			"Get the status of all Overstory agents, worktrees, unread mail count, and merge queue depth. Use this to understand what agents are active and what state the fleet is in.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: {
					type: "string",
					description: "Absolute path to the target project root. Required.",
				},
				agent_name: {
					type: "string",
					description: "Whose perspective for unread mail count (default: orchestrator).",
				},
				verbose: {
					type: "boolean",
					description: "Include extra per-agent detail (worktree path, logs dir, last mail).",
				},
			},
			required: ["project_root"],
		},
	},
	{
		name: "overstory_mail_send",
		description:
			"Send a mail message to an agent. Used for inter-agent coordination and task assignment.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: "Absolute path to project root." },
				from: { type: "string", description: "Sender agent name." },
				to: { type: "string", description: "Recipient agent name." },
				subject: { type: "string", description: "Message subject line." },
				body: { type: "string", description: "Message body." },
				type: {
					type: "string",
					description: "Message type: status, question, result, error, or protocol types.",
					enum: [
						"status",
						"question",
						"result",
						"error",
						"worker_done",
						"merge_ready",
						"merged",
						"merge_failed",
						"escalation",
						"health_check",
						"dispatch",
						"assign",
					],
				},
				priority: {
					type: "string",
					description: "Message priority.",
					enum: ["low", "normal", "high", "urgent"],
				},
				payload: {
					type: "string",
					description: "Optional JSON payload string for protocol messages.",
				},
			},
			required: ["project_root", "from", "to", "subject", "body"],
		},
	},
	{
		name: "overstory_mail_check",
		description:
			"Check inbox for unread messages. Marks them as read and returns the messages. Use to see what agents have reported.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: "Absolute path to project root." },
				agent_name: {
					type: "string",
					description: "Which agent's inbox to check (default: orchestrator).",
				},
			},
			required: ["project_root"],
		},
	},
	{
		name: "overstory_mail_list",
		description: "List mail messages with optional filters. Does NOT mark messages as read.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: "Absolute path to project root." },
				from: { type: "string", description: "Filter by sender." },
				to: { type: "string", description: "Filter by recipient." },
				unread: { type: "boolean", description: "Only unread messages." },
			},
			required: ["project_root"],
		},
	},
	{
		name: "overstory_sling",
		description:
			"Spawn a new worker agent in a git worktree. Creates the worktree, branch, overlay CLAUDE.md, and tmux/process session. Returns agent details.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: "Absolute path to project root." },
				task_id: { type: "string", description: "Bead task ID for the agent to work on." },
				capability: {
					type: "string",
					description: "Agent type to spawn.",
					enum: ["scout", "builder", "reviewer", "lead", "merger"],
				},
				name: { type: "string", description: "Unique agent name." },
				spec: { type: "string", description: "Path to task spec file." },
				files: {
					type: "string",
					description: "Comma-separated exclusive file scope.",
				},
				parent: { type: "string", description: "Parent agent name (for hierarchy)." },
				depth: { type: "number", description: "Current hierarchy depth (default: 0)." },
			},
			required: ["project_root", "task_id", "capability", "name"],
		},
	},
	{
		name: "overstory_merge",
		description:
			"Merge an agent's branch into the canonical branch. Supports dry-run to preview conflicts.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: "Absolute path to project root." },
				branch: { type: "string", description: "Specific branch to merge." },
				all: {
					type: "boolean",
					description: "Merge all completed agent branches.",
				},
				into: {
					type: "string",
					description: "Target branch (default: session-branch.txt or canonicalBranch).",
				},
				dry_run: {
					type: "boolean",
					description: "Check for conflicts without actually merging.",
				},
			},
			required: ["project_root"],
		},
	},
	{
		name: "overstory_inspect",
		description:
			"Deep inspection of a single agent: session state, recent tool calls, tmux pane capture, mail history.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: "Absolute path to project root." },
				agent_name: { type: "string", description: "Agent to inspect." },
				limit: {
					type: "number",
					description: "Recent tool calls to include (default: 20).",
				},
			},
			required: ["project_root", "agent_name"],
		},
	},
	{
		name: "overstory_worktree_list",
		description:
			"List all git worktrees with their branch and HEAD commit. Shows what parallel work exists.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: "Absolute path to project root." },
			},
			required: ["project_root"],
		},
	},
	{
		name: "overstory_metrics",
		description: "Get session metrics and token/cost analysis. Combines metrics and costs data.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: "Absolute path to project root." },
				agent_name: { type: "string", description: "Filter by agent name." },
				last: { type: "number", description: "Number of recent sessions (default: 20)." },
			},
			required: ["project_root"],
		},
	},
	{
		name: "overstory_doctor",
		description:
			"Run health checks on the Overstory setup. Returns pass/fail results for dependencies, config, databases, agents, etc.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: "Absolute path to project root." },
				category: {
					type: "string",
					description: "Run only this check category.",
					enum: [
						"dependencies",
						"config",
						"structure",
						"databases",
						"consistency",
						"agents",
						"merge",
						"logs",
						"version",
					],
				},
			},
			required: ["project_root"],
		},
	},
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleStatus(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = args.project_root as string;
	const agentName = (args.agent_name as string | undefined) ?? "orchestrator";
	const verbose = (args.verbose as boolean | undefined) ?? false;

	const data = await gatherStatus(root, agentName, verbose);
	return jsonResult(data);
}

async function handleMailSend(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = args.project_root as string;
	const dbPath = join(overstoryDir(root), "mail.db");
	const store = createMailStore(dbPath);

	try {
		const client = createMailClient(store);
		const id = client.send({
			from: args.from as string,
			to: args.to as string,
			subject: args.subject as string,
			body: args.body as string,
			type: args.type as string | undefined as
				| "status"
				| "question"
				| "result"
				| "error"
				| undefined,
			priority: args.priority as string | undefined as
				| "low"
				| "normal"
				| "high"
				| "urgent"
				| undefined,
			payload: args.payload as string | undefined,
		});
		return jsonResult({ id, sent: true });
	} finally {
		store.close();
	}
}

async function handleMailCheck(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = args.project_root as string;
	const agentName = (args.agent_name as string | undefined) ?? "orchestrator";
	const dbPath = join(overstoryDir(root), "mail.db");
	const store = createMailStore(dbPath);

	try {
		const client = createMailClient(store);
		const messages = client.check(agentName);
		return jsonResult({ count: messages.length, messages });
	} finally {
		store.close();
	}
}

async function handleMailList(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = args.project_root as string;
	const dbPath = join(overstoryDir(root), "mail.db");
	const store = createMailStore(dbPath);

	try {
		const client = createMailClient(store);
		const messages = client.list({
			from: args.from as string | undefined,
			to: args.to as string | undefined,
			unread: args.unread as boolean | undefined,
		});
		return jsonResult({ count: messages.length, messages });
	} finally {
		store.close();
	}
}

async function handleSling(args: Record<string, unknown>): Promise<McpToolResult> {
	// Sling has complex side effects (worktree creation, tmux spawn, stagger delay).
	// Shell out to CLI for reliability rather than duplicating the logic.
	const root = args.project_root as string;
	const cliArgs = [
		"run",
		join(import.meta.dir, "..", "index.ts"),
		"sling",
		args.task_id as string,
		"--capability",
		args.capability as string,
		"--name",
		args.name as string,
		"--json",
	];

	if (args.spec) cliArgs.push("--spec", args.spec as string);
	if (args.files) cliArgs.push("--files", args.files as string);
	if (args.parent) cliArgs.push("--parent", args.parent as string);
	if (args.depth !== undefined) cliArgs.push("--depth", String(args.depth));

	const proc = Bun.spawn(["bun", ...cliArgs], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		return errorResult(`sling failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
	}

	try {
		return jsonResult(JSON.parse(stdout.trim()));
	} catch {
		return textResult(stdout.trim());
	}
}

async function handleMerge(args: Record<string, unknown>): Promise<McpToolResult> {
	// Merge also has complex side effects — shell out to CLI.
	const root = args.project_root as string;
	const cliArgs = ["run", join(import.meta.dir, "..", "index.ts"), "merge", "--json"];

	if (args.branch) cliArgs.push("--branch", args.branch as string);
	if (args.all) cliArgs.push("--all");
	if (args.into) cliArgs.push("--into", args.into as string);
	if (args.dry_run) cliArgs.push("--dry-run");

	const proc = Bun.spawn(["bun", ...cliArgs], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		return errorResult(`merge failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
	}

	try {
		return jsonResult(JSON.parse(stdout.trim()));
	} catch {
		return textResult(stdout.trim());
	}
}

async function handleInspect(args: Record<string, unknown>): Promise<McpToolResult> {
	// Inspect aggregates data from multiple stores — shell out for simplicity.
	const root = args.project_root as string;
	const cliArgs = [
		"run",
		join(import.meta.dir, "..", "index.ts"),
		"inspect",
		args.agent_name as string,
		"--json",
	];

	if (args.limit !== undefined) cliArgs.push("--limit", String(args.limit));
	cliArgs.push("--no-tmux"); // Skip tmux capture-pane in MCP context

	const proc = Bun.spawn(["bun", ...cliArgs], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		return errorResult(`inspect failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
	}

	try {
		return jsonResult(JSON.parse(stdout.trim()));
	} catch {
		return textResult(stdout.trim());
	}
}

async function handleWorktreeList(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = args.project_root as string;
	const worktrees = await listWorktrees(root);
	return jsonResult({ count: worktrees.length, worktrees });
}

async function handleMetrics(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = args.project_root as string;
	const oDir = overstoryDir(root);

	// Gather metrics from the metrics store
	const metricsDbPath = join(oDir, "metrics.db");
	const metricsFile = Bun.file(metricsDbPath);
	if (!(await metricsFile.exists())) {
		return jsonResult({ metrics: [], message: "No metrics database found." });
	}

	const store = createMetricsStore(metricsDbPath);
	try {
		const last = (args.last as number | undefined) ?? 20;
		const agentName = args.agent_name as string | undefined;

		const records = agentName ? store.getSessionsByAgent(agentName) : store.getRecentSessions(last);

		return jsonResult({ count: records.length, metrics: records });
	} finally {
		store.close();
	}
}

async function handleDoctor(args: Record<string, unknown>): Promise<McpToolResult> {
	// Doctor aggregates 9 check categories — shell out to CLI.
	const root = args.project_root as string;
	const cliArgs = ["run", join(import.meta.dir, "..", "index.ts"), "doctor", "--json", "--verbose"];

	if (args.category) cliArgs.push("--category", args.category as string);

	const proc = Bun.spawn(["bun", ...cliArgs], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	// Doctor returns exit 1 on failures but still produces JSON output
	try {
		return jsonResult(JSON.parse(stdout.trim()));
	} catch {
		if (exitCode !== 0) {
			return errorResult(`doctor failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
		}
		return textResult(stdout.trim());
	}
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
	overstory_status: handleStatus,
	overstory_mail_send: handleMailSend,
	overstory_mail_check: handleMailCheck,
	overstory_mail_list: handleMailList,
	overstory_sling: handleSling,
	overstory_merge: handleMerge,
	overstory_inspect: handleInspect,
	overstory_worktree_list: handleWorktreeList,
	overstory_metrics: handleMetrics,
	overstory_doctor: handleDoctor,
};
