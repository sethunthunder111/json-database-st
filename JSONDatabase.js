// File: JSONDatabase.js
// Final, Complete, and Secure Version (Patched)

const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const _ = require("lodash");
const EventEmitter = require("events");
// --- FIX: Add dependency for cross-process file locking. Run `npm install proper-lockfile`.
const lockfile = require("proper-lockfile");

// --- Custom Error Classes for Better Error Handling ---

/** Base error for all database-specific issues. */
class DBError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}
/** Error during database file initialization or parsing. */
class DBInitializationError extends DBError {}
/** Error within a user-provided transaction function. */
class TransactionError extends DBError {}
/** Error when data fails schema validation. */
class ValidationError extends DBError {
  constructor(message, validationIssues) {
    super(message);
    this.issues = validationIssues; // e.g., from Zod/Joi
  }
}
/** Error related to index integrity (e.g., unique constraint violation). */
class IndexViolationError extends DBError {}
/** Error for security-related issues like path traversal or bad keys. */
class SecurityError extends DBError {}

// --- Type Definitions for Clarity ---

/**
 * @typedef {object} BatchOperationSet
 * @property {'set'} type
 * @property {string | string[]} path
 * @property {any} value
 */

/**
 * @typedef {object} BatchOperationDelete
 * @property {'delete'} type
 * @property {string | string[]} path
 */

/**
 * @typedef {object} BatchOperationPush
 * @property {'push'} type
 * @property {string | string[]} path
 * @property {any[]} values - Items to push uniquely using deep comparison.
 */

/**
 * @typedef {object} BatchOperationPull
 * @property {'pull'} type
 * @property {string | string[]} path
 * @property {any[]} values - Items to remove using deep comparison.
 */

/**
 * @typedef {BatchOperationSet | BatchOperationDelete | BatchOperationPush | BatchOperationPull} BatchOperation
 */

/**
 * @typedef {object} IndexDefinition
 * @property {string} name - The unique name for the index.
 * @property {string | string[]} path - The lodash path to the collection object (e.g., 'users').
 * @property {string} field - The property field within each collection item to index (e.g., 'email').
 * @property {boolean} [unique=false] - If true, enforces that the indexed field must be unique across the collection.
 */

// --- Cryptography Constants ---
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * A robust, secure, promise-based JSON file database with atomic operations, indexing, schema validation, and events.
 * Includes encryption-at-rest and path traversal protection.
 *
 * @class JSONDatabase
 * @extends {EventEmitter}
 */
class JSONDatabase extends EventEmitter {
  /**
   * Creates a database instance.
   *
   * @param {string} filename - Database file path.
   * @param {object} [options] - Configuration options.
   * @param {string} [options.encryptionKey=null] - A 32-byte (64-character hex) secret key for encryption. If provided, enables encryption-at-rest. **MANAGE THIS KEY SECURELY.**
   * @param {boolean} [options.prettyPrint=false] - Pretty-print JSON output (only if not encrypted).
   * @param {boolean} [options.writeOnChange=true] - Only write to disk if data has changed.
   * @param {object} [options.schema=null] - A validation schema (e.g., from Zod) with a `safeParse` method.
   * @param {IndexDefinition[]} [options.indices=[]] - An array of index definitions for fast lookups.
   * @throws {SecurityError} If the filename is invalid or attempts path traversal.
   * @throws {SecurityError} If an encryption key is provided but is not the correct length.
   */
  constructor(filename, options = {}) {
    super();

    // --- Security Check: Path Traversal ---
    const resolvedPath = path.resolve(filename);
    const workingDir = process.cwd();
    if (!resolvedPath.startsWith(workingDir)) {
      throw new SecurityError(
        `Path traversal detected. Database path must be within the project directory: ${workingDir}`
      );
    }
    this.filename = /\.json$/.test(resolvedPath)
      ? resolvedPath
      : `${resolvedPath}.json`;

    // --- Security Check: Encryption Key ---
    if (
      options.encryptionKey &&
      (!options.encryptionKey ||
        Buffer.from(options.encryptionKey, "hex").length !== 32)
    ) {
      throw new SecurityError(
        "Encryption key must be a 32-byte (64-character hex) string."
      );
    }

    this.config = {
      prettyPrint: options.prettyPrint === true,
      writeOnChange: options.writeOnChange !== false,
      schema: options.schema || null,
      indices: options.indices || [],
      encryptionKey: options.encryptionKey
        ? Buffer.from(options.encryptionKey, "hex")
        : null,
    };

    this.cache = null;
    this.writeLock = Promise.resolve();
    this.stats = { reads: 0, writes: 0, cacheHits: 0 };
    this._indices = new Map();

    // Asynchronously initialize. Operations will queue behind this promise.
    this._initPromise = this._initialize();
  }

  // --- Encryption & Decryption ---
  _encrypt(data) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(
      ALGORITHM,
      this.config.encryptionKey,
      iv
    );
    const jsonString = JSON.stringify(data);
    const encrypted = Buffer.concat([
      cipher.update(jsonString, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return JSON.stringify({
      iv: iv.toString("hex"),
      tag: authTag.toString("hex"),
      content: encrypted.toString("hex"),
    });
  }

  _decrypt(encryptedPayload) {
    try {
      const payload = JSON.parse(encryptedPayload);
      const iv = Buffer.from(payload.iv, "hex");
      const authTag = Buffer.from(payload.tag, "hex");
      const encryptedContent = Buffer.from(payload.content, "hex");
      const decipher = crypto.createDecipheriv(
        ALGORITHM,
        this.config.encryptionKey,
        iv
      );
      decipher.setAuthTag(authTag);
      const decrypted =
        decipher.update(encryptedContent, "hex", "utf8") +
        decipher.final("utf8");
      return JSON.parse(decrypted);
    } catch (e) {
      throw new SecurityError(
        "Decryption failed. The file may be corrupted, tampered with, or the encryption key is incorrect."
      );
    }
  }

  // --- Private Core Methods ---

  /** @private Kicks off the initialization process. */
  async _initialize() {
    // --- FIX: Crash Recovery for Durable Writes ---
    // Check if a temporary file exists from a previously failed write.
    // If so, it represents the most recent state. We recover by renaming it.
    const tempFile = this.filename + ".tmp";
    try {
      await fs.access(tempFile);
      console.warn(
        `[JSONDatabase] Found temporary file ${tempFile}. Recovering from a previous failed write.`
      );
      await fs.rename(tempFile, this.filename);
      console.log(
        `[JSONDatabase] Recovery successful. ${this.filename} has been restored.`
      );
    } catch (e) {
      // This is the normal case where no temp file exists. Do nothing.
    }

    try {
      await this._refreshCache();
      this._rebuildAllIndices();
    } catch (err) {
      const initError = new DBInitializationError(
        `Failed to initialize database: ${err.message}`
      );
      this.emit("error", initError);
      console.error(
        `[JSONDatabase] FATAL: Initialization failed for ${this.filename}. The database is in an unusable state.`,
        err
      );
      // --- ENHANCEMENT: Make the instance unusable if init fails ---
      // By re-throwing here, the _initPromise will be rejected, and all subsequent
      // operations waiting on _ensureInitialized() will fail immediately.
      throw initError;
    }
  }

  /** @private Reads file, decrypts if necessary, and populates cache. */
  async _refreshCache() {
    try {
      const fileContent = await fs.readFile(this.filename, "utf8");
      if (this.config.encryptionKey) {
        this.cache =
          fileContent.trim() === "" ? {} : this._decrypt(fileContent);
      } else {
        this.cache = fileContent.trim() === "" ? {} : JSON.parse(fileContent);
      }
      this.stats.reads++;
    } catch (err) {
      if (err.code === "ENOENT") {
        console.warn(
          `[JSONDatabase] File ${this.filename} not found. Creating.`
        );
        this.cache = {};
        // Do not write file here; _atomicWrite will create it safely.
      } else if (err instanceof SyntaxError && !this.config.encryptionKey) {
        throw new DBInitializationError(
          `Failed to parse JSON from ${this.filename}. File is corrupted.`
        );
      } else {
        throw err; // Re-throw security, crypto, and other errors
      }
    }
  }

  /** @private Ensures all operations wait for initialization to complete. */
  async _ensureInitialized() {
    // This promise will be rejected if _initialize() fails, stopping all operations.
    return this._initPromise;
  }

  /** @private Performs an atomic write operation. */
  async _atomicWrite(operationFn) {
    await this._ensureInitialized();

    // This promise chain ensures all writes *from this process* happen one after another.
    this.writeLock = this.writeLock.then(async () => {
      let releaseLock;
      try {
        // --- FIX: Acquire a cross-process lock to prevent race conditions.
        // This will wait if another process (or this one) currently holds the lock.
        releaseLock = await lockfile.lock(this.filename, {
          stale: 7000, // Lock is considered stale after 7s
          retries: {
            retries: 5,
            factor: 1.2,
            minTimeout: 200,
          },
        });

        // --- FIX: Refresh cache *after* acquiring the lock.
        // This is critical to get the latest data if another process changed it.
        await this._refreshCache();

        const oldData = this.cache;
        const dataToModify = _.cloneDeep(oldData);

        const newData = await operationFn(dataToModify);

        if (newData === undefined) {
          throw new TransactionError(
            "Atomic operation function returned undefined. Aborting to prevent data loss. Did you forget to `return data`?"
          );
        }

        if (this.config.schema) {
          const validationResult = this.config.schema.safeParse(newData);
          if (!validationResult.success) {
            throw new ValidationError(
              "Schema validation failed.",
              validationResult.error.issues
            );
          }
        }

        this._updateIndices(oldData, newData);

        if (this.config.writeOnChange && _.isEqual(newData, oldData)) {
          return oldData; // Return the unchanged data
        }

        const contentToWrite = this.config.encryptionKey
          ? this._encrypt(newData)
          : JSON.stringify(newData, null, this.config.prettyPrint ? 2 : 0);

        // --- FIX: Implement durable write. Write to temp file first.
        const tempFile = this.filename + ".tmp";
        await fs.writeFile(tempFile, contentToWrite, "utf8");
        // --- FIX: Atomically rename temp file to the final filename.
        await fs.rename(tempFile, this.filename);

        this.cache = newData;
        this.stats.writes++;

        this.emit("write", { filename: this.filename, timestamp: Date.now() });
        this.emit("change", { oldValue: oldData, newValue: newData });

        return newData;
      } catch (error) {
        this.emit("error", error);
        console.error(
          "[JSONDatabase] Atomic write failed. No changes were saved.",
          error
        );
        throw error;
      } finally {
        // --- FIX: Always release the lock, even if an error occurred.
        if (releaseLock) {
          await releaseLock();
        }
      }
    });

    return this.writeLock;
  }

  // --- Indexing ---

  /** @private Clears and rebuilds all defined indices from the current cache. */
  _rebuildAllIndices() {
    this._indices.clear();
    for (const indexDef of this.config.indices) {
      this._indices.set(indexDef.name, new Map());
    }
    if (this.config.indices.length > 0 && !_.isEmpty(this.cache)) {
      // Rebuild by treating the current state as "new" and the previous state as empty.
      this._updateIndices({}, this.cache);
    }
    console.log(
      `[JSONDatabase] Rebuilt ${this.config.indices.length} indices for ${this.filename}.`
    );
  }

  /**
   * @private Compares old and new data to update indices efficiently.
   * FIX: Replaced inefficient and buggy index update logic with a robust key-based comparison.
   * This new implementation correctly handles additions, deletions, and in-place updates,
   * and is significantly more performant.
   */
  _updateIndices(oldData, newData) {
    for (const indexDef of this.config.indices) {
      const indexMap = this._indices.get(indexDef.name);
      if (!indexMap) continue;

      const oldCollection = _.get(oldData, indexDef.path, {});
      const newCollection = _.get(newData, indexDef.path, {});

      if (!_.isObject(oldCollection) || !_.isObject(newCollection)) {
        continue; // Indexing requires a collection (object or array).
      }

      const allKeys = _.union(_.keys(oldCollection), _.keys(newCollection));

      for (const key of allKeys) {
        const oldItem = oldCollection[key];
        const newItem = newCollection[key];

        if (_.isEqual(oldItem, newItem)) {
          continue; // Item is unchanged, no index update needed.
        }

        const oldVal = oldItem?.[indexDef.field];
        const newVal = newItem?.[indexDef.field];

        if (_.isEqual(oldVal, newVal)) {
          continue; // Indexed field's value is unchanged.
        }

        // 1. Remove the old value if it was indexed and pointed to this item.
        if (oldVal !== undefined && indexMap.get(oldVal) === key) {
          indexMap.delete(oldVal);
        }

        // 2. Add the new value if it's defined.
        if (newVal !== undefined) {
          // Check for unique constraint violation before adding.
          if (indexDef.unique && indexMap.has(newVal)) {
            throw new IndexViolationError(
              `Unique index '${indexDef.name}' violated for value '${newVal}'.`
            );
          }
          indexMap.set(newVal, key);
        }
      }
    }
  }

  // --- Public API ---

  async get(path, defaultValue) {
    await this._ensureInitialized();
    this.stats.cacheHits++;
    if (path === undefined || path === null) {
      return this.cache;
    }
    return _.get(this.cache, path, defaultValue);
  }

  async has(path) {
    await this._ensureInitialized();
    this.stats.cacheHits++;
    return _.has(this.cache, path);
  }

  async set(path, value) {
    return this._atomicWrite((data) => {
      _.set(data, path, value);
      return data;
    });
  }

  async delete(path) {
    let deleted = false;
    await this._atomicWrite((data) => {
      deleted = _.unset(data, path);
      return data;
    });
    return deleted;
  }

  async push(path, ...items) {
    if (items.length === 0) return;
    return this._atomicWrite((data) => {
      const arr = _.get(data, path);
      const targetArray = Array.isArray(arr) ? arr : [];
      items.forEach((item) => {
        if (!targetArray.some((existing) => _.isEqual(existing, item))) {
          targetArray.push(item);
        }
      });
      _.set(data, path, targetArray);
      return data;
    });
  }

  async pull(path, ...itemsToRemove) {
    if (itemsToRemove.length === 0) return;
    return this._atomicWrite((data) => {
      const arr = _.get(data, path);
      if (Array.isArray(arr)) {
        _.pullAllWith(arr, itemsToRemove, _.isEqual);
      }
      return data;
    });
  }

  async transaction(transactionFn) {
    return this._atomicWrite(transactionFn);
  }

  async batch(ops, options = { stopOnError: false }) {
    if (!Array.isArray(ops) || ops.length === 0) return;

    return this._atomicWrite((data) => {
      for (const [index, op] of ops.entries()) {
        try {
          if (!op || !op.type || op.path === undefined)
            throw new Error("Invalid operation format: missing type or path.");

          switch (op.type) {
            case "set":
              if (!op.hasOwnProperty("value"))
                throw new Error("Set operation missing 'value'.");
              _.set(data, op.path, op.value);
              break;
            case "delete":
              _.unset(data, op.path);
              break;
            case "push":
              if (!Array.isArray(op.values))
                throw new Error("Push operation 'values' must be an array.");
              const arr = _.get(data, op.path);
              const targetArray = Array.isArray(arr) ? arr : [];
              op.values.forEach((item) => {
                if (!targetArray.some((existing) => _.isEqual(existing, item)))
                  targetArray.push(item);
              });
              _.set(data, op.path, targetArray);
              break;
            case "pull":
              if (!Array.isArray(op.values))
                throw new Error("Pull operation 'values' must be an array.");
              const pullArr = _.get(data, op.path);
              if (Array.isArray(pullArr))
                _.pullAllWith(pullArr, op.values, _.isEqual);
              break;
            default:
              throw new Error(`Unsupported operation type: '${op.type}'.`);
          }
        } catch (err) {
          const errorMessage = `[JSONDatabase] Batch failed at operation index ${index} (type: ${op?.type}): ${err.message}`;
          if (options.stopOnError) {
            throw new Error(errorMessage);
          } else {
            console.error(errorMessage);
          }
        }
      }
      return data;
    });
  }

  async find(collectionPath, predicate) {
    await this._ensureInitialized();
    const collection = _.get(this.cache, collectionPath);
    if (typeof collection !== "object" || collection === null) return undefined;

    this.stats.cacheHits++;
    return _.find(collection, predicate);
  }

  async findByIndex(indexName, value) {
    await this._ensureInitialized();
    if (!this._indices.has(indexName)) {
      throw new Error(`Index with name '${indexName}' does not exist.`);
    }

    this.stats.cacheHits++;
    const indexMap = this._indices.get(indexName);
    const objectKey = indexMap.get(value);

    if (objectKey === undefined) return undefined;

    const indexDef = this.config.indices.find((i) => i.name === indexName);
    const fullPath = [..._.toPath(indexDef.path), objectKey];
    return _.get(this.cache, fullPath);
  }

  async clear() {
    console.warn(
      `[JSONDatabase] Clearing all data from ${this.filename}. This action is irreversible.`
    );
    return this._atomicWrite(() => ({}));
  }

  getStats() {
    return { ...this.stats };
  }

  async close() {
    await this.writeLock;

    this.cache = null;
    this._indices.clear();
    this.removeAllListeners();
    this._initPromise = null;

    const finalStats = JSON.stringify(this.getStats());
    console.log(
      `[JSONDatabase] Closed connection to ${this.filename}. Final Stats: ${finalStats}`
    );
  }
}

module.exports = JSONDatabase;
