import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./dbquery.txt"
import { Database } from "bun:sqlite"

async function querySQLite(dbPath: string, query: string) {
  const file = Bun.file(dbPath)
  if (!(await file.exists())) throw new Error(`Database file not found: ${dbPath}`)
  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = db.query(query).all()
    const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v)
    return { output: JSON.stringify(rows, replacer, 2), rowCount: rows.length, title: `SQLite: ${dbPath}` }
  } finally {
    db.close()
  }
}

async function queryPostgres(conn: string, query: string) {
  let Client: { new (opts: { connectionString: string }): any }
  try {
    const mod = await import("pg")
    Client = mod.Client ?? mod.default?.Client
  } catch {
    return {
      output: "PostgreSQL driver not installed. Run: bun add pg",
      rowCount: 0,
      title: "PostgreSQL",
    }
  }
  const client = new Client({ connectionString: conn })
  await client.connect()
  try {
    const result = await client.query(query)
    return {
      output: JSON.stringify(result.rows, null, 2),
      rowCount: result.rowCount ?? result.rows.length,
      title: "PostgreSQL Query",
    }
  } finally {
    await client.end()
  }
}

async function queryMySQL(conn: string, query: string) {
  let createConnection: (url: string) => Promise<any>
  try {
    const mod = await import("mysql2/promise")
    createConnection = mod.createConnection ?? mod.default?.createConnection
  } catch {
    return {
      output: "MySQL driver not installed. Run: bun add mysql2",
      rowCount: 0,
      title: "MySQL",
    }
  }
  const client = await createConnection(conn)
  try {
    const [rows] = await client.execute(query)
    return {
      output: JSON.stringify(rows, null, 2),
      rowCount: Array.isArray(rows) ? rows.length : 0,
      title: "MySQL Query",
    }
  } finally {
    await client.end()
  }
}

export const DBQueryTool = Tool.define("dbquery", async () => {
  return {
    get description() {
      return DESCRIPTION
    },
    parameters: z.object({
      dbPath: z.string().optional().describe("Absolute path to the SQLite database file (.db, .sqlite)"),
      connectionString: z
        .string()
        .optional()
        .describe(
          "Connection string for PostgreSQL (postgresql://user:pass@host:5432/db) or MySQL (mysql://user:pass@host:3306/db)",
        ),
      query: z.string().describe("The SQL query to execute (e.g., SELECT, PRAGMA)"),
    }),
    async execute(params, ctx) {
      const target = params.dbPath ?? params.connectionString ?? "unknown"
      await ctx.ask({
        permission: "dbquery",
        patterns: [target],
        always: ["*"],
        metadata: {
          dbPath: params.dbPath,
          connectionString: params.connectionString,
          query: params.query,
        },
      })

      if (!params.dbPath && !params.connectionString) {
        return {
          output: "Error: provide dbPath for SQLite or connectionString for PostgreSQL/MySQL.",
          title: "DB Query Error",
          metadata: { rowCount: 0 },
        }
      }

      try {
        const conn = params.connectionString
        const result = params.dbPath
          ? await querySQLite(params.dbPath, params.query)
          : conn?.startsWith("mysql://")
            ? await queryMySQL(conn, params.query)
            : conn?.startsWith("postgresql://") || conn?.startsWith("postgres://")
              ? await queryPostgres(conn, params.query)
              : { output: `Unsupported connection string: ${conn}`, rowCount: 0, title: "DB Query Error" }

        return {
          output: result.output,
          title: result.title,
          metadata: { rowCount: result.rowCount },
        }
      } catch (err: any) {
        return {
          output: `Error: ${err.message}`,
          title: `DB Query Failed`,
          metadata: { rowCount: 0 },
        }
      }
    },
  }
})
