import { bumpOutboxTry, listOutbox, removeOutbox, upsertDocMeta, type DocMeta } from "./db";

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Callbacks pour notifier l'UI des changements de sync
type SyncCallback = (syncing: boolean, pending: number) => void;
const syncCallbacks = new Set<SyncCallback>();

export function onSyncChange(cb: SyncCallback) {
  syncCallbacks.add(cb);
  return () => syncCallbacks.delete(cb);
}

function notifySyncChange(syncing: boolean, pending: number) {
  syncCallbacks.forEach(cb => cb(syncing, pending));
}

async function uploadOne(job: { id: string; docId: string; rev: number; bytes: Uint8Array }, meta: DocMeta | null) {
  const fd = new FormData();
  fd.set("docId", job.docId);
  fd.set("filename", meta?.filename ?? `${job.docId}.pdf`);
  fd.set("revClient", String(job.rev));
  fd.set("file", new Blob([job.bytes], { type: "application/pdf" }), meta?.filename ?? `${job.docId}.pdf`);

  // Utiliser POST si le document n'a jamais été synchronisé (revServer undefined ou 0)
  // PUT seulement si le document existe déjà sur le serveur
  const existsOnServer = meta?.revServer !== undefined && meta.revServer > 0;
  const method = existsOnServer ? "PUT" : "POST";
  const url = existsOnServer ? `/api/docs/${encodeURIComponent(job.docId)}` : "/api/docs";

  console.log(`[sync] Upload ${job.docId} rev=${job.rev} method=${method} existsOnServer=${existsOnServer}`);

  const res = await fetch(url, { method, body: fd });
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    throw new Error(`Conflit serveur (409). revServer=${body?.revServer ?? "?"}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  const json = (await res.json()) as { revServer: number };
  console.log(`[sync] Upload OK ${job.docId} revServer=${json.revServer}`);
  await upsertDocMeta(job.docId, m => ({
    ...m,
    revServer: json.revServer,
    lastSyncedAt: Date.now()
  }));
}

let flushing = false;
let flushQueued = false;

export async function flushOutbox(): Promise<void> {
  if (flushing) {
    flushQueued = true;
    return;
  }
  if (!navigator.onLine) {
    console.log("[sync] Offline, sync en attente");
    const jobs = await listOutbox();
    notifySyncChange(false, jobs.length);
    return;
  }
  flushing = true;
  flushQueued = false;
  
  try {
    let jobs = await listOutbox();
    console.log(`[sync] Démarrage sync: ${jobs.length} jobs`);
    notifySyncChange(true, jobs.length);
    
    while (jobs.length > 0 && navigator.onLine) {
      const job = jobs[0];
      try {
        const meta = await upsertDocMeta(job.docId, m => m);
        await uploadOne(job, meta);
        await removeOutbox(job.id);
        console.log(`[sync] ✓ ${job.docId} rev ${job.rev}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[sync] ✗ ${job.docId}: ${msg}`);
        await bumpOutboxTry(job.id, msg);
        // Backoff exponentiel
        const tries = Math.min(6, Math.max(1, job.tries ?? 1));
        await sleep(250 * 2 ** tries);
      }
      jobs = await listOutbox();
      notifySyncChange(true, jobs.length);
    }
    
    notifySyncChange(false, 0);
    console.log("[sync] Sync terminée");
  } finally {
    flushing = false;
    // Si une nouvelle sync a été demandée pendant qu'on était occupé
    if (flushQueued) {
      void flushOutbox();
    }
  }
}

export async function getPendingCount(): Promise<number> {
  const jobs = await listOutbox();
  return jobs.length;
}

// Écouter l'événement online pour déclencher la sync automatiquement
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    console.log("[sync] Connexion rétablie, déclenchement sync");
    void flushOutbox();
  });
}

