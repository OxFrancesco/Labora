import { DurableObject } from "cloudflare:workers";
import { Option, Schema } from "effect";
import { readWithKitesurf } from "./browser";

interface Env {
  DESKTOPS: DurableObjectNamespace<LaboraDesktop>;
  LABORA_ADMIN_TOKEN: string;
  BROWSER: BrowserRun;
}

interface DesktopRecord { name: string; managementToken: string; createdAt: number; brokerUrl: string }

const json = (body: Schema.Schema.Type<typeof Schema.Json>, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const CreateDesktop = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
});

const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, "0")).join("");

const bearer = (request: Request) => {
  const header = request.headers.get("authorization") ?? "";

  return header.startsWith("Bearer ") ? header.slice(7) : "";
};

export class LaboraDesktop extends DurableObject<Env> {
  private starting: Promise<void> | undefined;
  private record: DesktopRecord | undefined;
  private busy = 0;
  private browserBusy = false;
  private removing = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    if (ctx.container?.running) void ctx.blockConcurrencyWhile(() => ctx.container?.setInactivityTimeout(300_000) ?? Promise.resolve());
  }

  async provision(name: string, brokerUrl: string) {
    if (this.removing) throw new Error("Desktop is being removed");
    this.record = await this.ctx.storage.get<DesktopRecord>("desktop");

    if (!this.record) {
      this.record = { name, managementToken: `${crypto.randomUUID()}${crypto.randomUUID()}`, createdAt: Date.now(), brokerUrl };
      await this.ctx.storage.put("desktop", this.record);
    }

    await this.ensureStarted();
    await this.ctx.storage.put("lastActivity", Date.now());
    const response = await this.port().fetch(new Request("http://desktop/_labora/pair", { method: "POST", headers: { "X-Labora-Management": this.record.managementToken } }));

    if (!response.ok) throw new Error("Companion pairing could not be created");
    const pairing = await response.json<{ code: string; expiresAt: number; attemptsRemaining: number }>();
    await this.ctx.storage.put("pairingExpiresAt", pairing.expiresAt);
    await this.ctx.storage.put("pairingAttempts", 5);

    return pairing;
  }

  private port() {
    if (!this.ctx.container) throw new Error("Container binding is missing");

    return this.ctx.container.getTcpPort(7778);
  }

  private async ensureStarted() {
    if (this.starting) return this.starting;
    this.starting = this.start();

    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async start() {
    const container = this.ctx.container;

    if (!container) throw new Error("Container binding is missing");
    this.record ??= await this.ctx.storage.get<DesktopRecord>("desktop");

    if (!this.record) throw new Error("Desktop has not been provisioned");

    if (!container.running) {
      const snapshot = await this.ctx.storage.get<{ id: string }>("snapshot");
      const source = snapshot ? { containerSnapshot: snapshot } : { image: container.images.desktop };
      container.start({ ...source, instance: "standard-2", enableInternet: true,
        env: { LABORA_MANAGEMENT_TOKEN: this.record.managementToken, LABORA_COMPUTER_NAME: this.record.name, LABORA_BROWSER_BROKER: this.record.brokerUrl },
      });
    }

    await container.setInactivityTimeout(300_000);
    const deadline = Date.now() + 45_000;

    while (Date.now() < deadline) {
      try { if ((await this.port().fetch("http://desktop/health")).ok) {
        if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 60_000);

        return;
      } }
      catch { /* The container API returns before its server has started. */ }

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    throw new Error("Desktop companion did not become ready");
  }

  async alarm() {
    const container = this.ctx.container;

    if (!container?.running) return;
    this.record ??= await this.ctx.storage.get<DesktopRecord>("desktop");

    if (!this.record) return;
    const activity = await this.port().fetch(new Request("http://desktop/_labora/activity", { headers: { "X-Labora-Management": this.record.managementToken } }));

    if (!activity.ok) throw new Error("Cannot check desktop activity before saving");
    const { busy: agentBusy } = await activity.json<{ busy: boolean }>();
    const lastActivity = await this.ctx.storage.get<number>("lastActivity") ?? 0;
    const savedAt = await this.ctx.storage.get<number>("savedAt") ?? 0;
    const idle = !agentBusy && this.busy === 0 && Date.now() - lastActivity > 600_000;

    if (!agentBusy && this.busy === 0 && (idle || Date.now() - savedAt > 300_000)) {
      const snapshot = await container.snapshotContainer({ name: "labora-workspace" });
      await this.ctx.storage.put({ snapshot: { id: snapshot.id }, savedAt: Date.now() });

      if (idle && this.busy === 0 && await this.ctx.storage.get<number>("lastActivity") === lastActivity) {
        await container.destroy();

        return;
      }
    }

    await container.setInactivityTimeout(300_000);
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async suspend() {
    if (!this.ctx.container?.running) return { suspended: true };
    this.record ??= await this.ctx.storage.get<DesktopRecord>("desktop");

    if (!this.record) throw new Error("Desktop has not been provisioned");
    const activity = await this.port().fetch(new Request("http://desktop/_labora/activity", { headers: { "X-Labora-Management": this.record.managementToken } }));

    if (!activity.ok || (await activity.json<{ busy: boolean }>()).busy || this.busy > 0 || this.browserBusy) return { suspended: false, reason: "Desktop has active work" };
    const lastActivity = await this.ctx.storage.get<number>("lastActivity");
    const snapshot = await this.ctx.container.snapshotContainer({ name: "labora-workspace" });
    await this.ctx.storage.put({ snapshot: { id: snapshot.id }, savedAt: Date.now() });

    if (this.busy > 0 || await this.ctx.storage.get<number>("lastActivity") !== lastActivity) return { suspended: false, reason: "Desktop became active while saving" };
    await this.ctx.container.destroy();
    await this.ctx.storage.deleteAlarm();

    return { suspended: true };
  }

  async remove() {
    if (this.starting || this.busy > 0 || this.browserBusy || this.removing) return { removed: false };
    this.removing = true;

    try {
      this.record ??= await this.ctx.storage.get<DesktopRecord>("desktop");

      if (this.ctx.container?.running && this.record) {
        const activity = await this.port().fetch(new Request("http://desktop/_labora/activity", { headers: { "X-Labora-Management": this.record.managementToken } }));

        if (!activity.ok || (await activity.json<{ busy: boolean }>()).busy) return { removed: false };
      }

      await this.ctx.container?.destroy();
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.record = undefined;

      return { removed: true };
    } finally { this.removing = false; }
  }

  private async browser(request: Request) {
    if (this.browserBusy) return json({ error: "A browser read is already running" }, 429);

    const allowed = await this.ctx.storage.transaction(async transaction => {
      const now = Date.now();
      const budget = await transaction.get<{ startedAt: number; count: number }>("browserBudget") ?? { startedAt: now, count: 0 };

      if (now - budget.startedAt > 60_000) { budget.startedAt = now; budget.count = 0; }

      if (budget.count >= 10) return false;
      budget.count += 1;
      await transaction.put("browserBudget", budget);

      return true;
    });

    if (!allowed) return json({ error: "Browser reads are limited to ten per minute per computer" }, 429);

    if (this.browserBusy) return json({ error: "A browser read is already running" }, 429);
    this.browserBusy = true;

    try { return await readWithKitesurf(request, this.env.BROWSER); }
    finally { this.browserBusy = false; }
  }

  async fetch(request: Request) {
    if (this.removing) return json({ error: "Desktop is being removed" }, 503);
    const url = new URL(request.url);

    if (url.pathname === "/_labora/browser/markdown" && request.method === "POST") {
      this.record ??= await this.ctx.storage.get<DesktopRecord>("desktop");
      const token = request.headers.get("X-Labora-Management") ?? "";

      if (!this.record || token.length < 32 || await hash(token) !== await hash(this.record.managementToken)) return json({ error: "unauthorized" }, 401);

      return this.browser(request);
    }

    if (url.pathname.startsWith("/_labora/")) return json({ error: "not_found" }, 404);

    if (url.pathname === "/health") return json({ ok: true });
    const isPair = url.pathname === "/v1/pair" && request.method === "POST";

    if (isPair) {
      const allowed = await this.ctx.storage.transaction(async transaction => {
        const expiry = await transaction.get<number>("pairingExpiresAt") ?? 0;
        const attempts = await transaction.get<number>("pairingAttempts") ?? 0;

        if (expiry < Date.now() || attempts <= 0) return false;
        await transaction.put("pairingAttempts", attempts - 1);

        return true;
      });

      if (!allowed) return json({ error: "Create a new pairing code through the owner API" }, 403);
    } else {
      const token = bearer(request);

      if (token.length < 40 || token.length > 256 || !(await this.ctx.storage.get<boolean>(`client:${await hash(token)}`))) return json({ error: "unauthorized" }, 401);
    }

    await this.ensureStarted();
    await this.ctx.storage.put("lastActivity", Date.now());

    if (url.pathname === "/v1/browser/markdown" && request.method === "POST") {
      const authenticated = await this.port().fetch(new Request("http://desktop/v1/computer", { headers: request.headers }));

      if (!authenticated.ok) return authenticated;

      return this.browser(request);
    }

    this.busy += 1;
    let response: Response;
    const internalUrl = new URL(request.url);
    internalUrl.protocol = "http:";
    internalUrl.hostname = "desktop";
    internalUrl.port = "";
    const internalHeaders = new Headers(request.headers);
    internalHeaders.delete("Origin");

    try { response = await this.port().fetch(new Request(internalUrl, new Request(request, { headers: internalHeaders }))); }
    finally { this.busy -= 1; await this.ctx.storage.put("lastActivity", Date.now()); }

    if (isPair && response.ok) {
      const paired = await response.clone().json<{ token: string }>();
      await this.ctx.storage.put(`client:${await hash(paired.token)}`, true);
      await this.ctx.storage.delete("pairingExpiresAt");
    }

    if (url.pathname === "/v1/clients/self" && request.method === "DELETE" && response.ok) await this.ctx.storage.delete(`client:${await hash(bearer(request))}`);

    return response;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (origin && origin !== url.origin) return json({ error: "origin_rejected" }, 403);

    if (url.pathname === "/v1/desktops" && request.method === "POST") {
      const token = bearer(request);

      if (!env.LABORA_ADMIN_TOKEN || token.length < 32 || await hash(token) !== await hash(env.LABORA_ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);

      if (Number(request.headers.get("content-length") ?? 0) > 4096) return json({ error: "body_too_large" }, 413);
      const text = await request.text();

      if (text.length > 4096) return json({ error: "body_too_large" }, 413);
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(CreateDesktop))(text);

      if (Option.isNone(decoded)) return json({ error: "invalid_desktop" }, 400);
      const input = decoded.value;
      const object = env.DESKTOPS.get(env.DESKTOPS.idFromName(input.id));
      const pairing = await object.provision(input.name, `${url.origin}/computers/${input.id}/_labora/browser/markdown`);

      return json({ url: `${url.origin}/computers/${input.id}`, ...pairing });
    }

    const suspendMatch = /^\/v1\/desktops\/([a-z0-9][a-z0-9_-]{0,63})\/suspend$/.exec(url.pathname);

    if (suspendMatch?.[1] && request.method === "POST") {
      const token = bearer(request);

      if (!env.LABORA_ADMIN_TOKEN || token.length < 32 || await hash(token) !== await hash(env.LABORA_ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);
      const result = await env.DESKTOPS.get(env.DESKTOPS.idFromName(suspendMatch[1])).suspend();

      return json({ suspended: result.suspended, reason: result.reason ?? null }, result.suspended ? 200 : 409);
    }

    const removeMatch = /^\/v1\/desktops\/([a-z0-9][a-z0-9_-]{0,63})$/.exec(url.pathname);

    if (removeMatch?.[1] && request.method === "DELETE") {
      const token = bearer(request);

      if (!env.LABORA_ADMIN_TOKEN || token.length < 32 || await hash(token) !== await hash(env.LABORA_ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);

      if (request.headers.get("X-Confirm-Desktop-Id") !== removeMatch[1]) return json({ error: "Explicit desktop ID confirmation is required" }, 400);
      const result = await env.DESKTOPS.get(env.DESKTOPS.idFromName(removeMatch[1])).remove();

      return json({ removed: result.removed }, result.removed ? 200 : 409);
    }

    const match = /^\/computers\/([a-z0-9][a-z0-9_-]{0,63})(\/.*)$/.exec(url.pathname);

    if (!match?.[1] || !match[2]) return json({ error: "not_found" }, 404);
    url.pathname = match[2];

    return env.DESKTOPS.get(env.DESKTOPS.idFromName(match[1])).fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
