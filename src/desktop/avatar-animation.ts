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
  sampled: number;
  previous: string;
  pointer: PointerPose;
}

const pointerFrameInterval = 1_000 / 60;

const subscriptions = new Set<Subscription>();

let environment: AvatarEnvironment = { reducedMotion: true, applicationActive: false };

let environmentDue = 0;

let environmentFailed = false;

let timer: ReturnType<typeof setTimeout> | undefined;

let ticking = false;

let scheduledAt = Infinity;

function schedule() {
  if (ticking || !subscriptions.size) return;
  const now = performance.now();
  let next = environmentDue;

  for (const subscription of subscriptions) {
    if (!subscription.previous || environment.applicationActive) next = Math.min(next, subscription.due);
  }

  const delay = Math.max(1, Math.min(1_000, next - now));

  if (timer && scheduledAt <= now + delay) return;

  if (timer) clearTimeout(timer);
  scheduledAt = now + delay;
  timer = setTimeout(() => {
    timer = undefined;
    scheduledAt = Infinity;
    void tick();
  }, delay);
}

async function paint(subscription: Subscription, now: number) {
  const { animation } = subscription;
  const elapsed = now - subscription.started;
  const pose = avatarPose(animation.activity, elapsed, environment.reducedMotion, animation.small);
  const pointer = environment.reducedMotion ? null : animation.pointer();

  const follow = 1 - Math.exp(-Math.min(100, now - subscription.sampled) / 35);
  subscription.sampled = now;
  subscription.pointer.yaw += ((pointer?.yaw ?? 0) - subscription.pointer.yaw) * follow;
  subscription.pointer.pitch += ((pointer?.pitch ?? 0) - subscription.pointer.pitch) * follow;
  pose.yaw += Math.round(subscription.pointer.yaw * 10_000) / 10_000;
  pose.pitch += Math.round(subscription.pointer.pitch * 10_000) / 10_000;
  const key = JSON.stringify(pose);
  const movingPointer = pointer || Math.abs(subscription.pointer.yaw) > 0.005 || Math.abs(subscription.pointer.pitch) > 0.005;
  const interval = environment.reducedMotion ? Infinity : movingPointer ? pointerFrameInterval : avatarFrameInterval(animation.activity, animation.small, elapsed);
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
    sampled: performance.now() - pointerFrameInterval,
    previous: "",
    pointer: { yaw: 0, pitch: 0 },
  };

  subscriptions.add(subscription);
  schedule();

  return {
    wake() {
      subscription.due = Math.min(subscription.due, Math.max(performance.now(), subscription.sampled + pointerFrameInterval));

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
