import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, useGpuix, useWindowSize } from "@gpuix/react";
import type { PublicInstance } from "@gpuix/react";
import type { Connection, Preferences } from "./store";
import type { Labora } from "./use-labora";
import { Button, Icon, Label } from "./icons";
import { color } from "./theme";

interface SettingsProps {
  labora: Labora;
  close: () => void;
  connectComputer: () => void;
  connectApps: () => void;
}

const voiceLanguages = [
  { value: "system", locale: "", label: "System default" },
  { value: "en-GB", locale: "en-GB", label: "English, United Kingdom" },
  { value: "en-US", locale: "en-US", label: "English, United States" },
  { value: "it-IT", locale: "it-IT", label: "Italian" },
] satisfies { value: string; locale: NonNullable<Preferences["voiceLocale"]>; label: string }[];

function Card({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flexShrink: 0, padding: 4, borderRadius: 14, backgroundColor: "#181818" }}>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, minHeight: 58, padding: 14 }}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Toggle({ id, label, value, change }: { id: string; label: string; value: boolean; change: () => void }) {
  return (
    <div
      role="button"
      aria-label={`${label}, ${value ? "on" : "off"}`}
      aria-valuetext={value ? "On" : "Off"}
      testId={id}
      tabIndex={0}
      onClick={change}
      onKeyDown={(event) => {
        if (!event.isHeld && (event.key === "enter" || event.key === "space")) change();
      }}
      style={{ width: 36, height: 22, padding: 3, borderRadius: 12, backgroundColor: value ? "#e6e6e6" : "#414141", display: "flex", justifyContent: value ? "flex-end" : "flex-start", alignItems: "center", flexShrink: 0, cursor: "pointer" }}
    >
      <div style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: value ? "#181818" : "#bcbcbc" }} />
    </div>
  );
}

function authLabel(labora: Labora, provider: "openai" | "executor") {
  if (!labora.auth) return "Unavailable";

  if (labora.auth.active === provider) return "Signing in…";

  return labora.auth[provider] === "ready" ? "Connected" : "Not connected";
}

interface GeneralProps extends Pick<SettingsProps, "labora" | "connectApps"> {
  languageMenuOpen: boolean;
  setLanguageMenuOpen: (open: boolean) => void;
}

function General({ labora, connectApps, languageMenuOpen, setLanguageMenuOpen }: GeneralProps) {
  const language = voiceLanguages.find((item) => item.locale === (labora.preferences.voiceLocale ?? "")) ?? voiceLanguages[0];

  return (
    <>
      <Card>
        {labora.selected ? (
          <>
            <Row label="ChatGPT"><Label secondary>{authLabel(labora, "openai")}</Label></Row>
            <Row label="Executor"><Label secondary>{authLabel(labora, "executor")}</Label></Row>
            <div style={{ padding: 8, paddingTop: 0, alignItems: "flex-end", display: "flex", justifyContent: "flex-end" }}>
              <Button id="settings-connect-apps" label="Connect apps" onClick={connectApps} style={{ paddingLeft: 12, paddingRight: 12, backgroundColor: "#292929" }}>
                <Label size={13}>Connect apps</Label>
              </Button>
            </div>
          </>
        ) : (
          <div style={{ padding: 14 }}><Label secondary>Create or select a bot to connect its apps.</Label></div>
        )}
      </Card>
      <Card>
        <Row label="Compact sidebar">
          <Toggle id="settings-compact" label="Compact sidebar" value={labora.preferences.compact} change={() => labora.updatePreferences({ compact: !labora.preferences.compact })} />
        </Row>
        <Row label="Show bot details">
          <Toggle id="settings-details" label="Show bot details" value={labora.preferences.detailsOpen} change={() => labora.updatePreferences({ detailsOpen: !labora.preferences.detailsOpen })} />
        </Row>
      </Card>
      <Card>
        <Row label="Voice input language">
          <Select
            value={language?.value ?? "system"}
            items={voiceLanguages}
            open={languageMenuOpen}
            onOpenChange={setLanguageMenuOpen}
            onValueChange={(value) => {
              const selected = voiceLanguages.find((item) => item.value === value);

              if (selected) labora.updatePreferences({ voiceLocale: selected.locale });
            }}
          >
            <SelectTrigger
              role="combobox"
              aria-label="Voice input language"
              aria-valuetext={language?.label ?? "System default"}
              testId="settings-voice-language"
              style={{ display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 8, borderRadius: 7, cursor: "pointer", hover: { backgroundColor: "#292929" } }}
            >
              <Label secondary size={13}>{language?.label ?? "System default"}</Label>
              <svg source='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><path d="m3 4.5 3 3 3-3"/></svg>' style={{ width: 12, height: 12, color: color.secondary }} />
            </SelectTrigger>
            <SelectContent role="listbox" aria-label="Voice input languages" side="bottom" align="end" sideOffset={6} style={{ width: 248, padding: 5, borderRadius: 9, borderWidth: 1, borderColor: "#383838", backgroundColor: "#222222", display: "flex", flexDirection: "column" }}>
              {voiceLanguages.map((item) => (
                <SelectItem
                  key={item.value}
                  value={item.value}
                  role="option"
                  aria-label={item.label}
                  aria-selected={item.value === language?.value}
                  testId={`settings-language-${item.value}`}
                  style={(state) => ({ padding: 10, borderRadius: 5, backgroundColor: state.highlighted ? "#3c3c3c" : "transparent", cursor: "pointer" })}
                >
                  <Label size={13}>{item.label}</Label>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </Card>
      <div style={{ padding: 14, display: "flex", justifyContent: "space-between" }}>
        <Label secondary size={12}>Version</Label><Label secondary size={12}>0.1.0</Label>
      </div>
    </>
  );
}

const platformNames = { macos: "macOS", linux: "Linux", windows: "Windows", unsupported: "Unknown platform" };

function Computers({ labora, connectComputer }: Pick<SettingsProps, "labora" | "connectComputer">) {
  const [disconnecting, setDisconnecting] = useState("");
  const [error, setError] = useState("");

  async function disconnect(connection: Connection) {
    if (disconnecting) return;
    setDisconnecting(connection.id);
    setError("");

    try {
      await labora.disconnect(connection);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not disconnect this computer.");
    } finally {
      setDisconnecting("");
    }
  }

  return (
    <>
      {labora.preferences.connections.length ? labora.preferences.connections.map((connection) => (
        <Card key={connection.id}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flexGrow: 1 }}>
              <Label>{connection.computer.name}</Label>
              <Label secondary size={12}>{platformNames[connection.computer.platform]}</Label>
              <Label secondary size={12} style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{connection.endpoint}</Label>
            </div>
            <Button id={`disconnect-${connection.id}`} label={`Disconnect ${connection.computer.name}`} onClick={() => { void disconnect(connection); }} style={{ paddingLeft: 12, paddingRight: 12, flexShrink: 0, backgroundColor: "#292929" }}>
              <Label size={13}>{disconnecting === connection.id ? "Disconnecting…" : "Disconnect"}</Label>
            </Button>
          </div>
        </Card>
      )) : (
        <Card><div style={{ padding: 14 }}><Label secondary>Connect a PC through Tailscale or add a Cloudflare desktop.</Label></div></Card>
      )}
      {error ? <Label size={13} style={{ color: color.error }}>{error}</Label> : null}
      <Button id="settings-add-computer" label="Add computer" onClick={connectComputer} style={{ paddingLeft: 14, paddingRight: 14, backgroundColor: "#eeeeee", alignSelf: "flex-start", borderRadius: 18 }}>
        <Label size={13} style={{ color: "#101010" }}>Add computer</Label>
      </Button>
    </>
  );
}

export function Settings({ labora, close, connectComputer, connectApps }: SettingsProps) {
  const [section, setSection] = useState<"General" | "Computer">("General");
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const window = useWindowSize();
  const { renderer } = useGpuix();
  const controls = useRef<PublicInstance | null>(null);
  const width = Math.min(945, window.width - 48);

  useLayoutEffect(() => {
    const previous = renderer?.getFocusedElementId?.();
    let mounted = true;
    queueMicrotask(() => {
      if (mounted && controls.current) renderer?.focusNextWithin?.(controls.current.id);
    });

    return () => {
      mounted = false;

      if (previous !== undefined && previous !== null) renderer?.focusElement?.(previous);
    };
  }, [renderer]);

  return (
    <anchored deferred priority={0} position={{ x: 0, y: 0 }} occlude>
      <div style={{ width: window.width, height: window.height, backgroundColor: "#00000088", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div tabIndex={0} onFocus={() => { if (controls.current) renderer?.focusPreviousWithin?.(controls.current.id); }} style={{ width: 0, height: 0 }} />
        <div
          ref={controls}
          role="dialog"
          aria-label="Labora settings"
          testId="settings-dialog"
          onKeyDown={(event) => { if (event.key === "escape" && !languageMenuOpen) close(); }}
          style={{ width, height: Math.min(665, window.height - 56), borderRadius: 18, borderWidth: 1, borderColor: "#2b2b2b", backgroundColor: color.canvas, overflow: "hidden", display: "flex", flexDirection: "row" }}
        >
          <div role="navigation" aria-label="Settings sections" style={{ width: width < 820 ? 170 : 200, flexShrink: 0, padding: 16, paddingTop: 60, display: "flex", flexDirection: "column", gap: 5, borderRightWidth: 1, borderColor: "#202020" }}>
            {(["General", "Computer"] satisfies (typeof section)[]).map((item) => (
              <Button key={item} id={`settings-section-${item.toLowerCase()}`} label={item} active={section === item} onClick={() => { setLanguageMenuOpen(false); setSection(item); }} style={{ justifyContent: "flex-start", gap: 10, padding: 11, borderRadius: 9 }}>
                <Icon name={item === "General" ? "settings" : "computer"} size={18} tint={section === item ? color.text : color.secondary} />
                <Label secondary={section !== item}>{item}</Label>
              </Button>
            ))}
          </div>
          <div style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: 24, paddingBottom: 18 }}>
              <div role="heading" aria-level={1}><Label size={22} style={{ fontWeight: 600 }}>{section}</Label></div>
              <Button id="sheet-close" label="Close settings" icon="close" onClick={close} />
            </div>
            <div style={{ flexGrow: 1, minHeight: 0, padding: 24, paddingTop: 0, overflowY: "scroll", display: "flex", flexDirection: "column", gap: 14 }}>
              {section === "General" ? <General labora={labora} connectApps={connectApps} languageMenuOpen={languageMenuOpen} setLanguageMenuOpen={setLanguageMenuOpen} /> : <Computers labora={labora} connectComputer={connectComputer} />}
            </div>
          </div>
        </div>
        <div tabIndex={0} onFocus={() => { if (controls.current) renderer?.focusNextWithin?.(controls.current.id); }} style={{ width: 0, height: 0 }} />
      </div>
    </anchored>
  );
}
