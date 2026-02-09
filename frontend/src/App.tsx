import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { nanoid } from "nanoid";
import { addDocFromDrop, getAllDocs, getDocBlobLatest, saveDocRevision, upsertDocMeta, cleanupOutbox } from "./db";
import { flushOutbox, onSyncChange, getPendingCount } from "./sync";

function HomePage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [docs, setDocs] = useState<Array<{ docId: string; filename: string; updatedAt: number; revLocal: number }>>([]);

  async function refresh() {
    const all = await getAllDocs();
    setDocs(
      all
        .map(d => ({ docId: d.docId, filename: d.filename, updatedAt: d.updatedAt, revLocal: d.revLocal }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    );
  }

  useEffect(() => {
    void refresh();
    void flushOutbox();
    const onOnline = () => void flushOutbox();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  async function handleFile(file: File) {
    if (file.type !== "application/pdf") {
      alert("Merci de déposer un PDF.");
      return;
    }
    const docId = nanoid();
    await addDocFromDrop({ docId, file });
    await refresh();
    navigate(`/doc/${docId}`);
  }

  return (
    <div className="page">
      <header className="header">
        <div className="title">pdfannotate</div>
        <div className="subtitle">Offline-first: drop un PDF, annote, autosave, puis synchro.</div>
      </header>

      <input
        type="file"
        ref={fileInputRef}
        accept="application/pdf"
        className="dropzoneFileInput"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
          e.target.value = "";
        }}
        aria-hidden
      />
      <section
        className="dropzone"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={e => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={async e => {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (!file) return;
          await handleFile(file);
        }}
      >
        <div className="dropzoneInner">
          <div className="dropTitle">Dépose un PDF ici ou clique pour choisir</div>
          <div className="dropHint">Le lien unique est généré tout de suite, même sans internet.</div>
          <div className="dropHint">Astuce: Ctrl+S dans le viewer déclenche la sauvegarde côté app (pas un téléchargement).</div>
        </div>
      </section>

      <section className="card">
        <div className="cardTitle">Documents locaux</div>
        {docs.length === 0 ? (
          <div className="muted">Aucun document pour l’instant.</div>
        ) : (
          <ul className="list">
            {docs.map(d => (
              <li key={d.docId} className="listItem">
                <div className="listMain">
                  <div className="filename">{d.filename}</div>
                  <div className="meta">
                    <span className="chip">rev {d.revLocal}</span>
                    <span className="muted">{new Date(d.updatedAt).toLocaleString()}</span>
                    <Link className="link" to={`/doc/${d.docId}`}>
                      Ouvrir
                    </Link>
                    <Link className="link" to={`/d/${d.docId}`}>
                      URL stable (/d)
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DocRoute({ mode }: { mode: "local" | "stable" }) {
  const params = useParams();
  const docId = params.docId!;
  return <DocPage docId={docId} mode={mode} />;
}

// Utilitaire pour comparer deux ArrayBuffer/Uint8Array
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

type ConflictInfo = {
  serverRev: number;
  serverFilename: string;
};

function DocPage({ docId, mode }: { docId: string; mode: "local" | "stable" }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState<string>(docId + ".pdf");
  const [revLocal, setRevLocal] = useState<number>(0);
  const [revServer, setRevServer] = useState<number | null>(null);
  const [status, setStatus] = useState<string>("Chargement…");
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const lastSavedBytesRef = useRef<Uint8Array | null>(null);
  
  // Panneau escamotable
  const [panelOpen, setPanelOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // Ouvrir le panneau automatiquement uniquement en cas de conflit
  useEffect(() => {
    if (conflict) {
      setPanelOpen(true);
    }
  }, [conflict]);

  // Écouter les changements de sync + cleanup au démarrage
  useEffect(() => {
    // Nettoyer les entrées obsolètes de l'outbox au démarrage
    cleanupOutbox().then(() => getPendingCount()).then(setPendingCount);
    return onSyncChange((isSyncing, pending) => {
      setSyncing(isSyncing);
      setPendingCount(pending);
    });
  }, []);

  // Recharger le viewer avec un nouveau blob
  const reloadViewer = useCallback(async () => {
    const newBlob = await getDocBlobLatest(docId);
    if (newBlob) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setObjectUrl(URL.createObjectURL(newBlob));
      // Mettre à jour lastSavedBytesRef
      const bytes = new Uint8Array(await newBlob.arrayBuffer());
      lastSavedBytesRef.current = bytes;
    }
  }, [docId, objectUrl]);

  // Télécharger la version serveur
  const downloadServerVersion = async (serverMeta: { filename: string; rev: number }) => {
    const fileRes = await fetch(`/api/docs/${encodeURIComponent(docId)}/file`);
    if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);
    const blob = await fileRes.blob();
    await addDocFromDrop({
      docId,
      file: new File([blob], serverMeta.filename, { type: "application/pdf" }),
      rev: serverMeta.rev,
      fromServer: true
    });
    setRevLocal(serverMeta.rev);
    setRevServer(serverMeta.rev);
    setFilename(serverMeta.filename);
    await reloadViewer();
    return blob;
  };

  // Vérifier les mises à jour (avec gestion des conflits)
  const checkForUpdate = async (autoResolve = false) => {
    if (!navigator.onLine || checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const metaRes = await fetch(`/api/docs/${encodeURIComponent(docId)}/meta`);
      if (!metaRes.ok) {
        if (metaRes.status === 404) {
          setRevServer(null);
          setStatus("Document pas encore sur le serveur.");
        } else {
          setStatus("Erreur serveur.");
        }
        return;
      }
      const serverMeta = await metaRes.json() as { filename: string; rev: number };
      setRevServer(serverMeta.rev);

      if (serverMeta.rev > revLocal) {
        // Version serveur plus récente
        if (autoResolve) {
          // Télécharger automatiquement
          setStatus(`Téléchargement (rev ${serverMeta.rev})…`);
          await downloadServerVersion(serverMeta);
          setStatus(`Mis à jour vers rev ${serverMeta.rev}.`);
        } else {
          // Demander à l'utilisateur
          setConflict({ serverRev: serverMeta.rev, serverFilename: serverMeta.filename });
          setStatus(`Conflit: serveur a rev ${serverMeta.rev}, vous avez rev ${revLocal}.`);
        }
      } else if (serverMeta.rev === revLocal) {
        setStatus(`À jour (rev ${revLocal}).`);
      } else {
        // Notre version est plus récente, pousser vers le serveur
        setStatus(`Envoi vers le serveur…`);
        await flushOutbox();
        setStatus(`Synchronisé.`);
      }
    } catch (e) {
      console.error("Erreur vérification:", e);
      setStatus("Erreur de connexion.");
    } finally {
      setCheckingUpdate(false);
    }
  };

  // Résoudre le conflit: garder la version locale
  const keepLocal = async () => {
    setConflict(null);
    setStatus("Version locale conservée. Envoi vers le serveur…");
    await flushOutbox();
    setStatus("Synchronisé.");
  };

  // Résoudre le conflit: prendre la version serveur
  const takeServer = async () => {
    if (!conflict) return;
    setConflict(null);
    setStatus(`Téléchargement version serveur (rev ${conflict.serverRev})…`);
    try {
      await downloadServerVersion({ filename: conflict.serverFilename, rev: conflict.serverRev });
      setStatus(`Version serveur appliquée (rev ${conflict.serverRev}).`);
    } catch (e) {
      setStatus("Erreur téléchargement.");
    }
  };

  const viewerUrl = useMemo(() => {
    if (!objectUrl) return null;
    const u = new URL("/pdfjs/web/viewer.html", window.location.origin);
    u.searchParams.set("file", objectUrl);
    u.searchParams.set("docId", docId);
    u.searchParams.set("filename", filename);
    return u.toString();
  }, [docId, objectUrl, filename]);

  // Fetch meta avec timeout court, ne lance jamais (retourne null en cas d'erreur / offline)
  const fetchMetaSafe = useCallback(async (id: string, timeoutMs = 3000): Promise<{ filename: string; rev: number } | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(id)}/meta`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      return (await res.json()) as { filename: string; rev: number };
    } catch {
      clearTimeout(timer);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus("Chargement…");
      const local = await getDocBlobLatest(docId);
      const localMeta = await upsertDocMeta(docId, m => m);
      if (cancelled) return;

      // === Offline-first: afficher la version locale IMMÉDIATEMENT ===
      if (local) {
        setFilename(localMeta.filename);
        setRevLocal(localMeta.revLocal);
        setObjectUrl(URL.createObjectURL(local));
        setStatus("Prêt.");

        // Meta en arrière-plan uniquement si online, sans jamais bloquer ni faire planter
        if (navigator.onLine) {
          void fetchMetaSafe(docId)
            .then(serverMeta => {
              if (cancelled || !serverMeta) return;
              setRevServer(serverMeta.rev);
              if (serverMeta.rev > localMeta.revLocal) {
                setConflict({ serverRev: serverMeta.rev, serverFilename: serverMeta.filename });
              }
            })
            .catch(() => {});
        }
        return;
      }

      // === Pas de version locale: tenter le serveur via fetchMetaSafe (non-bloquant) ===
      if (navigator.onLine) {
        const serverMeta = await fetchMetaSafe(docId);
        if (cancelled) return;

        if (serverMeta) {
          setRevServer(serverMeta.rev);
          setStatus("Téléchargement depuis le serveur…");
          try {
            const fileRes = await fetch(`/api/docs/${encodeURIComponent(docId)}/file`);
            if (fileRes.ok) {
              const blob = await fileRes.blob();
              if (cancelled) return;
              await addDocFromDrop({
                docId,
                file: new File([blob], serverMeta.filename, { type: "application/pdf" }),
                rev: serverMeta.rev,
                fromServer: true
              });
              const newLocal = await getDocBlobLatest(docId);
              const newMeta = await upsertDocMeta(docId, m => m);
              if (cancelled) return;
              if (newLocal) {
                setFilename(newMeta.filename);
                setRevLocal(newMeta.revLocal);
                setObjectUrl(URL.createObjectURL(newLocal));
                setStatus("Prêt.");
                return;
              }
            } else if (mode === "stable") {
              setStatus(`Document introuvable sur le serveur (HTTP ${fileRes.status}).`);
              return;
            }
          } catch (e) {
            console.error("Erreur téléchargement:", e);
            if (mode === "stable") {
              setStatus("Erreur de connexion au serveur.");
              return;
            }
          }
        } else if (mode === "stable") {
          setStatus("Document introuvable ou hors-ligne.");
          return;
        }
      }

      if (cancelled) return;

      // Aucune version disponible
      setStatus(mode === "stable"
        ? "PDF introuvable (hors-ligne, aucune copie locale)."
        : "PDF introuvable localement."
      );
    }

    void load();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [docId, mode, fetchMetaSafe]);

  // Sync quand on revient online
  useEffect(() => {
    const onOnline = () => {
      void flushOutbox();
      void checkForUpdate(false); // false = ne pas auto-résoudre, montrer le conflit
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revLocal]);

  // PAS de timer de sauvegarde périodique - seulement sur Ctrl+S

  // Écouter les sauvegardes depuis le viewer
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as unknown;
      if (!data || typeof data !== "object") return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = data as any;
      
      // Recevoir les bytes initiaux après chargement complet par PDF.js
      if (msg.type === "PDFJS_LOADED" && msg.docId === docId && msg.bytes instanceof ArrayBuffer) {
        const bytes = new Uint8Array(msg.bytes);
        lastSavedBytesRef.current = bytes;
        return;
      }
      
      // PDF.js a détecté qu'il n'y a pas de changement d'annotation
      if (msg.type === "PDFJS_NO_CHANGE" && msg.docId === docId) {
        setStatus("Aucune modification.");
        return;
      }
      
      if (msg.type === "PDFJS_SAVE" && msg.docId === docId && msg.bytes instanceof ArrayBuffer) {
        const bytes = new Uint8Array(msg.bytes);
        const name = filename; // closure
        void (async () => {
          setStatus("Sauvegarde…");
          const newMeta = await saveDocRevision({
            docId,
            bytes,
            filename: name
          });
          lastSavedBytesRef.current = bytes;
          setRevLocal(newMeta.revLocal);
          setStatus(`Sauvegardé (rev ${newMeta.revLocal}).`);
          await flushOutbox();
        })();
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [docId, filename]);

  const shareUrl = `${window.location.origin}/d/${docId}`;

  // Indicateurs pour la barre minimale
  const hasAlert = conflict !== null;
  const hasPending = pendingCount > 0;

  return (
    <div className="page pageFull">
      {/* Barre minimale toujours visible */}
      <div className="topBar">
        <div className="topBarLeft">
          <Link className="linkIcon" to="/">←</Link>
          <span className="topBarTitle">{filename}</span>
          <span className="topBarChip">rev {revLocal}</span>
          {hasPending && (
            <span className="topBarChip topBarChipPending">
              {syncing ? "⟳" : "●"} {pendingCount} en attente
            </span>
          )}
          {hasAlert && <span className="topBarChip topBarChipAlert">⚠️ Conflit</span>}
        </div>
        <div className="topBarRight">
          <button
            className="topBarBtn"
            onClick={async () => {
              const blob = await getDocBlobLatest(docId);
              if (blob) {
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);
              }
            }}
            title="Télécharger le PDF"
          >
            ⬇️
          </button>
          <button 
            className="topBarBtn"
            onClick={() => setPanelOpen(!panelOpen)}
            title={panelOpen ? "Masquer les détails" : "Afficher les détails"}
          >
            {panelOpen ? "▲" : "▼"}
          </button>
        </div>
      </div>

      {/* Panneau escamotable */}
      {panelOpen && (
        <div className="panel">
          <section className="card cardTight">
            <div className="row">
              <div className="muted">URL stable:</div>
              <code className="code">{shareUrl}</code>
              <button
                className="btn btnSmall"
                onClick={async () => {
                  await navigator.clipboard.writeText(shareUrl);
                  setStatus("Lien copié.");
                }}
              >
                Copier
              </button>
              <button
                className="btn btnSmall"
                disabled={checkingUpdate || syncing}
                onClick={async () => {
                  await flushOutbox();
                  await checkForUpdate();
                }}
              >
                {checkingUpdate || syncing ? "Sync…" : "↻ Sync"}
              </button>
            </div>
            <div className="muted">{status}</div>
          </section>

          {conflict && (
            <section className="card cardConflict">
              <div className="conflictTitle">⚠️ Version plus récente sur le serveur</div>
              <div className="conflictInfo">
                <span>Votre version: <strong>rev {revLocal}</strong></span>
                <span>Version serveur: <strong>rev {conflict.serverRev}</strong></span>
              </div>
              <div className="conflictActions">
                <button className="btn btnDanger" onClick={takeServer}>
                  Prendre la version serveur
                </button>
                <button className="btn" onClick={keepLocal}>
                  Garder ma version
                </button>
                <button className="btn btnMuted" onClick={() => setConflict(null)}>
                  Ignorer
                </button>
              </div>
            </section>
          )}
        </div>
      )}

      <div className={`viewerWrap ${panelOpen ? "viewerWrapWithPanel" : ""}`}>
        {viewerUrl ? (
          <iframe id="pdf-frame" className="viewer" src={viewerUrl} title="PDF viewer" />
        ) : (
          <div className="muted">Chargement…</div>
        )}
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/doc/:docId" element={<DocRoute mode="local" />} />
      <Route path="/d/:docId" element={<DocRoute mode="stable" />} />
      <Route path="*" element={<HomePage />} />
    </Routes>
  );
}

