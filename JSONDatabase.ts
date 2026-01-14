import { EventEmitter } from 'events';
import * as path from 'path';
// @ts-ignore
import * as lockfile from 'proper-lockfile';
// @ts-ignore
import * as _ from 'lodash';
import * as fs from 'fs';
import { DatabaseCore } from './index'; 

// Types
export interface DatabaseOptions {
  encryptionKey?: string;
  saveDelay?: number;
  prettyPrint?: boolean;
  schema?: any; // Zod schema or similar
  indices?: { name: string; path: string; field: string; unique?: boolean }[];
  silent?: boolean;
  wal?: boolean;
}

export interface MiddlewareContext {
  path: string;
  value?: any;
  finalData?: any;
  data?: any;
}

export type MiddlewareFn = (ctx: MiddlewareContext) => MiddlewareContext;

interface MiddlewareStore {
  before: { [key: string]: { regex: RegExp; cb: MiddlewareFn }[] };
  after: { [key: string]: { regex: RegExp; cb: MiddlewareFn }[] };
}

// Custom Errors
class DBError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = this.constructor.name;
  }
}
class TransactionError extends DBError {}
class ValidationError extends DBError {
  issues: any[];
  constructor(msg: string, issues: any[]) {
    super(msg);
    this.issues = issues;
  }
}

class QueryCursor implements PromiseLike<any[]> {
    private core: DatabaseCore;
    private path: string;
    private query: any;
    private dbInstance: JSONDatabase | null;
    private options: {
        limit?: number;
        skip?: number;
        sort?: any;
        select?: string[];
    } = {};

    constructor(core: DatabaseCore, path: string, query: any, dbInstance: JSONDatabase | null = null) {
        this.core = core;
        this.path = path;
        this.query = query;
        this.dbInstance = dbInstance;
    }

    public limit(n: number): this {
        this.options.limit = n;
        return this;
    }

    public skip(n: number): this {
        this.options.skip = n;
        return this;
    }

    public sort(criteria: any): this {
        this.options.sort = criteria;
        return this;
    }

    public select(fields: string[]): this {
        this.options.select = fields;
        return this;
    }

    public async exec(): Promise<any[]> {
        if (this.dbInstance) {
            // @ts-ignore - _flushOps is private but we need access
            this.dbInstance['_flushOps']();
        }

        if (typeof this.query === 'function') {
            const collection = this.core.get(this.path); 
            if (!Array.isArray(collection)) return [];
            let result = collection.filter(this.query);
            
            if (this.options.sort) {
                 if (typeof this.options.sort === 'function') {
                     result.sort(this.options.sort);
                 } else {
                     result = _.orderBy(result, Object.keys(this.options.sort), Object.values(this.options.sort).map(v => v === 1 ? 'asc' : 'desc'));
                 }
            }
            if (this.options.skip) result = result.slice(this.options.skip);
            if (this.options.limit) result = result.slice(0, this.options.limit);
            if (this.options.select && this.options.select.length > 0) {
                 result = result.map(item => _.pick(item, this.options.select!));
            }
            return result;
        } else {
            return this.core.find(this.path, this.query, this.options);
        }
    }

    then<TResult1 = any[], TResult2 = never>(
        onfulfilled?: ((value: any[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
    ): PromiseLike<TResult1 | TResult2> {
        return this.exec().then(onfulfilled, onrejected);
    }
}

/**
 * JSONDatabase
 */
class JSONDatabase extends EventEmitter {
  public static DBError = DBError;
  public static TransactionError = TransactionError;
  public static ValidationError = ValidationError;
  public static QueryCursor = QueryCursor;

  private core: DatabaseCore;
  private filename: string;
  private config: {
    saveDelay: number;
    schema: any;
    indices: any[];
    encryptionKey: string | null;
    prettyPrint: boolean;
    silent: boolean;
    wal: boolean;
  };
  private _saveTimer: any = null;
  private _savePromise: Promise<void> | null = null;
  private _saveResolve: ((value: void | PromiseLike<void>) => void) | null = null;
  private _saveReject: ((reason?: any) => void) | null = null;
  
  private _middleware: MiddlewareStore = {
    before: { set: [], delete: [], push: [], pull: [] },
    after: { set: [], delete: [], push: [], pull: [] },
  };
  private _loaded: boolean = false;
  private _initPromise: Promise<void>;
  
  // Auto-Batching Queue
  private _writeQueue: any[] = [];
  private _BATCH_SIZE: number = 1000;

  constructor(filename: string, options: DatabaseOptions = {}) {
    super();

    // 1. Path Resolution & Security
    const resolvedPath = path.resolve(filename);
    if (!resolvedPath.startsWith(process.cwd())) {
      throw new Error("Security Violation: Database path must be inside the project directory.");
    }
    this.filename = resolvedPath.endsWith(".json") ? resolvedPath : `${resolvedPath}.json`;

    // 2. Config
    this.config = {
      saveDelay: options.saveDelay || 60,
      schema: options.schema || null,
      indices: options.indices || [],
      encryptionKey: options.encryptionKey || null,
      prettyPrint: options.prettyPrint !== false, // Default to true
      silent: options.silent || false,
      wal: options.wal !== false, // Default to true
    };

    // 3. Initialize Rust Core
    this.core = new DatabaseCore(
      this.filename,
      this.config.encryptionKey || undefined,
      this.config.prettyPrint, // Pass prettyPrint
      this.config.wal // Pass use_wal
    );

    // 4. Initialization Promise
    this._initPromise = this._initialize();
  }

  private _log(level: 'info' | 'error' | 'warn', message: string, data?: any) {
    if (this.config.silent) return;

    const prefix = `[JSONDB]`;
    const formattedMsg = `${prefix} [${level.toUpperCase()}] ${message}`;

    if (level === 'error') {
        if (data) console.error(formattedMsg, data);
        else console.error(formattedMsg);
    } else if (level === 'warn') {
        if (data) console.warn(formattedMsg, data);
        else console.warn(formattedMsg);
    } else {
        if (data) console.log(formattedMsg, data);
        else console.log(formattedMsg);
    }
  }

  private async _initialize() {
      try {
          // Ensure file exists
          if (!fs.existsSync(this.filename)) {
             await fs.promises.writeFile(this.filename, "");
          }

          this.core.load();
          this._loaded = true;
          this.emit('ready');
      } catch (e) {
          this._log('error', "Failed to load database:", e);
          this.emit('error', e);
      }
  }

  // Compatibility method
  public async _ensureInitialized() {
      if (!this._loaded) await this._initPromise;
  }
  
  private _flushOps() {
      if (this._writeQueue.length === 0) return;
      const ops = this._writeQueue;
      this._writeQueue = []; // Clear ref immediately
      
      try {
          // Use JSON serialization for faster N-API transfer
          // @ts-ignore - batch_from_json is new
          this.core.batch_from_json(JSON.stringify(ops)); 
      } catch (e) {
          this._log('error', "Flush failed:", e);
      }
  }

  private async _scheduleSave(): Promise<void> {
    // Flush any pending operations first
    this._flushOps();

    // Debounce Logic: Clear existing timer
    if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
    }

    // Reuse existing promise if pending
    if (!this._savePromise) {
        this._savePromise = new Promise((resolve, reject) => {
             this._saveResolve = resolve;
             this._saveReject = reject;
        });
    }

    this._saveTimer = setTimeout(async () => {
      // Ensure flushed again just in case
      this._flushOps();

      try {
         await fs.promises.mkdir(path.dirname(this.filename), { recursive: true });

         // Ensure file exists
         if (!fs.existsSync(this.filename)) {
             await fs.promises.writeFile(this.filename, "");
         }

         // Acquire Lock
         const release = await lockfile.lock(this.filename, { retries: 3 });
         
         try {
           // Perform Save (Rust Core)
           this.core.save();
           
           if (!fs.existsSync(this.filename)) {
              this._log('error', `[CRITICAL] File missing after save: ${this.filename}`);
           }

           this.emit('write');
           if (this._saveResolve) this._saveResolve();
         } finally {
           // Release Lock
           await release();
         }

      } catch (e: any) {
         this._log('error', "Save Failed:", e);
         if (this._saveReject) this._saveReject(e);
      } finally {
         this._saveTimer = null;
         this._savePromise = null;
         this._saveResolve = null;
         this._saveReject = null;
      }
    }, this.config.saveDelay);

    return this._savePromise;
  }

  public async set(path: string, value: any): Promise<any> {
    if (!this._loaded) await this._initPromise;
    
    // Middleware Check Optimization
    if (this._middleware.before.set.length > 0) {
        let ctx: MiddlewareContext = { path, value };
        ctx = this._runMiddleware("before", "set", ctx);
        path = ctx.path;
        value = ctx.value;
    }

    if (this.config.schema) {
      this._flushOps();
      // Schema validation...
    }

    if (this.config.indices && this.config.indices.length > 0) {
        // Targeted unique check instead of full DB clone
        const hasUnique = this.config.indices.some(i => i.unique);
        if (hasUnique) {
            this._flushOps();
            for (const idx of this.config.indices) {
                if (idx.unique) {
                    const collection = this.core.get(idx.path);
                    if (Array.isArray(collection)) {
                        const val = _.get(value, idx.field) || value;
                        if (collection.some((item: any) => _.get(item, idx.field) === val)) {
                             throw new Error(`Unique index '${idx.name}' violated for value '${val}'`);
                        }
                    }
                }
            }
        }
    }

    // Add to Queue
    this._writeQueue.push({ type: 'set', path, value });
    
    // We can run 'after' middleware now
    if (this._middleware.after.set.length > 0) {
         this._runMiddleware("after", "set", { path, value, finalData: null });
    }

    // Flush if queue is full
    if (this._writeQueue.length >= this._BATCH_SIZE) {
        this._flushOps();
    }

    this._scheduleSave().catch(() => {}); // Don't await
    return true;
  }

  public async get(path?: string, defaultValue: any = null): Promise<any> {
    await this._ensureInitialized();
    this._flushOps(); // Flush before read
    const val = this.core.get(path || undefined);
    return val === null || val === undefined ? defaultValue : val;
  }

  public async has(path: string): Promise<boolean> {
    await this._ensureInitialized();
    this._flushOps(); // Flush before read
    return this.core.has(path);
  }

  public async delete(path: string): Promise<boolean> {
    await this._ensureInitialized();
    let ctx: MiddlewareContext = { path };
    ctx = this._runMiddleware("before", "delete", ctx);

    // Add to Queue
    this._writeQueue.push({ type: 'delete', path: ctx.path });

    this._runMiddleware("after", "delete", { ...ctx });
    
    if (this._writeQueue.length >= this._BATCH_SIZE) {
        this._flushOps();
    }
    
    await this._scheduleSave();
    return true;
  }

  public async push(path: string, ...items: any[]): Promise<void> {
    await this._ensureInitialized();
    this._flushOps(); // Flush before read-modify-write

    const arr = this.core.get(path);
    const targetArray = Array.isArray(arr) ? arr : [];
    
    let modified = false;
    items.forEach(item => {
        if (!targetArray.some((x: any) => _.isEqual(x, item))) {
            targetArray.push(item);
            modified = true;
        }
    });

    if (modified || !Array.isArray(arr)) {
        this._writeQueue.push({ type: 'set', path: path, value: targetArray });
        if (this._writeQueue.length >= this._BATCH_SIZE) {
            this._flushOps();
        }
        return await this._scheduleSave().catch(() => {});
    }
  }

  public async pull(path: string, ...items: any[]): Promise<void> {
    await this._ensureInitialized();
    this._flushOps(); // Flush before read-modify-write

    const arr = this.core.get(path);
    if (Array.isArray(arr)) {
        const initialLen = arr.length;
        _.pullAllWith(arr, items, _.isEqual);
        if (arr.length !== initialLen) {
            this._writeQueue.push({ type: 'set', path: path, value: arr });
            if (this._writeQueue.length >= this._BATCH_SIZE) {
                this._flushOps();
            }
            return this._scheduleSave().catch(() => {});
        }
    }
  }

  public async add(path: string, amount: number): Promise<void> {
    await this._ensureInitialized();
    this._flushOps(); // Flush before read-modify-write

    const current = this.core.get(path) || 0;
    if (typeof current !== 'number') throw new Error(`Value at ${path} is not a number`);
    
    this._writeQueue.push({ type: 'set', path: path, value: current + amount });
    if (this._writeQueue.length >= this._BATCH_SIZE) {
        this._flushOps();
    }
    return this._scheduleSave().catch(() => {});
  }

  public async subtract(path: string, amount: number): Promise<void> {
    return this.add(path, -amount);
  }

  /**
   * Find a single item matching the predicate.
   * Legacy compatibility.
   */
  public async find(path: string, predicate: any): Promise<any> {
     await this._ensureInitialized();
     this._flushOps(); // Flush before read
     if (typeof predicate === 'function') {
         // JS Predicate
         const collection = this.core.get(path);
         return _.find(collection, predicate);
     } else {
         // Object predicate - Use Rust for speed if possible, or fallback to lodash if Rust findOne is partial
         // Rust `findOne` supports mongo-style queries.
         // If `predicate` is simple object, Rust handles it.
         // @ts-ignore
         const res = this.core.findOne(path, predicate);
         // Rust returns Option<Value>, i.e. null or value.
         return res === null ? undefined : res;
     }
  }

  /**
   * Find by configured index.
   */
  public async findByIndex(indexName: string, value: any): Promise<any> {
      await this._ensureInitialized();
      this._flushOps(); // Flush before read
      const idx = this.config.indices.find(i => i.name === indexName);
      if (!idx) throw new Error(`Index with name '${indexName}' does not exist.`);

      // Construct query based on index definition
      // Index definition: { path: "users", field: "id", ... }
      // We want to find in "users" where "id" == value.
      // query: { [idx.field]: value }
      
      const query = { [idx.field]: value };
      // @ts-ignore
      const res = this.core.findOne(idx.path, query);
      return res === null ? undefined : res;
  }

  /**
   * Advanced Query (Returns Cursor).
   * Replaces legacy `find` for advanced use cases.
   */
  public query(path: string, query: any): QueryCursor {
      return new QueryCursor(this.core, path, query, this);
  }

  public async transaction(fn: (data: any) => any): Promise<any> {
      await this._ensureInitialized();
      this._flushOps();
      const data = this.core.get(undefined);
      const backup = _.cloneDeep(data);
      try {
          const mutableClone = _.cloneDeep(data);
          const result = await fn(mutableClone);
          
          if (result === undefined) throw new TransactionError("Atomic operation function returned undefined");
          
          this.core.set("", mutableClone);
          await this._scheduleSave();
          return result;
      } catch (e) {
          throw e;
      }
  }

  public async batch(ops: { type: "set" | "delete" | "push"; path: string; value?: any; values?: any[] }[]): Promise<void> {
      await this._ensureInitialized();
      this._flushOps();

      const rustOps: any[] = [];
      for (const op of ops) {
          if (op.type === 'push') {
              // Convert push to set
              const current = this.core.get(op.path) || [];
              const target = Array.isArray(current) ? _.cloneDeep(current) : [];
              if (op.values) {
                  op.values.forEach(v => {
                       if (!target.some((x: any) => _.isEqual(x, v))) target.push(v);
                  });
              }
              rustOps.push({ type: 'set', path: op.path, value: target });
          } else {
              rustOps.push(op);
          }
      }

      this.core.batch(rustOps);
      return this._scheduleSave().catch(() => {});
  }

  public async clear(): Promise<void> {
      await this._ensureInitialized();
      this._writeQueue = [];
      this.core.set("", {});
      return this._scheduleSave().catch(() => {});
  }
  
  public async paginate(path: string, page: number = 1, limit: number = 10): Promise<any> {
      await this._ensureInitialized();
      this._flushOps();
      const items = this.core.get(path);
      if (!Array.isArray(items)) throw new Error("Target is not an array");

      const total = items.length;
      const totalPages = Math.ceil(total / limit);
      const offset = (page - 1) * limit;

      return {
        data: items.slice(offset, offset + limit),
        meta: { total, page, limit, totalPages, hasNext: page < totalPages },
      };
  }
  
  public async createSnapshot(label: string = "backup"): Promise<string> {
    await this._ensureInitialized();
    // Flush to disk first
    await this._scheduleSave();
    
    const fs = require('fs').promises;
    const backupName = `${this.filename.replace(".json", "")}.${label}-${Date.now()}.bak`;
    await fs.copyFile(this.filename, backupName);
    return backupName;
  }
  
  public async close(): Promise<void> {
      if (this._savePromise) await this._savePromise;
      this._flushOps();
      this.removeAllListeners();
  }

  public before(op: string, pattern: string, cb: MiddlewareFn) {
      this._addM("before", op, pattern, cb);
  }
  public after(op: string, pattern: string, cb: MiddlewareFn) {
      this._addM("after", op, pattern, cb);
  }
  private _addM(hook: "before" | "after", op: string, pattern: string, cb: MiddlewareFn) {
      const regex = new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`);
      if (!this._middleware[hook][op]) this._middleware[hook][op] = [];
      this._middleware[hook][op].push({ regex, cb });
  }
  private _runMiddleware(hook: "before" | "after", op: string, ctx: MiddlewareContext): MiddlewareContext {
      if (!this._middleware[hook][op]) return ctx;
      this._middleware[hook][op].forEach(m => {
          if (m.regex.test(ctx.path)) ctx = m.cb(ctx);
      });
      return ctx;
  }
}

// @ts-ignore
if (typeof module !== 'undefined') {
    // @ts-ignore
    module.exports = JSONDatabase;
}

export default JSONDatabase;
