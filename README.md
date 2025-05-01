# JSON Database By ST

[![npm version](https://badge.fury.io/js/json-database-st.svg)](https://badge.fury.io/js/json-database-st) 
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A simple, promise-based JSON file database for Node.js applications. Features atomic file operations, lodash integration for easy data access, transactions, batching, and basic querying.

Ideal for small projects, prototypes, configuration management, or simple data persistence needs where a full database server is overkill.

## Features

*   **Promise-based API:** Fully asynchronous methods.
*   **Atomic Writes:** Prevents data corruption from concurrent writes using an internal lock.
*   **Simple API:** `get`, `set`, `has`, `delete`, `push` (deep unique), `pull` (deep removal), `clear`.
*   **Lodash Integration:** Use dot/bracket notation paths (e.g., `'users.john.age'`) via `lodash`.
*   **Transactions:** Execute multiple reads/writes as a single atomic unit (`transaction`).
*   **Batch Operations:** Efficiently perform multiple `set`, `delete`, `push`, or `pull` operations in one atomic write (`batch`).
*   **Basic Querying:** Filter object properties based on a predicate function (`query`).
*   **File Auto-Creation:** Creates the JSON file (with `{}`) if it doesn't exist.
*   **Pretty Print Option:** Optionally format the JSON file for readability.
*   **Dependencies:** Only requires `lodash`. Uses built-in `fs.promises`.

## Installation

```bash
# Make sure you have lodash installed as well
npm install json-database-st lodash
```


## Quick Start

```javascript
const JSONDatabase = require('json-database-st'); // Use your package name
const path = require('path');

// Initialize (creates 'mydata.json' if needed)
const db = new JSONDatabase(path.join(__dirname, 'mydata'), { prettyPrint: true });

async function run() {
  try {
    // Set data
    await db.set('user.name', 'Bob');
    await db.set('user.settings.theme', 'dark');

    // Get data
    const theme = await db.get('user.settings.theme', 'light'); // Default value
    console.log(`Theme: ${theme}`); // -> Theme: dark

    // Push unique items (uses deep compare)
    await db.push('user.tags', 'vip', { type: 'beta' });
    await db.push('user.tags', { type: 'beta' }); // Won't be added again
    console.log('Tags:', await db.get('user.tags')); // -> ['vip', { type: 'beta' }]

    // Check existence
    console.log('Has user age?', await db.has('user.age')); // -> false

    // Delete
    await db.delete('user.settings');
    console.log('User object:', await db.get('user')); // -> { name: 'Bob', tags: [...] }

    // Get Stats
    console.log('DB Stats:', db.getStats());

  } catch (err) {
    console.error('Database operation failed:', err);
  } finally {
    // IMPORTANT: Always close the DB when done
    await db.close();
    console.log('Database closed.');
  }
}

run();
```

## Documentation

**Full API details and advanced usage examples are available in the hosted documentation:**

**[View Documentation](https://sethunthunder111.github.io/json-database-st/)**

## API Summary

*   `new JSONDatabase(filename, [options])`
*   `async get(path, [defaultValue])`
*   `async set(path, value)`
*   `async has(path)`
*   `async delete(path)`
*   `async push(path, ...items)`
*   `async pull(path, ...itemsToRemove)`
*   `async transaction(asyncFn)`
*   `async batch(operations)`
*   `async query(predicateFn, [options])`
*   `async clear()`
*   `getStats()`
*   `async close()`
*   Properties: `filename`, `config`

## Concurrency and Atomicity

Writes are queued and executed one after another for a given instance, ensuring file integrity. Reads use an in-memory cache for speed. See Core Concepts in the full documentation for details.

## Limitations

*   Best suited for small to medium-sized JSON files. Performance degrades with very large files.
*   Loads the entire database into memory.
*   Designed for single-process access to a given file. Not suitable for distributed systems.

## Contributing

Contributions (issues, PRs) are welcome! Please open an issue to discuss significant changes.

## License

[MIT](LICENSE)
