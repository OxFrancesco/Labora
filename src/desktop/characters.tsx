import { useState } from "react";
import { characters } from "./avatars";
import { Avatar, Button, Label } from "./icons";
import { useCharacterWindow } from "./use-character-window";
import { color } from "./theme";

interface CharacterPickerProps {
  value: string;
  onChange: (value: string) => void | Promise<void>;
  idPrefix: string;
}

export function CharacterPicker({ value, onChange, idPrefix }: CharacterPickerProps) {
  const [error, setError] = useState("");
  const open = useCharacterWindow(value, onChange);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 4 }}>
      {characters.map((character) => (
        <Button
          key={character.color}
          id={`${idPrefix}-${character.color}`}
          label={`Choose ${character.name}, ${character.material}`}
          active={value === character.color}
          onClick={() => { setError(""); void Promise.resolve().then(() => onChange(character.color)).catch((reason: Error) => setError(reason instanceof Error ? reason.message : "Could not save character.")); }}
          style={{
            width: 38,
            height: 46,
            padding: 1,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: value === character.color ? color.secondary : "transparent",
          }}
        >
          <Avatar tint={character.color} size={36} />
        </Button>
      ))}
      <Button id={`${idPrefix}-more`} label="More characters" icon="plus" onClick={open} style={{ width: 30, height: 46, padding: 5 }} />
      {error ? <Label size={12} style={{ color: color.error }}>{error}</Label> : null}
    </div>
  );
}
