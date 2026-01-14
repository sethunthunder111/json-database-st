import { EventEmitter } from 'events';

export interface DatabaseOptions {
  encryptionKey?: string;
  saveDelay?: number;
  prettyPrint?: boolean;
  schema?: any;
}

export interface MiddlewareContext {
  path: string;
  value?: any;
  finalData?: any;
  data?: any;
}

export type MiddlewareFn = (ctx: MiddlewareContext) => MiddlewareContext;

export class DBError extends Error {}
export class TransactionError extends DBError {}
export class ValidationError extends DBError {
  issues: any[];
  constructor(msg: string, issues: any[]);
}

export default class JSONDatabase extends EventEmitter {
  constructor(filename: string, options?: DatabaseOptions);
  
  get(path?: string, defaultValue?: any): any;
  has(path: string): boolean;
  set(path: string, value: any): Promise<void>;
  delete(path: string): Promise<boolean>;
  
  push(path: string, ...items: any[]): Promise<void>;
  pull(path: string, ...items: any[]): Promise<void>;
  
  add(path: string, amount: number): Promise<void>;
  subtract(path: string, amount: number): Promise<void>;
  
  find(path: string, query: any): QueryCursor;
  findOne(path: string, query: any): any;
  
  transaction<T = any>(fn: (data: any) => T | Promise<T>): Promise<T>;
  batch(ops: Array<{ type: 'set' | 'delete'; path: string; value?: any }>): Promise<void>;
  
  clear(): Promise<void>;
  
  before(op: string, pattern: string, cb: MiddlewareFn): void;
  after(op: string, pattern: string, cb: MiddlewareFn): void;
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