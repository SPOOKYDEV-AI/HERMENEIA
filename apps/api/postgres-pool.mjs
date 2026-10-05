function asPositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return parsed;
}

export async function createNodePostgresPool({
  connectionString,
  max,
  idleTimeoutMillis,
  connectionTimeoutMillis,
  pgModule,
}) {
  if (typeof connectionString !== "string" || !connectionString) {
    throw new TypeError("connectionString is required");
  }

  const module = pgModule ?? await import("pg");
  if (!module || typeof module.Pool !== "function") {
    throw new TypeError("pg Pool constructor is required");
  }

  const pool = new module.Pool({
    connectionString,
    max: asPositiveInteger(max, 10, "max"),
    idleTimeoutMillis: asPositiveInteger(
      idleTimeoutMillis,
      30_000,
      "idleTimeoutMillis",
    ),
    connectionTimeoutMillis: asPositiveInteger(
      connectionTimeoutMillis,
      5_000,
      "connectionTimeoutMillis",
    ),
  });

  return {
    async connect() {
      const client = await pool.connect();
      let released = false;

      return {
        async query(text, params = []) {
          if (released) {
            throw new Error("PostgreSQL connection already released");
          }
          const result = await client.query(text, params);
          return {
            rows: result.rows ?? [],
            rowCount:
              typeof result.rowCount === "number"
                ? result.rowCount
                : (result.rows?.length ?? 0),
          };
        },

        release() {
          if (released) return;
          released = true;
          client.release();
        },
      };
    },

    async close() {
      await pool.end();
    },
  };
}

export function postgresPoolConfigFromEnv(env = process.env) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new TypeError("DATABASE_URL is required");
  }

  return {
    connectionString,
    max: asPositiveInteger(env.DB_POOL_MAX, 10, "DB_POOL_MAX"),
    idleTimeoutMillis: asPositiveInteger(
      env.DB_POOL_IDLE_TIMEOUT_MS,
      30_000,
      "DB_POOL_IDLE_TIMEOUT_MS",
    ),
    connectionTimeoutMillis: asPositiveInteger(
      env.DB_POOL_CONNECT_TIMEOUT_MS,
      5_000,
      "DB_POOL_CONNECT_TIMEOUT_MS",
    ),
  };
}
