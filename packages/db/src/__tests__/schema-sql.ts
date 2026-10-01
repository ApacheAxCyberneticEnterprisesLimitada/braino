import { readFileSync } from "node:fs";

// The canonical baseline schema every Doco database is built from. Tests that
// stand up a *legacy* shape (to exercise a self-healing migration) build their
// own DDL instead; this is the current, full schema.
export const schemaSql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
