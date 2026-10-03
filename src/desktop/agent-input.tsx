import { useEffect, useRef, useState } from "react";
import { ActivityIcon } from "./tool-message";
import { DisclosureArrow } from "./activity-motion";
import type { EventPayload, QuestionResponse, QueuedInput } from "../backend/contracts";
import type { PlanState } from "../backend/plan-contracts";
import { Button, Label } from "./icons";
import { color, font } from "./theme";

const planColors = { completed: "#79b88c", in_progress: "#b6a4db", pending: "#92929240" };

const planSymbols = { completed: "✓", in_progress: "◉", pending: "○" };

type PendingQuestion = Extract<EventPayload, { _tag: "QuestionRequested" }>;

interface AgentQuestionProps {
  question: PendingQuestion;
  answer: (requestId: string, runId: string, answers: QuestionResponse["answers"]) => Promise<void>;
}

export function AgentQuestion({ question, answer }: AgentQuestionProps) {
  const [answers, setAnswers] = useState(new Map<string, string>());
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const advanceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const currentAnswers = useRef(answers);
  currentAnswers.current = answers;
  useEffect(() => () => clearTimeout(advanceTimer.current), []);

  const change = (id: string, value: string) => setAnswers((current) => new Map(current).set(id, value));

  async function submit(skip = false) {
    if (pending.current) return;
    const values = question.questions.map((item) => ({ id: item.id, answer: currentAnswers.current.get(item.id)?.trim() ?? "" }));

    if (!skip && values.some((value) => !value.answer)) {
      setError("Answer each question, or skip them.");

      return;
    }

    pending.current = true;
    setSubmitting(true);
    setError("");

    try {
      await answer(question.requestId, question.runId, skip ? null : values);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send your answer.");
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  const item = question.questions[index]!;

  const advance = () => {
    if (!currentAnswers.current.get(item.id)?.trim()) return;

    if (index < question.questions.length - 1) { setIndex(index + 1); setCollapsed(false); }
    else void submit();
  };

  const choose = (option: string) => {
    if (pending.current) return;
    currentAnswers.current = new Map(currentAnswers.current).set(item.id, option);
    setAnswers(currentAnswers.current);
    clearTimeout(advanceTimer.current);
    advanceTimer.current = setTimeout(advance, 200);
  };

  return <div testId="agent-question" style={{ display: "flex", flexDirection: "column", flexShrink: 0, minWidth: 0, maxHeight: 300, borderRadius: 12, backgroundColor: "#ffffff06", padding: 8 }}>
    <div testId="question-toggle" role="button" aria-label={collapsed ? "Show question" : "Hide question"} aria-expanded={!collapsed} tabIndex={0} onClick={() => setCollapsed(!collapsed)} onKeyDown={(event) => { if (event.key === "enter" || event.key === "space") setCollapsed(!collapsed); }} style={{ display: "flex", alignItems: "center", minHeight: 24, gap: 8, cursor: "pointer" }}>
      <Label secondary size={12} style={{ flexGrow: 1, minWidth: 0, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{collapsed ? item.question : "Question"}</Label>
      {question.questions.length > 1 ? <Label secondary size={11}>{`${index + 1}/${question.questions.length}`}</Label> : null}
      <DisclosureArrow expanded={!collapsed} />
      <Button id="skip-question" label="Skip questions" icon="close" onClick={() => { void submit(true); }} style={{ width: 20, minHeight: 20, padding: 2 }} />
    </div>
    {!collapsed ? <div style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, overflowY: "scroll", gap: 8, paddingLeft: 24, paddingTop: 4 }}>
      <Label size={14}>{item.question}</Label>
      {item.options?.length ? <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {item.options.map((option, optionIndex) => <div key={option} testId={`question-option-${index}-${optionIndex}`} role="button" aria-label={option} tabIndex={0} onClick={() => choose(option)} onKeyDown={(event) => { if (event.key === "enter" || event.key === "space" || event.key === String(optionIndex + 1)) choose(option); }} style={{ display: "flex", alignItems: "center", minWidth: 0, gap: 8, paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 8, borderRadius: 6, cursor: "pointer", backgroundColor: answers.get(item.id) === option ? color.surface : "transparent", hover: { backgroundColor: "#ffffff0c" } }}>
          <Label size={14} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{option}</Label>
          <Label size={11} secondary>{answers.get(item.id) === option ? "✓" : String(optionIndex + 1)}</Label>
        </div>)}
      </div> : null}
      <textarea testId={`question-answer-${index}`} aria-label={item.question} value={answers.get(item.id) ?? ""} placeholder={item.options?.length ? "Or write your answer…" : "Your answer…"} minRows={1} maxRows={3} onChange={(event) => { if (!pending.current) { clearTimeout(advanceTimer.current); change(item.id, event.value ?? ""); } }} onSubmit={advance} style={{ padding: 8, borderRadius: 6, fontFamily: font, fontSize: 14, color: color.text, backgroundColor: "#ffffff06" }} />
      {error ? <Label size={12} style={{ color: color.error }}>{error}</Label> : null}
      <Button id="submit-question" label="Send answers" onClick={advance} style={{ alignSelf: "flex-end", paddingLeft: 10, paddingRight: 10 }}><Label size={12}>{submitting ? "Sending…" : index < question.questions.length - 1 ? "Next" : "Send answer"}</Label></Button>
    </div> : null}
  </div>;
}

export function QueuedInputs({ items }: { items: readonly QueuedInput[] }) {
  if (!items.length) return null;

  return <div testId="queued-inputs" style={{ display: "flex", flexDirection: "column", flexShrink: 0, gap: 10, maxHeight: 150, overflowY: "scroll", padding: 10 }}>
    {items.map((item) => <div key={item.id} testId={`queued-input-${item.id}`} style={{ display: "flex", flexDirection: "column", flexShrink: 0, gap: 3 }}>
      <Label size={12} secondary>{item.mode === "steer" ? "After the current step" : "After this task"}</Label>
      {item.text ? <Label size={13}>{item.text}</Label> : null}
      {item.attachments?.map((attachment, index) => <Label key={`${index}-${attachment.name}`} size={12} secondary>{attachment.name}</Label>)}
    </div>)}
  </div>;
}

export function AgentPlan({ plan }: { plan: PlanState }) {
  const [expanded, setExpanded] = useState(false);
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const current = plan.steps.find((step) => step.status === "in_progress") ?? plan.steps.find((step) => step.status === "pending") ?? plan.steps.at(-1);

  if (!current) return null;

  return <div testId="agent-plan" style={{ width: "100%", minWidth: 0, display: "flex", flexDirection: "column", flexShrink: 0, borderRadius: 12, backgroundColor: "#ffffff06", padding: 4 }}>
    <div testId="task-plan-toggle" role="button" aria-label={`Tasks: ${completed} of ${plan.steps.length} complete. ${current.text}`} aria-expanded={expanded} tabIndex={0} onClick={() => setExpanded(!expanded)} onKeyDown={(event) => { if (event.key === "enter" || event.key === "space") setExpanded(!expanded); }} style={{ minWidth: 0, width: "100%", minHeight: 28, display: "flex", alignItems: "center", gap: 8, padding: 4, cursor: "pointer", borderRadius: 6, hover: { backgroundColor: "#ffffff08" } }}>
      <ActivityIcon name="tasks" />
      <Label secondary size={12}>Tasks</Label>
      <Label size={12} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{current.text}</Label>
      <Label secondary size={12}>{`${completed}/${plan.steps.length}`}</Label>
      {plan.steps.length > 1 && plan.steps.length <= 10 ? <div style={{ width: 40, display: "flex", gap: 2, flexShrink: 0 }}>{plan.steps.map((step, index) => <div key={index} style={{ height: 3, flexGrow: 1, borderRadius: 2, backgroundColor: planColors[step.status] }} />)}</div> : null}
      <DisclosureArrow expanded={expanded} />
    </div>
    {expanded ? <div testId="task-plan-steps" role="list" aria-label="Task plan" style={{ width: "100%", maxHeight: 200, overflowY: "scroll", paddingLeft: 8, paddingRight: 8, paddingBottom: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      {plan.steps.map((step, index) => <div key={`${index}-${step.text}`} role="listitem" aria-label={`${step.text}, ${step.status.replaceAll("_", " ")}`} style={{ display: "flex", gap: 8, minWidth: 0, flexShrink: 0 }}>
        <Label size={12} style={{ color: planColors[step.status] }}>{planSymbols[step.status]}</Label>
        <Label size={12} secondary={step.status !== "in_progress"} style={{ flexShrink: 1, minWidth: 0 }}>{step.text}</Label>
      </div>)}
      {plan.explanation ? <Label size={12} secondary>{plan.explanation}</Label> : null}
    </div> : null}
  </div>;
}
