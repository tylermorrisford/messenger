import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { IdentityKeys } from './keys';

export interface StoredIdentity extends IdentityKeys {
  userId: string;
  keyVersion: number;
}

interface MessengerDB extends DBSchema {
  identity: { key: string; value: StoredIdentity };
}

let database: Promise<IDBPDatabase<MessengerDB>> | undefined;

function db(): Promise<IDBPDatabase<MessengerDB>> {
  database ??= openDB<MessengerDB>('messenger', 1, {
    upgrade(upgrade) {
      upgrade.createObjectStore('identity');
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

export async function clearIdentity(): Promise<void> {
  await (await db()).clear('identity');
}
