import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createExecutor } from "../src/backend/executor";
import { createGitHubConnector } from "../src/backend/github-connector";
import { officialConnectors } from "../src/backend/connector-contracts";

const directory = await mkdtemp("/private/tmp/labora-official-oauth-");

const evidence = resolve("evidence", `connector-oauth-${Date.now()}`);

const results: { name: string; origin: string; pkce: boolean; authorized: boolean }[] = [];

await mkdir(evidence, { recursive: true });

try {
  for (const entry of officialConnectors) {
    if (entry.auth !== "oauth") continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    let observed = false;

    const showLink = (url: string) => {
      const parsed = new URL(url);
      assert.equal(parsed.protocol, "https:");
      assert.ok(parsed.searchParams.get("client_id"));
      assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
      assert.ok(parsed.searchParams.get("state"));
      observed = true;
      results.push({ name: entry.name, origin: parsed.origin, pkce: true, authorized: false });
      controller.abort();
    };

    const github = createGitHubConnector(directory, showLink);

    try {
      if (entry.id === "github") await github.login(controller.signal);
      else {
        const oauth = await createExecutor({
          name: entry.id, label: entry.name, url: entry.url, path: join(directory, "auth.json"), showLink,
          manualInput: (signal) => new Promise<string>((_resolve, reject) => {
            if (signal.aborted) reject(new Error("Cancelled"));
            else signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
          }),
        });

        await oauth.login(controller.signal);
      }
    } catch (error) { if (!observed) throw error; }
    finally { clearTimeout(timer); await github.close(); }

    assert.ok(observed, `${entry.name} must produce an OAuth authorization URL`);
  }

  await Bun.write(join(evidence, "result.json"), JSON.stringify({ ok: true, results, boundary: "Real official OAuth initiation with PKCE and cancellation. No personal account authorization or app actions." }, null, 2));
  console.log(evidence);
} finally { await rm(directory, { recursive: true, force: true }); }
