import { useCallback, useEffect, useRef, useState } from "react";
import { NativeVoice } from "./voice";
import type { VoiceEvent, VoiceStatus } from "./voice";

export type VoiceInputState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "listening"; text: string }
  | { kind: "finishing"; text: string }
  | { kind: "ready"; text: string }
  | { kind: "error"; message: string; text: string };

interface VoiceInputOptions {
  contextKey: string | null;
  locale?: string;
}

export function useVoiceInput({ contextKey, locale }: VoiceInputOptions) {
  const [state, setState] = useState<VoiceInputState>({ kind: "idle" });
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const client = useRef<NativeVoice | null>(null);
  const active = useRef<number | null>(null);
  const generation = useRef(0);
  const origin = useRef<{ key: string | null; locale: string | undefined } | null>(null);
  const transcript = useRef("");
  const consumed = useRef(true);

  const close = useCallback(() => {
    active.current = null;
    client.current?.close();
    client.current = null;
  }, []);

  const cancel = useCallback(() => {
    consumed.current = true;
    origin.current = null;
    transcript.current = "";
    close();
    setState({ kind: "idle" });
  }, [close]);

  function onEvent(event: VoiceEvent) {
    if (event.id !== active.current) return;

    switch (event.type) {
      case "authorizing": setState({ kind: "requesting" }); break;
      case "listening": setState({ kind: "listening", text: "" }); break;
      case "partial":
        transcript.current = event.text;
        setState((current) => ({ kind: current.kind === "finishing" ? "finishing" : "listening", text: event.text }));
        break;
      case "finishing": setState({ kind: "finishing", text: event.text }); break;
      case "final":
        active.current = null;
        transcript.current = event.text.trim();
        consumed.current = !transcript.current;
        setState(transcript.current ? { kind: "ready", text: transcript.current } : { kind: "error", message: "No speech was detected.", text: "" });
        break;
      case "cancelled": cancel(); break;
      case "error":
        transcript.current = event.text || transcript.current;
        consumed.current = !transcript.current;
        setState({ kind: "error", message: event.message, text: transcript.current });
        close();
        break;
      default: {
        const unexpected: never = event.type;
        throw new Error(`Unexpected dictation event: ${unexpected}`);
      }
    }
  }

  function connection(): NativeVoice {
    client.current ??= new NativeVoice(onEvent);

    return client.current;
  }

  async function refreshStatus() {
    const current = generation.current;
    let next: VoiceStatus;

    try { next = await connection().status(locale); }
    catch (error) {
      if (current === generation.current && active.current === null) close();

      throw error;
    }

    if (current === generation.current) setStatus(next);

    return next;
  }

  function start() {
    if (active.current !== null) return;

    try {
      setState({ kind: "requesting" });
      origin.current = { key: contextKey, locale };
      transcript.current = "";
      consumed.current = true;
      active.current = connection().start(locale);
    } catch (error) {
      close();
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error), text: "" });
    }
  }

  function stop() {
    try { client.current?.stop(); }
    catch (error) {
      consumed.current = !transcript.current;
      close();
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error), text: transcript.current });
    }
  }

  function accept(): string {
    if ((state.kind !== "ready" && state.kind !== "error") || consumed.current) return "";

    if (origin.current?.key !== contextKey || origin.current?.locale !== locale) {
      cancel();

      return "";
    }

    consumed.current = true;
    origin.current = null;
    const text = transcript.current;
    transcript.current = "";
    cancel();

    return text;
  }

  useEffect(() => {
    generation.current += 1;
    cancel();
    setStatus(null);

    return () => {
      generation.current += 1;
      close();
    };
  }, [contextKey, locale, cancel, close]);

  return { state, status, refreshStatus, start, stop, cancel, accept };
}
