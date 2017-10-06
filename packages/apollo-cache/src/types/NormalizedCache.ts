import { StoreValue } from 'apollo-utilities';

/**
 * This is an interface used to access, set and remove
 * StoreObjects from the cache
 */
export interface NormalizedCache {
  readonly [Symbol.toStringTag]: 'NormalizedCache';

  get(dataId: string): StoreObject;
  set(dataId: string, value: StoreObject): this;
  delete(dataId: string): boolean;
  forEach(
    callback: (value: StoreObject, dataId: string, self: this) => void,
  ): void;
  clear(): void;

  // non-Map elements:
  /**
   * returns an Object with key-value pairs matching the contents of the store
   */
  toObject(): NormalizedCacheObject;
  /**
   * returns a NormalizedCache which passes-through overlay values if they exist,
   * otherwise refers to the underlying store
   */
  overlay(...patches: Array<NormalizedCache>): NormalizedCache;
}

/**
 * This is the default implementation of the normalized representation
 * of the Apollo query result cache. It consists of
 * a flattened representation of query result trees.
 */
export interface NormalizedCacheObject {
  [dataId: string]: StoreObject;
}

export interface StoreObject {
  __typename?: string;
  [storeFieldKey: string]: StoreValue;
}
