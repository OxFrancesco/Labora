import { Schema, Result } from "effect";

type Json = Schema.Schema.Type<typeof Schema.Json>;

const record = (value: Json | undefined) => {
  const decoded = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Json))(value);

  return Result.isSuccess(decoded) ? decoded.success : {};
};

const textField = (value: Json | undefined) => Schema.is(Schema.String)(value) ? value : "";

export function toolTitle(name: string): string {
  return ({ bash: "Terminal", read: "Read file", write: "Write file", edit: "Edit file", codemode: "Run tools", computer_actions: "Control computer", computer_capture: "Screenshot", computer_info: "Computer", browser_read: "Read web page", ask_user: "Question", update_plan: "Plan" })[name] ?? name.replace(/^mcp__executor__/, "").replaceAll("_", " ");
}

export function toolInput(name: string, input: Json | undefined): string {
  const data = record(input);

  if (name === "bash") return textField(data.command);

  if (["read", "write", "edit"].includes(name)) return textField(data.path);

  if (name === "browser_read") return textField(data.url);

  if (name === "codemode") return textField(data.code) || textField(data.script);

  if (name === "computer_actions" && Schema.is(Schema.String)(data.request)) {
    const parsed = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))(data.request);

    if (Result.isSuccess(parsed)) return describeFields(parsed.success);
  }

  return describeFields(input);
}

function describeFields(input: Json | undefined, depth = 0): string {
  if (depth > 3) return "";

  if (Schema.is(Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))(input)) return String(input).slice(0, 2000);

  if (Array.isArray(input)) return input.slice(0, 20).map((item, index) => `${index + 1}. ${describeFields(item, depth + 1)}`).join("\n");

  return Object.entries(record(input)).flatMap(([key, value]) => {
    if (/token|secret|password|^data$/i.test(key)) return [];
    const text = describeFields(value, depth + 1);

    return text ? [`${key.replaceAll("_", " ")}: ${text}`] : [];
  }).join("\n");
}

export function readableToolText(text: string): string {
  const trimmed = text.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;

  try {
    const value: Json = JSON.parse(trimmed);
    const data = record(value);

    return ["text", "markdown", "message", "output", "error"].flatMap((key) => Schema.is(Schema.String)(data[key]) ? [data[key]] : []).join("\n") || "";
  } catch { return ""; }
}

export function toolOutput(output: Json): string {
  const content = record(output).content;

  if (!Array.isArray(content)) return readableToolText(textField(output));

  return content.flatMap((part) => {
    const data = record(part);

    if (data.type === "text") return [readableToolText(textField(data.text))];

    if (data.type === "image") return ["Image captured"];

    return [];
  }).filter(Boolean).join("\n");
}
