const fs = require('fs');
const path = require('path');
const session = require('express-session');
const sqlite3 = require('sqlite3');

function sessionExpiryTimestamp(sessionData) {
  const expires = sessionData?.cookie?.expires;
  if (expires) {
    const timestamp = new Date(expires).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }

  const maxAge = Number(sessionData?.cookie?.maxAge);
  return Date.now() + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 24 * 60 * 60 * 1000);
}

class SQLiteSessionStore extends session.Store {
  constructor(databaseFile) {
    super();
    this.databaseFile = databaseFile;
    this.database = null;
    this.readyPromise = null;
    this.lastTouchAt = new Map();
    this.touchThrottleMs = 5 * 60 * 1000;
    this.cleanupTimer = setInterval(() => this.pruneExpired(() => {}), 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  ensureReady() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      fs.mkdirSync(path.dirname(this.databaseFile), { recursive: true });
      const database = new sqlite3.Database(this.databaseFile, error => {
        if (error) return reject(error);
        database.configure('busyTimeout', 15000);
        return database.run('PRAGMA synchronous = NORMAL', pragmaError => {
          if (pragmaError) return reject(pragmaError);
          return database.run(
            `CREATE TABLE IF NOT EXISTS sessions (
               sid TEXT PRIMARY KEY,
               sess TEXT NOT NULL,
               expires INTEGER NOT NULL
             )`,
            createError => {
              if (createError) return reject(createError);
              this.database = database;
              return database.run(
                'CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires)',
                indexError => indexError ? reject(indexError) : resolve(database)
              );
            }
          );
        });
      });
    }).catch(error => {
      this.readyPromise = null;
      throw error;
    });
    return this.readyPromise;
  }

  get(sid, callback) {
    this.ensureReady().then(database => {
      database.get('SELECT sess, expires FROM sessions WHERE sid = ?', [sid], (error, row) => {
        if (error) return callback(error);
        if (!row) return callback(null, null);
        if (Number(row.expires) <= Date.now()) {
          this.lastTouchAt.delete(sid);
          return database.run('DELETE FROM sessions WHERE sid = ?', [sid], deleteError => callback(deleteError || null, null));
        }
        try {
          return callback(null, JSON.parse(row.sess));
        } catch (parseError) {
          return database.run('DELETE FROM sessions WHERE sid = ?', [sid], () => callback(parseError));
        }
      });
    }).catch(callback);
  }

  set(sid, sessionData, callback = () => {}) {
    let payload;
    try {
      payload = JSON.stringify(sessionData);
    } catch (error) {
      callback(error);
      return;
    }
    const expires = sessionExpiryTimestamp(sessionData);
    this.ensureReady().then(database => {
      this.lastTouchAt.set(sid, Date.now());
      database.run(
        `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`,
        [sid, payload, expires],
        callback
      );
    }).catch(callback);
  }

  touch(sid, sessionData, callback = () => {}) {
    const expires = sessionExpiryTimestamp(sessionData);
    const now = Date.now();
    const lastTouch = this.lastTouchAt.get(sid) || 0;
    if (now - lastTouch < this.touchThrottleMs) {
      process.nextTick(callback);
      return;
    }

    this.ensureReady().then(database => {
      this.lastTouchAt.set(sid, now);
      database.run('UPDATE sessions SET expires = ? WHERE sid = ?', [expires, sid], callback);
    }).catch(callback);
  }

  destroy(sid, callback = () => {}) {
    this.lastTouchAt.delete(sid);
    this.ensureReady().then(database => {
      database.run('DELETE FROM sessions WHERE sid = ?', [sid], callback);
    }).catch(callback);
  }

  clear(callback = () => {}) {
    this.lastTouchAt.clear();
    this.ensureReady().then(database => {
      database.run('DELETE FROM sessions', callback);
    }).catch(callback);
  }

  length(callback) {
    this.ensureReady().then(database => {
      database.get('SELECT COUNT(*) AS count FROM sessions WHERE expires > ?', [Date.now()], (error, row) => {
        callback(error, row?.count || 0);
      });
    }).catch(callback);
  }

  pruneExpired(callback = () => {}) {
    const cutoff = Date.now() - this.touchThrottleMs;
    this.lastTouchAt.forEach((touchedAt, sid) => {
      if (touchedAt < cutoff) this.lastTouchAt.delete(sid);
    });
    this.ensureReady().then(database => {
      database.run('DELETE FROM sessions WHERE expires <= ?', [Date.now()], callback);
    }).catch(callback);
  }

  close(callback = () => {}) {
    clearInterval(this.cleanupTimer);
    if (!this.database) {
      callback();
      return;
    }
    const database = this.database;
    this.database = null;
    this.readyPromise = null;
    this.lastTouchAt.clear();
    database.close(callback);
  }
}

module.exports = { SQLiteSessionStore, sessionExpiryTimestamp };
