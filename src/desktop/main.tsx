import { render } from "@gpuix/react";
import { App } from "./app";
import { createDesktopStore } from "./store";
import { closeAvatarRenderer } from "./avatar-renderer";
import { installNativeCaptureCleanup } from "./native-capture";

installNativeCaptureCleanup();

process.once("exit", closeAvatarRenderer);

const store = await createDesktopStore();

process.once("exit", () => store.flush());

render(<App store={store} />, {
  title: "Labora",
  appName: "Labora",
  width: 1224,
  height: 768,
  minWidth: 800,
  minHeight: 540,
  titlebarTransparent: true,
  trafficLightX: 18,
  trafficLightY: 18,
  windowBackground: "opaque",
  resizable: true,
});
