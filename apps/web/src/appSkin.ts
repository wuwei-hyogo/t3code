import type { ClientSettings } from "@t3tools/contracts";

import { APP_SKIN_MAX_BYTES, type AppSkinImageType, detectAppSkinImageType } from "./appSkinImage";
import { getClientSettings, subscribeClientSettings } from "./hooks/useSettings";

export type AppSkinImage = Readonly<{
  url: string;
  name: string;
  type: AppSkinImageType;
  size: number;
  width: number;
  height: number;
}>;

export type AppSkinFailure = "unsupported" | "too-large" | "unreadable" | "storage";

type StoredAppSkin = Readonly<{
  blob: Blob;
  name: string;
  type: AppSkinImageType;
  width: number;
  height: number;
}>;

const DATABASE_NAME = "t3code:app-skin";
const DATABASE_VERSION = 1;
const STORE_NAME = "images";
const IMAGE_KEY = "current";
const CHANNEL_NAME = "t3code:app-skin";
const LAYER_ID = "app-skin-layer";

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => {
      database = undefined;
      reject(request.error);
    });
    request.addEventListener("blocked", () => {
      database = undefined;
      reject(new Error("Skin storage is blocked."));
    });
  }));
}

async function withStore<A>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<A> | void,
): Promise<A | undefined> {
  const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
  const request = use(transaction.objectStore(STORE_NAME));
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  return request?.result;
}

function isStoredAppSkin(value: unknown): value is StoredAppSkin {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.blob instanceof Blob &&
    typeof record.name === "string" &&
    typeof record.type === "string" &&
    typeof record.width === "number" &&
    typeof record.height === "number"
  );
}

let current: AppSkinImage | null = null;
let generation = 0;
const listeners = new Set<() => void>();
let layer: HTMLDivElement | null = null;
let channel: BroadcastChannel | null = null;

function notifyOtherTabs(): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel is scoped to the origin
  channel?.postMessage("changed");
}

export function getAppSkinSnapshot(): AppSkinImage | null {
  return current;
}

export function subscribeAppSkin(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function render(settings: ClientSettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (current === null) {
    layer?.remove();
    delete root.dataset.appSkin;
    return;
  }
  if (layer === null) {
    layer = document.createElement("div");
    layer.id = LAYER_ID;
    layer.setAttribute("aria-hidden", "true");
  }
  if (!layer.isConnected) document.body.prepend(layer);
  layer.style.setProperty("--app-skin-image", `url("${current.url}")`);
  layer.style.setProperty("--app-skin-veil", `${settings.appSkinVeil}%`);
  layer.dataset.fit = settings.appSkinFit;
  root.dataset.appSkin = "";
}

function show(next: AppSkinImage | null): void {
  const previous = current;
  current = next;
  render(getClientSettings());
  if (previous !== null && previous.url !== next?.url) URL.revokeObjectURL(previous.url);
  for (const listener of listeners) listener();
}

function toImage(stored: StoredAppSkin): AppSkinImage {
  return {
    url: URL.createObjectURL(stored.blob),
    name: stored.name,
    type: stored.type,
    size: stored.blob.size,
    width: stored.width,
    height: stored.height,
  };
}

async function loadStored(): Promise<void> {
  const loadGeneration = ++generation;
  const stored = await withStore("readonly", (store) => store.get(IMAGE_KEY)).catch(
    () => undefined,
  );
  if (loadGeneration !== generation) return;
  show(isStoredAppSkin(stored) ? toImage(stored) : null);
}

async function decodedSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  const bitmap = await createImageBitmap(blob).catch(() => null);
  if (bitmap === null) return null;
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size.width > 0 && size.height > 0 ? size : null;
}

/** Saves `file` as this client's skin. The browser must decode it, so a corrupt file is refused. */
export async function setAppSkinImage(
  file: Blob & { readonly name?: string },
): Promise<{ ok: true } | { ok: false; reason: AppSkinFailure }> {
  if (file.size > APP_SKIN_MAX_BYTES) return { ok: false, reason: "too-large" };
  const header = await file
    .slice(0, 64)
    .arrayBuffer()
    .then(
      (buffer) => new Uint8Array(buffer),
      () => null,
    );
  if (header === null) return { ok: false, reason: "unreadable" };
  const type = detectAppSkinImageType(header);
  if (type === null) return { ok: false, reason: "unsupported" };
  const blob = new Blob([file], { type });
  const size = await decodedSize(blob);
  if (size === null) return { ok: false, reason: "unreadable" };
  const stored: StoredAppSkin = { blob, name: file.name ?? "", type, ...size };
  const saved = await withStore("readwrite", (store) => store.put(stored, IMAGE_KEY)).then(
    () => true,
    () => false,
  );
  if (!saved) return { ok: false, reason: "storage" };
  generation++;
  show(toImage(stored));
  notifyOtherTabs();
  return { ok: true };
}

export async function removeAppSkinImage(): Promise<boolean> {
  const removed = await withStore("readwrite", (store) => store.delete(IMAGE_KEY)).then(
    () => true,
    () => false,
  );
  if (!removed) return false;
  generation++;
  show(null);
  notifyOtherTabs();
  return true;
}

export function startAppSkin(): () => void {
  if (typeof indexedDB === "undefined") return () => undefined;
  const unsubscribeSettings = subscribeClientSettings(() => render(getClientSettings()));
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener("message", () => void loadStored());
  }
  void loadStored();
  return () => {
    unsubscribeSettings();
    channel?.close();
    channel = null;
    generation++;
    show(null);
  };
}
