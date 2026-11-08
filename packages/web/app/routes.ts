import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("healthz", "routes/healthz.ts"),
  route("api/v1/workspaces.json", "routes/api.v1.workspaces[.]json.ts"),
  route("api/v1/collections.json", "routes/api.v1.collections[.]json.ts"),
  route(
    ":collectionHandle/api/authoring-contract.json",
    "routes/$collectionHandle.api.authoring-contract[.]json.ts",
  ),
  route(
    ":collectionHandle/api/changesets.json",
    "routes/$collectionHandle.api.changesets[.]json.ts",
  ),
  route(":collectionHandle", "routes/$collectionHandle.tsx"),
] satisfies RouteConfig;
