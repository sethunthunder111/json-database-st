# Performance Benchmarks

This document provides a detailed analysis of the performance characteristics of `json-database-st` under various loads. The tests were conducted to measure initial write speed, indexed read speed, and the time taken to update a single record within a large dataset.

## System Specifications

The following hardware was used for these benchmarks. Performance may vary on different systems.

- **CPU:** Intel(R) Core(TM) i5-8350U CPU @ 1.70GHz
- **RAM:** 8GB DDR4 @ 2400Mhz
- **Storage:** Intel Pro 7600p 256 GB NVMe SSD

## Methodology

The benchmarks were executed using a standalone Node.js script (`run-all-benchmarks.js`) to ensure the results were not influenced by test runner overhead. The script performed the following steps for each dataset size (50k, 100k, and 1M records):

1. **Cleanup:** It started by deleting any previous benchmark data to ensure a fresh run.
2. **Data Generation:** A new dataset of user objects (`{ id, name, email }`) was generated programmatically using `@faker-js/faker`.
3. **Database Instantiation:** A `JSONDatabase` instance was created with `multiProcess: false` for optimal single-process performance. An index was configured on the `email` field to test indexed lookups.
4. **Initial Write Test:** The script used `process.hrtime.bigint()` to measure the precise time it took to write the entire collection of new records to a new database file with `db.set()`.
5. **Indexed Read Test:** It measured the time taken to retrieve a single user object from near the end of the dataset using `db.findByIndex()`.
6. **Single Update Test:** Finally, it measured the time taken to modify the `name` field of that same user record, which involves rewriting the entire database file.
7. **Save Results:** The timing and file size results for each run were saved to a JSON file, which was then used to build this report.

## Benchmark Results

| Records   | File Size | Initial Write (ms) | Indexed Read (ms) | Single Update (ms) |
| --------- | --------- | ------------------ | ----------------- | ------------------ |
| 50,000    | 3.96 MB   | 216.12 ms          | 0.97 ms           | 819.75 ms          |
| 100,000   | 7.94 MB   | 400.87 ms          | 0.25 ms           | 950.20 ms          |
| 1,000,000 | 82.28 MB  | 3,271.48 ms        | 0.07 ms           | 9,421.12 ms        |

## Analysis

### Initial Write Performance

The time taken for the initial bulk write scales linearly and efficiently with the number of records. Writing 100,000 records (~8 MB) took well under half a second, while a massive one million records (~82 MB) took just over 3 seconds. This demonstrates that the library is highly capable of ingesting large initial datasets.

### Indexed Read Performance

**This is the library's greatest strength.** The time to read a record using `findByIndex()` is nearly instantaneous and does not increase with the size of the dataset. At one million records, the lookup time was so fast (`0.07ms`) that it was near the limit of the measurement's precision. This `O(1)` complexity means that no matter how large your collection grows, indexed lookups will remain incredibly fast.

### Single Update Performance

This benchmark highlights the fundamental trade-off of a single-file database. Because the entire file must be rewritten to ensure data integrity (atomicity), the update time scales linearly with the file size.

- At 50,000 records, the update took `~820ms`.
- At 1,000,000 records, this increased to `~9.4 seconds`.

This behavior is expected and correct. It ensures that the database file is never left in a corrupted state.

## Conclusion

`json-database-st` is highly optimized for **read-heavy applications**. Its indexing feature provides exceptionally fast data retrieval regardless of dataset size. While individual record updates on very large datasets can be slow, this is a deliberate design choice to guarantee data safety.

The library is production-ready for its intended use case: small to medium-sized applications that require a simple, secure, and reliable database with excellent read performance.
