import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

const CheckResponse = Schema.Struct({
  structuredContent: Schema.Struct({
    status: Schema.Literal("completed"),
    result: Schema.Struct({
      path: Schema.String,
      resultCount: Schema.Number.check(Schema.isGreaterThan(0)),
      results: Schema.Array(Schema.Struct({ title: Schema.String, url: Schema.String })),
    }),
  }),
});

export async function checkExecutor(session: AgentSession) {
  const tool = session.agent.state.tools.find(({ name }) => name === "mcp__executor__execute");

  if (!tool) throw new Error("Executor's execute tool is unavailable.");

  const result = await tool.execute(
    crypto.randomUUID(),
    {
      code: `
    const matches = await tools.search({ namespace: "cloudflare_docs", query: "search documentation", limit: 12 });
    const match = matches.items.find(({ path }) => path.endsWith(".search_cloudflare_documentation"));
    if (!match) throw new Error("Add the Cloudflare Docs integration and a connection in Executor first.");
    const response = await tools[match.path]({ query: "Cloudflare Sandbox SDK run Pi coding agent" });
    if (!response.ok) throw new Error(response.error.message);
    if (response.data.isError) throw new Error("Cloudflare documentation returned an MCP error.");
    const results = response.data.structuredContent?.results;
    if (!results?.length) throw new Error("Cloudflare documentation returned no results.");
    return { path: match.path, resultCount: results.length, results: results.slice(0, 3).map(({ title, url }) => ({ title, url })) };
  `,
    },
    AbortSignal.timeout(60_000),
  );

  if (result.isError) {
    throw new Error(`Executor check did not complete: ${JSON.stringify(result.content)}`);
  }

  const payload = Schema.decodeUnknownSync(CheckResponse)(result.structuredContent)
    .structuredContent.result;

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
