import { toolInput, toolOutput, readableToolText } from "../tool-presentation";
import { EventPayload, type Message } from "../backend/contracts";

export function reduceMessages(messages: readonly Message[], payload: EventPayload, timestamp: string): readonly Message[] {
  if (EventPayload.isAnyOf(["Message"])(payload)) {
    const message = payload.message;

    return messages.some((item) => item.id === message.id)
      ? messages.map((item) => item.id === message.id ? message : item)
      : [...messages, message];
  }

  if (EventPayload.isAnyOf(["ToolStart", "ToolProgress", "ToolEnd"])(payload)) {
    const id = `tool-${payload.toolCallId}`;
    const previous = messages.find((message) => message.id === id);

    const next: Message = {
      ...previous, id, role: "tool", toolName: payload.name, createdAt: previous?.createdAt ?? timestamp,
      text: EventPayload.isAnyOf(["ToolEnd"])(payload) ? toolOutput(payload.output)
        : EventPayload.isAnyOf(["ToolProgress"])(payload) ? readableToolText(payload.text) : "",
      toolInput: EventPayload.isAnyOf(["ToolStart"])(payload) ? toolInput(payload.name, payload.input) : previous?.toolInput ?? "",
      toolStatus: EventPayload.isAnyOf(["ToolEnd"])(payload) ? payload.isError ? "error" : "complete" : "running",
    };

    return previous ? messages.map((message) => message.id === id ? next : message) : [...messages, next];
  }

  if (!EventPayload.isAnyOf(["TextDelta"])(payload)) return messages;
  const existing = messages.find((item) => item.id === payload.messageId);
  const text = existing?.text ?? "";
  const offset = payload.offset ?? text.length;

  if (offset > text.length) throw new Error("A reply update was missed. Reconnecting…");
  const next = text + payload.text.slice(Math.max(0, text.length - offset));

  if (existing)
    return messages.map((item) => item.id === payload.messageId ? { ...item, text: next } : item);

  return [...messages, { id: payload.messageId, text: next, role: "assistant", createdAt: timestamp }];
}
