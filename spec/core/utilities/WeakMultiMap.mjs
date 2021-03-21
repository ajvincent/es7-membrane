import WeakMultiMap from "../../../source/core/utilities/WeakMultiMap.mjs";

class SubWeakSet extends WeakSet {}
class SubSet extends Set {}
class SubSubWeak extends SubWeakSet {}
class SubSubSet  extends SubSet {}

class SetWithArgs extends WeakSet {
  constructor(...args) {
    super();
    this.args = args;
  }
}

function constructorTests(ctorName = null, ctor = null, ...args) {
  let map;

  describe(`(${ctorName})`, () => {
    if (ctor) {
      beforeEach(() => {
        map = new WeakMultiMap(ctor, ...args);
      });
      afterEach(() => {
        map = null;
      });
    }
    else {
      beforeEach(() => {
        map = new WeakMultiMap();
      });
      afterEach(() => {
        map = null;
      });

      ctor = Set;
    }

    it("is an instance of WeakMap", () => {
      expect(map).toBeInstanceOf(WeakMap);
    });

    it("can hold a single value", () => {
      const key = {}, value = {};
      expect(map.set(key, value)).toBe(map);

      const container = map.get(key);
      expect(container).toBeInstanceOf(ctor);
      if (container instanceof Set)
        expect(container.size).toBe(1);
      expect(container.has(value)).toBe(true);
    });

    it("can hold multiple values", () => {
      const key = {}, values = [{}, {}, {}];
      values.forEach(value => expect(map.set(key, value)).toBe(map));

      const container = map.get(key);
      expect(container).toBeInstanceOf(ctor);
      if (container instanceof Set)
        expect(container.size).toBe(3);
      values.forEach(value => expect(container.has(value)).toBe(true));
    });

    it("can hold multiple keys", () => {
      const keys = [{}, {}], value = {};
      keys.forEach(key => expect(map.set(key, value)).toBe(map));
  
      keys.forEach(key => {
        const container = map.get(key);
        expect(container).toBeInstanceOf(ctor);
        if (container instanceof Set)
          expect(container.size).toBe(1);
        expect(container.has(value)).toBe(true);
      });
  
      expect(map.get(keys[0])).not.toBe(map.get(keys[1]));
    });

    if (ctor === SetWithArgs) {
      it("passes the arguments for the set constructor in", () => {
        const key = {}, value = {};
        map.set(key, value);

        const container = map.get(key);
        expect(container.args).toEqual(args);
      });
    }
  });
}

describe("WeakMultiMap", () => {
  constructorTests("");
  constructorTests("Set", Set);
  constructorTests("WeakSet", WeakSet);
  constructorTests("SubSet", SubSet);
  constructorTests("SubWeakSet", SubWeakSet);
  constructorTests("SubSubWeak", SubSubWeak);
  constructorTests("SubSubSet", SubSubSet);

  const arg0 = {}, arg1 = {};
  constructorTests("SetWithArgs", SetWithArgs, arg0, arg1);

  it("throws for a non-Set, non-WeakSet constructor", () => {
    expect(() => {
      new WeakMultiMap(Map)
    }).toThrowError("WeakMultiMap requires a WeakSet or Set for the set constructor!");
  });
});