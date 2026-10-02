import { resolve } from "node:path";
import { Schema } from "effect";

const Permission = Schema.Literals(["authorized", "not-determined", "restricted", "denied"]);

const VoiceStatus = Schema.Struct({
  type: Schema.Literal("status"),
  id: Schema.Number,
  locale: Schema.String,
  microphone: Permission,
  speech: Permission,
  available: Schema.Boolean,
  onDevice: Schema.Boolean,
  owner: Schema.String,
});

export interface VoiceStatus extends Schema.Schema.Type<typeof VoiceStatus> {}

const VoiceEvent = Schema.Struct({
  type: Schema.Literals(["authorizing", "listening", "partial", "finishing", "final", "cancelled", "error"]),
  id: Schema.Number,
  text: Schema.String,
  message: Schema.String,
});

export interface VoiceEvent extends Schema.Schema.Type<typeof VoiceEvent> {}

const Response = Schema.fromJsonString(Schema.Union([VoiceStatus, VoiceEvent]));

interface PendingStatus {
  resolve: (status: VoiceStatus) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class NativeVoice {
  private sequence = 0;
  private session: number | null = null;
  private closed = false;
  private pending = new Map<number, PendingStatus>();
  private child = Bun.spawn([
    process.env.LABORA_VOICE_HELPER ?? resolve(import.meta.dir, "../../dist/labora-voice"),
  ], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });

  constructor(private readonly onEvent: (event: VoiceEvent) => void) {
    void this.read().catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
    void this.child.exited.then((code) => this.fail(new Error(`Dictation stopped (${code}).`)));
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.child.kill();

    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }

    this.pending.clear();

    if (this.session !== null) this.onEvent({ type: "error", id: this.session, text: "", message: error.message });
    this.session = null;
  }

  private async read() {
    const decoder = new TextDecoder();
    let buffered = "";

    for await (const chunk of this.child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });

      if (buffered.length > 1_048_576) throw new Error("Dictation returned an invalid response.");
      let newline = buffered.indexOf("\n");

      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const response = Schema.decodeUnknownSync(Response)(line);

        if (response.type === "status") {
          const request = this.pending.get(response.id);

          if (request) {
            clearTimeout(request.timeout);
            this.pending.delete(response.id);
            request.resolve(response);
          }
        } else if (response.id === this.session) {
          if (["final", "cancelled", "error"].includes(response.type)) this.session = null;
          this.onEvent(response);
        }

        newline = buffered.indexOf("\n");
      }
    }
  }

  private send(id: number, action: "status" | "start" | "stop" | "cancel", locale?: string) {
    if (this.closed) throw new Error("Dictation is closed. Try starting it again.");
    this.child.stdin.write(`${JSON.stringify({ id, action, locale })}\n`);
  }

  status(locale?: string): Promise<VoiceStatus> {
    const id = ++this.sequence;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Could not check dictation availability."));
      }, 10_000);

      this.pending.set(id, { resolve, reject, timeout });

      try { this.send(id, "status", locale); }
      catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  start(locale?: string): number {
    if (this.session !== null) throw new Error("Dictation is already running.");
    const id = ++this.sequence;
    this.session = id;

    try { this.send(id, "start", locale); }
    catch (error) { this.session = null; throw error; }

    return id;
  }

  stop() {
    if (this.session !== null) this.send(this.session, "stop");
  }

  cancel() {
    if (this.session !== null) this.send(this.session, "cancel");
  }

  close() {
    this.fail(new Error("Dictation closed."));
  }
}
