import { Schema } from "effect";
import { CharacterWindowAction } from "../src/desktop/character-window-contracts";
import { render } from "@gpuix/react";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { App } from "../src/desktop/app";
import { createDesktopStore } from "../src/desktop/store";
import { CharacterLauncherContext } from "../src/desktop/use-character-window";

const store = await createDesktopStore();

process.once("exit", () => store.flush());

render(<CharacterLauncherContext.Provider value={(receive) => {
  const executable = process.env.LABORA_GALLERY_EXECUTABLE;
  const child = Bun.spawn(executable ? [executable, "--characters"] : [process.execPath, resolve("src/desktop/main.tsx"), "--characters"], { stdin: "pipe", stdout: "pipe", stderr: "inherit", ipc: (input) => receive(Schema.decodeUnknownSync(CharacterWindowAction)(input)) });

  const socket = createServer((client) => {
    client.on("data", (chunk) => child.stdin.write(chunk));
    void (async () => { for await (const chunk of child.stdout) client.write(chunk); })();
  });

  socket.listen(process.env.LABORA_GALLERY_SOCKET);
  void child.exited.then(() => socket.close());

  return child;
}}><App store={store} /></CharacterLauncherContext.Provider>, { title: "Labora verification", width: 1224, height: 768, minWidth: 800, minHeight: 540, titlebarTransparent: true, windowBackground: "opaque" });
