import type { PoolClient } from "@doco/db";

/** A short-lived database-client boundary. External I/O must run outside it. */
export type ClientScope = <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>;
