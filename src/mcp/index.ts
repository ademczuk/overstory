#!/usr/bin/env bun

/**
 * Overstory MCP server entry point.
 *
 * Runs as a stdio MCP server for Claude Code integration.
 * Zero external dependencies — raw JSON-RPC 2.0 over stdin/stdout.
 *
 * Usage:
 *   bun run src/mcp/index.ts
 *
 * Registration in .mcp.json:
 *   { "mcpServers": { "overstory": { "command": "bun", "args": ["run", "/path/to/src/mcp/index.ts"] } } }
 */

import { McpServer } from "./server.ts";
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "./tools.ts";

const VERSION = "0.5.2";

const server = new McpServer({
	name: "overstory",
	version: VERSION,
});

// Register all tools
for (const definition of TOOL_DEFINITIONS) {
	const handler = TOOL_HANDLERS[definition.name];
	if (handler) {
		server.registerTool(definition, handler);
	}
}

// Start listening
server.listen().catch((err: unknown) => {
	process.stderr.write(
		`[overstory-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
});
