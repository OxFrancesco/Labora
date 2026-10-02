import { useEffect, useRef, useState } from "react";
import { useWindowSize } from "@gpuix/react";
import type { ReactNode } from "react";
import type { Labora } from "./use-labora";
import { CharacterPicker } from "./characters";
import { Button, Label } from "./icons";
import { botColors, color, font } from "./theme";
import { startComputerConnection } from "../enrollment/connect";
import type { ConnectionState } from "../enrollment/connect";
import { launchLocalComputerSetup } from "./computer-setup";

interface SheetProps {
  title: string;
  close: () => void;
  children: ReactNode;
}

export function Sheet({ title, close, children }: SheetProps) {
  const window = useWindowSize();
  const width = Math.min(500, window.width - 48);

  return (
    <anchored deferred priority={100} position={{ x: 0, y: 0 }}>
      <div
        role="dialog"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === "escape") close();
        }}
        style={{
          width: window.width,
          height: window.height,
          backgroundColor: "#00000099",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width,
            display: "flex",
            flexDirection: "column",
            gap: 18,
            padding: 24,
            borderRadius: 18,
            backgroundColor: "#202020",
            borderWidth: 1,
            borderColor: "#383838",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Label size={20}>{title}</Label>
            <Button id="sheet-close" label="Close" icon="close" onClick={close} />
          </div>
          {children}
        </div>
      </div>
    </anchored>
  );
}

const fieldStyle = {
  width: "100%",
  padding: 12,
  borderRadius: 8,
  color: color.text,
  fontFamily: font,
  fontSize: 14,
  backgroundColor: "#101010",
};

interface DialogProps {
  labora: Labora;
  close: () => void;
}

export function ConnectComputer({ labora, close }: DialogProps) {
  const [advanced, setAdvanced] = useState(false);
  const [browserState, setBrowserState] = useState<ConnectionState>();
  const wizard = useRef<ReturnType<typeof startComputerConnection> | undefined>(undefined);
  const acceptConnection = useRef(labora.acceptConnection);
  acceptConnection.current = labora.acceptConnection;
  const refresh = useRef(labora.refresh);
  refresh.current = labora.refresh;
  const [endpoint, setEndpoint] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [settingUp, setSettingUp] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      if (wizard.current) setBrowserState(wizard.current.state());
    }, 500);

    return () => { clearInterval(timer); wizard.current?.close(); };
  }, []);

  async function openConnection() {
    setError("");

    try {
      if (!wizard.current || wizard.current.isClosed()) wizard.current = startComputerConnection({ onConnected: (connection) => acceptConnection.current(connection), onConfirmed: () => refresh.current() });
      setBrowserState(wizard.current.state());
      const child = Bun.spawn(["/usr/bin/open", wizard.current.url], { stdout: "ignore", stderr: "ignore" });

      if (await child.exited !== 0) throw new Error("Could not open your browser. Check your default browser and try again.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not start setup."); }
  }

  async function pair() {
    setConnecting(true);
    setError("");

    try {
      await labora.connect(endpoint, code);
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connection failed.");
    } finally {
      setConnecting(false);
    }
  }

  async function setupComputer() {
    if (settingUp) return;
    setSettingUp(true);
    setError("");

    try {
      const url = await launchLocalComputerSetup();
      const child = Bun.spawn(["/usr/bin/open", url], { stdout: "ignore", stderr: "ignore" });

      if (await child.exited !== 0) throw new Error("Could not open computer setup. Check your default browser and try again.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not start computer setup."); }
    finally { setSettingUp(false); }
  }

  return (
    <Sheet title="Connect a computer" close={close}>
      <Label secondary>{browserState?.stage === "connected"
        ? `${browserState.connectedName} is connected.`
        : browserState
          ? "Continue in your browser. Labora will connect as soon as you approve access."
          : "Sign in to Tailscale, choose your PC, and approve access in your browser."}</Label>
      <Button
        id="connect-with-tailscale"
        label={browserState?.stage === "connected" ? "Done" : browserState ? "Open setup in browser" : "Connect with Tailscale"}
        onClick={() => { if (browserState?.stage === "connected") close(); else void openConnection(); }}
        style={{ backgroundColor: "#eeeeee", borderRadius: 20 }}
      ><Label style={{ color: "#101010" }}>{browserState?.stage === "connected" ? "Done" : browserState ? "Open browser" : "Connect with Tailscale"}</Label></Button>
      {!browserState && !advanced ? <Button id="setup-this-computer" label="Set up this computer" onClick={() => { void setupComputer(); }}>
        <Label size={13}>{settingUp ? "Opening setup…" : "Set up this computer"}</Label>
      </Button> : null}
      {!browserState ? <Button id="connection-advanced" label="Advanced connection" onClick={() => setAdvanced(!advanced)}>
        <Label secondary size={13}>{advanced ? "Hide manual connection" : "Advanced connection"}</Label>
      </Button> : null}
      {advanced ? <>
      <input
        testId="computer-address"
        aria-label="Computer address"
        value={endpoint}
        onChange={(event) => setEndpoint(event.value ?? "")}
        placeholder="https://my-pc.tailnet.ts.net"
        style={fieldStyle}
      />
      <input
        testId="pairing-code"
        aria-label="Pairing code"
        value={code}
        onChange={(event) => setCode(event.value ?? "")}
        onSubmit={() => {
          if (!connecting) void pair();
        }}
        placeholder="8-digit pairing code"
        style={fieldStyle}
      />
      <Button
        id="pair-computer"
        label="Connect computer"
        onClick={() => {
          if (!connecting) void pair();
        }}
        style={{ backgroundColor: "#eeeeee", borderRadius: 20 }}
      >
        <Label style={{ color: "#101010" }}>{connecting ? "Connecting…" : "Connect"}</Label>
      </Button>
      </> : null}
      {error ? <div testId="pair-error"><Label size={13} style={{ color: color.error }}>{error}</Label></div> : null}
    </Sheet>
  );
}

export function CreateBotDialog({ labora, close }: DialogProps) {
  const [name, setName] = useState("New Bot");
  const [connectionId, setConnectionId] = useState(labora.preferences.connections[0]?.id ?? "");
  const [tint, setTint] = useState(botColors[labora.bots.length % botColors.length] ?? "#8450e5");
  const [error, setError] = useState("");

  async function create() {
    const connection = labora.preferences.connections.find((item) => item.id === connectionId);

    if (!connection || !name.trim()) return;

    try {
      await labora.createBot(connection, name.trim(), tint);
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create bot.");
    }
  }

  return (
    <Sheet title="Create new Bot" close={close}>
      <input
        autoFocus
        testId="new-bot-name"
        aria-label="Bot name"
        value={name}
        onChange={(event) => setName(event.value ?? "")}
        onSubmit={() => {
          void create();
        }}
        style={fieldStyle}
      />
      <CharacterPicker value={tint} onChange={setTint} idPrefix="color" />
      {labora.preferences.connections.map((connection) => (
        <Button
          key={connection.id}
          id={`choose-computer-${connection.id}`}
          label={connection.computer.name}
          active={connection.id === connectionId}
          onClick={() => setConnectionId(connection.id)}
          style={{ justifyContent: "flex-start", padding: 10 }}
        >
          <Label>{connection.computer.name}</Label>
        </Button>
      ))}
      {error ? <Label style={{ color: color.error }}>{error}</Label> : null}
      <Button
        id="create-bot"
        label="Create bot"
        onClick={() => {
          void create();
        }}
        style={{ backgroundColor: "#eeeeee", borderRadius: 20 }}
      >
        <Label style={{ color: "#101010" }}>Create</Label>
      </Button>
    </Sheet>
  );
}

export function ConnectionsDialog({ labora, close }: DialogProps) {
  const [answer, setAnswer] = useState("");
  const target = labora.selected;
  const cancelAuth = labora.cancelAuth;
  const attempt = labora.attempt;

  useEffect(
    () => () => attempt(cancelAuth(target)),
    [target?.key, target?.connection.endpoint, target?.connection.token, cancelAuth, attempt],
  );

  return (
    <Sheet title="Connect apps" close={close}>
      <Button
        id="connection-openai"
        label="Sign in with ChatGPT"
        onClick={() => labora.attempt(labora.signIn("openai"))}
        style={{ justifyContent: "space-between", padding: 12, backgroundColor: color.surface }}
      >
        <Label>ChatGPT</Label>
        <Label secondary>{labora.auth?.openai === "ready" ? "Connected" : "Sign in"}</Label>
      </Button>
      <Button
        id="connection-executor"
        label="Connect Executor"
        onClick={() => labora.attempt(labora.signIn("executor"))}
        style={{ justifyContent: "space-between", padding: 12, backgroundColor: color.surface }}
      >
        <Label>Executor</Label>
        <Label secondary>{labora.auth?.executor === "ready" ? "Connected" : "Connect"}</Label>
      </Button>
      {labora.authLink ? (
        <Button
          id="open-auth-link"
          label="Open sign-in page"
          onClick={() => {
            Bun.spawn(["/usr/bin/open", labora.authLink]);
          }}
          style={{ backgroundColor: color.selected }}
        >
          <Label>Open sign-in page</Label>
        </Button>
      ) : null}
      {labora.authQuestion ? (
        <>
          <Label secondary>{labora.authQuestion.message}</Label>
          <input
            testId="auth-answer"
            value={answer}
            onChange={(event) => setAnswer(event.value ?? "")}
            onSubmit={() => labora.attempt(labora.answerAuth(answer))}
            placeholder="Paste the code or callback URL"
            style={fieldStyle}
          />
          <Button
            id="submit-auth-answer"
            label="Continue sign in"
            onClick={() => labora.attempt(labora.answerAuth(answer))}
          >
            <Label>Continue</Label>
          </Button>
        </>
      ) : null}
      {labora.error ? <Label style={{ color: color.error }}>{labora.error}</Label> : null}
    </Sheet>
  );
}
