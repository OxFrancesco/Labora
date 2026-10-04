import { Schema } from "effect";

export const ConnectorId = Schema.String.check(Schema.isPattern(/^(notion|linear|github|granola|custom_[a-z0-9]{1,32})$/));

export const ConnectorAuth = Schema.Literals(["oauth", "none"]);

export const CustomConnector = Schema.Struct({
  id: ConnectorId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  url: Schema.String.check(Schema.isMaxLength(2048)),
  auth: ConnectorAuth,
});

export interface CustomConnector extends Schema.Schema.Type<typeof CustomConnector> {}

export const ConnectorChange = Schema.Struct({ id: ConnectorId, action: Schema.Literals(["enable", "disable", "disconnect", "check", "remove"]) });

export interface ConnectorChange extends Schema.Schema.Type<typeof ConnectorChange> {}

export const Connector = Schema.Struct({
  ...CustomConnector.fields,
  description: Schema.String,
  docs: Schema.String,
  enabled: Schema.Boolean,
  status: Schema.Literals(["disconnected", "checking", "connected", "error"]),
  message: Schema.String,
});

export interface Connector extends Schema.Schema.Type<typeof Connector> {}

export const ConnectorList = Schema.Struct({ connectors: Schema.Array(Connector) });

export const officialConnectors = [
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", auth: "oauth", description: "Pages, databases, and workspace search", docs: "https://developers.notion.com/guides/mcp/get-started-with-mcp" },
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", auth: "oauth", description: "Issues, projects, and team planning", docs: "https://linear.app/docs/mcp" },
  { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", auth: "oauth", description: "Repositories, issues, and pull requests", docs: "https://github.com/github/github-mcp-server" },
  { id: "granola", name: "Granola", url: "https://mcp.granola.ai/mcp", auth: "oauth", description: "Meeting notes and conversation search", docs: "https://www.granola.ai/blog/granola-mcp" },
] satisfies Omit<Connector, "enabled" | "status" | "message">[];
