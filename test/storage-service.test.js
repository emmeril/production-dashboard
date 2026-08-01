const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DataTypes } = require('sequelize');
const { createStorageService } = require('../src/infrastructure/storage/service');

function createTestStorage({ authenticate = async () => {}, upsertSnapshot = async () => {} } = {}) {
  const appDataModel = {};
  const snapshotModel = { upsert: upsertSnapshot };
  const sequelize = {
    authenticate,
    define(name) {
      return name === 'ProductionSnapshot' ? snapshotModel : appDataModel;
    }
  };

  return createStorageService({
    DataTypes,
    crypto,
    fs: {},
    logger: { error() {}, info() {}, warn() {} },
    sequelize,
    zlib
  });
}

test('failed snapshot writes are reported and never inserted into the cache', async () => {
  const storage = createTestStorage({
    upsertSnapshot: async () => {
      throw new Error('snapshot disk failure');
    }
  });

  storage.storeProductionSnapshot(
    'data_2026-08-02.json',
    '2026-08-02',
    'daily',
    { lines: {} }
  );

  await assert.rejects(storage.flushPendingDatabaseWrites(), /snapshot disk failure/);
  assert.equal(storage.productionSnapshotCache.has('data_2026-08-02.json'), false);
  await storage.flushPendingDatabaseWrites();
});

test('storage initialization rejects when the database cannot be opened', async () => {
  const storage = createTestStorage({
    authenticate: async () => {
      throw new Error('database unavailable');
    }
  });

  await assert.rejects(storage.initSequelizeStorage(), /database unavailable/);
});
