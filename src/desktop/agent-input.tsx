import { useRef, useState } from "react";
import { Match } from "effect";
import type { EventPayload, QuestionResponse, QueuedInput } from "../backend/contracts";
import type { PlanState } from "../backend/plan-contracts";
import { Button, Label } from "./icons";
import { color, font } from "./theme";

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

  const change = (id: string, value: string) => setAnswers((current) => new Map(current).set(id, value));

  async function submit(skip = false) {
    if (pending.current) return;
    const values = question.questions.map((item) => ({ id: item.id, answer: answers.get(item.id)?.trim() ?? "" }));

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

  return <div testId="agent-question" style={{ display: "flex", flexDirection: "column", flexShrink: 0, minWidth: 0, gap: 16, padding: 14, marginTop: 12, borderRadius: 14, backgroundColor: color.surface }}>
    {question.questions.map((item, index) => <div key={item.id} style={{ display: "flex", flexDirection: "column", flexShrink: 0, minWidth: 0, gap: 8 }}>
      <Label>{item.question}</Label>
      {item.options?.length ? <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {item.options.map((option, optionIndex) => <Button key={option} id={`question-option-${index}-${optionIndex}`} label={option} active={answers.get(item.id) === option} onClick={() => { if (!pending.current) change(item.id, option); }} style={{ paddingLeft: 10, paddingRight: 10, borderWidth: 1, borderColor: answers.get(item.id) === option ? color.secondary : "#424242" }}><Label size={13}>{option}</Label></Button>)}
      </div> : null}
      <textarea testId={`question-answer-${index}`} aria-label={item.question} value={answers.get(item.id) ?? ""} placeholder={item.options?.length ? "Choose above or write your answer" : "Your answer"} minRows={1} maxRows={4} onChange={(event) => { if (!pending.current) change(item.id, event.value ?? ""); }} onSubmit={() => { void submit(); }} style={{ padding: 10, borderRadius: 8, fontFamily: font, fontSize: 14, color: color.text, backgroundColor: "#111111" }} />
    </div>)}
    {error ? <Label size={13} style={{ color: color.error }}>{error}</Label> : null}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      <Button id="submit-question" label="Send answers" onClick={() => { void submit(); }} style={{ backgroundColor: color.composer }}><Label>{submitting ? "Sending…" : "Send answers"}</Label></Button>
      <Button id="skip-question" label="Skip questions" onClick={() => { void submit(true); }}><Label secondary>Skip</Label></Button>
    </div>
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
  return <div testId="agent-plan" role="list" aria-label="Task plan" style={{ width: "100%", display: "flex", flexDirection: "column", flexShrink: 0, gap: 7, paddingTop: 12, paddingBottom: 12 }}>
    {plan.steps.map((step, index) => <div key={`${index}-${step.text}`} role="listitem" aria-label={`${step.text}, ${step.status.replaceAll("_", " ")}`} style={{ width: "100%", display: "flex", gap: 8, alignItems: "flex-start", flexShrink: 0 }}>
      <Label size={13} secondary={step.status !== "in_progress"}>{Match.value(step.status).pipe(Match.when("completed", () => "✓"), Match.when("in_progress", () => "→"), Match.when("pending", () => "○"), Match.exhaustive)}</Label>
      <Label size={13} secondary={step.status !== "in_progress"} style={{ flexShrink: 1, minWidth: 0 }}>{step.text}</Label>
    </div>)}
    {plan.explanation ? <Label size={12} secondary>{plan.explanation}</Label> : null}
  </div>;
}
