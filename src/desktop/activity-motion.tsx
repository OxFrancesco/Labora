import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useGpuixRequired, type PublicInstance } from "@gpuix/react";
import { avatarEnvironment } from "./avatar-renderer";
import { color } from "./theme";

let environmentCheck: ReturnType<typeof avatarEnvironment> | undefined;

let environmentTime = 0;

function motionEnvironment() {
  if (!environmentCheck || Date.now() - environmentTime > 900) {
    environmentTime = Date.now();
    environmentCheck = avatarEnvironment();
  }

  return environmentCheck;
}

export function useActivityMotion(active: boolean) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!active) {
      setEnabled(false);

      return;
    }

    let stopped = false;

    const refresh = async () => {
      try {
        const environment = await motionEnvironment();

        if (!stopped) setEnabled(!environment.reducedMotion && environment.applicationActive);
      } catch { if (!stopped) setEnabled(false); }
    };

    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1_000);

    return () => { stopped = true; clearInterval(timer); };
  }, [active]);

  return enabled;
}

// T3's 72px travelling alpha mask, sampled into native clipping strips.
// Both tracks run in GPUI; React only resets the 2.2s cycle, never each frame.
export const ActivityShimmer = memo(function ActivityShimmer({ active, children }: { active: boolean; children: (highlighted: boolean) => ReactNode }) {
  const renderer = useGpuixRequired();
  const ref = useRef<PublicInstance>(null);
  const enabled = useActivityMotion(active);
  const [cycle, setCycle] = useState(0);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!enabled) return;

    const measure = () => {
      const bounds = ref.current ? renderer.getElementBounds?.(ref.current.id) : null;
      setWidth(bounds?.width ?? 0);
      setCycle((value) => value + 1);
    };

    const initial = setTimeout(measure, 40);
    const timer = setInterval(measure, 2_200);

    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [enabled, renderer]);
  const stops = [[0, 0], [10.8, .12], [25.2, .55], [36, 1], [46.8, .55], [61.2, .12], [72, 0]];

  return <div ref={ref} style={{ position: "relative", minWidth: 0, maxWidth: "100%", display: "flex", flexDirection: "column", flexShrink: 1, overflow: "hidden" }}>
    {children(false)}
    {enabled && width > 0 ? Array.from({ length: 24 }, (_, index) => {
      const x = index * 3;
      const right = stops.findIndex(([position]) => position! >= x + 1.5);
      const [a, alpha] = stops[right - 1]!;
      const [b, beta] = stops[right]!;
      const opacity = alpha! + (beta! - alpha!) * (x + 1.5 - a!) / (b! - a!);

      return <motion.div key={`${cycle}-${index}`} initial={{ left: -72 + x }} animate={{ left: width + 72 + x }} transition={{ duration: 2.2, ease: "linear" }} style={{ position: "absolute", top: 0, bottom: 0, width: 3, overflow: "hidden", opacity, pointerEvents: "none", userSelect: "none" }}>
        <motion.div initial={{ left: 72 - x }} animate={{ left: -width - 72 - x }} transition={{ duration: 2.2, ease: "linear" }} style={{ position: "absolute", top: 0, width, pointerEvents: "none" }}>{children(true)}</motion.div>
      </motion.div>;
    }) : null}
  </div>;
});

export const DisclosureArrow = memo(function DisclosureArrow({ expanded }: { expanded: boolean }) {
  const enabled = useActivityMotion(true);
  const angle = useRef(expanded ? 90 : 0);
  const [shown, setShown] = useState(angle.current);
  useEffect(() => {
    const target = expanded ? 90 : 0;

    if (!enabled) {
      angle.current = target;
      setShown(target);

      return;
    }

    const start = performance.now();
    const from = angle.current;

    const timer = setInterval(() => {
      const t = Math.min(1, (performance.now() - start) / 200);
      // CSS ease-in-out, cubic-bezier(.4, 0, .2, 1).
      let low = 0, high = 1;

      for (let i = 0; i < 10; i++) {
        const p = (low + high) / 2;
        const x = 3 * (1 - p) ** 2 * p * .4 + 3 * (1 - p) * p ** 2 * .2 + p ** 3;

        if (x < t) low = p; else high = p;
      }

      const p = (low + high) / 2;
      angle.current = from + (target - from) * (3 * (1 - p) * p ** 2 + p ** 3);
      setShown(angle.current);

      if (t === 1) clearInterval(timer);
    }, 16);

    return () => clearInterval(timer);
  }, [expanded, enabled]);

  return <svg source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path transform="rotate(${shown} 12 12)" d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`} style={{ width: 12, height: 12, color: color.secondary, opacity: .7, flexShrink: 0 }} />;
});
