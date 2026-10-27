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

interface MessengerDB extends DBSchema {
  identity: { key: string; value: StoredIdentity };
  conversationKeys: { key: [string, number]; value: StoredConversationKey };
}

let database: Promise<IDBPDatabase<MessengerDB>> | undefined;

function db(): Promise<IDBPDatabase<MessengerDB>> {
  database ??= openDB<MessengerDB>('messenger', 2, {
    upgrade(upgrade, oldVersion) {
      if (oldVersion < 1) {
        upgrade.createObjectStore('identity');
      }
      if (oldVersion < 2) {
        upgrade.createObjectStore('conversationKeys', { keyPath: ['conversationId', 'epoch'] });
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

/** Drops everything secret; called on logout and when the stored session turns out to be dead */
export async function clearKeys(): Promise<void> {
  const tx = (await db()).transaction(['identity', 'conversationKeys'], 'readwrite');

  await Promise.all([tx.objectStore('identity').clear(), tx.objectStore('conversationKeys').clear(), tx.done]);
}
