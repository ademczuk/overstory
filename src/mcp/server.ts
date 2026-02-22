/**
 * Raw MCP server over stdio (JSON-RPC 2.0).
 *
 * Zero external dependencies — pure Bun stdin/stdout.
 * Protocol: newline-delimited JSON-RPC 2.0 messages on stdio.
 * All logging goes to stderr (stdout is reserved for protocol).
 */

const PROTOCOL_VERSION = "2024-11-05";

export interface McpToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

export interface McpResourceDefinition {
	uri: string;
	name: string;
	description: string;
	mimeType: string;
}

export type ResourceHandler = () => Promise<{
	contents: Array<{ uri: string; text: string; mimeType: string }>;
}>;

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/**
 * Minimal MCP server: register tools, register resources, call listen().
 */
export class McpServer {
	private serverName: string;
	private serverVersion: string;
	private tools = new Map<string, { definition: McpToolDefinition; handler: ToolHandler }>();
	private resources = new Map<
		string,
		{ definition: McpResourceDefinition; handler: ResourceHandler }
	>();

	constructor(opts: { name: string; version: string }) {
		this.serverName = opts.name;
		this.serverVersion = opts.version;
	}

	registerTool(definition: McpToolDefinition, handler: ToolHandler): void {
		this.tools.set(definition.name, { definition, handler });
	}

	registerResource(definition: McpResourceDefinition, handler: ResourceHandler): void {
		this.resources.set(definition.uri, { definition, handler });
	}

	/**
	 * Start listening on stdin. Blocks until stdin closes.
	 */
	async listen(): Promise<void> {
		process.stderr.write(
			`[overstory-mcp] Server starting (${this.serverName} v${this.serverVersion})\n`,
		);

		const decoder = new TextDecoder();
		let buffer = "";

		const stream = Bun.stdin.stream();
		const reader = stream.getReader();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					try {
						const request = JSON.parse(trimmed) as JsonRpcRequest;
						const response = await this.handleRequest(request);
						if (response !== null) {
							process.stdout.write(`${JSON.stringify(response)}\n`);
						}
					} catch (err) {
						process.stderr.write(
							`[overstory-mcp] Parse error: ${err instanceof Error ? err.message : String(err)}\n`,
						);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		process.stderr.write("[overstory-mcp] stdin closed, shutting down\n");
	}

	private async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
		const { method, id, params } = req;

		// Notifications (no id) — no response
		if (id === undefined || id === null) {
			if (method === "notifications/initialized") {
				process.stderr.write("[overstory-mcp] Client initialized\n");
			}
			return null;
		}

		try {
			const result = await this.dispatch(method, params ?? {});
			return { jsonrpc: "2.0", id, result };
		} catch (err) {
			const isRpcError = typeof err === "object" && err !== null && "code" in err;
			if (isRpcError) {
				const rpcErr = err as { code: number; message: string };
				return { jsonrpc: "2.0", id, error: { code: rpcErr.code, message: rpcErr.message } };
			}
			return {
				jsonrpc: "2.0",
				id,
				error: {
					code: -32603,
					message: err instanceof Error ? err.message : String(err),
				},
			};
		}
	}

	private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
		switch (method) {
			case "initialize":
				return {
					protocolVersion: PROTOCOL_VERSION,
					serverInfo: { name: this.serverName, version: this.serverVersion },
					capabilities: {
						tools: {},
						resources: this.resources.size > 0 ? {} : undefined,
					},
				};

			case "tools/list":
				return {
					tools: [...this.tools.values()].map((t) => t.definition),
				};

			case "tools/call": {
				const name = params.name as string | undefined;
				const args = (params.arguments as Record<string, unknown>) ?? {};

				if (!name) {
					throw { code: -32602, message: "Missing tool name" };
				}

				const tool = this.tools.get(name);
				if (!tool) {
					throw { code: -32602, message: `Unknown tool: ${name}` };
				}

				process.stderr.write(`[overstory-mcp] Calling tool: ${name}\n`);
				return await tool.handler(args);
			}

			case "resources/list":
				return {
					resources: [...this.resources.values()].map((r) => r.definition),
				};

			case "resources/read": {
				const uri = params.uri as string | undefined;
				if (!uri) {
					throw { code: -32602, message: "Missing resource URI" };
				}

				const resource = this.resources.get(uri);
				if (!resource) {
					throw { code: -32602, message: `Unknown resource: ${uri}` };
				}

				return await resource.handler();
			}

			case "prompts/list":
				return { prompts: [] };

			case "ping":
				return {};

			default:
				throw { code: -32601, message: `Unknown method: ${method}` };
		}
	}
}
