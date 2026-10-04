import { useEffect, useState } from "react";
import { useGpuixRequired } from "@gpuix/react";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { WorkspaceFile } from "../backend/contracts";
import type { LinkedBot } from "./use-labora";
import { computerClient } from "./client";
import { Button, Icon, Label } from "./icons";
import { color } from "./theme";

export function Library({ selected }: { selected: LinkedBot }) {
  const renderer = useGpuixRequired();

  const [listing, setListing] = useState<{ key: string; files: readonly WorkspaceFile[] } | null>(
    null,
  );

  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const loaded = listing?.key === selected.key;
  const files = loaded ? listing.files : [];

  useEffect(() => {
    let cancelled = false;
    setListing(null);
    setError("");
    void computerClient(selected.connection)
      .files(selected.bot.id)
      .then((next) => {
        if (cancelled) return;
        setListing({ key: selected.key, files: next });
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message);
      });

    return () => {
      cancelled = true;
    };
  }, [selected.key, selected.connection.endpoint, selected.connection.token, revision]);

  async function save(file: WorkspaceFile) {
    const directories = await renderer.promptForPaths?.({
      files: false,
      directories: true,
      multiple: false,
      prompt: "Save here",
    });

    const directory = directories?.[0];

    if (!directory) return;
    const bytes = await computerClient(selected.connection).file(selected.bot.id, file.path);
    await writeFile(join(directory, basename(file.name)), new Uint8Array(bytes), {
      flag: "wx",
      mode: 0o600,
    });
    setError("");
  }

  return (
    <div testId="library" style={{ display: "flex", flexDirection: "column", width: "100%", minWidth: 0, minHeight: 0, flexGrow: 1, gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button
          id="library-refresh"
          label="Refresh files"
          onClick={() => setRevision((value) => value + 1)}
        >
          <Label secondary size={12}>
            Refresh
          </Label>
        </Button>
      </div>
      {error ? (
        <Label size={12} style={{ color: color.error }}>
          {error}
        </Label>
      ) : null}
      {loaded && !files.length ? <Label secondary>No files yet</Label> : null}
      <div testId="library-files" style={{ display: "flex", flexDirection: "column", width: "100%", minWidth: 0, overflowX: "hidden", overflowY: "scroll", flexGrow: 1, minHeight: 0 }}>
        {files.map((file) => (
          <Button
            key={file.path}
            id={`file-${file.path}`}
            label={`Save ${file.path}`}
            onClick={() => {
              void save(file).catch((reason: Error) => setError(reason.message));
            }}
            style={{
              alignSelf: "stretch",
              justifyContent: "flex-start",
              alignItems: "center",
              gap: 10,
              padding: 10,
              marginBottom: 4,
            }}
          >
            <Icon name="file" size={18} />
            <div testId={`file-text-${file.path}`} style={{ display: "flex", flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, gap: 3 }}>
              <Label size={13} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{file.path}</Label>
              <Label secondary size={11} style={{ whiteSpace: "nowrap" }}>
                {`${new Intl.NumberFormat(undefined, {
                  notation: "compact",
                  maximumFractionDigits: 1,
                }).format(file.size)} bytes`}
              </Label>
            </div>
          </Button>
        ))}
      </div>
    </div>
  );
}
