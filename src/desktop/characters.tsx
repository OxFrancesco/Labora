import { characters } from "./avatars";
import { Avatar, Button } from "./icons";
import { color } from "./theme";

interface CharacterPickerProps {
  value: string;
  onChange: (value: (typeof characters)[number]["color"]) => void;
  idPrefix: string;
}

export function CharacterPicker({ value, onChange, idPrefix }: CharacterPickerProps) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 6 }}>
      {characters.map((character) => (
        <Button
          key={character.color}
          id={`${idPrefix}-${character.color}`}
          label={`Choose ${character.name}, ${character.material}`}
          active={value === character.color}
          onClick={() => onChange(character.color)}
          style={{
            width: 42,
            height: 46,
            padding: 3,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: value === character.color ? color.secondary : "transparent",
          }}
        >
          <Avatar tint={character.color} size={36} />
        </Button>
      ))}
    </div>
  );
}
