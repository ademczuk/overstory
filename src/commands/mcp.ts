/**
 * CLI command: overstory mcp [serve|register|status]
 *
 * Manages the MCP server for Claude Code integration.
 * - serve: Start the stdio MCP server (blocking — called by Claude Code)
 * - register: Generate .mcp.json for a target project
 * - status: Show registration status
 */

import { join, resolve } from "node:path";

const MCP_HELP = `overstory mcp — MCP server for Claude Code

Usage: overstory mcp <subcommand>

Subcommands:
  serve                    Start the MCP server (stdio transport, blocking)
  register [project-dir]   Generate .mcp.json in target project for Claude Code
  unregister [project-dir] Remove .mcp.json from target project
  status [project-dir]     Check if MCP server is registered

Options:
  --help, -h               Show this help
  --json                   JSON output

The MCP server exposes Overstory tools as native Claude Code tools,
eliminating the need for Bash-wrapped CLI calls. It runs alongside
the existing hooks system — hooks handle lifecycle events (automatic),
MCP handles explicit tool invocations (on-demand).

Tools exposed:
  overstory_status         Fleet status (agents, worktrees, mail, merge queue)
  overstory_mail_send      Send inter-agent messages
  overstory_mail_check     Check inbox (marks as read)
  overstory_mail_list      List messages with filters
  overstory_sling          Spawn a worker agent
  overstory_merge          Merge agent branches
  overstory_inspect        Deep agent inspection
  overstory_worktree_list  List git worktrees
  overstory_metrics        Token/cost analysis
  overstory_doctor         Health checks`;

interface McpJsonConfig {
	mcpServers: Record<string, { command: string; args: string[] }>;
}

/**
 * Start the MCP server. This is a blocking call — it runs until stdin closes.
 */
async function mcpServe(_args: string[]): Promise<void> {
	// Dynamically import to avoid loading MCP code for non-serve commands
	const { McpServer } = await import("../mcp/server.ts");
	const { TOOL_DEFINITIONS, TOOL_HANDLERS } = await import("../mcp/tools.ts");

	const server = new McpServer({ name: "overstory", version: "0.5.2" });

	for (const definition of TOOL_DEFINITIONS) {
		const handler = TOOL_HANDLERS[definition.name];
		if (handler) {
			server.registerTool(definition, handler);
		}
	}

	await server.listen();
}

/**
 * Generate .mcp.json in the target project directory.
 */
async function mcpRegister(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const projectDir = args.find((a) => !a.startsWith("--")) ?? process.cwd();
	const targetDir = resolve(projectDir);
	const mcpJsonPath = join(targetDir, ".mcp.json");

	// Resolve the path to this overstory installation's MCP entry point
	const mcpEntryPoint = resolve(join(import.meta.dir, "..", "mcp", "index.ts"));

	const mcpConfig: McpJsonConfig = {
		mcpServers: {
			overstory: {
				command: "bun",
				args: ["run", mcpEntryPoint],
			},
		},
	};

	// Check if .mcp.json already exists
	const file = Bun.file(mcpJsonPath);
	if (await file.exists()) {
		const existing = (await file.json()) as McpJsonConfig;
		if (existing.mcpServers?.overstory) {
			if (json) {
				process.stdout.write(
					`${JSON.stringify({ registered: true, path: mcpJsonPath, updated: false })}\n`,
				);
			} else {
				process.stdout.write(
					`Overstory MCP already registered in ${mcpJsonPath}\nUse --force to overwrite, or edit .mcp.json manually.\n`,
				);
			}
			if (!args.includes("--force")) return;
		}

		// Merge: preserve other MCP servers, add/replace overstory
		existing.mcpServers = existing.mcpServers ?? {};
		const overstoryEntry = mcpConfig.mcpServers.overstory;
		if (overstoryEntry) {
			existing.mcpServers.overstory = overstoryEntry;
		}
		await Bun.write(mcpJsonPath, `${JSON.stringify(existing, null, "\t")}\n`);
	} else {
		await Bun.write(mcpJsonPath, `${JSON.stringify(mcpConfig, null, "\t")}\n`);
	}

	if (json) {
		process.stdout.write(
			`${JSON.stringify({ registered: true, path: mcpJsonPath, entryPoint: mcpEntryPoint })}\n`,
		);
	} else {
		process.stdout.write(`\u2713 Registered Overstory MCP server in ${mcpJsonPath}\n`);
		process.stdout.write(`  Entry point: ${mcpEntryPoint}\n`);
		process.stdout.write(`  Transport: stdio\n`);
		process.stdout.write(`\nClaude Code will discover the server on next session start.\n`);
	}
}

/**
 * Remove overstory entry from .mcp.json.
 */
async function mcpUnregister(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const projectDir = args.find((a) => !a.startsWith("--")) ?? process.cwd();
	const targetDir = resolve(projectDir);
	const mcpJsonPath = join(targetDir, ".mcp.json");

	const file = Bun.file(mcpJsonPath);
	if (!(await file.exists())) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ registered: false })}\n`);
		} else {
			process.stdout.write("No .mcp.json found — nothing to unregister.\n");
		}
		return;
	}

	const existing = (await file.json()) as McpJsonConfig;
	if (!existing.mcpServers?.overstory) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ registered: false })}\n`);
		} else {
			process.stdout.write("Overstory MCP not found in .mcp.json.\n");
		}
		return;
	}

	delete existing.mcpServers.overstory;

	const remainingServers = Object.keys(existing.mcpServers);
	if (remainingServers.length === 0) {
		const { unlink } = await import("node:fs/promises");
		await unlink(mcpJsonPath);
		if (json) {
			process.stdout.write(`${JSON.stringify({ unregistered: true, fileRemoved: true })}\n`);
		} else {
			process.stdout.write("\u2713 Removed .mcp.json (was overstory-only)\n");
		}
	} else {
		await Bun.write(mcpJsonPath, `${JSON.stringify(existing, null, "\t")}\n`);
		if (json) {
			process.stdout.write(`${JSON.stringify({ unregistered: true, fileRemoved: false })}\n`);
		} else {
			process.stdout.write("\u2713 Removed overstory from .mcp.json (preserved other servers)\n");
		}
	}
}

/**
 * Show MCP registration status.
 */
async function mcpStatus(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const projectDir = args.find((a) => !a.startsWith("--")) ?? process.cwd();
	const targetDir = resolve(projectDir);
	const mcpJsonPath = join(targetDir, ".mcp.json");

	const file = Bun.file(mcpJsonPath);
	const exists = await file.exists();

	let registered = false;
	let entryPoint: string | null = null;

	if (exists) {
		const content = (await file.json()) as McpJsonConfig;
		if (content.mcpServers?.overstory) {
			registered = true;
			const serverArgs = content.mcpServers.overstory.args;
			entryPoint = serverArgs[serverArgs.length - 1] ?? null;
		}
	}

	if (json) {
		process.stdout.write(`${JSON.stringify({ registered, entryPoint, mcpJsonPath })}\n`);
	} else {
		process.stdout.write(`MCP registration (.mcp.json): ${registered ? "yes" : "no"}\n`);
		if (registered && entryPoint) {
			process.stdout.write(`  Entry point: ${entryPoint}\n`);
		}
		if (!registered) {
			process.stdout.write(`\nRun 'overstory mcp register' to set up.\n`);
		}
	}
}

/**
 * Entry point for `overstory mcp <subcommand>`.
 */
export async function mcpCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${MCP_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "serve":
			await mcpServe(subArgs);
			break;
		case "register":
			await mcpRegister(subArgs);
			break;
		case "unregister":
			await mcpUnregister(subArgs);
			break;
		case "status":
			await mcpStatus(subArgs);
			break;
		default:
			process.stderr.write(
				`Unknown mcp subcommand: ${subcommand}. Run 'overstory mcp --help' for usage.\n`,
			);
			process.exit(1);
	}
}
