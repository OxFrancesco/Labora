import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { AgentHost } from "./host";
import { Routines } from "./routines";
import { CreateRoutine, SetRoutineEnabled, UpdateRoutine } from "./routine-contracts";
import {
  AgentRequestContext,
  ApprovalResponse,
  AuthInput,
  AuthStart,
  AuthStatus,
  BackendError,
  ChildCommand,
  ConversationId,
  CreateBot,
  SendMessage,
  UpdateBot,
  QuestionResponse,
  QueueInput,
} from "./contracts";

export type AgentHttpOptions = AgentHost.HostOptions;

export interface AgentHttpHandler {
  readonly isBusy: () => Promise<boolean>;
  readonly fetch: (request: Request, context: AgentRequestContext) => Promise<Response | undefined>;
  readonly close: () => Promise<void>;
}

const response = (value: Schema.Schema.Type<typeof Schema.Json>, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });

const invalid = () =>
  new BackendError({
    code: "invalid_request",
    message: "The request does not match the expected JSON schema.",
    status: 400,
  });

const readBody = Effect.fn("AgentHttp.readBody")((request: Request) =>
  Effect.tryPromise({
    try: async () => {
      if (!(request.headers.get("content-type") ?? "").startsWith("application/json"))
        throw new Error("JSON body required");
      const reader = request.body?.getReader();

      if (!reader) throw new Error("Request body required");
      const chunks: Uint8Array[] = [];
      let length = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;
          length += value.byteLength;

          if (length > 25_000_000) {
            await reader.cancel();
            throw new Error("Request body exceeds 25 MB");
          }

          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      return Buffer.concat(chunks).toString("utf8");
    },
    catch: invalid,
  }),
);

export async function createAgentHttpHandler(options: AgentHttpOptions): Promise<AgentHttpHandler> {
  const runtime = ManagedRuntime.make(
    Routines.layer(options).pipe(Layer.provideMerge(AgentHost.layer(options))),
  );

  await runtime.context();

  const handle = Effect.fn("AgentHttp.handle")(function* (
    request: Request,
    context: AgentRequestContext,
  ) {
    yield* Schema.decodeUnknownEffect(AgentRequestContext)(context).pipe(Effect.mapError(invalid));
    const url = new URL(request.url);

    const routineRoute = url.pathname === "/v1/routines" || url.pathname.startsWith("/v1/routines/");

    if (!routineRoute && url.pathname !== "/v1/bots" && !url.pathname.startsWith("/v1/bots/")) return undefined;

    if (routineRoute) {
      const routines = yield* Routines.Service;

      if (url.pathname === "/v1/routines") {
        if (request.method === "GET") return response({ routines: [...(yield* routines.list())] });

        if (request.method === "POST") {
          const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CreateRoutine))(
            yield* readBody(request),
          ).pipe(Effect.mapError(invalid));

          return response({ routine: yield* routines.create(input) }, 201);
        }
      }

      const segments = url.pathname.split("/");
      const id = segments[3];
      const action = segments[4];

      if (!id || segments.length > 5)
        return response({ error: { code: "not_found", message: "Unknown routine route" } }, 404);

      if (action === undefined && request.method === "PATCH") {
        const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(UpdateRoutine))(
          yield* readBody(request),
        ).pipe(Effect.mapError(invalid));

        return response({ routine: yield* routines.update(id, input) });
      }

      if (action === undefined && request.method === "DELETE") {
        yield* routines.remove(id);

        return response({ deleted: true });
      }

      if (action === "enabled" && request.method === "POST") {
        const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SetRoutineEnabled))(
          yield* readBody(request),
        ).pipe(Effect.mapError(invalid));

        return response({ routine: yield* routines.enabled(id, input.enabled) });
      }

      if (action === "runs" && request.method === "GET")
        return response({ runs: [...(yield* routines.runs(id))] });

      if (action === "run" && request.method === "POST")
        return response({ run: yield* routines.run(id) }, 202);

      return response({ error: { code: "not_found", message: "Unknown routine route" } }, 404);
    }

    const host = yield* AgentHost.Service;

    const conversationId = yield* Schema.decodeUnknownEffect(ConversationId)(
      url.searchParams.get("conversationId") ?? "direct",
    ).pipe(Effect.mapError(invalid));

    if (url.pathname === "/v1/bots") {
      if (request.method === "GET") return response({ bots: [...(yield* host.list())] });

      if (request.method === "POST") {
        const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CreateBot))(
          yield* readBody(request),
        ).pipe(Effect.mapError(invalid));

        return response({ bot: yield* host.create(input) }, 201);
      }
    }

    const segments = url.pathname.split("/");
    const id = segments[3];
    const route = segments[4];

    if (!id) return response({ error: { code: "not_found", message: "Unknown agent route" } }, 404);

    if (route === "activity" && request.method === "GET") return response(yield* host.activity(id));

    if (route === "messages" || route === "events" || route === "cancel" || route === "questions" || route === "inputs") {
      const routines = yield* Routines.Service;
      yield* routines.conversation(id, conversationId);
    }

    if (route === undefined && request.method === "PATCH") {
      const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(UpdateBot))(
        yield* readBody(request),
      ).pipe(Effect.mapError(invalid));

      return response({ bot: yield* host.update(id, input) });
    }

    if (route === "messages" && request.method === "GET") return response(yield* host.snapshot(id, conversationId));

    if (route === "messages" && request.method === "POST") {
      const message = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SendMessage))(
        yield* readBody(request),
      ).pipe(Effect.mapError(invalid));

      if (!message.text.trim() && !message.attachments?.length)
        return yield* Effect.fail(invalid());

      return response(
        yield* host.request(
          id,
          ChildCommand.cases.Prompt.make({ runId: crypto.randomUUID(), message, conversationId }),
        ),
        202,
      );
    }

    if (route === "cancel" && request.method === "POST") {
      const runId = url.searchParams.get("runId");

      if (runId !== null && (!runId || runId.length > 128)) return yield* Effect.fail(invalid());
      let command = ChildCommand.cases.Cancel.make({ conversationId });

      if (runId) command = ChildCommand.cases.Cancel.make({ conversationId, runId });

      return response(yield* host.request(id, command));
    }

    if (route === "questions" && segments[5] && request.method === "POST") {
      const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(QuestionResponse))(yield* readBody(request)).pipe(Effect.mapError(invalid));

      return response(yield* host.request(id, ChildCommand.cases.QuestionResponse.make({ ...input, requestId: segments[5], conversationId })));
    }

    if (route === "inputs" && request.method === "POST") {
      const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(QueueInput))(yield* readBody(request)).pipe(Effect.mapError(invalid));

      return response(yield* host.request(id, ChildCommand.cases.QueueInput.make({ ...input, conversationId })), 202);
    }

    if (route === "auth" && request.method === "GET") {
      const status = yield* host.request(id, ChildCommand.cases.AuthStatus.make({}));

      return response(
        yield* Schema.decodeUnknownEffect(AuthStatus)(status).pipe(Effect.mapError(invalid)),
      );
    }

    if (route === "auth" && segments[5] === "start" && request.method === "POST") {
      const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AuthStart))(
        yield* readBody(request),
      ).pipe(Effect.mapError(invalid));

      return response(yield* host.request(id, ChildCommand.cases.AuthStart.make(input)), 202);
    }

    if (route === "auth" && segments[5] === "cancel" && request.method === "POST")
      return response(yield* host.request(id, ChildCommand.cases.AuthCancel.make({})));

    if (route === "auth" && segments[5] === "input" && request.method === "POST") {
      const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AuthInput))(
        yield* readBody(request),
      ).pipe(Effect.mapError(invalid));

      return response(yield* host.request(id, ChildCommand.cases.AuthInput.make(input)));
    }

    if (route === "approvals" && segments[5] && request.method === "POST") {
      const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ApprovalResponse))(
        yield* readBody(request),
      ).pipe(Effect.mapError(invalid));

      return response(
        yield* host.request(
          id,
          ChildCommand.cases.Approval.make({ requestId: segments[5], decision: input.decision }),
        ),
      );
    }

    if (route === "events" && request.method === "GET") {
      const cursor = Number(
        request.headers.get("last-event-id") ?? url.searchParams.get("cursor") ?? "0",
      );

      if (!Number.isSafeInteger(cursor) || cursor < 0) return yield* Effect.fail(invalid());
      const events = yield* host.events(id, cursor, url.searchParams.get("scope") === "bot" ? null : conversationId);

      const heartbeat = Stream.tick("15 seconds").pipe(
        Stream.map(() => new TextEncoder().encode(": keep-alive\n\n")),
      );

      const bytes = events.pipe(
        Stream.map((event) =>
          new TextEncoder().encode(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`),
        ),
        Stream.merge(heartbeat, { haltStrategy: "left" }),
      );

      return new Response(Stream.toReadableStream(bytes), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
      });
    }

    if (route === "files" && request.method === "GET") {
      if (segments[5] === "content") {
        const path = url.searchParams.get("path");

        if (!path) return yield* Effect.fail(invalid());
        const bytes = yield* host.file(id, path);

        return new Response(new Uint8Array(bytes).buffer, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.split("/").at(-1) ?? "file")}`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      return response({ files: [...(yield* host.files(id))] });
    }

    return response({ error: { code: "not_found", message: "Unknown agent route" } }, 404);
  });

  return {
    isBusy: () => runtime.runPromise(Effect.flatMap(AgentHost.Service, (host) => host.isBusy())),
    fetch: (request, context) =>
      runtime.runPromise(
        handle(request, context).pipe(
          Effect.catch((error) =>
            Effect.succeed(
              response({ error: { code: error.code, message: error.message } }, error.status),
            ),
          ),
        ),
      ),
    close: () => runtime.dispose(),
  };
}
