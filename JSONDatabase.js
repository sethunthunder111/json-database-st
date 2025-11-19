// File: JSONDatabase.js
// Version: 2.0.0 (ST Gold Edition - Complete)

const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");
const _ = require("lodash");
const EventEmitter = require("events");
const lockfile = require("proper-lockfile");

// --- Custom Errors ---
class DBError extends Error { constructor(msg) { super(msg); this.name = this.constructor.name; } }

class JSONDatabase extends EventEmitter {
    constructor(filename, options = {}) {
        super();

        // 1. Security: Path Traversal Protection
        const resolvedPath = path.resolve(filename);
        if (!resolvedPath.startsWith(process.cwd())) {
            throw new Error("Security Violation: Database path must be inside the project directory.");
        }
        this.filename = resolvedPath.endsWith(".json") ? resolvedPath : `${resolvedPath}.json`;

        // 2. Configuration
        this.config = {
            encryptionKey: options.encryptionKey ? Buffer.from(options.encryptionKey, "hex") : null,
            prettyPrint: options.prettyPrint !== false,
            saveDelay: options.saveDelay || 60, // Speed optimization (Debounce)
            indices: options.indices || [],
            schema: options.schema || null
        };

        // 3. Validate Key
        if (this.config.encryptionKey && this.config.encryptionKey.length !== 32) {
            throw new Error("Encryption key must be exactly 32 bytes (64 hex chars).");
        }

        // 4. Internal State
        this.data = {}; 
        this._indices = new Map();
        this._writeTimeout = null;
        this._writePromise = Promise.resolve();
        this._loaded = false;

        // 5. Middleware Storage
        this._middleware = {
            before: { set: [], delete: [], push: [], pull: [] },
            after: { set: [], delete: [], push: [], pull: [] }
        };

        // 6. Start Loading
        this._initPromise = this._load();
    }

    // ==========================================
    //             CORE ENGINE
    // ==========================================

    async _load() {
        try {
            // Crash Recovery: Check for .tmp file
            if (fsSync.existsSync(this.filename + ".tmp")) {
                console.warn("[JSONDatabase] Recovering from crash...");
                await fs.rename(this.filename + ".tmp", this.filename);
            }

            // Ensure file exists
            await fs.access(this.filename).catch(async () => {
                await fs.writeFile(this.filename, this.config.encryptionKey ? this._encrypt({}) : '{}');
            });

            // Read & Parse
            const content = await fs.readFile(this.filename, "utf8");
            this.data = content.trim() ? (this.config.encryptionKey ? this._decrypt(content) : JSON.parse(content)) : {};
        } catch (e) {
            console.error("[JSONDatabase] Load Error:", e);
            this.data = {}; // Fallback
        }
        this._rebuildIndices();
        this._loaded = true;
        this.emit("ready");
    }

    async _ensureReady() {
        if (!this._loaded) await this._initPromise;
    }

    /**
     * The "Smart Save" Engine.
     * Updates indices immediately, then schedules a disk write.
     */
    async _save() {
        this._rebuildIndices(); 
        this.emit("change", this.data);

        // Debounce: Cancel previous timer
        if (this._writeTimeout) clearTimeout(this._writeTimeout);

        return new Promise((resolve, reject) => {
            this._writeTimeout = setTimeout(async () => {
                // Queue behind any existing write
                await this._writePromise;
                
                this._writePromise = (async () => {
                    let release;
                    try {
                        // Atomic Lock
                        release = await lockfile.lock(this.filename, { retries: 3 });
                        
                        const content = this.config.encryptionKey 
                            ? this._encrypt(this.data) 
                            : JSON.stringify(this.data, null, this.config.prettyPrint ? 2 : 0);
                        
                        // Safe Write: Write Tmp -> Rename
                        const temp = this.filename + ".tmp";
                        await fs.writeFile(temp, content);
                        await fs.rename(temp, this.filename);
                        
                        this.emit("write");
                        resolve();
                    } catch (e) {
                        console.error("[JSONDatabase] Write Failed:", e);
                        reject(e);
                    } finally {
                        if (release) await release();
                    }
                })();
            }, this.config.saveDelay);
        });
    }

    // ==========================================
    //           BASIC OPERATIONS
    // ==========================================

    async set(path, value) {
        await this._ensureReady();
        const ctx = this._runMiddleware('before', 'set', { path, value });
        _.set(this.data, ctx.path, ctx.value);
        
        // Schema Validation check (if configured)
        if (this.config.schema) {
            const result = this.config.schema.safeParse(this.data);
            if (!result.success) throw new Error(`Schema Validation Failed: ${JSON.stringify(result.error.issues)}`);
        }

        const p = this._save();
        this._runMiddleware('after', 'set', { ...ctx, data: this.data });
        return p;
    }

    async get(path, defaultValue = null) {
        await this._ensureReady();
        return _.get(this.data, path, defaultValue);
    }

    async has(path) {
        await this._ensureReady();
        return _.has(this.data, path);
    }

    async delete(path) {
        await this._ensureReady();
        const ctx = this._runMiddleware('before', 'delete', { path });
        _.unset(this.data, ctx.path);
        const p = this._save();
        this._runMiddleware('after', 'delete', { ...ctx, data: this.data });
        return p;
    }

    async push(path, ...items) {
        await this._ensureReady();
        const arr = _.get(this.data, path, []);
        if (!Array.isArray(arr)) throw new Error(`Path ${path} is not an array`);
        
        let modified = false;
        items.forEach(item => {
            if (!arr.some(x => _.isEqual(x, item))) {
                arr.push(item);
                modified = true;
            }
        });

        if (modified) {
            _.set(this.data, path, arr);
            return this._save();
        }
    }

    async pull(path, ...items) {
        await this._ensureReady();
        const arr = _.get(this.data, path);
        if (Array.isArray(arr)) {
            _.pullAllWith(arr, items, _.isEqual);
            return this._save();
        }
    }

    // ==========================================
    //           LAYBON 1.5 MATH
    // ==========================================

    async add(path, amount) {
        await this._ensureReady();
        const current = _.get(this.data, path, 0);
        if (typeof current !== 'number') throw new Error(`Value at ${path} is not a number`);
        _.set(this.data, path, current + amount);
        return this._save();
    }

    async subtract(path, amount) {
        return this.add(path, -amount);
    }

    // ==========================================
    //        ADVANCED (Transaction/Batch)
    // ==========================================

    /** 
     * Executes a function against the current data.
     * Since we use debouncing, this is effectively atomic in memory.
     */
    async transaction(fn) {
        await this._ensureReady();
        const result = await fn(this.data); // Pass reference to data
        await this._save();
        return result;
    }

    async batch(ops) {
        await this._ensureReady();
        for(const op of ops) {
            if(op.type === 'set') _.set(this.data, op.path, op.value);
            else if(op.type === 'delete') _.unset(this.data, op.path);
            else if(op.type === 'push') {
                const arr = _.get(this.data, op.path, []);
                op.values.forEach(v => { if(!arr.includes(v)) arr.push(v) });
            }
        }
        return this._save();
    }

    async clear() {
        await this._ensureReady();
        this.data = {};
        return this._save();
    }

    // ==========================================
    //           QUERY & PAGINATION
    // ==========================================

    async find(path, predicate) {
        await this._ensureReady();
        return _.find(_.get(this.data, path), predicate);
    }

    async findByIndex(indexName, value) {
        await this._ensureReady();
        const map = this._indices.get(indexName);
        if (!map) throw new Error(`Index ${indexName} not found`);
        const path = map.get(value);
        return path ? _.get(this.data, path) : undefined;
    }

    async paginate(path, page = 1, limit = 10) {
        await this._ensureReady();
        const items = _.get(this.data, path, []);
        if (!Array.isArray(items)) throw new Error("Target is not an array");
        
        const total = items.length;
        const totalPages = Math.ceil(total / limit);
        const offset = (page - 1) * limit;
        
        return {
            data: items.slice(offset, offset + limit),
            meta: { total, page, limit, totalPages, hasNext: page < totalPages }
        };
    }

    // ==========================================
    //           UTILITIES
    // ==========================================

    async createSnapshot(label = 'manual') {
        await this._ensureReady();
        // Force a save first to ensure disk is up to date
        await this._savePromise; 
        const backupName = `${this.filename.replace('.json', '')}.${label}-${Date.now()}.bak`;
        await fs.copyFile(this.filename, backupName);
        return backupName;
    }

    async close() {
        // Wait for any pending writes
        if (this._writeTimeout) clearTimeout(this._writeTimeout);
        await this._writePromise;
        this.removeAllListeners();
        this.data = null;
    }

    // Middleware Helpers
    before(op, pattern, cb) { this._addM('before', op, pattern, cb); }
    after(op, pattern, cb) { this._addM('after', op, pattern, cb); }
    _addM(hook, op, pattern, cb) {
        // Convert glob pattern (users.*) to Regex
        const regex = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
        this._middleware[hook][op].push({ regex, cb });
    }
    _runMiddleware(hook, op, ctx) {
        this._middleware[hook][op].forEach(m => { 
            if(m.regex.test(ctx.path)) ctx = m.cb(ctx); 
        });
        return ctx;
    }

    // Internal: Indexing
    _rebuildIndices() {
        this._indices.clear();
        this.config.indices.forEach(idx => {
            const map = new Map();
            const col = _.get(this.data, idx.path);
            if (typeof col === 'object') {
                _.forEach(col, (item, key) => {
                    const val = _.get(item, idx.field);
                    if (val !== undefined) map.set(val, `${idx.path}.${key}`);
                });
            }
            this._indices.set(idx.name, map);
        });
    }

    // Internal: Crypto
    _encrypt(d) {
        const iv = crypto.randomBytes(16);
        const c = crypto.createCipheriv("aes-256-gcm", this.config.encryptionKey, iv);
        const e = Buffer.concat([c.update(JSON.stringify(d)), c.final()]);
        return JSON.stringify({ iv: iv.toString('hex'), t: c.getAuthTag().toString('hex'), d: e.toString('hex') });
    }
    _decrypt(s) {
        const p = JSON.parse(s);
        const d = crypto.createDecipheriv("aes-256-gcm", this.config.encryptionKey, Buffer.from(p.iv, 'hex'));
        d.setAuthTag(Buffer.from(p.t, 'hex'));
        return JSON.parse(Buffer.concat([d.update(Buffer.from(p.d, 'hex')), d.final()]).toString());
    }
}

module.exports = JSONDatabase;