import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import {
	BridgeStore,
	type CCTask,
	type CCTeamConfig,
	createTaskBridge,
	resolveBridgeTeamName,
	type TaskBridge,
} from "./task-bridge.ts";

describe("resolveBridgeTeamName", () => {
	test("uses project name when no override", () => {
		expect(resolveBridgeTeamName("myapp", null)).toBe("overstory-myapp");
	});

	test("uses override when provided", () => {
		expect(resolveBridgeTeamName("myapp", "custom-team")).toBe("custom-team");
	});
});

describe("BridgeStore", () => {
	let tempDir: string;
	let store: BridgeStore;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-bridge-store-test-"));
		store = new BridgeStore(join(tempDir, "bridge.db"));
	});

	afterEach(async () => {
		store.close();
		await cleanupTempDir(tempDir);
	});

	test("insert and getByBead", () => {
		store.insert("bead-1", "1", "test-team", "builder-1");
		const row = store.getByBead("bead-1");
		expect(row).not.toBeNull();
		expect(row?.bead_id).toBe("bead-1");
		expect(row?.cc_task_id).toBe("1");
		expect(row?.cc_team_name).toBe("test-team");
		expect(row?.agent_name).toBe("builder-1");
		expect(row?.status).toBe("pending");
	});

	test("getByBead returns null for missing bead", () => {
		expect(store.getByBead("nonexistent")).toBeNull();
	});

	test("updateStatus changes status", () => {
		store.insert("bead-1", "1", "test-team");
		store.updateStatus("bead-1", "in_progress");
		const row = store.getByBead("bead-1");
		expect(row?.status).toBe("in_progress");
	});

	test("updateAgent changes agent_name", () => {
		store.insert("bead-1", "1", "test-team");
		store.updateAgent("bead-1", "scout-1");
		const row = store.getByBead("bead-1");
		expect(row?.agent_name).toBe("scout-1");
	});

	test("getAll returns all rows ordered by created_at DESC", () => {
		store.insert("bead-1", "1", "test-team");
		store.insert("bead-2", "2", "test-team");
		const rows = store.getAll();
		expect(rows).toHaveLength(2);
	});

	test("getTeamName returns team name from first row", () => {
		expect(store.getTeamName()).toBeNull();
		store.insert("bead-1", "1", "my-team");
		expect(store.getTeamName()).toBe("my-team");
	});

	test("purge clears all rows and returns count", () => {
		store.insert("bead-1", "1", "t");
		store.insert("bead-2", "2", "t");
		const purged = store.purge();
		expect(purged).toBe(2);
		expect(store.getAll()).toHaveLength(0);
	});

	test("insert with same bead_id replaces existing row", () => {
		store.insert("bead-1", "1", "team-a", "agent-old");
		store.insert("bead-1", "2", "team-b", "agent-new");
		const row = store.getByBead("bead-1");
		expect(row?.cc_task_id).toBe("2");
		expect(row?.agent_name).toBe("agent-new");
		expect(store.getAll()).toHaveLength(1);
	});
});

describe("TaskBridge", () => {
	let tempDir: string;
	let claudeDir: string;
	let overstoryDir: string;
	let bridge: TaskBridge;
	const teamName = "overstory-test-project";

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-bridge-test-"));
		claudeDir = join(tempDir, ".claude");
		overstoryDir = join(tempDir, ".overstory");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(overstoryDir, { recursive: true });
		bridge = createTaskBridge(overstoryDir, teamName, claudeDir);
	});

	afterEach(async () => {
		bridge.getStore().close();
		await cleanupTempDir(tempDir);
	});

	describe("createTeam", () => {
		test("creates team config and task directories", async () => {
			await bridge.createTeam({
				projectName: "test-project",
				projectRoot: "/tmp/test-project",
			});

			const configFile = Bun.file(join(claudeDir, "teams", teamName, "config.json"));
			expect(await configFile.exists()).toBe(true);

			const config = (await configFile.json()) as CCTeamConfig;
			expect(config.name).toBe(teamName);
			expect(config.description).toContain("test-project");
			expect(config.members).toHaveLength(1);
			expect(config.members[0]?.name).toBe("orchestrator");
			expect(config.members[0]?.agentType).toBe("team-lead");

			// Highwatermark file created
			const hwm = Bun.file(join(claudeDir, "tasks", teamName, ".highwatermark"));
			expect(await hwm.exists()).toBe(true);
			expect((await hwm.text()).trim()).toBe("0");
		});

		test("includes sessionId when provided", async () => {
			await bridge.createTeam({
				projectName: "test-project",
				projectRoot: "/tmp/test-project",
				sessionId: "session-abc-123",
			});

			const config = (await Bun.file(
				join(claudeDir, "teams", teamName, "config.json"),
			).json()) as CCTeamConfig;
			expect(config.leadSessionId).toBe("session-abc-123");
		});
	});

	describe("addTeamMember", () => {
		test("adds member to team config", async () => {
			await bridge.createTeam({
				projectName: "test-project",
				projectRoot: "/tmp/test-project",
			});

			await bridge.addTeamMember({
				name: "builder-1",
				agentType: "builder",
				cwd: "/tmp/test-project/worktrees/builder-1",
			});

			const config = (await Bun.file(
				join(claudeDir, "teams", teamName, "config.json"),
			).json()) as CCTeamConfig;
			expect(config.members).toHaveLength(2);
			expect(config.members[1]?.name).toBe("builder-1");
			expect(config.members[1]?.agentType).toBe("builder");
			expect(config.members[1]?.backendType).toBe("in-process");
		});

		test("does not duplicate existing member", async () => {
			await bridge.createTeam({
				projectName: "test-project",
				projectRoot: "/tmp/test-project",
			});

			await bridge.addTeamMember({
				name: "builder-1",
				agentType: "builder",
				cwd: "/tmp/wt",
			});
			await bridge.addTeamMember({
				name: "builder-1",
				agentType: "builder",
				cwd: "/tmp/wt",
			});

			const config = (await Bun.file(
				join(claudeDir, "teams", teamName, "config.json"),
			).json()) as CCTeamConfig;
			expect(config.members).toHaveLength(2);
		});
	});

	describe("onDispatch", () => {
		test("creates task file and bridge record", async () => {
			await bridge.createTeam({
				projectName: "test-project",
				projectRoot: "/tmp/test-project",
			});

			await bridge.onDispatch(
				{
					beadId: "bead-abc",
					specPath: ".overstory/specs/bead-abc.md",
					capability: "builder",
					fileScope: ["src/foo.ts", "src/bar.ts"],
				},
				"orchestrator",
				"builder-1",
			);

			// Task file should exist
			const taskFile = Bun.file(join(claudeDir, "tasks", teamName, "1.json"));
			expect(await taskFile.exists()).toBe(true);

			const task = (await taskFile.json()) as CCTask;
			expect(task.id).toBe("1");
			expect(task.subject).toContain("builder");
			expect(task.subject).toContain("bead-abc");
			expect(task.description).toContain("orchestrator");
			expect(task.description).toContain("builder-1");
			expect(task.description).toContain("src/foo.ts");
			expect(task.status).toBe("pending");
			expect(task.owner).toBeNull();

			// Bridge record should exist
			const row = bridge.getStore().getByBead("bead-abc");
			expect(row).not.toBeNull();
			expect(row?.cc_task_id).toBe("1");
			expect(row?.agent_name).toBe("builder-1");

			// Highwatermark should be incremented
			const hwm = await Bun.file(join(claudeDir, "tasks", teamName, ".highwatermark")).text();
			expect(hwm.trim()).toBe("1");
		});

		test("auto-increments task IDs", async () => {
			await bridge.createTeam({
				projectName: "p",
				projectRoot: "/tmp/p",
			});

			await bridge.onDispatch(
				{ beadId: "bead-1", specPath: "", capability: "scout", fileScope: [] },
				"orch",
				"scout-1",
			);
			await bridge.onDispatch(
				{ beadId: "bead-2", specPath: "", capability: "builder", fileScope: [] },
				"orch",
				"builder-1",
			);

			const task1 = Bun.file(join(claudeDir, "tasks", teamName, "1.json"));
			const task2 = Bun.file(join(claudeDir, "tasks", teamName, "2.json"));
			expect(await task1.exists()).toBe(true);
			expect(await task2.exists()).toBe(true);

			const hwm = await Bun.file(join(claudeDir, "tasks", teamName, ".highwatermark")).text();
			expect(hwm.trim()).toBe("2");
		});
	});

	describe("onAssign", () => {
		test("updates existing task to in_progress with owner", async () => {
			await bridge.createTeam({
				projectName: "p",
				projectRoot: "/tmp/p",
			});

			await bridge.onDispatch(
				{ beadId: "bead-1", specPath: "", capability: "builder", fileScope: [] },
				"orch",
				"builder-1",
			);

			await bridge.onAssign({
				beadId: "bead-1",
				specPath: ".overstory/specs/bead-1.md",
				workerName: "builder-1",
				branch: "overstory/builder-1",
			});

			const task = (await Bun.file(join(claudeDir, "tasks", teamName, "1.json")).json()) as CCTask;
			expect(task.status).toBe("in_progress");
			expect(task.owner).toBe("builder-1");

			const row = bridge.getStore().getByBead("bead-1");
			expect(row?.status).toBe("in_progress");
			expect(row?.agent_name).toBe("builder-1");
		});

		test("creates new task when no prior dispatch", async () => {
			await bridge.createTeam({
				projectName: "p",
				projectRoot: "/tmp/p",
			});

			await bridge.onAssign({
				beadId: "bead-new",
				specPath: "",
				workerName: "scout-1",
				branch: "overstory/scout-1",
			});

			const task = (await Bun.file(join(claudeDir, "tasks", teamName, "1.json")).json()) as CCTask;
			expect(task.owner).toBe("scout-1");
			expect(task.status).toBe("in_progress");
		});
	});

	describe("onWorkerDone", () => {
		test("marks task as completed", async () => {
			await bridge.createTeam({
				projectName: "p",
				projectRoot: "/tmp/p",
			});

			await bridge.onDispatch(
				{ beadId: "bead-1", specPath: "", capability: "builder", fileScope: [] },
				"orch",
				"builder-1",
			);

			await bridge.onWorkerDone(
				{
					beadId: "bead-1",
					branch: "overstory/builder-1",
					exitCode: 0,
					filesModified: ["src/foo.ts"],
				},
				"builder-1",
			);

			const task = (await Bun.file(join(claudeDir, "tasks", teamName, "1.json")).json()) as CCTask;
			expect(task.status).toBe("completed");
			expect(task.description).toContain("Completed by builder-1");
			expect(task.description).toContain("Exit code: 0");

			const row = bridge.getStore().getByBead("bead-1");
			expect(row?.status).toBe("completed");
		});

		test("no-op when bead not found", async () => {
			await bridge.createTeam({
				projectName: "p",
				projectRoot: "/tmp/p",
			});

			// Should not throw
			await bridge.onWorkerDone(
				{
					beadId: "nonexistent",
					branch: "overstory/x",
					exitCode: 0,
					filesModified: [],
				},
				"agent-x",
			);
		});
	});

	describe("onMergeReady", () => {
		test("creates a merge task", async () => {
			await bridge.createTeam({
				projectName: "p",
				projectRoot: "/tmp/p",
			});

			await bridge.onMergeReady({
				branch: "overstory/builder-1",
				beadId: "bead-1",
				agentName: "builder-1",
				filesModified: ["src/a.ts", "src/b.ts"],
			});

			const task = (await Bun.file(join(claudeDir, "tasks", teamName, "1.json")).json()) as CCTask;
			expect(task.subject).toContain("merge");
			expect(task.description).toContain("overstory/builder-1");
			expect(task.status).toBe("pending");
		});

		test("sets blockedBy when dispatch task exists", async () => {
			await bridge.createTeam({
				projectName: "p",
				projectRoot: "/tmp/p",
			});

			await bridge.onDispatch(
				{ beadId: "bead-1", specPath: "", capability: "builder", fileScope: [] },
				"orch",
				"builder-1",
			);

			await bridge.onMergeReady({
				branch: "overstory/builder-1",
				beadId: "bead-1",
				agentName: "builder-1",
				filesModified: ["src/a.ts"],
			});

			const mergeTask = (await Bun.file(
				join(claudeDir, "tasks", teamName, "2.json"),
			).json()) as CCTask;
			expect(mergeTask.blockedBy).toContain("1");
		});
	});

	describe("onMerged", () => {
		test("appends merge info to task description", async () => {
			await bridge.createTeam({
				projectName: "p",
				projectRoot: "/tmp/p",
			});

			await bridge.onDispatch(
				{ beadId: "bead-1", specPath: "", capability: "builder", fileScope: [] },
				"orch",
				"builder-1",
			);

			await bridge.onMerged({
				branch: "overstory/builder-1",
				beadId: "bead-1",
				tier: "clean-merge",
			});

			const task = (await Bun.file(join(claudeDir, "tasks", teamName, "1.json")).json()) as CCTask;
			expect(task.description).toContain("Merged (tier: clean-merge)");
		});
	});

	describe("onMergeFailed", () => {
		test("appends failure info to task description", async () => {
			await bridge.createTeam({
				projectName: "p",
				projectRoot: "/tmp/p",
			});

			await bridge.onDispatch(
				{ beadId: "bead-1", specPath: "", capability: "builder", fileScope: [] },
				"orch",
				"builder-1",
			);

			await bridge.onMergeFailed({
				branch: "overstory/builder-1",
				beadId: "bead-1",
				conflictFiles: ["src/a.ts", "src/b.ts"],
				errorMessage: "conflicting changes",
			});

			const task = (await Bun.file(join(claudeDir, "tasks", teamName, "1.json")).json()) as CCTask;
			expect(task.description).toContain("Merge FAILED");
			expect(task.description).toContain("src/a.ts");
			expect(task.description).toContain("conflicting changes");
		});
	});

	describe("onEscalation", () => {
		test("creates an escalation task", async () => {
			await bridge.createTeam({
				projectName: "p",
				projectRoot: "/tmp/p",
			});

			await bridge.onEscalation(
				{
					severity: "critical",
					beadId: "bead-1",
					context: "Out of memory during build",
				},
				"builder-1",
			);

			const task = (await Bun.file(join(claudeDir, "tasks", teamName, "1.json")).json()) as CCTask;
			expect(task.subject).toContain("critical");
			expect(task.subject).toContain("builder-1");
			expect(task.description).toContain("Out of memory during build");
			expect(task.status).toBe("pending");
		});
	});

	describe("circuit breaker", () => {
		test("disables bridge after 3 consecutive failures", async () => {
			// Don't create team directories — all operations will fail
			expect(bridge.isDisabled).toBe(false);

			// Each dispatch will fail because task directory doesn't exist
			await bridge.onDispatch(
				{ beadId: "b1", specPath: "", capability: "scout", fileScope: [] },
				"o",
				"a",
			);
			expect(bridge.isDisabled).toBe(false);

			await bridge.onDispatch(
				{ beadId: "b2", specPath: "", capability: "scout", fileScope: [] },
				"o",
				"a",
			);
			expect(bridge.isDisabled).toBe(false);

			await bridge.onDispatch(
				{ beadId: "b3", specPath: "", capability: "scout", fileScope: [] },
				"o",
				"a",
			);
			expect(bridge.isDisabled).toBe(true);

			// Subsequent calls should be no-ops (no error thrown)
			await bridge.onDispatch(
				{ beadId: "b4", specPath: "", capability: "scout", fileScope: [] },
				"o",
				"a",
			);
		});

		test("resets failure count on success", async () => {
			await bridge.createTeam({
				projectName: "p",
				projectRoot: "/tmp/p",
			});

			// 2 failures (won't trip breaker)
			const badBridge = createTaskBridge(
				overstoryDir,
				teamName,
				join(tempDir, "nonexistent-claude"),
			);
			await badBridge.onDispatch(
				{ beadId: "b1", specPath: "", capability: "scout", fileScope: [] },
				"o",
				"a",
			);
			await badBridge.onDispatch(
				{ beadId: "b2", specPath: "", capability: "scout", fileScope: [] },
				"o",
				"a",
			);
			expect(badBridge.isDisabled).toBe(false);
			badBridge.getStore().close();
		});
	});

	describe("full protocol flow", () => {
		test("dispatch → assign → worker_done lifecycle", async () => {
			await bridge.createTeam({
				projectName: "test-project",
				projectRoot: "/tmp/test-project",
			});

			// 1. Dispatch
			await bridge.onDispatch(
				{
					beadId: "bead-lifecycle",
					specPath: ".overstory/specs/bead-lifecycle.md",
					capability: "builder",
					fileScope: ["src/main.ts"],
				},
				"orchestrator",
				"builder-1",
			);

			let task = (await Bun.file(join(claudeDir, "tasks", teamName, "1.json")).json()) as CCTask;
			expect(task.status).toBe("pending");
			expect(task.owner).toBeNull();

			// 2. Assign
			await bridge.onAssign({
				beadId: "bead-lifecycle",
				specPath: ".overstory/specs/bead-lifecycle.md",
				workerName: "builder-1",
				branch: "overstory/builder-1",
			});

			task = (await Bun.file(join(claudeDir, "tasks", teamName, "1.json")).json()) as CCTask;
			expect(task.status).toBe("in_progress");
			expect(task.owner).toBe("builder-1");

			// 3. Worker done
			await bridge.onWorkerDone(
				{
					beadId: "bead-lifecycle",
					branch: "overstory/builder-1",
					exitCode: 0,
					filesModified: ["src/main.ts"],
				},
				"builder-1",
			);

			task = (await Bun.file(join(claudeDir, "tasks", teamName, "1.json")).json()) as CCTask;
			expect(task.status).toBe("completed");
			expect(task.description).toContain("Completed by builder-1");

			// Bridge store reflects final state
			const row = bridge.getStore().getByBead("bead-lifecycle");
			expect(row?.status).toBe("completed");
		});
	});
});

describe("createTaskBridge", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-bridge-factory-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("creates bridge with store and team name", () => {
		const bridge = createTaskBridge(tempDir, "my-team", join(tempDir, ".claude"));
		expect(bridge.getTeamName()).toBe("my-team");
		expect(bridge.getStore()).toBeDefined();
		expect(bridge.isDisabled).toBe(false);
		bridge.getStore().close();
	});
});
