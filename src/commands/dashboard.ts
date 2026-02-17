/**
 * CLI command: overstory dashboard [--interval <ms>]
 *
 * Rich terminal dashboard using raw ANSI escape codes (zero runtime deps).
 * Polls existing data sources and renders multi-panel layout with agent status,
 * mail activity, merge queue, and metrics.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { color } from "../logging/color.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { launchAgentPanes } from "../observability/win-terminal.ts";
import type { MailMessage, StoredEvent } from "../types.ts";
import { getSessionBackend } from "../worktree/session-backend.ts";
import { gatherStatus, type StatusData } from "./status.ts";

/**
 * Terminal control codes (cursor movement, screen clearing).
 * These are not colors, so they stay separate from the color module.
 */
const CURSOR = {
	clear: "\x1b[2J\x1b[H", // Clear screen and home cursor
	cursorTo: (row: number, col: number) => `\x1b[${row};${col}H`,
	hideCursor: "\x1b[?25l",
	showCursor: "\x1b[?25h",
} as const;

/**
 * Box drawing characters for panel borders.
 */
const BOX = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
	tee: "├",
	teeRight: "┤",
	cross: "┼",
};

/**
 * Parse a named flag value from args.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

/**
 * Format a duration in ms to a human-readable string.
 */
function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainSec = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainSec}s`;
	const hours = Math.floor(minutes / 60);
	const remainMin = minutes % 60;
	return `${hours}h ${remainMin}m`;
}

/**
 * Format a timestamp to "time ago" format.
 */
function timeAgo(timestamp: string): string {
	const now = Date.now();
	const then = new Date(timestamp).getTime();
	const diffMs = now - then;
	const diffSec = Math.floor(diffMs / 1000);

	if (diffSec < 60) return `${diffSec}s ago`;
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h ago`;
	const diffDay = Math.floor(diffHr / 24);
	return `${diffDay}d ago`;
}

/**
 * Truncate a string to fit within maxLen characters, adding ellipsis if needed.
 */
function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 1)}…`;
}

/**
 * Pad or truncate a string to exactly the given width.
 */
function pad(str: string, width: number): string {
	if (str.length >= width) return str.slice(0, width);
	return str + " ".repeat(width - str.length);
}

/**
 * Draw a horizontal line with left/right/middle connectors.
 */
function horizontalLine(width: number, left: string, _middle: string, right: string): string {
	return left + BOX.horizontal.repeat(width - 2) + right;
}

interface DashboardData {
	status: StatusData;
	recentMail: MailMessage[];
	recentEvents: StoredEvent[];
	mergeQueue: Array<{ branchName: string; agentName: string; status: string }>;
	metrics: {
		totalSessions: number;
		avgDuration: number;
		byCapability: Record<string, number>;
	};
	/** Captured output per active agent (agentName -> last N lines or null). */
	agentOutput: Map<string, string | null>;
}

/**
 * Load all data sources for the dashboard.
 */
async function loadDashboardData(root: string): Promise<DashboardData> {
	const status = await gatherStatus(root, "orchestrator", false);

	// Load recent mail
	let recentMail: MailMessage[] = [];
	try {
		const mailDbPath = join(root, ".overstory", "mail.db");
		const mailFile = Bun.file(mailDbPath);
		if (await mailFile.exists()) {
			const mailStore = createMailStore(mailDbPath);
			recentMail = mailStore.getAll().slice(0, 5);
			mailStore.close();
		}
	} catch {
		// Mail db might not exist
	}

	// Load recent events
	let recentEvents: StoredEvent[] = [];
	try {
		const eventsDbPath = join(root, ".overstory", "events.db");
		const eventsFile = Bun.file(eventsDbPath);
		if (await eventsFile.exists()) {
			const eventStore = createEventStore(eventsDbPath);
			const since = new Date(Date.now() - 3600_000).toISOString(); // Last hour
			recentEvents = eventStore.getTimeline({ since, limit: 20 });
			eventStore.close();
		}
	} catch {
		// Events db might not exist
	}

	// Load merge queue
	let mergeQueue: Array<{ branchName: string; agentName: string; status: string }> = [];
	try {
		const queuePath = join(root, ".overstory", "merge-queue.db");
		const queue = createMergeQueue(queuePath);
		mergeQueue = queue.list().map((e) => ({
			branchName: e.branchName,
			agentName: e.agentName,
			status: e.status,
		}));
		queue.close();
	} catch {
		// Queue db might not exist
	}

	// Load metrics
	let totalSessions = 0;
	let avgDuration = 0;
	const byCapability: Record<string, number> = {};
	try {
		const metricsDbPath = join(root, ".overstory", "metrics.db");
		const metricsFile = Bun.file(metricsDbPath);
		if (await metricsFile.exists()) {
			const store = createMetricsStore(metricsDbPath);
			const sessions = store.getRecentSessions(100);
			totalSessions = sessions.length;
			avgDuration = store.getAverageDuration();

			// Count by capability
			for (const session of sessions) {
				const cap = session.capability;
				byCapability[cap] = (byCapability[cap] ?? 0) + 1;
			}

			store.close();
		}
	} catch {
		// Metrics db might not exist
	}

	// Capture output for active agents
	const agentOutput = new Map<string, string | null>();
	const activeAgents = status.agents.filter(
		(a) => a.state === "working" || a.state === "booting" || a.state === "stalled",
	);
	const backend = getSessionBackend();
	for (const agent of activeAgents) {
		try {
			const output = await backend.captureOutput(agent.tmuxSession, 30);
			agentOutput.set(agent.agentName, output);
		} catch {
			agentOutput.set(agent.agentName, null);
		}
	}

	return {
		status,
		recentMail,
		recentEvents,
		mergeQueue,
		metrics: { totalSessions, avgDuration, byCapability },
		agentOutput,
	};
}

/**
 * Render the header bar (line 1).
 */
function renderHeader(width: number, interval: number): string {
	const left = `${color.bold}overstory dashboard v0.2.0${color.reset}`;
	const now = new Date().toLocaleTimeString();
	const right = `${now} | refresh: ${interval}ms`;
	const leftStripped = "overstory dashboard v0.2.0"; // for length calculation
	const padding = width - leftStripped.length - right.length;
	const line = left + " ".repeat(Math.max(0, padding)) + right;
	const separator = horizontalLine(width, BOX.topLeft, BOX.horizontal, BOX.topRight);
	return `${line}\n${separator}`;
}

/**
 * Get color for agent state.
 */
function getStateColor(state: string): string {
	switch (state) {
		case "working":
			return color.green;
		case "booting":
			return color.yellow;
		case "stalled":
			return color.red;
		case "zombie":
			return color.dim;
		case "completed":
			return color.cyan;
		default:
			return color.white;
	}
}

/**
 * Get status icon for agent state.
 */
function getStateIcon(state: string): string {
	switch (state) {
		case "working":
			return "●";
		case "booting":
			return "◐";
		case "stalled":
			return "⚠";
		case "zombie":
			return "○";
		case "completed":
			return "✓";
		default:
			return "?";
	}
}

/**
 * Render the agent panel (top ~40% of screen).
 */
function renderAgentPanel(
	data: DashboardData,
	width: number,
	height: number,
	startRow: number,
): string {
	const panelHeight = Math.floor(height * 0.4);
	let output = "";

	// Panel header
	const headerLine = `${BOX.vertical} ${color.bold}Agents${color.reset} (${data.status.agents.length})`;
	const headerPadding = " ".repeat(
		width - headerLine.length - 1 + color.bold.length + color.reset.length,
	);
	output += `${CURSOR.cursorTo(startRow, 1)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	// Column headers
	const colHeaders = `${BOX.vertical} St Name            Capability    State      Bead ID          Duration  Tmux ${BOX.vertical}`;
	output += `${CURSOR.cursorTo(startRow + 1, 1)}${colHeaders}\n`;

	// Separator
	const separator = horizontalLine(width, BOX.tee, BOX.horizontal, BOX.teeRight);
	output += `${CURSOR.cursorTo(startRow + 2, 1)}${separator}\n`;

	// Sort agents: active first (working, booting, stalled), then completed, then zombie
	const agents = [...data.status.agents].sort((a, b) => {
		const activeStates = ["working", "booting", "stalled"];
		const aActive = activeStates.includes(a.state);
		const bActive = activeStates.includes(b.state);
		if (aActive && !bActive) return -1;
		if (!aActive && bActive) return 1;
		return 0;
	});

	const now = Date.now();
	const maxRows = panelHeight - 4; // header + col headers + separator + border
	const visibleAgents = agents.slice(0, maxRows);

	for (let i = 0; i < visibleAgents.length; i++) {
		const agent = visibleAgents[i];
		if (!agent) continue;

		const icon = getStateIcon(agent.state);
		const stateColor = getStateColor(agent.state);
		const name = pad(truncate(agent.agentName, 15), 15);
		const capability = pad(truncate(agent.capability, 12), 12);
		const state = pad(agent.state, 10);
		const beadId = pad(truncate(agent.beadId, 16), 16);
		const endTime =
			agent.state === "completed" || agent.state === "zombie"
				? new Date(agent.lastActivity).getTime()
				: now;
		const duration = formatDuration(endTime - new Date(agent.startedAt).getTime());
		const durationPadded = pad(duration, 9);
		const tmuxAlive = data.status.tmuxSessions.some((s) => s.name === agent.tmuxSession);
		const tmuxDot = tmuxAlive ? `${color.green}●${color.reset}` : `${color.red}○${color.reset}`;

		const line = `${BOX.vertical} ${stateColor}${icon}${color.reset}  ${name} ${capability} ${stateColor}${state}${color.reset} ${beadId} ${durationPadded} ${tmuxDot}    ${BOX.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 3 + i, 1)}${line}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = visibleAgents.length; i < maxRows; i++) {
		const emptyLine = `${BOX.vertical}${" ".repeat(width - 2)}${BOX.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 3 + i, 1)}${emptyLine}\n`;
	}

	// Bottom border
	const bottomBorder = horizontalLine(width, BOX.tee, BOX.horizontal, BOX.teeRight);
	output += `${CURSOR.cursorTo(startRow + 3 + maxRows, 1)}${bottomBorder}\n`;

	return output;
}

/**
 * Render side-by-side output panes for active agents.
 *
 * Each agent gets an equal-width column. Lines are wrapped/truncated
 * to fit the column width. Returns empty string if no output to show.
 */
function renderOutputPanel(
	data: DashboardData,
	width: number,
	panelHeight: number,
	startRow: number,
): string {
	if (data.agentOutput.size === 0) return "";

	const agents = [...data.agentOutput.entries()];
	const numCols = Math.min(agents.length, 4); // Max 4 side-by-side panes
	const colWidth = Math.floor((width - 1) / numCols); // -1 for right border
	let output = "";

	// Panel header
	const headerLine = `${BOX.vertical} ${color.bold}Agent Output${color.reset} (${agents.length} active)`;
	const headerPadding = " ".repeat(
		Math.max(0, width - headerLine.length - 1 + color.bold.length + color.reset.length),
	);
	output += `${CURSOR.cursorTo(startRow, 1)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	// Column headers with agent names
	let colHeaderLine = "";
	for (let c = 0; c < numCols; c++) {
		const entry = agents[c];
		if (!entry) continue;
		const [agentName] = entry;
		const stateAgent = data.status.agents.find((a) => a.agentName === agentName);
		const stateColor = stateAgent ? getStateColor(stateAgent.state) : color.white;
		const nameStr = truncate(agentName, colWidth - 4);
		const padLen = colWidth - nameStr.length - 3;
		colHeaderLine += `${BOX.vertical} ${stateColor}${nameStr}${color.reset}${" ".repeat(Math.max(0, padLen))}`;
	}
	colHeaderLine += BOX.vertical;
	output += `${CURSOR.cursorTo(startRow + 1, 1)}${colHeaderLine}\n`;

	// Separator
	let sepLine = "";
	for (let c = 0; c < numCols; c++) {
		sepLine += (c === 0 ? BOX.tee : BOX.cross) + BOX.horizontal.repeat(colWidth - 1);
	}
	sepLine += BOX.teeRight;
	output += `${CURSOR.cursorTo(startRow + 2, 1)}${sepLine}\n`;

	// Content rows: split each agent's output into lines and render side by side
	const contentHeight = panelHeight - 4; // header + col header + separator + bottom border
	const agentLines: string[][] = [];
	for (let c = 0; c < numCols; c++) {
		const entry = agents[c];
		if (!entry) {
			agentLines.push([]);
			continue;
		}
		const [, text] = entry;
		if (text) {
			const allLines = text.split("\n");
			// Take the last N lines that fit
			agentLines.push(allLines.slice(-contentHeight));
		} else {
			agentLines.push(["(no output)"]);
		}
	}

	for (let row = 0; row < contentHeight; row++) {
		let rowLine = "";
		for (let c = 0; c < numCols; c++) {
			const lines = agentLines[c] ?? [];
			const lineText = lines[row] ?? "";
			const displayWidth = colWidth - 2; // 1 for border, 1 for padding
			const truncatedLine =
				lineText.length > displayWidth ? lineText.slice(0, displayWidth) : lineText;
			const padLen = displayWidth - truncatedLine.length;
			rowLine += `${BOX.vertical} ${color.dim}${truncatedLine}${color.reset}${" ".repeat(Math.max(0, padLen))}`;
		}
		rowLine += BOX.vertical;
		output += `${CURSOR.cursorTo(startRow + 3 + row, 1)}${rowLine}\n`;
	}

	// Bottom border
	const bottomBorder = horizontalLine(width, BOX.tee, BOX.horizontal, BOX.teeRight);
	output += `${CURSOR.cursorTo(startRow + 3 + contentHeight, 1)}${bottomBorder}\n`;

	return output;
}

/**
 * Get color for mail priority.
 */
function getPriorityColor(priority: string): string {
	switch (priority) {
		case "urgent":
			return color.red;
		case "high":
			return color.yellow;
		case "normal":
			return color.white;
		case "low":
			return color.dim;
		default:
			return color.white;
	}
}

/**
 * Render the mail panel (middle-left ~30% height, ~60% width).
 */
function renderMailPanel(
	data: DashboardData,
	width: number,
	height: number,
	startRow: number,
	overrideWidth?: number,
): string {
	const panelHeight = Math.floor(height * 0.3);
	const panelWidth = overrideWidth ?? Math.floor(width * 0.6);
	let output = "";

	const unreadCount = data.status.unreadMailCount;
	const headerLine = `${BOX.vertical} ${color.bold}Mail${color.reset} (${unreadCount} unread)`;
	const headerPadding = " ".repeat(
		panelWidth - headerLine.length - 1 + color.bold.length + color.reset.length,
	);
	output += `${CURSOR.cursorTo(startRow, 1)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	const separator = horizontalLine(panelWidth, BOX.tee, BOX.horizontal, BOX.cross);
	output += `${CURSOR.cursorTo(startRow + 1, 1)}${separator}\n`;

	const maxRows = panelHeight - 3; // header + separator + border
	const messages = data.recentMail.slice(0, maxRows);

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;

		const priorityColor = getPriorityColor(msg.priority);
		const priority = msg.priority === "normal" ? "" : `[${msg.priority}] `;
		const from = truncate(msg.from, 12);
		const to = truncate(msg.to, 12);
		const subject = truncate(msg.subject, panelWidth - 40);
		const time = timeAgo(msg.createdAt);

		const line = `${BOX.vertical} ${priorityColor}${priority}${color.reset}${from} → ${to}: ${subject} (${time})`;
		const padding = " ".repeat(
			Math.max(
				0,
				panelWidth -
					line.length -
					1 +
					priorityColor.length +
					color.reset.length +
					priorityColor.length +
					color.reset.length,
			),
		);
		output += `${CURSOR.cursorTo(startRow + 2 + i, 1)}${line}${padding}${BOX.vertical}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = messages.length; i < maxRows; i++) {
		const emptyLine = `${BOX.vertical}${" ".repeat(panelWidth - 2)}${BOX.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 2 + i, 1)}${emptyLine}\n`;
	}

	return output;
}

/**
 * Get color for event level.
 */
function getEventColor(level: string): string {
	switch (level) {
		case "error":
			return color.red;
		case "warn":
			return color.yellow;
		case "info":
			return color.cyan;
		case "debug":
			return color.dim;
		default:
			return color.white;
	}
}

/**
 * Render the events panel (middle-center section in classic layout).
 */
function renderEventsPanel(
	data: DashboardData,
	width: number,
	height: number,
	startRow: number,
	startCol: number,
	overrideWidth?: number,
): string {
	const panelHeight = Math.floor(height * 0.3);
	const panelWidth = overrideWidth ?? width - startCol + 1;
	let output = "";

	const headerLine = `${BOX.vertical} ${color.bold}Events${color.reset} (${data.recentEvents.length})`;
	const headerPadding = " ".repeat(
		Math.max(0, panelWidth - headerLine.length - 1 + color.bold.length + color.reset.length),
	);
	output += `${CURSOR.cursorTo(startRow, startCol)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	const separator = horizontalLine(panelWidth, BOX.cross, BOX.horizontal, BOX.cross);
	output += `${CURSOR.cursorTo(startRow + 1, startCol)}${separator}\n`;

	const maxRows = panelHeight - 3;
	// Show most recent events first
	const events = [...data.recentEvents].reverse().slice(0, maxRows);

	for (let i = 0; i < events.length; i++) {
		const evt = events[i];
		if (!evt) continue;

		const levelColor = getEventColor(evt.level);
		const time = new Date(evt.createdAt).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		const agent = truncate(evt.agentName, 10);
		const eventDesc = evt.toolName
			? `${evt.eventType.replace("tool_", "")} ${evt.toolName}`
			: evt.eventType;
		const desc = truncate(eventDesc, panelWidth - 22);

		const line = `${BOX.vertical} ${time} ${levelColor}${pad(agent, 10)}${color.reset} ${desc}`;
		const padding = " ".repeat(
			Math.max(0, panelWidth - line.length - 1 + levelColor.length + color.reset.length),
		);
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${line}${padding}${BOX.vertical}\n`;
	}

	for (let i = events.length; i < maxRows; i++) {
		const emptyLine = `${BOX.vertical}${" ".repeat(panelWidth - 2)}${BOX.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${emptyLine}\n`;
	}

	return output;
}

/**
 * Get color for merge queue status.
 */
function getMergeStatusColor(status: string): string {
	switch (status) {
		case "pending":
			return color.yellow;
		case "merging":
			return color.blue;
		case "conflict":
			return color.red;
		case "merged":
			return color.green;
		default:
			return color.white;
	}
}

/**
 * Render the merge queue panel (middle-right ~30% height, ~40% width).
 */
function renderMergeQueuePanel(
	data: DashboardData,
	width: number,
	height: number,
	startRow: number,
	startCol: number,
): string {
	const panelHeight = Math.floor(height * 0.3);
	const panelWidth = width - startCol + 1;
	let output = "";

	const headerLine = `${BOX.vertical} ${color.bold}Merge Queue${color.reset} (${data.mergeQueue.length})`;
	const headerPadding = " ".repeat(
		panelWidth - headerLine.length - 1 + color.bold.length + color.reset.length,
	);
	output += `${CURSOR.cursorTo(startRow, startCol)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	const separator = horizontalLine(panelWidth, BOX.cross, BOX.horizontal, BOX.teeRight);
	output += `${CURSOR.cursorTo(startRow + 1, startCol)}${separator}\n`;

	const maxRows = panelHeight - 3; // header + separator + border
	const entries = data.mergeQueue.slice(0, maxRows);

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;

		const statusColor = getMergeStatusColor(entry.status);
		const status = pad(entry.status, 10);
		const agent = truncate(entry.agentName, 15);
		const branch = truncate(entry.branchName, panelWidth - 30);

		const line = `${BOX.vertical} ${statusColor}${status}${color.reset} ${agent} ${branch}`;
		const padding = " ".repeat(
			Math.max(0, panelWidth - line.length - 1 + statusColor.length + color.reset.length),
		);
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${line}${padding}${BOX.vertical}\n`;
	}

	// Fill remaining rows with empty lines
	for (let i = entries.length; i < maxRows; i++) {
		const emptyLine = `${BOX.vertical}${" ".repeat(panelWidth - 2)}${BOX.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 2 + i, startCol)}${emptyLine}\n`;
	}

	return output;
}

/**
 * Render the metrics panel (bottom strip).
 */
function renderMetricsPanel(
	data: DashboardData,
	width: number,
	_height: number,
	startRow: number,
): string {
	let output = "";

	const separator = horizontalLine(width, BOX.tee, BOX.horizontal, BOX.teeRight);
	output += `${CURSOR.cursorTo(startRow, 1)}${separator}\n`;

	const headerLine = `${BOX.vertical} ${color.bold}Metrics${color.reset}`;
	const headerPadding = " ".repeat(
		width - headerLine.length - 1 + color.bold.length + color.reset.length,
	);
	output += `${CURSOR.cursorTo(startRow + 1, 1)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	const totalSessions = data.metrics.totalSessions;
	const avgDuration = formatDuration(data.metrics.avgDuration);
	const byCapability = Object.entries(data.metrics.byCapability)
		.map(([cap, count]) => `${cap}:${count}`)
		.join(", ");

	const metricsLine = `${BOX.vertical} Total sessions: ${totalSessions} | Avg duration: ${avgDuration} | By capability: ${byCapability}`;
	const metricsPadding = " ".repeat(Math.max(0, width - metricsLine.length - 1));
	output += `${CURSOR.cursorTo(startRow + 2, 1)}${metricsLine}${metricsPadding}${BOX.vertical}\n`;

	const bottomBorder = horizontalLine(width, BOX.bottomLeft, BOX.horizontal, BOX.bottomRight);
	output += `${CURSOR.cursorTo(startRow + 3, 1)}${bottomBorder}\n`;

	return output;
}

/**
 * Render a compact agent table sized to content (no empty filler rows).
 * Used in the output-pane layout to give maximum space to output.
 */
function renderAgentPanelCompact(
	data: DashboardData,
	width: number,
	panelHeight: number,
	startRow: number,
): string {
	let output = "";

	// Panel header
	const headerLine = `${BOX.vertical} ${color.bold}Agents${color.reset} (${data.status.agents.length})`;
	const headerPadding = " ".repeat(
		width - headerLine.length - 1 + color.bold.length + color.reset.length,
	);
	output += `${CURSOR.cursorTo(startRow, 1)}${headerLine}${headerPadding}${BOX.vertical}\n`;

	// Column headers
	const colHeaders = `${BOX.vertical} St Name            Capability    State      Bead ID          Duration  Tmux ${BOX.vertical}`;
	output += `${CURSOR.cursorTo(startRow + 1, 1)}${colHeaders}\n`;

	// Separator
	const separator = horizontalLine(width, BOX.tee, BOX.horizontal, BOX.teeRight);
	output += `${CURSOR.cursorTo(startRow + 2, 1)}${separator}\n`;

	// Sort agents: active first
	const agents = [...data.status.agents].sort((a, b) => {
		const activeStates = ["working", "booting", "stalled"];
		const aActive = activeStates.includes(a.state);
		const bActive = activeStates.includes(b.state);
		if (aActive && !bActive) return -1;
		if (!aActive && bActive) return 1;
		return 0;
	});

	const now = Date.now();
	const maxRows = panelHeight - 4; // header + col headers + separator + border
	const visibleAgents = agents.slice(0, maxRows);

	for (let i = 0; i < visibleAgents.length; i++) {
		const agent = visibleAgents[i];
		if (!agent) continue;

		const icon = getStateIcon(agent.state);
		const stateColor = getStateColor(agent.state);
		const name = pad(truncate(agent.agentName, 15), 15);
		const capability = pad(truncate(agent.capability, 12), 12);
		const state = pad(agent.state, 10);
		const beadId = pad(truncate(agent.beadId, 16), 16);
		const endTime =
			agent.state === "completed" || agent.state === "zombie"
				? new Date(agent.lastActivity).getTime()
				: now;
		const duration = formatDuration(endTime - new Date(agent.startedAt).getTime());
		const durationPadded = pad(duration, 9);
		const tmuxAlive = data.status.tmuxSessions.some((s) => s.name === agent.tmuxSession);
		const tmuxDot = tmuxAlive ? `${color.green}●${color.reset}` : `${color.red}○${color.reset}`;

		const line = `${BOX.vertical} ${stateColor}${icon}${color.reset}  ${name} ${capability} ${stateColor}${state}${color.reset} ${beadId} ${durationPadded} ${tmuxDot}    ${BOX.vertical}`;
		output += `${CURSOR.cursorTo(startRow + 3 + i, 1)}${line}\n`;
	}

	// Bottom border (no filler rows)
	const bottomBorder = horizontalLine(width, BOX.tee, BOX.horizontal, BOX.teeRight);
	output += `${CURSOR.cursorTo(startRow + 3 + visibleAgents.length, 1)}${bottomBorder}\n`;

	return output;
}

/**
 * Render a single-line status bar with mail, merge queue, and metrics summary.
 */
function renderStatusBar(data: DashboardData, width: number, row: number): string {
	const mail = `Mail: ${data.status.unreadMailCount} unread`;
	const events = `Events: ${data.recentEvents.length}`;
	const merge = `Merge: ${data.mergeQueue.length} queued`;
	const sessions = `Sessions: ${data.metrics.totalSessions}`;
	const avgDur = `Avg: ${formatDuration(data.metrics.avgDuration)}`;
	const byCapability = Object.entries(data.metrics.byCapability)
		.map(([cap, count]) => `${cap}:${count}`)
		.join(" ");
	const content = `${mail} | ${events} | ${merge} | ${sessions} | ${avgDur}${byCapability ? ` | ${byCapability}` : ""}`;

	const line = `${BOX.bottomLeft}${BOX.horizontal} ${truncate(content, width - 4)} ${BOX.horizontal.repeat(Math.max(0, width - content.length - 5))}${BOX.bottomRight}`;
	return `${CURSOR.cursorTo(row, 1)}${line}`;
}

/**
 * Render the full dashboard.
 *
 * When active agents have captured output, the layout shifts to give the
 * output panes the largest share of screen real-estate:
 *
 *   Header (2 rows)
 *   Agent table (sized to content, capped at 25% of height)
 *   Agent output panes (fills remaining space minus footer)
 *   Status bar (1 row: mail count + merge queue count + metrics summary)
 *
 * When no output is available, the classic layout is used:
 *
 *   Header (2 rows)
 *   Agent table (40%)
 *   Mail (30%, left 60%) + Merge queue (30%, right 40%)
 *   Metrics footer (4 rows)
 */
function renderDashboard(data: DashboardData, interval: number): void {
	const width = process.stdout.columns ?? 100;
	const height = process.stdout.rows ?? 30;
	const hasOutput = data.agentOutput.size > 0;

	let output = CURSOR.clear;

	// Header (rows 1-2)
	output += renderHeader(width, interval);

	const agentPanelStart = 3;

	if (hasOutput) {
		// --- Compact layout: agent table + output panes + status bar ---

		// Agent table: sized to content, capped at 25% of screen
		const agentRows = data.status.agents.length;
		const agentTableRows = Math.min(agentRows, Math.floor(height * 0.25));
		// 4 = header row + column headers + separator + bottom border
		const agentPanelHeight = agentTableRows + 4;
		output += renderAgentPanelCompact(data, width, agentPanelHeight, agentPanelStart);

		// Status bar: 1 row at bottom for mail/merge/metrics summary
		const statusBarRow = height;

		// Output panes fill everything between agent table and status bar
		const outputStart = agentPanelStart + agentPanelHeight;
		const outputHeight = statusBarRow - outputStart;
		if (outputHeight > 4) {
			output += renderOutputPanel(data, width, outputHeight, outputStart);
		}

		// Compact status bar at bottom
		output += renderStatusBar(data, width, statusBarRow);
	} else {
		// --- Classic layout: full panels ---
		output += renderAgentPanel(data, width, height, agentPanelStart);

		const agentPanelHeight = Math.floor(height * 0.4);
		const middlePanelStart = agentPanelStart + agentPanelHeight + 1;

		// Three-column middle section: Mail | Events | Merge Queue
		const colWidth = Math.floor(width / 3);
		output += renderMailPanel(data, width, height, middlePanelStart, colWidth);

		const eventsCol = colWidth + 1;
		output += renderEventsPanel(data, width, height, middlePanelStart, eventsCol, colWidth);

		const mergeQueueCol = colWidth * 2 + 1;
		output += renderMergeQueuePanel(data, width, height, middlePanelStart, mergeQueueCol);

		const middlePanelHeight = Math.floor(height * 0.3);
		const metricsStart = middlePanelStart + middlePanelHeight + 1;
		output += renderMetricsPanel(data, width, height, metricsStart);
	}

	process.stdout.write(output);
}

/**
 * Entry point for `overstory dashboard [--interval <ms>]`.
 */
const DASHBOARD_HELP = `overstory dashboard — Live TUI dashboard for agent monitoring

Usage: overstory dashboard [--interval <ms>]

Options:
  --interval <ms>       Poll interval in milliseconds (default: 2000, min: 500)
  --launch-terminals    Open Windows Terminal panes tailing each agent's log
  --help, -h            Show this help

Dashboard panels:
  - Agent panel: Active agents with status, capability, bead ID, duration
  - Agent output: Live side-by-side output panes for active agents (auto-shown)
  - Mail panel: Recent messages with priority and time
  - Events panel: Recent tool/session events timeline
  - Merge queue: Pending/merging/conflict entries
  - Metrics: Session counts, avg duration, by-capability breakdown

When active agents are running, the layout switches to a compact mode that
maximizes output pane space (up to 4 agents side-by-side). When no agents
are active, the classic multi-panel layout is shown.

Press Ctrl+C to exit.`;

export async function dashboardCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${DASHBOARD_HELP}\n`);
		return;
	}

	const intervalStr = getFlag(args, "--interval");
	const interval = intervalStr ? Number.parseInt(intervalStr, 10) : 2000;

	if (Number.isNaN(interval) || interval < 500) {
		throw new ValidationError("--interval must be a number >= 500 (milliseconds)", {
			field: "interval",
			value: intervalStr,
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	// --launch-terminals: open Windows Terminal panes for active agents
	if (args.includes("--launch-terminals")) {
		const status = await gatherStatus(root, "orchestrator", false);
		const activeAgents = status.agents.filter(
			(a) => a.state === "working" || a.state === "booting" || a.state === "stalled",
		);
		await launchAgentPanes(activeAgents, join(root, ".overstory"));
	}

	// Hide cursor
	process.stdout.write(CURSOR.hideCursor);

	// Clean exit on Ctrl+C
	let running = true;
	process.on("SIGINT", () => {
		running = false;
		process.stdout.write(CURSOR.showCursor);
		process.stdout.write(CURSOR.clear);
		process.exit(0);
	});

	// Poll loop
	while (running) {
		const data = await loadDashboardData(root);
		renderDashboard(data, interval);
		await Bun.sleep(interval);
	}
}
