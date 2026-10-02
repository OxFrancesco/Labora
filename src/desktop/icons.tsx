import type { ReactNode } from "react";
import type { StyleDesc } from "@gpuix/react";
import { color, font } from "./theme";
import { characterForColor, characterModel } from "./avatars";
import { Avatar3D } from "./avatar-3d";

const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  details: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  apps: '<path d="M4 9V4h16v5M5 13v7h14v-7M3 9h18l-2 5-4-1-3 1-3-1-4 1z"/>',
  share: '<path d="M8 4 12 1l4 3M12 2v12M5 10H3v11h18V10h-2"/>',
  send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-3 0h6"/>',
  voice: '<path d="M4 9v6M8 5v14M12 2v20M16 6v12M20 9v6"/>',
  file: '<path d="M5 3h9l5 5v13H5zM14 3v6h5"/>',
  computer: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4m-5 0h10"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  settings:
    '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="#111"/><circle cx="16" cy="12" r="2" fill="#111"/><circle cx="10" cy="18" r="2" fill="#111"/>',
  back: '<path d="m14 5-7 7 7 7"/>',
};

export type IconName = keyof typeof paths;

interface IconProps {
  name: IconName;
  size?: number;
  tint?: string;
}

export function Icon({ name, size = 20, tint = color.secondary }: IconProps) {
  return (
    <svg
      source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`}
      style={{ width: size, height: size, color: tint, flexShrink: 0 }}
    />
  );
}

interface AvatarProps {
  tint: string;
  size?: number;
  onClick?: () => void;
}

export function Avatar({ tint, size = 40, onClick }: AvatarProps) {
  const character = characterForColor(tint);

  return (
    <Avatar3D
      key={character.file}
      modelPath={characterModel(tint)}
      name={`${character.name}, ${character.material}`}
      size={size}
      interactive={size >= 72}
      onClick={onClick}
    />
  );
}

interface ButtonProps {
  label: string;
  id: string;
  icon?: IconName;
  children?: ReactNode;
  onClick: () => void;
  active?: boolean;
  style?: StyleDesc;
}

export function Button({ label, id, icon, children, onClick, active = false, style }: ButtonProps) {
  return (
    <div
      role="button"
      aria-label={label}
      testId={id}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "enter" || event.key === "space") onClick();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 30,
        padding: 6,
        borderRadius: 8,
        cursor: "pointer",
        backgroundColor: active ? color.selected : "transparent",
        hover: { backgroundColor: color.selected },
        ...style,
      }}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </div>
  );
}

interface LabelProps {
  children: ReactNode;
  secondary?: boolean;
  size?: number;
  style?: StyleDesc;
}

export function Label({ children, secondary = false, size = 14, style }: LabelProps) {
  return (
    <text
      style={{
        color: secondary ? color.secondary : color.text,
        fontFamily: font,
        fontSize: size,
        lineHeight: size * 1.5,
        ...style,
      }}
    >
      {children}
    </text>
  );
}
