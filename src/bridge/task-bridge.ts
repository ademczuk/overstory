/**
 * Bridge: projects Overstory protocol mail events into Claude Code Task files.
 *
 * Claude Code stores tasks as numbered JSON files in ~/.claude/tasks/{team}/.
 * This bridge writes those files directly (via Bun.file/Bun.write) to give
 * the human operator native Task UI visibility into agent fleet coordination.
 *
 * The bridge is best-effort and never blocking. If it fails, mail delivery
 * still succeeds. After MAX_CONSECUTIVE_FAILURES, the bridge auto-disables
 * for the remainder of the session (circuit breaker).
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getHomeDir } from "../platform.ts";
import type {
	AssignPayload,
	DispatchPayload,
	EscalationPayload,
	MergedPayload,
	MergeFailedPayload,
	MergeReadyPayload,
	WorkerDonePayload,
} from "../types.ts";

/** Shape of a Claude Code task file (discovered from ~/.claude/tasks/). */
export interface CCTask {
	id: string;
	subject: string;
	description: string;
	activeForm: string;
	owner: string | null;
	status: "pending" | "in_progress" | "completed";
	blocks: string[];
	blockedBy: string[];
}

/** Shape of a Claude Code team config file. */
export interface CCTeamConfig {
	name: string;
	description: string;
	createdAt: number;
	leadAgentId: string;
	leadSessionId: string;
	members: CCTeamMember[];
}

export interface CCTeamMember {
	agentId: string;
	name: string;
	agentType: string;
	model: string;
	joinedAt: number;
	tmuxPaneId: string;
	cwd: string;
	subscriptions: string[];
	backendType?: string;
}

/** Row shape for the bridge_tasks mapping table. */
interface BridgeTaskRow {
	bead_id: string;
	cc_task_id: string;
	cc_team_name: string;
	agent_name: string | null;
	status: string;
	created_at: string;
}

const CREATE_BRIDGE_TABLE = `
CREATE TABLE IF NOT EXISTS bridge_tasks (
  bead_id TEXT PRIMARY KEY,
  cc_task_id TEXT NOT NULL,
  cc_team_name TEXT NOT NULL,
  agent_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Resolve the Claude Code data directory (~/.claude).
 */
function getClaudeDir(): string {
	return join(getHomeDir(), ".claude");
}

/**
 * BridgeStore: SQLite table mapping Overstory bead IDs to Claude Code task IDs.
 */
export class BridgeStore {
	private db: Database;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.exec("PRAGMA journal_mode=WAL");
		this.db.exec("PRAGMA busy_timeout=5000");
		this.db.exec(CREATE_BRIDGE_TABLE);
	}

	getByBead(beadId: string): BridgeTaskRow | null {
		return this.db
			.prepare("SELECT * FROM bridge_tasks WHERE bead_id = ?")
			.get(beadId) as BridgeTaskRow | null;
	}

	insert(beadId: string, ccTaskId: string, teamName: string, agentName?: string): void {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO bridge_tasks (bead_id, cc_task_id, cc_team_name, agent_name) VALUES (?, ?, ?, ?)",
			)
			.run(beadId, ccTaskId, teamName, agentName ?? null);
	}

	updateStatus(beadId: string, status: string): void {
		this.db.prepare("UPDATE bridge_tasks SET status = ? WHERE bead_id = ?").run(status, beadId);
	}

	updateAgent(beadId: string, agentName: string): void {
		this.db
			.prepare("UPDATE bridge_tasks SET agent_name = ? WHERE bead_id = ?")
			.run(agentName, beadId);
	}

	getAll(): BridgeTaskRow[] {
		return this.db
			.prepare("SELECT * FROM bridge_tasks ORDER BY created_at DESC")
			.all() as BridgeTaskRow[];
	}

	getTeamName(): string | null {
		const row = this.db.prepare("SELECT cc_team_name FROM bridge_tasks LIMIT 1").get() as {
			cc_team_name: string;
		} | null;
		return row?.cc_team_name ?? null;
	}

	purge(): number {
		const count = this.db.prepare("SELECT COUNT(*) as cnt FROM bridge_tasks").get() as {
			cnt: number;
		} | null;
		this.db.prepare("DELETE FROM bridge_tasks").run();
		return count?.cnt ?? 0;
	}

	close(): void {
		try {
			this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
		} catch {
			// Best effort
		}
		this.db.close();
	}
}

/**
 * TaskBridge: projects Overstory protocol events into Claude Code Task files.
 *
 * Methods are called by the BridgedMailClient after each sendProtocol() call.
 * All errors are caught internally (circuit breaker pattern).
 */
export class TaskBridge {
	private store: BridgeStore;
	private teamName: string;
	private claudeDir: string;
	private consecutiveFailures = 0;
	private disabled = false;

	constructor(store: BridgeStore, teamName: string, claudeDir?: string) {
		this.store = store;
		this.teamName = teamName;
		this.claudeDir = claudeDir ?? getClaudeDir();
	}

	get isDisabled(): boolean {
		return this.disabled;
	}

	/**
	 * Create the Claude Code team directory and config file.
	 * Called once when the coordinator starts.
	 */
	async createTeam(opts: {
		projectName: string;
		projectRoot: string;
		sessionId?: string;
	}): Promise<void> {
		const claudeDir = this.claudeDir;
		const teamDir = join(claudeDir, "teams", this.teamName);
		const taskDir = join(claudeDir, "tasks", this.teamName);

		await mkdir(join(teamDir, "inboxes"), { recursive: true });
		await mkdir(taskDir, { recursive: true });

		const config: CCTeamConfig = {
			name: this.teamName,
			description: `Overstory agent fleet for ${opts.projectName}`,
			createdAt: Date.now(),
			leadAgentId: `orchestrator@${this.teamName}`,
			leadSessionId: opts.sessionId ?? "",
			members: [
				{
					agentId: `orchestrator@${this.teamName}`,
					name: "orchestrator",
					agentType: "team-lead",
					model: "claude-opus-4-6",
					joinedAt: Date.now(),
					tmuxPaneId: "",
					cwd: opts.projectRoot,
					subscriptions: [],
				},
			],
		};

		await Bun.write(join(teamDir, "config.json"), JSON.stringify(config, null, 2));
		await Bun.write(join(taskDir, ".highwatermark"), "0");
		await Bun.write(join(taskDir, ".lock"), "");
	}

	/**
	 * Add an agent to the team config's members array.
	 */
	async addTeamMember(member: {
		name: string;
		agentType: string;
		cwd: string;
		model?: string;
	}): Promise<void> {
		await this.guard(async () => {
			const configPath = join(this.claudeDir, "teams", this.teamName, "config.json");
			const file = Bun.file(configPath);
			if (!(await file.exists())) return;

			const config = (await file.json()) as CCTeamConfig;
			if (config.members.some((m) => m.name === member.name)) return;

			config.members.push({
				agentId: `${member.name}@${this.teamName}`,
				name: member.name,
				agentType: member.agentType,
				model: member.model ?? "claude-sonnet-4-5-20250929",
				joinedAt: Date.now(),
				tmuxPaneId: "in-process",
				cwd: member.cwd,
				subscriptions: [],
				backendType: "in-process",
			});

			await Bun.write(configPath, JSON.stringify(config, null, 2));
		});
	}

	async onDispatch(payload: DispatchPayload, from: string, to: string): Promise<void> {
		await this.guard(async () => {
			const taskId = await this.nextTaskId();
			const task: CCTask = {
				id: taskId,
				subject: `[${payload.capability}] Bead ${payload.beadId}`,
				description: [
					`Dispatched by ${from} to ${to}`,
					`Bead: ${payload.beadId}`,
					`Capability: ${payload.capability}`,
					`Spec: ${payload.specPath}`,
					payload.fileScope.length > 0 ? `File scope: ${payload.fileScope.join(", ")}` : "",
				]
					.filter(Boolean)
					.join("\n"),
				activeForm: `Working on ${payload.beadId}`,
				owner: null,
				status: "pending",
				blocks: [],
				blockedBy: [],
			};
			await this.writeTask(task);
			this.store.insert(payload.beadId, taskId, this.teamName, to);
		});
	}

	async onAssign(payload: AssignPayload): Promise<void> {
		await this.guard(async () => {
			const existing = this.store.getByBead(payload.beadId);
			if (existing) {
				const task = await this.readTask(existing.cc_task_id);
				if (task) {
					task.owner = payload.workerName;
					task.status = "in_progress";
					task.activeForm = `${payload.workerName} implementing ${payload.beadId}`;
					await this.writeTask(task);
				}
				this.store.updateAgent(payload.beadId, payload.workerName);
				this.store.updateStatus(payload.beadId, "in_progress");
			} else {
				const taskId = await this.nextTaskId();
				const task: CCTask = {
					id: taskId,
					subject: `[assign] Bead ${payload.beadId} → ${payload.workerName}`,
					description: `Worker: ${payload.workerName}\nBranch: ${payload.branch}\nSpec: ${payload.specPath}`,
					activeForm: `${payload.workerName} implementing ${payload.beadId}`,
					owner: payload.workerName,
					status: "in_progress",
					blocks: [],
					blockedBy: [],
				};
				await this.writeTask(task);
				this.store.insert(payload.beadId, taskId, this.teamName, payload.workerName);
			}
		});
	}

	async onWorkerDone(payload: WorkerDonePayload, from: string): Promise<void> {
		await this.guard(async () => {
			const existing = this.store.getByBead(payload.beadId);
			if (existing) {
				const task = await this.readTask(existing.cc_task_id);
				if (task) {
					task.status = "completed";
					task.description += `\n\n--- Completed by ${from} ---\nExit code: ${payload.exitCode}\nFiles: ${payload.filesModified.join(", ")}`;
					await this.writeTask(task);
				}
				this.store.updateStatus(payload.beadId, "completed");
			}
		});
	}

	async onMergeReady(payload: MergeReadyPayload): Promise<void> {
		await this.guard(async () => {
			const taskId = await this.nextTaskId();
			const task: CCTask = {
				id: taskId,
				subject: `[merge] ${payload.branch} ready`,
				description: `Branch: ${payload.branch}\nBead: ${payload.beadId}\nAgent: ${payload.agentName}\nFiles: ${payload.filesModified.join(", ")}`,
				activeForm: `Merging ${payload.branch}`,
				owner: null,
				status: "pending",
				blocks: [],
				blockedBy: [],
			};

			const existing = this.store.getByBead(payload.beadId);
			if (existing) {
				task.blockedBy = [existing.cc_task_id];
			}

			await this.writeTask(task);
		});
	}

	async onMerged(payload: MergedPayload): Promise<void> {
		await this.guard(async () => {
			const existing = this.store.getByBead(payload.beadId);
			if (existing) {
				const task = await this.readTask(existing.cc_task_id);
				if (task) {
					task.description += `\n\n--- Merged (tier: ${payload.tier}) ---`;
					await this.writeTask(task);
				}
			}
		});
	}

	async onMergeFailed(payload: MergeFailedPayload): Promise<void> {
		await this.guard(async () => {
			const existing = this.store.getByBead(payload.beadId);
			if (existing) {
				const task = await this.readTask(existing.cc_task_id);
				if (task) {
					task.description += `\n\n--- Merge FAILED ---\nConflicts: ${payload.conflictFiles.join(", ")}\nError: ${payload.errorMessage}`;
					await this.writeTask(task);
				}
			}
		});
	}

	async onEscalation(payload: EscalationPayload, from: string): Promise<void> {
		await this.guard(async () => {
			const taskId = await this.nextTaskId();
			const task: CCTask = {
				id: taskId,
				subject: `[${payload.severity}] Escalation from ${from}`,
				description: [
					`Severity: ${payload.severity}`,
					payload.beadId ? `Bead: ${payload.beadId}` : "",
					`Context: ${payload.context}`,
				]
					.filter(Boolean)
					.join("\n"),
				activeForm: `Handling escalation from ${from}`,
				owner: null,
				status: "pending",
				blocks: [],
				blockedBy: [],
			};
			await this.writeTask(task);
		});
	}

	getTeamName(): string {
		return this.teamName;
	}

	getStore(): BridgeStore {
		return this.store;
	}

	// --- Private helpers ---

	private async guard(fn: () => Promise<void>): Promise<void> {
		if (this.disabled) return;
		try {
			await fn();
			this.consecutiveFailures = 0;
		} catch {
			this.consecutiveFailures++;
			if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				this.disabled = true;
			}
		}
	}

	private async nextTaskId(): Promise<string> {
		const hwmPath = join(this.claudeDir, "tasks", this.teamName, ".highwatermark");
		const file = Bun.file(hwmPath);

		let current = 0;
		if (await file.exists()) {
			const text = (await file.text()).trim();
			current = Number.parseInt(text, 10) || 0;
		}

		const next = current + 1;
		await Bun.write(hwmPath, String(next));
		return String(next);
	}

	private async writeTask(task: CCTask): Promise<void> {
		const taskPath = join(this.claudeDir, "tasks", this.teamName, `${task.id}.json`);
		await Bun.write(taskPath, JSON.stringify(task, null, 2));
	}

	private async readTask(taskId: string): Promise<CCTask | null> {
		const taskPath = join(this.claudeDir, "tasks", this.teamName, `${taskId}.json`);
		const file = Bun.file(taskPath);
		if (!(await file.exists())) return null;
		return (await file.json()) as CCTask;
	}
}

/**
 * Create a TaskBridge instance for a project.
 */
export function createTaskBridge(
	overstoryDir: string,
	teamName: string,
	claudeDir?: string,
): TaskBridge {
	const dbPath = join(overstoryDir, "bridge.db");
	const store = new BridgeStore(dbPath);
	return new TaskBridge(store, teamName, claudeDir);
}

/**
 * Resolve the bridge team name for a project.
 */
export function resolveBridgeTeamName(projectName: string, configOverride: string | null): string {
	return configOverride ?? `overstory-${projectName}`;
}
