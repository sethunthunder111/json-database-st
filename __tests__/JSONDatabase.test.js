const JSONDatabase = require('../JSONDatabase');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// --- Test Setup ---
const TEST_DATA_DIR = path.join(__dirname, 'test-data');

// Helper function to create a temporary file path within the project
const getTempDbPath = () => path.join(TEST_DATA_DIR, `test-db-${Date.now()}-${Math.random()}.json`);

// --- Mock Schema for Testing ---
const mockSchema = {
    safeParse: (data) => {
        if (data && typeof data.user?.name === 'string') {
            return { success: true };
        }
        return { success: false, error: { issues: [{ message: 'User name must be a string' }] } };
    }
};


describe('JSONDatabase Core Functionality', () => {
    let dbPath;
    let db;
    let mockConsole;

    // Create the test-data directory before any tests run
    beforeAll(async () => {
        try {
            await fs.mkdir(TEST_DATA_DIR, { recursive: true });
        } catch (error) {
            console.error("Could not create test data directory", error);
        }
    });

    // Clean up the test-data directory after all tests have run
    afterAll(async () => {
        try {
            if (fs.rm) {
                await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
            } else {
                await fs.rmdir(TEST_DATA_DIR, { recursive: true });
            }
        } catch (error) {
            console.error("Could not remove test data directory", error);
        }
    });


    beforeEach(async () => {
        // Suppress console output
        mockConsole = {
            log: jest.spyOn(console, 'log').mockImplementation(() => {}),
            warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
            error: jest.spyOn(console, 'error').mockImplementation(() => {}),
        };

        dbPath = getTempDbPath();
        db = new JSONDatabase(dbPath);
        await db._ensureInitialized();
    });

    afterEach(async () => {
        if (db) {
            await db.close();
        }
        // Restore console output
        mockConsole.log.mockRestore();
        mockConsole.warn.mockRestore();
        mockConsole.error.mockRestore();

        try {
            await fs.unlink(dbPath);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                // console.error(`Failed to delete test db file: ${dbPath}`, error);
            }
        }
    });

    test('constructor should create a database file on first write', async () => {
        // File should not exist on instantiation
        await expect(fs.stat(dbPath)).rejects.toThrow();

        // Perform a write operation
        await db.set('a', 1);

        // Now the file should exist
        const stats = await fs.stat(dbPath);
        expect(stats.isFile()).toBe(true);
    });

    test('set() and get() should store and retrieve values', async () => {
        await db.set('user.name', 'John Doe');
        const name = await db.get('user.name');
        expect(name).toBe('John Doe');
    });

    test('get() should return the entire cache if path is null or undefined', async () => {
        const data = { user: { name: 'John' }, post: { title: 'Hello' } };
        await db.set('user', data.user);
        await db.set('post', data.post);
        
        const allData = await db.get();
        expect(allData).toEqual(data);
    });

    test('get() should return a default value for non-existent paths', async () => {
        const defaultValue = 'default';
        const value = await db.get('non.existent.path', defaultValue);
        expect(value).toBe(defaultValue);
    });

    test('has() should return true for an existing path', async () => {
        await db.set('a.b.c', 123);
        const exists = await db.has('a.b.c');
        expect(exists).toBe(true);
    });

    test('has() should return false for a non-existent path', async () => {
        const exists = await db.has('non.existent.path');
        expect(exists).toBe(false);
    });

    test('delete() should remove a value at a given path', async () => {
        await db.set('user.email', 'test@example.com');
        let exists = await db.has('user.email');
        expect(exists).toBe(true);

        const wasDeleted = await db.delete('user.email');
        expect(wasDeleted).toBe(true);

        exists = await db.has('user.email');
        expect(exists).toBe(false);
    });

    test('delete() should return true for a non-existent path but not change data', async () => {
        await db.set('a', 1);
        const initialData = await db.get();

        // _.unset returns true even if the path doesn't exist.
        const wasDeleted = await db.delete('non.existent.path');
        expect(wasDeleted).toBe(true);

        const finalData = await db.get();
        expect(finalData).toEqual(initialData);
    });

    test('clear() should remove all data from the database', async () => {
        await db.set('a', 1);
        await db.set('b', 2);

        await db.clear();
        const data = await db.get();
        expect(data).toEqual({});
    });
});

describe('JSONDatabase Array Operations', () => {
    let dbPath;
    let db;
    let mockConsole;

    beforeAll(async () => {
        try {
            await fs.mkdir(TEST_DATA_DIR, { recursive: true });
        } catch (error) {}
    });

    afterAll(async () => {
        try {
            if (fs.rm) await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
            else await fs.rmdir(TEST_DATA_DIR, { recursive: true });
        } catch (error) {}
    });

    beforeEach(async () => {
        mockConsole = {
            log: jest.spyOn(console, 'log').mockImplementation(() => {}),
            warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
            error: jest.spyOn(console, 'error').mockImplementation(() => {}),
        };
        dbPath = getTempDbPath();
        db = new JSONDatabase(dbPath);
        await db.set('tags', ['a', 'b']);
    });

    afterEach(async () => {
        if (db) await db.close();
        mockConsole.log.mockRestore();
        mockConsole.warn.mockRestore();
        mockConsole.error.mockRestore();
        try {
            await fs.unlink(dbPath);
        } catch (error) {}
    });

    test('push() should add items to an array', async () => {
        await db.push('tags', 'c', 'd');
        const tags = await db.get('tags');
        expect(tags).toEqual(['a', 'b', 'c', 'd']);
    });

    test('push() should not add duplicate primitive items', async () => {
        await db.push('tags', 'a', 'c');
        const tags = await db.get('tags');
        expect(tags).toEqual(['a', 'b', 'c']);
    });

    test('push() should not add duplicate object items', async () => {
        await db.set('users', [{ id: 1, name: 'A' }]);
        await db.push('users', { id: 1, name: 'A' }, { id: 2, name: 'B' });
        const users = await db.get('users');
        expect(users).toEqual([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
    });

    test('push() should create a new array if path does not exist', async () => {
        await db.push('newTags', 'x');
        const newTags = await db.get('newTags');
        expect(newTags).toEqual(['x']);
    });

    test('pull() should remove items from an array by deep equality', async () => {
        await db.set('users', [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 2 }]);
        await db.pull('users', { id: 2 });
        const users = await db.get('users');
        expect(users).toEqual([{ id: 1 }, { id: 3 }]);
    });

    test('pull() should do nothing if array does not exist', async () => {
        const initialData = await db.get();
        await db.pull('nonExistent', 'a');
        const finalData = await db.get();
        expect(finalData).toEqual(initialData);
    });
});

describe('JSONDatabase Transactions and Batch Operations', () => {
    let dbPath;
    let db;

    beforeAll(async () => {
        try {
            await fs.mkdir(TEST_DATA_DIR, { recursive: true });
        } catch (error) {}
    });

    afterAll(async () => {
        try {
            if (fs.rm) await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
            else await fs.rmdir(TEST_DATA_DIR, { recursive: true });
        } catch (error) {}
    });

    beforeEach(async () => {
        dbPath = getTempDbPath();
        db = new JSONDatabase(dbPath);
        await db.set('accounts', { a: 100, b: 200 });
    });

    afterEach(async () => {
        if (db) await db.close();
        try {
            await fs.unlink(dbPath);
        } catch (error) {}
    });

    test('transaction() should correctly modify data', async () => {
        await db.transaction(data => {
            data.accounts.a -= 50;
            data.accounts.b += 50;
            return data;
        });
        const accounts = await db.get('accounts');
        expect(accounts).toEqual({ a: 50, b: 250 });
    });

    test('transaction() should abort if function returns undefined', async () => {
        await expect(db.transaction(data => {
            data.accounts.a = 0;
        })).rejects.toThrow('Atomic operation function returned undefined');
        
        const accounts = await db.get('accounts');
        expect(accounts).toEqual({ a: 100, b: 200 });
    });

    test('transaction() should abort if function throws an error', async () => {
        await expect(db.transaction(data => {
            throw new Error("Test error");
        })).rejects.toThrow('Test error');

        const accounts = await db.get('accounts');
        expect(accounts).toEqual({ a: 100, b: 200 });
    });

    test('batch() should execute multiple operations', async () => {
        const operations = [
            { type: 'set', path: 'accounts.c', value: 300 },
            { type: 'delete', path: 'accounts.b' },
            { type: 'push', path: 'log', values: ['batch_op'] }
        ];
        await db.batch(operations);
        const data = await db.get();
        expect(data).toEqual({
            accounts: { a: 100, c: 300 },
            log: ['batch_op']
        });
    });
});

describe('JSONDatabase Advanced Features', () => {
    let dbPath;
    let db;
    let mockConsole;
    const encryptionKey = crypto.randomBytes(32).toString('hex');

    beforeAll(async () => {
        try {
            await fs.mkdir(TEST_DATA_DIR, { recursive: true });
        } catch (error) {}
    });

    afterAll(async () => {
        try {
            if (fs.rm) await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
            else await fs.rmdir(TEST_DATA_DIR, { recursive: true });
        } catch (error) {}
    });

    beforeEach(() => {
        mockConsole = {
            log: jest.spyOn(console, 'log').mockImplementation(() => {}),
            warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
            error: jest.spyOn(console, 'error').mockImplementation(() => {}),
        };
        dbPath = getTempDbPath();
    });

    afterEach(async () => {
        if (db) await db.close();
        mockConsole.log.mockRestore();
        mockConsole.warn.mockRestore();
        mockConsole.error.mockRestore();
        try {
            await fs.unlink(dbPath);
        } catch (error) {}
    });

    test('Encryption: should encrypt data and decrypt it correctly', async () => {
        db = new JSONDatabase(dbPath, { encryptionKey });
        const secretData = { secret: 'my secret' };
        await db.set('data', secretData);

        const fileContent = JSON.parse(await fs.readFile(dbPath, 'utf8'));
        expect(fileContent.iv).toBeDefined();
        expect(fileContent.tag).toBeDefined();
        expect(fileContent.content).toBeDefined();
        expect(fileContent.content).not.toContain('my secret');

        const retrieved = await db.get('data');
        expect(retrieved).toEqual(secretData);
    });

    test('Indexing: should find items by index', async () => {
        db = new JSONDatabase(dbPath, {
            indices: [{ name: 'user-email', path: 'users', field: 'email' }]
        });
        await db.set('users', {
            'user1': { name: 'Alice', email: 'alice@example.com' },
            'user2': { name: 'Bob', email: 'bob@example.com' }
        });

        const found = await db.findByIndex('user-email', 'bob@example.com');
        expect(found).toEqual({ name: 'Bob', email: 'bob@example.com' });
    });

    test('Indexing: should throw for unique index violation', async () => {
        db = new JSONDatabase(dbPath, {
            indices: [{ name: 'user-email', path: 'users', field: 'email', unique: true }]
        });
        await db.set('users.user1', { email: 'test@example.com' });
        await expect(db.set('users.user2', { email: 'test@example.com' }))
            .rejects.toThrow("Unique index 'user-email' violated for value 'test@example.com'");
    });

    test('Schema Validation: should accept valid data', async () => {
        db = new JSONDatabase(dbPath, { schema: mockSchema });
        await expect(db.set('user', { name: 'Valid Name' })).resolves.toBeDefined();
    });

    test('Schema Validation: should reject invalid data', async () => {
        db = new JSONDatabase(dbPath, { schema: mockSchema });
        await expect(db.set('user', { name: 12345 }))
            .rejects.toThrow('Schema validation failed');
    });
});

describe('JSONDatabase Middleware', () => {
    let dbPath;
    let db;
    let mockConsole;

    beforeAll(async () => {
        try {
            await fs.mkdir(TEST_DATA_DIR, { recursive: true });
        } catch (error) {}
    });

    afterAll(async () => {
        try {
            if (fs.rm) await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
            else await fs.rmdir(TEST_DATA_DIR, { recursive: true });
        } catch (error) {}
    });

    beforeEach(async () => {
        mockConsole = {
            log: jest.spyOn(console, 'log').mockImplementation(() => {}),
            warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
            error: jest.spyOn(console, 'error').mockImplementation(() => {}),
        };
        dbPath = getTempDbPath();
        db = new JSONDatabase(dbPath);
    });

    afterEach(async () => {
        if (db) await db.close();
        mockConsole.log.mockRestore();
        mockConsole.warn.mockRestore();
        mockConsole.error.mockRestore();
        try {
            await fs.unlink(dbPath);
        } catch (error) {}
    });

    test('before(set) should modify data before it is saved', async () => {
        db.before('set', 'users.*', (context) => {
            context.value.createdAt = 'timestamp';
            return context;
        });

        await db.set('users.alice', { name: 'Alice' });
        const user = await db.get('users.alice');
        expect(user).toEqual({ name: 'Alice', createdAt: 'timestamp' });
    });

    test('after(set) should be called after data is saved', async () => {
        const afterHook = jest.fn();
        db.after('set', 'users.*', afterHook);

        await db.set('users.bob', { name: 'Bob' });
        
        expect(afterHook).toHaveBeenCalledTimes(1);
        expect(afterHook).toHaveBeenCalledWith({
            path: 'users.bob',
            value: { name: 'Bob' },
            finalData: { users: { bob: { name: 'Bob' } } }
        });
    });

    test('before(delete) can be used to log or validate', async () => {
        const beforeHook = jest.fn((context) => context);
        db.before('delete', 'audits.*', beforeHook);
        await db.set('audits.log1', { data: 'some data' });

        await db.delete('audits.log1');

        expect(beforeHook).toHaveBeenCalledTimes(1);
        expect(beforeHook).toHaveBeenCalledWith({ path: 'audits.log1' });
    });
});