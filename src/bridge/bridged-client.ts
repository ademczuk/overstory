/**
 * Bridged mail client: wraps MailClient to project protocol messages
 * into Claude Code Task files via TaskBridge.
 *
 * The decorator intercepts sendProtocol() calls. Bridge errors are
 * caught and never propagated — mail delivery always succeeds.
 */

import type { MailClient } from "../mail/client.ts";
import { createMailClient } from "../mail/client.ts";
import type { MailStore } from "../mail/store.ts";
import type {
	AssignPayload,
	DispatchPayload,
	EscalationPayload,
	MailMessage,
	MailPayloadMap,
	MailProtocolType,
	MergedPayload,
	MergeFailedPayload,
	MergeReadyPayload,
	WorkerDonePayload,
} from "../types.ts";
import type { TaskBridge } from "./task-bridge.ts";

/**
 * Create a bridged mail client that projects protocol messages into CC Tasks.
 *
 * All MailClient methods are delegated to the underlying client.
 * sendProtocol() additionally invokes the TaskBridge for protocol types
 * that map to task operations (dispatch, assign, worker_done, etc.).
 *
 * @param store - The underlying MailStore for persistence
 * @param bridge - TaskBridge for projecting to Claude Code Tasks
 */
export function createBridgedMailClient(store: MailStore, bridge: TaskBridge): MailClient {
	const inner = createMailClient(store);

	return {
		send: inner.send.bind(inner),
		check: inner.check.bind(inner),
		checkInject: inner.checkInject.bind(inner),
		list: inner.list.bind(inner),
		markRead: inner.markRead.bind(inner),
		reply: inner.reply.bind(inner),
		close: inner.close.bind(inner),

		sendProtocol<T extends MailProtocolType>(msg: {
			from: string;
			to: string;
			subject: string;
			body: string;
			type: T;
			priority?: MailMessage["priority"];
			threadId?: string;
			payload: MailPayloadMap[T];
		}): string {
			// Mail delivery first — always succeeds
			const messageId = inner.sendProtocol(msg);

			// Bridge projection — best-effort, fire-and-forget
			if (!bridge.isDisabled) {
				projectToTaskBridge(bridge, msg.type, msg.payload, msg.from, msg.to).catch(() => {
					// Swallowed — bridge has its own circuit breaker
				});
			}

			return messageId;
		},
	};
}

/**
 * Route a protocol message to the appropriate TaskBridge method.
 */
async function projectToTaskBridge(
	bridge: TaskBridge,
	type: MailProtocolType,
	payload: MailPayloadMap[MailProtocolType],
	from: string,
	to: string,
): Promise<void> {
	switch (type) {
		case "dispatch":
			await bridge.onDispatch(payload as DispatchPayload, from, to);
			break;
		case "assign":
			await bridge.onAssign(payload as AssignPayload);
			break;
		case "worker_done":
			await bridge.onWorkerDone(payload as WorkerDonePayload, from);
			break;
		case "merge_ready":
			await bridge.onMergeReady(payload as MergeReadyPayload);
			break;
		case "merged":
			await bridge.onMerged(payload as MergedPayload);
			break;
		case "merge_failed":
			await bridge.onMergeFailed(payload as MergeFailedPayload);
			break;
		case "escalation":
			await bridge.onEscalation(payload as EscalationPayload, from);
			break;
		case "health_check":
			// Too frequent — skip to avoid task clutter
			break;
	}
}
