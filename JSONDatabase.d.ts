// File: JSONDatabase.d.ts
import { EventEmitter } from 'events';

/**
 * A lightweight schema representation accepted by the DB.
 * Libraries such as Zod or Joi can be used at runtime; this type is intentionally permissive.
 */
export type SchemaLike = any;

/**
 * Options configuring behavior of the JSONDatabase.
 */
export interface DBOptions {
    /**
     * Optional key used to encrypt the file on disk. If provided,
     * all reads/writes will transparently encrypt/decrypt data.
     */
    encryptionKey?: string;

    /**
     * When true the file will be written with 2-space indentation for readability.
     * Defaults to false (compact).
     */
    prettyPrint?: boolean;

    /**
     * When true, any change is flushed to disk immediately. When false,
     * writes may be batched for performance.
     * Defaults to true.
     */
    writeOnChange?: boolean;

    /**
     * Optional validation schema (Zod/Joi/etc). If provided, writes
     * that would violate the schema will be rejected.
     */
    schema?: SchemaLike;

    /**
     * Optional index definitions for faster lookups via `findByIndex`.
     */
    indices?: IndexDefinition[];

    /**
     * If true, database will periodically compact the file to reduce size.
     */
    autoCompact?: boolean;
}

/**
 * Defines a secondary index on objects stored under a path.
 * - `path` is a dot-separated path inside the DB where the array/object lives.
 * - `field` is the property name to index on each element.
 */
export interface IndexDefinition {
    name: string;
    path: string;
    field: string;
    unique?: boolean;
}

/**
 * Discriminated union describing a single batched operation.
 */
export type BatchOp =
    | { type: 'set'; path: string; value: any }
    | { type: 'delete'; path: string }
    | { type: 'push'; path: string; values: any[] }
    | { type: 'pull'; path: string; values: any[] };

/**
 * Main JSON file-backed database.
 *
 * The API is promise-based and supports paths using dot-notation
 * to address nested objects/arrays (e.g. "users.0.name").
 */
export default class JSONDatabase extends EventEmitter {
    /**
     * Open or create a database file at `filename`.
     * @param filename Path to JSON file on disk.
     * @param options Optional DBOptions to configure behavior.
     */
    constructor(filename: string, options?: DBOptions);

    /**
     * Read a value at `path`. If `path` is omitted, returns the entire DB.
     * @param path Dot-separated path or undefined for root.
     * @param defaultValue Value returned when the path is missing.
     */
    get<T = any>(path?: string, defaultValue?: T): Promise<T>;

    /**
     * Return true if the given path exists.
     */
    has(path: string): Promise<boolean>;

    /**
     * Set the value at `path`. If `path` points to a nested location,
     * intermediate objects/arrays will be created as needed.
     */
    set(path: string, value: any): Promise<any>;

    /**
     * Delete the value at `path`. Returns true if something was deleted.
     */
    delete(path: string): Promise<boolean>;

    /**
     * Append one or more items to an array at `path`. If the target is missing,
     * an array will be created.
     */
    push(path: string, ...items: any[]): Promise<void>;

    /**
     * Remove one or more items from an array at `path` (strict equality).
     */
    pull(path: string, ...items: any[]): Promise<void>;

    /**
     * Atomically add `amount` to a numeric value at `path`. If the value is missing,
     * it will be treated as 0 before adding.
     */
    add(path: string, amount: number): Promise<number>;

    /**
     * Atomically subtract `amount` from a numeric value at `path`.
     */
    subtract(path: string, amount: number): Promise<number>;

    /**
     * Run a function with the current DB snapshot and atomically persist
     * the result. The function may mutate the provided object (in-memory)
     * and the final value will be written back.
     */
    transaction<T = any>(fn: (data: any) => T | Promise<T>): Promise<T>;

    /**
     * Execute a batch of operations. If `stopOnError` is true, processing
     * will stop at the first failing operation and the returned promise will reject.
     */
    batch(ops: BatchOp[], options?: { stopOnError?: boolean }): Promise<any>;

    /**
     * Find the first item under `path` that matches `predicate`.
     * `predicate` may be an object of key/value pairs or a predicate function.
     */
    find<T = any>(path: string, predicate: Partial<T> | ((item: T) => boolean)): Promise<T | undefined>;

    /**
     * Lookup a record using a previously defined index.
     */
    findByIndex<T = any>(indexName: string, value: any): Promise<T | undefined>;

    /**
     * Return a paginated slice of an array at `path`. `page` is 1-based.
     */
    paginate<T = any>(
        path: string,
        page?: number,
        limit?: number,
        filterFn?: (item: T) => boolean
    ): Promise<{
        data: T[];
        meta: { total: number; page: number; limit: number; totalPages: number; hasNext: boolean };
    }>;

    /**
     * Create a snapshot file (or internal snapshot) and return the snapshot id/path.
     */
    createSnapshot(label?: string): Promise<string>;

    /**
     * Remove all data and return the previous root object.
     */
    clear(): Promise<object>;

    /**
     * Close any open file handles and stop background tasks.
     */
    close(): Promise<void>;

    /**
     * Register a handler to run before an operation. `op` is one of: 'get','set','delete','push','pull','batch'.
     * The callback receives a context object with details about the operation and may throw to abort the operation.
     */
    before(op: string, path: string, cb: (ctx: any) => any): void;

    /**
     * Register a handler to run after an operation completes successfully.
     */
    after(op: string, path: string, cb: (ctx: any) => any): void;
}

/* Example usage:
import JSONDatabase from './JSONDatabase';

const db = new JSONDatabase('data.json', { prettyPrint: true });
await db.set('users.alice', { id: 'alice', age: 30 });
const alice = await db.get('users.alice');
*/