// File: JSONDatabase.d.ts
import { EventEmitter } from 'events';

export interface DBOptions {
    encryptionKey?: string;
    prettyPrint?: boolean;
    writeOnChange?: boolean;
    schema?: any; // Zod or Joi schema
    indices?: IndexDefinition[];
}

export interface IndexDefinition {
    name: string;
    path: string;
    field: string;
    unique?: boolean;
}

export interface BatchOp {
    type: 'set' | 'delete' | 'push' | 'pull';
    path: string;
    value?: any; // For set
    values?: any[]; // For push/pull
}

export default class JSONDatabase extends EventEmitter {
    constructor(filename: string, options?: DBOptions);

    get<T = any>(path?: string, defaultValue?: T): Promise<T>;
    has(path: string): Promise<boolean>;
    set(path: string, value: any): Promise<any>;
    delete(path: string): Promise<boolean>;
    
    push(path: string, ...items: any[]): Promise<void>;
    pull(path: string, ...items: any[]): Promise<void>;
    
    /** Laybon 1.5: Atomic Math */
    add(path: string, amount: number): Promise<any>;
    subtract(path: string, amount: number): Promise<any>;

    transaction<T>(fn: (data: any) => T): Promise<T>;
    batch(ops: BatchOp[], options?: { stopOnError: boolean }): Promise<any>;

    find<T>(path: string, predicate: object | ((item: T) => boolean)): Promise<T | undefined>;
    findByIndex<T>(indexName: string, value: any): Promise<T | undefined>;
    
    /** Laybon 1.5: Pagination */
    paginate<T>(path: string, page?: number, limit?: number, filterFn?: (i: T) => boolean): Promise<{
        data: T[];
        meta: { total: number; page: number; limit: number; totalPages: number; hasNext: boolean };
    }>;

    /** Laybon 1.5: Snapshot */
    createSnapshot(label?: string): Promise<string>;

    clear(): Promise<object>;
    close(): Promise<void>;

    // Middleware
    before(op: string, path: string, cb: (ctx: any) => any): void;
    after(op: string, path: string, cb: (ctx: any) => any): void;
}