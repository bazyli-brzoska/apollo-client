import { DocumentNode } from 'graphql';

import {
  Cache,
  DataProxy,
  ApolloCache,
  Transaction,
  NormalizedCacheObject,
  StoreObject,
} from 'apollo-cache';

import {
  getFragmentQueryDocument,
  addTypenameToDocument,
} from 'apollo-utilities';

import { HeuristicFragmentMatcher } from './fragmentMatcher';
import {
  OptimisticStoreItem,
  ApolloReducerConfig,
  NormalizedCache,
  NormalizedCacheFactory,
} from './types';
import { writeResultToStore } from './writeToStore';
import { readQueryFromStore, diffQueryAgainstStore } from './readFromStore';

const defaultConfig: ApolloReducerConfig = {
  fragmentMatcher: new HeuristicFragmentMatcher().match,
  dataIdFromObject: defaultDataIdFromObject,
  addTypename: true,
  storeFactory: defaultNormalizedCacheFactory,
};

export function defaultDataIdFromObject(result: any): string | null {
  if (result.__typename) {
    if (result.id !== undefined) {
      return `${result.__typename}:${result.id}`;
    }
    if (result._id !== undefined) {
      return `${result.__typename}:${result._id}`;
    }
  }
  return null;
}

export class ObjectBasedCache implements NormalizedCache {
  get [Symbol.toStringTag](): 'NormalizedCache' {
    return 'NormalizedCache';
  }

  private _patches: Array<NormalizedCache> | undefined;

  constructor(
    private _data: NormalizedCacheObject = {},
    patches?: Array<NormalizedCache> | undefined,
  ) {
    if (patches) {
      this._patches = patches.length > 0 ? patches : undefined;
    }
  }

  public toObject(): NormalizedCacheObject {
    return this._patches && this._patches.length > 0
      ? Object.assign(
          {},
          this._data,
          ...this._patches.map(patchCache => patchCache.toObject()),
        )
      : this._data;
  }

  public overlay(...patches: Array<NormalizedCache>): ObjectBasedCache {
    return new ObjectBasedCache(this._data, patches);
  }

  public get(dataId: string): StoreObject {
    return this._patches ? this.toObject()[dataId] : this._data[dataId];
  }

  public set(dataId: string, value: StoreObject): this {
    // NOTE: any overlay cache will still take precendence over this
    this._data[dataId] = value;
    return this;
  }

  public delete(dataId: string): boolean {
    const keyExisted = this._data.hasOwnProperty(dataId);
    // NOTE: any overlay cache will still take precendence over this
    delete this._data[dataId];
    // keyExisted is here only for Map compatibility
    return keyExisted;
  }

  public clear(): void {
    this._data = {};
    this._patches = undefined;
  }

  public forEach(
    callback: (value: StoreObject, dataId: string, self: this) => void,
  ) {
    const data = this.toObject();
    Object.keys(data).forEach(dataId => callback(data[dataId], dataId, this));
  }
}

export function defaultNormalizedCacheFactory(
  seed?: NormalizedCacheObject,
): NormalizedCache {
  return new ObjectBasedCache(seed);
}

export function isNormalizedCacheImplementation(
  store: NormalizedCache | NormalizedCacheObject,
): store is NormalizedCache {
  return (store as NormalizedCache)[Symbol.toStringTag] === 'NormalizedCache';
}

export function ensureNormalizedCache({
  store,
  storeFactory = defaultNormalizedCacheFactory,
}: {
  store: NormalizedCache | NormalizedCacheObject;
  storeFactory: NormalizedCacheFactory;
}): NormalizedCache {
  return isNormalizedCacheImplementation(store) ? store : storeFactory(store);
}

export class InMemoryCache extends ApolloCache<NormalizedCacheObject> {
  private data: NormalizedCache;
  private config: ApolloReducerConfig;
  private optimistic: OptimisticStoreItem[] = [];
  private watches: Cache.WatchOptions[] = [];
  private addTypename: boolean;

  constructor(config: ApolloReducerConfig = {}) {
    super();
    this.config = { ...defaultConfig, ...config };
    this.addTypename = this.config.addTypename ? true : false;
    this.data = this.config.storeFactory();
  }

  public restore(data: NormalizedCache | NormalizedCacheObject): this {
    if (data) {
      this.data = ensureNormalizedCache({
        store: data,
        storeFactory: this.config.storeFactory,
      });
    }
    return this;
  }

  public extract(optimistic: boolean, serializable: false): NormalizedCache;
  public extract(
    optimistic: boolean,
    serializable?: true,
  ): NormalizedCacheObject;
  public extract(
    optimistic: boolean = false,
    serializable: boolean = true,
  ): NormalizedCacheObject | NormalizedCache {
    let data = this.data;
    if (optimistic && this.optimistic.length > 0) {
      const patches = this.optimistic.map(opt => opt.data);
      data = this.data.overlay(...patches);
    }

    return serializable ? data.toObject() : data;
  }

  public read<T>(query: Cache.ReadOptions): Cache.DiffResult<T> {
    if (query.rootId && typeof this.data.get(query.rootId) === 'undefined') {
      return null;
    }

    return readQueryFromStore({
      store: this.extract(query.optimistic, false),
      query: this.transformDocument(query.query),
      variables: query.variables,
      rootId: query.rootId,
      fragmentMatcherFunction: this.config.fragmentMatcher,
      previousResult: query.previousResult,
      config: this.config,
    });
  }

  public write(write: Cache.WriteOptions): void {
    writeResultToStore({
      dataId: write.dataId,
      result: write.result,
      variables: write.variables,
      document: this.transformDocument(write.query),
      store: this.data,
      dataIdFromObject: this.config.dataIdFromObject,
      fragmentMatcherFunction: this.config.fragmentMatcher,
    });

    this.broadcastWatches();
  }

  public diff<T>(query: Cache.DiffOptions): Cache.DiffResult<T> {
    return diffQueryAgainstStore({
      store: this.extract(query.optimistic, false),
      query: this.transformDocument(query.query),
      variables: query.variables,
      returnPartialData: query.returnPartialData,
      previousResult: query.previousResult,
      fragmentMatcherFunction: this.config.fragmentMatcher,
      config: this.config,
    });
  }

  public watch(watch: Cache.WatchOptions): () => void {
    this.watches.push(watch);

    return () => {
      this.watches = this.watches.filter(c => c !== watch);
    };
  }

  public evict(query: Cache.EvictOptions): Cache.EvictionResult {
    throw new Error(`eviction is not implemented on InMemory Cache`);
  }

  public reset(): Promise<void> {
    this.data.clear();
    this.broadcastWatches();

    return Promise.resolve();
  }

  public removeOptimistic(id: string) {
    // Throw away optimistic changes of that particular mutation
    const toPerform = this.optimistic.filter(item => item.id !== id);

    this.optimistic = [];

    // Re-run all of our optimistic data actions on top of one another.
    toPerform.forEach(change => {
      this.recordOptimisticTransaction(change.transaction, change.id);
    });

    this.broadcastWatches();
  }

  public performTransaction(transaction: Transaction<NormalizedCacheObject>) {
    // TODO: does this need to be different, or is this okay for an in-memory cache?
    transaction(this);
  }

  public recordOptimisticTransaction(
    transaction: Transaction<NormalizedCacheObject>,
    id: string,
  ) {
    const before = this.extract(true, false);

    const orig = this.data;
    this.data = before;
    transaction(this);
    const after = this.data;
    this.data = orig;

    const patch = this.config.storeFactory();

    after.forEach((afterKey, key) => {
      if (afterKey !== before.get(key)) {
        patch.set(key, afterKey);
      }
    });

    this.optimistic.push({
      id,
      transaction,
      data: patch,
    });

    this.broadcastWatches();
  }

  public transformDocument(document: DocumentNode): DocumentNode {
    if (this.addTypename) return addTypenameToDocument(document);
    return document;
  }

  public readQuery<QueryType>(
    options: DataProxy.Query,
    optimistic: boolean = false,
  ): Cache.DiffResult<QueryType> {
    return this.read({
      query: options.query,
      variables: options.variables,
      optimistic,
    });
  }

  public readFragment<FragmentType>(
    options: DataProxy.Fragment,
    optimistic: boolean = false,
  ): Cache.DiffResult<FragmentType> | null {
    return this.read({
      query: this.transformDocument(
        getFragmentQueryDocument(options.fragment, options.fragmentName),
      ),
      variables: options.variables,
      rootId: options.id,
      optimistic,
    });
  }

  public writeQuery(options: DataProxy.WriteQueryOptions): void {
    this.write({
      dataId: 'ROOT_QUERY',
      result: options.data,
      query: this.transformDocument(options.query),
      variables: options.variables,
    });
  }

  public writeFragment(options: DataProxy.WriteFragmentOptions): void {
    this.write({
      dataId: options.id,
      result: options.data,
      query: this.transformDocument(
        getFragmentQueryDocument(options.fragment, options.fragmentName),
      ),
      variables: options.variables,
    });
  }

  private broadcastWatches() {
    // right now, we invalidate all queries whenever anything changes
    this.watches.forEach(c => {
      const newData = this.diff({
        query: c.query,
        variables: c.variables,
        previousResult: c.previousResult(),
        optimistic: c.optimistic,
      });

      c.callback(newData);
    });
  }
}
