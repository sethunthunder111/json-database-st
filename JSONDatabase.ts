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
  schema?: any;
  indices?: { name: string; path: string; field: string; unique?: boolean }[];
  silent?: boolean;
  wal?: boolean;
}

export interface MiddlewareContext {
  path: string;
  value?: any;
  finalData?: any;
  [key: string]: any;
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
  issues?: any[];
  constructor(msg: string, issues?: any[]) {
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
            // @ts-ignore
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
                     result = _.orderBy(result, Object.keys(this.options.sort), Object.values(this.options.sort).map((v: any) => v === 1 ? 'asc' : 'desc'));
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
  private _savePromise: Promise<boolean> | null = null;
  private _saveResolve: ((value: boolean | PromiseLike<boolean>) => void) | null = null;
  private _saveReject: ((reason?: any) => void) | null = null;
  
  private _middleware: MiddlewareStore = {
    before: { set: [], delete: [], push: [], pull: [] },
    after: { set: [], delete: [], push: [], pull: [] },
  };
  private _loaded: boolean = false;
  private _initPromise: Promise<void>;
  private _writeQueue: any[] = [];
  private _BATCH_SIZE: number = 1000;

  constructor(filename: string, options: DatabaseOptions = {}) {
    super();

    const resolvedPath = path.resolve(filename);
    if (!resolvedPath.startsWith(process.cwd())) {
      throw new Error("Security Violation: Database path must be inside the project directory.");
    }
    this.filename = resolvedPath.endsWith(".json") ? resolvedPath : `${resolvedPath}.json`;

    this.config = {
      saveDelay: options.saveDelay || 60,
      schema: options.schema || null,
      indices: options.indices || [],
      encryptionKey: options.encryptionKey || null,
      prettyPrint: options.prettyPrint !== false,
      silent: options.silent || false,
      wal: options.wal !== false,
    };

    this.core = new DatabaseCore(
      this.filename,
      this.config.encryptionKey || undefined,
      this.config.prettyPrint,
      this.config.wal
    );

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
          if (fs.existsSync(this.filename)) {
              this.core.load();
          } else {
              this.core.set("", {});
          }
          this._loaded = true;
          this.emit('ready');
      } catch (e) {
          this._log('error', "Failed to load database:", e);
          this.emit('error', e);
      }
  }

  public async _ensureInitialized() {
      if (!this._loaded) await this._initPromise;
  }
  
  private _flushOps() {
      if (this._writeQueue.length === 0) return;
      const ops = this._writeQueue;
      this._writeQueue = []; 
      
      try {
          this.core.batch(ops);
          for (const op of ops) {
              if (this._middleware.after[op.type]) {
                  const { type, ...rest } = op;
                  this._runMiddleware("after", type, { ...rest, finalData: this.core.get(undefined) });
              }
          }
      } catch (e) {
          this._log('error', "Flush failed:", e);
      }
  }

  private async _scheduleSave(): Promise<boolean> {
    this._flushOps();

    if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
    }

    if (!this._savePromise) {
        this._savePromise = new Promise((resolve, reject) => {
             this._saveResolve = resolve;
             this._saveReject = reject;
        });
    }

    this._saveTimer = setTimeout(async () => {
      this._flushOps();

      try {
         const dir = path.dirname(this.filename);
         if (!fs.existsSync(dir)) {
             await fs.promises.mkdir(dir, { recursive: true });
         }

         let release = () => {};
         if (fs.existsSync(this.filename)) {
             release = await lockfile.lock(this.filename, { retries: 3 });
         }
         
         try {
           this.core.save();
           this.emit('write');
           if (this._saveResolve) this._saveResolve(true);
         } finally {
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

  public async set(path: string, value: any): Promise<boolean> {
    await this._ensureInitialized();
    
    let ctx = { path, value };
    ctx = this._runMiddleware("before", "set", ctx);

    if (this.config.schema) {
      if (this.config.schema.safeParse) {
          const res = this.config.schema.safeParse({ user: ctx.value });
          if (!res.success) throw new ValidationError("Schema validation failed", res.error.issues);
      } else if (typeof this.config.schema === 'function') {
          if (!this.config.schema(ctx.value)) throw new ValidationError("Schema validation failed");
      }
    }

    if (this.config.indices && this.config.indices.length > 0) {
        const hasUnique = this.config.indices.some(i => i.unique);
        if (hasUnique) {
            this._flushOps();
            for (const idx of this.config.indices) {
                if (idx.unique) {
                    const collection = this.core.get(idx.path);
                    if (collection) {
                        const val = _.get(ctx.value, idx.field) || ctx.value;
                        const items = Array.isArray(collection) ? collection : Object.values(collection);
                        if (items.some((item: any) => _.get(item, idx.field) === val)) {
                             throw new Error(`Unique index '${idx.name}' violated for value '${val}'`);
                        }
                    }
                }
            }
        }
    }

    this._writeQueue.push({ type: 'set', path: ctx.path, value: ctx.value });
    
    if (this._writeQueue.length >= this._BATCH_SIZE) {
        this._flushOps();
    }

    return await this._scheduleSave();
  }

  public async get(path?: string, defaultValue: any = null): Promise<any> {
    await this._ensureInitialized();
    this._flushOps(); 
    const val = this.core.get(path || undefined);
    return val === null || val === undefined ? defaultValue : val;
  }

  public async has(path: string): Promise<boolean> {
    await this._ensureInitialized();
    this._flushOps(); 
    return this.core.has(path);
  }

  public async delete(path: string): Promise<boolean> {
    await this._ensureInitialized();
    let ctx = { path };
    ctx = this._runMiddleware("before", "delete", ctx);

    this._writeQueue.push({ type: 'delete', path: ctx.path });
    
    if (this._writeQueue.length >= this._BATCH_SIZE) {
        this._flushOps();
    }

    return await this._scheduleSave();
  }

  public async push(path: string, ...items: any[]): Promise<boolean | void> {
    await this._ensureInitialized();
    this._flushOps(); 

    const arr = this.core.get(path);
    const targetArray = Array.isArray(arr) ? _.cloneDeep(arr) : [];
    
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
        return await this._scheduleSave();
    }
    return true;
  }

  public async pull(path: string, ...items: any[]): Promise<boolean | void> {
    await this._ensureInitialized();
    this._flushOps(); 

    const arr = this.core.get(path);
    if (Array.isArray(arr)) {
        const copy = _.cloneDeep(arr);
        const initialLen = copy.length;
        _.pullAllWith(copy, items, _.isEqual);
        if (copy.length !== initialLen) {
            this._writeQueue.push({ type: 'set', path: path, value: copy });
            if (this._writeQueue.length >= this._BATCH_SIZE) {
                this._flushOps();
            }
            return await this._scheduleSave();
        }
    }
    return true;
  }

  public async add(path: string, amount: number): Promise<boolean> {
    await this._ensureInitialized();
    this._flushOps(); 

    const current = this.core.get(path) || 0;
    if (typeof current !== 'number') throw new Error(`Value at ${path} is not a number`);
    
    this._writeQueue.push({ type: 'set', path: path, value: current + amount });
    if (this._writeQueue.length >= this._BATCH_SIZE) {
        this._flushOps();
    }
    return await this._scheduleSave();
  }

  public async subtract(path: string, amount: number): Promise<boolean> {
    return this.add(path, -amount);
  }

  public async find(path: string, predicate: any): Promise<any> {
     await this._ensureInitialized();
     this._flushOps(); 
     if (typeof predicate === 'function') {
         const collection = this.core.get(path);
         return _.find(collection, predicate);
     } else {
         const res = this.core.findOne(path, predicate);
         return res === null ? undefined : res;
     }
  }

  public async findByIndex(indexName: string, value: any): Promise<any> {
      await this._ensureInitialized();
      this._flushOps(); 
      const idx = this.config.indices.find(i => i.name === indexName);
      if (!idx) throw new Error(`Index with name '${indexName}' does not exist.`);

      const query = { [idx.field]: value };
      const res = this.core.findOne(idx.path, query);
      return res === null ? undefined : res;
  }

  public query(path: string, query: any): QueryCursor {
      return new QueryCursor(this.core, path, query, this);
  }

  public async transaction(fn: (data: any) => any): Promise<boolean> {
      await this._ensureInitialized();
      this._flushOps(); 
      const data = this.core.get(undefined);
      try {
          const mutableClone = _.cloneDeep(data);
          const result = await fn(mutableClone);
          
          if (result === undefined) throw new TransactionError("Atomic operation function returned undefined");
          
          this.core.set("", mutableClone);
          return await this._scheduleSave();
      } catch (e) {
          throw e;
      }
  }

  public async batch(ops: { type: "set" | "delete" | "push"; path: string; value?: any; values?: any[] }[]): Promise<boolean> {
      await this._ensureInitialized();
      this._flushOps();

      const rustOps: any[] = [];
      for (const op of ops) {
          if (op.type === 'push') {
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
      return await this._scheduleSave();
  }

  public async clear(): Promise<boolean> {
      await this._ensureInitialized();
      this._writeQueue = []; 
      this.core.set("", {});
      return await this._scheduleSave();
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
    await this._scheduleSave(); 
    
    const backupName = `${this.filename.replace(".json", "")}.${label}-${Date.now()}.bak`;
    await fs.promises.copyFile(this.filename, backupName);
    return backupName;
  }
  
  public async close(): Promise<void> {
      if (this._savePromise) await this._savePromise;
      this._flushOps(); 
      this.removeAllListeners();
  }

  public before(op: 'set' | 'delete' | 'push' | 'pull', pattern: string, cb: MiddlewareFn) {
      this._addM("before", op, pattern, cb);
  }
  public after(op: 'set' | 'delete' | 'push' | 'pull', pattern: string, cb: MiddlewareFn) {
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
