// File: JSONDatabase.js

const fs = require('fs').promises;
const path = require('path');
const _ = require('lodash'); // Ensure lodash is installed: npm install lodash

const jsonRegex = /\.json$/;

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
 * A simple, promise-based JSON file database with atomic operations.
 * Uses lodash for object manipulation.
 *
 * @class JSONDatabase
 */
class JSONDatabase {
  /**
   * Creates a database instance.
   *
   * @param {string} filename - Database file path (e.g., 'db.json' or './data/myDb'). '.json' extension is added if missing.
   * @param {object} [options] - Configuration options.
   * @param {boolean} [options.prettyPrint=false] - Pretty-print JSON file output (adds indentation). Defaults to false for smaller file size.
   */
  constructor(filename, options = {}) {
    if (!jsonRegex.test(filename)) {
      this.filename = path.resolve(`${filename}.json`);
    } else {
      this.filename = path.resolve(filename);
    }
    this.cache = null; // In-memory cache of the database content
    this.writeLock = null; // Promise acting as a lock for atomic writes
    this.config = {
      prettyPrint: options.prettyPrint === true, // Explicit check
    };
    this.stats = { reads: 0, writes: 0, cacheHits: 0 };
    this._initPromise = null; // Track initialization promise

    // Initialize cache asynchronously, handle errors during init.
    this._init().catch(err => {
      console.error(`[JSONDatabase] FATAL: Initialization failed for ${this.filename}:`, err);
      // Optionally, set a state indicating permanent failure
    });
  }

  /** @private Initialize cache by reading the file */
  async _init() {
    // Prevent race conditions during initial load if multiple operations trigger it
    if (this._initPromise) return this._initPromise;

    // Create the promise and store it
    this._initPromise = this._refreshCache();

    try {
        await this._initPromise;
    } finally {
        // Clear the promise variable once initialization is complete (success or failure)
        // So subsequent calls to _init (if needed, e.g. after close/re-open) would trigger a new load
        this._initPromise = null;
    }
    return this.cache; // Return cache state after init attempt
  }

  /** @private Reads the database file and populates the cache. Creates file if not exists. */
  async _refreshCache() {
    try {
      const data = await fs.readFile(this.filename, 'utf8');
      // Handle case where file is empty or contains only whitespace
      this.cache = data.trim() === '' ? {} : JSON.parse(data);
      this.stats.reads++;
      return this.cache;
    } catch (err) {
      if (err.code === 'ENOENT') {
        // File doesn't exist, create it with an empty object
        console.warn(`[JSONDatabase] File ${this.filename} not found. Creating.`);
        try {
          await fs.writeFile(this.filename, '{}', 'utf8');
          this.cache = {};
          this.stats.writes++; // Count file creation as a write
          return this.cache;
        } catch (writeErr) {
          console.error(`[JSONDatabase] Failed to create ${this.filename}:`, writeErr);
          throw writeErr; // Re-throw creation error
        }
      } else if (err instanceof SyntaxError) {
         // Handle corrupted JSON file
         console.error(`[JSONDatabase] Error parsing JSON from ${this.filename}. File might be corrupted. Returning empty object and logging error.`, err);
         // Decide recovery strategy: Throw, reset to {}, load backup?
         // For robustness, let's reset the cache to {} but throw the original error
         this.cache = {}; // Prevent operations on potentially bad data
         throw new Error(`Failed to parse JSON file: ${this.filename}. ${err.message}`);
      }
      // Log and re-throw other unexpected errors
      console.error(`[JSONDatabase] Error reading or parsing ${this.filename}:`, err);
      throw err;
    }
  }

  /**
   * @private Ensures atomic write operations using a lock.
   * Takes a function that receives the current data state and should return the modified state.
   * @param {(data: object) => object | Promise<object>} operationFn - Function performing the modification.
   * @returns {Promise<object>} The final data state after the write.
   */
   async _atomicWrite(operationFn) {
     // Ensure initialization is complete before attempting writes
     // If _initPromise exists, await it. If not, call _init() which handles the lock itself.
     await (this._initPromise || this._init());

    // Chain onto the existing lock promise if it exists
    const performWrite = async () => {
        let dataToModify;
        try {
            // Get the most recent data, MUST be from cache as it reflects the state after the previous write lock released.
            // If cache is somehow null here (edge case after close?), refresh.
            dataToModify = _.cloneDeep(this.cache ?? await this._refreshCache());

            // Execute the user-provided operation function
            const result = await operationFn(dataToModify);

            // The operationFn *must* return the data object to be written.
             const dataToWrite = result;
             if (dataToWrite === undefined) {
                // This indicates a potential programming error in the calling function (e.g., transaction, batch)
                console.error("[JSONDatabase] FATAL: Atomic operation function returned undefined. This should not happen. Aborting write to prevent data loss.");
                 throw new Error("Atomic operation function returned undefined, cannot proceed with write.");
             }

            // Optimization: Only write if data actually changed. Deep compare can be costly for large objects.
            // Let's keep it simple and write every time for guaranteed consistency, unless performance becomes an issue.
            // if (_.isEqual(dataToWrite, this.cache)) {
            //     return this.cache; // No change, return current cache state
            // }

            await fs.writeFile(
                this.filename,
                JSON.stringify(dataToWrite, null, this.config.prettyPrint ? 2 : 0),
                'utf8'
            );

            this.cache = dataToWrite; // Update cache AFTER successful write
            this.stats.writes++;
            return this.cache; // Return the final state written to disk/cache

        } catch (error) {
            console.error("[JSONDatabase] Error during atomic write operation:", error);
            // Don't update cache on error, state is uncertain relative to the disk.
            // A subsequent read/write *should* re-sync if the error was temporary.
            throw error; // Re-throw the error to the caller
        }
    };

    // Assign the promise of the current write operation to the lock, ensuring sequential execution.
    // The `then()` ensures we wait for the previous lock to finish before starting the new write.
    this.writeLock = (this.writeLock || Promise.resolve()).then(performWrite, performWrite);
    // We return the promise assigned to this.writeLock so callers can await this specific operation's completion.
    return this.writeLock;
   }


  /**
   * Gets a value from the database using a lodash path.
   * Returns undefined if the path does not exist, unless a defaultValue is provided.
   *
   * @param {string | string[]} path - The lodash path (e.g., 'users.john.age' or ['users', 'john', 'age']).
   * @param {any} [defaultValue] - Value to return if path is not found.
   * @returns {Promise<any>} The value found at the path or the default value.
   */
  async get(path, defaultValue) {
    // Ensure cache is loaded. _init() handles the initialization promise logic.
    await this._init();
    const data = this.cache; // Read directly from cache after init ensures it's loaded
    this.stats.cacheHits++;
    return _.get(data, path, defaultValue);
  }

  /**
   * Sets a value in the database at a specific lodash path.
   *
   * @param {string | string[]} path - The lodash path to set.
   * @param {any} value - The value to set. Can be any JSON-serializable type.
   * @returns {Promise<void>} Resolves when the write operation is complete.
   */
  async set(path, value) {
    // The void return type means callers don't get the data back directly,
    // but the promise resolution confirms the write completed.
    await this._atomicWrite((data) => {
        _.set(data, path, value);
        return data; // Return the modified data object for the atomic write process
    });
  }


  /**
   * Pushes one or more items into an array at the specified path.
   * If the path doesn't exist or isn't an array, it creates/replaces it with a new array containing the items.
   * Ensures items are unique within the array using deep comparison (`lodash.isEqual`).
   *
   * @param {string | string[]} path - The lodash path to the array.
   * @param {...any} items - The items to push into the array.
   * @returns {Promise<void>} Resolves when the write operation is complete.
   */
  async push(path, ...items) {
    if (items.length === 0) return; // No-op if no items provided
    await this._atomicWrite((data) => {
      let arr = _.get(data, path);
      // Initialize as array if path doesn't exist or holds a non-array value
      if (!Array.isArray(arr)) {
           arr = [];
           // Ensure the path is set to an empty array before proceeding
           _.set(data, path, arr);
      }

      let changed = false;
      items.forEach(item => {
          // Use lodash isEqual for deep comparison to check existence
          const itemExists = arr.some(existingItem => _.isEqual(existingItem, item));
          if (!itemExists) {
              arr.push(item);
              changed = true;
          }
      });

      // No need to _.set again if arr reference was modified in place and already set
      // However, if arr was initialized (arr = []), _.set was needed above.
      // The atomic write will handle writing 'data' regardless if 'changed' is true.
      // Returning 'data' is sufficient.

      return data; // Return the data object (potentially modified)
    });
  }

  /**
   * Removes specified items from an array at the given path.
   * Uses deep comparison (`lodash.isEqual`) via `lodash.pullAllWith`.
   * If the target path doesn't exist or is not an array, the operation is ignored silently.
   *
   * @param {string | string[]} path - Dot notation path to the array.
   * @param {...any} itemsToRemove - Items to remove from the array.
   * @returns {Promise<void>} Resolves when the write operation is complete.
   */
  async pull(path, ...itemsToRemove) {
     if (itemsToRemove.length === 0) return; // No-op if no items provided
     await this._atomicWrite((data) => {
        let arr = _.get(data, path);

        if (!Array.isArray(arr)) {
             // Silently ignore if target is not an array
             return data; // Return unmodified data
        }

        const initialLength = arr.length;
        // Use pullAllWith and isEqual for robust object comparison during removal
        _.pullAllWith(arr, itemsToRemove, _.isEqual);

        // If the array length changed, the data object 'data' now contains the modified array.
        // No explicit _.set is needed here as pullAllWith modifies the array in place,
        // and 'arr' is a reference within 'data'.

        // Only trigger a file write if something actually changed (handled by atomicWrite comparing result)
        // if (arr.length !== initialLength) {
            // _.set(data, path, arr); // No need to set again, arr is ref inside data
        // }
        return data; // Return the data object (potentially modified)
    });
  }


  /**
   * Deletes a value or property at the specified path.
   *
   * @param {string | string[]} path - The lodash path to delete.
   * @returns {Promise<boolean>} True if the path existed and was deleted, false otherwise.
   */
  async delete(path) {
      let deleted = false;
      await this._atomicWrite((data) => {
          // _.unset modifies 'data' in place and returns boolean
          deleted = _.unset(data, path);
          return data; // Return the modified data object
      });
      // Return the result captured from _.unset
      return deleted;
  }

  /**
   * Checks if a path exists in the database.
   * Note: An existing path with a value of `undefined` will return `true`.
   *
   * @param {string | string[]} path - The lodash path to check.
   * @returns {Promise<boolean>} True if the path exists, false otherwise.
   */
  async has(path) {
    await this._init(); // Ensure cache is ready
    const data = this.cache;
    this.stats.cacheHits++;
    return _.has(data, path);
  }

  /**
   * Performs an atomic transaction.
   * The provided asynchronous function receives the current database state (as a deep clone)
   * and should return the modified state to be written.
   * If the function throws an error, the transaction is aborted, and no changes are saved.
   * If the function returns `undefined`, an error is thrown to prevent potential data loss.
   *
   * @param {(data: object) => Promise<object> | object} asyncFn - An async function that modifies the data. It MUST return the modified data object.
   * @returns {Promise<object>} A promise that resolves with the final database state after the transaction (the value returned by `asyncFn`).
   * @throws {Error} Throws if the transaction function `asyncFn` throws an error, or if `asyncFn` returns undefined.
   * @example
   * await db.transaction(async (data) => {
   *   const user = _.get(data, 'users.john');
   *   if (user) {
   *     user.visits = (user.visits || 0) + 1;
   *     _.set(data, 'users.john', user); // Optional if modifying user in place
   *   }
   *   return data; // MUST return the modified data
   * });
   */
  async transaction(asyncFn) {
      // _atomicWrite handles the locking, cloning, writing, and cache update.
      // It expects a function that receives data and returns the modified data.
      // asyncFn fits this signature. We just pass it through.
      // _atomicWrite also handles the 'undefined' return check now.
      return this._atomicWrite(asyncFn);
  }


  /**
   * Executes multiple operations atomically within a single write lock.
   * Supported operations: 'set', 'delete', 'push', 'pull'.
   * Operations are executed sequentially in the provided order.
   * If any operation definition is invalid (e.g., missing path/value, invalid type) or
   * encounters an error during its execution (this is less likely for simple types but possible),
   * an error is logged, and the batch processing *continues* with the next operation by default.
   * The entire final state is written to disk once all operations are attempted.
   *
   * @param {BatchOperation[]} ops - An array of operation objects.
   * @returns {Promise<void>} Resolves when the batch write is complete.
   * @example
   * await db.batch([
   *   { type: 'set', path: 'users.jane', value: { age: 30 } },
   *   { type: 'push', path: 'users.jane.hobbies', values: ['reading', 'hiking'] }, // deep compares items in 'values'
   *   { type: 'pull', path: 'config.features', values: ['betaFeature'] }, // deep compares items in 'values'
   *   { type: 'delete', path: 'users.oldUser' }
   * ]);
   */
  async batch(ops) {
    if (!Array.isArray(ops) || ops.length === 0) {
      console.warn("[JSONDatabase] Batch called with no operations.");
      return; // No operations to perform
    }

    await this._atomicWrite((data) => {
      ops.forEach((op, index) => {
        try {
             // Validate base operation structure
             if (!op || typeof op !== 'object' || !op.type) {
                 throw new Error(`Operation at index ${index} is invalid or missing 'type'.`);
             }

            switch (op.type) {
            case 'set':
                if (op.path === undefined || !op.hasOwnProperty('value')) throw new Error(`Batch 'set' op index ${index} missing 'path' or 'value'.`);
                _.set(data, op.path, op.value);
                break;
            case 'delete':
                 if (op.path === undefined) throw new Error(`Batch 'delete' op index ${index} missing 'path'.`);
                _.unset(data, op.path);
                break;
            case 'push': {
                if (op.path === undefined || !Array.isArray(op.values)) throw new Error(`Batch 'push' op index ${index} missing 'path' or 'values' array.`);
                if (op.values.length === 0) break; // Skip if no values to push

                let arr = _.get(data, op.path);
                if (!Array.isArray(arr)) {
                     arr = []; // Initialize if not array
                     _.set(data, op.path, arr); // Set the path to the new array
                 }
                op.values.forEach(item => {
                     const itemExists = arr.some(existing => _.isEqual(existing, item));
                    if (!itemExists) { arr.push(item); } // Push modifies arr in place
                });
                break;
            }
            case 'pull': {
                 if (op.path === undefined || !Array.isArray(op.values)) throw new Error(`Batch 'pull' op index ${index} missing 'path' or 'values' array.`);
                 if (op.values.length === 0) break; // Skip if no values to pull

                 let arr = _.get(data, op.path);
                 if (Array.isArray(arr)) {
                     _.pullAllWith(arr, op.values, _.isEqual); // pullAllWith modifies arr in place
                 } // else ignore pull from non-array silently
                 break;
            }
            default:
                 // Use Error for invalid type as it indicates a programming mistake
                throw new Error(`Invalid batch operation type: '${op.type}' at index ${index}.`);
            }
        } catch (batchOpError) {
             // Log the error but continue processing the rest of the batch
             console.error(`[JSONDatabase] Error during batch operation index ${index} (type: ${op?.type}, path: ${op?.path}):`, batchOpError.message);
             // Optional: Could add an option to stop batch on first error if needed
        }
      });
      // Return the final state after all batch operations attempted
      return data;
    });
  }

  /**
   * Queries the database based on a predicate function.
   * Iterates over the direct properties (key-value pairs) of an object specified by `options.basePath`,
   * or the root object of the database if `basePath` is omitted.
   * Returns an array of the **values** of the properties that satisfy the predicate.
   *
   * @param {(value: any, key: string) => boolean} predicate - A function returning true for items to include. Receives (value, key) of each property being iterated.
   * @param {object} [options] - Query options.
   * @param {string | string[]} [options.basePath] - A lodash path to the object whose properties should be queried.
   * @param {number} [options.limit] - Maximum number of results to return.
   * @returns {Promise<any[]>} An array of **values** that satisfy the predicate.
   * @example
   * // Find all users older than 30 within the 'users' object
   * const oldUsers = await db.query(
   *   (userValue, userKey) => typeof userValue === 'object' && userValue.age > 30,
   *   { basePath: 'users' }
   * );
   * // -> [ { name: 'Alice', age: 35, ... }, { name: 'Charlie', age: 40, ... } ]
   *
   * // Find top-level properties whose key starts with 'config'
   * const configValues = await db.query(
   *   (value, key) => key.startsWith('config')
   * );
   * // -> [ { theme: 'dark', ... }, { region: 'us-east', ... } ] (assuming config objects exist at root)
   */
  async query(predicate, options = {}) {
    await this._init(); // Ensure cache is ready
    const data = this.cache;
    this.stats.cacheHits++; // Count query as cache hit

    const basePath = options.basePath;
    // Use _.get to safely retrieve the base object/value
    const baseData = basePath ? _.get(data, basePath) : data;

    // Ensure baseData is an object we can iterate over
    if (typeof baseData !== 'object' || baseData === null || Array.isArray(baseData)) {
        if (basePath) {
             console.warn(`[JSONDatabase] Query basePath "${basePath}" does not point to an iterable object (must be a plain object). Returning empty array.`);
        } else {
             console.warn(`[JSONDatabase] Query attempted on non-object root data type (${typeof baseData}). Returning empty array.`);
        }
        return [];
    }

    const results = [];
    const limit = options.limit ?? Infinity;

    // Iterate over the properties of the baseData object
    for (const key in baseData) {
        // Ensure we only iterate own properties
        if (Object.prototype.hasOwnProperty.call(baseData, key)) {
            if (results.length >= limit) {
                break; // Stop iteration if limit is reached
            }
            const value = baseData[key];
            try {
                if (predicate(value, key)) {
                    results.push(value); // Return the value that matched
                }
            } catch (predicateError) {
                console.error(`[JSONDatabase] Error executing query predicate for key "${key}":`, predicateError);
                // Skip this item or handle error as needed (currently skipping)
            }
        }
    }

    // Slice again in case limit was exactly reached (though break should handle it)
    return results.slice(0, limit);
  }


  /**
   * Clears the entire database content, replacing it with an empty object `{}`.
   * This is an atomic write operation. Use with caution!
   * @returns {Promise<void>} Resolves when the database has been cleared.
   */
  async clear() {
      await this._atomicWrite(() => {
          // Return an empty object to be written
          return {};
      });
      console.warn(`[JSONDatabase] Cleared all data from ${this.filename}.`);
  }

   /**
   * Returns the current operational statistics for this database instance.
   * @returns {{reads: number, writes: number, cacheHits: number}}
   */
   getStats() {
    // Return a copy to prevent external modification of the internal stats object
    return { ...this.stats };
  }


  /**
   * Waits for any pending write operations queued by this instance to complete,
   * then clears the internal cache and releases the write lock.
   * Does not delete the database file.
   * Call this before your application exits to ensure data integrity.
   *
   * @returns {Promise<void>} Resolves when the database instance is closed and pending writes are finished.
   */
  async close() {
    // Wait for the current write lock promise chain to complete, if any exists
    try {
        // If there's a lock, await it. If not, nothing to wait for.
        if (this.writeLock) {
            await this.writeLock;
        }
    } catch (err) {
        // Log error during final write if it occurs, but proceed with closing
        console.error("[JSONDatabase] Error during final write operation while closing:", err);
    } finally {
        // Clear the cache and the lock reference *after* waiting
        this.cache = null;
        this.writeLock = null;
        this._initPromise = null; // Reset init promise tracking
        const stats = this.getStats(); // Get stats before resetting
        console.log(`[JSONDatabase] Closed connection to ${this.filename}. Final Stats: ${JSON.stringify(stats)}`);
        // Optionally reset stats, or leave them for inspection after close
        // this.stats = { reads: 0, writes: 0, cacheHits: 0 };
    }
  }
}

module.exports = JSONDatabase;
