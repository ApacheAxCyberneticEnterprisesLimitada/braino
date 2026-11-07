import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
  server: { host: "127.0.0.1", port: 5173 },
  resolve: { dedupe: ["react", "react-dom"] },
  ssr: {
    external: ["pg"],
    noExternal: ["@react-router/node", "@doco/db", "@doco/host", "@doco/shared", "react-router"],
  },
});
