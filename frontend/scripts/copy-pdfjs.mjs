/**
 * Ce script est exécuté après npm install pour télécharger et installer
 * le viewer PDF.js officiel complet (depuis les releases GitHub).
 * 
 * Il ajoute également un petit patch (viewer_patch.js) qui intercepte
 * la sauvegarde pour envoyer les bytes au parent via postMessage.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createUnzip } from "node:zlib";
import { Extract } from "unzipper";

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

const VIEWER_PATCH = `/**
 * Patch pour intercepter la sauvegarde PDF.js et envoyer les bytes au parent (app React).
 * Injecté dans viewer.html après le chargement de PDFViewerApplication.
 */
(function () {
  "use strict";

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
      console.warn("[viewer_patch] Pas de parent, sauvegarde locale ignorée.");
      return;
    }
    try {
      const ab = transferableBuffer(bytes);
      window.parent.postMessage(
        { type: "PDFJS_SAVE", docId, bytes: ab },
        window.location.origin,
        [ab]
      );
      console.log("[viewer_patch] PDFJS_SAVE envoyé au parent.");
    } catch (e) {
      console.error("[viewer_patch] Erreur postMessage:", e);
    }
  }

  let saveInProgress = false;

  async function doSave() {
    const { docId } = getParams();
    if (!docId) {
      console.warn("[viewer_patch] Pas de docId, sauvegarde annulée.");
      return;
    }
    const app = window.PDFViewerApplication;
    if (!app || !app.pdfDocument) {
      console.warn("[viewer_patch] PDF non chargé.");
      return;
    }
    if (saveInProgress) return;
    saveInProgress = true;

    try {
      await app.pdfScriptingManager?.dispatchWillSave?.();
      const data = await app.pdfDocument.saveDocument();
      postSave(docId, data);
    } catch (e) {
      console.error("[viewer_patch] Erreur lors de la sauvegarde:", e);
      try {
        const data = await app.pdfDocument.getData();
        postSave(docId, data);
      } catch (e2) {
        console.error("[viewer_patch] Fallback getData échoué:", e2);
      }
    } finally {
      try {
        await app.pdfScriptingManager?.dispatchDidSave?.();
      } catch {}
      saveInProgress = false;
    }
  }

  function patchPDFViewerApplication() {
    const app = window.PDFViewerApplication;
    if (!app) {
      console.warn("[viewer_patch] PDFViewerApplication non trouvé.");
      return;
    }

    const { docId } = getParams();
    if (!docId) {
      console.log("[viewer_patch] Pas de docId, patch non appliqué (mode normal).");
      return;
    }

    app.save = async function () {
      console.log("[viewer_patch] save() intercepté.");
      await doSave();
    };

    app.downloadOrSave = async function () {
      console.log("[viewer_patch] downloadOrSave() intercepté.");
      await doSave();
    };

    window.addEventListener("message", (ev) => {
      if (ev.origin !== window.location.origin) return;
      const msg = ev.data || {};
      if (msg.type === "PDFJS_TRIGGER_SAVE" && msg.docId === docId) {
        console.log("[viewer_patch] PDFJS_TRIGGER_SAVE reçu.");
        void doSave();
      }
    });

    console.log("[viewer_patch] Patch appliqué pour docId:", docId);
  }

  document.addEventListener("webviewerloaded", () => {
    setTimeout(patchPDFViewerApplication, 100);
  });

  if (window.PDFViewerApplication) {
    setTimeout(patchPDFViewerApplication, 100);
  }
})();
`;

async function patchViewerHtml(viewerHtmlPath) {
  let html = await fs.readFile(viewerHtmlPath, "utf8");
  if (html.includes("viewer_patch.js")) return;
  html = html.replace(
    /<\\/body>/i,
    '  <script src="viewer_patch.js"></script>\\n</body>'
  );
  await fs.writeFile(viewerHtmlPath, html, "utf8");
}

async function main() {
  // Vérifier si PDF.js est déjà installé
  const markerFile = path.join(dst, ".pdfjs-version");
  if (await exists(markerFile)) {
    const installedVersion = (await fs.readFile(markerFile, "utf8")).trim();
    if (installedVersion === PDFJS_VERSION) {
      console.log(\`PDF.js v\${PDFJS_VERSION} déjà installé.\`);
      return;
    }
  }

  console.log(\`Téléchargement de PDF.js v\${PDFJS_VERSION}...\`);

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

  // Écrire le patch
  const patchPath = path.join(dst, "web", "viewer_patch.js");
  await fs.writeFile(patchPath, VIEWER_PATCH, "utf8");

  // Patcher viewer.html
  await patchViewerHtml(path.join(dst, "web", "viewer.html"));

  // Écrire le marqueur de version
  await fs.writeFile(markerFile, PDFJS_VERSION, "utf8");

  console.log(\`PDF.js v\${PDFJS_VERSION} installé avec succès.\`);
}

main().catch((err) => {
  console.error("Erreur lors de l'installation de PDF.js:", err);
  process.exit(1);
});
