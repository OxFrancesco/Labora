import { render } from "@gpuix/react";
import { useEffect, useState } from "react";
import { Schema } from "effect";
import { Bubble } from "./bubble";
import { BubbleCommand, BubbleAction, type BubbleSnapshot } from "./bubble-contracts";
import { createNativeBubble } from "./native-bubble";
import { closeAvatarRenderer } from "./avatar-renderer";

const native = createNativeBubble();

function BubbleWindow() {
  const [snapshot, setSnapshot] = useState<BubbleSnapshot | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    process.on("message", (input) => {
      BubbleCommand.match(Schema.decodeUnknownSync(BubbleCommand)(input), {
        State: ({ snapshot }) => setSnapshot(snapshot),
        Visibility: ({ visible, restoreFocus }) => {
          native.visible(visible, restoreFocus);
          setVisible(visible);
        },
      });
    });
    native.prepare();
    process.send?.(BubbleAction.cases.Ready.make({}));

    return () => { process.removeAllListeners("message"); };
  }, []);

  return <Bubble snapshot={snapshot} visible={visible} dispatch={(action) => process.send?.(action)} />;
}

process.on("disconnect", () => process.exit(0));

process.once("exit", () => { closeAvatarRenderer(); native.close(); });

render(<BubbleWindow />, { title: "Labora Bubble", appName: "Labora", width: 440, height: 560, minWidth: 360, minHeight: 380, titlebarTransparent: true, windowBackground: "transparent", resizable: true, focus: false, show: false });
