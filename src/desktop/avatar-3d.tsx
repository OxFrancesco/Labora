import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useGpuixRequired } from "@gpuix/react";
import type { ImgInstance, PublicInstance } from "@gpuix/react";
import { renderAvatar } from "./avatar-renderer";
import type { AvatarFrame } from "./avatar-renderer";

interface Avatar3DProps {
  modelPath: string;
  name: string;
  size: number;
  interactive?: boolean;
  onClick?: () => void;
}

const initialPose = { yaw: 0.16, pitch: -0.08 };

export function Avatar3D({ modelPath, name, size, interactive = false, onClick }: Avatar3DProps) {
  const renderer = useGpuixRequired();
  const surface = useRef<PublicInstance | null>(null);
  const image = useRef<ImgInstance | null>(null);
  const [pose, setPose] = useState(initialPose);
  const [frame, setFrame] = useState<AvatarFrame | null>(null);
  const [error, setError] = useState("");
  const pixels = Math.min(512, Math.max(64, Math.round(size * 2)));

  useEffect(() => {
    let cancelled = false;

    const timer = setTimeout(() => {
      void renderAvatar({ model: modelPath, width: pixels, height: pixels, ...pose }).then((next) => {
        if (cancelled) return;
        setFrame(next);
        setError("");
      }).catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });
    }, interactive ? 60 : 0);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [modelPath, pixels, pose, interactive]);

  useLayoutEffect(() => {
    if (frame) image.current?.setImagePixels(frame.width, frame.height, frame.pixels);
  }, [frame]);

  return (
    <div
      ref={surface}
      role="img"
      aria-label={error ? `${name}: ${error}` : `${name}, 3D character`}
      testId={`avatar3d-view-${name.split(",")[0]?.toLowerCase()}-${size}`}
      onClick={onClick}
      onMouseMove={(event) => {
        if (!interactive || !surface.current || event.x === undefined || event.y === undefined) return;
        const bounds = renderer.getElementBounds?.(surface.current.id);

        if (!bounds) return;
        const yaw = Math.round(((event.x - bounds.x) / bounds.width - 0.5) * 14) / 20;
        const pitch = Math.round(((event.y - bounds.y) / bounds.height - 0.5) * 8) / 20;
        setPose((current) => current.yaw === yaw && current.pitch === pitch ? current : { yaw, pitch });
      }}
      onMouseLeave={() => { if (interactive) setPose(initialPose); }}
      style={{ width: size, height: size, flexShrink: 0, position: "relative", pointerEvents: interactive ? "auto" : "none" }}
    >
      {frame ? (
        <img
          ref={image}
          alt={name}
          testId={`avatar3d-ready-${name.split(",")[0]?.toLowerCase()}-${size}`}
          objectFit="contain"
          style={{ width: size, height: size, pointerEvents: "none" }}
        />
      ) : null}
    </div>
  );
}
