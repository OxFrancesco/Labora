import { Fragment, memo, useEffect, useMemo, useState } from "react";
import type { Message } from "../backend/contracts";
import { ToolMessage, WorkRow, toolIcon } from "./tool-message";
import { Label } from "./icons";
import { color, font, terminalFont } from "./theme";

type TimelineEntry = { id: string; messages: readonly Message[]; activity: boolean };

function timelineEntries(messages: readonly Message[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const message of messages) {
    if (!message.text.trim() && message.role === "assistant") continue;
    const activity = message.role === "tool" || message.role === "thinking";
    const previous = entries.at(-1);

    if (activity && previous?.activity) previous.messages = [...previous.messages, message];
    else entries.push({ id: message.id, messages: [message], activity });
  }

  return entries;
}

function groupSummary(messages: readonly Message[]) {
  const commands = messages.filter((message) => message.toolName === "bash").length;
  const changes = new Set(messages.flatMap((message) => (message.toolName === "write" || message.toolName === "edit") && message.toolStatus !== "error" ? [message.toolInput?.split("\n")[0]] : [])).size;
  const reads = messages.filter((message) => message.toolName === "read").length;
  const other = messages.filter((message) => message.role === "tool" && !["bash", "write", "edit", "read"].includes(message.toolName ?? "")).length;
  const parts = [commands ? `Ran ${commands} command${commands === 1 ? "" : "s"}` : "", changes ? `changed ${changes} file${changes === 1 ? "" : "s"}` : "", reads ? `read ${reads} file${reads === 1 ? "" : "s"}` : "", other ? `used ${other} tool${other === 1 ? "" : "s"}` : ""].filter(Boolean);

  if (!parts.length) return "Thought";
  const label = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]!;

  return label[0]!.toUpperCase() + label.slice(1);
}

const WorkGroup = memo(function WorkGroup({ messages }: { messages: readonly Message[] }) {
  const [expanded, setExpanded] = useState(false);
  const active = messages.some((message) => message.toolStatus === "running");
  const first = messages[0]!;

  if (messages.length === 1 && first.role === "thinking") return <ToolMessage message={first} />;
  const icon = toolIcon(messages.find((message) => message.role === "tool") ?? first);

  return <div testId={`activity-group-${first.id}`} style={{ width: "100%", minWidth: 0, display: "flex", flexDirection: "column", flexShrink: 0 }}>
    <WorkRow id={`activity-toggle-${first.id}`} label={groupSummary(messages)} icon={icon} active={active} failed={messages.some((message) => message.toolStatus === "error")} toggle={() => setExpanded(!expanded)} timestamp={messages.at(-1)?.createdAt} />
    {expanded ? <div testId={`activity-entries-${first.id}`} role="region" aria-label="Tool calls" style={{ width: "100%", maxHeight: 576, overflowY: "scroll", minWidth: 0, display: "flex", flexDirection: "column" }}>
      {messages.map((message) => <ToolMessage key={message.id} message={message} />)}
    </div> : null}
  </div>;
});

const WorkingHeader = memo(function WorkingHeader({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);

    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  const elapsed = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;

  return <div testId="working-timer" style={{ width: "100%", paddingTop: 4, paddingBottom: 8, marginBottom: 8, paddingLeft: 4, borderBottomWidth: 1, borderColor: "#ffffff10" }}><Label secondary size={14} style={{ lineHeight: 24 }}>{`Working for ${elapsed}`}</Label></div>;
});

export const ConversationRows = memo(function ConversationRows({ messages, busy = false }: { messages: readonly Message[]; busy?: boolean }) {
  const entries = useMemo(() => timelineEntries(messages), [messages]);

  const latestUser = messages.slice().reverse().find((message) => message.role === "user");

  return <>{entries.map((entry) => entry.activity ? <div key={entry.id} style={{ width: "100%", minWidth: 0, paddingBottom: 8 }}><WorkGroup messages={entry.messages} /></div> : <Fragment key={entry.id}><div style={{ width: "100%", display: "flex", justifyContent: entry.messages[0]!.role === "user" ? "flex-end" : "flex-start", paddingTop: 12, paddingBottom: 16 }}>
    <div style={{ maxWidth: entry.messages[0]!.role === "user" ? "85%" : "100%", width: entry.messages[0]!.role === "user" ? undefined : "100%", minWidth: 0, overflow: "hidden", padding: entry.messages[0]!.role === "user" ? 12 : 4, backgroundColor: entry.messages[0]!.role === "user" ? color.surface : "transparent", borderRadius: 16 }}>
      <markdown source={entry.messages[0]!.text} theme={{ fontSans: font, fontMono: terminalFont, text: color.text, accent: "#b6a4db", metrics: { mdTextSize: 14, mdLineHeight: 23 } }} onLinkClick={(event) => { if (event.value?.startsWith("https://")) Bun.spawn(["/usr/bin/open", event.value]); }} style={{ width: "100%", minWidth: 0, fontFamily: font, fontSize: 14, lineHeight: 23 }} />
    </div>
  </div>{busy && entry.id === latestUser?.id ? <WorkingHeader startedAt={latestUser.createdAt} /> : null}</Fragment>)}</>;
});
