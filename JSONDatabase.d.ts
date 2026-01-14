import { EventEmitter } from 'events';

export interface IndexConfig {
  name: string;
  path: string;
  field: string;
  unique?: boolean;
}

export interface DatabaseOptions {
  encryptionKey?: string;
  saveDelay?: number;
  prettyPrint?: boolean;
  silent?: boolean;
  wal?: boolean;
  schema?: any;
  indices?: IndexConfig[];
}

export interface MiddlewareContext {
  path: string;
  value?: any;
  finalData?: any;
  [key: string]: any;
}

export type MiddlewareFn = (ctx: MiddlewareContext) => MiddlewareContext;

export class DBError extends Error {}
export class TransactionError extends DBError {}
export class ValidationError extends DBError {
  issues?: any[];
  constructor(msg: string, issues?: any[]);
}

export class QueryCursor implements PromiseLike<any[]> {
  limit(n: number): this;
  skip(n: number): this;
  sort(criteria: any): this;
  select(fields: string[]): this;
  exec(): Promise<any[]>;
  then<TResult1 = any[], TResult2 = never>(
    onfulfilled?: ((value: any[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2>;
}

export default class JSONDatabase extends EventEmitter {
  static DBError: typeof DBError;
  static TransactionError: typeof TransactionError;
  static ValidationError: typeof ValidationError;
  static QueryCursor: typeof QueryCursor;

  constructor(filename: string, options?: DatabaseOptions);
  
  get<T = any>(path?: string, defaultValue?: T): Promise<T>;
  has(path: string): Promise<boolean>;
  set(path: string, value: any): Promise<boolean>;
  delete(path: string): Promise<boolean>;
  
  push(path: string, ...items: any[]): Promise<boolean | void>;
  pull(path: string, ...items: any[]): Promise<boolean | void>;
  
  add(path: string, amount: number): Promise<boolean>;
  subtract(path: string, amount: number): Promise<boolean>;
  
  find<T = any>(path: string, predicate: ((item: T) => boolean) | object): Promise<T | undefined>;
  findByIndex<T = any>(indexName: string, value: any): Promise<T | undefined>;
  
  query(path: string, query?: any): QueryCursor;
  
  transaction<T = any>(fn: (data: any) => T | Promise<T>): Promise<boolean>;
  batch(ops: Array<{ type: 'set' | 'delete' | 'push'; path: string; value?: any; values?: any[] }>): Promise<boolean>;
  
  clear(): Promise<boolean>;
  
  paginate<T = any>(path: string, page?: number, limit?: number): Promise<{
    data: T[];
    meta: { total: number; page: number; limit: number; totalPages: number; hasNext: boolean };
  }>;
  
  createSnapshot(label?: string): Promise<string>;
  close(): Promise<void>;

  before(op: 'set' | 'delete' | 'push' | 'pull', pattern: string, cb: MiddlewareFn): void;
  after(op: 'set' | 'delete' | 'push' | 'pull', pattern: string, cb: MiddlewareFn): void;
}
