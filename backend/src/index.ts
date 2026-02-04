import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { IndexDb } from "./indexDb";
import { dataDir, pdfDir, sqlitePath } from "./paths";
import { assertDocId, parseIntField } from "./validate";

const PORT = Number.parseInt(process.env.PORT || "3001", 10);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

async function ensureDirs() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(pdfDir, { recursive: true });
}

function latestPdfPath(docId: string, rev: number) {
  return path.join(pdfDir, docId, `rev-${rev}.pdf`);
}

async function main() {
  await ensureDirs();
  const indexDb = await IndexDb.open(sqlitePath);

  const app = express();
  app.disable("x-powered-by");

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/docs/:docId/meta", (req, res) => {
    const docId = String(req.params.docId);
    assertDocId(docId);
    const doc = indexDb.getDoc(docId);
    if (!doc) return res.status(404).json({ error: "not_found" });
    return res.json({
      docId: doc.docId,
      rev: doc.rev,
      filename: doc.filename,
      updatedAt: doc.updatedAt
    });
  });

  app.get("/api/docs/:docId/file", async (req, res) => {
    const docId = String(req.params.docId);
    assertDocId(docId);
    const doc = indexDb.getDoc(docId);
    if (!doc) return res.status(404).json({ error: "not_found" });
    const filePath = latestPdfPath(docId, doc.rev);
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: "file_missing" });
    }
    res.setHeader("content-type", "application/pdf");
    res.setHeader("cache-control", "no-store");
    return res.sendFile(filePath);
  });

  app.post("/api/docs", upload.single("file"), async (req, res, next) => {
    try {
      const docId = String(req.body.docId ?? "");
      const filename = String(req.body.filename ?? `${docId}.pdf`);
      const revClient = parseIntField("revClient", req.body.revClient);
      assertDocId(docId);
      const file = req.file;
      if (!file) return res.status(400).json({ error: "missing_file" });

      const existing = indexDb.getDoc(docId);
      if (existing && revClient <= existing.rev) {
        return res.status(409).json({ error: "conflict", revServer: existing.rev });
      }

      const revServer = revClient;
      const dir = path.join(pdfDir, docId);
      await fs.mkdir(dir, { recursive: true });
      const target = latestPdfPath(docId, revServer);
      await fs.writeFile(target, file.buffer);

      const now = Date.now();
      const sha256 = IndexDb.sha256Hex(new Uint8Array(file.buffer));
      const sizeBytes = file.size;
      indexDb.upsertDoc({
        docId,
        filename,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        rev: revServer,
        sha256,
        sizeBytes
      });

      return res.json({ docId, revServer, url: `/d/${docId}` });
    } catch (e) {
      next(e);
    }
  });

  app.put("/api/docs/:docId", upload.single("file"), async (req, res, next) => {
    try {
      const docId = String(req.params.docId);
      assertDocId(docId);
      const filename = String(req.body.filename ?? `${docId}.pdf`);
      const revClient = parseIntField("revClient", req.body.revClient);
      const file = req.file;
      if (!file) return res.status(400).json({ error: "missing_file" });

      const existing = indexDb.getDoc(docId);
      if (!existing) return res.status(404).json({ error: "not_found" });
      if (revClient <= existing.rev) {
        return res.status(409).json({ error: "conflict", revServer: existing.rev });
      }

      const revServer = revClient;
      const dir = path.join(pdfDir, docId);
      await fs.mkdir(dir, { recursive: true });
      const target = latestPdfPath(docId, revServer);
      await fs.writeFile(target, file.buffer);

      const now = Date.now();
      const sha256 = IndexDb.sha256Hex(new Uint8Array(file.buffer));
      const sizeBytes = file.size;
      indexDb.upsertDoc({
        docId,
        filename,
        createdAt: existing.createdAt,
        updatedAt: now,
        rev: revServer,
        sha256,
        sizeBytes
      });

      return res.json({ docId, revServer });
    } catch (e) {
      next(e);
    }
  });

  // /d/:docId = URL stable (SPA)
  app.get("/d/:docId", async (req, res) => {
    const docId = String(req.params.docId);
    try {
      assertDocId(docId);
    } catch {
      // ignore; SPA can handle invalid routes too
    }

    const distIndex = path.resolve(__dirname, "..", "..", "frontend", "dist", "index.html");
    try {
      await fs.access(distIndex);
      return res.sendFile(distIndex);
    } catch {
      // Dev fallback: redirect to Vite (try common ports)
      const vitePort = process.env.VITE_PORT || "5173";
      return res.redirect(302, `http://localhost:${vitePort}/d/${encodeURIComponent(docId)}`);
    }
  });

  // Serve frontend dist in prod (SPA fallback)
  const distDir = path.resolve(__dirname, "..", "..", "frontend", "dist");
  try {
    await fs.access(distDir);
    app.use(express.static(distDir, { index: false }));
    app.get("*", async (_req, res) => {
      const index = path.join(distDir, "index.html");
      return res.sendFile(index);
    });
  } catch {
    // no-op in dev before build
  }

  // Error handler
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = Number.isFinite(err?.status) ? err.status : 500;
    const message = err instanceof Error ? err.message : "Erreur";
    res.status(status).json({ error: message });
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Backend listening on http://localhost:${PORT}`);
  });
}

void main();

