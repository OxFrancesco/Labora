import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { Schema, Result } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";

const issuer = "https://auth.openai.com";

const resource = "https://api.openai.com/v1";

const directScope = "chatgpt.tokens.use.direct";

const scopes = `openid profile email offline_access resource.invoke ${directScope}`;

const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

const Registration = Schema.Struct({
  clientId: Schema.String.check(Schema.isMinLength(1)),
  subject: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  idToken: Schema.optionalKey(Schema.String),
});

interface Registration extends Schema.Schema.Type<typeof Registration> {}

const TokenResponse = Schema.Struct({
  access_token: Schema.String.check(Schema.isMinLength(1)),
  refresh_token: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  id_token: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  token_type: Schema.String,
  scope: Schema.String,
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
});

interface TokenResponse extends Schema.Schema.Type<typeof TokenResponse> {}

const SavedCredential = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
  clientId: Schema.String,
  subject: Schema.String,
  email: Schema.optionalKey(Schema.String),
  idToken: Schema.String,
  scopes: Schema.Array(Schema.String),
});

const Failure = Schema.Struct({ error: Schema.String.check(Schema.isPattern(/^[a-z_]+$/)) });

const Identity = Schema.Struct({
  sub: Schema.String,
  nonce: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
});

const random = () => randomBytes(32).toString("base64url");

export interface OpenAiAuthOptions {
  readonly registrationPath: string;
  readonly deviceId: string;
}

export function createOpenAiSubscriptionAuth(options: OpenAiAuthOptions): OAuthAuth {
  const load = async () => {
    if (!(await Bun.file(options.registrationPath).exists())) return undefined;

    const result = Schema.decodeUnknownResult(Schema.fromJsonString(Registration))(
      await readFile(options.registrationPath, "utf8"),
    );

    if (Result.isFailure(result)) throw new Error("The saved ChatGPT registration is invalid.");

    return result.success;
  };

  const save = async (registration: Registration) => {
    const temporary = `${options.registrationPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(registration), { mode: 0o600 });
    await rename(temporary, options.registrationPath);
  };

  const token = async (body: URLSearchParams, signal: AbortSignal): Promise<TokenResponse> => {
    const response = await fetch(`${issuer}/api/accounts/oauth/token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal,
    });

    const content = await response.text();

    if (!response.ok) {
      const failure = Schema.decodeUnknownResult(Schema.fromJsonString(Failure))(content);
      throw new Error(
        `ChatGPT token exchange failed (${response.status}): ${Result.isSuccess(failure) ? failure.success.error : "provider_error"}. Try signing in again; your registered client is retained.`,
      );
    }

    const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(TokenResponse))(content);

    if (Result.isFailure(decoded)) throw new Error("OpenAI returned an invalid token response.");

    if (!decoded.success.scope.split(/\s+/).includes(directScope))
      throw new Error("ChatGPT plan usage was not authorized for this connection.");

    return decoded.success;
  };

  const identity = async (
    idToken: string,
    clientId: string,
    expectedNonce?: string,
    expectedSubject?: string,
  ) => {
    const verified = await jwtVerify(idToken, jwks, {
      issuer,
      audience: clientId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat"],
    });

    const parsed = Schema.decodeUnknownResult(Identity)(verified.payload);

    if (Result.isFailure(parsed)) throw new Error("The ChatGPT ID token has no valid identity.");

    if (expectedNonce !== undefined && parsed.success.nonce !== expectedNonce)
      throw new Error("ChatGPT ID-token nonce mismatch.");

    if (expectedSubject !== undefined && parsed.success.sub !== expectedSubject)
      throw new Error("The sign-in returned a different ChatGPT account.");

    return parsed.success;
  };

  const login = async (interaction: ProviderAuthInteraction): Promise<OAuthCredential> => {
    const registration = await load();
    const state = random();
    const nonce = random();
    const verifier = random();
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const controller = new AbortController();
    const signal = AbortSignal.any([interaction.signal, controller.signal]);
    let redirectUri = "http://127.0.0.1:1455/auth/callback";
    let received: ((value: URL) => void) | undefined;

    const callback = new Promise<URL>((resolve) => {
      received = resolve;
    });

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);

      if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state) {
        response.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        response.end("Invalid or expired sign-in callback.");

        return;
      }

      received?.(url);
      response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end("Callback received. Check Labora for the sign-in result.");
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      const parsed = Schema.decodeUnknownResult(Schema.Struct({ port: Schema.Number }))(address);

      if (Result.isFailure(parsed))
        throw new Error("The ChatGPT callback did not bind to a TCP port.");
      redirectUri = `http://127.0.0.1:${parsed.success.port}/auth/callback`;
      const url = new URL(`${issuer}/api/accounts/authorize`);
      url.search = new URLSearchParams({
        client_id: registration?.clientId ?? "dynamic_agent_client",
        ext_agent_host_id: `urn:uuid:${options.deviceId}`,
        response_type: "code",
        redirect_uri: redirectUri,
        resource,
        scope: scopes,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();

      if (!registration) url.searchParams.set("agent_name_hint", "Labora");

      if (registration?.email) url.searchParams.set("login_hint", registration.email);
      interaction.notify({
        type: "auth_url",
        url: url.href,
        instructions: "Complete sign-in in the browser, then return to Labora.",
      });

      const manual = interaction
        .prompt({
          type: "manual_code",
          message:
            "If this computer cannot receive the callback, paste the full redirect URL here.",
          placeholder: redirectUri,
          signal,
        })
        .then((value) => new URL(value.trim()));

      const result = await Promise.race([callback, manual]);
      const expected = new URL(redirectUri);

      if (
        result.origin !== expected.origin ||
        result.pathname !== expected.pathname ||
        result.searchParams.get("state") !== state
      )
        throw new Error("The callback did not match this ChatGPT sign-in attempt.");

      if (result.searchParams.has("error"))
        throw new Error("ChatGPT sign-in was declined or could not complete.");
      const clientId = result.searchParams.get("client_id") ?? registration?.clientId;
      const code = result.searchParams.get("code");

      if (!clientId || clientId === "dynamic_agent_client" || !code)
        throw new Error("The callback did not contain a complete ChatGPT registration.");

      if (registration && clientId !== registration.clientId)
        throw new Error("The callback changed this connection's registered client.");
      const retained = Registration.make({ ...registration, clientId });
      await save(retained);

      const tokens = await token(
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource,
        }),
        signal,
      );

      if (!tokens.id_token || !tokens.refresh_token)
        throw new Error(
          "OpenAI did not return the identity and refresh credentials required for this connection.",
        );
      const account = await identity(tokens.id_token, clientId, nonce, registration?.subject);

      const complete = Registration.make({
        clientId,
        subject: account.sub,
        email: account.email,
        idToken: tokens.id_token,
      });

      await save(complete);

      return {
        type: "oauth",
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: Date.now() + tokens.expires_in * 1000 - 180_000,
        clientId,
        subject: account.sub,
        email: account.email,
        idToken: tokens.id_token,
        scopes: tokens.scope.split(/\s+/),
      };
    } finally {
      controller.abort();
      server.close();
      server.closeAllConnections();
    }
  };

  return {
    name: "OpenAI (ChatGPT subscription)",
    isSubscription: true,
    loginLabel: "Continue with ChatGPT",
    login,
    async refresh(credential, signal) {
      const parsed = Schema.decodeUnknownResult(SavedCredential)(credential);

      if (Result.isFailure(parsed))
        throw new Error("Reconnect ChatGPT to validate this connection's identity.");
      const previous = parsed.success;

      const tokens = await token(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: previous.clientId,
          refresh_token: previous.refresh,
          resource,
        }),
        signal,
      );

      if (tokens.id_token)
        await identity(tokens.id_token, previous.clientId, undefined, previous.subject);

      const next = {
        ...previous,
        access: tokens.access_token,
        refresh: tokens.refresh_token ?? previous.refresh,
        expires: Date.now() + tokens.expires_in * 1000 - 180_000,
        idToken: tokens.id_token ?? previous.idToken,
        scopes: tokens.scope.split(/\s+/),
      };

      await save(
        Registration.make({
          clientId: next.clientId,
          subject: next.subject,
          email: next.email,
          idToken: next.idToken,
        }),
      );

      return next;
    },
    async toAuth(credential) {
      const parsed = Schema.decodeUnknownResult(SavedCredential)(credential);

      if (Result.isFailure(parsed) || !parsed.success.scopes.includes(directScope))
        throw new Error(
          "Reconnect ChatGPT to validate this connection's identity and plan permission.",
        );

      return { apiKey: parsed.success.access };
    },
  };
}
