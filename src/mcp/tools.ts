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

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { gatherStatus } from "../commands/status.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { listWorktrees } from "../worktree/manager.ts";
import type { McpToolDefinition, McpToolResult, ToolHandler } from "./server.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Overstory installation root (two levels up from src/mcp/) */
const OVERSTORY_INSTALL_ROOT = resolve(join(import.meta.dir, "..", ".."));

/** Timeout for CLI subprocess calls (30s) */
const CLI_TIMEOUT_MS = 30_000;

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

/**
 * Resolve and validate project_root.
 *
 * Resolution order:
 * 1. Explicit `project_root` argument (if provided)
 * 2. OVERSTORY_PROJECT_ROOT environment variable
 * 3. Overstory installation directory (this repo)
 *
 * Returns the resolved path or an error result.
 */
function resolveRoot(args: Record<string, unknown>): string | McpToolResult {
	const explicit = args.project_root as string | undefined;

	let root: string;
	if (explicit) {
		root = explicit;
	} else if (process.env.OVERSTORY_PROJECT_ROOT) {
		root = process.env.OVERSTORY_PROJECT_ROOT;
	} else {
		root = OVERSTORY_INSTALL_ROOT;
	}

	// Validate
	const oDir = join(root, ".overstory");
	if (!existsSync(oDir)) {
		const hints = [
			`Directory '${root}' does not have .overstory/ initialized.`,
			"",
			"To fix, either:",
			`  1. Run 'overstory init' in ${root}`,
			"  2. Pass the correct project_root (absolute path to a project with .overstory/)",
			"  3. Set OVERSTORY_PROJECT_ROOT environment variable",
			"",
			`Known overstory project: ${OVERSTORY_INSTALL_ROOT}`,
		];
		return errorResult(hints.join("\n"));
	}

	const configPath = join(oDir, "config.yaml");
	if (!existsSync(configPath)) {
		return errorResult(
			`Found .overstory/ in ${root} but config.yaml is missing. Run 'overstory init' to fix.`,
		);
	}

	return root;
}

/**
 * Run a CLI subprocess with timeout. Returns stdout/stderr/exitCode.
 */
async function runCli(
	cliArgs: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", ...cliArgs], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	// Race the process against a timeout
	const timeout = new Promise<never>((_, reject) => {
		const id = setTimeout(() => {
			proc.kill();
			reject(new Error(`CLI subprocess timed out after ${CLI_TIMEOUT_MS}ms`));
		}, CLI_TIMEOUT_MS);
		// Don't let the timer keep the process alive
		proc.exited.then(() => clearTimeout(id));
	});

	const [stdout, stderr, exitCode] = await Promise.race([
		Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
		timeout.then(() => ["", "timeout", 1] as [string, string, number]),
	]);

	return { stdout, stderr, exitCode };
}

/** project_root description shared across all tools */
const PROJECT_ROOT_DESC =
	"Absolute path to the target project root (must have .overstory/ initialized). " +
	"Optional — auto-discovers from OVERSTORY_PROJECT_ROOT env or overstory install location.";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
	{
		name: "overstory_discover",
		description:
			"Check if overstory is available and return the default project root. " +
			"Call this first to discover which project_root to use for other tools. " +
			"Returns the auto-discovered root, whether .overstory/ is initialized, and server version.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: {
					type: "string",
					description: "Optional path to check. If omitted, auto-discovers.",
				},
			},
			required: [],
		},
	},
	{
		name: "overstory_status",
		description:
			"Get the status of all Overstory agents, worktrees, unread mail count, and merge queue depth. " +
			"Use this to understand what agents are active and what state the fleet is in.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: PROJECT_ROOT_DESC },
				agent_name: {
					type: "string",
					description: "Whose perspective for unread mail count (default: orchestrator).",
				},
				verbose: {
					type: "boolean",
					description: "Include extra per-agent detail (worktree path, logs dir, last mail).",
				},
			},
			required: [],
		},
	},
	{
		name: "overstory_mail_send",
		description:
			"Send a mail message to an agent. Used for inter-agent coordination and task assignment.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: PROJECT_ROOT_DESC },
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
			required: ["from", "to", "subject", "body"],
		},
	},
	{
		name: "overstory_mail_check",
		description:
			"Check inbox for unread messages. Marks them as read and returns the messages. " +
			"Use to see what agents have reported.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: PROJECT_ROOT_DESC },
				agent_name: {
					type: "string",
					description: "Which agent's inbox to check (default: orchestrator).",
				},
			},
			required: [],
		},
	},
	{
		name: "overstory_mail_list",
		description: "List mail messages with optional filters. Does NOT mark messages as read.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: PROJECT_ROOT_DESC },
				from: { type: "string", description: "Filter by sender." },
				to: { type: "string", description: "Filter by recipient." },
				unread: { type: "boolean", description: "Only unread messages." },
			},
			required: [],
		},
	},
	{
		name: "overstory_sling",
		description:
			"Spawn a new worker agent in a git worktree. Creates the worktree, branch, overlay CLAUDE.md, " +
			"and tmux/process session. Returns agent details.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: PROJECT_ROOT_DESC },
				task_id: { type: "string", description: "Bead task ID for the agent to work on." },
				capability: {
					type: "string",
					description: "Agent type to spawn.",
					enum: ["scout", "builder", "reviewer", "lead", "merger"],
				},
				name: { type: "string", description: "Unique agent name." },
				spec: { type: "string", description: "Path to task spec file." },
				files: { type: "string", description: "Comma-separated exclusive file scope." },
				parent: { type: "string", description: "Parent agent name (for hierarchy)." },
				depth: { type: "number", description: "Current hierarchy depth (default: 0)." },
			},
			required: ["task_id", "capability", "name"],
		},
	},
	{
		name: "overstory_merge",
		description:
			"Merge an agent's branch into the canonical branch. Supports dry-run to preview conflicts.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: PROJECT_ROOT_DESC },
				branch: { type: "string", description: "Specific branch to merge." },
				all: { type: "boolean", description: "Merge all completed agent branches." },
				into: {
					type: "string",
					description: "Target branch (default: session-branch.txt or canonicalBranch).",
				},
				dry_run: {
					type: "boolean",
					description: "Check for conflicts without actually merging.",
				},
			},
			required: [],
		},
	},
	{
		name: "overstory_inspect",
		description:
			"Deep inspection of a single agent: session state, recent tool calls, tmux pane capture, mail history.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: PROJECT_ROOT_DESC },
				agent_name: { type: "string", description: "Agent to inspect." },
				limit: { type: "number", description: "Recent tool calls to include (default: 20)." },
			},
			required: ["agent_name"],
		},
	},
	{
		name: "overstory_worktree_list",
		description:
			"List all git worktrees with their branch and HEAD commit. Shows what parallel work exists.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: PROJECT_ROOT_DESC },
			},
			required: [],
		},
	},
	{
		name: "overstory_metrics",
		description: "Get session metrics and token/cost analysis. Combines metrics and costs data.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: PROJECT_ROOT_DESC },
				agent_name: { type: "string", description: "Filter by agent name." },
				last: { type: "number", description: "Number of recent sessions (default: 20)." },
			},
			required: [],
		},
	},
	{
		name: "overstory_doctor",
		description:
			"Run health checks on the Overstory setup. Returns pass/fail results for " +
			"dependencies, config, databases, agents, etc.",
		inputSchema: {
			type: "object",
			properties: {
				project_root: { type: "string", description: PROJECT_ROOT_DESC },
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
			required: [],
		},
	},
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleDiscover(args: Record<string, unknown>): Promise<McpToolResult> {
	const explicit = args.project_root as string | undefined;
	const envRoot = process.env.OVERSTORY_PROJECT_ROOT;

	const candidates = [
		...(explicit ? [{ path: explicit, source: "explicit" }] : []),
		...(envRoot ? [{ path: envRoot, source: "OVERSTORY_PROJECT_ROOT env" }] : []),
		{ path: OVERSTORY_INSTALL_ROOT, source: "overstory install directory" },
	];

	const results = candidates.map((c) => ({
		...c,
		initialized: existsSync(join(c.path, ".overstory", "config.yaml")),
	}));

	const active = results.find((r) => r.initialized);

	return jsonResult({
		server_version: "0.5.2",
		default_root: active?.path ?? null,
		default_source: active?.source ?? null,
		candidates: results,
		hint: active
			? `Use project_root: "${active.path}" for other overstory tools, or omit it to auto-discover.`
			: "No initialized overstory project found. Run 'overstory init' in a project directory.",
	});
}

async function handleStatus(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = resolveRoot(args);
	if (typeof root !== "string") return root;

	try {
		const agentName = (args.agent_name as string | undefined) ?? "orchestrator";
		const verbose = (args.verbose as boolean | undefined) ?? false;
		const data = await gatherStatus(root, agentName, verbose);
		return jsonResult(data);
	} catch (err) {
		return errorResult(`status failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function handleMailSend(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = resolveRoot(args);
	if (typeof root !== "string") return root;

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
	} catch (err) {
		return errorResult(`mail send failed: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		store.close();
	}
}

async function handleMailCheck(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = resolveRoot(args);
	if (typeof root !== "string") return root;

	const agentName = (args.agent_name as string | undefined) ?? "orchestrator";
	const dbPath = join(overstoryDir(root), "mail.db");
	const store = createMailStore(dbPath);

	try {
		const client = createMailClient(store);
		const messages = client.check(agentName);
		return jsonResult({ count: messages.length, messages });
	} catch (err) {
		return errorResult(`mail check failed: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		store.close();
	}
}

async function handleMailList(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = resolveRoot(args);
	if (typeof root !== "string") return root;

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
	} catch (err) {
		return errorResult(`mail list failed: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		store.close();
	}
}

async function handleSling(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = resolveRoot(args);
	if (typeof root !== "string") return root;

	try {
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

		const { stdout, stderr, exitCode } = await runCli(cliArgs, root);

		if (exitCode !== 0) {
			return errorResult(`sling failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
		}

		try {
			return jsonResult(JSON.parse(stdout.trim()));
		} catch {
			return textResult(stdout.trim());
		}
	} catch (err) {
		return errorResult(`sling failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function handleMerge(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = resolveRoot(args);
	if (typeof root !== "string") return root;

	try {
		const cliArgs = ["run", join(import.meta.dir, "..", "index.ts"), "merge", "--json"];

		if (args.branch) cliArgs.push("--branch", args.branch as string);
		if (args.all) cliArgs.push("--all");
		if (args.into) cliArgs.push("--into", args.into as string);
		if (args.dry_run) cliArgs.push("--dry-run");

		const { stdout, stderr, exitCode } = await runCli(cliArgs, root);

		if (exitCode !== 0) {
			return errorResult(`merge failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
		}

		try {
			return jsonResult(JSON.parse(stdout.trim()));
		} catch {
			return textResult(stdout.trim());
		}
	} catch (err) {
		return errorResult(`merge failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function handleInspect(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = resolveRoot(args);
	if (typeof root !== "string") return root;

	try {
		const cliArgs = [
			"run",
			join(import.meta.dir, "..", "index.ts"),
			"inspect",
			args.agent_name as string,
			"--json",
		];

		if (args.limit !== undefined) cliArgs.push("--limit", String(args.limit));
		cliArgs.push("--no-tmux"); // Skip tmux capture-pane in MCP context

		const { stdout, stderr, exitCode } = await runCli(cliArgs, root);

		if (exitCode !== 0) {
			return errorResult(`inspect failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
		}

		try {
			return jsonResult(JSON.parse(stdout.trim()));
		} catch {
			return textResult(stdout.trim());
		}
	} catch (err) {
		return errorResult(`inspect failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function handleWorktreeList(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = resolveRoot(args);
	if (typeof root !== "string") return root;

	try {
		const worktrees = await listWorktrees(root);
		return jsonResult({ count: worktrees.length, worktrees });
	} catch (err) {
		return errorResult(`worktree list failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function handleMetrics(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = resolveRoot(args);
	if (typeof root !== "string") return root;

	const oDir = overstoryDir(root);
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
	} catch (err) {
		return errorResult(`metrics failed: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		store.close();
	}
}

async function handleDoctor(args: Record<string, unknown>): Promise<McpToolResult> {
	const root = resolveRoot(args);
	if (typeof root !== "string") return root;

	try {
		const cliArgs = [
			"run",
			join(import.meta.dir, "..", "index.ts"),
			"doctor",
			"--json",
			"--verbose",
		];

		if (args.category) cliArgs.push("--category", args.category as string);

		const { stdout, stderr, exitCode } = await runCli(cliArgs, root);

		// Doctor returns exit 1 on failures but still produces JSON output
		try {
			return jsonResult(JSON.parse(stdout.trim()));
		} catch {
			if (exitCode !== 0) {
				return errorResult(`doctor failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
			}
			return textResult(stdout.trim());
		}
	} catch (err) {
		return errorResult(`doctor failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
	overstory_discover: handleDiscover,
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
