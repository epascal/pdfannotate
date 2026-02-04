import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import initSqlJs from "sql.js";

type DocRow = {
  docId: string;
  filename: string;
  createdAt: number;
  updatedAt: number;
  rev: number;
  sha256: string;
  sizeBytes: number;
};

export class IndexDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;
  private persistQueue: Promise<void> = Promise.resolve();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private constructor(private dbPath: string, db: any) {
    this.db = db;
    this.ensureSchema();
  }

  static async open(dbPath: string): Promise<IndexDb> {
    // Find the wasm file relative to node_modules
    const wasmPath = path.join(
      path.dirname(require.resolve("sql.js/package.json")),
      "dist",
      "sql-wasm.wasm"
    );
    const SQL = await initSqlJs({ locateFile: () => wasmPath });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let db: any;
    try {
      const buf = await fs.readFile(dbPath);
      db = new SQL.Database(new Uint8Array(buf));
    } catch {
      db = new SQL.Database();
    }
    return new IndexDb(dbPath, db);
  }

  private ensureSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS docs (
        docId TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        rev INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        sizeBytes INTEGER NOT NULL
      );
    `);
  }

  private queuePersist() {
    this.persistQueue = this.persistQueue.then(async () => {
      const bytes = this.db.export();
      await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
      await fs.writeFile(this.dbPath, Buffer.from(bytes));
    });
    return this.persistQueue;
  }

  getDoc(docId: string): DocRow | null {
    const stmt = this.db.prepare(
      "SELECT docId, filename, createdAt, updatedAt, rev, sha256, sizeBytes FROM docs WHERE docId = ?"
    );
    try {
      stmt.bind([docId]);
      if (!stmt.step()) return null;
      const row = stmt.getAsObject() as unknown as Record<string, any>;
      return {
        docId: String(row.docId),
        filename: String(row.filename),
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
        rev: Number(row.rev),
        sha256: String(row.sha256),
        sizeBytes: Number(row.sizeBytes)
      };
    } finally {
      stmt.free();
    }
  }

  upsertDoc(row: DocRow) {
    const stmt = this.db.prepare(`
      INSERT INTO docs (docId, filename, createdAt, updatedAt, rev, sha256, sizeBytes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(docId) DO UPDATE SET
        filename=excluded.filename,
        updatedAt=excluded.updatedAt,
        rev=excluded.rev,
        sha256=excluded.sha256,
        sizeBytes=excluded.sizeBytes;
    `);
    try {
      stmt.run([
        row.docId,
        row.filename,
        row.createdAt,
        row.updatedAt,
        row.rev,
        row.sha256,
        row.sizeBytes
      ]);
    } finally {
      stmt.free();
    }
    void this.queuePersist();
  }

  static sha256Hex(buf: Uint8Array): string {
    return crypto.createHash("sha256").update(buf).digest("hex");
  }
}

