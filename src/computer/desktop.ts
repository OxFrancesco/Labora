import { Context, Effect, Layer, Schedule, Semaphore } from "effect";
import { ComputerAuthority } from "./authority";
import { DesktopPlatform } from "./platform";
import { ComputerError, type Action, type ActionsRequest, type Computer, type Frame } from "./contracts";

export interface CapturedFrame { frame: Frame; png: Uint8Array }

export class Desktop extends Context.Service<Desktop, {
  info: () => Effect.Effect<Computer, ComputerError>;
  capture: (displayId: string) => Effect.Effect<CapturedFrame, ComputerError>;
  act: (request: ActionsRequest) => Effect.Effect<{ executed: number }, ComputerError>;
  control: (owner: "user" | "agent") => Effect.Effect<void, ComputerError>;
  owner: () => "user" | "agent";
}>()("labora/Desktop") {}

const invalid = (code: string, message: string) => new ComputerError({ status: 409, code, message });

export const desktopLayer = (name: string, agentHost: boolean) => Layer.effect(Desktop, Effect.gen(function* () {
  const platform = yield* DesktopPlatform;
  const authority = yield* ComputerAuthority;
  const serial = yield* Semaphore.make(1);
  let owner: "user" | "agent" = "user";
  const frames = new Map<string, Frame>();
  const dispatched = new Set<string>();
  const heldButtons = new Set<string>();
  let lastInputAt = 0;

  yield* Effect.suspend(() => serial.withPermit(Effect.gen(function* () {
    if (heldButtons.size > 0 && Date.now() - lastInputAt >= 5_000) {
      yield* platform.release();
      heldButtons.clear();
    }
  }))).pipe(
    Effect.catch(() => Effect.logWarning("Computer pointer release failed; retrying")),
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.forkScoped,
  );

  const info = Effect.fn("Desktop.info")(function* () {
    const current = yield* platform.info();

    return { ...current, id: authority.computerId, name, controlOwner: owner, capabilities: agentHost ? [...current.capabilities, "agent-host" as const] : current.capabilities } satisfies Computer;
  });

  return Desktop.of({
    info, owner: () => owner,
    capture: Effect.fn("Desktop.capture")((displayId: string) => serial.withPermit(Effect.gen(function* () {
      const current = yield* info();
      const display = current.displays.find(display => display.id === displayId);

      if (!display) return yield* Effect.fail(invalid("display_missing", "The selected display is unavailable"));
      const png = yield* platform.capture(display);

      if (png.length < 24 || Buffer.from(png.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a") return yield* Effect.fail(invalid("invalid_frame", "Capture did not produce a PNG image"));
      const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
      const width = view.getUint32(16), height = view.getUint32(20);
      const frame: Frame = { id: crypto.randomUUID(), displayId, capturedAt: Date.now(), width, height, originX: display.x, originY: display.y, scaleX: display.width / width, scaleY: display.height / height };

      for (const [id, previous] of frames) if (previous.capturedAt < Date.now() - 30_000) frames.delete(id);
      frames.set(frame.id, frame);

      while (frames.size > 120) {
        const first = frames.keys().next().value;

        if (first) frames.delete(first);
      }

      return { frame, png };
    }))),
    act: Effect.fn("Desktop.act")((request: ActionsRequest) => serial.withPermit(Effect.gen(function* () {
      if (dispatched.has(request.requestId)) return yield* Effect.fail(invalid("already_dispatched", "This input request was already dispatched; observe the computer before continuing"));
      const frame = frames.get(request.frameId);

      if (!frame || frame.displayId !== request.displayId || Date.now() - frame.capturedAt > 30_000) return yield* Effect.fail(invalid("stale_frame", "Capture the selected display again before sending input"));
      const current = yield* info();
      const display = current.displays.find(display => display.id === frame.displayId);

      if (!display || display.x !== frame.originX || display.y !== frame.originY || display.width !== frame.width * frame.scaleX || display.height !== frame.height * frame.scaleY) return yield* Effect.fail(invalid("display_changed", "The display geometry changed; capture it again"));

      if (!current.capabilities.includes("input")) return yield* Effect.fail(invalid("input_unavailable", "Input permission is not available on this computer"));

      for (const action of request.actions) if ("x" in action && (action.x >= frame.width || action.y >= frame.height)) return yield* Effect.fail(invalid("coordinates_outside_frame", "Input coordinates are outside the captured image"));

      if (request.actor !== owner) return yield* Effect.fail(invalid("control_owner", owner === "user" ? "The user has control of this computer" : "Take control before sending user input"));
      dispatched.add(request.requestId);
      let executed = 0;

      for (const action of request.actions) {
        if (request.actor !== owner) return yield* Effect.fail(invalid("control_changed", `Control changed after ${executed} actions`));
        const mapped: Action = "x" in action ? { ...action, x: frame.originX + action.x * frame.scaleX, y: frame.originY + action.y * frame.scaleY } : action;
        yield* platform.act(mapped);
        lastInputAt = Date.now();

        if (action.type === "pointer_down") heldButtons.add(action.button);

        if (action.type === "pointer_up") heldButtons.delete(action.button);
        executed += 1;
      }

      return { executed };
    }))),
    control: Effect.fn("Desktop.control")(function* (next: "user" | "agent") {
      owner = next;
      yield* serial.withPermit(platform.release());
      heldButtons.clear();
    }),
  });
}));
