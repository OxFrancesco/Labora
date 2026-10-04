import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Result, Schema } from "effect";
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthProvider,
  OAuthCallbackServer,
  type McpOAuthState,
} from "@earendil-works/pi-mcp/oauth";
import { StreamableHttpTransport, type AuthProvider } from "@earendil-works/pi-mcp";
import lockfile from "proper-lockfile";

const Strings = Schema.mutable(Schema.Array(Schema.String));

const Tokens = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.String),
  id_token: Schema.optionalKey(Schema.String),
});

const Client = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optionalKey(Schema.String),
  client_id_issued_at: Schema.optionalKey(Schema.Number),
  client_secret_expires_at: Schema.optionalKey(Schema.Number),
  redirect_uris: Schema.optionalKey(Strings),
  client_name: Schema.optionalKey(Schema.String),
  grant_types: Schema.optionalKey(Strings),
  response_types: Schema.optionalKey(Strings),
  token_endpoint_auth_method: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
});

const Metadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optionalKey(Schema.String),
  scopes_supported: Schema.optionalKey(Strings),
  response_types_supported: Strings,
  grant_types_supported: Schema.optionalKey(Strings),
  token_endpoint_auth_methods_supported: Schema.optionalKey(Strings),
  code_challenge_methods_supported: Schema.optionalKey(Strings),
  client_id_metadata_document_supported: Schema.optionalKey(Schema.Boolean),
  authorization_response_iss_parameter_supported: Schema.optionalKey(Schema.Boolean),
});

const State = Schema.Struct({
  serverUrl: Schema.String,
  clientInformation: Schema.optionalKey(Client),
  tokens: Schema.optionalKey(Tokens),
  tokensExpireAt: Schema.optionalKey(Schema.Number),
  codeVerifier: Schema.optionalKey(Schema.String),
  oauthState: Schema.optionalKey(Schema.String),
  discovery: Schema.optionalKey(
    Schema.Struct({
      authorizationServerUrl: Schema.String,
      authorizationServerMetadata: Schema.optionalKey(Metadata),
      resourceMetadataUrl: Schema.optionalKey(Schema.String),
      resourceMetadata: Schema.optionalKey(
        Schema.Struct({
          resource: Schema.String,
          authorization_servers: Schema.optionalKey(Strings),
          scopes_supported: Schema.optionalKey(Strings),
        }),
      ),
    }),
  ),
});

export interface ExecutorOptions {
  readonly name?: string;
  readonly label?: string;
  readonly path: string;
  readonly url: string;
  readonly showLink: (url: string) => void;
  readonly manualInput: (signal: AbortSignal) => Promise<string>;
}

interface CallbackWait {
  state?: string;
  received?: ReturnType<OAuthCallbackServer["waitForCallback"]>;
}

export async function createExecutor(options: ExecutorOptions) {
  const serverUrl = new URL(options.url).href;
  const label = options.label ?? "Executor";
  const key = `mcp__${options.name ?? "executor"}|${serverUrl}`;
  const States = Schema.Record(Schema.String, Schema.Json);

  const readStates = async () => {
    if (!(await Bun.file(options.path).exists())) return Schema.decodeUnknownSync(States)({});

    const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(States))(
      await readFile(options.path, "utf8"),
    );

    if (Result.isFailure(decoded)) throw new Error("The Executor credential file is invalid.");

    return decoded.success;
  };

  const store = {
    async load(): Promise<McpOAuthState | undefined> {
      const states = await readStates();
      const value = states[key] ?? states[serverUrl];

      if (value === undefined) return undefined;

      const decoded = Schema.decodeUnknownResult(State)(value);

      if (Result.isFailure(decoded)) throw new Error("The stored Executor connection is invalid.");

      return decoded.success;
    },
    async save(state: McpOAuthState): Promise<void> {
      const release = await lockfile.lock(options.path, {
        realpath: false,
        stale: 20_000,
        retries: { retries: 30, minTimeout: 100, maxTimeout: 100 },
      });

      try {
        const states = await readStates();
        const next = { ...states, [key]: state };
        delete next[serverUrl];
        const temporary = `${options.path}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, options.path);
      } finally {
        await release();
      }
    },
  };

  const makeProvider = (
    redirectUrl: string,
    interactive: boolean,
    authorization?: (url: URL) => void,
  ) =>
    new McpOAuthProvider({
      serverUrl: options.url,
      redirectUrl,
      store,
      clientMetadata: {
        client_name: "Labora",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      onRedirect: (url) => {
        if (!interactive) throw new Error(`Sign in to ${label} from this bot's connections.`);
        authorization?.(url);
        options.showLink(url.href);
      },
    });

  const transportProvider = makeProvider("http://127.0.0.1/callback", false);
  const adapted = adaptOAuthProvider(transportProvider);
  const refreshKey = createHash("sha256").update(key).digest("hex").slice(0, 16);

  const authProvider: AuthProvider = {
    token: () => adapted.token(),
    async onUnauthorized(context) {
      const release = await lockfile.lock(
        join(dirname(options.path), `mcp-auth-refresh-${refreshKey}`),
        {
          realpath: false,
          stale: 20_000,
          retries: { retries: 250, minTimeout: 100, maxTimeout: 100 },
        },
      );

      try {
        const tokens = await transportProvider.tokens();

        if (tokens?.access_token && tokens.access_token !== context.token) return;

        if (!tokens?.refresh_token)
          throw new Error(`Sign in to ${label} from this bot's connections.`);
        await adapted.onUnauthorized?.(context);
      } finally {
        await release();
      }
    },
  };

  return {
    async clear() {
      await store.save({ serverUrl });
    },
    async status() {
      const state = await store.load();

      return state?.serverUrl === serverUrl && Boolean(state.tokens);
    },
    transport() {
      return new StreamableHttpTransport({ url: options.url, authProvider });
    },
    async login(signal: AbortSignal) {
      signal.throwIfAborted();
      const callback = await OAuthCallbackServer.listen({ host: "127.0.0.1", timeoutMs: 300_000 });
      const controller = new AbortController();
      const aborted = () => controller.abort();
      signal.addEventListener("abort", aborted, { once: true });
      const pending: CallbackWait = {};

      const provider = makeProvider(callback.redirectUrl, true, (url) => {
        const state = url.searchParams.get("state");

        if (!state) throw new Error("Executor did not provide an OAuth state.");
        pending.state = state;
        pending.received = callback.waitForCallback(state);
        void pending.received.catch(() => undefined);
      });

      try {
        const previous = await store.load();
        await store.save({
          ...(previous?.serverUrl === options.url ? previous : { serverUrl: options.url }),
          oauthState: crypto.randomUUID(),
        });
        signal.throwIfAborted();

        const result = await authorizeMcp(provider, {
          serverUrl: options.url,
          fetch: (url, init) => fetch(url, { ...init, signal }),
        });

        signal.throwIfAborted();

        if (result === "AUTHORIZED") return;
        const state = pending.state;
        const received = pending.received;

        if (!state || !received)
          throw new Error("Executor did not start an OAuth authorization attempt.");

        const manual = options.manualInput(controller.signal).then((value) => {
          const url = new URL(value);
          const expected = new URL(callback.redirectUrl);

          if (
            url.origin !== expected.origin ||
            url.pathname !== expected.pathname ||
            url.searchParams.get("state") !== state
          ) {
            throw new Error("OAuth callback URL or state did not match this login attempt.");
          }

          const code = url.searchParams.get("code");

          if (!code) throw new Error("The callback URL contains no authorization code.");

          return { code, state, iss: url.searchParams.get("iss") ?? undefined };
        });

        const authorization = await Promise.race([received, manual]);
        await authorizeMcp(provider, {
          serverUrl: options.url,
          authorizationCode: authorization.code,
          iss: authorization.iss,
          fetch: (url, init) => fetch(url, { ...init, signal }),
        });
      } finally {
        controller.abort();
        signal.removeEventListener("abort", aborted);
        await callback.close();
      }
    },
  };
}
