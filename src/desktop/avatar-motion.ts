export type AvatarActivity =
  | "idle"
  | "thinking"
  | "compacting"
  | "streaming"
  | "working"
  | "waiting"
  | "asking"
  | "retrying"
  | "complete"
  | "failed"
  | "cancelled"
  | "reconnecting";

export interface AvatarPose {
  yaw: number;
  pitch: number;
  roll: number;
  lift: number;
  stretch: number;
  eyeOpen: number;
}

export const avatarActivityLabels: Record<AvatarActivity, string> = {
  idle: "Ready",
  thinking: "Thinking",
  compacting: "Tidying context",
  streaming: "Writing",
  working: "Using tools",
  waiting: "Waiting for approval",
  asking: "Waiting for your answer",
  retrying: "Retrying",
  complete: "Complete",
  failed: "Needs attention",
  cancelled: "Stopped",
  reconnecting: "Reconnecting",
};

const neutral: AvatarPose = { yaw: 0.16, pitch: -0.08, roll: 0, lift: 0, stretch: 1, eyeOpen: 1 };

function round(value: number, steps: number) {
  return Math.round(value * steps) / steps;
}

function blink(elapsed: number, period = 4_800) {
  const phase = elapsed % period;

  if (phase < period - 180) return 1;

  return phase < period - 120 || phase > period - 60 ? 0.5 : 0.12;
}

export function avatarPose(activity: AvatarActivity, elapsed: number, reducedMotion: boolean, small: boolean): AvatarPose {
  const pose = { ...neutral };

  switch (activity) {
    case "thinking":
    case "compacting":
      pose.yaw = -0.1;
      pose.pitch = -0.16;
      pose.roll = -0.06;
      break;
    case "streaming":
      pose.pitch = 0.04;
      break;
    case "working":
      pose.pitch = 0.1;
      pose.stretch = 0.98;
      break;
    case "waiting":
    case "asking":
      pose.yaw = 0.04;
      pose.roll = 0.13;
      break;
    case "retrying":
      pose.yaw = -0.12;
      pose.roll = -0.08;
      break;
    case "complete":
      pose.pitch = -0.03;
      pose.eyeOpen = 0.72;
      break;
    case "failed":
      pose.pitch = 0.12;
      pose.roll = -0.12;
      pose.eyeOpen = 0.8;
      break;
    case "cancelled":
      pose.pitch = 0.06;
      pose.eyeOpen = 0.65;
      break;
    case "reconnecting":
      pose.pitch = 0.16;
      pose.roll = 0.08;
      pose.eyeOpen = 0.45;
      break;
    case "idle":
      break;
  }

  if (reducedMotion) return pose;
  const turn = 2 * Math.PI;

  switch (activity) {
    case "idle":
      if (!small) {
        pose.lift = Math.sin(elapsed / 3_200 * turn) * 0.018;
        pose.eyeOpen = blink(elapsed);
      }

      break;
    case "thinking":
    case "compacting":
      pose.yaw += Math.sin(elapsed / 2_400 * turn) * 0.07;
      pose.roll += Math.sin(elapsed / 2_400 * turn) * 0.025;
      pose.eyeOpen = blink(elapsed, 3_200);
      break;
    case "streaming":
      pose.pitch += Math.sin(elapsed / 900 * turn) * 0.045;
      pose.lift = Math.sin(elapsed / 900 * turn) * 0.026;
      pose.eyeOpen = blink(elapsed, 3_200);
      break;
    case "working": {
      const bob = Math.sin(elapsed / 800 * turn);
      pose.roll = Math.sin(elapsed / 1_600 * turn) * 0.08;
      pose.lift = (bob + 1) * 0.025;
      pose.stretch += bob * 0.02;
      pose.eyeOpen = blink(elapsed, 3_200);
      break;
    }

    case "waiting":
    case "asking":
      pose.eyeOpen = blink(elapsed);
      break;
    case "retrying":
      pose.yaw += Math.sin(elapsed / 2_400 * turn) * 0.08;
      pose.eyeOpen = blink(elapsed, 3_200);
      break;
    case "complete":
      if (elapsed < 300) {
        const hop = Math.sin(elapsed / 300 * Math.PI);
        pose.lift = hop * 0.14;
        pose.stretch = 1 + hop * 0.025;
        pose.roll = hop * 0.055;
      }

      break;
    case "failed":
      if (elapsed < 280) pose.yaw += Math.sin(elapsed / 280 * turn * 2) * 0.15 * (1 - elapsed / 280);
      break;
    case "cancelled":
      if (elapsed < 200) pose.lift = (1 - elapsed / 200) * 0.035;
      break;
    case "reconnecting":
      break;
  }

  return {
    yaw: round(pose.yaw, 100),
    pitch: round(pose.pitch, 100),
    roll: round(pose.roll, 100),
    lift: round(pose.lift, 100),
    stretch: round(pose.stretch, 100),
    eyeOpen: pose.eyeOpen,
  };
}

export function avatarFrameInterval(activity: AvatarActivity, small: boolean, elapsed: number) {
  if (activity === "reconnecting" || activity === "idle" && small) return Infinity;

  if (activity === "complete" && elapsed >= 300 || activity === "failed" && elapsed >= 280 || activity === "cancelled" && elapsed >= 200) return Infinity;

  return activity === "idle" || activity === "waiting" || activity === "asking" ? 80 : small ? 80 : 50;
}
