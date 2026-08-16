const path = require('path');
const fs = require('fs');
let sqlite3;

try {
  sqlite3 = require('sqlite3').verbose();
} catch (err) {
  // sqlite3 may not be available in all hosting environments
  sqlite3 = null;
}

const dataDir = path.join(__dirname, '../../data');
const dbPath = path.join(dataDir, 'ledger.db');

let db = null;
let available = false;
let sqliteReady = false;
let sqliteProven = false;
let initPromise = null;

const markSqliteUnavailable = (message) => {
  available = false;
  sqliteReady = false;
  sqliteProven = false;
  db = null;
  initPromise = null;
  if (message) {
    console.error(message);
  }
};

const ensureLedgerReady = async () => {
  if (!sqlite3) {
    sqliteReady = false;
    sqliteProven = false;
    available = false;
    db = null;
    return false;
  }

  if (sqliteReady && available && db) {
    return true;
  }

  if (!initPromise) {
    initPromise = new Promise((resolve) => {
      sqliteReady = false;
      sqliteProven = false;
      available = false;

      try {
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }

        db = new sqlite3.Database(dbPath, (err) => {
          if (err) {
            markSqliteUnavailable(`Failed to open ledger database: ${err.message}`);
            resolve(false);
            return;
          }

          const sql = `
            CREATE TABLE IF NOT EXISTS ledger_entries (
              id TEXT PRIMARY KEY,
              created_at TEXT NOT NULL,
              record_type TEXT NOT NULL,
              brief_version TEXT,
              content_hash TEXT,
              content_encrypted TEXT,
              author_pubkey TEXT,
              signature TEXT,
              prev_hash TEXT,
              status TEXT,
              board_note TEXT
            );
          `;

          db.run(sql, (err2) => {
            if (err2) {
              markSqliteUnavailable(`Failed to initialize ledger schema: ${err2.message}`);
              resolve(false);
              return;
            }

            db.get('SELECT 1 AS ok', (probeErr) => {
              if (probeErr) {
                markSqliteUnavailable(`SQLite probe failed: ${probeErr.message}`);
                resolve(false);
                return;
              }
              available = true;
              sqliteReady = true;
              sqliteProven = true;
              resolve(true);
            });
          });
        });
      } catch (err) {
        markSqliteUnavailable(`Ledger initialization error: ${err.message}`);
        resolve(false);
      }
    });
  }

  return initPromise;
};

// Attempt to initialize ledger but do not throw on failure.
ensureLedgerReady().catch(() => false);

const fallbackAvailable = () => {
  try {
    ensureFallbackLedgerReady();
    const testFile = path.join(dataDir, `.fallback-${Date.now()}.tmp`);
    fs.writeFileSync(testFile, 'ok', 'utf8');
    fs.unlinkSync(testFile);
    return true;
  } catch (err) {
    return false;
  }
};

const cleanupLedgerFiles = () => {
  const filesToRemove = [dbPath, `${dbPath}-shm`, `${dbPath}-wal`];
  for (const filePathToRemove of filesToRemove) {
    try {
      if (fs.existsSync(filePathToRemove)) {
        fs.unlinkSync(filePathToRemove);
      }
    } catch (err) {
      console.error('Failed to remove ledger file:', filePathToRemove, err.message);
    }
  }
};

const resetLedgerStorage = async () => {
  return new Promise((resolve) => {
    const finalizeReset = () => {
      db = null;
      available = false;
      sqliteReady = false;
      initPromise = null;
      cleanupLedgerFiles();
      ensureLedgerReady();
      resolve(true);
    };

    if (db) {
      db.close((err) => {
        if (err) {
          console.error('Failed to close ledger DB during reset:', err.message);
        }
        finalizeReset();
      });
    } else {
      finalizeReset();
    }
  });
};

const isSqliteReallyAvailable = () => {
  if (!sqliteProven || !sqliteReady || !available || !db) return false;
  try {
    return typeof db.all === 'function' && typeof db.run === 'function';
  } catch (err) {
    return false;
  }
};

const getLedgerStatus = async () => {
  await ensureLedgerReady();
  const sqliteAvailable = isSqliteReallyAvailable();
  const fallbackAvailableNow = fallbackAvailable();
  const availableNow = sqliteAvailable || fallbackAvailableNow;
  const type = sqliteAvailable ? 'sqlite' : (fallbackAvailableNow ? 'sqlite fallback' : 'unavailable');
  return {
    available: availableNow,
    type,
    height: await getLedgerHeight(),
  };
};

const isAvailable = () => isSqliteReallyAvailable() || fallbackAvailable();

const ledgerType = () => {
  if (isSqliteReallyAvailable()) return 'sqlite';
  if (fallbackAvailable()) return 'sqlite fallback';
  return 'unavailable';
};

const getLedgerHeight = () => {
  return new Promise((resolve, reject) => {
    if (available && db && sqliteProven) {
      return db.get('SELECT COUNT(*) AS count FROM ledger_entries', (err, row) => {
        if (err) {
          console.error('Failed to query ledger height:', err.message);
          markSqliteUnavailable(`SQLite query failed while reading height: ${err.message}`);
          return resolve(0);
        }
        return resolve(row ? row.count : 0);
      });
    }

    try {
      if (!fs.existsSync(fallbackPath)) {
        return resolve(0);
      }

      const data = fs.readFileSync(fallbackPath, 'utf8').trim();
      if (!data) {
        return resolve(0);
      }

      const lines = data.split(/\r?\n/).filter(Boolean);
      return resolve(lines.length);
    } catch (err) {
      console.error('Failed to read fallback ledger height:', err.message);
      return resolve(0);
    }
  });
};

const getEntries = ({ limit = 50, offset = 0 } = {}) => {
  return new Promise((resolve, reject) => {
    if (!available || !db || !sqliteProven) {
      return resolve([]);
    }

    db.all(
      'SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [limit, offset],
      (err, rows) => {
        if (err) {
          console.error('Failed to read ledger entries:', err.message);
          markSqliteUnavailable(`SQLite query failed while reading entries: ${err.message}`);
          return resolve([]);
        }
        resolve(rows);
      }
    );
  });
};

// JSON-file fallback ledger implementation
const crypto = require('crypto');
const uuid = (typeof crypto.randomUUID === 'function') ? crypto.randomUUID : () => {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c => (c ^ crypto.randomBytes(1)[0] & 15 >> c / 4).toString(16));
};

const fallbackPath = path.join(dataDir, 'ledger.jsonl');

const ensureFallbackLedgerReady = () => {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    if (!fs.existsSync(fallbackPath)) {
      fs.writeFileSync(fallbackPath, '', 'utf8');
    }
    return true;
  } catch (err) {
    console.error('Failed to initialize ledger fallback storage:', err.message);
    return false;
  }
};

const normalizePem = (rawPem) => {
  if (!rawPem) return null;
  let normalized = String(rawPem).trim();
  normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.indexOf('\\n') !== -1) {
    normalized = normalized.replace(/\\n/g, '\n');
  }
  return normalized;
};

const ensurePublicKeyPem = (rawKey) => {
  const normalized = normalizePem(rawKey);
  if (!normalized) return null;

  if (/-----BEGIN [A-Z ]+-----/.test(normalized)) {
    return normalized;
  }

  const bare = normalized.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(bare)) {
    const lines = bare.match(/.{1,64}/g) || [bare];
    return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
  }

  return normalized;
};

const getEnvNodePublicKey = () => {
  if (process.env.NODE_PUBLIC_KEY) {
    return ensurePublicKeyPem(process.env.NODE_PUBLIC_KEY);
  }

  if (process.env.NODE_PUBLIC_KEY_B64) {
    try {
      return ensurePublicKeyPem(Buffer.from(process.env.NODE_PUBLIC_KEY_B64, 'base64').toString('utf8'));
    } catch (err) {
      return null;
    }
  }

  return null;
};

const getPrivateKeyInfo = () => {
  const tryCreateKey = (rawKey, source) => {
    if (!rawKey) {
      return { private_key_present: false, private_key_source: null, private_key_valid: false, private_key_error: null, keyObject: null };
    }

    if (rawKey.indexOf('\\n') !== -1) {
      rawKey = rawKey.replace(/\\n/g, '\n');
    }

    try {
      const keyObject = crypto.createPrivateKey(rawKey);
      return { private_key_present: true, private_key_source: source, private_key_valid: true, private_key_error: null, keyObject };
    } catch (err) {
      try {
        const keyObject = crypto.createPrivateKey({ key: rawKey, format: 'pem', type: 'pkcs8' });
        return { private_key_present: true, private_key_source: source, private_key_valid: true, private_key_error: null, keyObject };
      } catch (innerErr) {
        return { private_key_present: true, private_key_source: source, private_key_valid: false, private_key_error: innerErr.message, keyObject: null };
      }
    }
  };

  let pk = process.env.NODE_PRIVATE_KEY || null;
  if (pk) {
    const info = tryCreateKey(pk, 'NODE_PRIVATE_KEY');
    if (info.private_key_valid || !process.env.NODE_PRIVATE_KEY_B64) {
      return info;
    }
  }

  if (process.env.NODE_PRIVATE_KEY_B64) {
    let pkB64 = process.env.NODE_PRIVATE_KEY_B64;
    try {
      pkB64 = Buffer.from(pkB64, 'base64').toString('utf8');
    } catch (err) {
      return { private_key_present: true, private_key_source: 'NODE_PRIVATE_KEY_B64', private_key_valid: false, private_key_error: 'Invalid base64', keyObject: null };
    }
    return tryCreateKey(pkB64, 'NODE_PRIVATE_KEY_B64');
  }

  return { private_key_present: false, private_key_source: null, private_key_valid: false, private_key_error: null, keyObject: null };
};

const getPublicKeyPemFromPrivate = (keyObject) => {
  try {
    return crypto.createPublicKey(keyObject).export({ type: 'spki', format: 'pem' }).trim();
  } catch (err) {
    return null;
  }
};

const appendFallbackRecord = async (opts = {}) => {
  // opts: { record_type, brief_version, content_plain }
  const id = uuid();
  const created_at = new Date().toISOString();
  const record_type = opts.record_type || 'system';
  const brief_version = opts.brief_version || process.env.BRIEF_VERSION || '0.0.1';
  const content_plain = opts.content_plain || '';

  const content_hash = crypto.createHash('sha256').update(content_plain).digest('hex');
  const content_encrypted = Buffer.from(content_plain, 'utf8').toString('base64');

  // compute prev_hash from last line if exists
  let prev_hash = null;
  try {
    if (fs.existsSync(fallbackPath)) {
      const stat = fs.statSync(fallbackPath);
      if (stat.size > 0) {
        const data = fs.readFileSync(fallbackPath, 'utf8');
        const lines = data.trim().split(/\r?\n/);
        const last = lines[lines.length - 1];
        if (last) {
          try {
            const lastObj = JSON.parse(last);
            prev_hash = lastObj.content_hash || null;
          } catch (e) {
            prev_hash = null;
          }
        }
      }
    }
  } catch (e) {
    prev_hash = null;
  }

  // signature with NODE_PRIVATE_KEY or NODE_PRIVATE_KEY_B64 if available
  let signature = null;
  let author_pubkey = null;
  let private_key_info = getPrivateKeyInfo();
  if (private_key_info.private_key_present && private_key_info.private_key_valid && private_key_info.keyObject) {
    try {
      // Sign the hex digest string bytes to match existing stored ledger entries.
      const sign = crypto.sign(null, content_hash, private_key_info.keyObject);
      signature = sign.toString('base64');
      author_pubkey = getPublicKeyPemFromPrivate(private_key_info.keyObject) || null;
    } catch (err) {
      signature = null;
      author_pubkey = null;
    }
  }

  if (!author_pubkey && signature) {
    const envPubKey = getEnvNodePublicKey();
    author_pubkey = envPubKey ? envPubKey.trim() : null;
  }

  if (!author_pubkey && signature) {
    const pubKeyPath = path.join(__dirname, '../../config/node-identity.pub');
    if (fs.existsSync(pubKeyPath)) {
      author_pubkey = fs.readFileSync(pubKeyPath, 'utf8').trim();
    }
  }

  const entry = {
    id,
    created_at,
    record_type,
    brief_version,
    content_hash,
    content_encrypted,
    author_pubkey,
    signature,
    prev_hash,
    status: 'pending_review',
    board_note: null,
  };

  try {
    fs.appendFileSync(fallbackPath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
    return entry;
  } catch (err) {
    throw new Error('Failed to append fallback ledger record: ' + err.message);
  }
};

const readFallbackEntries = ({ limit = 50, offset = 0 } = {}) => {
  try {
    ensureFallbackLedgerReady();
    if (!fs.existsSync(fallbackPath)) return [];
    const data = fs.readFileSync(fallbackPath, 'utf8').trim();
    if (!data) return [];
    const lines = data.split(/\r?\n/).reverse();
    const selected = lines.slice(offset, offset + limit).map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
    return selected;
  } catch (err) {
    return [];
  }
};

module.exports.ensureLedgerReady = ensureLedgerReady;

const verifyEntrySignature = (entry) => {
  if (!entry || !entry.signature || !entry.author_pubkey || !entry.content_hash) {
    return { ok: false, error: 'Missing signature, author_pubkey, or content_hash' };
  }

  try {
    const signature = Buffer.from(entry.signature, 'base64');
    const content = String(entry.content_hash);
    const publicKeyPem = ensurePublicKeyPem(String(entry.author_pubkey));
    if (!publicKeyPem) {
      return { ok: false, error: 'Invalid author_pubkey format' };
    }
    const publicKey = crypto.createPublicKey(publicKeyPem);
    const ok = crypto.verify(null, content, publicKey, signature);
    return { ok, error: ok ? null : 'Signature verification failed' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

module.exports.isAvailable = isAvailable;
module.exports.ledgerType = ledgerType;
module.exports.getLedgerStatus = getLedgerStatus;
module.exports.getLedgerHeight = getLedgerHeight;
module.exports.getEntries = getEntries;
module.exports.appendFallbackRecord = appendFallbackRecord;
module.exports.readFallbackEntries = readFallbackEntries;
module.exports.verifyEntrySignature = verifyEntrySignature;
module.exports.getPrivateKeyInfo = getPrivateKeyInfo;
// appendRecord: unified append used by application code. Chooses sqlite path if available else fallback
const appendRecord = async (opts = {}) => {
  // Only use SQLite when it has been proven functional.
  if (available && db && sqliteProven) {
    return new Promise((resolve, reject) => {
      const id = uuid();
      const created_at = new Date().toISOString();
      const record_type = opts.record_type || 'system';
      const brief_version = opts.brief_version || process.env.BRIEF_VERSION || '0.0.1';
      const content_plain = opts.content_plain || '';
      const content_hash = crypto.createHash('sha256').update(content_plain).digest('hex');
      const content_encrypted = Buffer.from(content_plain, 'utf8').toString('base64');

      // attempt to sign using available private key
      let signature = null;
      let author_pubkey = null;
      try {
        const privateInfo = getPrivateKeyInfo();
        if (privateInfo && privateInfo.private_key_present && privateInfo.private_key_valid && privateInfo.keyObject) {
          const sign = crypto.sign(null, String(content_hash), privateInfo.keyObject);
          signature = sign.toString('base64');
          author_pubkey = getPublicKeyPemFromPrivate(privateInfo.keyObject) || null;
        }
      } catch (e) {
        signature = null;
        author_pubkey = null;
      }

      const prev_hash = null;
      const status = 'pending_review';

      const sql = `INSERT INTO ledger_entries (id, created_at, record_type, brief_version, content_hash, content_encrypted, author_pubkey, signature, prev_hash, status, board_note) VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
      db.run(sql, [id, created_at, record_type, brief_version, content_hash, content_encrypted, author_pubkey, signature, prev_hash, status, null], function (err) {
        if (err) {
          console.error('SQLite insert failed, falling back to JSONL ledger:', err.message);
          markSqliteUnavailable(`SQLite insert failed: ${err.message}`);
          return resolve(appendFallbackRecord(opts));
        }
        resolve({ id, created_at, record_type, brief_version, content_hash, content_encrypted, author_pubkey, signature, prev_hash, status, board_note: null });
      });
    });
  }

  // otherwise fallback to file-based append
  return appendFallbackRecord(opts);
};

module.exports.appendRecord = appendRecord;
module.exports.resetLedgerStorage = resetLedgerStorage;

