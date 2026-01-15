const { EventEmitter } = require('events');
const path = require('path');
const lockfile = require('proper-lockfile');
const _ = require('lodash');
const fs = require('fs');
const { DatabaseCore } = require('./index');

// Custom Errors
class DBError extends Error {
  constructor(msg) {
    super(msg);
    this.name = this.constructor.name;
  }
}
class TransactionError extends DBError {}
class ValidationError extends DBError {
  constructor(msg, issues) {
    super(msg);
    this.issues = issues;
  }
}

class QueryCursor {
    constructor(core, path, query, dbInstance) {
        this.core = core;
        this.path = path;
        this.query = query;
        this.dbInstance = dbInstance;
        this.options = {};
    }

    limit(n) {
        this.options.limit = n;
        return this;
    }

    skip(n) {
        this.options.skip = n;
        return this;
    }

    sort(criteria) {
        this.options.sort = criteria;
        return this;
    }

    select(fields) {
        this.options.select = fields;
        return this;
    }

    async exec() {
        if (this.dbInstance) {
            this.dbInstance._flushOps();
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
                 result = result.map(item => _.pick(item, this.options.select));
            }
            return result;
        } else {
            return this.core.find(this.path, this.query, this.options);
        }
    }

    then(onfulfilled, onrejected) {
        return this.exec().then(onfulfilled, onrejected);
    }
}

class JSONDatabase extends EventEmitter {
  static DBError = DBError;
  static TransactionError = TransactionError;
  static ValidationError = ValidationError;
  static QueryCursor = QueryCursor;

  constructor(filename, options = {}) {
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

    this._saveTimer = null;
    this._savePromise = null;
    this._saveResolve = null;
    this._saveReject = null;
    
    this._middleware = {
      before: { set: [], delete: [], push: [], pull: [] },
      after: { set: [], delete: [], push: [], pull: [] },
    };
    this._loaded = false;
    this._writeQueue = [];
    this._BATCH_SIZE = 1000;
    this._performSaveBound = this._performSave.bind(this);

    this._initPromise = this._initialize();
  }

  _log(level, message, data) {
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

  async _initialize() {
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

  async _ensureInitialized() {
      if (!this._loaded) await this._initPromise;
  }

  _flushOps() {
      if (this._writeQueue.length === 0) return;
      const ops = this._writeQueue;
      this._writeQueue = []; 
      
      try {
          this.core.batch(ops);
          
          const hasAfter = Object.values(this._middleware.after).some(arr => arr.length > 0);
          if (hasAfter) {
              for (const op of ops) {
                  if (this._middleware.after[op.type] && this._middleware.after[op.type].length > 0) {
                      const { type, ...rest } = op;
                      this._runMiddleware("after", type, { ...rest, finalData: this.core.get(undefined) });
                  }
              }
          }
      } catch (e) {
          this._log('error', "Flush failed:", e);
      }
  }

  async _performSave() {
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

      } catch (e) {
         this._log('error', "Save Failed:", e);
         if (this._saveReject) this._saveReject(e);
      } finally {
         this._saveTimer = null;
         this._savePromise = null;
         this._saveResolve = null;
         this._saveReject = null;
      }
  }

  _scheduleSave() {
    // this._flushOps(); // REMOVED: Batching optimization. Flush only on read or before save.

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

    this._saveTimer = setTimeout(this._performSaveBound, this.config.saveDelay);

    return this._savePromise;
  }

  set(path, value) {
    try {
        if (!this._loaded) {
            return this._initPromise.then(() => this._setSync(path, value));
        }
        return this._setSync(path, value);
    } catch (e) {
        return Promise.reject(e);
    }
  }

  _setSync(path, value) {
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
                        if (items.some((item) => _.get(item, idx.field) === val)) {
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

    return this._scheduleSave();
  }

  async get(path, defaultValue = null) {
    await this._ensureInitialized();
    this._flushOps(); 
    const val = this.core.get(path || undefined);
    return val === null || val === undefined ? defaultValue : val;
  }

  async has(path) {
    await this._ensureInitialized();
    this._flushOps(); 
    return this.core.has(path);
  }

  async delete(path) {
    await this._ensureInitialized();
    let ctx = { path };
    ctx = this._runMiddleware("before", "delete", ctx);

    this._writeQueue.push({ type: 'delete', path: ctx.path });
    
    if (this._writeQueue.length >= this._BATCH_SIZE) {
        this._flushOps();
    }

    return await this._scheduleSave();
  }

  async push(path, ...items) {
    await this._ensureInitialized();
    this._flushOps(); 

    const arr = this.core.get(path);
    const targetArray = Array.isArray(arr) ? _.cloneDeep(arr) : [];
    
    let modified = false;
    items.forEach(item => {
        if (!targetArray.some((x) => _.isEqual(x, item))) {
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

  async pull(path, ...items) {
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

  async add(path, amount) {
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

  async subtract(path, amount) {
    return this.add(path, -amount);
  }

  async find(path, predicate) {
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

  async findByIndex(indexName, value) {
      await this._ensureInitialized();
      this._flushOps(); 
      const idx = this.config.indices.find(i => i.name === indexName);
      if (!idx) throw new Error(`Index with name '${indexName}' does not exist.`);

      const query = { [idx.field]: value };
      const res = this.core.findOne(idx.path, query);
      return res === null ? undefined : res;
  }

  query(path, query) {
      return new QueryCursor(this.core, path, query, this);
  }

  async transaction(fn) {
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

  async batch(ops) {
      await this._ensureInitialized();
      this._flushOps();

      const rustOps = [];
      for (const op of ops) {
          if (op.type === 'push') {
              const current = this.core.get(op.path) || [];
              const target = Array.isArray(current) ? _.cloneDeep(current) : [];
              if (op.values) {
                  op.values.forEach(v => {
                       if (!target.some((x) => _.isEqual(x, v))) target.push(v);
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

  async clear() {
      await this._ensureInitialized();
      this._writeQueue = []; 
      this.core.set("", {});
      return await this._scheduleSave();
  }
  
  async paginate(path, page = 1, limit = 10) {
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
  
  async createSnapshot(label = "backup") {
    await this._ensureInitialized();
    await this._scheduleSave(); 
    
    const backupName = `${this.filename.replace(".json", "")}.${label}-${Date.now()}.bak`;
    await fs.promises.copyFile(this.filename, backupName);
    return backupName;
  }
  
  async close() {
      if (this._savePromise) await this._savePromise;
      this._flushOps(); 
      this.removeAllListeners();
  }

  before(op, pattern, cb) {
      this._addM("before", op, pattern, cb);
  }
  after(op, pattern, cb) {
      this._addM("after", op, pattern, cb);
  }
  _addM(hook, op, pattern, cb) {
      const regex = new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`);
      if (!this._middleware[hook][op]) this._middleware[hook][op] = [];
      this._middleware[hook][op].push({ regex, cb });
  }
  _runMiddleware(hook, op, ctx) {
      if (!this._middleware[hook][op]) return ctx;
      this._middleware[hook][op].forEach(m => {
          if (m.regex.test(ctx.path)) ctx = m.cb(ctx);
      });
      return ctx;
  }
}

module.exports = JSONDatabase;
module.exports.default = JSONDatabase;
