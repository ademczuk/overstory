/**
 * Windows turn-runner daemon.
 *
 * Bridges the gap between file-based IPC and Claude Code's single-shot
 * `-p` (print) mode on Windows. Claude Code's `-p` mode is always
 * single-shot: one conversation turn, then exit. Multi-turn requires
 * `--resume <session_id>` with separate process invocations.
 *
 * This daemon:
 * 1. Polls an inbox NDJSON file for new user messages
 * 2. For the FIRST message: spawns Claude Code with the original args
 *    (including --append-system-prompt) + -p + stream-json flags
 * 3. Extracts the session_id from the result output
 * 4. For SUBSEQUENT messages: spawns Claude Code with --resume <session_id>
 * 5. All stdout is appended to the output log file
 * 6. Handles the Claude Code "hang after result" bug with a kill timeout
 *
 * Usage:
 *   bun run src/worktree/win-relay.ts <inbox-path> <stdout-path> <stderr-path> <cwd> -- <claude-args...>
 *
 * The daemon writes the active Claude Code PID to <inbox-path>.pid
 * so the session backend can track the process.
 */

import { appendFile, readFile } from "node:fs/promises";

const POLL_INTERVAL_MS = 2000;
/** How often to poll the stdout file for result during a turn. */
const RESULT_POLL_MS = 2000;
/** Grace period after result detected before killing the process. */
const POST_RESULT_GRACE_MS = 5000;
/** Maximum time for a single turn before force-killing. */
const TURN_TIMEOUT_MS = 1_800_000; // 30 minutes

// Parse arguments: everything before "--" is relay config, after is the command
const separatorIdx = process.argv.indexOf("--");
if (separatorIdx === -1 || separatorIdx < 6) {
	process.stderr.write("Usage: bun run win-relay.ts <inbox> <stdout> <stderr> <cwd> -- <cmd...>\n");
	process.exit(1);
}

const inboxPath = process.argv[2] ?? "";
const stdoutPath = process.argv[3] ?? "";
const stderrPath = process.argv[4] ?? "";
const cwd = process.argv[5] ?? ".";
const firstTurnArgs = process.argv.slice(separatorIdx + 1);

const pidPath = `${inboxPath}.pid`;

// Ensure inbox file exists
const inboxFile = Bun.file(inboxPath);
if (!(await inboxFile.exists())) {
	await Bun.write(inboxPath, "");
}

// Write daemon PID initially (updated to Claude PID when running)
await Bun.write(pidPath, String(process.pid));

await log(`Turn-runner started: pid=${process.pid}`);
await log(`inbox=${inboxPath} stdout=${stdoutPath} stderr=${stderrPath} cwd=${cwd}`);

// Extract model and permissions flags from first-turn args for reuse
const model = extractFlag(firstTurnArgs, "--model");
const hasSkipPerms = firstTurnArgs.includes("--dangerously-skip-permissions");

let sessionId: string | null = null;
let linesProcessed = 0;

// Main event loop: poll inbox for messages, run turns
await log("Entering main loop...");

try {
	let loopCount = 0;
	while (true) {
		await Bun.sleep(POLL_INTERVAL_MS);
		loopCount++;

		if (loopCount <= 3 || loopCount % 10 === 0) {
			await log(`Poll #${loopCount}`);
		}

		const message = await getNextMessage();
		if (!message) continue;

		await log(`Got message (${message.length} chars), running turn...`);
		await runTurn(message);
		await log("Turn completed, resuming polling...");
	}
} catch (err) {
	await log(`FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
	process.exit(1);
}

// --- Functions ---

/** Read the inbox file and return the next unprocessed NDJSON line, or null. */
async function getNextMessage(): Promise<string | null> {
	try {
		// Use Node's fs.readFile instead of Bun.file().text() — the latter
		// may return stale/cached content on Windows with concurrent writes.
		const raw = await readFile(inboxPath, "utf-8");
		if (raw.length === 0) return null;

		const allLines = raw.split("\n");

		if (allLines.length > linesProcessed + 1) {
			await log(
				`Inbox: ${raw.length} chars, ${allLines.length} lines, linesProcessed=${linesProcessed}`,
			);
		}

		for (let i = linesProcessed; i < allLines.length; i++) {
			const trimmed = (allLines[i] ?? "").trim();
			if (trimmed.length === 0) {
				// Don't advance past the trailing empty element — when the file
				// is "msg1\n", split gives ["msg1", ""], and the empty "" at the
				// end will become "msg2" once the next message is appended.
				// Advancing past it would cause us to miss that message.
				if (i === allLines.length - 1) break;
				linesProcessed = i + 1;
				continue;
			}
			linesProcessed = i + 1;
			return trimmed;
		}
	} catch (err) {
		await log(`getNextMessage error: ${err}`);
	}
	return null;
}

/** Run a single Claude Code turn with the given NDJSON user message. */
async function runTurn(ndjsonMessage: string): Promise<void> {
	const args = buildArgs();

	await log(`Starting turn (session=${sessionId ?? "new"}, args=${args.length})`);
	await log(`  cmd: ${args.join(" ").slice(0, 200)}`);

	// Use a temporary stdout file for this turn so output is available
	// in real-time (not buffered until process exit).
	const turnStdout = `${stdoutPath}.turn`;

	// Clear turn file from previous run
	await Bun.write(turnStdout, "");

	// Spawn Claude Code for this turn
	const proc = Bun.spawn(args, {
		cwd,
		stdin: "pipe",
		stdout: Bun.file(turnStdout),
		stderr: Bun.file(`${stderrPath}.claude`),
		env: process.env,
	});

	await log(`Spawned Claude PID=${proc.pid}`);

	// Write Claude Code's PID so the session backend can track it
	await Bun.write(pidPath, String(proc.pid));

	// Pipe the NDJSON user message to stdin, then close stdin to signal EOF.
	// Bun's stdin is a FileSink with .write()/.end(), not a WritableStream.
	try {
		const sink = proc.stdin as unknown as {
			write(data: string | Uint8Array): number;
			end(): void;
			flush(): void;
		};
		sink.write(`${ndjsonMessage}\n`);
		sink.flush();
		sink.end();
		await log("Wrote to stdin and closed");
	} catch (err) {
		await log(`stdin write error: ${err}`);
	}

	// Poll the stdout file for the result message instead of waiting on
	// proc.exited — Claude Code has a known hang bug where the process
	// stays alive indefinitely after sending the result (GitHub #25629).
	let resultFound = false;
	let processExited = false;
	const startTime = Date.now();

	// Also listen for natural exit (in case it does exit cleanly)
	proc.exited
		.then(() => {
			processExited = true;
		})
		.catch(() => {
			processExited = true;
		});

	while (!resultFound && !processExited) {
		const elapsed = Date.now() - startTime;
		if (elapsed > TURN_TIMEOUT_MS) {
			await log(`Turn timed out after ${elapsed}ms, killing PID ${proc.pid}`);
			killProcess(proc.pid);
			break;
		}

		await Bun.sleep(RESULT_POLL_MS);

		// Check stdout file for result line
		try {
			const turnOutput = await readFile(turnStdout, "utf-8");
			if (turnOutput.length > 0) {
				for (const line of turnOutput.split("\n")) {
					const trimmed = line.trim();
					if (trimmed.length === 0) continue;
					try {
						const parsed = JSON.parse(trimmed);
						if (parsed.type === "result") {
							resultFound = true;
							if (parsed.session_id) {
								sessionId = parsed.session_id;
								await log(`Result found: session_id=${sessionId}`);
							} else {
								await log("Result found (no session_id)");
							}
							break;
						}
					} catch {
						// Not valid JSON — ignore
					}
				}
			}
		} catch {
			// File read error — non-fatal, retry next poll
		}

		// Log progress periodically
		const elapsedSec = Math.round(elapsed / 1000);
		if (elapsedSec > 0 && elapsedSec % 30 === 0) {
			try {
				const size = await readFile(turnStdout, "utf-8").then((t) => t.length);
				await log(`Waiting... ${elapsedSec}s elapsed, stdout=${size} chars`);
			} catch {
				await log(`Waiting... ${elapsedSec}s elapsed`);
			}
		}
	}

	// If result was found but process is still alive, give it a brief grace
	// period to exit naturally, then kill it (Claude Code hang bug workaround).
	if (resultFound && !processExited) {
		await log(`Result received, waiting ${POST_RESULT_GRACE_MS}ms for clean exit...`);
		await Bun.sleep(POST_RESULT_GRACE_MS);

		if (!processExited) {
			await log(`Process still alive after grace period, killing PID ${proc.pid}`);
			killProcess(proc.pid);
		} else {
			await log("Process exited cleanly after result");
		}
	}

	// Read the turn's stdout and append to the main output log
	try {
		const turnOutput = await readFile(turnStdout, "utf-8");
		if (turnOutput.length > 0) {
			await appendFile(stdoutPath, turnOutput);
			await log(`stdout: ${turnOutput.length} chars appended to main log`);
		} else {
			await log("stdout: 0 chars (empty)");
		}
	} catch (err) {
		await log(`stdout read error: ${err}`);
	}

	// Copy Claude's stderr to main stderr log
	try {
		const claudeStderrFile = `${stderrPath}.claude`;
		const claudeStderr = await readFile(claudeStderrFile, "utf-8").catch(() => "");
		if (claudeStderr.length > 0) {
			await appendFile(stderrPath, claudeStderr);
			await log(`Claude stderr: ${claudeStderr.length} chars`);
		}
	} catch {
		// Non-fatal
	}

	// Reset PID file to relay PID (no active Claude process)
	await Bun.write(pidPath, String(process.pid));
}

/** Kill a process, handling the case where it's already dead. */
function killProcess(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already dead
	}
}

/** Build the args array for the current turn. */
function buildArgs(): string[] {
	if (sessionId === null) {
		// First turn: use original args + stream-json flags
		const args = [...firstTurnArgs];

		// Add -p if not present (required for non-interactive mode)
		if (!args.includes("-p") && !args.includes("--print")) {
			args.splice(1, 0, "-p");
		}

		// Add stream-json flags
		if (!args.includes("--input-format")) {
			args.push("--input-format", "stream-json");
		}
		if (!args.includes("--output-format")) {
			args.push("--output-format", "stream-json");
		}
		if (!args.includes("--verbose")) {
			args.push("--verbose");
		}

		return args;
	}

	// Subsequent turns: minimal args + --resume
	const args = [
		"claude",
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
	];

	if (model) {
		args.push("--model", model);
	}
	if (hasSkipPerms) {
		args.push("--dangerously-skip-permissions");
	}

	args.push("--resume", sessionId);

	return args;
}

/** Extract a flag value from an args array (e.g., --model opus -> "opus"). */
function extractFlag(args: string[], flag: string): string | null {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) return null;
	return args[idx + 1] ?? null;
}

/** Append a timestamped log line to the stderr file. */
async function log(message: string): Promise<void> {
	try {
		const ts = new Date().toISOString();
		await appendFile(stderrPath, `[win-relay ${ts}] ${message}\n`);
	} catch {
		// Non-fatal
	}
}
