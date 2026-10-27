import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { IdentityKeys } from './keys';

export interface StoredIdentity extends IdentityKeys {
  userId: string;
  keyVersion: number;
}

export interface StoredConversationKey {
  conversationId: string;
  epoch: number;
  key: Uint8Array;
}

/** The public keys trusted for another user, set the first time they are seen */
export interface StoredPin {
  userId: string;
  keyVersion: number;
  x25519Pub: string;
  ed25519Pub: string;
}

export interface PublicKeys {
  version: number;
  x25519Pub: string;
  ed25519Pub: string;
}

interface MessengerDB extends DBSchema {
  identity: { key: string; value: StoredIdentity };
  conversationKeys: { key: [string, number]; value: StoredConversationKey };
  pins: { key: string; value: StoredPin };
}

let database: Promise<IDBPDatabase<MessengerDB>> | undefined;

function db(): Promise<IDBPDatabase<MessengerDB>> {
  database ??= openDB<MessengerDB>('messenger', 3, {
    upgrade(upgrade, oldVersion) {
      if (oldVersion < 1) {
        upgrade.createObjectStore('identity');
      }
      if (oldVersion < 2) {
        upgrade.createObjectStore('conversationKeys', { keyPath: ['conversationId', 'epoch'] });
      }
      if (oldVersion < 3) {
        upgrade.createObjectStore('pins', { keyPath: 'userId' });
      }
    },
  });

  return database;
}

export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  await (await db()).put('identity', identity, 'current');
}

export async function loadIdentity(): Promise<StoredIdentity | undefined> {
  return (await db()).get('identity', 'current');
}

export async function saveConversationKey(key: StoredConversationKey): Promise<void> {
  await (await db()).put('conversationKeys', key);
}

/** Every epoch key cached for a conversation, oldest epoch first */
export async function loadConversationKeys(conversationId: string): Promise<StoredConversationKey[]> {
  return (await db()).getAll('conversationKeys', IDBKeyRange.bound([conversationId, 0], [conversationId, Infinity]));
}

export async function savePin(pin: StoredPin): Promise<void> {
  await (await db()).put('pins', pin);
}

export async function loadPin(userId: string): Promise<StoredPin | undefined> {
  return (await db()).get('pins', userId);
}

/** Trust on first use: pins the first key seen for a user and returns the pin when a later key differs */
export async function checkPin(userId: string, current: PublicKeys): Promise<StoredPin | null> {
  const pinned = await loadPin(userId);

  if (!pinned) {
    await savePin({ userId, keyVersion: current.version, x25519Pub: current.x25519Pub, ed25519Pub: current.ed25519Pub });
    return null;
  }

  return pinned.ed25519Pub === current.ed25519Pub && pinned.x25519Pub === current.x25519Pub ? null : pinned;
}

/** Drops everything secret; called on logout and when the stored session turns out to be dead. Pins stay: they are trust, not secrets */
export async function clearKeys(): Promise<void> {
  const tx = (await db()).transaction(['identity', 'conversationKeys'], 'readwrite');

  await Promise.all([tx.objectStore('identity').clear(), tx.objectStore('conversationKeys').clear(), tx.done]);
}
