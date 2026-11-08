import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("collaborators", "routes/collaborators.tsx"),
  route("integrations", "routes/integrations.tsx"),
  route("mcp-tokens", "routes/mcp-tokens.tsx"),
  route("mcp", "routes/mcp.ts"),
  route("healthz", "routes/healthz.ts"),
  route("search", "routes/search.tsx"),
  route("api/v1/search.json", "routes/api.v1.search[.]json.ts"),
  route("api/v1/workspaces.json", "routes/api.v1.workspaces[.]json.ts"),
  route("api/v1/collections.json", "routes/api.v1.collections[.]json.ts"),
  route("api/v1/webhooks/:token", "routes/api.v1.webhooks.$token.ts"),
  route(
    ":collectionHandle/api/authoring-contract.json",
    "routes/$collectionHandle.api.authoring-contract[.]json.ts",
  ),
  route(
    ":collectionHandle/api/changesets.json",
    "routes/$collectionHandle.api.changesets[.]json.ts",
  ),
  route(":collectionHandle", "routes/$collectionHandle.tsx"),
  route(":collectionHandle/:nodeId", "routes/$collectionHandle.$nodeId.tsx"),
] satisfies RouteConfig;
