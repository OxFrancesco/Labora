import { useLayoutEffect, useRef } from "react";
import { useGpuixRequired, type PublicInstance } from "@gpuix/react";
import { Avatar, Button, Label } from "./icons";
import { ConversationRows } from "./activity-timeline";
import { AgentPlan, AgentQuestion } from "./agent-input";
import { color, font, composerTextStyle, composerButtonStyle } from "./theme";
import { BubbleAction, type BubbleSnapshot } from "./bubble-contracts";

export function Bubble({ snapshot, visible, dispatch }: { snapshot: BubbleSnapshot | null; visible: boolean; dispatch: (action: BubbleAction) => void }) {
  const renderer = useGpuixRequired();
  const composer = useRef<PublicInstance | null>(null);

  useLayoutEffect(() => {
    if (visible && composer.current) renderer.focusElement?.(composer.current.id);
  }, [visible, snapshot?.key, renderer]);

  const key = snapshot?.key ?? "";

  return <div testId="agent-bubble" role="dialog" aria-label="Agent bubble" onKeyDown={(event) => { if (event.key === "escape") dispatch(BubbleAction.cases.Hide.make({ })); }} style={{ width: "100%", height: "100%", minWidth: 0, display: "flex", flexDirection: "column", backgroundColor: color.canvas, borderRadius: 24, borderWidth: 1, borderColor: "#383838", overflow: "hidden", padding: 16, gap: 10 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
      <Avatar tint={snapshot?.bot?.color ?? "#777777"} size={36} activity={snapshot?.activity.phase} activityKey={snapshot?.activity.runId} />
      <Label style={{ flexGrow: 1, flexShrink: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{snapshot?.bot?.name ?? "Default agent"}</Label>
      <Button id="bubble-open" label="Open in Labora" icon="panel" onClick={() => dispatch(BubbleAction.cases.Open.make({ }))} />
      <Button id="bubble-close" label="Hide agent bubble" icon="close" onClick={() => dispatch(BubbleAction.cases.Hide.make({ }))} />
    </div>
    <virtual-list testId="bubble-transcript" role="log" aria-label="Agent conversation" alignment="bottom" followTail style={{ flexGrow: 1, minHeight: 0, width: "100%" }}>
      {snapshot ? <ConversationRows messages={snapshot.messages} busy={snapshot.busy} /> : null}
      {snapshot && !snapshot.bot ? <Label secondary>Choose an available default agent in Settings.</Label> : null}
    </virtual-list>
    {snapshot?.error ? <div style={{ maxHeight: 80, overflowY: "scroll", flexShrink: 0 }}><Label size={12} style={{ color: color.error }}>{snapshot.error}</Label></div> : null}
    {snapshot?.question ? <AgentQuestion key={snapshot.question.requestId} question={snapshot.question} maxHeight={200} answer={async (requestId, runId, answers) => { dispatch(BubbleAction.cases.Answer.make({ key, requestId, runId, answers })); }} /> : snapshot?.plan ? <AgentPlan plan={snapshot.plan} /> : null}
    {snapshot?.approval ? <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
      <Label size={12}>{`Allow ${snapshot.approval.toolName}?`}</Label>
      <div style={{ maxHeight: 90, overflowY: "scroll" }}><Label secondary size={12}>{snapshot.approval.input}</Label></div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button id="bubble-approve" label="Allow once" onClick={() => dispatch(BubbleAction.cases.Approve.make({ key, decision: "approve" }))}><Label size={12}>Allow once</Label></Button>
        <Button id="bubble-deny" label="Decline" onClick={() => dispatch(BubbleAction.cases.Approve.make({ key, decision: "deny" }))}><Label size={12}>Decline</Label></Button>
      </div>
    </div> : null}
    {snapshot?.draft.paths.length ? <Button id="bubble-attachments" label="Review attachments in Labora" onClick={() => dispatch(BubbleAction.cases.Open.make({ }))}><Label secondary size={12}>Review attachments in Labora</Label></Button> : null}
    <div testId="bubble-composer-row" style={{ display: "flex", alignItems: "flex-end", flexShrink: 0, gap: 8, borderRadius: 16, borderWidth: 1, borderColor: "#444444", padding: 10 }}>
      <textarea ref={composer} testId="bubble-composer" aria-label="Message your default agent" value={snapshot?.draft.text ?? ""} placeholder="Message…" minRows={1} maxRows={4} onChange={(event) => { if (snapshot?.bot) dispatch(BubbleAction.cases.Draft.make({ key, draft: { ...snapshot.draft, text: event.value ?? "" } })); }} onSubmit={() => { if (snapshot?.bot) dispatch(BubbleAction.cases.Send.make({ key })); }} style={{ ...composerTextStyle, fontFamily: font }} />
      {snapshot?.busy ? <Button style={composerButtonStyle} id="bubble-stop" label="Stop response" icon="stop" onClick={() => dispatch(BubbleAction.cases.Stop.make({ key }))} /> : null}
      <Button id="bubble-send" label={snapshot?.busy ? "Queue follow-up" : "Send message"} icon="send" onClick={() => { if (snapshot?.bot) dispatch(BubbleAction.cases.Send.make({ key })); }} style={{ ...composerButtonStyle, backgroundColor: "#eeeeee" }} />
    </div>
  </div>;
}
