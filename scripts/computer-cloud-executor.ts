import { writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { AgentEvent, AuthStatus, EventPayload, MessageSnapshot } from "../src/backend/contracts";

const connection = Schema.decodeUnknownSync(Schema.Struct({ base: Schema.String, token: Schema.String, computerId: Schema.String, desktopId: Schema.String }))(await Bun.file(".labora/cloud-verification.json").json());

if (connection.desktopId !== "verification-20261002") throw new Error("This handoff is scoped to the disposable verification computer");

const headers = { Authorization: `Bearer ${connection.token}`, "X-Computer-Id": connection.computerId, "Content-Type": "application/json" };

const base = `${connection.base}/v1/bots/cloud-verification`;

const api = (suffix: string, init?: RequestInit) => fetch(`${base}${suffix}`, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(90_000) });

const messages = await api("/messages");

if (!messages.ok) throw new Error(`Cloud Pi child startup returned ${messages.status}`);

const snapshot = Schema.decodeUnknownSync(MessageSnapshot)(await messages.json());

const auth = await api("/auth");

if (!auth.ok) throw new Error(`Cloud provider status returned ${auth.status}`);

const state = Schema.decodeUnknownSync(AuthStatus)(await auth.json());

if (state.openai !== "signed-out") throw new Error("Unexpected OpenAI credentials on the isolated verification bot");

await Bun.write("artifacts/computer-cloud-e2e/pi-runtime.json", JSON.stringify({ checkedAt: new Date().toISOString(), sdkChildResponded: true, messages: snapshot.messages.length, busy: snapshot.busy, auth: state, oauthInitiated: "executor", openaiOAuthInitiated: false }, null, 2));

const controller = new AbortController();

const events = await api(`/events?cursor=${snapshot.cursor}`, { signal: controller.signal });

if (!events.ok || !events.body) throw new Error("Cloud Pi event stream failed");

const start = await api("/auth/start", { method: "POST", body: JSON.stringify({ provider: "executor" }) });

if (!start.ok) throw new Error(`Cloud Executor OAuth start returned ${start.status}`);

const deadline = setTimeout(() => controller.abort(), 90_000);

const reader = events.body.getReader();

let buffer = "";

let found = false;

try {
  while (!found) {
    const chunk = await reader.read();

    if (chunk.done) break;
    buffer += new TextDecoder().decode(chunk.value);
    let boundary: number;

    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").find(line => line.startsWith("data: "))?.slice(6);

      if (!data) continue;
      const event = Schema.decodeUnknownSync(Schema.fromJsonString(AgentEvent))(data);

      if (EventPayload.isAnyOf(["AuthFailed"])(event.payload)) throw new Error("Cloud Executor OAuth failed before authorization; inspect the private bot event history");

      if (EventPayload.isAnyOf(["AuthLink"])(event.payload) && event.payload.provider === "executor") {
        await writeFile(".labora/cloud-executor-handoff.json", JSON.stringify({ createdAt: new Date().toISOString(), authorizationUrl: event.payload.url, message: event.payload.message, inputEndpoint: `${base}/auth/input`, statusEndpoint: `${base}/auth`, eventsEndpoint: `${base}/events`, desktopId: connection.desktopId, botId: "cloud-verification" }), { mode: 0o600 });
        found = true;
        break;
      }
    }
  }
} finally { clearTimeout(deadline); controller.abort(); reader.releaseLock(); }

if (!found) throw new Error("Executor did not provide an authorization URL within90seconds");

console.log(JSON.stringify({ piSdkChildVerified: true, openai: state.openai, handoffFile: ".labora/cloud-executor-handoff.json", oauth: "executor" }));
