import { useEffect, useRef, useState } from "react";
import { useGpuixRequired } from "@gpuix/react";
import { Match } from "effect";
import type { EventPayload, PublicInstance } from "@gpuix/react";
import type { Action, Button as PointerButton, Computer } from "../computer/contracts";
import type { LinkedBot } from "./use-labora";
import { computerClient } from "./client";
import { Button, Icon, Label } from "./icons";
import { color, font } from "./theme";

interface ComputerViewProps {
  selected: LinkedBot;
  expanded: boolean;
  onExpand: () => void;
}

export function ComputerView({ selected, expanded, onExpand }: ComputerViewProps) {
  const renderer = useGpuixRequired();
  const viewport = useRef<PublicInstance | null>(null);
  const [computer, setComputer] = useState<Computer>(selected.connection.computer);
  const [frame, setFrame] = useState({ frameId: "", source: "", width: 0, height: 0 });
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [text, setText] = useState("");
  const [displayId, setDisplayId] = useState("");
  const display = computer.displays.find((item) => item.id === displayId) ?? computer.displays[0];

  const pointer = useRef<{ button: "left" | "right" | "middle"; x: number; y: number } | null>(
    null,
  );

  const queue = useRef(Promise.resolve());
  const controlling = expanded && computer.controlOwner === "user";

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const client = computerClient(selected.connection);

    const capture = async () => {
      const info = await client.computer();

      if (cancelled) return;
      setComputer(info);
      const first = info.displays.find((item) => item.id === displayId) ?? info.displays[0];

      if (!first || info.permissions.screenCapture !== "granted") {
        setFrame({ frameId: "", source: "", width: 0, height: 0 });
        timer = setTimeout(poll, 2_000);

        return;
      }

      const next = await client.frame(first.id);

      if (cancelled) return;
      setFrame(next);
      setError("");
      timer = setTimeout(poll, expanded ? 300 : 1_200);
    };

    const poll = () => {
      void capture().catch((reason: Error) => {
        if (cancelled) return;
        setError(reason.message);
        timer = setTimeout(poll, 3_000);
      });
    };

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selected.key, expanded, retry, displayId]);

  function point(event: EventPayload) {
    if (!controlling || !display || !frame.frameId || !viewport.current) return;
    const bounds = renderer.getElementBounds?.(viewport.current.id);

    if (!bounds || event.x === undefined || event.y === undefined) return;
    const scale = Math.min(bounds.width / frame.width, bounds.height / frame.height);
    const imageWidth = frame.width * scale;
    const imageHeight = frame.height * scale;
    const x = Math.round((event.x - bounds.x - (bounds.width - imageWidth) / 2) / scale);
    const y = Math.round((event.y - bounds.y - (bounds.height - imageHeight) / 2) / scale);

    if (!pointer.current && (x < 0 || y < 0 || x >= frame.width || y >= frame.height)) return;

    return {
      x: Math.max(0, Math.min(frame.width - 1, x)),
      y: Math.max(0, Math.min(frame.height - 1, y)),
    };
  }

  function act(actions: Action[]) {
    if (!controlling || !display || !frame.frameId) return;

    const send = () =>
      computerClient(selected.connection)
        .action(display.id, frame.frameId, actions)
        .then(() => undefined);

    queue.current = queue.current.then(send).catch((reason: Error) => setError(reason.message));
  }

  function key(event: EventPayload) {
    if (!event.key) return;
    const modifiers = event.modifiers;
    const parts: string[] = [];

    if (modifiers?.cmd) parts.push("Cmd");

    if (modifiers?.ctrl) parts.push("Ctrl");

    if (modifiers?.alt) parts.push("Alt");

    if (modifiers?.shift) parts.push("Shift");

    if (event.key.length === 1 && !parts.length) {
      act([{ type: "type", text: event.key }]);

      return;
    }

    const names = new Map([
      ["enter", "Enter"],
      ["backspace", "Backspace"],
      ["escape", "Escape"],
      ["space", "Space"],
      ["tab", "Tab"],
      ["left", "Left"],
      ["right", "Right"],
      ["up", "Up"],
      ["down", "Down"],
      ["home", "Home"],
      ["end", "End"],
      ["pageup", "PageUp"],
      ["pagedown", "PageDown"],
      ["delete", "Delete"],
    ]);

    parts.push(names.get(event.key) ?? event.key);
    act([{ type: "key", key: parts.join("+") }]);
  }

  async function takeover() {
    const owner = computer.controlOwner === "user" ? "agent" : "user";
    await computerClient(selected.connection).control(owner);
    setComputer((current) => ({ ...current, controlOwner: owner }));
    setRetry((current) => current + 1);
  }

  async function type() {
    if (!display || !text || !frame.frameId) return;
    await computerClient(selected.connection).action(display.id, frame.frameId, [
      { type: "type", text },
    ]);
    setText("");
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        minHeight: 0,
        gap: 12,
        padding: expanded ? 16 : 8,
      }}
    >
      {computer.displays.length > 1 ? (
        <div style={{ display: "flex", gap: 8 }}>
          {computer.displays.map((item) => (
            <Button
              key={item.id}
              id={`display-${item.id}`}
              label={item.name}
              active={item.id === display?.id}
              onClick={() => {
                setFrame({ frameId: "", source: "", width: 0, height: 0 });
                setDisplayId(item.id);
              }}
            >
              <Label size={12}>{item.name}</Label>
            </Button>
          ))}
        </div>
      ) : null}
      {frame.source ? (
        <div
          ref={viewport}
          aria-label={`${computer.name} desktop`}
          testId="computer-frame"
          tabIndex={0}
          onMouseDown={(event) => {
            const position = point(event);

            if (!position) return;

            const button = Match.value(event.button).pipe(
              Match.withReturnType<typeof PointerButton.Type>(),
              Match.when(2, () => "right"),
              Match.when(1, () => "middle"),
              Match.orElse(() => "left"),
            );

            pointer.current = { ...position, button };
            act([{ type: "pointer_down", ...position, button }]);
          }}
          onMouseMove={(event) => {
            const position = point(event);

            if (!position || !pointer.current) return;
            pointer.current = { ...pointer.current, ...position };
            act([{ type: "move", ...position }]);
          }}
          onMouseUp={(event) => {
            const position = point(event) ?? pointer.current;

            if (!position || !pointer.current) return;
            act([
              { type: "pointer_up", x: position.x, y: position.y, button: pointer.current.button },
            ]);
            pointer.current = null;
          }}
          onScroll={(event) => {
            const position = point(event);

            if (!position) return;
            act([
              {
                type: "scroll",
                ...position,
                deltaX: Math.round(Math.max(-1000, Math.min(1000, event.deltaX ?? 0))),
                deltaY: Math.round(Math.max(-1000, Math.min(1000, event.deltaY ?? 0))),
              },
            ]);
          }}
          onKeyDown={key}
          style={{
            width: "100%",
            height: expanded ? "75%" : 180,
            flexGrow: expanded ? 1 : 0,
            borderRadius: 8,
            position: "relative",
          }}
        >
          <img
            src={frame.source}
            objectFit="contain"
            alt={`${computer.name} desktop`}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: "100%",
              height: "100%",
              borderRadius: 8,
              pointerEvents: "none",
            }}
          />
        </div>
      ) : (
        <div
          style={{
            height: 180,
            alignItems: "center",
            justifyContent: "center",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            borderWidth: 1,
            borderColor: color.border,
            borderRadius: 10,
          }}
        >
          <Icon name="computer" size={30} />
          <Label secondary style={{ textAlign: "center" }}>
            {computer.permissions.screenCapture === "granted"
              ? "Connecting to computer…"
              : "Screen access is not enabled on this computer."}
          </Label>
        </div>
      )}
      <Label secondary>{computer.name}</Label>
      {computer.diagnostics.map((diagnostic) => (
        <Label key={diagnostic} secondary size={12}>
          {diagnostic}
        </Label>
      ))}
      {error ? (
        <>
          <Label size={12} style={{ color: color.error }}>
            {error}
          </Label>
          <Button
            id="computer-retry"
            label="Retry"
            onClick={() => setRetry((current) => current + 1)}
          >
            <Label>Retry</Label>
          </Button>
        </>
      ) : null}
      <Button
        id="computer-open"
        label={expanded ? "Close computer" : "Open computer"}
        onClick={onExpand}
        style={{ backgroundColor: color.surface, borderRadius: 20 }}
      >
        <Label>{expanded ? "Close computer" : "Open computer"}</Label>
      </Button>
      {expanded ? (
        <Button
          id="computer-control"
          label={controlling ? "Return control to agent" : "Take control"}
          onClick={() => {
            void takeover().catch((reason: Error) => setError(reason.message));
          }}
          style={{ backgroundColor: color.surface }}
        >
          <Label>{controlling ? "Return control to agent" : "Take control"}</Label>
        </Button>
      ) : null}
      {controlling ? (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            testId="computer-type"
            value={text}
            onChange={(event) => setText(event.value ?? "")}
            onSubmit={() => {
              void type().catch((reason: Error) => setError(reason.message));
            }}
            placeholder="Type on computer"
            style={{
              flexGrow: 1,
              minWidth: 0,
              fontFamily: font,
              color: color.text,
              backgroundColor: color.surface,
              padding: 10,
              borderRadius: 8,
            }}
          />
          <Button
            id="computer-type-send"
            label="Type"
            icon="send"
            onClick={() => {
              void type().catch((reason: Error) => setError(reason.message));
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
