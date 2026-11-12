import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequestHandler } from "@react-router/express";
import express from "express";

export function trustSingleProxy(app) {
  app.set("trust proxy", 1);
  return app;
}

export function createApp(build) {
  const app = trustSingleProxy(express());
  app.disable("x-powered-by");

  app.use(
    `${build.publicPath}assets`,
    express.static(resolve(build.assetsBuildDirectory, "assets"), {
      immutable: true,
      maxAge: "1y",
    }),
  );
  app.use(build.publicPath, express.static(resolve(build.assetsBuildDirectory)));
  app.use(express.static("public", { maxAge: "1h" }));
  app.all("*", createRequestHandler({ build, mode: process.env.NODE_ENV }));

  return app;
}

async function run() {
  process.env.NODE_ENV ??= "production";
  const build = await import("./build/server/index.js");
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST;
  const server = createApp(build).listen(port, host, () => {
    console.log(`[braino] http://${host || "localhost"}:${port}`);
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => server.close());
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run();
}
