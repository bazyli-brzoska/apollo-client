import { ObjectBasedCache } from '../inMemoryCache';
import { NormalizedCacheObject } from '../types';

describe('ObjectBasedCache', () => {
  it('should create an empty cache', () => {
    const cache = new ObjectBasedCache();
    expect(cache.toObject()).toEqual({});
  });

  it('should create a cache based on an Object', () => {
    const contents: NormalizedCacheObject = { a: {} };
    const cache = new ObjectBasedCache(contents);
    expect(cache.toObject()).toBe(contents);
  });

  it(`should .get() an object from the store by dataId`, () => {
    const contents: NormalizedCacheObject = { a: {} };
    const cache = new ObjectBasedCache(contents);
    expect(cache.get('a')).toBe(contents.a);
  });

  it(`should .set() an object from the store by dataId`, () => {
    const obj = {};
    const cache = new ObjectBasedCache();
    cache.set('a', obj);
    expect(cache.get('a')).toBe(obj);
  });

  it(`should .clear() the store`, () => {
    const obj = {};
    const cache = new ObjectBasedCache();
    cache.set('a', obj);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
  });

  describe('store overlay', () => {
    it('should overlay the cache with another object', () => {
      const data = {
        Human: { __typename: 'Human', name: 'Mark' },
        Animal: { __typename: 'Mouse', name: '🐭' },
      };
      const cache = new ObjectBasedCache(data);
      const overlayData = { Human: { __typename: 'Human', name: 'John' } };
      const overlay = cache.overlay(overlayData);
      // original remains the same:
      expect(cache.get('Human')).toBe(data.Human);
      // overlay is overlayed:
      expect(overlay.get('Human')).toBe(overlayData.Human);
      expect(overlay.get('Animal')).toBe(data.Animal);
    });

    it('should overlay the cache with multiple objects', () => {
      const data = {
        Human: { __typename: 'Human', name: 'Mark' },
        Animal: { __typename: 'Mouse', name: '🐭' },
      };
      const cache = new ObjectBasedCache(data);
      const overlayData1 = {
        Human: { __typename: 'Human', name: 'John' },
      };
      const overlayData2 = {
        Human: { __typename: 'Human', name: 'Amelia' },
        Animal: { __typename: 'Chick', name: '🐣' },
      };
      const overlay = cache.overlay(overlayData1, overlayData2);
      expect(overlay.get('Human')).toBe(overlayData2.Human);
      expect(overlay.get('Animal')).toBe(overlayData2.Animal);
    });

    it('should not affect the original cache when setting on an overlayed one', () => {
      const data = {
        Human: { __typename: 'Human', name: 'Mark' },
        Animal: { __typename: 'Mouse', name: '🐭' },
      };
      const cache = new ObjectBasedCache(data);
      const overlayData = { Human: { __typename: 'Human', name: 'John' } };
      const overlay = cache.overlay(overlayData);
      const otherData = { Human: { __typename: 'Human', name: 'Amelia' } };
      overlay.set('Human', otherData.Human);
      // original remains the same:
      expect(cache.get('Human')).toBe(data.Human);
      // overlay is changed:
      expect(overlay.get('Human')).toBe(otherData.Human);
    });

    it('should record changes during a transaction', () => {
      const data = {
        Human: { __typename: 'Human', name: 'Mark' },
        Animal: { __typename: 'Mouse', name: '🐭' },
      };
      const cache = new ObjectBasedCache({ ...data });
      const dataToRecord = { Human: { __typename: 'Human', name: 'John' } };
      const recording = cache.record(() => {
        expect(cache.get('Human')).toBeUndefined();
        cache.set('Human', dataToRecord.Human);
        expect(cache.get('Human')).toBe(dataToRecord.Human);
        expect(cache.get('Animal')).toBeUndefined();
        cache.delete('Animal');
      });
      expect(recording).toEqual({
        Human: dataToRecord.Human,
      });
      // original data remains unaffected:
      expect(cache.toObject()).toEqual(data);
    });

    it('should record changes during a nested transaction', () => {
      const data = {
        Human: { __typename: 'Human', name: 'Mark' },
        Animal: { __typename: 'Mouse', name: '🐭' },
      };
      const cache = new ObjectBasedCache({ ...data });
      const dataToRecord = { Human: { __typename: 'Human', name: 'John' } };
      const nestedDataToRecord = {
        Human: { __typename: 'Human', name: 'Amelia' },
        Animal: { __typename: 'Chick', name: '🐣' },
      };
      const recording = cache.record(() => {
        expect(cache.get('Human')).toBeUndefined();
        cache.set('Human', dataToRecord.Human);
        expect(cache.get('Human')).toBe(dataToRecord.Human);

        const nestedRecording = cache.record(() => {
          expect(cache.get('Human')).toBeUndefined();
          cache.set('Human', nestedDataToRecord.Human);
          expect(cache.get('Human')).toBe(nestedDataToRecord.Human);
          cache.set('Animal', nestedDataToRecord.Animal);
          expect(cache.get('Animal')).toBe(nestedDataToRecord.Animal);
        });

        // nested recording shouldn't propagate state to the parent recording:
        expect(cache.get('Human')).toBe(dataToRecord.Human);
        expect(cache.get('Animal')).toBeUndefined();
      });

      expect(recording).toEqual({
        Human: dataToRecord.Human,
      });
      // original data remains unaffected:
      expect(cache.toObject()).toEqual(data);
    });

    it('should not allow clearing when recording changes', () => {
      const cache = new ObjectBasedCache();
      const recording = cache.record(() => {
        expect(() => cache.clear()).toThrowError(
          'Clearing the cache while recording a transaction is not possible',
        );
      });
    });
  });
});
