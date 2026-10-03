import { memo, useState, type ReactNode } from "react";
import type { Message } from "../backend/contracts";
import { toolTitle } from "../tool-presentation";
import { Label } from "./icons";
import { ActivityShimmer, DisclosureArrow } from "./activity-motion";
import { color, font, terminalFont } from "./theme";

const paths = {
  terminal: '<path d="m4 17 6-5-6-5m8 12h8"/>',
  brain: '<path d="M12 18V5a3 3 0 0 0-5.8-1 4 4 0 0 0-3.5 5.7 4 4 0 0 0 .6 7.5 4 4 0 0 0 7.7.8m1-13a3 3 0 0 1 5.8-1 4 4 0 0 1 3.5 5.7 4 4 0 0 1-.6 7.5 4 4 0 0 1-7.7.8M8 8a4 4 0 0 1-1.8-4M16 8a4 4 0 0 0 1.8-4M6 13a4 4 0 0 0-3.3 1M18 13a4 4 0 0 1 3.3 1"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  tools: '<path d="m14.7 6.3 3 3a1 1 0 0 0 1.4 0l2.8-2.8a6 6 0 0 1-8 8l-7.5 7.5a2.1 2.1 0 0 1-3-3l7.5-7.5a6 6 0 0 1 8-8l-2.8 2.8a1 1 0 0 0 0 1.4z"/>',
  tasks: '<path d="M8 6h13M8 12h13M8 18h13m-18-12 1 1 2-2m-3 7 1 1 2-2m-3 7 1 1 2-2"/>',
};

export type ActivityIconName = keyof typeof paths;

export function ActivityIcon({ name, tint = color.secondary }: { name: ActivityIconName; tint?: string }) {
  return <svg source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`} style={{ width: 16, height: 16, flexShrink: 0, color: tint }} />;
}

export function toolIcon(message: Message): ActivityIconName {
  if (message.role === "thinking") return "brain";

  if (message.toolName === "bash") return "terminal";

  if (/read|write|edit/.test(message.toolName ?? "")) return "file";

  if (/search|browse/.test(message.toolName ?? "")) return "search";

  return "tools";
}

export const WorkRow = memo(function WorkRow({ id, label, icon, active = false, failed = false, expanded, toggle, timestamp, children }: {
  id: string; label: string; icon: ActivityIconName; active?: boolean; failed?: boolean;
  expanded?: boolean; toggle?: () => void; timestamp?: string; children?: ReactNode;
}) {
  const [hover, setHover] = useState(false);

  return <div style={{ width: "100%", minWidth: 0, flexShrink: 0, display: "flex", flexDirection: "column" }}>
    <div testId={id} role={toggle ? "button" : "status"} aria-label={label} aria-expanded={expanded} tabIndex={toggle ? 0 : undefined}
      onClick={toggle} onKeyDown={(event) => { if (event.key === "enter" || event.key === "space") toggle?.(); }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}
      style={{ width: "100%", minWidth: 0, minHeight: 24, paddingLeft: 2, paddingRight: 2, display: "flex", alignItems: "center", gap: 6, borderRadius: 6, userSelect: "none", cursor: toggle ? "pointer" : "default", hover: { backgroundColor: toggle ? "#ffffff08" : "transparent" } }}>
      <div style={{ flexGrow: 1, minWidth: 0 }}>
        <ActivityShimmer active={active && !failed}>{(highlighted) => <div style={{ display: "flex", alignItems: "center", minWidth: 0, gap: 6 }}>
          <div style={{ width: 24, height: 24, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}><ActivityIcon name={icon} tint={failed ? color.error : highlighted ? color.text : color.secondary} /></div>
          <Label secondary={!highlighted} size={14} style={{ lineHeight: 22.75, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden", minWidth: 0, flexShrink: 1 }}>{label}</Label>
        </div>}</ActivityShimmer>
      </div>
      {hover && timestamp ? <Label secondary size={12} style={{ flexShrink: 0 }}>{new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Label> : null}
      {expanded !== undefined ? <div style={{ width: 16, height: 16, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}><DisclosureArrow expanded={expanded} /></div> : null}
    </div>
    {children}
  </div>;
});

export function thoughtPreview(text: string) {
  return text.trim().split("\n").find((line) => line.trim())?.replace(/^#+\s*|\*\*/g, "").trim() || "Thinking";
}

export const ToolMessage = memo(function ToolMessage({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const thinking = message.role === "thinking";
  const running = message.toolStatus === "running";
  const command = message.toolInput?.trim();

  const title = thinking ? expanded ? running ? "Thinking" : "Thought" : thoughtPreview(message.text)
    : message.toolName === "bash" ? command?.split("\n")[0] || "Run command"
    : `${toolTitle(message.toolName ?? "Tool")}${command ? ` ${command.split("\n")[0]}` : ""}`;

  return <WorkRow id={`tool-${message.id}`} label={title} icon={toolIcon(message)} active={running} failed={message.toolStatus === "error"} expanded={expanded} toggle={() => setExpanded(!expanded)} timestamp={message.createdAt}>
    {expanded ? <div testId={`detail-${message.id}`} style={{ marginLeft: 28, marginTop: thinking ? 0 : 4, marginBottom: 4, minWidth: 0, maxHeight: 384, overflowY: "scroll", display: "flex", flexDirection: "column", gap: 12, paddingTop: thinking ? 4 : 8, paddingBottom: thinking ? 4 : 8, paddingLeft: thinking ? 2 : 12, paddingRight: thinking ? 2 : 12, borderRadius: 6, backgroundColor: thinking ? "transparent" : "#ffffff09" }}>
      {thinking ? <markdown source={message.text} theme={{ fontSans: font, fontMono: terminalFont, text: color.secondary, metrics: { mdTextSize: 14, mdLineHeight: 22.75 } }} style={{ width: "100%", minWidth: 0 }} /> : <>
        {command ? <div style={{ padding: 8, borderWidth: 1, borderColor: "#ffffff14", borderRadius: 6, minWidth: 0 }}><Label size={12} style={{ fontFamily: terminalFont, lineHeight: 18 }}>{command}</Label></div> : null}
        {message.text ? <Label size={12} style={{ fontFamily: terminalFont, lineHeight: 18, color: message.toolStatus === "error" ? color.error : color.secondary }}>{message.text}</Label> : null}
        <Label size={12} style={{ color: running ? color.secondary : message.toolStatus === "error" ? color.error : "#79b88c" }}>{running ? "Running…" : message.toolStatus === "error" ? "Tool call failed" : "Completed"}</Label>
      </>}
    </div> : null}
  </WorkRow>;
});
