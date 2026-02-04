import { openDB, type DBSchema } from "idb";

export type DocMeta = {
  docId: string;
  filename: string;
  createdAt: number;
  updatedAt: number;
  revLocal: number;
  revServer?: number;
  lastSyncedAt?: number;
};

type BlobEntry = {
  docId: string;
  rev: number;
  bytes: Uint8Array;
};

type OutboxEntry = {
  id: string;
  docId: string;
  rev: number;
  bytes: Uint8Array;
  createdAt: number;
  tries: number;
  lastError?: string;
};

interface PdfAnnotateDB extends DBSchema {
  docs: {
    key: string;
    value: DocMeta;
    indexes: { "by-updatedAt": number };
  };
  blobs: {
    key: [string, number]; // [docId, rev]
    value: BlobEntry;
    indexes: { "by-docId": string };
  };
  outbox: {
    key: string; // id
    value: OutboxEntry;
    indexes: { "by-createdAt": number };
  };
}

const dbPromise = openDB<PdfAnnotateDB>("pdfannotate", 1, {
  upgrade(db) {
    const docs = db.createObjectStore("docs", { keyPath: "docId" });
    docs.createIndex("by-updatedAt", "updatedAt");

    const blobs = db.createObjectStore("blobs", { keyPath: ["docId", "rev"] });
    blobs.createIndex("by-docId", "docId");

    const outbox = db.createObjectStore("outbox", { keyPath: "id" });
    outbox.createIndex("by-createdAt", "createdAt");
  }
});

function ensureDocId(docId: string) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(docId)) {
    throw new Error("docId invalide.");
  }
}

function bytesFromBlob(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then(ab => new Uint8Array(ab));
}

export async function upsertDocMeta(docId: string, fn: (current: DocMeta) => DocMeta): Promise<DocMeta> {
  ensureDocId(docId);
  const db = await dbPromise;
  const existing = await db.get("docs", docId);
  const now = Date.now();
  const base: DocMeta =
    existing ??
    ({
      docId,
      filename: `${docId}.pdf`,
      createdAt: now,
      updatedAt: now,
      revLocal: 0
    } satisfies DocMeta);

  const next = fn(base);
  await db.put("docs", next);
  return next;
}

export async function getAllDocs(): Promise<DocMeta[]> {
  const db = await dbPromise;
  return await db.getAll("docs");
}

export async function getDocBlobLatest(docId: string): Promise<Blob | null> {
  ensureDocId(docId);
  const db = await dbPromise;
  const meta = await db.get("docs", docId);
  if (!meta) return null;

  const rev = meta.revLocal;
  const entry = await db.get("blobs", [docId, rev]);
  if (!entry) return null;
  return new Blob([entry.bytes], { type: "application/pdf" });
}

export async function addDocFromDrop(opts: { docId: string; file: File; rev?: number; fromServer?: boolean }) {
  const { docId, file, fromServer } = opts;
  ensureDocId(docId);
  const db = await dbPromise;

  const now = Date.now();
  const rev = opts.rev ?? 0;
  const bytes = await bytesFromBlob(file);

  await upsertDocMeta(docId, current => ({
    ...current,
    filename: file.name || current.filename,
    createdAt: current.createdAt ?? now,
    updatedAt: now,
    revLocal: Math.max(current.revLocal, rev),
    // Si téléchargé depuis le serveur, marquer comme synchronisé
    ...(fromServer ? { revServer: rev, lastSyncedAt: now } : {})
  }));

  await db.put("blobs", { docId, rev, bytes });

  if (fromServer) {
    // Nettoyer les entrées obsolètes de l'outbox (révisions déjà sur le serveur)
    await clearOutboxForDoc(docId, rev);
  } else {
    await enqueueUpload({ docId, rev, bytes });
  }
}

export async function enqueueUpload(params: { docId: string; rev: number; bytes: Uint8Array }) {
  const db = await dbPromise;
  const id = `${params.docId}:${params.rev}`;
  const existing = await db.get("outbox", id);
  if (existing) return;
  await db.put("outbox", {
    id,
    docId: params.docId,
    rev: params.rev,
    bytes: params.bytes,
    createdAt: Date.now(),
    tries: 0
  });
}

export async function listOutbox(): Promise<OutboxEntry[]> {
  const db = await dbPromise;
  const all = await db.getAll("outbox");
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function bumpOutboxTry(id: string, error: string) {
  const db = await dbPromise;
  const job = await db.get("outbox", id);
  if (!job) return;
  await db.put("outbox", { ...job, tries: job.tries + 1, lastError: error });
}

export async function removeOutbox(id: string) {
  const db = await dbPromise;
  await db.delete("outbox", id);
}

// Supprimer les entrées de l'outbox pour un document dont la révision est <= revServer
export async function clearOutboxForDoc(docId: string, upToRev: number) {
  const db = await dbPromise;
  const all = await db.getAllFromIndex("outbox", "by-createdAt");
  let cleared = 0;
  for (const entry of all) {
    if (entry.docId === docId && entry.rev <= upToRev) {
      await db.delete("outbox", entry.id);
      cleared++;
    }
  }
  if (cleared > 0) {
    console.log(`[db] Cleared ${cleared} obsolete outbox entries for ${docId} (rev <= ${upToRev})`);
  }
  return cleared;
}

// Nettoyer l'outbox de toutes les entrées obsolètes (revLocal <= revServer)
export async function cleanupOutbox(): Promise<number> {
  const db = await dbPromise;
  const allDocs = await db.getAll("docs");
  const allOutbox = await db.getAll("outbox");
  
  let cleared = 0;
  for (const entry of allOutbox) {
    const doc = allDocs.find(d => d.docId === entry.docId);
    // Supprimer si: le doc n'existe plus OU la révision est déjà sync
    if (!doc || (doc.revServer !== undefined && entry.rev <= doc.revServer)) {
      await db.delete("outbox", entry.id);
      cleared++;
    }
  }
  
  if (cleared > 0) {
    console.log(`[db] Cleanup: removed ${cleared} obsolete outbox entries`);
  }
  return cleared;
}