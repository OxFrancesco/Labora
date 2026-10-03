import { useEffect, useRef, useState } from "react";
import { useGpuixRequired, useWindowSize } from "@gpuix/react";
import { basename, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { Avatar, Button, Icon, Label } from "./icons";
import { WorkRow } from "./tool-message";
import { ConversationRows } from "./activity-timeline";
import { toolTitle } from "../tool-presentation";
import { color, font, terminalFont } from "./theme";
import { ConnectComputer, ConnectionsDialog, CreateBotDialog } from "./dialogs";
import { Settings } from "./settings";
import { Routines } from "./routines";
import { ComputerView } from "./computer-view";
import { Library } from "./library";
import { BotProfile } from "./bot-profile";
import { avatarActivityLabels } from "./avatar-motion";
import { readClipboard } from "./clipboard";
import { useLabora } from "./use-labora";
import { useVoiceInput } from "./voice-input";
import { AgentPlan, AgentQuestion, QueuedInputs } from "./agent-input";
import type { DesktopStore } from "./use-labora";

type Tab = "Details" | "Library" | "Computer";

type Dialog = "none" | "computer" | "bot" | "apps" | "signin" | "settings";

interface AppProps {
  store: DesktopStore;
}

export function App({ store }: AppProps) {
  const labora = useLabora(store);
  const renderer = useGpuixRequired();
  const window = useWindowSize();
  const [tab, setTab] = useState<Tab>("Details");
  const [dialog, setDialog] = useState<Dialog>("none");
  const [composerMenu, setComposerMenu] = useState(false);
  const [inputMode, setInputMode] = useState<"steer" | "followUp">("steer");
  const [expandedComputer, setExpandedComputer] = useState(false);
  const [routineOpen, setRoutineOpen] = useState(false);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const selected = labora.selected;
  const voice = useVoiceInput({ contextKey: selected?.key ?? null, locale: labora.preferences.voiceLocale || undefined });
  const recording = voice.state.kind === "requesting" || voice.state.kind === "listening" || voice.state.kind === "finishing";
  const bot = selected?.bot;
  const compact = labora.preferences.compact || (labora.preferences.detailsOpen && !!bot && window.width < 1000);
  const sidebarWidth = compact ? 92 : 248;
  const detailsOpen = labora.preferences.detailsOpen && !!bot && !expandedComputer;

  const detailWidth = Math.min(
    labora.preferences.detailsWidth,
    Math.max(280, window.width - sidebarWidth - 363),
  );

  useEffect(() => {
    if ((expandedComputer || dialog !== "none") && recording) voice.cancel();
  }, [expandedComputer, dialog, recording, voice.cancel]);

  useEffect(() => { setInputMode("steer"); }, [selected?.key, labora.busy]);

  function insertTranscript() {
    const transcript = voice.accept();

    if (!transcript) return;
    const previous = labora.draft.text;
    const separator = previous && !/\s$/.test(previous) ? " " : "";
    labora.changeDraft({ ...labora.draft, text: `${previous}${separator}${transcript}` });
  }

  function newBot() {
    setDialog(labora.preferences.connections.length ? "bot" : "computer");
  }

  async function sendMessage() {
    if (recording) return;
    const result = await labora.send(inputMode);

    if (result === "signin") setDialog("signin");
  }

  async function chooseFiles() {
    setComposerMenu(false);

    const paths = await renderer.promptForPaths?.({
      files: true,
      directories: false,
      multiple: true,
      prompt: "Attach",
    });

    if (paths) await labora.addAttachments(paths);
  }

  function toggleDetails() {
    labora.updatePreferences({ detailsOpen: !labora.preferences.detailsOpen });
  }

  async function pasteAttachments() {
    const clipboard = await readClipboard();

    if (clipboard.files.length) return labora.addAttachments(clipboard.files);

    if (!clipboard.image) return;
    const directory = join(store.directory, "clipboard");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${crypto.randomUUID()}-${clipboard.image.name}`);
    await writeFile(path, Buffer.from(clipboard.image.data, "base64"), { mode: 0o600 });
    await labora.addAttachments([path]);
  }

  return (
    <div
      testId="app-layout"
      onFileDrop={(event) => {
        if (event.paths) labora.attempt(labora.addAttachments(event.paths));
      }}
      onKeyDown={(event) => {
        if (!expandedComputer && dialog === "none" && event.modifiers?.cmd && event.key === "n") newBot();

        if (event.key === "escape" && !expandedComputer) {
          voice.cancel();

          if (dialog !== "settings") setDialog("none");
          setComposerMenu(false);
        }
      }}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "row",
        backgroundColor: color.canvas,
        color: color.text,
        fontFamily: font,
      }}
    >
      <div
        style={{
          width: sidebarWidth,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: compact ? "center" : "stretch",
          paddingTop: 56,
          paddingBottom: 16,
          backgroundColor: color.sidebar,
          borderRightWidth: 1,
          borderColor: color.border,
        }}
      >
        <Button
          id="sidebar-home"
          label="Labora"
          onClick={() => setDialog("settings")}
          style={{
            width: compact ? 56 : "auto",
            height: 54,
            marginLeft: compact ? 0 : 18,
            marginRight: compact ? 0 : 18,
            marginBottom: 12,
            justifyContent: compact ? "center" : "flex-start",
            gap: 12,
          }}
        >
          <Avatar tint="#eeeeee" size={42} />
          {compact ? null : <Label>Labora</Label>}
        </Button>
        <div
          style={{
            height: 1,
            marginLeft: compact ? 0 : 18,
            marginRight: compact ? 0 : 18,
            width: compact ? 56 : "auto",
            backgroundColor: color.border,
            marginBottom: 14,
          }}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            minHeight: 0,
            overflowY: "scroll",
            alignItems: compact ? "center" : "stretch",
            paddingLeft: compact ? 0 : 12,
            paddingRight: compact ? 0 : 12,
            gap: 5,
          }}
        >
          {labora.bots.map((item) => (
            <Button
              key={item.key}
              id={`bot-${item.bot.id}`}
              label={item.bot.name}
              active={item.key === selected?.key}
              onClick={() => {
                labora.updatePreferences({ selected: item.key });
                setExpandedComputer(false);
              }}
              style={{
                width: compact ? 56 : "100%",
                height: 56,
                flexShrink: 0,
                justifyContent: compact ? "center" : "flex-start",
                gap: 12,
                borderRadius: 12,
              }}
            >
              <Avatar
                tint={item.bot.color}
                size={42}
                activity={labora.botActivities.get(item.key)?.phase}
                activityKey={labora.botActivities.get(item.key)?.runId}
              />
              {compact ? null : (
                <Label style={{ flexShrink: 1, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {item.bot.name}
                </Label>
              )}
            </Button>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 3,
            alignItems: compact ? "center" : "stretch",
            paddingLeft: compact ? 0 : 14,
            paddingRight: compact ? 0 : 14,
          }}
        >
          <Button
            id="sidebar-toggle"
            label="Toggle compact sidebar"
            icon="panel"
            onClick={() => labora.updatePreferences({ compact: !labora.preferences.compact })}
            style={{ justifyContent: compact ? "center" : "flex-start", gap: 12 }}
          >
            {compact ? null : <Label secondary>Collapse sidebar</Label>}
          </Button>
          <Button
            id="sidebar-new"
            label="New chat"
            icon="plus"
            onClick={newBot}
            style={{ justifyContent: compact ? "center" : "flex-start", gap: 12 }}
          >
            {compact ? null : <Label secondary>New chat</Label>}
          </Button>
          <Button
            id="sidebar-apps"
            label="Connect apps"
            icon="apps"
            onClick={() => setDialog("apps")}
            style={{ justifyContent: compact ? "center" : "flex-start", gap: 12 }}
          >
            {compact ? null : <Label secondary>Connect apps</Label>}
          </Button>
          <Button
            id="sidebar-account"
            label="Open account menu"
            onClick={() => setDialog("settings")}
            style={{
              marginTop: 8,
              width: 38,
              height: 38,
              borderRadius: 19,
              backgroundColor: "#232323",
            }}
          >
            <Label secondary>L</Label>
          </Button>
        </div>
      </div>
      <div style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            height: 62,
            paddingLeft: 64,
            paddingRight: 64,
            flexShrink: 0,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            position: "relative",
          }}
        >
          <Button
            id="conversation-title"
            label="View conversation details"
            onClick={toggleDetails}
            style={{
              maxWidth: "100%",
              minWidth: 0,
              borderRadius: 24,
              backgroundColor: "#181818",
              borderWidth: 1,
              borderColor: "#202020",
              paddingLeft: 9,
              paddingRight: 15,
              gap: 6,
            }}
          >
            <Avatar key={selected?.key ?? "new"} tint={bot?.color ?? "#777777"} size={26} activity={labora.botActivity.phase} activityKey={labora.botActivity.runId} />
            <Label style={{ minWidth: 0, flexShrink: 1, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{bot?.name ?? "New chat"}</Label>
          </Button>
          <div style={{ position: "absolute", right: 12, display: "flex", gap: 8 }}>
            <Button
              id="details-toggle"
              label="Toggle conversation details"
              icon="details"
              onClick={toggleDetails}
              style={{ borderRadius: 20, width: 38, height: 38 }}
            />
          </div>
        </div>
        {expandedComputer && selected ? (
          <ComputerView selected={selected} expanded onExpand={() => setExpandedComputer(false)} />
        ) : (
          <>
            <div testId="conversation-body" style={{ flexGrow: 1, flexBasis: 0, minHeight: 0, minWidth: 0, display: "flex", paddingLeft: 16, paddingRight: 16 }}>
            <virtual-list
              testId="transcript"
              role="log"
              aria-label="Conversation transcript"
              alignment="bottom"
              followTail
              style={{
                flexGrow: 1,
                minHeight: 0,
                width: "100%",
                paddingBottom: 18,
              }}
            >
              <ConversationRows messages={labora.messages} busy={labora.busy} />
              {!selected ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 16,
                    padding: 48,
                  }}
                >
                  <Button
                    id="empty-create"
                    label="Create new bot"
                    onClick={newBot}
                    style={{
                      backgroundColor: color.surface,
                      borderRadius: 24,
                      paddingLeft: 22,
                      paddingRight: 22,
                    }}
                  >
                    <Label>Create new Bot</Label>
                  </Button>
                </div>
              ) : null}
              {!["idle", "complete"].includes(labora.botActivity.phase) ? (
                <WorkRow id="bot-activity" label={avatarActivityLabels[labora.botActivity.phase]} icon="brain" active={["thinking", "retrying", "compacting"].includes(labora.botActivity.phase)} failed={labora.botActivity.phase === "failed"} />
              ) : null}
              {labora.approval ? (
                <div
                  style={{
                    padding: 14,
                    marginTop: 12,
                    backgroundColor: color.surface,
                    borderRadius: 16,
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <Label>{`Allow ${toolTitle(labora.approval.toolName).toLowerCase()}?`}</Label>
                  <div style={{ maxHeight: 160, overflowY: "scroll", minWidth: 0 }}><Label size={12} secondary style={{ fontFamily: terminalFont }}>{labora.approval.input || "This action uses a connected app or controls your computer."}</Label></div>
                  <div style={{ display: "flex", gap: 12 }}>
                    <Button
                      id="approve-tool"
                      label="Approve once"
                      onClick={() => labora.attempt(labora.answerApproval("approve"))}
                      style={{ backgroundColor: color.composer }}
                    >
                      <Label>Allow once</Label>
                    </Button>
                    <Button
                      id="deny-tool"
                      label="Deny tool"
                      onClick={() => labora.attempt(labora.answerApproval("deny"))}
                    >
                      <Label>Decline</Label>
                    </Button>
                  </div>
                </div>
              ) : null}
            </virtual-list>
            </div>
            <div
              style={{
                paddingLeft: 16,
                paddingRight: 16,
                paddingBottom: 15,
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div testId="composer-context" style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: Math.floor(window.height * 0.24), overflowY: "scroll", minHeight: 0 }}>
              {labora.error ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <Label size={12} style={{ color: color.error, flexShrink: 1 }}>
                    {labora.error}
                  </Label>
                  <Button
                    id="dismiss-error"
                    label="Dismiss error"
                    icon="close"
                    onClick={() => labora.setError("")}
                  />
                </div>
              ) : null}
              {labora.draft.paths.length ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, flexShrink: 0 }}>
                  {labora.draft.paths.map((path, index) => (
                    <div
                      key={path}
                      testId={`attachment-${index}`}
                      style={{
                        minWidth: 0,
                        maxWidth: "100%",
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: 6,
                        backgroundColor: color.surface,
                        borderRadius: 10,
                      }}
                    >
                      <Icon name="file" size={16} />
                      <Label size={12} style={{ minWidth: 0, flexShrink: 1, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{basename(path).replace(/^[a-f0-9-]{36}-/, "")}</Label>
                      <Button
                        id={`remove-attachment-${index}`}
                        label="Remove attachment"
                        icon="close"
                        onClick={() =>
                          labora.changeDraft({
                            ...labora.draft,
                            paths: labora.draft.paths.filter((item) => item !== path),
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              ) : null}
              {voice.state.kind !== "idle" ? (
                <div
                  testId="voice-input"
                  style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, backgroundColor: color.surface, borderRadius: 14 }}
                >
                  {voice.state.kind === "requesting" ? <Label size={13} secondary>Starting dictation…</Label> : null}
                  {voice.state.kind === "listening" ? <Label size={13}>Listening…</Label> : null}
                  {voice.state.kind === "finishing" ? <Label size={13} secondary>Finishing…</Label> : null}
                  {voice.state.kind === "error" ? <Label size={13} style={{ color: color.error }}>{voice.state.message}</Label> : null}
                  {"text" in voice.state && voice.state.text ? (
                    <div style={{ maxHeight: 132, overflowY: "scroll" }}>
                      <Label size={14}>{voice.state.text}</Label>
                    </div>
                  ) : null}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {voice.state.kind === "listening" ? (
                      <Button id="voice-stop" label="Stop dictation" icon="stop" onClick={voice.stop} style={{ gap: 6 }}><Label size={13}>Stop</Label></Button>
                    ) : null}
                    {(voice.state.kind === "ready" || voice.state.kind === "error") && voice.state.text ? (
                      <Button id="voice-use-text" label="Use recognized text" onClick={insertTranscript} style={{ backgroundColor: color.composer }}><Label size={13}>Use text</Label></Button>
                    ) : null}
                    <Button id="voice-cancel" label={recording ? "Cancel dictation" : "Discard dictation"} onClick={voice.cancel}>
                      <Label size={13} secondary>{recording ? "Cancel" : "Discard"}</Label>
                    </Button>
                  </div>
                </div>
              ) : null}
              <QueuedInputs items={labora.queuedInputs} />
              </div>
              {labora.question ? <AgentQuestion key={labora.question.requestId} question={labora.question} answer={labora.answerQuestion} maxHeight={Math.min(300, window.height * .4)} /> : labora.plan ? <AgentPlan key={selected?.key} plan={labora.plan} /> : null}
              {labora.busy ? <div style={{ display: "flex", flexWrap: "wrap", gap: 6, flexShrink: 0 }}>
                <Button id="input-mode-steer" label="Update task after the current step" active={inputMode === "steer"} onClick={() => setInputMode("steer")}><Label size={12}>After current step</Label></Button>
                <Button id="input-mode-follow-up" label="Send after this task" active={inputMode === "followUp"} onClick={() => setInputMode("followUp")}><Label size={12}>After this task</Label></Button>
              </div> : null}
              <div
                testId="composer-row"
                style={{
                  display: "flex",
                  flexShrink: 0,
                  alignItems: "flex-end",
                  gap: 8,
                  padding: 8,
                  backgroundColor: color.canvas,
                  borderRadius: 2,
                  borderWidth: 1,
                  borderColor: "#766c96",
                }}
              >
                <Button
                  id="composer-actions"
                  label="Composer actions"
                  icon="plus"
                  onClick={() => setComposerMenu(!composerMenu)}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 16,
                    backgroundColor: "#414141",
                    flexShrink: 0,
                  }}
                />
                <textarea
                  testId="composer"
                  aria-label="Prompt"
                  value={labora.draft.text}
                  placeholder={labora.busy ? inputMode === "steer" ? "Update this task…" : "Message after this task…" : "Message…"}
                  onKeyDown={(event) => {
                    if (dialog === "none" && event.modifiers?.cmd && event.key === "v") labora.attempt(pasteAttachments());
                  }}
                  onChange={(event) =>
                    labora.changeDraft({ ...labora.draft, text: event.value ?? "" })
                  }
                  onSubmit={() => labora.attempt(sendMessage())}
                  minRows={1}
                  maxRows={window.height < 650 ? 4 : 8}
                  style={{
                    flexGrow: 1,
                    minWidth: 0,
                    paddingTop: 4,
                    paddingBottom: 3,
                    color: color.text,
                    fontFamily: terminalFont,
                    fontSize: 14,
                    lineHeight: 22,
                    backgroundColor: "transparent",
                  }}
                />
                {voice.state.kind === "idle" ? (
                  <Button
                    id="voice-start"
                    label="Start voice input"
                    icon="mic"
                    onClick={voice.start}
                    style={{ width: 30, height: 30, borderRadius: 16, flexShrink: 0 }}
                  />
                ) : null}
                {labora.busy ? (
                  <Button
                    id="cancel"
                    label="Stop response"
                    icon="stop"
                    onClick={() => labora.attempt(labora.cancel())}
                    style={{ width: 30, height: 30, borderRadius: 16, backgroundColor: "#eeeeee" }}
                  />
                ) : null}
                {!labora.busy || labora.draft.text.trim() || labora.draft.paths.length ? (
                  <Button
                    id="send"
                    label={labora.busy ? inputMode === "steer" ? "Send task update" : "Queue follow-up" : "Send message"}
                    icon="send"
                    onClick={() => labora.attempt(sendMessage())}
                    style={{ width: 30, height: 30, borderRadius: 16, backgroundColor: recording ? "#555555" : "#eeeeee" }}
                  />
                ) : null}
              </div>
              {composerMenu ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <Button
                    id="attach-files"
                    label="Attach files"
                    icon="file"
                    onClick={() => labora.attempt(chooseFiles())}
                    style={{
                      backgroundColor: color.surface,
                      gap: 8,
                      paddingLeft: 12,
                      paddingRight: 12,
                    }}
                  >
                    <Label>Attach files</Label>
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
      {detailsOpen ? (
        <>
          <div
            testId="details-divider"
            role="separator"
            aria-label="Resize details"
            onMouseDown={(event) => {
              drag.current = { x: event.x ?? 0, width: detailWidth };
            }}
            onMouseMove={(event) => {
              if (drag.current && event.x !== undefined)
                labora.updatePreferences({
                  detailsWidth: Math.min(
                    520,
                    Math.max(270, drag.current.width + drag.current.x - event.x),
                  ),
                });
            }}
            onMouseUp={() => {
              drag.current = null;
            }}
            style={{ width: 3, flexShrink: 0, cursor: "col-resize", backgroundColor: color.border }}
          />
          <div
            style={{
              width: detailWidth,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              paddingLeft: 15,
              paddingRight: 15,
              borderLeftWidth: 1,
              borderColor: color.border,
            }}
          >
            <div
              style={{
                height: 62,
                flexShrink: 0,
                display: "flex",
                justifyContent: "flex-end",
                alignItems: "center",
              }}
            >
              <Button
                id="details-close"
                label="Close details"
                icon="details"
                onClick={toggleDetails}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 20,
                  backgroundColor: "#161616",
                  borderWidth: 1,
                  borderColor: "#222222",
                }}
              />
            </div>
            <div testId="details-content" style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, overflowY: "scroll", paddingBottom: 14 }}>
            {!routineOpen ? <BotProfile key={selected.key} labora={labora} /> : null}
            {!routineOpen ? <div
              role="tablist"
              style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", flexShrink: 0, gap: 4, paddingBottom: 18 }}
            >
              {(["Details", "Library", "Computer"] satisfies Tab[]).map((item) => (
                <Button
                  key={item}
                  id={`tab-${item.toLowerCase()}`}
                  label={item}
                  active={tab === item}
                  onClick={() => setTab(item)}
                  style={{ paddingLeft: 9, paddingRight: 9, minHeight: 28 }}
                >
                  <Label secondary={tab !== item} size={14}>
                    {item}
                  </Label>
                </Button>
              ))}
            </div> : null}
            {tab === "Details" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, flexGrow: 1, minHeight: routineOpen ? 0 : 180, flexShrink: routineOpen ? 1 : 0 }}>
                <Routines key={selected.key} selected={selected} onOpenChange={setRoutineOpen} />
                {!routineOpen ? <><Button
                  id="details-apps"
                  label="Connect apps for this bot"
                  onClick={() => setDialog("apps")}
                  style={{
                    justifyContent: "space-between",
                    padding: 12,
                    borderWidth: 1,
                    borderColor: color.border,
                  }}
                >
                  <Label>Apps</Label>
                  <Icon name="chevron" size={16} />
                </Button>
                <Button
                  id="details-computer"
                  label="Choose computer"
                  onClick={() => setTab("Computer")}
                  style={{
                    justifyContent: "space-between",
                    padding: 12,
                    borderWidth: 1,
                    borderColor: color.border,
                  }}
                >
                  <Label secondary>{selected.connection.computer.name}</Label>
                  <Icon name="chevron" size={16} />
                </Button></> : null}
              </div>
            ) : null}
            {tab === "Library" ? <Library selected={selected} /> : null}
            {tab === "Computer" ? (
              <ComputerView
                selected={selected}
                expanded={false}
                onExpand={() => setExpandedComputer(true)}
              />
            ) : null}
            </div>
          </div>
        </>
      ) : null}
      {dialog === "computer" ? (
        <ConnectComputer labora={labora} close={() => setDialog("none")} />
      ) : null}
      {dialog === "bot" ? (
        <CreateBotDialog labora={labora} close={() => setDialog("none")} />
      ) : null}
      {dialog === "apps" || dialog === "signin" ? (
        <ConnectionsDialog labora={labora} signInRequired={dialog === "signin"} close={() => setDialog("none")} />
      ) : null}
      {dialog === "settings" ? (
        <Settings labora={labora} close={() => setDialog("none")} connectComputer={() => setDialog("computer")} connectApps={() => setDialog("apps")} />
      ) : null}
    </div>
  );
}
