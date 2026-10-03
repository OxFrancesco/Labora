import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { App, ElementBounds } from "@gpuix/react/automation";
import type { Schema } from "effect";
import type { computerClient } from "../src/desktop/client";
import { EventPayload } from "../src/backend/contracts";
import { RoutineSchedule } from "../src/backend/routine-contracts";

interface Generation {
  input: string;
  text(delta: string): void;
  finish(): void;
  tool(name: string, input: Schema.Schema.Type<typeof Schema.Json>): void;
  fail(): void;
}

export async function verifyLayout({ app, client, send, capture, evidenceDirectory, checks, pending, generation, complete }: {
  app: App;
  client: ReturnType<typeof computerClient>;
  send: (text: string) => Promise<Generation>;
  capture: (name: string) => Promise<void>;
  evidenceDirectory: string;
  checks: string[];
  pending: () => Promise<Generation>;
  generation: (request: Promise<Generation>) => Promise<Generation>;
  complete: (model: Generation, text: string) => Promise<void>;
}) {
  const { pid } = await app.call("initialize", { protocolVersion: 1, client: "labora-layout" });
  const measurements: unknown[] = [];
  let width = 1224;
  let height = 768;

  async function resize(w: number, h: number) {
    const command = Bun.spawn(["/usr/bin/osascript", "-e", `tell application "System Events" to tell (first application process whose unix id is ${pid}) to set size of window 1 to {${w}, ${h}}`], { stdout: "pipe", stderr: "pipe" });
    const error = await new Response(command.stderr).text();
    assert.equal(await command.exited, 0, error);
    width = w;
    height = h;
    const deadline = Date.now() + 8000;

    for (;;) {
      await app.screenshot({ path: join(evidenceDirectory, "resize.png") });
      const bounds = await app.getByTestId("app-layout").bounds();

      if (Math.abs(bounds.width - width) < 1 && Math.abs(bounds.height - height) < 1) break;
      assert.ok(Date.now() < deadline, `Window did not reach ${width}x${height}: ${JSON.stringify(bounds)}`);
      await Bun.sleep(200);
    }

    await Bun.sleep(300);
  }

  // GPUix 0.10.0 offsets padded div bounds horizontally by their left inset.
  async function box(id: string, inset = 0) {
    const bounds = await app.getByTestId(id).bounds();

    return { ...bounds, x: bounds.x - inset };
  }

  function inside(child: ElementBounds, parent: ElementBounds, label: string) {
    assert.ok(child.x >= parent.x - 1 && child.x + child.width <= parent.x + parent.width + 1, `${label} overflows horizontally: ${JSON.stringify({ child, parent })}`);
  }

  async function measure(name: string) {
    await capture(name);
    const body = await app.getByTestId("conversation-body").bounds();
    const row = await app.getByTestId("composer-row").bounds();
    const title = await app.getByTestId("conversation-title").bounds();
    const toggle = await app.getByTestId("details-toggle").bounds();
    await writeFile(join(evidenceDirectory, `${name}-geometry.json`), JSON.stringify({width,height,body,row,title,toggle}, null, 2));
    assert.ok(title.x + title.width + 8 <= toggle.x, `Conversation title overlaps details toggle: ${JSON.stringify({title,toggle})}`);
    assert.ok(body.height >= 100, `Transcript lost its reading space: ${body.height}`);
    assert.ok(body.y + body.height <= row.y + 1, `Transcript overlaps composer: ${JSON.stringify({body, row})}`);
    assert.ok(row.y + row.height <= height + 1, `Composer overflows window bottom: ${JSON.stringify({row,height})}`);
    inside(row, { x: 0, y: 0, width, height }, "Composer");
    let lastRight = row.x - 5;

    for (const id of ["composer-actions", "composer", "voice-start", "cancel", "send"]) {
      if (!await app.getByTestId(id).count()) continue;
      const bounds = await app.getByTestId(id).bounds();
      inside(bounds, row, id);
      assert.ok(bounds.x >= lastRight + 5, `${id} overlaps the preceding control`);
      lastRight = bounds.x + bounds.width;
    }

    const tree = await app.call("getTree", {});
    await writeFile(join(evidenceDirectory, `${name}-tree.json`), JSON.stringify(tree, null, 2));
    measurements.push({ name, width, height, body, row, title, toggle });
    await capture(name);
  }

  const longName = "Research assistant for the quarterly product and engineering review";
  await app.getByTestId("edit-bot-name").click();
  await app.getByTestId("edit-bot-value").fill(longName);
  await app.getByTestId("edit-bot-value").press("enter");
  await app.getByTestId("sidebar-toggle").click();
  await resize(800, 540);
  await measure("layout-800-attachments");
  const context = await app.getByTestId("composer-context").bounds();
  inside(await box("attachment-0", 6), context, "Long attachment");
  await app.getByTestId("remove-attachment-0").click();
  checks.push("Long attachment names fit their chips and the remove control works in the minimum window");

  const asking = await send("Ask for a format and include a detailed choice.");
  asking.tool("ask_user", { questions: [{ id: "format", question: "Which format should I use for the product and engineering review?", options: ["A short summary with the next actions", "A detailed explanation covering the investigation, evidence, remaining questions and suggested changes"] }] });
  await app.getByTestId("agent-question").waitFor();
  await measure("layout-800-question");
  const question = await box("agent-question", 14);

  for (const id of ["question-option-0-0", "question-option-0-1", "question-answer-0", "submit-question", "skip-question"]) inside(await box(id, id.startsWith("question-option") ? 11 : id.startsWith("question-answer") ? 10 : 6), question, id);
  await app.getByTestId("question-option-0-0").click();
  const answer = pending();
  await app.getByTestId("submit-question").click();
  const afterAnswer = await generation(answer);
  const plan = pending();
  afterAnswer.tool("update_plan", { steps: [
    { text: "Review the long question, selected answer, attachments and supporting documentation", status: "completed" },
    { text: "Check that the remaining controls stay reachable when the window is resized", status: "in_progress" },
  ] });
  await app.getByTestId("agent-plan").waitFor();
  await capture("layout-800-plan");
  const planLabels = await app.getByTestId("agent-plan").getByType("text").all();

  const steps = planLabels.filter((label) => (label.text?.length ?? 0) > 10);
  assert.equal(steps.length, 2, "Both plan steps must be rendered");

  for (const label of steps) assert.ok((label.bounds?.width ?? 0) > 150, "Plan text must retain a readable line width");
  assert.ok(steps[0]?.bounds && steps[1]?.bounds && steps[0].bounds.y + steps[0].bounds.height <= steps[1].bounds.y, "Plan steps must not overlap");
  checks.push("Long plan steps retain a readable line width at the minimum window size");
  await complete(await generation(plan), "The selected format was received.\n\n" + "A long paragraph should wrap within the conversation without reaching the side panel. ".repeat(10) + "\n\nhttps://example.test/" + "long-path-segment".repeat(24) + "\n\n```text\n" + "long_terminal_output_".repeat(28) + "\n```");
  await measure("layout-800-long-message");
  checks.push("Minimum 800x540 window preserves title, transcript and composer spacing; long question choices fit and remain clickable");

  const active = await send("Keep working while I queue updates.");
  active.text("Working on the layout verification.");

  for (let index = 0; index < 3; index++) {
    await app.getByTestId("composer").fill(`Update ${index + 1}: ` + "Include the results and evidence in the final review. ".repeat(4));
    await app.getByTestId("send").click();
    const deadline = Date.now() + 5000;

    while ((await client.messages("controls")).pending.find(EventPayload.isAnyOf(["InputQueueChanged"]))?.items.length !== index + 1) {
      assert.ok(Date.now() < deadline, "The queue did not accept the update");
      await Bun.sleep(50);
    }
  }

  await app.getByTestId("composer").fill("An unsent multiline draft.\n".repeat(14));
  await measure("layout-800-queue-draft");
  await app.getByTestId("queued-inputs").wheel(0, -500);
  await measure("layout-800-queue-scrolled");
  await app.getByTestId("input-mode-follow-up").click();
  await app.getByTestId("cancel").click();
  await app.getByTestId("composer").fill("");
  checks.push("Queued updates and a long draft keep the transcript, Stop, and Send within the minimum window");

  await resize(1000, 650);
  await measure("layout-1000-expanded-sidebar");
  await resize(1224, 768);
  await measure("layout-1224-expanded-sidebar");
  await app.mouse.drag(app.getByTestId("details-divider"), { x: 680, y: 350 });
  await measure("layout-1224-wide-details");
  await app.getByTestId("details-close").click();
  await resize(800, 540);
  await measure("layout-800-expanded-sidebar");
  await app.getByTestId("details-toggle").click();

  const routine = await client.createRoutine({ botId: "controls", name: longName, prompt: "Ask about the review format.", schedule: RoutineSchedule.cases.Once.make({ at: new Date(Date.now() + 86_400_000).toISOString() }) });
  await app.getByTestId(`routine-${routine.id}`).waitFor({ timeoutMs: 15_000 });
  await app.getByTestId(`routine-${routine.id}`).click();
  await app.getByTestId("routine-run").waitFor();
  await capture("layout-800-routine-ready");
  const started = pending();
  await app.getByTestId("routine-run").click();
  const model = await generation(started);
  model.tool("ask_user", { questions: [{ id: "routine-format", question: "Which results should I include in the scheduled review?", options: ["All completed tasks and their supporting evidence", "Only the next actions"] }] });
  await app.getByTestId("routine-results").waitFor();
  await app.getByTestId("routine-results").click();
  await app.getByTestId("agent-question").waitFor();
  await app.getByTestId("agent-question").wheel(0, -220);
  await measure("layout-800-routine-question");
  const routineQuestion = await box("agent-question", 14);
  inside(routineQuestion, await app.getByTestId("details-content").bounds(), "Routine question");

  for (const id of ["question-option-0-0", "question-option-0-1", "question-answer-0", "submit-question", "skip-question"]) inside(await box(id, id.startsWith("question-option") ? 11 : id.startsWith("question-answer") ? 10 : 6), routineQuestion, id);
  const continued = pending();
  await app.getByTestId("question-option-0-1").click();
  await app.getByTestId("submit-question").click();
  const result = await generation(continued);
  assert.ok(result.input.includes("Only the next actions"));
  result.text("The routine answer was received.");
  result.finish();
  await Bun.sleep(1200);
  checks.push("Routine question choices and answers work in the narrow details panel with a long routine title");

  await app.getByTestId("sidebar-new").click();

  for (const character of ["spark", "cube", "pyramid", "star", "hexagon", "pebble"]) await app.getByTestId(`avatar3d-ready-${character}-36`).waitFor({ timeoutMs: 30_000 });
  await measure("layout-800-create-dialog");
  await app.getByTestId("sheet-close").click();
  await app.getByTestId("sidebar-home").click();
  await measure("layout-800-settings");
  await writeFile(join(evidenceDirectory, "layout-measurements.json"), JSON.stringify(measurements, null, 2));
  checks.push("Native screenshots and geometry cover 800x540, 1000x650, and 1224x768, expanded sidebar, resized details, creation dialog and settings");
}
