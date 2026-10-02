import { useState } from "react";
import type { Labora } from "./use-labora";
import { Avatar, Button, Label } from "./icons";
import { color, font } from "./theme";
import { CharacterPicker } from "./characters";

export function BotProfile({ labora }: { labora: Labora }) {
  const bot = labora.selected?.bot;
  const [editing, setEditing] = useState<"none" | "name" | "label" | "color">("none");
  const [value, setValue] = useState("");

  if (!bot) return null;

  async function save() {
    if (editing === "name" && value.trim()) await labora.updateBot({ name: value.trim() });

    if (editing === "label") await labora.updateBot({ label: value.trim() });
    setEditing("none");
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        paddingTop: 10,
        paddingBottom: 20,
      }}
    >
      <Button
        id="edit-bot-color"
        label="Change character"
        onClick={() => setEditing(editing === "color" ? "none" : "color")}
        style={{ width: 88, height: 88 }}
      >
        <Avatar tint={bot.color} size={80} onClick={() => setEditing(editing === "color" ? "none" : "color")} />
      </Button>
      {editing === "color" ? (
        <CharacterPicker
          value={bot.color}
          idPrefix="edit-color"
          onChange={(value) =>
            labora.attempt(labora.updateBot({ color: value }).then(() => setEditing("none")))
          }
        />
      ) : null}
      {editing === "name" || editing === "label" ? (
        <input
          autoFocus
          testId="edit-bot-value"
          value={value}
          onChange={(event) => setValue(event.value ?? "")}
          onSubmit={() => labora.attempt(save())}
          onBlur={() => labora.attempt(save())}
          onKeyDown={(event) => {
            if (event.key === "escape") setEditing("none");
          }}
          style={{
            width: "100%",
            padding: 8,
            backgroundColor: color.surface,
            color: color.text,
            fontFamily: font,
            fontSize: 15,
          }}
        />
      ) : (
        <>
          <Button
            id="edit-bot-name"
            label="Edit bot name"
            onClick={() => {
              setValue(bot.name);
              setEditing("name");
            }}
            style={{ minHeight: 26 }}
          >
            <Label size={18}>{bot.name}</Label>
          </Button>
          <Button
            id="edit-bot-label"
            label="Edit bot label"
            onClick={() => {
              setValue(bot.label ?? "");
              setEditing("label");
            }}
            style={{ minHeight: 24 }}
          >
            <Label size={12} secondary>
              {bot.label || "Add a label"}
            </Label>
          </Button>
        </>
      )}
    </div>
  );
}
