import { ImportResult } from "./types";

const DB_NAME = "tou-analyzer";
const DB_VERSION = 1;
const STORE_NAME = "imports";
const CURRENT_KEY = "current";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveCurrentImport(result: ImportResult): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(result, CURRENT_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function loadCurrentImport(): Promise<ImportResult | null> {
  const db = await openDb();
  const result = await new Promise<ImportResult | null>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(CURRENT_KEY);
    request.onsuccess = () => resolve((request.result as ImportResult | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  if (result && result.sourceKind !== "csv" && result.sourceKind !== "parquet" && result.sourceKind !== "sample") {
    return null;
  }
  if (result && (result.sourceKind === "csv" || result.sourceKind === "parquet") && !result.dataSource?.file) {
    return null;
  }
  if (result && !result.dataSource) {
    return null;
  }
  if (result?.dataSource) {
    result.dataSource = { ...result.dataSource, loaded: false };
  }
  return result;
}

export async function clearCurrentImport(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(CURRENT_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}
