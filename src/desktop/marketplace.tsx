import { useCallback, useEffect, useState } from "react";
import { officialConnectors, type Connector, type ConnectorChange, type CustomConnector } from "../backend/connector-contracts";
import { computerClient } from "./client";
import { Button, Label } from "./icons";
import { color, font } from "./theme";
import type { Labora } from "./use-labora";

const authLabels = { oauth: "Browser sign-in", none: "No sign-in" };

const fieldStyle = { width: "100%", minHeight: 42, padding: 12, borderRadius: 8, color: color.text, fontFamily: font, fontSize: 14, backgroundColor: "#101010" };

function statusLabel(item: Connector, active: string | null | undefined) {
  if (active === item.id) return "Connecting…";

  if (item.status === "connected") return item.enabled ? "Connected" : "Paused";

  if (item.status === "checking") return "Checking…";

  if (item.status === "error") return "Reconnect";

  return "Connect";
}

export function Marketplace({ labora }: { labora: Labora }) {
  const target = labora.selected;
  const [items, setItems] = useState<readonly Connector[]>(() => officialConnectors.map((item) => ({ ...item, enabled: false, status: "disconnected", message: "" })));
  const [search, setSearch] = useState("");
  const [selected, select] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<CustomConnector["auth"]>("oauth");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!target) return;
    setItems(await computerClient(target.connection).connectors(target.bot.id));
    setLoaded(true);
  }, [target?.key, target?.connection.endpoint, target?.connection.token]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        if (!target) return;
        const next = await computerClient(target.connection).connectors(target.bot.id);

        if (active) { setItems(next); setLoaded(true); }
      } catch { if (active) setError("Could not load apps. Check your computer connection."); }
      finally { if (active) timer = setTimeout(() => { void poll(); }, 2000); }
    };

    void poll();

    return () => { active = false; clearTimeout(timer); };
  }, [target?.key, target?.connection.endpoint, target?.connection.token]);

  const change = async (item: Connector, action: ConnectorChange["action"]) => {
    if (!target || pending || labora.auth?.active) return;
    setPending(true); setError("");

    try {
      await computerClient(target.connection).changeConnector(target.bot.id, { id: item.id, action });
      await refresh();

      if (action === "remove") select("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update this app."); }
    finally { setPending(false); }
  };

  const add = async () => {
    if (!target || pending || !name.trim() || !url.trim()) return;
    setPending(true); setError("");

    try {
      const id = `custom_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
      await computerClient(target.connection).addConnector(target.bot.id, { id, name: name.trim(), url: url.trim(), auth });
      await refresh(); select(id); setName(""); setUrl("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not add this server."); }
    finally { setPending(false); }
  };

  const item = items.find((entry) => entry.id === selected);
  const query = search.trim().toLowerCase();
  const visible = items.filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(query));

  const connect = (id: string) => {
    if (pending || labora.auth?.active) return;
    setError(""); labora.setError(""); labora.attempt(labora.signIn(id));
  };

  return <div testId="marketplace" style={{ display: "flex", flexDirection: "column", gap: 12, flexShrink: 0, minWidth: 0 }}>
    {selected ? <Button id="marketplace-back" label="Back to apps" onClick={() => { select(""); setError(""); }} style={{ alignSelf: "flex-start" }}><Label secondary>‹ All apps</Label></Button> : null}
    {item ? <>
      <Label size={20}>{item.name}</Label>
      <Label secondary>{item.description}</Label>
      {item.id === "ocu" ? <Label secondary>Connect opens permission setup on this agent's Mac. Allow Accessibility and Screen Recording for Labora Open Computer Use. Clicks and typing still ask for your approval.</Label> : null}
      {item.id === "github" ? <Label secondary>Sign in through GitHub in your browser. You may need to reconnect after restarting the companion.</Label> : item.id.startsWith("custom_") ? <Label secondary size={12}>{item.url}</Label> : null}
      {item.status === "connected" ? <Label secondary>{item.enabled ? "Enabled for this agent" : "Paused for this agent"}</Label> : null}
      {item.message ? <Label style={{ color: color.error }}>{item.message}</Label> : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button id={`connect-${item.id}`} label={`Connect ${item.name}`} onClick={() => connect(item.id)} style={{ backgroundColor: color.selected }}><Label>{labora.auth?.active === item.id ? "Connecting…" : item.status === "connected" ? "Reconnect" : "Connect"}</Label></Button>
        {item.status === "connected" || item.enabled ? <Button id={`toggle-${item.id}`} label={item.enabled ? `Pause ${item.name}` : `Enable ${item.name}`} onClick={() => { void change(item, item.enabled ? "disable" : "enable"); }}><Label>{item.enabled ? "Pause for this agent" : "Enable for this agent"}</Label></Button> : null}
        {item.status !== "disconnected" ? <Button id={`disconnect-${item.id}`} label={`Disconnect ${item.name}`} onClick={() => { void change(item, "disconnect"); }}><Label>Disconnect</Label></Button> : null}
        {item.docs ? <Button id={`docs-${item.id}`} label={`${item.name} setup guide`} onClick={() => { Bun.spawn(["/usr/bin/open", item.docs]); }}><Label>Setup guide</Label></Button> : null}
        {item.id.startsWith("custom_") ? <Button id={`remove-${item.id}`} label={`Remove ${item.name}`} onClick={() => { void change(item, "remove"); }}><Label>Remove server</Label></Button> : null}
      </div>
    </> : selected === "executor" ? <>
      <Label size={20}>Executor</Label>
      <Label secondary>Connect apps through your Executor account.</Label>
      <Button id="connection-executor" label="Connect Executor" onClick={() => connect("executor")} style={{ backgroundColor: color.selected }}><Label>{labora.auth?.active === "executor" ? "Connecting…" : labora.auth?.executor === "ready" ? "Connected" : "Connect"}</Label></Button>
    </> : selected === "new" ? <>
      <input testId="connector-name" aria-label="App name" placeholder="App name" value={name} onChange={(event) => setName(event.value ?? "")} style={fieldStyle} />
      <input testId="connector-url" aria-label="MCP server URL" placeholder="https://example.com/mcp" value={url} onChange={(event) => setUrl(event.value ?? "")} style={fieldStyle} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {(["oauth", "none"] as const).map((mode) => <Button key={mode} id={`connector-auth-${mode}`} label={authLabels[mode]} active={auth === mode} onClick={() => setAuth(mode)}><Label>{authLabels[mode]}</Label></Button>)}
      </div>
      <Button id="connector-add" label="Add MCP server" onClick={() => { void add(); }} style={{ backgroundColor: color.selected }}><Label>{pending ? "Adding…" : "Add server"}</Label></Button>
    </> : <>
      <Button id="connection-openai" label="Sign in with ChatGPT" onClick={() => connect("openai")} style={{ justifyContent: "space-between", padding: 12, backgroundColor: color.surface }}><Label>ChatGPT</Label><Label secondary>{labora.auth?.active === "openai" ? "Signing in…" : labora.auth?.openai === "ready" ? "Connected" : "Sign in"}</Label></Button>
      <Label secondary>{`Apps for ${target?.bot.name ?? "this agent"}`}</Label>
      <input testId="marketplace-search" aria-label="Search apps" placeholder="Search apps" value={search} onChange={(event) => setSearch(event.value ?? "")} style={fieldStyle} />
      {visible.map((entry) => <Button key={entry.id} id={`marketplace-${entry.id}`} label={`Open ${entry.name} connection`} onClick={() => { select(entry.id); setError(""); }} style={{ justifyContent: "space-between", gap: 12, padding: 12, backgroundColor: color.surface }}>
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0, gap: 3 }}><Label>{entry.name}</Label><Label secondary size={12}>{entry.description}</Label></div>
        <Label secondary size={12}>{statusLabel(entry, labora.auth?.active)}</Label>
      </Button>)}
      {"executor integrations".includes(query) ? <Button id="connection-executor" label="Connect Executor" onClick={() => { select("executor"); connect("executor"); }} style={{ justifyContent: "space-between", gap: 12, padding: 12, backgroundColor: color.surface }}><div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0, gap: 3 }}><Label>Executor</Label><Label secondary size={12}>Connect more apps through Executor</Label></div><Label secondary size={12}>{labora.auth?.active === "executor" ? "Connecting…" : labora.auth?.executor === "ready" ? "Connected" : "Connect"}</Label></Button> : null}
      {loaded && visible.length === 0 && !"executor integrations".includes(query) ? <Label secondary>No matching apps</Label> : null}
      <Button id="marketplace-custom" label="Add custom MCP server" onClick={() => { select("new"); setError(""); }} style={{ alignSelf: "flex-start" }}><Label>+ Add custom MCP server</Label></Button>
    </>}
    {pending ? <Label secondary>Updating connection…</Label> : null}
    {error ? <Label style={{ color: color.error }}>{error}</Label> : null}
  </div>;
}
