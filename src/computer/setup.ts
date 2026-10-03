import { webIcon } from "../web-icon";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result, Schema } from "effect";
import { createTailscaleAdapter, TailscaleError, type TailscaleStatus } from "../tailscale";
import type { createComputerHost } from "./host";

const SetupInstance = Schema.Struct({ pid: Schema.Number, instanceId: Schema.String, url: Schema.String });

const Enrollment = Schema.Struct({ publicUrl: Schema.String, ownerLogin: Schema.optionalKey(Schema.String), pairingOnly: Schema.optionalKey(Schema.Boolean), nodeId: Schema.optionalKey(Schema.String) });

interface SetupInstance extends Schema.Schema.Type<typeof SetupInstance> {}

interface SetupSnapshot {
  tailscale: Pick<TailscaleStatus, "installed" | "running" | "self">;
  loggingIn: boolean;
  enabled: boolean;
  authUrl?: string;
  error?: string;
  pairingCode?: { code: string; expiresAt: number };
}

interface ActiveEnrollment extends Schema.Schema.Type<typeof Enrollment> { nodeId: string }

interface SetupFailure { error: string }

interface SetupOptions {
  host: Pick<Awaited<ReturnType<typeof createComputerHost>>, "enableEnrollment" | "disableEnrollment" | "issuePairingCode">;
  dataDir: string;
  localOrigin: string;
  port: number;
  adapter?: ReturnType<typeof createTailscaleAdapter>;
}

const instancePath = (directory: string) => join(directory, "setup-instance.json");

async function privateWrite(path: string, value: Schema.Schema.Type<typeof Schema.Json>) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });

  try { await rename(temporary, path); } finally { await unlink(temporary).catch(() => undefined); }
}

async function privateRead(path: string) {
  const info = await lstat(path);

  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
    throw new Error("Computer setup state must be a private file owned by your account.");

  return readFile(path, "utf8");
}

function localSetupUrl(value: string) {
  const url = new URL(value);

  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || !/^\/__labora\/setup\/[a-f0-9]{48}$/.test(url.pathname))
    throw new Error("The computer setup address is invalid.");

  return url;
}

export async function readComputerSetup(dataDir: string): Promise<SetupInstance | undefined> {
  try {
    const state = Schema.decodeUnknownSync(Schema.fromJsonString(SetupInstance))(await privateRead(instancePath(dataDir)));
    const url = localSetupUrl(state.url);

    if (!Number.isSafeInteger(state.pid) || state.pid < 1) return undefined;

    const response = await fetch(`${url.href}/ready`, { redirect: "error", signal: AbortSignal.timeout(1_000) });

    if (!response.ok) return undefined;

    const live = Schema.decodeUnknownSync(SetupInstance)(await response.json());

    return live.instanceId === state.instanceId && live.pid === state.pid && live.url === state.url ? state : undefined;
  } catch { return undefined; }
}

const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function setupPage() {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up this computer · Labora</title>${webIcon}<style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#eee;background:#0a0a0a}*{box-sizing:border-box}body{margin:0;padding:28px}main{max-width:440px;margin:15vh auto}h1{font-size:28px;line-height:1.2;letter-spacing:-.7px;margin:0 0 18px;font-weight:600}p{font-size:15px;line-height:1.6;color:#aaa;margin:0 0 24px}#actions{display:flex;gap:10px;flex-wrap:wrap}button,a{font:inherit;font-size:15px;text-decoration:none;border:1px solid #444;border-radius:8px;background:#1a1a1a;color:#eee;padding:12px 18px;cursor:pointer}button.primary{background:#eee;color:#111;border-color:#eee}button:disabled{opacity:.45;cursor:default}button:focus-visible,a:focus-visible{outline:3px solid #888;outline-offset:3px}#error{color:#ffb0a9;margin-top:20px}#account{overflow-wrap:anywhere}#pairing-code{margin-top:24px;color:#eee;font-variant-numeric:tabular-nums;white-space:pre-line;overflow-wrap:anywhere}#refresh{margin-top:24px;background:transparent;padding:8px 0;border:0;color:#aaa}a[hidden],button[hidden],p[hidden]{display:none}@media(max-width:480px){main{margin-top:10vh}}
</style><main><h1>Set up this computer</h1><p id="description">Checking Tailscale…</p><p id="account" hidden></p><div id="actions"><a id="install" href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer" hidden>Install Tailscale</a><button id="login" class="primary" hidden>Sign in to Tailscale</button><a id="consent" target="_blank" rel="noopener noreferrer" hidden>Continue in Tailscale</a><button id="enable" class="primary" hidden>Enable access</button><button id="pair-code" hidden>Create pairing code</button><button id="cancel" hidden>Cancel sign-in</button></div><p id="pairing-code" hidden></p><p id="error" role="alert" hidden></p><button id="refresh">Check again</button></main><script>
const base=location.pathname.endsWith('/')?location.pathname.slice(0,-1):location.pathname;
const element=id=>document.getElementById(id);
let busy=false;
let polling=false;
function show(id,visible){element(id).hidden=!visible;}
function error(message){element('error').textContent=message;show('error',!!message);}
function render(state){
 const ts=state.tailscale;
 const usable=ts.running&&ts.self&&(ts.self.tagged||ts.self.ownerLogin);
 element('description').textContent=state.enabled?'This computer is ready. Choose it in Labora. If asked for a pairing code, create one here and enter it in Labora. Only share a code with a client you want to give computer access.':!ts.installed?'Install Tailscale, sign in with the same account you use on your other computer, then check again.':!ts.running?'Sign in to Tailscale to connect your computers.':!usable?'Tailscale has not reported a usable device identity. Open Tailscale and check this device.':ts.self?.tagged?'Allow Labora to connect through Tailscale. Each new client needs a pairing code from this page.':'Allow your Labora clients to request access through Tailscale. Approve each client in your browser or with a pairing code.';
 element('account').textContent=ts.self?ts.self.name+(ts.self.ownerLogin?' · '+ts.self.ownerLogin:''):'';
 show('pair-code',state.enabled);show('pairing-code',!!state.pairingCode&&state.enabled);element('pairing-code').textContent=state.pairingCode?'Pairing code: '+state.pairingCode.code+'\\nExpires at '+new Date(state.pairingCode.expiresAt).toLocaleTimeString()+'. One use, five attempts.':'';
 show('account',!!ts.self);show('install',!ts.installed);show('login',ts.installed&&!ts.running&&!state.loggingIn);show('cancel',state.loggingIn);show('enable',!!usable&&!state.enabled);show('consent',!!state.authUrl&&!state.enabled);
 if(state.authUrl)element('consent').href=state.authUrl;
 for(const id of ['enable','login','refresh','pair-code'])element(id).disabled=busy;
 error(state.error||'');
}
async function refresh(){if(polling)return;polling=true;try{const response=await fetch(base+'/status',{cache:'no-store'});const state=await response.json();if(!response.ok)throw new Error(state.error||'Could not check this computer.');render(state);}catch(cause){error(cause.message||'Could not check this computer.');}finally{polling=false;}}
async function action(name){if(busy)return;busy=true;for(const id of ['enable','login','refresh','pair-code'])element(id).disabled=true;try{const response=await fetch(base+'/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const state=await response.json();if(!response.ok)throw new Error(state.error||'Setup did not finish.');render(state);}catch(cause){error(cause.message||'Setup did not finish.');}finally{busy=false;await refresh();}}
element('pair-code').onclick=()=>action('pair-code');element('login').onclick=()=>action('login');element('enable').onclick=()=>action('enable');element('cancel').onclick=()=>action('cancel');element('refresh').onclick=refresh;
refresh();const timer=setInterval(()=>{if(!busy)refresh();},3000);addEventListener('pagehide',()=>clearInterval(timer));
</script></html>`;
}

export async function startComputerSetup(options: SetupOptions) {
  const origin = new URL(options.localOrigin);

  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || Number(origin.port) !== options.port)
    throw new Error("Computer setup requires the companion's loopback listener.");

  const listenerHost = origin.hostname === "[::1]" ? "::1" : "127.0.0.1";
  const adapter = options.adapter ?? createTailscaleAdapter({ listenerHost });
  const route = `/__labora/setup/${randomBytes(24).toString("hex")}`;
  const instance = { pid: process.pid, instanceId: randomUUID(), url: `${origin.origin}${route}` };
  const enrollmentPath = join(options.dataDir, "enrollment.json");
  const controller = new AbortController();
  let login: ReturnType<typeof adapter.beginLogin> | undefined;
  let enabling = false;
  let enabled = false;
  let activeEnrollment: ActiveEnrollment | undefined;
  let authUrl: string | undefined;
  let message: string | undefined;
  let pairingCode: { code: string; expiresAt: number } | undefined;

  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  await chmod(options.dataDir, 0o700);

  try {
    const stored = Schema.decodeUnknownSync(Schema.fromJsonString(Enrollment))(await privateRead(enrollmentPath));
    const live = await adapter.serveStatus(options.port, controller.signal);

    if (live.configured && live.endpoint === stored.publicUrl && live.self.ownerLogin === stored.ownerLogin && live.self.tagged === Boolean(stored.pairingOnly) && (!stored.pairingOnly || live.self.id === stored.nodeId)) {
      await options.host.enableEnrollment({ ...stored, listenerHost });
      activeEnrollment = { ...stored, nodeId: live.self.id };
      enabled = true;
    } else message = "Computer access changed. Enable access again to reconnect it.";
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
      message = "Saved computer access could not be verified. Check Tailscale, then enable access again.";
  }

  const snapshot = async (): Promise<SetupSnapshot> => {
    const current = await adapter.status(controller.signal);

    if (enabled && activeEnrollment && !enabling) {
      const live = await adapter.serveStatus(options.port, controller.signal).catch(() => undefined);

      if (!live?.configured || live.endpoint !== activeEnrollment.publicUrl || live.self.id !== activeEnrollment.nodeId || live.self.ownerLogin !== activeEnrollment.ownerLogin || live.self.tagged !== Boolean(activeEnrollment.pairingOnly)) {
        enabled = false;
        pairingCode = undefined;
        activeEnrollment = undefined;
        options.host.disableEnrollment();
        message = "Computer access changed. Check Tailscale, then enable access again.";
      }
    }

    return { tailscale: { installed: current.installed, running: current.running, self: current.self }, loggingIn: Boolean(login), enabled, authUrl, error: message ?? current.unavailableReason, pairingCode: pairingCode && pairingCode.expiresAt > Date.now() ? pairingCode : undefined };
  };

  const json = (value: SetupInstance | SetupSnapshot | SetupFailure, status = 200) => Response.json(value, { status, headers });

  const enable = async () => {
    if (login || enabling) throw new TailscaleError({ code: "busy", message: "Finish the current Tailscale step first." });
    enabling = true;
    message = undefined;
    authUrl = undefined;

    try {
      const before = await adapter.status(controller.signal);

      if (!before.running || !before.self || (!before.self.ownerLogin && !before.self.tagged))
        throw new TailscaleError({ code: "owner_required", message: "Sign in to Tailscale with your personal account first." });

      const result = await adapter.ensureServe(options.port, (url) => { authUrl = url; }, controller.signal);
      const after = await adapter.serveStatus(options.port, controller.signal);

      if (!after.configured || after.endpoint !== result.endpoint || after.self.id !== before.self.id || after.self.ownerLogin !== before.self.ownerLogin || after.self.tagged !== before.self.tagged)
        throw new TailscaleError({ code: "identity_changed", message: "The Tailscale account changed. Check the account and try again." });

      const configuration = { publicUrl: result.endpoint, pairingOnly: before.self.tagged, nodeId: before.self.id };

      if (before.self.ownerLogin) Object.assign(configuration, { ownerLogin: before.self.ownerLogin });
      await privateWrite(enrollmentPath, configuration);
      await options.host.enableEnrollment({ ...configuration, listenerHost });
      activeEnrollment = { ...configuration, nodeId: after.self.id };
      enabled = true;
    } finally { enabling = false; }
  };

  const handle = Effect.fn("ComputerSetup.fetch")((request: Request, peerAddress: string | undefined) => Effect.tryPromise({
    try: async () => {
      const url = new URL(request.url);

      if (!url.pathname.startsWith("/__labora/setup/")) return undefined;

      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peerAddress ?? "") || url.origin !== origin.origin || request.headers.get("host") !== origin.host)
        return json({ error: "Open computer setup on this computer." }, 403);

      const parts = url.pathname.split("/");
      const expected = route.split("/")[3] ?? "";
      const supplied = parts[3] ?? "";

      if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) || parts.length > 5 || url.search)
        return json({ error: "This setup link is no longer available. Open setup from Labora." }, 404);

      const action = parts[4] ?? "";

      if (request.method === "GET" && action === "") return new Response(setupPage(), { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });

      if (request.method === "GET" && action === "ready") return json(instance);

      if (request.method === "GET" && action === "status") return json(await snapshot());

      if (request.method !== "POST") return json({ error: "Unknown setup operation." }, 405);

      if (request.headers.get("origin") !== origin.origin || request.headers.get("content-type") !== "application/json")
        return json({ error: "Open computer setup on this computer." }, 403);

      if (action === "login") {
        if (!login && !enabling) {
          message = undefined;
          authUrl = undefined;
          const pending = adapter.beginLogin((value) => { authUrl = value; });
          login = pending;
          void pending.done.then(() => { authUrl = undefined; }).catch((cause: unknown) => { message = cause instanceof TailscaleError ? cause.message : "Tailscale sign-in did not finish."; }).finally(() => { if (login === pending) login = undefined; });
        }
      } else if (action === "cancel") {
        login?.cancel();
        authUrl = undefined;
      } else if (action === "enable") await enable();
      else if (action === "pair-code") {
        await snapshot();

        if (!enabled) throw new TailscaleError({ code: "sharing_required", message: "Enable access before creating a pairing code." });
        const issued = await options.host.issuePairingCode();
        pairingCode = { code: issued.code, expiresAt: issued.expiresAt };
      }
      else return json({ error: "Unknown setup operation." }, 404);

      return json(await snapshot());
    },
    catch: (cause) => cause instanceof TailscaleError ? cause : new TailscaleError({ code: "setup_failed", message: "Computer setup did not finish. Check Tailscale and try again." }),
  }));

  await privateWrite(instancePath(options.dataDir), instance);

  return {
    url: instance.url,
    async fetch(request: Request, peerAddress: string | undefined) {
      const result = await Effect.runPromise(Effect.result(handle(request, peerAddress)));

      if (Result.isFailure(result)) {
        message = result.failure.message;

        return json({ error: message }, 400);
      }

      return result.success;
    },
    async close() {
      controller.abort();
      login?.cancel();
      await login?.done.catch(() => undefined);

      try {
        const current = Schema.decodeUnknownSync(Schema.fromJsonString(SetupInstance))(await privateRead(instancePath(options.dataDir)));

        if (current.instanceId === instance.instanceId) await unlink(instancePath(options.dataDir));
      } catch { /* The instance file may already have been removed during shutdown. */ }
    },
  };
}
