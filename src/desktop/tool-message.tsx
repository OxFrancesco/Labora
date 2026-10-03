import { useState } from "react";
import type { Message } from "../backend/contracts";
import { toolTitle } from "../tool-presentation";
import { Button, Label } from "./icons";
import { color, terminalFont } from "./theme";

export function ToolMessage({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const full = [message.toolInput, message.text].filter(Boolean).join("\n\n");
  const lines = full.split("\n");
  const long = lines.length > 8 || full.length > 900;
  const shown = expanded ? full : lines.slice(0, 8).join("\n").slice(0, 900);
  const status = { running: " · Running", error: " · Failed", complete: "" }[message.toolStatus ?? "complete"];
  const title = `${toolTitle(message.toolName ?? "Tool")}${status}`;

  return <div testId={`tool-${message.id}`} style={{ width: "100%", minWidth: 0, padding: 12, backgroundColor: message.toolStatus === "error" ? "#382829" : "#202629", display: "flex", flexDirection: "column", gap: 6 }}>
    <Label size={13} style={{ fontFamily: terminalFont, color: message.toolStatus === "error" ? color.error : "#b6a4db" }}>{title}</Label>
    {shown ? <div style={{ minWidth: 0, maxHeight: expanded ? 320 : 180, overflowY: "scroll" }}><Label size={12} style={{ fontFamily: terminalFont }}>{shown}</Label></div> : null}
    {long ? <Button id={`expand-${message.id}`} label={expanded ? "Show less output" : "Show full output"} onClick={() => setExpanded(!expanded)} style={{ alignSelf: "flex-start", padding: 0 }}><Label secondary size={12}>{expanded ? "Show less" : "Show more"}</Label></Button> : null}
  </div>;
}
