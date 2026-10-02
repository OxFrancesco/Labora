import { useEffect, useState } from "react";
import { Match } from "effect";
import { RoutineSchedule } from "../backend/routine-contracts";
import type { Routine, RoutineRun } from "../backend/routine-contracts";
import { EventPayload } from "../backend/contracts";
import type { MessageSnapshot } from "../backend/contracts";
import type { LinkedBot } from "./use-labora";
import { computerClient } from "./client";
import { Button, Icon, Label } from "./icons";
import { color, font } from "./theme";
import { AgentPlan, AgentQuestion } from "./agent-input";
import { avatarActivityLabels } from "./avatar-motion";

const fieldStyle = {
  width: "100%", padding: 10, borderRadius: 8, color: color.text,
  fontFamily: font, fontSize: 13, backgroundColor: "#202020",
};

function scheduleLabel(schedule: RoutineSchedule) {
  return RoutineSchedule.match(schedule, {
    Once: ({ at }) => new Date(at).toLocaleString(),
    Cron: ({ expression, timeZone }) => {
      const [minute, hour, day, month, weekday] = expression.split(/\s+/);
      const time = `${hour?.padStart(2, "0")}:${minute?.padStart(2, "0")}`;

      if (/^\d+ \d+ \* \* (\*|1-5|1)$/.test(expression) && day === "*" && month === "*") {
        const frequency = Match.value(weekday).pipe(
          Match.when("*", () => "Every day"),
          Match.when("1-5", () => "Weekdays"),
          Match.orElse(() => "Mondays"),
        );

        return `${frequency} at ${time} · ${timeZone}`;
      }

      return `${expression} · ${timeZone}`;
    },
  });
}

function RoutineResults({ selected, routine, close }: { selected: LinkedBot; routine: Routine; close: () => void }) {
  const [snapshot, setSnapshot] = useState<MessageSnapshot | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const conversationId = `routine-${routine.id}`;

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;

      try {
        const next = await computerClient(selected.connection).messages(selected.bot.id, conversationId);

        if (!cancelled) { setSnapshot(next); setError(""); }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load results.");
      } finally { inFlight = false; }
    };

    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1_000);

    return () => { cancelled = true; clearInterval(timer); };
  }, [selected.key, selected.connection.endpoint, selected.connection.token, conversationId, revision]);

  async function act(operation: Promise<Response>) {
    try { await operation; setError(""); setRevision((value) => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not complete the action."); }
  }

  const approval = snapshot?.pending.find(EventPayload.isAnyOf(["ApprovalRequested"]));
  const question = snapshot?.pending.find(EventPayload.isAnyOf(["QuestionRequested"]));

  return <div testId="routine-conversation" style={{ display: "flex", flexDirection: "column", minHeight: 0, flexGrow: 1, gap: 12 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Button id="routine-results-back" label="Back to routine" icon="back" onClick={close} />
      <Label>{routine.name}</Label>
    </div>
    {error ? <Label size={12} style={{ color: color.error }}>{error}</Label> : null}
    <div style={{ display: "flex", flexDirection: "column", overflowY: "scroll", minHeight: 0, flexGrow: 1, gap: 14 }}>
      {snapshot && !snapshot.messages.length ? <Label secondary size={13}>No results yet</Label> : null}
      {snapshot?.messages.map((message) => message.role === "assistant" && !message.text.trim() ? null : <div key={message.id} style={{ display: "flex", flexDirection: "column", gap: 4, padding: 10, borderRadius: 10, backgroundColor: message.role === "user" ? color.surface : "transparent" }}>
        <Label secondary size={11}>{`${message.role === "user" ? "Instruction" : selected.bot.name} · ${new Date(message.createdAt).toLocaleTimeString()}`}</Label>
        <markdown source={message.text} style={{ color: color.text, fontFamily: font, fontSize: 13, lineHeight: 20 }} />
      </div>)}
      {snapshot?.plan ? <AgentPlan plan={snapshot.plan} /> : null}
      {snapshot?.activity && snapshot.activity.phase !== "idle" ? <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Label size={12} secondary>{avatarActivityLabels[snapshot.activity.phase]}</Label>
        {snapshot.activity.message && (snapshot.activity.phase === "working" || snapshot.activity.phase === "failed") ? <div testId="routine-tool-progress" style={{ maxHeight: 96, overflowY: "scroll" }}><Label size={12} secondary>{snapshot.activity.message}</Label></div> : null}
      </div> : null}
      {question ? <AgentQuestion key={question.requestId} question={question} answer={async (requestId, runId, answers) => {
        await computerClient(selected.connection).answerQuestion(selected.bot.id, requestId, { runId, answers }, conversationId);
        setRevision((value) => value + 1);
      }} /> : null}
      {approval ? <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 12, backgroundColor: color.surface }}>
        <Label size={13}>Allow {approval.toolName}?</Label>
        <Label size={12} secondary>{JSON.stringify(approval.input, null, 2)}</Label>
        <div style={{ display: "flex", gap: 8 }}>
          <Button id="routine-approve" label="Approve routine action" onClick={() => { void act(computerClient(selected.connection).approve(selected.bot.id, approval.requestId, "approve")); }}><Label>Allow</Label></Button>
          <Button id="routine-deny" label="Deny routine action" onClick={() => { void act(computerClient(selected.connection).approve(selected.bot.id, approval.requestId, "deny")); }}><Label>Deny</Label></Button>
        </div>
      </div> : null}
    </div>
    {snapshot?.busy && snapshot.activity?.runId ? <Button id="routine-stop" label="Stop routine run" icon="stop" onClick={() => { void act(computerClient(selected.connection).cancel(selected.bot.id, conversationId, snapshot.activity?.runId)); }} style={{ gap: 8, marginBottom: 14 }}><Label>Stop</Label></Button> : null}
  </div>;
}

function RoutineEditor({ selected, routine, close, saved }: {
  selected: LinkedBot;
  routine?: Routine;
  close: () => void;
  saved: (routine: Routine) => void;
}) {
  const initial = routine ? RoutineSchedule.match(routine.schedule, {
    Once: ({ at }) => ({ mode: "once", value: at, zone: "" }),
    Cron: ({ expression, timeZone }) => ({ mode: "cron", value: expression, zone: timeZone }),
  }) : { mode: "cron", value: "0 9 * * 1-5", zone: Intl.DateTimeFormat().resolvedOptions().timeZone };

  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [mode, setMode] = useState(initial.mode);
  const [expression, setExpression] = useState(initial.mode === "cron" ? initial.value : "0 9 * * 1-5");
  const simpleSchedule = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|1)$/.exec(expression);
  const [custom, setCustom] = useState(initial.mode === "cron" && !simpleSchedule);
  const [frequency, setFrequency] = useState(simpleSchedule?.[3] ?? "1-5");
  const [time, setTime] = useState(`${(simpleSchedule?.[2] ?? "9").padStart(2, "0")}:${(simpleSchedule?.[1] ?? "0").padStart(2, "0")}`);
  const [at, setAt] = useState(initial.mode === "once" ? initial.value : "");
  const [zone, setZone] = useState(initial.zone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError("");

    try {
      if (!name.trim() || !prompt.trim()) throw new Error("Enter a name and an instruction.");

      if (mode === "once" && !/(?:Z|[+-]\d{2}:\d{2})$/.test(at.trim()))
        throw new Error("Include a time zone, such as +02:00 or Z for UTC.");

      if (mode === "cron" && !custom && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
        throw new Error("Enter a time from 00:00 to 23:59.");

      const [hour, minute] = time.split(":");
      const cron = custom ? expression.trim() : `${Number(minute)} ${Number(hour)} * * ${frequency}`;

      const schedule = mode === "once"
        ? RoutineSchedule.cases.Once.make({ at: new Date(at).toISOString() })
        : RoutineSchedule.cases.Cron.make({ expression: cron, timeZone: zone.trim() });

      const client = computerClient(selected.connection);
      const update = { name: name.trim(), prompt: prompt.trim(), schedule };

      const result = routine
        ? await client.updateRoutine(routine.id, update)
        : await client.createRoutine({ ...update, botId: selected.bot.id });

      saved(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the routine.");
    } finally {
      setSaving(false);
    }
  }

  return <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flexGrow: 1, gap: 12, overflowY: "scroll", paddingBottom: 16 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Button id="routine-editor-back" label="Back to routines" icon="back" onClick={close} />
      <Label>{routine ? "Edit routine" : "New routine"}</Label>
    </div>
    <input autoFocus testId="routine-name" aria-label="Routine name" placeholder="Name" value={name} onChange={(event) => setName(event.value ?? "")} style={fieldStyle} />
    <Label secondary size={12}>Instruction</Label>
    <textarea testId="routine-prompt" aria-label="Routine instruction" placeholder="What should this bot do?" value={prompt} onChange={(event) => setPrompt(event.value ?? "")} style={{ ...fieldStyle, minHeight: 100 }} />
    <Label secondary size={12}>When to run</Label>
    <div style={{ display: "flex", gap: 8 }}>
      <Button id="routine-repeat" label="Repeat" active={mode === "cron"} onClick={() => setMode("cron")}><Label size={13}>Repeat</Label></Button>
      <Button id="routine-once" label="Once" active={mode === "once"} onClick={() => setMode("once")}><Label size={13}>Once</Label></Button>
    </div>
    {mode === "cron" ? <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {[
          { name: "Weekdays", value: "1-5" },
          { name: "Daily", value: "*" },
          { name: "Mondays", value: "1" },
        ].map((preset) => <Button key={preset.value} id={`routine-preset-${preset.name.toLowerCase()}`} label={preset.name} active={!custom && frequency === preset.value} onClick={() => { setFrequency(preset.value); setCustom(false); }}><Label size={12}>{preset.name}</Label></Button>)}
        <Button id="routine-custom" label="Custom schedule" active={custom} onClick={() => setCustom(true)}><Label size={12}>Custom</Label></Button>
      </div>
      {custom ? <>
        <input testId="routine-cron" aria-label="Cron schedule" value={expression} onChange={(event) => setExpression(event.value ?? "")} style={fieldStyle} />
        <Label secondary size={11}>Minute, hour, day of month, month, day of week</Label>
      </> : <input testId="routine-time" aria-label="Time, 24-hour clock" placeholder="09:00" value={time} onChange={(event) => setTime(event.value ?? "")} style={fieldStyle} />}
      <input testId="routine-timezone" aria-label="Time zone" placeholder="Europe/Rome" value={zone} onChange={(event) => setZone(event.value ?? "")} style={fieldStyle} />
    </> : <>
      <input testId="routine-at" aria-label="Date and time with time zone" placeholder="2026-10-05T09:00:00+02:00" value={at} onChange={(event) => setAt(event.value ?? "")} style={fieldStyle} />
      <Label secondary size={11}>Include the time zone, for example +02:00.</Label>
    </>}
    <Label secondary size={12}>Runs while {selected.connection.computer.name} is awake. {routine ? "" : "New routines start paused."}</Label>
    {error ? <Label size={12} style={{ color: color.error }}>{error}</Label> : null}
    <Button id="routine-save" label="Save routine" onClick={() => { void save(); }} style={{ backgroundColor: "#eeeeee", borderRadius: 20 }}><Label style={{ color: "#101010" }}>{saving ? "Saving…" : "Save"}</Label></Button>
  </div>;
}

export function Routines({ selected, onOpenChange }: { selected: LinkedBot; onOpenChange: (open: boolean) => void }) {
  const [routines, setRoutines] = useState<readonly Routine[]>([]);
  const [runs, setRuns] = useState<readonly RoutineRun[]>([]);
  const [opened, setOpened] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [working, setWorking] = useState(false);
  const [revision, setRevision] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const routine = routines.find((item) => item.id === opened);

  useEffect(() => { onOpenChange(editing || !!routine); }, [editing, routine?.id, onOpenChange]);
  useEffect(() => () => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    let cancelled = false;
    const client = computerClient(selected.connection);
    let inFlight = false;

    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;

      try {
        const [next, history] = await Promise.all([client.routines(), opened ? client.routineRuns(opened) : Promise.resolve([])]);

        if (cancelled) return;
        setRoutines(next.filter((item) => item.botId === selected.bot.id));
        setRuns(history);
        setLoaded(true);
        setError("");
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load routines.");
      } finally { inFlight = false; }
    };

    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5_000);

    return () => { cancelled = true; clearInterval(timer); };
  }, [selected.key, selected.connection.endpoint, selected.connection.token, opened, revision]);

  async function act(operation: () => Promise<void>) {
    if (working) return;
    setWorking(true);
    setError("");

    try { await operation(); setRevision((value) => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The routine could not be updated."); }
    finally { setWorking(false); }
  }

  function save(result: Routine) {
    setRoutines((current) => [...current.filter((item) => item.id !== result.id), result]);
    setOpened(result.id);
    setEditing(false);
    setRevision((value) => value + 1);
  }

  if (editing) return <RoutineEditor selected={selected} routine={routine} close={() => setEditing(false)} saved={save} />;

  if (routine && showResults) return <RoutineResults key={routine.id} selected={selected} routine={routine} close={() => setShowResults(false)} />;

  return <div testId="routines" style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, gap: 12 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      {routine ? <Button id="routine-back" label="Back to routines" icon="back" onClick={() => { setOpened(null); setConfirmDelete(false); }} /> : null}
      <Label size={13} secondary={!routine}>{routine?.name ?? "Routines"}</Label>
      {!routine ? <Button id="routine-new" label="New routine" icon="plus" onClick={() => { setOpened(null); setEditing(true); }} /> : null}
    </div>
    {error ? <Label size={12} style={{ color: color.error }}>{error}</Label> : null}
    {routine ? <>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, overflowY: "scroll", flexGrow: 1, minHeight: 0 }}>
        <Label size={12} secondary>Instruction</Label>
        <Label size={13}>{routine.prompt}</Label>
        <Label size={12} secondary>When to run</Label>
        <Label size={13}>{scheduleLabel(routine.schedule)}</Label>
        <Label size={12} secondary>{routine.enabled ? `Next: ${routine.nextRunAt ? new Date(routine.nextRunAt).toLocaleString() : "No upcoming run"}` : "Paused"}</Label>
        {runs.length ? <Button id="routine-results" label="View routine results" onClick={() => setShowResults(true)} style={{ justifyContent: "space-between", backgroundColor: color.surface }}><Label size={13}>View results</Label><Icon name="chevron" size={14} /></Button> : null}
        {runs.map((run) => <div key={run.id} style={{ display: "flex", flexDirection: "column", gap: 3, paddingTop: 10, borderTopWidth: 1, borderColor: color.border }}>
          <Label size={12}>{run.status.charAt(0).toUpperCase() + run.status.slice(1)} · {new Date(run.startedAt ?? run.scheduledAt).toLocaleString()}</Label>
          {run.message ? <Label size={12} secondary>{run.message}</Label> : null}
        </div>)}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingBottom: 14 }}>
        <Button id="routine-toggle" label={routine.enabled ? "Pause routine" : "Enable routine"} onClick={() => { void act(async () => { save(await computerClient(selected.connection).enableRoutine(routine.id, !routine.enabled)); }); }} style={{ backgroundColor: color.surface }}><Label size={12}>{routine.enabled ? "Pause" : "Enable"}</Label></Button>
        <Button id="routine-edit" label="Edit routine" onClick={() => { if (!working) setEditing(true); }} style={{ backgroundColor: color.surface }}><Label size={12}>Edit</Label></Button>
        <Button id="routine-run" label="Run routine now" onClick={() => { void act(async () => { const run = await computerClient(selected.connection).runRoutine(routine.id); setRuns((current) => [run, ...current]); }); }} style={{ backgroundColor: color.surface }}><Label size={12}>Run now</Label></Button>
        <Button id="routine-delete" label={confirmDelete ? "Confirm delete routine" : "Delete routine"} onClick={() => {
          if (!confirmDelete) { setConfirmDelete(true);

 return; }

          void act(async () => { await computerClient(selected.connection).deleteRoutine(routine.id); setRoutines((current) => current.filter((item) => item.id !== routine.id)); setOpened(null); setConfirmDelete(false); });
        }}><Label size={12} style={{ color: color.error }}>{confirmDelete ? "Confirm delete" : "Delete"}</Label></Button>
      </div>
    </> : <div style={{ display: "flex", flexDirection: "column", overflowY: "scroll", minHeight: 0, gap: 4 }}>
      {loaded && !routines.length ? <Label secondary size={13}>No routines yet</Label> : null}
      {routines.map((item) => <Button key={item.id} id={`routine-${item.id}`} label={item.name} onClick={() => { setOpened(item.id); setConfirmDelete(false); }} style={{ justifyContent: "space-between", padding: 10, gap: 8 }}>
        <div style={{ display: "flex", flexDirection: "column", flexShrink: 1, gap: 3 }}>
          <Label size={13}>{item.name}</Label>
          <Label size={11} secondary>{item.enabled ? scheduleLabel(item.schedule) : "Paused"}</Label>
        </div>
        <Icon name="chevron" size={14} />
      </Button>)}
    </div>}
  </div>;
}
