import { useEffect, useRef, useState } from "react";
import { flushSync, useGpuixRequired } from "@gpuix/react";
import { resolve } from "node:path";
import { Schema } from "effect";
import { useLabora, type DesktopStore, type Labora } from "./use-labora";
import { BubbleAction, BubbleCommand, type BubbleSnapshot } from "./bubble-contracts";
import { createNativeBubble } from "./native-bubble";
import { defaultShortcut, type Shortcut } from "./shortcut";

export type BubbleLauncher = (receive: (message: BubbleAction) => void) => ReturnType<typeof Bun.spawn>;

export const launchBubble: BubbleLauncher = (receive) => {
  const packaged = process.env.LABORA_PACKAGED === "1";

  return Bun.spawn([process.execPath, ...(packaged ? ["--bubble"] : [resolve(import.meta.dir, "main.tsx"), "--bubble"])], {
    stdin: "ignore", stdout: "ignore", stderr: "inherit",
    ipc: (message) => receive(Schema.decodeUnknownSync(BubbleAction)(message)),
  });
};

export function useBubble(store: DesktopStore, main: Labora, openMain: (signIn: boolean) => void, launch: BubbleLauncher = launchBubble) {
  const defaultKey = main.preferences.defaultAgent ?? main.selected?.key ?? "";
  const labora = useLabora(store, defaultKey);
  const renderer = useGpuixRequired();
  const current = useRef(labora);
  current.current = labora;
  const open = useRef(openMain);
  open.current = openMain;
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const native = useRef<ReturnType<typeof createNativeBubble> | null>(null);
  const child = useRef<ReturnType<typeof Bun.spawn> | null>(null);
  const ready = useRef(false);
  const visible = useRef(false);
  const latest = useRef<BubbleSnapshot | null>(null);
  const shortcut = main.preferences.bubbleShortcut ?? defaultShortcut;

  const send = (command: BubbleCommand) => { if (ready.current) child.current?.send(command); };

  const hide = (restoreFocus = true) => {
    visible.current = false;
    send(BubbleCommand.cases.Visibility.make({ visible: false, restoreFocus }));
  };

  const showMain = (signIn = false) => {
    hide(false);
    const target = current.current.selected;

    if (target) main.updatePreferences({ selected: target.key });
    renderer.activateWindow?.();
    open.current(signIn);
  };

  const handle = (action: BubbleAction) => {
    const state = current.current;

    if ("key" in action && (!state.selected || action.key !== state.selected.key)) return;
    BubbleAction.match(action, {
      Ready: () => {
        ready.current = true;

        if (latest.current) send(BubbleCommand.cases.State.make({ snapshot: latest.current }));
        send(BubbleCommand.cases.Visibility.make({ visible: visible.current, restoreFocus: true }));
      },
      Hide: () => hide(),
      Open: () => showMain(),
      Draft: ({ draft }) => { if (draft.key === state.draft.key) flushSync(() => state.changeDraft(draft)); },
      Send: () => state.attempt(state.send("followUp").then((result) => { if (result === "signin") showMain(true); })),
      Stop: () => state.attempt(state.cancel()),
      Approve: ({ decision }) => state.attempt(state.answerApproval(decision)),
      Answer: ({ requestId, runId, answers }) => state.attempt(state.answerQuestion(requestId, runId, answers)),
    });
  };

  const handler = useRef(handle);
  handler.current = handle;

  const toggle = () => {
    visible.current = !visible.current;

    if (!child.current) {
      const next = launch((message) => handler.current(message));

      child.current = next;
      void next.exited.then(() => {
        if (child.current !== next) return;
        child.current = null;
        ready.current = false;
        visible.current = false;
      });
    } else send(BubbleCommand.cases.Visibility.make({ visible: visible.current, restoreFocus: true }));
  };

  const toggler = useRef(toggle);
  toggler.current = toggle;

  useEffect(() => {
    try { native.current = createNativeBubble(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not start the global shortcut."); }

    const timer = setInterval(() => { if ((native.current?.poll() ?? 0) % 2) toggler.current(); }, 25);
    const cleanup = () => { child.current?.kill(); native.current?.close(); native.current = null; };

    process.once("exit", cleanup);

    return () => { clearInterval(timer); process.off("exit", cleanup); cleanup(); };
  }, []);

  useEffect(() => {
    if (!native.current || process.env.LABORA_SHORTCUT_DISABLED === "1") return;

    if (recording) { native.current.clear();

 return; }

    try { native.current.register(shortcut); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not register this shortcut."); }
  }, [shortcut, recording]);

  useEffect(() => {
    const snapshot: BubbleSnapshot = { key: labora.selected?.key ?? "", bot: labora.selected?.bot ?? null, messages: labora.messages, draft: labora.draft, busy: labora.busy, error: labora.error, activity: labora.botActivity, question: labora.question ?? null, plan: labora.plan, approval: labora.approval ?? null };
    latest.current = snapshot;
    send(BubbleCommand.cases.State.make({ snapshot }));
  }, [labora.selected, labora.messages, labora.draft, labora.busy, labora.error, labora.botActivity, labora.question, labora.plan, labora.approval]);

  useEffect(() => {
    if (!main.preferences.defaultAgent && main.selected) main.updatePreferences({ defaultAgent: main.selected.key });
  }, [main.preferences.defaultAgent, main.selected?.key]);

  return {
    shortcut, error, recording, setRecording, toggle,
    async changeShortcut(next: Shortcut) {
      if (!native.current) throw new Error("The native shortcut helper is unavailable.");
      native.current.register(next);
      await store.save({ ...store.getSnapshot(), bubbleShortcut: next });
      setError("");
      setRecording(false);
    },
  };
}

export type BubbleControls = ReturnType<typeof useBubble>;
