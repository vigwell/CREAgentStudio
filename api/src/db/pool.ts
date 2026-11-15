import sql from "mssql";
import type { Config } from "../config.js";

export type Db = sql.ConnectionPool;

export async function createPool(config: Config): Promise<Db> {
  const pool = new sql.ConnectionPool({
    server: config.DB_SERVER,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
    connectionTimeout: 20_000,
    requestTimeout: 30_000,
  });
  return pool.connect();
}

export { sql };
