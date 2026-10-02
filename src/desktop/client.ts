import { Effect, Result, Schema } from "effect";
import { AgentEvent, AuthStatus, Bot, BotActivity, MessageSnapshot, QueuedInputResult, WorkspaceFile } from "../backend/contracts";
import type {
  ApprovalResponse,
  AuthStart,
  CreateBot,
  SendMessage,
  QuestionResponse,
  QueueInput,
  UpdateBot,
} from "../backend/contracts";
import { Computer, PairResponse } from "../computer/contracts";
import type { Action, ControlRequest } from "../computer/contracts";
import type { Connection } from "./store";
import { Routine, RoutineRun } from "../backend/routine-contracts";
import type { CreateRoutine, UpdateRoutine } from "../backend/routine-contracts";

const RoutineList = Schema.Struct({ routines: Schema.Array(Routine) });

const SavedRoutine = Schema.Struct({ routine: Routine });

const RoutineRuns = Schema.Struct({ runs: Schema.Array(RoutineRun) });

const StartedRoutineRun = Schema.Struct({ run: RoutineRun });

const BotList = Schema.Struct({ bots: Schema.Array(Bot) });

const CreatedBot = Schema.Struct({ bot: Bot });

const Run = Schema.Struct({ runId: Schema.String });

const Files = Schema.Struct({ files: Schema.Array(WorkspaceFile) });

const Failure = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
);

const PixelDimension = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 32768 }),
);

export function normalizeEndpoint(value: string) {
  const url = new URL(value.trim());

  if (url.username || url.password || url.search || url.hash)
    throw new Error("Use the computer address without credentials or query parameters.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    throw new Error("Use the HTTPS address from Tailscale Serve or Cloudflare.");

  return url.href.replace(/\/$/, "");
}

async function ensureResponse(response: Response) {
  if (!response.ok) {
    const body = await response.text();
    const failure = Schema.decodeUnknownResult(Failure)(body);
    throw new Error(
      Result.isSuccess(failure)
        ? failure.success.error.message
        : `The computer could not complete the request (${response.status}).`,
    );
  }

  return response;
}

export async function pairComputer(endpoint: string, code: string): Promise<Connection> {
  const address = normalizeEndpoint(endpoint);

  const response = await ensureResponse(
    await fetch(`${address}/v1/pair`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, clientName: "Labora for macOS" }),
    }),
  );

  const paired = await Effect.runPromise(
    Schema.decodeUnknownEffect(PairResponse)(await response.json()),
  );

  return {
    id: paired.computer.id,
    endpoint: address,
    token: paired.token,
    clientId: paired.clientId,
    computer: paired.computer,
  };
}

export function computerClient(connection: Connection) {
  const request = (path: string, options: RequestInit = {}) =>
    fetch(`${connection.endpoint}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection.token}`,
        "X-Computer-Id": connection.id,
        ...options.headers,
      },
      signal: options.signal ?? AbortSignal.timeout(30_000),
    }).then(ensureResponse);

  return {
    routines: async () =>
      Schema.decodeUnknownSync(RoutineList)(await (await request("/v1/routines")).json()).routines,
    createRoutine: async (routine: CreateRoutine) =>
      Schema.decodeUnknownSync(SavedRoutine)(await (await request("/v1/routines", {
        method: "POST", body: JSON.stringify(routine),
      })).json()).routine,
    updateRoutine: async (id: string, routine: UpdateRoutine) =>
      Schema.decodeUnknownSync(SavedRoutine)(await (await request(`/v1/routines/${id}`, {
        method: "PATCH", body: JSON.stringify(routine),
      })).json()).routine,
    enableRoutine: async (id: string, enabled: boolean) =>
      Schema.decodeUnknownSync(SavedRoutine)(await (await request(`/v1/routines/${id}/enabled`, {
        method: "POST", body: JSON.stringify({ enabled }),
      })).json()).routine,
    deleteRoutine: (id: string) => request(`/v1/routines/${id}`, { method: "DELETE" }),
    routineRuns: async (id: string) =>
      Schema.decodeUnknownSync(RoutineRuns)(await (await request(`/v1/routines/${id}/runs`)).json()).runs,
    runRoutine: async (id: string) =>
      Schema.decodeUnknownSync(StartedRoutineRun)(await (await request(`/v1/routines/${id}/run`, {
        method: "POST",
      })).json()).run,
    disconnect: () => request("/v1/clients/self", { method: "DELETE" }),
    computer: async () =>
      Schema.decodeUnknownSync(Computer)(await (await request("/v1/computer")).json()),
    bots: async () =>
      Schema.decodeUnknownSync(BotList)(await (await request("/v1/bots")).json()).bots,
    createBot: async (bot: CreateBot) =>
      Schema.decodeUnknownSync(CreatedBot)(
        await (await request("/v1/bots", { method: "POST", body: JSON.stringify(bot) })).json(),
      ).bot,
    updateBot: async (id: string, bot: UpdateBot) =>
      Schema.decodeUnknownSync(CreatedBot)(
        await (
          await request(`/v1/bots/${id}`, { method: "PATCH", body: JSON.stringify(bot) })
        ).json(),
      ).bot,
    files: async (id: string) =>
      Schema.decodeUnknownSync(Files)(await (await request(`/v1/bots/${id}/files`)).json()).files,
    file: async (id: string, path: string) =>
      (
        await request(`/v1/bots/${id}/files/content?path=${encodeURIComponent(path)}`)
      ).arrayBuffer(),
    messages: async (id: string, conversationId?: string) =>
      Schema.decodeUnknownSync(MessageSnapshot)(
        await (await request(`/v1/bots/${id}/messages${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`)).json(),
      ),
    activity: async (id: string, signal: AbortSignal) =>
      Schema.decodeUnknownSync(BotActivity)(
        await (await request(`/v1/bots/${id}/activity`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        })).json(),
      ),
    send: async (id: string, message: SendMessage) =>
      Schema.decodeUnknownSync(Run)(
        await (
          await request(`/v1/bots/${id}/messages`, {
            method: "POST",
            body: JSON.stringify(message),
          })
        ).json(),
      ),
    cancel: (id: string, conversationId = "direct", runId?: string) => {
      const query = new URLSearchParams({ conversationId });

      if (runId) query.set("runId", runId);

      return request(`/v1/bots/${id}/cancel?${query}`, { method: "POST" });
    },
    answerQuestion: (id: string, requestId: string, answer: QuestionResponse, conversationId = "direct") =>
      request(`/v1/bots/${id}/questions/${requestId}?conversationId=${encodeURIComponent(conversationId)}`, {
        method: "POST", body: JSON.stringify(answer),
      }),
    queueInput: async (id: string, input: QueueInput, conversationId = "direct") =>
      Schema.decodeUnknownSync(QueuedInputResult)(await (await request(`/v1/bots/${id}/inputs?conversationId=${encodeURIComponent(conversationId)}`, {
        method: "POST", body: JSON.stringify(input),
      })).json()),
    auth: async (id: string) =>
      Schema.decodeUnknownSync(AuthStatus)(await (await request(`/v1/bots/${id}/auth`)).json()),
    startAuth: (id: string, provider: AuthStart["provider"]) =>
      request(`/v1/bots/${id}/auth/start`, { method: "POST", body: JSON.stringify({ provider }) }),
    authInput: (id: string, value: string) =>
      request(`/v1/bots/${id}/auth/input`, { method: "POST", body: JSON.stringify({ value }) }),
    approve: (id: string, requestId: string, decision: ApprovalResponse["decision"]) =>
      request(`/v1/bots/${id}/approvals/${requestId}`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      }),
    control: (owner: ControlRequest["owner"]) =>
      request("/v1/control", { method: "POST", body: JSON.stringify({ owner }) }),
    frame: async (displayId: string) => {
      const response = await request(`/v1/displays/${encodeURIComponent(displayId)}/frame`);
      const frameId = response.headers.get("X-Frame-Id");

      if (!frameId) throw new Error("The computer returned a frame without an identity.");
      const image = Buffer.from(await response.arrayBuffer());

      return {
        frameId,
        width: Schema.decodeUnknownSync(PixelDimension)(response.headers.get("X-Frame-Width")),
        height: Schema.decodeUnknownSync(PixelDimension)(response.headers.get("X-Frame-Height")),
        source: `data:image/png;base64,${image.toString("base64")}`,
      };
    },
    action: (displayId: string, frameId: string, actions: Action[]) =>
      request("/v1/actions", {
        method: "POST",
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          displayId,
          frameId,
          actor: "user",
          actions,
        }),
      }),
    events: async (
      id: string,
      cursor: number,
      signal: AbortSignal,
      onEvent: (event: AgentEvent) => void,
      scope?: "bot",
    ) => {
      const response = await request(`/v1/bots/${id}/events?cursor=${cursor}${scope === "bot" ? "&scope=bot" : ""}`, { signal });

      if (!response.body) throw new Error("The agent event stream has no body.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let lastSequence = cursor;

      const consume = (block: string) => {
        const lines = block.split(/\r?\n/).flatMap((part) =>
          part.startsWith("data:") ? [part.slice(5).replace(/^ /, "")] : []);

        if (!lines.length) return;
        const event = Schema.decodeUnknownSync(Schema.fromJsonString(AgentEvent))(lines.join("\n"));

        if (event.botId !== id) throw new Error("The computer sent an update for a different bot.");

        if (event.sequence <= lastSequence) return;
        onEvent(event);
        lastSequence = event.sequence;
      };

      try {
        while (!signal.aborted) {
          const chunk = await reader.read();

          if (chunk.done) {
            pending += decoder.decode();

            if (pending.trim()) throw new Error("The agent stream ended during an update. Reconnecting…");

            return;
          }

          pending += decoder.decode(chunk.value, { stream: true });

          if (pending.length > 32_000_000) throw new Error("The agent stream update is too large.");
          const blocks = pending.split(/\r?\n\r?\n/);
          pending = blocks.pop() ?? "";

          for (const block of blocks) consume(block);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
  };
}
