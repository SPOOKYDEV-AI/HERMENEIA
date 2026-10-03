export type SqlValue = string | number | boolean | null;

export interface SqlQueryResult<Row extends Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export interface SqlExecutor {
  query<Row extends Record<string, unknown>>(
    text: string,
    params?: readonly SqlValue[],
  ): Promise<SqlQueryResult<Row>>;
}

export interface SqlConnection extends SqlExecutor {
  release(): void;
}

export interface SqlPool {
  connect(): Promise<SqlConnection>;
}

export class SqlTransactionManager {
  constructor(private readonly pool: SqlPool) {}

  async withTransaction<T>(
    work: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      const result = await work(connection);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await connection.query("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}
