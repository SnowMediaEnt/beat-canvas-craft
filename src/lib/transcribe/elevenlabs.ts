import { get, set, del } from "idb-keyval";
import type { TranscribedWord } from "@/lib/lyrics/types";

export type TranscribeStatus = "idle" | "uploading" | "transcribing" | "ready" | "error";

interface Entry {
  status: TranscribeStatus;
  words?: TranscribedWord[];
  error?: string;
  promise?: Promise<TranscribedWord[]>;
}

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const hydrating = new Map<string, Promise<TranscribedWord[] | undefined>>();

const idbKey = (assetId: string) => `transcript:v2:${assetId}`;

function notify() {
  for (const l of listeners) l();
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getEntry(assetId: string | undefined): Entry | undefined {
  if (!assetId) return undefined;
  const existing = cache.get(assetId);
  if (existing) return existing;
  // Kick off async hydration from IndexedDB; subscribers notified on load.
  hydrateFromIdb(assetId);
  return undefined;
}

export function hydrateFromIdb(assetId: string): Promise<TranscribedWord[] | undefined> {
  const inFlight = hydrating.get(assetId);
  if (inFlight) return inFlight;
  const cur = cache.get(assetId);
  if (cur?.status === "ready" && cur.words) return Promise.resolve(cur.words);
  const p = (async () => {
    try {
      const stored = await get<TranscribedWord[]>(idbKey(assetId));
      if (stored && Array.isArray(stored) && stored.length && !cache.get(assetId)) {
        cache.set(assetId, { status: "ready", words: stored });
        notify();
        console.log(`[elevenlabs-direct] hydrated ${stored.length} cached words for ${assetId}`);
        return stored;
      }
    } catch (e) {
      console.warn("[elevenlabs-direct] idb hydrate failed", e);
    }
    return undefined;
  })();
  hydrating.set(assetId, p);
  p.finally(() => hydrating.delete(assetId));
  return p;
}

// Server-side transcription proxy. The API key stays on the server; the client
// only ever POSTs audio here and receives the transcript. (Previously this
// module fetched the raw ElevenLabs key from /api/public/elevenlabs-key and
// called ElevenLabs directly from the browser, which exposed the key.)
const TRANSCRIBE_PATH = "/api/public/elevenlabs-key";

async function runTranscription(file: Blob, filename: string): Promise<TranscribedWord[]> {
  const fd = new FormData();
  fd.append("file", file, filename);
  fd.append("model_id", "scribe_v2");
  fd.append("timestamps_granularity", "word");
  fd.append("diarize", "false");
  fd.append("tag_audio_events", "false");

  console.log(`[elevenlabs] POST starting | size=${(file.size / 1024 / 1024).toFixed(2)}MB | filename=${filename}`);
  const t0 = Date.now();
  const res = await fetch(TRANSCRIBE_PATH, {
    method: "POST",
    body: fd,
  });
  const dt = Date.now() - t0;
  console.log(`[elevenlabs] Response received | status=${res.status} | duration=${dt}ms`);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Transcription ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    text?: string;
    words?: Array<{ text: string; start: number; end: number; type?: string }>;
  };
  const words: TranscribedWord[] = (data.words ?? [])
    .filter((w) => (w.type ?? "word") === "word" && typeof w.start === "number")
    .map((w) => ({ text: w.text, start: w.start, end: w.end }));
  let longestGap = 0;
  for (let i = 1; i < words.length; i++) {
    const g = words[i].start - words[i - 1].end;
    if (g > longestGap) longestGap = g;
  }
  const covered = words.length ? words[words.length - 1].end - words[0].start : 0;
  console.log(`[elevenlabs-direct] ${words.length} words | covered ${covered.toFixed(1)}s | longest gap ${longestGap.toFixed(1)}s`);
  return words;
}

/**
 * Kick off transcription in the background. Safe to call repeatedly —
 * returns the existing promise/result if one is already in flight or ready.
 */
export function transcribeInBackground(assetId: string, file: Blob, filename: string): Promise<TranscribedWord[]> {
  const existing = cache.get(assetId);
  if (existing?.status === "ready" && existing.words) return Promise.resolve(existing.words);
  if (existing?.promise) return existing.promise;

  const entry: Entry = { status: "uploading" };
  cache.set(assetId, entry);
  notify();

  const promise = (async () => {
    try {
      // Check persistent cache first — survives reloads.
      const stored = await get<TranscribedWord[]>(idbKey(assetId)).catch(() => undefined);
      if (stored && Array.isArray(stored) && stored.length) {
        entry.status = "ready";
        entry.words = stored;
        entry.error = undefined;
        notify();
        console.log(`[elevenlabs-direct] reused ${stored.length} cached words for ${assetId}`);
        return stored;
      }
      entry.status = "transcribing";
      notify();
      const words = await runTranscription(file, filename);
      entry.status = "ready";
      entry.words = words;
      entry.error = undefined;
      try { await set(idbKey(assetId), words); } catch (e) { console.warn("[elevenlabs-direct] idb persist failed", e); }
      notify();
      return words;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[elevenlabs-direct] error:", msg);
      entry.status = "error";
      entry.error = msg;
      notify();
      throw e;
    } finally {
      entry.promise = undefined;
    }
  })();

  entry.promise = promise;
  promise.catch(() => {});
  return promise;
}

export function retryTranscription(assetId: string, file: Blob, filename: string) {
  cache.delete(assetId);
  del(idbKey(assetId)).catch(() => {});
  notify();
  return transcribeInBackground(assetId, file, filename);
}

export async function ensureTranscription(assetId: string, file: Blob, filename: string): Promise<TranscribedWord[]> {
  const existing = cache.get(assetId);
  if (existing?.status === "ready" && existing.words) return existing.words;
  if (existing?.promise) return existing.promise;
  const hydrated = await hydrateFromIdb(assetId);
  if (hydrated && hydrated.length) return hydrated;
  return transcribeInBackground(assetId, file, filename);
}
