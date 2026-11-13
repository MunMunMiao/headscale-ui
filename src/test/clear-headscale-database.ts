import { __resetForTest, DB_NAME } from "@/lib/idb";

/** Drop the real browser database so one Chromium profile cannot leak between tests. */
export function clearHeadscaleDatabase(): Promise<void> {
  __resetForTest();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
