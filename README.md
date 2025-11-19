# JSON Database ST

[![NPM Version](https://badge.fury.io/js/json-database-st.svg)](https://badge.fury.io/js/json-database-st)
[![NPM Downloads](https://img.shields.io/npm/dm/json-database-st.svg)](https://www.npmjs.com/package/json-database-st)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The high-performance, secure, JSON-based database engine powering **Project Ares** and the **ST Conglomerate**.

Designed for Node.js applications that need data persistence without the complexity of SQL servers.

## 🚀 Key Features

- **🔒 AES-256-GCM Encryption:** Military-grade security for your data at rest.
- **⚡ O(1) Indexing:** Instant lookups, no matter how big the database gets.
- **🛡️ Atomic Writes:** Zero corruption risk. Uses lockfiles and temp-write-swap strategy.
- **🔢 Math Helpers:** Atomic `add` and `subtract` for financial/gaming logic.
- **📄 Pagination:** Built-in support for handling large lists efficiently.
- **📸 Snapshots:** One-line command to backup your entire database.

## 📦 Installation

```bash
npm install json-database-st lodash proper-lockfile
```

## ⚡ Quick Start

```javascript
const JSONDatabase = require('json-database-st');

const db = new JSONDatabase('data.json');

async function run() {
    // 1. Set Data
    await db.set('user.name', 'Sethun');
    
    // 2. Atomic Math (New!)
    await db.set('user.balance', 1000);
    await db.add('user.balance', 500); // Balance is now 1500
    
    // 3. Arrays with Uniqueness
    await db.push('inventory', { id: 1, item: 'Laptop' });
    
    console.log(await db.get('user'));
}

run();
```

## 📖 Documentation

Full documentation is available in the `website/docs.html` file included in this repository.

## 🏗️ Project Ares Integration

This database is optimized for the **ST Financial Engine**.
- Use `encryptionKey` for all financial records.
- Use `paginate()` for transaction history lists.
- Use `createSnapshot('daily')` for automated backups.

## 🤝 Contributing

Built by **SethunThunder** for the ST Empire. 
Laybon Gold 1.5 Assisted.
