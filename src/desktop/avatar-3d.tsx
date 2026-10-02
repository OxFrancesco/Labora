import { useEffect, useRef, useState } from "react";
import { useGpuixRequired } from "@gpuix/react";
import type { ImgInstance, PublicInstance } from "@gpuix/react";
import { animateAvatar } from "./avatar-animation";
import { avatarActivityLabels } from "./avatar-motion";
import type { AvatarActivity } from "./avatar-motion";

interface Avatar3DProps {
  modelPath: string;
  name: string;
  size: number;
  interactive?: boolean;
  activity?: AvatarActivity;
  activityKey?: string | number;
  onClick?: () => void;
}

export function Avatar3D({ modelPath, name, size, interactive = false, activity = "idle", activityKey, onClick }: Avatar3DProps) {
  const renderer = useGpuixRequired();
  const surface = useRef<PublicInstance | null>(null);
  const image = useRef<ImgInstance | null>(null);
  const pointer = useRef<{ yaw: number; pitch: number } | null>(null);
  const animation = useRef<ReturnType<typeof animateAvatar> | null>(null);
  const displayed = useRef(false);
  const failed = useRef(false);
  const observedRun = useRef<{ key: string | number | undefined; terminalPending: boolean } | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const pixels = Math.min(512, Math.max(64, Math.round(size * 2)));

  useEffect(() => {
    const active = activity === "thinking" || activity === "streaming" || activity === "working" || activity === "waiting" || activity === "retrying";
    const terminal = activity === "complete" || activity === "failed" || activity === "cancelled";

    if (active && (!observedRun.current || observedRun.current.key !== activityKey))
      observedRun.current = { key: activityKey, terminalPending: true };
    const settled = terminal && (!observedRun.current || observedRun.current.key !== activityKey || !observedRun.current.terminalPending);

    if (terminal) observedRun.current = { key: activityKey, terminalPending: false };

    const subscription = animateAvatar({
      model: modelPath,
      pixels,
      small: size < 64,
      activity,
      settled,
      pointer: () => interactive ? pointer.current : null,
      onFrame: (frame) => {
        image.current?.setImagePixels(frame.width, frame.height, frame.pixels);

        if (!displayed.current) {
          displayed.current = true;
          setReady(true);
        }

        if (failed.current) {
          failed.current = false;
          setError("");
        }
      },
      onError: (reason) => {
        failed.current = true;
        setError(reason.message);
      },
    });

    animation.current = subscription;

    return () => {
      subscription.stop();
      animation.current = null;
    };
  }, [modelPath, pixels, size, interactive, activity, activityKey]);

  return (
    <div
      ref={surface}
      role="img"
      aria-label={error ? `${name}: ${error}` : `${name}, ${avatarActivityLabels[activity]}`}
      testId={`avatar3d-view-${name.split(",")[0]?.toLowerCase()}-${size}`}
      onClick={onClick}
      onMouseMove={(event) => {
        if (!interactive || !surface.current || event.x === undefined || event.y === undefined) return;
        const bounds = renderer.getElementBounds?.(surface.current.id);

        if (!bounds) return;
        const yaw = Math.round(((event.x - bounds.x) / bounds.width - 0.5) * 8) / 20;
        const pitch = Math.round(((event.y - bounds.y) / bounds.height - 0.5) * 5) / 20;
        pointer.current = { yaw, pitch };
        animation.current?.wake();
      }}
      onMouseLeave={() => {
        pointer.current = null;
        animation.current?.wake();
      }}
      style={{ width: size, height: size, flexShrink: 0, position: "relative", pointerEvents: interactive ? "auto" : "none" }}
    >
      <img
        ref={image}
        alt={name}
        testId={`avatar3d-${ready ? "ready" : "loading"}-${name.split(",")[0]?.toLowerCase()}-${size}`}
        objectFit="contain"
        style={{ width: size, height: size, pointerEvents: "none" }}
      />
    </div>
  );
}
