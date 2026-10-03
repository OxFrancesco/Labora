import { toolInput } from "../tool-presentation";
import { useCallback, useEffect, useRef, useState } from "react";
import { basename, join } from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import { EventPayload, isConversationEvent } from "../backend/contracts";
import type { BotActivity } from "../backend/contracts";
import type { PlanState } from "../backend/plan-contracts";
import { idleActivity, reduceActivity } from "../backend/activity";
import { reduceMessages } from "./conversation-state";
import type {
  AgentEvent,
  AuthStatus,
  Bot,
  Message,
  Provider,
  QuestionResponse,
  QueuedInput,
  UpdateBot,
} from "../backend/contracts";
import { computerClient, pairComputer } from "./client";
import type { Connection, Draft, Preferences, createDesktopStore } from "./store";

export interface LinkedBot {
  bot: Bot;
  connection: Connection;
  key: string;
}

interface BotChanges {
  confirmed: Bot;
  pending: { id: string; update: UpdateBot }[];
  tail: Promise<void>;
}

function visibleBot(changes: BotChanges): Bot {
  const bot = { ...changes.confirmed };

  for (const change of changes.pending) Object.assign(bot, change.update);

  return bot;
}

interface Approval {
  requestId: string;
  toolName: string;
  input: string;
}

interface AuthQuestion {
  provider: Provider;
  message: string;
  secret: boolean;
}

export type DesktopStore = Awaited<ReturnType<typeof createDesktopStore>>;

export function useLabora(store: DesktopStore) {
  const [preferences, renderPreferences] = useState(store.preferences);
  const latestPreferences = useRef(preferences);
  const [bots, setBots] = useState<LinkedBot[]>([]);
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [directRunId, setDirectRunId] = useState<string>();
  const [questions, setQuestions] = useState<Extract<EventPayload, { _tag: "QuestionRequested" }>[]>([]);
  const [queuedInputs, setQueuedInputs] = useState<readonly QueuedInput[]>([]);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [activity, setActivity] = useState("");
  const [botActivities, setBotActivities] = useState<ReadonlyMap<string, BotActivity>>(new Map());
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const approval = approvals[0];
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authLink, setAuthLink] = useState("");
  const [authQuestion, setAuthQuestion] = useState<AuthQuestion | null>(null);
  const selected = bots.find((item) => item.key === preferences.selected) ?? bots[0];
  const key = selected?.key ?? "new";
  const draft = preferences.drafts.find((item) => item.key === key) ?? { key, text: "", paths: [] };
  const currentSelection = useRef(selected);
  const sending = useRef(new Set<string>());
  const queuedAttempts = useRef(new Map<string, { signature: string; id: string }>());
  const botChanges = useRef(new Map<string, BotChanges>());
  const authStarts = useRef(new Map<string, Promise<void>>());
  const authCancellations = useRef(new Map<string, Promise<void>>());
  const authVersions = useRef(new Map<string, number>());
  currentSelection.current = selected;

  const isCurrent = useCallback((target: LinkedBot) => {
    const current = currentSelection.current;

    return (
      current?.key === target.key &&
      current.connection.endpoint === target.connection.endpoint &&
      current.connection.token === target.connection.token
    );
  }, []);

  const reportError = useCallback((reason: Error) => setError(reason.message), []);

  const setPreferences = useCallback((update: (current: Preferences) => Preferences) => {
    const next = update(latestPreferences.current);
    latestPreferences.current = next;
    renderPreferences(next);
    const saved = store.save(next);
    void saved.catch(reportError);

    return saved;
  }, [store, reportError]);

  const attempt = useCallback(
    (operation: Promise<void>) => {
      void operation.catch(reportError);
    },
    [reportError],
  );

  const refresh = useCallback(async () => {
    const loaded = await Promise.allSettled(
      preferences.connections.map(async (connection) => {
        const remote = await computerClient(connection).bots();

        return remote.map((bot) => ({ bot, connection, key: `${connection.id}/${bot.id}` }));
      }),
    );

    const available: LinkedBot[] = [];

    for (const result of loaded) {
      if (result.status === "fulfilled") available.push(...result.value);
      else
        setError(
          "One of your computers is unavailable. Check that Labora Computer and Tailscale are running.",
        );
    }

    setBots(available.map((item) => {
      const changes = botChanges.current.get(item.key);

      return changes ? { ...item, bot: visibleBot(changes) } : item;
    }));
  }, [preferences.connections]);

  useEffect(() => {
    attempt(refresh());
  }, [refresh, attempt]);

  useEffect(() => {
    setMessages([]);
    setAuth(null);
    setApprovals([]);
    setBusy(false);
    setDirectRunId(undefined);
    setQuestions([]);
    setQueuedInputs([]);
    setPlan(null);
    setActivity("");
    setAuthLink("");
    setAuthQuestion(null);

    if (!selected) return;
    const controller = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const client = computerClient(selected.connection);

    let streamedMessages: readonly Message[] = [];
    let botActivity = idleActivity();

    const updateActivity = (next: BotActivity) => {
      botActivity = next;
      setBotActivities((current) => new Map(current).set(selected.key, next));
    };

    const apply = (payload: EventPayload, timestamp: string) => {
      streamedMessages = reduceMessages(streamedMessages, payload, timestamp);
      setMessages(streamedMessages);
      EventPayload.match(payload, {
        Ready: () => undefined,
        Message: () => undefined,
        TextDelta: () => undefined,
        RunActivity: () => undefined,
        RunStarted: ({ runId }) => {
          setBusy(true);
          setDirectRunId(runId);
          setError("");
        },
        RunCompleted: () => {
          setBusy(false);
          setDirectRunId(undefined);
          setQuestions([]);
          setQueuedInputs([]);
          setActivity("");
        },
        RunCancelled: () => {
          setBusy(false);
          setDirectRunId(undefined);
          setQuestions([]);
          setQueuedInputs([]);
          setActivity("");
        },
        RunFailed: ({ message }) => {
          setBusy(false);
          setDirectRunId(undefined);
          setQuestions([]);
          setQueuedInputs([]);
          setActivity("");
          setError(message);
        },
        ToolStart: () => undefined,
        ToolProgress: () => undefined,
        ToolEnd: () => undefined,
        AuthLink: ({ url, provider }) => {
          setAuthLink(url);
          setAuth((current) => (current ? { ...current, active: provider } : current));
        },
        AuthPrompt: (question) => setAuthQuestion(question),
        AuthCompleted: () => {
          setAuthLink("");
          setAuthQuestion(null);
          const version = authVersions.current.get(selected.key);
          void client
            .auth(selected.bot.id)
            .then((status) => {
              if (!controller.signal.aborted && authVersions.current.get(selected.key) === version)
                setAuth(status);
            })
            .catch((reason: Error) => {
              if (!controller.signal.aborted) reportError(reason);
            });
        },
        AuthFailed: ({ message }) => {
          setAuthLink("");
          setAuthQuestion(null);
          setError(message);
          setAuth((current) => (current ? { ...current, active: null } : current));
        },
        ApprovalRequested: ({ requestId, toolName, input }) =>
          setApprovals((current) => [
            ...current.filter((item) => item.requestId !== requestId),
            { requestId, toolName, input: toolInput(toolName, input) },
          ]),
        ApprovalResolved: ({ requestId }) =>
          setApprovals((current) => current.filter((item) => item.requestId !== requestId)),
        QuestionRequested: (question) => setQuestions((current) => [
          ...current.filter((item) => item.requestId !== question.requestId), question,
        ]),
        QuestionResolved: ({ requestId }) => setQuestions((current) => current.filter((item) => item.requestId !== requestId)),
        InputQueueChanged: ({ items }) => setQueuedInputs(items),
        PlanUpdated: ({ plan }) => setPlan(plan),
        ProcessExited: ({ message }) => {
          setBusy(false);
          setDirectRunId(undefined);
          setQuestions([]);
          setQueuedInputs([]);
          setActivity("");
          setApprovals([]);
          setAuthLink("");
          setAuthQuestion(null);
          setAuth((current) => (current ? { ...current, active: null } : current));
          setError(message);
        },
      });
    };

    const watch = async () => {
      const history = await client.messages(selected.bot.id);

      if (controller.signal.aborted) return;
      streamedMessages = history.messages;
      setMessages(streamedMessages);
      setBusy(history.busy);
      setDirectRunId(history.busy ? history.activity?.runId : undefined);
      setQuestions([]);
      setQueuedInputs([]);
      setPlan(history.plan ?? null);
      updateActivity(history.botActivity ?? history.activity ?? (history.busy ? { ...idleActivity(), phase: "thinking" } : idleActivity()));
      setActivity((history.activity?.tools ?? []).map((tool) => tool.name).join(", "));
      setApprovals([]);
      setAuthLink("");
      setAuthQuestion(null);

      for (const payload of history.pending) apply(payload, new Date().toISOString());
      const authVersion = authVersions.current.get(selected.key);
      const status = await client.auth(selected.bot.id);

      if (controller.signal.aborted) return;

      if (authVersions.current.get(selected.key) === authVersion) setAuth(status);
      setError(history.activity?.phase === "failed" ? history.activity.message ?? "The run failed." : "");
      let cursor = history.cursor;
      await client.events(selected.bot.id, cursor, controller.signal, (event: AgentEvent) => {
        if (controller.signal.aborted || event.sequence <= cursor) return;

        if (event.botId !== selected.bot.id) throw new Error("The computer sent an update for a different bot.");
        updateActivity(reduceActivity(botActivity, event.payload));

        if (!isConversationEvent(event.payload) || (event.conversationId ?? "direct") === "direct") {
          apply(event.payload, event.timestamp);
          setActivity(botActivity.tools.map((tool) => tool.name).join(", "));
        }

        cursor = event.sequence;
      }, "bot");

      if (!controller.signal.aborted) throw new Error("The connection closed. Reconnecting…");
    };

    const reconnect = () => {
      void watch().catch((reason: Error) => {
        if (controller.signal.aborted) return;
        updateActivity({ ...botActivity, phase: "reconnecting", message: reason.message });
        reportError(reason);
        reconnectTimer = setTimeout(reconnect, 3_000);
      });
    };

    reconnect();

    return () => {
      controller.abort();
      clearTimeout(reconnectTimer);
    };
  }, [selected?.key, selected?.connection.endpoint, selected?.connection.token, reportError]);

  useEffect(() => {
    const controller = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const visible = new Set(bots.map((item) => item.key));
    setBotActivities((current) => new Map([...current].filter(([key]) => visible.has(key))));

    for (const bot of bots) {
      if (bot.key === selected?.key) continue;
      const client = computerClient(bot.connection);
      let activity = idleActivity();

      const update = (next: BotActivity) => {
        if (controller.signal.aborted) return;
        activity = next;
        setBotActivities((current) => new Map(current).set(bot.key, next));
      };

      const poll = async () => {
        try {
          update(await client.activity(bot.bot.id, controller.signal));
        } catch (reason) {
          update({ ...activity, phase: "reconnecting", message: reason instanceof Error ? reason.message : "Could not read this bot's activity." });
        } finally {
          if (!controller.signal.aborted) {
            const timer = setTimeout(() => { timers.delete(timer); void poll(); }, 3_000);
            timers.add(timer);
          }
        }
      };

      void poll();
    }

    return () => {
      controller.abort();

      for (const timer of timers) clearTimeout(timer);
    };
  }, [bots, selected?.key]);

  function changeDraft(next: Draft) {
    setPreferences((current) => ({
      ...current,
      drafts: [...current.drafts.filter((item) => item.key !== next.key), next],
    }));
  }

  async function addAttachments(paths: readonly string[]) {
    if (draft.paths.length + paths.length > 12)
      throw new Error("Attach up to 12 files per message.");
    const directory = join(store.directory, "attachments");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const added: string[] = [];

    for (const path of paths) {
      const file = Bun.file(path);

      if (file.size > 15_000_000) throw new Error(`${basename(path)} is larger than 15 MB.`);

      const target = join(
        directory,
        `${crypto.randomUUID()}-${basename(path).replace(/^[a-f0-9-]{36}-/, "")}`,
      );

      await copyFile(path, target);
      added.push(target);
    }

    setPreferences((current) => {
      const latest = current.drafts.find((item) => item.key === key) ?? {
        key,
        text: "",
        paths: [],
      };

      const next = { ...latest, paths: [...latest.paths, ...added] };

      return { ...current, drafts: [...current.drafts.filter((item) => item.key !== key), next] };
    });
  }

  async function connect(endpoint: string, code: string) {
    const connection = await pairComputer(endpoint, code);
    await acceptConnection(connection);
  }

  async function acceptConnection(connection: Connection) {
    const previous = latestPreferences.current.connections.find((item) => item.id === connection.id);

    try {
      await setPreferences((current) => ({
        ...current,
        connections: [...current.connections.filter((item) => item.id !== connection.id), connection],
      }));
    } catch (error) {
      await setPreferences((current) => ({ ...current,
        connections: [...current.connections.filter((item) => item.id !== connection.id), ...(previous ? [previous] : [])],
      })).catch(() => undefined);
      throw error;
    }

    setError("");

    return async () => {
      await setPreferences((current) => {
        if (!current.connections.some((item) => item.id === connection.id && item.token === connection.token)) return current;

        return { ...current, connections: [...current.connections.filter((item) => item.id !== connection.id), ...(previous ? [previous] : [])] };
      });
    };
  }

  async function createBot(connection: Connection, name: string, color: string) {
    const bot = await computerClient(connection).createBot({
      id: crypto.randomUUID(),
      name,
      color,
    });

    const next = { bot, connection, key: `${connection.id}/${bot.id}` };
    setBots((current) => [...current, next]);
    setPreferences((current) => ({ ...current, selected: next.key }));
    setError("");
  }

  async function disconnect(connection: Connection) {
    await computerClient(connection).disconnect();
    setPreferences((current) => ({
      ...current,
      connections: current.connections.filter((item) => item.id !== connection.id),
      selected: current.selected.startsWith(`${connection.id}/`) ? "" : current.selected,
    }));
    setBots((current) => current.filter((item) => item.connection.id !== connection.id));
  }

  async function send(mode: "steer" | "followUp" = "steer") {
    if (!selected) throw new Error("Connect a computer and create a bot first.");
    const target = selected;
    const targetKey = key;
    const submitted = draft;
    const currentRunId = directRunId;

    if (
      sending.current.has(targetKey) ||
      authCancellations.current.has(targetKey) ||
      (!submitted.text.trim() && !submitted.paths.length)
    )
      return;
    sending.current.add(targetKey);

    try {
      if (!busy) {
        const status = await computerClient(target.connection).auth(target.bot.id);

        if (!isCurrent(target)) return;
        setAuth(status);

        if (status.openai !== "ready") {
          setError("");

          return "signin" as const;
        }
      }

      const attachments = await Promise.all(
        submitted.paths.map(async (path) => {
          const file = Bun.file(path);

          return {
            name: basename(path).replace(/^[a-f0-9-]{36}-/, ""),
            mimeType: file.type || "application/octet-stream",
            data: Buffer.from(await file.arrayBuffer()).toString("base64"),
          };
        }),
      );

      if (busy) {
        if (!currentRunId) throw new Error("This task changed. Wait for it to reconnect, then send your update again.");
        const signature = JSON.stringify({ runId: currentRunId, mode, text: submitted.text, paths: submitted.paths });
        const previous = queuedAttempts.current.get(targetKey);
        const id = previous?.signature === signature ? previous.id : crypto.randomUUID();
        queuedAttempts.current.set(targetKey, { signature, id });
        await computerClient(target.connection).queueInput(target.bot.id, {
          id, runId: currentRunId, mode, text: submitted.text, attachments,
        });
        queuedAttempts.current.delete(targetKey);
      } else {
        await computerClient(target.connection).send(target.bot.id, {
          text: submitted.text,
          attachments,
        });
      }

      if (isCurrent(target)) setError("");

      setPreferences((current) => ({
        ...current,
        drafts: current.drafts.map((item) =>
          item.key === targetKey
            ? {
                ...item,
                text: item.text === submitted.text ? "" : item.text,
                paths: item.paths.filter((path) => !submitted.paths.includes(path)),
              }
            : item,
        ),
      }));
    } catch (reason) {
      if (isCurrent(target)) throw reason;
    } finally {
      sending.current.delete(targetKey);
    }
  }

  async function updateBot(update: UpdateBot) {
    const target = currentSelection.current;

    if (!target) return;
    setError("");
    const changes = botChanges.current.get(target.key) ?? { confirmed: target.bot, pending: [], tail: Promise.resolve() };
    botChanges.current.set(target.key, changes);
    const mutation = { id: crypto.randomUUID(), update };
    changes.pending.push(mutation);

    const paint = () => {
      const bot = visibleBot(changes);
      setBots((current) => current.map((item) => item.key === target.key ? { ...item, bot } : item));
    };

    paint();

    const saved = changes.tail.then(async () => {
      try {
        changes.confirmed = await computerClient(target.connection).updateBot(target.bot.id, update);
      } finally {
        changes.pending = changes.pending.filter((item) => item.id !== mutation.id);
        paint();

        if (!changes.pending.length) botChanges.current.delete(target.key);
      }
    });

    changes.tail = saved.catch(() => undefined);
    await saved;
  }

  async function cancel() {
    if (selected && directRunId) await computerClient(selected.connection).cancel(selected.bot.id, "direct", directRunId);
  }

  async function signIn(provider: Provider) {
    if (!selected) throw new Error("Create a bot on a connected computer first.");
    const target = selected;

    if (authStarts.current.has(target.key) || authCancellations.current.has(target.key))
      throw new Error("A sign-in request is already in progress for this bot.");
    const version = (authVersions.current.get(target.key) ?? 0) + 1;
    authVersions.current.set(target.key, version);
    setAuthLink("");
    setAuthQuestion(null);
    const client = computerClient(target.connection);
    const start = client.startAuth(target.bot.id, provider).then(() => undefined);
    authStarts.current.set(target.key, start);

    try {
      await start;

      if (authVersions.current.get(target.key) !== version) return;
      const status = await client.auth(target.bot.id);

      if (isCurrent(target) && authVersions.current.get(target.key) === version) setAuth(status);
    } finally {
      authStarts.current.delete(target.key);
    }
  }

  const cancelAuth = useCallback(
    async (target: LinkedBot | undefined) => {
      if (!target) return;
      const existing = authCancellations.current.get(target.key);

      if (existing) return existing;
      authVersions.current.set(target.key, (authVersions.current.get(target.key) ?? 0) + 1);
      const client = computerClient(target.connection);

      const cancelPending = async () => {
        try {
          await authStarts.current.get(target.key)?.catch(() => undefined);
          const status = await client.auth(target.bot.id);

          if (status.active) await client.cancelAuth(target.bot.id);

          if (isCurrent(target)) {
            setAuthLink("");
            setAuthQuestion(null);
            setAuth({ ...status, active: null });
          }
        } finally {
          authCancellations.current.delete(target.key);
        }
      };

      const cancellation = cancelPending();
      authCancellations.current.set(target.key, cancellation);
      await cancellation;
    },
    [isCurrent],
  );

  async function answerAuth(value: string) {
    if (!selected) return;
    const target = selected;
    const question = authQuestion;
    await computerClient(target.connection).authInput(target.bot.id, value);

    if (isCurrent(target)) setAuthQuestion((current) => (current === question ? null : current));
  }

  async function answerApproval(decision: "approve" | "deny") {
    if (selected && approval)
      await computerClient(selected.connection).approve(
        selected.bot.id,
        approval.requestId,
        decision,
      );
  }

  async function answerQuestion(requestId: string, runId: string, answers: QuestionResponse["answers"]) {
    if (!selected) return;
    const target = selected;
    await computerClient(target.connection).answerQuestion(target.bot.id, requestId, { runId, answers });
  }

  function updatePreferences(update: Partial<Preferences>) {
    setPreferences((current) => ({ ...current, ...update }));
  }

  return {
    preferences,
    updatePreferences,
    bots,
    selected,
    messages,
    draft,
    changeDraft,
    error,
    setError,
    busy,
    question: questions[0],
    queuedInputs,
    plan,
    activity,
    botActivities,
    botActivity: botActivities.get(key) ?? idleActivity(),
    approval,
    auth,
    authLink,
    authQuestion,
    connect,
    acceptConnection,
    disconnect,
    createBot,
    updateBot,
    send,
    cancel,
    cancelAuth,
    signIn,
    answerAuth,
    answerApproval,
    answerQuestion,
    addAttachments,
    attempt,
    refresh,
  };
}

export type Labora = ReturnType<typeof useLabora>;
