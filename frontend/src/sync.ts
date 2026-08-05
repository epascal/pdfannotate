import { bumpOutboxTry, countOutbox, listOutbox, removeOutbox, upsertDocMeta, type DocMeta } from "./db";

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

// Gros PDF / réseau lent: laisser largement le temps (nginx aligné).
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

class SyncHttpError extends Error {
  status: number;
  revServer?: number;

  constructor(status: number, message: string, revServer?: number) {
    super(message);
    this.name = "SyncHttpError";
    this.status = status;
    this.revServer = revServer;
  }
}

function isNetworkLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  // AbortError seul (timeout) n'est pas forcément une coupure réseau.
  return message.includes("networkerror") || message.includes("failed to fetch");
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
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

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { method, body: fd, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { revServer?: number } | null;
    throw new SyncHttpError(
      409,
      `Conflit serveur (409). revServer=${body?.revServer ?? "?"}`,
      body?.revServer
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SyncHttpError(res.status, `HTTP ${res.status} ${text}`);
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
    // En hors-ligne, éviter de charger tous les bytes (gros PDFs) juste pour compter.
    const pending = await countOutbox();
    notifySyncChange(false, pending);
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

        // 409 = le serveur a déjà cette révision (ou plus récente).
        // Cas typique: upload réussi puis réponse perdue / SW abort → le job reste en outbox.
        const conflict =
          (e instanceof SyncHttpError && e.status === 409) ||
          (typeof msg === "string" && msg.includes("(409)"));
        if (conflict) {
          const revServer = e instanceof SyncHttpError ? e.revServer : undefined;
          if (typeof revServer === "number" && revServer >= job.rev) {
            await upsertDocMeta(job.docId, m => ({
              ...m,
              revServer: Math.max(m.revServer ?? 0, revServer),
              lastSyncedAt: Date.now()
            }));
          }
          await removeOutbox(job.id);
          console.log(`[sync] Job 409 retiré ${job.docId} rev ${job.rev} (serveur=${revServer ?? "?"})`);
        } else if (!navigator.onLine || isNetworkLikeError(e)) {
          await bumpOutboxTry(job.id, msg);
          // Coupure réseau réelle: sortir vite pour ne pas bloquer l'UI.
          console.log("[sync] Arrêt du cycle courant (réseau indisponible)");
          break;
        } else if (isAbortError(e)) {
          // Timeout upload: garder le job, sortir du cycle, retenter plus tard.
          await bumpOutboxTry(job.id, msg);
          console.log("[sync] Timeout upload, pause du cycle");
          break;
        } else {
          await bumpOutboxTry(job.id, msg);
          // Backoff exponentiel pour erreurs serveur temporaires.
          const tries = Math.min(6, Math.max(1, job.tries ?? 1));
          await sleep(250 * 2 ** tries);
        }
      }
      jobs = await listOutbox();
      notifySyncChange(true, jobs.length);
    }

    const pending = await countOutbox();
    notifySyncChange(false, pending);
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
  return await countOutbox();
}

// Écouter l'événement online pour déclencher la sync automatiquement
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    console.log("[sync] Connexion rétablie, déclenchement sync");
    void flushOutbox();
  });
}
