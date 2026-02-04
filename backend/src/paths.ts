import path from "node:path";

export const projectRoot = path.resolve(__dirname, "..");
export const dataDir = path.join(projectRoot, "data");
export const pdfDir = path.join(dataDir, "pdfs");
export const sqlitePath = path.join(dataDir, "index.sqlite");

