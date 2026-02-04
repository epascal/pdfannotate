export function assertDocId(docId: string) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(docId)) {
    const err = new Error("docId invalide");
    // @ts-expect-error - attach status
    err.status = 400;
    throw err;
  }
}

export function parseIntField(name: string, v: unknown): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
  if (!Number.isFinite(n)) {
    const err = new Error(`Champ invalide: ${name}`);
    // @ts-expect-error - attach status
    err.status = 400;
    throw err;
  }
  return n;
}

