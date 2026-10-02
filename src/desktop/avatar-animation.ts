import { avatarEnvironment, renderAvatar } from "./avatar-renderer";
import type { AvatarEnvironment, AvatarFrame } from "./avatar-renderer";
import { avatarFrameInterval, avatarPose } from "./avatar-motion";
import type { AvatarActivity } from "./avatar-motion";

interface PointerPose {
  yaw: number;
  pitch: number;
}

interface AvatarAnimation {
  model: string;
  pixels: number;
  small: boolean;
  activity: AvatarActivity;
  settled: boolean;
  pointer: () => PointerPose | null;
  onFrame: (frame: AvatarFrame) => void;
  onError: (error: Error) => void;
}

interface Subscription {
  animation: AvatarAnimation;
  started: number;
  due: number;
  previous: string;
  pointer: PointerPose;
}

const subscriptions = new Set<Subscription>();

let environment: AvatarEnvironment = { reducedMotion: true, applicationActive: false };

let environmentDue = 0;

let environmentFailed = false;

let timer: ReturnType<typeof setTimeout> | undefined;

let ticking = false;

function schedule() {
  if (timer || ticking || !subscriptions.size) return;
  const now = performance.now();
  let next = environmentDue;

  for (const subscription of subscriptions) {
    if (!subscription.previous || environment.applicationActive) next = Math.min(next, subscription.due);
  }

  timer = setTimeout(() => {
    timer = undefined;
    void tick();
  }, Math.max(16, Math.min(1_000, next - now)));
}

async function paint(subscription: Subscription, now: number) {
  const { animation } = subscription;
  const elapsed = now - subscription.started;
  const pose = avatarPose(animation.activity, elapsed, environment.reducedMotion, animation.small);
  const pointer = environment.reducedMotion ? null : animation.pointer();

  subscription.pointer.yaw += ((pointer?.yaw ?? 0) - subscription.pointer.yaw) * 0.4;
  subscription.pointer.pitch += ((pointer?.pitch ?? 0) - subscription.pointer.pitch) * 0.4;
  pose.yaw += Math.round(subscription.pointer.yaw * 100) / 100;
  pose.pitch += Math.round(subscription.pointer.pitch * 100) / 100;
  const key = JSON.stringify(pose);
  const movingPointer = pointer || Math.abs(subscription.pointer.yaw) > 0.005 || Math.abs(subscription.pointer.pitch) > 0.005;
  const interval = environment.reducedMotion ? Infinity : movingPointer ? 50 : avatarFrameInterval(animation.activity, animation.small, elapsed);
  subscription.due = now + interval;

  if (subscription.previous === key) return;

  try {
    const frame = await renderAvatar({ model: animation.model, width: animation.pixels, height: animation.pixels, ...pose });

    if (!subscriptions.has(subscription)) return;
    subscription.previous = key;
    animation.onFrame(frame);
  } catch (reason) {
    subscription.due = now + 5_000;

    if (subscriptions.has(subscription)) animation.onError(reason instanceof Error ? reason : new Error(String(reason)));
  }
}

async function tick() {
  ticking = true;
  const now = performance.now();

  try {
    if (now >= environmentDue) {
      environmentDue = now + 1_000;

      try {
        const next = await avatarEnvironment();

        if (environmentFailed || next.reducedMotion !== environment.reducedMotion || next.applicationActive && !environment.applicationActive) {
          for (const subscription of subscriptions) {
            subscription.due = 0;

            if (environmentFailed) subscription.previous = "";
          }
        }

        environment = next;
        environmentFailed = false;
      } catch (reason) {
        environmentFailed = true;
        environmentDue = now + 5_000;
        const error = reason instanceof Error ? reason : new Error(String(reason));

        for (const subscription of subscriptions) subscription.animation.onError(error);

        return;
      }
    }

    const due: Subscription[] = [];

    for (const subscription of subscriptions) {
      if (subscription.due <= now && (!subscription.previous || environment.applicationActive)) due.push(subscription);
    }

    due.sort((first, second) => first.due - second.due);
    await Promise.all(due.slice(0, 4).map((subscription) => paint(subscription, now)));
  } finally {
    ticking = false;
    schedule();
  }
}

export function animateAvatar(animation: AvatarAnimation) {
  const subscription: Subscription = {
    animation,
    started: performance.now() - (animation.settled ? 1_000 : 0),
    due: 0,
    previous: "",
    pointer: { yaw: 0, pitch: 0 },
  };

  subscriptions.add(subscription);
  schedule();

  return {
    wake() {
      subscription.due = 0;

      if (timer) clearTimeout(timer);
      timer = undefined;
      schedule();
    },
    stop() {
      subscriptions.delete(subscription);

      if (!subscriptions.size && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
