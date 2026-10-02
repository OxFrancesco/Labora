import { Match } from "effect";
import { BotActivity, EventPayload } from "./contracts";

export const idleActivity = (): BotActivity => ({ phase: "idle", tools: [], approvalIds: [] });

export function reduceActivity(current: BotActivity, payload: EventPayload): BotActivity {
  if (EventPayload.isAnyOf(["RunStarted"])(payload))
    return { phase: "thinking", runId: payload.runId, tools: [], approvalIds: [] };

  if (EventPayload.isAnyOf(["ProcessExited"])(payload))
    return { ...current, phase: "failed", tools: [], approvalIds: [], message: payload.message };

  if (EventPayload.isAnyOf(["RunCompleted", "RunCancelled", "RunFailed"])(payload)) {
    if (current.runId && current.runId !== payload.runId) return current;

    const activity: BotActivity = {
      phase: Match.value(payload).pipe(
        Match.tag("RunCompleted", () => "complete" as const),
        Match.tag("RunCancelled", () => "cancelled" as const),
        Match.tag("RunFailed", () => "failed" as const),
        Match.exhaustive,
      ),
      runId: payload.runId,
      tools: [],
      approvalIds: [],
    };

    return EventPayload.isAnyOf(["RunFailed"])(payload) ? { ...activity, message: payload.message } : activity;
  }

  if (EventPayload.isAnyOf(["RunActivity"])(payload)) {
    if (current.runId && current.runId !== payload.runId) return current;

    const { message: _message, ...previous } = current;

    const activity: BotActivity = {
      ...previous,
      runId: payload.runId,
      phase: current.approvalIds.length ? "waiting" : current.tools.length ? "working" : payload.phase,
    };

    return payload.message === undefined ? activity : { ...activity, message: payload.message };
  }

  if (EventPayload.isAnyOf(["ApprovalRequested"])(payload))
    return { ...current, phase: "waiting", approvalIds: [...new Set([...current.approvalIds, payload.requestId])] };

  if (EventPayload.isAnyOf(["ApprovalResolved"])(payload)) {
    const approvalIds = current.approvalIds.filter((id) => id !== payload.requestId);

    return { ...current, approvalIds, phase: approvalIds.length ? "waiting" : current.tools.length ? "working" : "thinking" };
  }

  if (EventPayload.isAnyOf(["ToolStart"])(payload))
    return {
      ...current,
      phase: current.approvalIds.length ? "waiting" : "working",
      tools: [...current.tools.filter((tool) => tool.id !== payload.toolCallId), { id: payload.toolCallId, name: payload.name }],
    };

  if (EventPayload.isAnyOf(["ToolEnd"])(payload)) {
    const tools = current.tools.filter((tool) => tool.id !== payload.toolCallId);

    return { ...current, tools, phase: current.approvalIds.length ? "waiting" : tools.length ? "working" : "thinking" };
  }

  if (EventPayload.isAnyOf(["TextDelta"])(payload)) {
    const { message: _message, ...previous } = current;

    return { ...previous, phase: current.approvalIds.length ? "waiting" : current.tools.length ? "working" : "streaming" };
  }

  return current;
}
