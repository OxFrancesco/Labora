import { resolve } from "node:path";
import { Schema } from "effect";

const FrameResponse = Schema.Struct({
  id: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  pixels: Schema.String,
  nodes: Schema.Number,
  materials: Schema.Array(Schema.String),
});

const RenderResponse = Schema.fromJsonString(Schema.Union([
  FrameResponse,
  Schema.Struct({ id: Schema.Number, error: Schema.String }),
]));

export interface AvatarFrame {
  width: number;
  height: number;
  pixels: Buffer;
  nodes: number;
  materials: readonly string[];
}

export interface AvatarRenderRequest {
  model: string;
  width: number;
  height: number;
  yaw: number;
  pitch: number;
}

interface PendingFrame {
  resolve: (frame: AvatarFrame) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

class NativeAvatarRenderer {
  private sequence = 0;
  private pending = new Map<number, PendingFrame>();
  private child = Bun.spawn([
    process.env.LABORA_AVATAR_HELPER ?? resolve(import.meta.dir, "../../dist/labora-avatar"),
  ], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });

  constructor() {
    void this.read().catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
    void this.child.exited.then((code) => this.fail(new Error(`The native 3D renderer exited (${code}).`)));
  }

  private fail(error: Error) {
    this.child.kill();

    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }

    this.pending.clear();

    if (active === this) active = undefined;
  }

  private async read() {
    const decoder = new TextDecoder();
    let buffered = "";

    for await (const chunk of this.child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");

      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const response = Schema.decodeUnknownSync(RenderResponse)(line);
        const request = this.pending.get(response.id);

        if (request) {
          clearTimeout(request.timeout);
          this.pending.delete(response.id);

          if ("error" in response) request.reject(new Error(response.error));
          else {
            const pixels = Buffer.from(response.pixels, "base64");

            if (pixels.length !== response.width * response.height * 4) request.reject(new Error("The 3D renderer returned an incomplete frame."));
            else request.resolve({ ...response, pixels });
          }
        }

        newline = buffered.indexOf("\n");
      }
    }
  }

  render(options: AvatarRenderRequest): Promise<AvatarFrame> {
    const id = ++this.sequence;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.child.kill();
        this.fail(new Error("The native 3D renderer timed out."));
      }, 30_000);

      this.pending.set(id, { resolve, reject, timeout });

      try { this.child.stdin.write(`${JSON.stringify({ id, ...options })}\n`); }
      catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close() {
    this.child.stdin.end();
    this.fail(new Error("The native 3D renderer closed."));
  }
}

let active: NativeAvatarRenderer | undefined;

const frames = new Map<string, Promise<AvatarFrame>>();

export function renderAvatar(options: AvatarRenderRequest): Promise<AvatarFrame> {
  const key = JSON.stringify(options);
  const previous = frames.get(key);

  if (previous) return previous;
  active ??= new NativeAvatarRenderer();

  const result = active.render(options).catch((error) => {
    frames.delete(key);

    throw error;
  });

  frames.set(key, result);

  if (frames.size > 128) {
    const oldest = frames.keys().next().value;

    if (oldest) frames.delete(oldest);
  }

  return result;
}

export function closeAvatarRenderer() {
  active?.close();
  active = undefined;
  frames.clear();
}
