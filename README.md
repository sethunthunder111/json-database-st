# JSON Database ST

> High-performance, lightweight JSON-based database engine for Node.js & Bun.
> Powered by a **Rust** core for speed and reliability.

[![npm version](https://img.shields.io/npm/v/json-database-st.svg)](https://www.npmjs.com/package/json-database-st)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **WARNING:** This library currently only works on **macOS** and **Windows**. Linux support is temporarily unavailable.

## 🚀 Features

- **⚡ Blazing Fast:** Core logic written in **Rust** via N-API for native performance.
- **🛡️ Atomic Operations:** Uses Write-Ahead Logging (WAL) and atomic file swaps to prevent data corruption.
- **🔍 O(1) Indexing:** In-memory `Map` indices allow for instant lookups by field.
- **🔒 Encryption:** Optional AES-256-GCM encryption for data at rest.
- **📦 Zero Dependencies (Runtime):** Self-contained native binary; no heavy external DB servers required.
- **🔄 Middleware:** Support for `before` and `after` hooks on operations.
- **💾 JSON Compatible:** Stores data in a simple, portable JSON file.

## 📦 Installation

```bash
bun add json-database-st
# or
npm install json-database-st
```

## 🛠️ Usage

### Basic Example

```javascript
const { JSONDatabase } = require('json-database-st');

const db = new JSONDatabase('mydb.json', {
    encryptionKey: 'my-secret-key-123', // Optional: encrypts the file
    indices: [
        { name: 'email', path: 'users', field: 'email' } // O(1) lookup index
    ]
});

async function main() {
    // Write data
    await db.set('users.u1', {
        id: 1,
        name: 'Alice',
        email: 'alice@example.com'
    });

    // Read data
    const user = await db.get('users.u1');
    console.log(user); 
    // { id: 1, name: 'Alice', ... }

    // O(1) Lookup by Index
    const alice = await db.findByIndex('email', 'alice@example.com');
    console.log(alice); 
    // { id: 1, name: 'Alice', ... }
    
    // Atomic Math Operations
    await db.add('stats.visits', 1);
}

main();
```

## ⚙️ Configuration

| Option | Type | Default | Description |
|os|--- |--- |--- |--- |
| `saveDelay` | `number` | `60` | Debounce time (ms) for writes. Higher = better batching, lower = faster disk commit. |
| `wal` | `boolean` | `true` | If true, uses Write-Ahead Logging for maximum durability. |

## 📖 Documentation

Visit our full documentation site: [https://sethunthunder111.github.io/json-database-st/docs.html](https://sethunthunder111.github.io/json-database-st/docs.html)


## 📊 Benchmarks

*Running benchmarks on your local machine...*

> **Note:** Performance depends heavily on disk I/O speed (SSD recommended).

## 📄 License

MIT
