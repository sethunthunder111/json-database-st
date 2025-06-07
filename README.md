# JSON Database ST

[![NPM Version](https://badge.fury.io/js/json-database-st.svg)](https://badge.fury.io/js/json-database-st)
[![NPM Downloads](https://img.shields.io/npm/dm/json-database-st.svg)](https://www.npmjs.com/package/json-database-st)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A secure, performant, and feature-rich JSON file database for Node.js. Designed for projects that need simple, persistent data storage without the overhead of a traditional database server, but with modern features like **encryption, indexing, and schema validation**.

Ideal for small to medium-sized projects, configuration management, user session data, or any application where data safety and integrity are critical.

## Features

*   **🔒 Security First:**
    *   **Encryption at Rest:** Built-in AES-256-GCM encryption protects your data on disk.
    *   **Path Traversal Protection:** Prevents malicious file path inputs.
    *   **Secure by Default:** Fails safely if data is tampered with or the key is wrong.

*   **⚡ High-Performance Indexing:**
    *   Create indexes on your data fields (e.g., `users.email`).
    *   Enjoy near-instantaneous `O(1)` lookups with `findByIndex()`, avoiding slow full-database scans.

*   **🤝 Atomic & Reliable:**
    *   **Atomic Writes:** All write operations (`set`, `transaction`, `batch`, etc.) are queued and executed atomically, preventing data corruption.
    *   **Transactions:** Execute complex multi-step operations as a single, indivisible unit.
    *   **Batching:** Perform multiple simple operations in a single, efficient disk write.

*   **✅ Data Integrity:**
    *   **Schema Validation:** Integrate with libraries like Zod or Joi to enforce data structures on every write, preventing bad data from ever being saved.
    *   **Deep Uniqueness:** The `push()` method automatically prevents duplicate entries in arrays using deep object comparison.

*   **📢 Modern & DX-Focused API:**
    *   **Promise-based:** Fully asynchronous `async/await` friendly API.
    *   **Event-Driven:** Emits `write`, `change`, and `error` events for reactive programming, auditing, or real-time updates.
    *   **Intuitive & Powerful:** A clean API (`get`, `set`, `find`) powered by `lodash` for flexible path notation.

## Installation

```bash
# This package requires lodash as a peer dependency
npm install json-database-st lodash
```

## Quick Start: Secure & Indexed Database

This example demonstrates setting up a secure, encrypted database with a high-speed index on user emails.

```javascript
const JSONDatabase = require('json-database-st');
const path = require('path');
const crypto = require('crypto');

// 1. Generate a secure key (run once and store it in environment variables)
// const encryptionKey = crypto.randomBytes(32).toString('hex');
// console.log('Your secure encryption key:', encryptionKey);
const ENCRYPTION_KEY = 'd0a7e8c1b2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9'; // Example key

// 2. Initialize the database with encryption and an index
const db = new JSONDatabase(path.join(__dirname, 'secure-data.json'), {
  encryptionKey: ENCRYPTION_KEY,
  indices: [
    { name: 'user-email', path: 'users', field: 'email', unique: true }
  ]
});

async function run() {
  try {
    // 3. Set data. The index will be updated automatically.
    await db.set('users.alice', { email: 'alice@example.com', name: 'Alice' });
    await db.set('users.bob', { email: 'bob@example.com', name: 'Bob' });
    
    // This would throw an IndexViolationError because the email is not unique
    // await db.set('users.impostor', { email: 'alice@example.com', name: 'Impostor' });

    // 4. Use the high-speed index for an instant lookup
    console.log('--- Finding user with index ---');
    const alice = await db.findByIndex('user-email', 'alice@example.com');
    console.log('Found user:', alice); // -> { email: 'alice@example.com', name: 'Alice' }

    // 5. Perform a transaction
    await db.transaction(data => {
      data.users.bob.lastLogin = Date.now();
      return data; // Must return the modified data
    });

    console.log('\n--- Bob after transaction ---');
    console.log(await db.get('users.bob'));

  } catch (err) {
    console.error('Database operation failed:', err);
  } finally {
    // 6. IMPORTANT: Always close the DB for a graceful shutdown
    await db.close();
  }
}

run();
```

## Documentation

**Full API details and advanced usage examples are available on the hosted documentation site:**

**[View Full Documentation Website](https://sethunthunder111.github.io/json-database-st/)**

## API Summary

*   `new JSONDatabase(filename, [options])`
*   `async get(path, [defaultValue])`
*   `async set(path, value)`
*   `async has(path)`
*   `async delete(path)`
*   `async push(path, ...items)`
*   `async pull(path, ...itemsToRemove)`
*   `async transaction(asyncFn)`
*   `async batch(operations, [options])`
*   `async find(collectionPath, predicate)`
*   `async findByIndex(indexName, value)`
*   `async clear()`
*   `getStats()`
*   `async close()`
*   Events: `.on('write', handler)`, `.on('change', handler)`, `.on('error', handler)`

## Limitations

*   **In-Memory Operation:** The entire database file is loaded into memory on initialization. This makes it extremely fast for reads but limits the practical file size to what can comfortably fit in your available RAM.
*   **Single-Process Focus:** While writes are atomic, this library is designed for use by a single Node.js process. Using it with multiple processes writing to the same file (e.g., in a cluster) is not recommended and can lead to race conditions.
*   **Not a Replacement for SQL/NoSQL Servers:** For very large datasets, high write concurrency, complex queries, or multi-process/multi-server needs, a dedicated database system like PostgreSQL, MongoDB, or SQLite is the appropriate choice.

## Contributing

Contributions, issues, and feature requests are welcome! Please feel free to open an issue to discuss any significant changes.

## License

[MIT](LICENSE)
