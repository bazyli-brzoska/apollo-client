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

  private recordedData?: NormalizedCacheObject | undefined;

  constructor(private data: NormalizedCacheObject = {}) {}

  public toObject(): NormalizedCacheObject {
    return {
      ...this.data,
      ...this.recordedData,
    };
  }

  public overlay(...patches: Array<NormalizedCacheObject>): ObjectBasedCache {
    return new ObjectBasedCache(Object.assign(this.toObject(), ...patches));
  }

  public get(dataId: string): StoreObject {
    if (this.recordedData && this.recordedData.hasOwnProperty(dataId)) {
      // recording always takes precedence:
      return this.recordedData[dataId];
    }
    return this.data[dataId];
  }

  public set(dataId: string, value: StoreObject) {
    if (this.recordedData) {
      this.recordedData[dataId] = value;
    } else {
      this.data[dataId] = value;
    }
  }

  public delete(dataId: string): void {
    this.set(dataId, undefined);
  }

  public clear(): void {
    if (this.recordedData) {
      throw new Error(
        'Clearing the cache while recording a transaction is not possible',
      );
    } else {
      this.data = {};
    }
  }

  public replace(newData: NormalizedCacheObject): void {
    if (this.recordedData) {
      this.recordedData = newData;
    } else {
      this.data = newData;
    }
  }

  public record(
    transaction: () => void,
    data: NormalizedCacheObject = {
      ...this.data,
      ...this.recordedData,
    },
  ): NormalizedCacheObject {
    const { data: parentData, recordedData: parentRecordedData } = this;

    this.data = data;

    // setup the recording:
    const recordedData = (this.recordedData = {});
    transaction();
    // restore the data state:
    this.data = parentData;
    // restore the parent recording:
    this.recordedData = parentRecordedData;
    return recordedData;
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

  get optimisticPatches(): NormalizedCacheObject[] {
    return this.optimistic.map(opt => opt.data);
  }

  constructor(config: ApolloReducerConfig = {}) {
    super();
    this.config = { ...defaultConfig, ...config };
    this.addTypename = this.config.addTypename ? true : false;
    this.data = this.config.storeFactory();
  }

  public restore(data: NormalizedCacheObject): this {
    if (data) {
      this.data.replace(data);
    }
    return this;
  }

  public extract(optimistic: boolean, serializable: false): NormalizedCache;
  public extract(
    optimistic?: boolean,
    serializable?: true,
  ): NormalizedCacheObject;
  public extract(
    optimistic: boolean = false,
    serializable: boolean = true,
  ): NormalizedCacheObject | NormalizedCache {
    const data =
      optimistic && this.optimistic.length > 0
        ? this.data.overlay(...this.optimisticPatches)
        : this.data;

    return serializable ? data.toObject() : data;
  }

  public read<T>(query: Cache.ReadOptions): Cache.DiffResult<T> {
    if (query.rootId && this.data.get(query.rootId) === undefined) {
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
    const patch = this.data.record(() => transaction(this), this.extract(true));

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
