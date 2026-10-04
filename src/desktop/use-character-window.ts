import { createContext, useContext, useEffect, useRef } from "react";
import { resolve } from "node:path";
import { Schema } from "effect";
import { allCharacters } from "./avatars";
import { CharacterWindowAction, CharacterWindowCommand } from "./character-window-contracts";

export type CharacterLauncher = (receive: (input: CharacterWindowAction) => void) => ReturnType<typeof Bun.spawn>;

export const launchCharacterWindow: CharacterLauncher = (receive) => Bun.spawn([process.execPath, ...(process.env.LABORA_PACKAGED === "1" ? ["--characters"] : [resolve(import.meta.dir, "main.tsx"), "--characters"])], { stdin: "ignore", stdout: "ignore", stderr: "inherit", ipc: (input) => receive(Schema.decodeUnknownSync(CharacterWindowAction)(input)) });

export const CharacterLauncherContext = createContext<CharacterLauncher>(launchCharacterWindow);

export function useCharacterWindow(value: string, onChange: (value: string) => void | Promise<void>) {
  const launch = useContext(CharacterLauncherContext);
  const child = useRef<ReturnType<typeof Bun.spawn> | null>(null);
  const ready = useRef(false);
  const saving = useRef(false);
  const error = useRef("");
  const current = useRef({ value, onChange });
  current.current = { value, onChange };

  const sync = () => {
    if (ready.current) child.current?.send(CharacterWindowCommand.cases.State.make({ color: current.current.value, saving: saving.current, error: error.current }));
  };

  useEffect(sync, [value]);
  useEffect(() => {
    const close = () => { child.current?.kill(); child.current = null; ready.current = false; };

    process.once("exit", close);

    return () => { process.off("exit", close); close(); };
  }, []);

  return () => {
    if (child.current) {
      if (ready.current) child.current.send(CharacterWindowCommand.cases.Activate.make({}));

      return;
    }

    const next = launch((input) => {
        const action = input;

        if (child.current !== next) return;

        if (Schema.is(CharacterWindowAction.cases.Ready)(action)) { ready.current = true; sync();

 return; }

        if (saving.current || !allCharacters.some((item) => item.color === action.color)) return;
        saving.current = true;
        error.current = "";
        sync();
        void Promise.resolve().then(() => current.current.onChange(action.color)).catch((reason: Error) => {
          error.current = reason instanceof Error ? reason.message : "Could not save this character. Try again.";
        }).finally(() => { saving.current = false; sync(); });
    });

    child.current = next;
    void next.exited.then(() => {
      if (child.current !== next) return;
      child.current = null;
      ready.current = false;
      saving.current = false;
      error.current = "";
    });
  };
}
