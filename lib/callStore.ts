// In-memory call score store. Survives Next dev HMR via globalThis. No DB.
import { CallScore } from "./scoring";

const g = globalThis as any;
if (!g.__dealripeCallStore) {
  g.__dealripeCallStore = new Map<string, CallScore[]>();
}
const store: Map<string, CallScore[]> = g.__dealripeCallStore;

export function addScore(dealId: string, score: CallScore) {
  const arr = store.get(dealId) || [];
  arr.unshift(score); // newest first
  store.set(dealId, arr);
}

export function getScores(dealId: string): CallScore[] {
  return store.get(dealId) || [];
}

export function getLatestScore(dealId: string): CallScore | null {
  const arr = store.get(dealId);
  return arr && arr.length > 0 ? arr[0] : null;
}
