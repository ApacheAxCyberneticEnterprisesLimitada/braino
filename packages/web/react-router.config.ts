import type { Config } from "@react-router/dev/config";

export default {
  appDirectory: "app",
  ssr: true,
  routeDiscovery: { mode: "initial" },
  allowedActionOrigins: process.env.DOCO_HOST?.trim() ? [process.env.DOCO_HOST.trim()] : [],
} satisfies Config;
