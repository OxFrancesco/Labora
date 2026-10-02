import { resolve } from "node:path";
import { Schema } from "effect";

const FrameResponse = Schema.Struct({
  kind: Schema.Literal("frame"),
  id: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  pixels: Schema.String,
  nodes: Schema.Number,
  materials: Schema.Array(Schema.String),
});

const EnvironmentResponse = Schema.Struct({
  kind: Schema.Literal("environment"),
  id: Schema.Number,
  reducedMotion: Schema.Boolean,
  applicationActive: Schema.Boolean,
});

const RenderResponse = Schema.fromJsonString(Schema.Union([
  FrameResponse,
  EnvironmentResponse,
  Schema.Struct({ id: Schema.Number, error: Schema.String }),
]));

type HelperResponse = typeof RenderResponse.Type;

export interface AvatarEnvironment {
  reducedMotion: boolean;
  applicationActive: boolean;
}

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
  roll?: number;
  lift?: number;
  stretch?: number;
  eyeOpen?: number;
}

interface PendingResponse {
  resolve: (frame: HelperResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

class NativeAvatarRenderer {
  private sequence = 0;
  private pending = new Map<number, PendingResponse>();
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
          else request.resolve(response);
        }

        newline = buffered.indexOf("\n");
      }
    }
  }

  request(options: AvatarRenderRequest | { kind: "environment" }): Promise<HelperResponse> {
    const id = ++this.sequence;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
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

interface CachedFrame {
  frame: Promise<AvatarFrame>;
  bytes: number;
}

const frames = new Map<string, CachedFrame>();

const maximumCacheBytes = 24 * 1024 * 1024;

let cacheBytes = 0;

function forgetFrame(key: string) {
  const entry = frames.get(key);

  if (entry) cacheBytes -= entry.bytes;
  frames.delete(key);
}

export async function avatarEnvironment(): Promise<AvatarEnvironment> {
  active ??= new NativeAvatarRenderer();
  const response = await active.request({ kind: "environment" });

  if ("error" in response) throw new Error(response.error);

  if (response.kind !== "environment") throw new Error("The 3D renderer returned an invalid environment.");

  return response;
}

export function renderAvatar(options: AvatarRenderRequest): Promise<AvatarFrame> {
  const key = JSON.stringify(options);
  const previous = frames.get(key);

  if (previous) {
    frames.delete(key);
    frames.set(key, previous);

    return previous.frame;
  }

  active ??= new NativeAvatarRenderer();

  const result = active.request(options).then((response) => {
    if ("error" in response) throw new Error(response.error);

    if (response.kind !== "frame") throw new Error("The 3D renderer returned an invalid frame.");
    const pixels = Buffer.from(response.pixels, "base64");

    if (pixels.length !== response.width * response.height * 4) throw new Error("The 3D renderer returned an incomplete frame.");

    return { ...response, pixels };
  }).catch((error) => {
    forgetFrame(key);
    throw error;
  });

  const bytes = options.width * options.height * 4;
  frames.set(key, { frame: result, bytes });
  cacheBytes += bytes;

  while (cacheBytes > maximumCacheBytes || frames.size > 256) {
    const oldest = frames.keys().next().value;

    if (!oldest) break;
    forgetFrame(oldest);
  }

  return result;
}

export function closeAvatarRenderer() {
  active?.close();
  active = undefined;
  frames.clear();
  cacheBytes = 0;
}
