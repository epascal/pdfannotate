/**
 * Ce script est exécuté après npm install pour télécharger et installer
 * le viewer PDF.js officiel complet (depuis les releases GitHub).
 * 
 * Il ajoute également un patch (viewer_patch.js) qui :
 * - Intercepte la sauvegarde pour envoyer les bytes au parent via postMessage
 * - Active les fonctionnalités de commentaires sur les annotations
 * - Gère le dirty tracking pour éviter les sauvegardes inutiles
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { createWriteStream } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.resolve(__dirname, "..");
const dst = path.join(root, "public", "pdfjs");

// URL de la release officielle PDF.js
const PDFJS_VERSION = "5.4.624";
const PDFJS_URL = `https://github.com/mozilla/pdf.js/releases/download/v${PDFJS_VERSION}/pdfjs-${PDFJS_VERSION}-dist.zip`;

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    https.get(url, (response) => {
      // Suivre les redirections (GitHub)
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlink(destPath).catch(() => {});
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(destPath).catch(() => {});
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
      file.on("error", (err) => {
        fs.unlink(destPath).catch(() => {});
        reject(err);
      });
    }).on("error", (err) => {
      fs.unlink(destPath).catch(() => {});
      reject(err);
    });
  });
}

async function unzipFile(zipPath, destDir) {
  const { execSync } = await import("node:child_process");
  execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: "inherit" });
}

// Patch complet pour intercepter les sauvegardes et activer les fonctionnalités avancées
const VIEWER_PATCH = `/**
 * Patch pour intercepter la sauvegarde PDF.js et envoyer les bytes au parent (app React).
 * Utilise un polling robuste pour attendre que PDFViewerApplication soit prêt.
 * Active également les fonctionnalités avancées (commentaires, bouton flottant).
 */
(function () {
  "use strict";

  console.log("[viewer_patch] Script chargé");

  // Activer les fonctionnalités avancées dès que possible
  function enableAdvancedFeatures() {
    if (window.PDFViewerApplicationOptions) {
      const opts = window.PDFViewerApplicationOptions;
      // Activer les commentaires sur les annotations
      opts.set("enableComment", true);
      // Activer le bouton flottant pour surligner/commenter la sélection
      opts.set("enableHighlightFloatingButton", true);
      // Activer l'édition des annotations
      opts.set("enableHighlightEditor", true);
      opts.set("enableUpdatedAddImage", true);
      console.log("[viewer_patch] Options avancées activées (commentaires, bouton flottant)");
      return true;
    }
    return false;
  }

  // Essayer d'activer les options immédiatement et via polling
  if (!enableAdvancedFeatures()) {
    let optAttempts = 0;
    const optInterval = setInterval(() => {
      optAttempts++;
      if (enableAdvancedFeatures() || optAttempts > 50) {
        clearInterval(optInterval);
      }
    }, 50);
  }

  function getParams() {
    const u = new URL(window.location.href);
    return {
      docId: u.searchParams.get("docId") || "",
      filename: u.searchParams.get("filename") || "document.pdf",
    };
  }

  function transferableBuffer(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  function postSave(docId, bytes) {
    if (!window.parent || window.parent === window) {
      console.warn("[viewer_patch] Pas de parent iframe, sauvegarde ignorée.");
      return;
    }
    try {
      const ab = transferableBuffer(bytes);
      window.parent.postMessage(
        { type: "PDFJS_SAVE", docId, bytes: ab },
        window.location.origin,
        [ab]
      );
      console.log("[viewer_patch] PDFJS_SAVE envoyé au parent, taille:", bytes.length);
    } catch (e) {
      console.error("[viewer_patch] Erreur postMessage:", e);
    }
  }

  let saveInProgress = false;
  let isDirty = true; // Commence dirty pour permettre la première sauvegarde
  let saveCount = 0;

  async function doSave() {
    const { docId } = getParams();
    if (!docId) {
      console.warn("[viewer_patch] Pas de docId dans l'URL, sauvegarde annulée.");
      return;
    }
    const app = window.PDFViewerApplication;
    if (!app || !app.pdfDocument) {
      console.warn("[viewer_patch] PDF non chargé.");
      return;
    }
    if (saveInProgress) {
      console.log("[viewer_patch] Sauvegarde déjà en cours, ignoré.");
      return;
    }

    // Si pas dirty, ne pas sauvegarder
    if (!isDirty) {
      console.log("[viewer_patch] Document non modifié, sauvegarde ignorée.");
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "PDFJS_NO_CHANGE", docId }, window.location.origin);
      }
      return;
    }

    saveInProgress = true;
    saveCount++;
    console.log("[viewer_patch] Début de la sauvegarde #" + saveCount);

    try {
      await app.pdfScriptingManager?.dispatchWillSave?.();
      const data = await app.pdfDocument.saveDocument();
      console.log("[viewer_patch] saveDocument() OK, bytes:", data.length);
      postSave(docId, data);
      // Marquer comme propre après sauvegarde réussie
      isDirty = false;
    } catch (e) {
      console.error("[viewer_patch] Erreur saveDocument:", e);
      try {
        console.log("[viewer_patch] Tentative fallback getData()...");
        const data = await app.pdfDocument.getData();
        console.log("[viewer_patch] getData() OK, bytes:", data.length);
        postSave(docId, data);
        isDirty = false;
      } catch (e2) {
        console.error("[viewer_patch] Fallback getData échoué:", e2);
      }
    } finally {
      try {
        await app.pdfScriptingManager?.dispatchDidSave?.();
      } catch {}
      saveInProgress = false;
      console.log("[viewer_patch] Sauvegarde terminée.");
    }
  }

  // Marquer le document comme modifié quand l'utilisateur fait des changements
  function setupDirtyTracking(app) {
    // Écouter les changements d'annotation via eventBus
    if (app.eventBus) {
      const dirtyEvents = [
        "annotationeditorstateschanged",
        "annotationeditormodechanged",
        "switchannotationeditorparams"
      ];
      dirtyEvents.forEach(evt => {
        app.eventBus.on(evt, () => {
          isDirty = true;
        });
      });
    }
    // Aussi surveiller les modifications du storage
    const storage = app.pdfDocument?.annotationStorage;
    if (storage && storage.onSetModified) {
      const originalOnSetModified = storage.onSetModified;
      storage.onSetModified = function() {
        isDirty = true;
        if (originalOnSetModified) originalOnSetModified.call(this);
      };
    }
  }

  // Envoyer les bytes initiaux au parent après chargement complet
  async function sendInitialBytes(app, docId) {
    if (!app || !app.pdfDocument) return;
    try {
      // Utiliser saveDocument pour avoir les bytes comme PDF.js les représente
      const data = await app.pdfDocument.saveDocument();
      if (!window.parent || window.parent === window) return;
      const ab = transferableBuffer(data);
      window.parent.postMessage(
        { type: "PDFJS_LOADED", docId, bytes: ab },
        window.location.origin,
        [ab]
      );
      // Après le chargement initial, le document est "propre"
      isDirty = false;
      // Configurer le tracking des modifications
      setupDirtyTracking(app);
      console.log("[viewer_patch] PDFJS_LOADED envoyé, dirty tracking configuré");
    } catch (e) {
      console.warn("[viewer_patch] Erreur envoi bytes initiaux:", e);
    }
  }

  function patchApplication(app) {
    const { docId } = getParams();
    if (!docId) {
      console.log("[viewer_patch] Pas de docId, patch non appliqué (mode normal).");
      return;
    }

    console.log("[viewer_patch] Application du patch pour docId:", docId);

    // Override save()
    const originalSave = app.save;
    app.save = async function () {
      console.log("[viewer_patch] save() intercepté");
      await doSave();
      // Ne pas appeler l'original pour éviter le téléchargement
    };

    // Override downloadOrSave()
    const originalDownloadOrSave = app.downloadOrSave;
    app.downloadOrSave = async function () {
      console.log("[viewer_patch] downloadOrSave() intercepté");
      await doSave();
    };

    // Override download() aussi pour être sûr
    const originalDownload = app.download;
    app.download = async function () {
      console.log("[viewer_patch] download() intercepté");
      await doSave();
    };

    // Écouter les messages du parent (PDFJS_TRIGGER_SAVE pour autosave)
    window.addEventListener("message", (ev) => {
      if (ev.origin !== window.location.origin) return;
      const msg = ev.data || {};
      if (msg.type === "PDFJS_TRIGGER_SAVE" && msg.docId === docId) {
        console.log("[viewer_patch] PDFJS_TRIGGER_SAVE reçu du parent");
        void doSave();
      }
    });

    // Envoyer les bytes initiaux après chargement complet du PDF
    app.eventBus.on("documentloaded", () => {
      console.log("[viewer_patch] documentloaded event");
      // Attendre un peu que les annotations soient chargées
      setTimeout(() => sendInitialBytes(app, docId), 500);
    });

    console.log("[viewer_patch] Patch appliqué avec succès!");
  }

  // Polling robuste pour attendre que PDFViewerApplication soit disponible et initialisé
  let attempts = 0;
  const maxAttempts = 100; // 10 secondes max

  function tryPatch() {
    attempts++;
    const app = window.PDFViewerApplication;
    
    if (app && app.eventBus) {
      console.log("[viewer_patch] PDFViewerApplication trouvé après", attempts, "tentatives");
      patchApplication(app);
      return;
    }

    if (attempts < maxAttempts) {
      setTimeout(tryPatch, 100);
    } else {
      console.error("[viewer_patch] Timeout: PDFViewerApplication non trouvé après", maxAttempts, "tentatives");
    }
  }

  // Démarrer le polling
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryPatch);
  } else {
    tryPatch();
  }
})();
`;

async function patchViewerHtml(viewerHtmlPath) {
  let html = await fs.readFile(viewerHtmlPath, "utf8");
  if (html.includes("viewer_patch.js")) return;
  // Injecter le script dans le head avec defer pour qu'il se charge tôt
  html = html.replace(
    /<\/head>/i,
    '  <script src="viewer_patch.js" defer></script>\n</head>'
  );
  await fs.writeFile(viewerHtmlPath, html, "utf8");
  console.log("  - viewer.html patché");
}

// Patcher viewer.mjs pour activer enableComment et enableHighlightFloatingButton par défaut
async function patchViewerMjs(viewerMjsPath) {
  let content = await fs.readFile(viewerMjsPath, "utf8");
  let modified = false;

  // Activer enableComment: true
  if (content.includes('enableComment: {\n    value: false')) {
    content = content.replace(
      'enableComment: {\n    value: false',
      'enableComment: {\n    value: true'
    );
    modified = true;
  }

  // Activer enableHighlightFloatingButton: true
  if (content.includes('enableHighlightFloatingButton: {\n    value: false')) {
    content = content.replace(
      'enableHighlightFloatingButton: {\n    value: false',
      'enableHighlightFloatingButton: {\n    value: true'
    );
    modified = true;
  }

  if (modified) {
    await fs.writeFile(viewerMjsPath, content, "utf8");
    console.log("  - viewer.mjs patché (enableComment, enableHighlightFloatingButton activés)");
  }
}

async function main() {
  // Vérifier si PDF.js est déjà installé
  const markerFile = path.join(dst, ".pdfjs-version");
  if (await exists(markerFile)) {
    const installedVersion = (await fs.readFile(markerFile, "utf8")).trim();
    if (installedVersion === PDFJS_VERSION) {
      console.log(`PDF.js v${PDFJS_VERSION} déjà installé.`);
      return;
    }
  }

  console.log(`Téléchargement de PDF.js v${PDFJS_VERSION}...`);

  // Nettoyer le dossier destination
  await fs.rm(dst, { recursive: true, force: true });
  await fs.mkdir(dst, { recursive: true });

  // Télécharger le zip
  const zipPath = path.join(dst, "pdfjs.zip");
  await downloadFile(PDFJS_URL, zipPath);

  // Extraire
  console.log("Extraction...");
  await unzipFile(zipPath, dst);

  // Supprimer le zip
  await fs.unlink(zipPath);

  console.log("Application des patches...");

  // Écrire le patch
  const patchPath = path.join(dst, "web", "viewer_patch.js");
  await fs.writeFile(patchPath, VIEWER_PATCH, "utf8");
  console.log("  - viewer_patch.js créé");

  // Patcher viewer.html
  await patchViewerHtml(path.join(dst, "web", "viewer.html"));

  // Patcher viewer.mjs pour activer les fonctionnalités par défaut
  await patchViewerMjs(path.join(dst, "web", "viewer.mjs"));

  // Écrire le marqueur de version
  await fs.writeFile(markerFile, PDFJS_VERSION, "utf8");

  console.log(`PDF.js v${PDFJS_VERSION} installé avec succès.`);
}

main().catch((err) => {
  console.error("Erreur lors de l'installation de PDF.js:", err);
  process.exit(1);
});
