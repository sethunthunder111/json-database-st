## Project Overview

This project is a Node.js library called `json-database-st`, which provides a simple, secure, and performant JSON file-based database. It is designed for small to medium-sized projects that require persistent data storage without the overhead of a traditional database server.

**Key Features:**

*   **Security:** Implements AES-256-GCM encryption at rest and protects against path traversal attacks.
*   **Performance:** Utilizes indexing for near-instantaneous `O(1)` lookups, avoiding slow, full-database scans.
*   **Reliability:** Ensures data integrity through atomic write operations, transactions, and batching.
*   **Data Integrity:** Supports schema validation using libraries like Zod or Joi.
*   **Modern API:** Offers a promise-based, `async/await` friendly API and an event-driven architecture with middleware hooks.

**Core Technologies:**

*   **Language:** JavaScript (Node.js)
*   **Key Dependencies:**
    *   `lodash`: For data manipulation and path notation.
    *   `proper-lockfile`: To prevent race conditions and ensure atomic writes.
*   **Testing Framework:** Jest

**Architecture:**

The main logic is encapsulated in the `JSONDatabase.js` class. The database is loaded into memory on initialization for fast read operations. All write operations are queued and executed atomically to prevent data corruption. The library is event-driven, emitting `write`, `change`, and `error` events, and supports `before()` and `after()` hooks for middleware.

## Building and Running

### Installation

This project is a Node.js library. To use it in another project, install it via npm:

```bash
npm install json-database-st lodash
```

### Running Tests

The project uses Jest for testing. To run the test suite, execute the following command:

```bash
npm test
```

This command will run the tests defined in the `__tests__/JSONDatabase.test.js` file.

## Development Conventions

### Coding Style

*   The codebase is written in modern JavaScript (ES6+), utilizing `async/await` for asynchronous operations.
*   The code is well-documented with JSDoc comments.
*   Custom error classes are used for robust error handling.
*   The code is organized into a single `JSONDatabase.js` file, which contains the main `JSONDatabase` class.

### Testing

*   Tests are located in the `__tests__` directory.
*   The project uses Jest as its testing framework.
*   The test script is defined in `package.json` under the `scripts` section.

### Contribution

The `README.md` file indicates that contributions, issues, and feature requests are welcome. It is recommended to open an issue to discuss any significant changes before submitting a pull request.
