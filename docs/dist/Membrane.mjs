/** @module source/core/sharedUtilities */

const ShadowKeyMap = new WeakMap();

const DeadProxyKey = Symbol("dead map entry");

function assert(condition, message) {
  if (!condition)
    throw new Error("Assertion failure: " + message);
}

/**
 * Define a shadow target, so we can manipulate the proxy independently of the
 * original target.
 *
 * @argument value {Object} The original target.
 *
 * @returns {Object} A shadow target to minimally emulate the real one.
 */
function makeShadowTarget(value) {
  var rv;
  if (Array.isArray(value))
    rv = [];
  else if (typeof value === "object")
    rv = {};
  else if (typeof value === "function")
    rv = function() {};
  else
    throw new Error("Unknown value for makeShadowTarget");
  ShadowKeyMap.set(rv, value);
  return rv;
}

/**
 * Get the real target for a given shadow object.
 * @param target
 */
function getRealTarget(target) {
  return ShadowKeyMap.has(target) ? ShadowKeyMap.get(target) : target;
}

function returnFalse() {
  return false;
}

class DataDescriptor {
  /**
   * A data descriptor.
   *
   * @param {any} value
   * @param {Boolean} [writable]
   * @param {Boolean} [enumerable]
   * @param {Boolean} [configurable]
   */
  constructor(value, writable = false, enumerable = true, configurable = true) {
    this.value = value;
    this.writable = writable;
    this.enumerable = enumerable;
    this.configurable = configurable;
  }
}

class AccessorDescriptor {
  /**
   *
   * @param {Function} getter
   * @param {Function} [setter]
   * @param {Boolean}  [enumerable]
   * @param {Boolean}  [configurable]
   */
  constructor(getter, setter, enumerable = true, configurable = true) {
    this.get = getter;
    this.set = setter;
    this.enumerable = enumerable;
    this.configurable = configurable;
  }
}

class NWNCDataDescriptor {
  /**
   * A non-writable, non-configurable data descriptor.
   *
   * @param {any} value
   * @param {Boolean} [writable]
   */
  constructor(value, enumerable = true) {
    this.value = value;
    this.enumerable = enumerable;
  }
}
NWNCDataDescriptor.prototype.writable = false;
NWNCDataDescriptor.prototype.configurable = false;
Object.freeze(NWNCDataDescriptor.prototype);

/**
 * Determine if a value is legally a data descriptor.
 * @param {Object} desc
 *
 * @returns {Boolean} true if it is a data descriptor.
 */
function isDataDescriptor(desc) {
  if (typeof desc === "undefined")
    return false;
  if (!("value" in desc) && !("writable" in desc))
    return false;
  return true;
}

/**
 * Determine if a value is legally an accessor descriptor.
 * @param {Object} desc
 *
 * @returns {Boolean} true if it is an accessor descriptor.
 */
function isAccessorDescriptor(desc) {
  if (typeof desc === "undefined") {
    return false;
  }
  if (!("get" in desc) && !("set" in desc))
    return false;
  return true;
}

const allTraps = Object.freeze([
  "getPrototypeOf",
  "setPrototypeOf",
  "isExtensible",
  "preventExtensions",
  "getOwnPropertyDescriptor",
  "defineProperty",
  "has",
  "get",
  "set",
  "deleteProperty",
  "ownKeys",
  "apply",
  "construct"
]);

/* XXX ajvincent This is supposed to be a complete list of top-level globals.
   Copied from https://github.com/tc39/proposal-realms/blob/master/shim/src/stdlib.js
   on September 20, 2017.
*/
const Primordials = Object.freeze((function() {
const p = [
  Array,
  ArrayBuffer,
  Boolean,
  DataView,
  Date,
  decodeURI,
  decodeURIComponent,
  encodeURI,
  encodeURIComponent,
  Error,
  eval,
  EvalError,
  Float32Array,
  Float64Array,
  Function,
  Int8Array,
  Int16Array,
  Int32Array,
  isFinite,
  isNaN,
  JSON,
  Map,
  Math,
  Number,
  Object,
  parseFloat,
  parseInt,
  Promise,
  Proxy,
  RangeError,
  ReferenceError,
  Reflect,
  RegExp,
  Set,
  String,
  Symbol,
  SyntaxError,
  TypeError,
  Uint8Array,
  Uint8ClampedArray,
  Uint16Array,
  Uint32Array,
  URIError,
  WeakMap,
  WeakSet,
];

return p.concat(p.filter((i) => {
    if (!i.name)
      return false;
    let j = i.name[0];
    return j.toUpperCase() === j;
  }).map((k) => k.prototype));
})());

/**
 *
 * @param value
 *
 * @return "primitive" | "function" | "object"
 */
function valueType(value) {
  if (value === null)
    return "primitive";
  const type = typeof value;
  if ((type !== "function") && (type !== "object"))
    return "primitive";
  return type;
}

function makeRevokeDeleteRefs(parts, mapping, field) {
  let oldRevoke = parts.revoke;
  if (!oldRevoke)
    return;

  // necessary: in OverriddenProxyParts, revoke is inherited and read-only.
  Reflect.defineProperty(parts, "revoke", new DataDescriptor(function() {
    oldRevoke.apply(parts);
    mapping.remove(field);
  }, true));
}

const NOT_YET_DETERMINED = {};
Object.defineProperty(
  NOT_YET_DETERMINED,
  "not_yet_determined",
  new NWNCDataDescriptor(true)
);

/** @module source/core/ProxyCylinder */

/**
 * @callback OwnKeysFilter
 * @param {Symbol | String}     key   The current key.
 * @param {Number}              index The index of the current key.
 * @param {{Symbol | String}[]} array The ordered set of keys to make available.
 *
 * @returns {Boolean}
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/filter
 */

/**
 * @typedef GraphMetadata
 * @property {Object} value                - The original value
 * @property {Proxy} proxy                 - The proxy object from Proxy.revocable()
 * @property {Function} revoke             - The revoke() function from Proxy.revocable()
 * @property {Object} shadowTarget         - The shadow target
 * @property {Boolean} override            - True if the graph should be overridden.
 * @property {Map} localDescriptors        - Property descriptors local to an object graph.
 * @property {Set} deletedLocals           - Names of properties deleted locally.
 * @property {Object} cachedOwnKeys        - A bag of "own keys" that is cached for performance.
 * @property {OwnKeysFilter} ownKeysFilter - A callback to filter the list of "own keys" for an object graph.
 * @property {Number} truncateArgList      - A limit on the number of arguments.
 */

/**
 * @package
 */
class ProxyCylinder {
  /**
   * @param {String | Symbol} originGraph The name of the original graph.
   */
  constructor(originGraph) {
    /**
     * @type {String | Symbol}
     * @public
     * @readonly
     */
    Reflect.defineProperty(this, "originGraph", new NWNCDataDescriptor(originGraph));

    /**
     * @type {Map<String | Symbol, GraphMetadata>}
     * @private
     * @readonly
     */
    Reflect.defineProperty(this, "proxyDataByGraph", new NWNCDataDescriptor(new Map()));

    /**
     * @type {Boolean}
     * @private
     */
    this.originalValueSet = false;
  
    /**
     * Local flags for string keys determining behavior.
     * @type {?Set}
     * @private
     */
    this.localFlags = null;

    /**
     * Local flags for symbol keys.
     * @type {?Map}
     * @private
     */
    this.localFlagsSymbols = null;

    Reflect.preventExtensions(this);
  }

  /**
   * @private
   *
   * @returns {{String | Symbol}[]}
   */
  getGraphNames() {
    return Array.from(this.proxyDataByGraph.keys());
  }

  /**
   * @private
   *
   * @param {String | Symbol} graphName The graph name.
   *
   * @returns {GraphMetadata}
   * @throws {Error}
   */
  getMetadata(graphName) {
    {
      const type = typeof graphName;
      if ((type !== "string") && (type !== "symbol"))
        throw new Error("graphName is neither a symbol nor a string!");
    }

    {
      const rv = this.proxyDataByGraph.get(graphName);
      if (!rv)
        throw new Error(`unknown graph "${graphName}"`);
      if (rv === DeadProxyKey)
        throw new Error(`dead object graph "${graphName}"`);
      return rv;
    }
  }

  /**
   * @private
   *
   * @param {String | Symbol}              graphName The graph name.
   * @param {GraphMetadata | DeadProxyKey} metadata  The metadata.
   *
   * @throws {Error}
   */
  setMetadataInternal(graphName, metadata) {
    if (!metadata)
      throw new Error(`no graph for "${graphName}"`);
    if ((metadata !== DeadProxyKey) && (this.proxyDataByGraph.get(graphName) === DeadProxyKey))
      throw new Error(`dead object graph "${graphName}"`);
    this.proxyDataByGraph.set(graphName, metadata);
  }

  /**
   * Get the original, unproxied value.
   * @public
   */
  getOriginal() {
    if (!this.originalValueSet)
      throw new Error("the original value hasn't been set");
    return this.getProxy(this.originGraph);
  }

  /**
   * Determine if the mapping has a particular graph.
   *
   * @param {String | Symbol} graphName The graph name.
   *
   * @returns {Boolean} true if the graph exists.
   * @public
   */
  hasGraph(graphName) {
    return this.getGraphNames().includes(graphName);
  }

  /**
   * Get the proxy or object associated with a graph name.
   *
   * @param {String | Symbol} graphName The graph name.
   *
   * @returns {Object | Proxy}
   * @public
   */
  getProxy(graphName) {
    let rv = this.getMetadata(graphName);
    return (graphName === this.originGraph) ? rv.value : rv.proxy;
  }

  /**
   *
   * @param {String | Symbol} graphName The graph name.
   *
   * @returns {Object} The shadow target.
   * @public
   */
  getShadowTarget(graphName) {
    return this.getMetadata(graphName).shadowTarget;
  }

  /**
   * Determine if the argument is a shadow target we know about.
   *
   * @param {Object} shadowTarget The presumed shadow target.
   *
   * @returns {Boolean} True if the shadow target belongs to this cylinder.
   * @public
   */
  isShadowTarget(shadowTarget) {
    const graphs = Array.from(this.proxyDataByGraph.values());
    return graphs.some(
      graph => (graph !== DeadProxyKey) && (graph.shadowTarget === shadowTarget)
    );
  }

  /**
   * Add a value to the mapping.
   *
   * @param {Membrane}      membrane  The owning membrane.
   * @param {Symbol|String} graphName The graph name of the object graph.
   * @param {GraphMetadata} metadata  The metadata (proxy, value, shadow, etc.) for the graph.
   *
   * @public
   */
  setMetadata(membrane, graphName, metadata) {
    if ((typeof metadata !== "object") || (metadata === null))
      throw new Error("metadata argument must be an object");

    const override = (typeof metadata.override === "boolean") && metadata.override;
    if (!override && this.hasGraph(graphName))
      throw new Error(`set called for previously defined graph "${graphName}"`);

    if (this.proxyDataByGraph.get(graphName) === DeadProxyKey)
      throw new Error(`dead object graph "${graphName}"`);

    const type = typeof graphName;
    if ((type !== "string") && (type !== "symbol"))
      throw new Error("graphName is neither a symbol nor a string!");

    const isForeignGraph = (graphName !== this.originGraph);

    if (!this.originalValueSet && (override || isForeignGraph))
      throw new Error("original value has not been set");

    if (isForeignGraph) {
      if (this.proxyDataByGraph.get(this.originGraph) === DeadProxyKey)
        throw new Error(`dead origin object graph "${this.originGraph}"`);
      if ("value" in metadata)
        throw new Error("metadata must not include a value");
      if (!metadata.proxy)
        throw new Error("metadata must include a proxy");
      if (typeof metadata.revoke !== "function")
        throw new Error("metadata must include a revoke method");
      if (!metadata.shadowTarget)
        throw new Error("metadata must include a shadow target");
    }
    else {
      if (!("value" in metadata))
        throw new Error("metadata must include an original value");
      if (metadata.proxy)
        throw new Error("metadata must not include a proxy");
      if (metadata.revoke)
        throw new Error("metadata must not include a revoke method");
      if (metadata.shadowTarget)
        throw new Error("metadata must not include a shadow target");
    }

    this.setMetadataInternal(graphName, metadata);

    if (isForeignGraph) {
      if (valueType(metadata.proxy) !== "primitive") {
        membrane.map.set(metadata.proxy, this);
      }
    }
    else if (!this.originalValueSet) {
      Reflect.defineProperty(this, "originalValueSet", new NWNCDataDescriptor(true));
    }

    if (!isForeignGraph &&
        !membrane.map.has(metadata.value) &&
        (valueType(metadata.value) !== "primitive")) {
      membrane.map.set(metadata.value, this);
    }
  }

  /**
   * Mark a graph name as dead.
   *
   * @param {String | Symbol} graphName The graph name of the object graph.
   * @public
   */
  removeGraph(graphName) {
    /* This will make the keys of the Membrane's WeakMapOfProxyMappings
     * unreachable, and thus reduce the set of references to the ProxyMapping.
     *
     * There's also the benefit of disallowing recreating a proxy to the
     * original object.
     */

    this.getMetadata(graphName); // ensure we're alive

    if (graphName === this.originGraph) {
      // Ensure no other graph is alive.
      const values = new Set(this.proxyDataByGraph.values());
      values.delete(DeadProxyKey);
      if (values.size !== 1)
        throw new Error("Cannot remove the origin graph with another graph referring to it");
    }
    this.setMetadataInternal(graphName, DeadProxyKey);
  }

  /**
   * Kill all membrane proxies this references.
   *
   * @param {Membrane} membrane The owning membrane.
   *
   * @public
   *
   * @note The key difference between this.selfDestruct() and this.revoke() is
   * that when the Membrane invokes this.selfDestruct(), it's expecting to set
   * all new proxies and values.
   */
  selfDestruct(membrane) {
    const names = this.getGraphNames();
    for (let i = (names.length - 1); i >= 0; i--) {
      const graphName = names[i];
      if (this.proxyDataByGraph.get(graphName) === DeadProxyKey)
        continue;
      const metadata = this.getMetadata(graphName);
      if (graphName !== this.originGraph) {
        membrane.map.delete(metadata.proxy);
      }
      else {
        membrane.map.delete(metadata.value);
      }
      this.removeGraph(graphName);
    }
  }

  /**
   * Revoke all proxies associated with a membrane.
   *
   * @param {Membrane} membrane The controlling membrane.
   *
   * @public
   */
  revokeAll(membrane) {
    if (!this.originalValueSet)
      throw new Error("the original value hasn't been set");

    const names = this.getGraphNames();
    // graphs[0] === this.originGraph
    for (let i = 1; i < names.length; i++) {
      const parts = this.proxyDataByGraph.get(names[i]);
      if (parts === DeadProxyKey)
        continue;

      if (typeof parts.revoke === "function")
        parts.revoke();
      if (Object(parts.proxy) === parts.proxy)
        membrane.revokeMapping(parts.proxy);
      if (Object(parts.shadowTarget) === parts.shadowTarget)
        membrane.revokeMapping(parts.shadowTarget);

      this.removeGraph(names[i]);
    }

    {
      const parts = this.proxyDataByGraph.get(this.originGraph);
      if (parts !== DeadProxyKey) {
        membrane.revokeMapping(parts.value);
        this.removeGraph(this.originGraph);
      }
    }
  }

  /**
   * Get a local flag's current value.
   *
   * @param {Symbol | String} graphName The object graph's name.
   * @param {String}          flagName  The flag to get.
   *
   * @returns {Boolean} The value of the flag.
   * @public
   */
  getLocalFlag(graphName, flagName) {
    this.getMetadata(graphName); // ensure we're alive
    if (typeof graphName == "string") {
      if (!this.localFlags)
        return false;
      let flag = flagName + ":" + graphName;
      return this.localFlags.has(flag);
    }
    else {
      if (!this.localFlagsSymbols)
        return false;
      let obj = this.localFlagsSymbols.get(graphName);
      if (!obj || !obj[flagName])
        return false;
      return true;
    }
  }

  /**
   * Set a local flag for a particular graph.
   *
   * @param {Symbol | String} graphName The object graph's name.
   * @param {String}          flagName  The flag to set.
   * @param {Boolean}         value     The value to set.
   *
   * @public
   */
  setLocalFlag(graphName, flagName, value) {
    this.getMetadata(graphName); // ensure we're alive
    if (typeof graphName == "string") {
      if (!this.localFlags)
        this.localFlags = new Set();

      let flag = flagName + ":" + graphName;
      if (value)
        this.localFlags.add(flag);
      else
        this.localFlags.delete(flag);
    }
    else {
      // It's harder to combine symbols and strings into a string...
      if (!this.localFlagsSymbols)
        this.localFlagsSymbols = new Map();
      let obj = this.localFlagsSymbols.get(graphName) || {};
      obj[flagName] = value;
      this.localFlagsSymbols.set(graphName, obj);
    }
  }

  /**
   * Get the list of "own keys" local to a particular object graph.
   * @param {Symbol | String} graphName The object graph's name.
   *
   * @returns {{Symbol | String}[]}
   * @public
   */
  localOwnKeys(graphName) {
    const metadata = this.getMetadata(graphName);
    let rv = [];
    if ("localDescriptors" in metadata)
      rv = Array.from(metadata.localDescriptors.keys());
    return rv;
  }

  /**
   * Get a property descriptor which is local to a graph proxy.
   *
   * @param {Symbol | String} graphName The object graph's name.
   * @param {Symbol | String} propName
   *
   * @returns {DataDescriptor | AccessorDescriptor}
   * @public
   */
  getLocalDescriptor(graphName, propName) {
    const metadata = this.getMetadata(graphName); // ensure we're alive
    let desc;
    if (!this.hasGraph(graphName))
      return desc;

    if (metadata.localDescriptors)
      desc = metadata.localDescriptors.get(propName);
    return desc;
  }

  /**
   * Set a property descriptor which is local to a graph proxy.
   *
   * @param {Symbol | String}                     graphName The object graph's name.
   * @param {Symbol | String}                     propName  The property name.
   * @param {DataDescriptor | AccessorDescriptor} desc      The property descriptor.
   *
   * @public
   *
   * @note This does not update cachedOwnKeys.
   */
  setLocalDescriptor(graphName, propName, desc) {
    const metadata = this.getMetadata(graphName); // ensure we're alive
    this.unmaskDeletion(graphName, propName);

    if (!metadata.localDescriptors) {
      metadata.localDescriptors = new Map();
    }

    metadata.localDescriptors.set(propName, desc);
    return true;
  }

  /**
   * Delete a property descriptor from an object graph.
   *
   * @param {Symbol | String} graphName         The object graph's name.
   * @param {Symbol | String} propName          The property name.
   * @param {Boolean}         recordLocalDelete True if the delete operation is local.
   *
   * @public
   *
   * @note This does not update cachedOwnKeys.
   */
  deleteLocalDescriptor(graphName, propName, recordLocalDelete) {
    this.getMetadata(graphName); // ensure we're alive
    const metadata = this.getMetadata(graphName);
    if (recordLocalDelete) {
      if (!metadata.deletedLocals)
        metadata.deletedLocals = new Set();
      metadata.deletedLocals.add(propName);
    }
    else
      this.unmaskDeletion(graphName, propName);

    if ("localDescriptors" in metadata) {
      metadata.localDescriptors.delete(propName);
      if (metadata.localDescriptors.size === 0) {
        delete metadata.localDescriptors;
      }
    }
  }

  /**
   *
   * @param {Symbol | String} graphName The object graph's name.
   * @param {Set}             set       Storage for a list of names.
   *
   * @public
   */
  appendDeletedNames(graphName, set) {
    const metadata = this.getMetadata(graphName);

    const locals = metadata.deletedLocals;
    if (!locals || !locals.size)
      return;

    const iter = locals.values();
    let next;
    do {
      next = iter.next();
      if (!next.done)
        set.add(next.value);
    } while (!next.done);
  }

  /**
   * Report if there is an active local delete for a property name.
   *
   * @param {Symbol | String} graphName The object graph's name.
   * @param {Symbol | String} propName  The property name.
   *
   * @returns {Boolean}
   * @public
   */
  wasDeletedLocally(graphName, propName) {
    const metadata = this.getMetadata(graphName);
    const locals = metadata.deletedLocals;
    return Boolean(locals) && locals.has(propName);
  }

  /**
   * Unmask a property name from the set of deleted local properties.
   *
   * @param {Symbol | String} graphName The object graph's name.
   * @param {Symbol | String} propName  The property name.
   *
   * @public
   */
  unmaskDeletion(graphName, propName) {
    const metadata = this.getMetadata(graphName);
    if (!metadata.deletedLocals)
      return;
    metadata.deletedLocals.delete(propName);
    if (metadata.deletedLocals.size === 0)
      delete metadata.deletedLocals;
  }

  /**
   * Get the cached "own keys" for a particular graph.
   *
   * @param {Symbol | String} graphName The object graph's name.
   *
   * @returns {{Symbol | String}[]}
   * @public
   */
  cachedOwnKeys(graphName) {
    const metadata = this.getMetadata(graphName);
    if ("cachedOwnKeys" in metadata)
      return metadata.cachedOwnKeys;
    return null;
  }

  /**
   * Set the cached "own keys" for a particular graph.
   *
   * @param {Symbol | String}     graphName The object graph's name.
   * @param {{Symbol | String}[]} keys      The ordered set of keys to make available.
   * @param {{Symbol | String}[]} original  The ordered set of keys on the underlying object.
   *
   * @public
   */
  setCachedOwnKeys(graphName, keys, original) {
    this.getMetadata(graphName).cachedOwnKeys = { keys, original };
  }

  /**
   * Get a filter function for a list of own keys.
   *
   * @param {Symbol | String} graphName The object graph's name.
   * @returns {?OwnKeysFilter} The filter function.
   *
   * @public
   */
  getOwnKeysFilter(graphName) {
    const metadata = this.getMetadata(graphName);
    return (typeof metadata.ownKeysFilter === "function") ?
           metadata.ownKeysFilter :
           null;
  }

  /**
   * Set a filter function for a list of own keys.
   *
   * @param {Symbol | String} graphName The object graph's name.
   * @param {?OwnKeysFilter}  filter    The filter function.
   *
   * @public
   */
  setOwnKeysFilter(graphName, filter) {
    this.getMetadata(graphName).ownKeysFilter = (typeof filter === "function") ? filter : null;
  }

  /**
   * Get the maximum argument count for a function proxy.
   * @param {Symbol | String} graphName The object graph's name.
   *
   * @returns {Number | false}
   * @public
   */
  getTruncateArgList(graphName) {
    const metadata = this.getMetadata(graphName);

    return (typeof metadata.truncateArgList !== "undefined") ?
           metadata.truncateArgList :
           false;
  }

  /**
   * Set the maximum argument count for a function proxy.
   * @param {Symbol | String} graphName The object graph's name.
   * @param {?Number | false} count     The argument count.
   *
   * @public
   */
  setTruncateArgList(graphName, count) {
    const metadata = this.getMetadata(graphName);
    if ((typeof count === "number") && (count >= 0) && (parseInt(count) === count) && isFinite(count))
      metadata.truncateArgList = count;
    else
      delete metadata.truncateArgList;
  }
}

Object.freeze(ProxyCylinder.prototype);
Object.freeze(ProxyCylinder);

/**
 * Notify all proxy listeners of a new proxy.
 *
 * @param {Object}             parts     The field object from a ProxyMapping's proxiedFields.
 * @param {ObjectGraphHandler} handler   The handler for the proxy.
 * @param {Boolean}            isOrigin  True if the handler is the origin graph handler.
 * @param {Object}             options   Special options to pass on to the listeners.
 *
 * @package
 */
function ProxyNotify(parts, handler, isOrigin, options) {
  if (typeof options === "undefined")
    options = {};

  // private variables
  const listeners = handler.__proxyListeners__;
  if (listeners.length === 0)
    return;
  const modifyRules = handler.membrane.modifyRules;

  // the actual metadata object for the listener
  var meta = Object.create(options, {
    /**
     * The proxy or value the Membrane will return to the caller.
     *
     * @note If you set this property with a non-proxy value, the value will NOT
     * be protected by the membrane.
     *
     * If you wish to replace the proxy with another Membrane-based proxy,
     * including a new proxy with a chained proxy handler (see ModifyRulesAPI),
     * do NOT just call Proxy.revocable and set this property.  Instead, set the
     * handler property with the new proxy handler, and call .rebuildProxy().
     */
    "proxy": new AccessorDescriptor(
      () => parts.proxy,
      (val) => { if (!meta.stopped) parts.proxy = val; }
    ),

    /* XXX ajvincent revoke is explicitly NOT exposed, lest a listener call it 
     * and cause chaos for any new proxy trying to rely on the existing one.  If
     * you really have a problem, use throwException() below.
     */

    /**
     * The unwrapped object or function we're building the proxy for.
     */
    "target": new DataDescriptor(parts.value),

    "isOriginGraph": new DataDescriptor(isOrigin),

    /**
     * The proxy handler.  This should be an ObjectGraphHandler.
     */
    "handler": new AccessorDescriptor(
      () => handler,
      (val) => { if (!meta.stopped) handler = val; }
    ),

    /**
     * A reference to the membrane logger, if there is one.
     */
    "logger": new DataDescriptor(handler.membrane.logger),

    /**
     * Rebuild the proxy object.
     */
    "rebuildProxy": new DataDescriptor(
      function() {
        if (!this.stopped)
          parts.proxy = modifyRules.replaceProxy(parts.proxy, handler);
      }
    ),

    /**
     * Direct the membrane to use the shadow target instead of the full proxy.
     *
     * @param mode {String} One of several values:
     *   - "frozen" means return a frozen shadow target.
     *   - "sealed" means return a sealed shadow target.
     *   - "prepared" means return a shadow target with lazy getters for all
     *     available properties and for its prototype.
     */
    "useShadowTarget": new DataDescriptor(
      (mode) => {
        ProxyNotify.useShadowTarget.apply(meta, [parts, handler, mode]);
      }
    ),
  });

  const callbacks = [];
  const inConstruction = handler.proxiesInConstruction;
  inConstruction.set(parts.value, callbacks);

  try {
    invokeProxyListeners(listeners, meta);
  }
  finally {
    callbacks.forEach(function(c) {
      try {
        c(parts.proxy);
      }
      catch (e) {
        // do nothing
      }
    });

    inConstruction.delete(parts.value);
  }
}

ProxyNotify.useShadowTarget = function(parts, handler, mode) {
  let newHandler = {};

  if (mode === "frozen")
    Object.freeze(parts.proxy);
  else if (mode === "sealed")
    Object.seal(parts.proxy);
  else if (mode === "prepared") {
    // Establish the list of own properties.
    const keys = Reflect.ownKeys(parts.proxy);
    keys.forEach(function(key) {
      handler.defineLazyGetter(parts.value, parts.shadowTarget, key);
    });

    /* Establish the prototype.  (I tried using a lazy getPrototypeOf,
     * but testing showed that fails a later test.)
     */
    let proto = handler.getPrototypeOf(parts.shadowTarget);
    Reflect.setPrototypeOf(parts.shadowTarget, proto);

    // Lazy preventExtensions.
    newHandler.preventExtensions = function(st) {
      var rv = handler.preventExtensions.apply(handler, [st]);
      delete newHandler.preventExtensions;
      return rv;
    };
  }
  else {
    throw new Error("useShadowTarget requires its first argument be 'frozen', 'sealed', or 'prepared'");
  }

  this.stopIteration();
  if (typeof parts.shadowTarget == "function") {
    newHandler.apply     = handler.boundMethods.apply;
    newHandler.construct = handler.boundMethods.construct;
  }
  else if (Reflect.ownKeys(newHandler).length === 0)
    newHandler = Reflect; // yay, maximum optimization

  let newParts = Proxy.revocable(parts.shadowTarget, newHandler);
  parts.proxy = newParts.proxy;
  parts.revoke = newParts.revoke;

  const masterMap = handler.membrane.map;
  let map = masterMap.get(parts.value);
  assert(map instanceof ProxyCylinder,
         "Didn't get a ProxyCylinder for an existing value?");
  masterMap.set(parts.proxy, map);
  makeRevokeDeleteRefs(parts, map, handler.fieldName);
};

function invokeProxyListeners(listeners, meta) {
  listeners = listeners.slice(0);
  var index = 0, exn = null, exnFound = false, stopped = false;

  Object.defineProperties(meta, {
    /**
     * Notify no more listeners.
     */
    "stopIteration": new DataDescriptor(
      () => { stopped = true; }
    ),

    "stopped": new AccessorDescriptor(
      () => stopped
    ),

    /**
     * Explicitly throw an exception from the listener, through the membrane.
     */
    "throwException": new DataDescriptor(
      function(e) { stopped = true; exnFound = true; exn = e; }
    )
  });

  Object.seal(meta);

  while (!stopped && (index < listeners.length)) {
    try {
      listeners[index](meta);
    }
    catch (e) {
      if (meta.logger) {
        /* We don't want an accidental exception to break the iteration.
        That's why the throwException() method exists:  a deliberate call means
        yes, we really want that exception to propagate outward... which is
        still nasty when you consider what a membrane is for.
        */
        try {
          meta.logger.error(e);
        }
        catch (f) {
          // really do nothing, there's no point
        }
      }
    }
    if (exnFound)
      throw exn;
    index++;
  }

  stopped = true;
}

Object.freeze(ProxyNotify);
Object.freeze(ProxyNotify.useShadowTarget);

function AssertIsPropertyKey(propName) {
  var type = typeof propName;
  if ((type !== "string") && (type !== "symbol"))
    throw new Error("propName is not a symbol or a string!");
  return true;
}

/**
 * A proxy handler designed to return only primitives and objects in a given
 * object graph, defined by the fieldName.
 *
 * @package
 */
class ObjectGraphHandler {
  constructor(membrane, fieldName) {
    {
      let t = typeof fieldName;
      if ((t != "string") && (t != "symbol"))
        throw new Error("field must be a string or a symbol!");
    }

    let boundMethods = {};
    [
      "apply",
      "construct",
    ].forEach(function(key) {
      Reflect.defineProperty(boundMethods, key, new NWNCDataDescriptor(
        this[key].bind(this), false
      ));
    }, this);
    Object.freeze(boundMethods);

    var passThroughFilter = returnFalse;

    // private
    Object.defineProperties(this, {
      "membrane": new NWNCDataDescriptor(membrane, false),
      "fieldName": new NWNCDataDescriptor(fieldName, false),

      "passThroughFilter": {
        get: () => passThroughFilter,
        set: (val) => {
          if (passThroughFilter !== returnFalse)
            throw new Error("passThroughFilter has been defined once already!");
          if (typeof val !== "function")
            throw new Error("passThroughFilter must be a function");
          passThroughFilter = val;
        },
        enumerable: false,
        configurable: false,
      },

      "mayReplacePassThrough": {
        get: () => passThroughFilter === returnFalse,
        enumerable: true,
        configurable: false
      },
    });

    // private
    Object.defineProperties(this, {
      "boundMethods": new NWNCDataDescriptor(boundMethods, false),

      /* Temporary until membraneGraphName is defined on Object.prototype through
      * the object graph.
      */
      "graphNameDescriptor": new NWNCDataDescriptor(
        new DataDescriptor(fieldName), false
      ),

      // see .defineLazyGetter, ProxyNotify for details.
      "proxiesInConstruction": new NWNCDataDescriptor(
        new WeakMap(/* original value: [callback() {}, ...]*/), false
      ),

      "__revokeFunctions__": new NWNCDataDescriptor([], false),

      "__isDead__": new DataDescriptor(false, true, true, true),

      "__proxyListeners__": new NWNCDataDescriptor([], false),

      "__functionListeners__": new NWNCDataDescriptor([], false),
    });
  }
  /* Strategy for each handler trap:
   * (1) Determine the target's origin field name.
   * (2) Wrap all non-primitive arguments for Reflect in the target field.
   * (3) var rv = Reflect[trapName].call(argList);
   * (4) Wrap rv in this.fieldName's field.
   * (5) return rv.
   *
   * Error stack trace hiding will be determined by the membrane itself.
   */

  // ProxyHandler
  ownKeys(shadowTarget) {
    this.validateTrapAndShadowTarget("ownKeys", shadowTarget);
    if (!Reflect.isExtensible(shadowTarget))
      return Reflect.ownKeys(shadowTarget);

    var target = getRealTarget(shadowTarget);
    var targetMap = this.membrane.map.get(target);

    // cached keys are only valid if original keys have not changed
    var cached = targetMap.cachedOwnKeys(this.fieldName);
    if (cached) {
      let _this = targetMap.getOriginal();
      let check = this.externalHandler(function() {
        return Reflect.ownKeys(_this);
      });

      let pass = ((check.length == cached.original.length) &&
        (check.every(function(elem) {
          return cached.original.includes(elem);
        })));
      if (pass)
        return cached.keys.slice(0);
    }
    return this.setOwnKeys(shadowTarget);
  }

  // ProxyHandler
  has(shadowTarget, propName) {
    this.validateTrapAndShadowTarget("has", shadowTarget);

    var target = getRealTarget(shadowTarget);
    /*
    http://www.ecma-international.org/ecma-262/7.0/#sec-ordinary-object-internal-methods-and-internal-slots-hasproperty-p

    1. Assert: IsPropertyKey(P) is true.
    2. Let hasOwn be ? O.[[GetOwnProperty]](P).
    3. If hasOwn is not undefined, return true.
    4. Let parent be ? O.[[GetPrototypeOf]]().
    5. If parent is not null, then
         a. Return ? parent.[[HasProperty]](P).
    6. Return false. 
    */

    // 1. Assert: IsPropertyKey(P) is true.
    AssertIsPropertyKey(propName);

    var hasOwn;
    while (target !== null) {
      let pMapping = this.membrane.map.get(target);
      let shadow = pMapping.getShadowTarget(this.fieldName);
      hasOwn = this.getOwnPropertyDescriptor(shadow, propName);
      if (typeof hasOwn !== "undefined")
        return true;
      target = this.getPrototypeOf(shadow);
      if (target === null)
        break;
      let foundProto;
      [foundProto, target] = this.membrane.getMembraneValue(
        this.fieldName,
        target
      );
      assert(foundProto, "Must find membrane value for prototype");
    }
    return false;
  }

  // ProxyHandler
  get(shadowTarget, propName, receiver) {
    this.validateTrapAndShadowTarget("get", shadowTarget);

    var desc, target, found, rv;
    target = getRealTarget(shadowTarget);

    /*
    http://www.ecma-international.org/ecma-262/7.0/#sec-ordinary-object-internal-methods-and-internal-slots-get-p-receiver

    1. Assert: IsPropertyKey(P) is true.
    2. Let desc be ? O.[[GetOwnProperty]](P).
    3. If desc is undefined, then
         a. Let parent be ? O.[[GetPrototypeOf]]().
         b. If parent is null, return undefined.
         c. Return ? parent.[[Get]](P, Receiver).
    4. If IsDataDescriptor(desc) is true, return desc.[[Value]].
    5. Assert: IsAccessorDescriptor(desc) is true.
    6. Let getter be desc.[[Get]].
    7. If getter is undefined, return undefined.
    8. Return ? Call(getter, Receiver). 
     */


    // 1. Assert: IsPropertyKey(P) is true.
    // Optimization:  do this once!
    AssertIsPropertyKey(propName);

    /* Optimization:  Recursively calling this.get() is a pain in the neck,
     * especially for the stack trace.  So let's use a do...while loop to reset
     * only the entry arguments we need (specifically, target).
     * We should exit the loop with desc, or return from the function.
     */
    do {
      let targetMap = this.membrane.map.get(target);
      {
        /* Special case:  Look for a local property descriptors first, and if we
         * find it, return it unwrapped.
         */
        desc = targetMap.getLocalDescriptor(this.fieldName, propName);

        if (desc) {
          // Quickly repeating steps 4-8 from above algorithm.
          if (isDataDescriptor(desc))
            return desc.value;
          if (!isAccessorDescriptor(desc))
            throw new Error("desc must be a data descriptor or an accessor descriptor!");
          let type = typeof desc.get;
          if (type === "undefined")
            return undefined;
          if (type !== "function")
            throw new Error("getter is not a function");
          return Reflect.apply(desc.get, receiver, []);
        }
      }

      /*
      2. Let desc be ? O.[[GetOwnProperty]](P).
      3. If desc is undefined, then
           a. Let parent be ? O.[[GetPrototypeOf]]().
           b. If parent is null, return undefined.
           c. Return ? parent.[[Get]](P, Receiver).
       */
      let shadow = targetMap.getShadowTarget(this.fieldName);
      desc = this.getOwnPropertyDescriptor(shadow, propName);
      if (!desc) {
        let proto = this.getPrototypeOf(shadow);
        if (proto === null)
          return undefined;

        {
          let foundProto, other;
          [foundProto, other] = this.membrane.getMembraneProxy(
            this.fieldName,
            proto
          );
          if (!foundProto)
            return Reflect.get(proto, propName, receiver);
          assert(other === proto, "Retrieved prototypes must match");
        }

        if (Reflect.isExtensible(shadow))
        {
          target = this.membrane.getMembraneValue(
            this.fieldName,
            proto
          )[1];
        }
        else
          target = proto;
      }
    } while (!desc);

    found = false;
    rv = undefined;

    // 4. If IsDataDescriptor(desc) is true, return desc.[[Value]].
    if (isDataDescriptor(desc)) {
      rv = desc.value;
      found = true;
      if (!desc.configurable && !desc.writable)
        return rv;
    }

    if (!found) {
      // 5. Assert: IsAccessorDescriptor(desc) is true.

      if (!isAccessorDescriptor(desc))
        throw new Error("desc must be a data descriptor or an accessor descriptor!");

      // 6. Let getter be desc.[[Get]].
      var getter = desc.get;

      /*
      7. If getter is undefined, return undefined.
      8. Return ? Call(getter, Receiver). 
       */
      {
        let type = typeof getter;
        if (type === "undefined")
          return undefined;
        if (type !== "function")
          throw new Error("getter is not a function");
        rv = this.externalHandler(function() {
          return Reflect.apply(getter, receiver, []);
        });
        found = true;
      }
    }

    if (!found) {
      // end of the algorithm
      throw new Error("Membrane fall-through: we should not get here");
    }

    return rv;
  }

  // ProxyHandler
  getOwnPropertyDescriptor(shadowTarget, propName) {
    this.validateTrapAndShadowTarget("getOwnPropertyDescriptor", shadowTarget);

    const mayLog = this.membrane.__mayLog__();
    if (mayLog) {
      this.membrane.logger.debug("propName: " + propName.toString());
    }
    var target = getRealTarget(shadowTarget);
    {
      let [found, unwrapped] = this.membrane.getMembraneValue(this.fieldName, target);
      assert(found, "Original target must be found after calling getRealTarget");
      assert(unwrapped === target, "Original target must match getMembraneValue's return value");
    }
    var targetMap = this.membrane.map.get(target);

    if (this.membrane.showGraphName && (propName == "membraneGraphName")) {
      let checkDesc = Reflect.getOwnPropertyDescriptor(shadowTarget, propName);
      if (checkDesc && !checkDesc.configurable)
        return checkDesc;
      return this.graphNameDescriptor;
    }

    try {
      /* Order of operations:
       * (1) locally deleted property:  undefined
       * (2) locally set property:  the property
       * (3) own keys filtered property: undefined
       * (4) original property:  wrapped property.
       */
      if (targetMap.wasDeletedLocally(targetMap.originField, propName) ||
          targetMap.wasDeletedLocally(this.fieldName, propName))
        return undefined;

      var desc = targetMap.getLocalDescriptor(this.fieldName, propName);
      if (desc !== undefined)
        return desc;

      {
        let originFilter = targetMap.getOwnKeysFilter(targetMap.originField);
        if (originFilter && !originFilter(propName))
          return undefined;
      }
      {
        let localFilter  = targetMap.getOwnKeysFilter(this.fieldName);
        if (localFilter && !localFilter(propName))
          return undefined;
      }

      var _this = targetMap.getOriginal();
      desc = this.externalHandler(function() {
        return Reflect.getOwnPropertyDescriptor(_this, propName);
      });

      // See .getPrototypeOf trap comments for why this matters.
      const isProtoDesc = (propName === "prototype") && isDataDescriptor(desc);
      const isForeign = ((desc !== undefined) &&
                         (targetMap.originField !== this.fieldName));
      if (isProtoDesc || isForeign) {
        // This is necessary to force desc.value to really be a proxy.
        let configurable = desc.configurable;
        desc.configurable = true;
        desc = this.membrane.wrapDescriptor(
          targetMap.originField, this.fieldName, desc
        );
        desc.configurable = configurable;
      }

      // Non-configurable descriptors must apply on the actual proxy target.
      if (desc && !desc.configurable) {
        let current = Reflect.getOwnPropertyDescriptor(shadowTarget, propName);
        let attempt = Reflect.defineProperty(shadowTarget, propName, desc);
        assert(!current || attempt,
               "Non-configurable descriptors must apply on the actual proxy target.");
      }

      // If a shadow target has a non-configurable descriptor, we must return it.
      /* XXX ajvincent It's unclear why this block couldn't go earlier in this
       * function.  There's either a bug here, or a gap in my own understanding.
       */
      {
        let shadowDesc = Reflect.getOwnPropertyDescriptor(shadowTarget, propName);
        if (shadowDesc)
          return shadowDesc;
      }

      return desc;
    }
    catch (e) {
      if (mayLog) {
        this.membrane.logger.error(e.message, e.stack);
      }
      throw e;
    }
  }

  // ProxyHandler
  getPrototypeOf(shadowTarget) {
    this.validateTrapAndShadowTarget("getPrototypeOf", shadowTarget);

    /* Prototype objects are special in JavaScript, but with proxies there is a
     * major drawback.  If the prototype property of a function is
     * non-configurable on the proxy target, the proxy is required to return the
     * proxy target's actual prototype property instead of a wrapper.  You might
     * think "just store the wrapped prototype on the shadow target," and maybe
     * that would work.
     *
     * The trouble arises when you have multiple objects sharing the same
     * prototype object (either through .prototype on functions or through
     * Reflect.getPrototypeOf on ordinary objects).  Some of them may be frozen,
     * others may be sealed, still others not.  The point is .getPrototypeOf()
     * doesn't have a non-configurability requirement to exactly match the way
     * the .prototype property lookup does.
     *
     * It's also for this reason that getPrototypeOf and setPrototypeOf were
     * completely rewritten to more directly use the real prototype chain.
     *
     * One more thing:  it is a relatively safe practice to use a proxy to add,
     * remove or modify individual properties, and ModifyRulesAPI.js supports
     * that in several flavors.  It is doable, but NOT safe, to alter the
     * prototype chain in such a way that breaks the perfect mirroring between
     * object graphs.  Thus, this membrane code will never directly support that
     * as an option.  If you really insist, you should look at either
     * ModifyRulesAPI.prototype.replaceProxy(), or replacing the referring
     * membrane proxy in the object graph with its own shadow target.
     *
     * XXX ajvincent update this comment after fixing #76 to specify how the
     * user will extract the shadow target.
     */
    const target = getRealTarget(shadowTarget);
    const targetMap = this.membrane.map.get(target);

    try {
      const proto = Reflect.getPrototypeOf(target);
      let proxy;
      if (targetMap.originField !== this.fieldName)
        proxy = this.membrane.convertArgumentToProxy(
          this.membrane.getHandlerByName(targetMap.originField),
          this,
          proto
        );
      else
        proxy = proto;

      let pMapping = this.membrane.map.get(proxy);
      if (pMapping && (pMapping.originField !== this.fieldName)) {
        assert(Reflect.setPrototypeOf(shadowTarget, proxy),
               "shadowTarget could not receive prototype?");
      }
      return proxy;
    }
    catch (e) {
      if (this.membrane.__mayLog__()) {
        this.membrane.logger.error(e.message, e.stack);
      }
      throw e;
    }
  }

  // ProxyHandler
  isExtensible(shadowTarget) {
    this.validateTrapAndShadowTarget("isExtensible", shadowTarget);

    if (!Reflect.isExtensible(shadowTarget))
      return false;
    var target = getRealTarget(shadowTarget);
    var shouldBeLocal = this.getLocalFlag(target, "storeUnknownAsLocal", true);
    if (shouldBeLocal)
      return true;
    
    var targetMap = this.membrane.map.get(target);
    var _this = targetMap.getOriginal();

    var rv = this.externalHandler(function() {
      return Reflect.isExtensible(_this);
    });

    if (!rv)
      // This is our one and only chance to set properties on the shadow target.
      this.lockShadowTarget(shadowTarget);

    return rv;
  }

  // ProxyHandler
  preventExtensions(shadowTarget) {
    this.validateTrapAndShadowTarget("preventExtensions", shadowTarget);

    var target = getRealTarget(shadowTarget);
    var targetMap = this.membrane.map.get(target);
    var _this = targetMap.getOriginal();

    // Walk the prototype chain to look for shouldBeLocal.
    var shouldBeLocal = this.getLocalFlag(target, "storeUnknownAsLocal", true);

    if (!shouldBeLocal && !this.isExtensible(shadowTarget))
      return true;

    // This is our one and only chance to set properties on the shadow target.
    var rv = this.lockShadowTarget(shadowTarget);

    if (!shouldBeLocal)
      rv = Reflect.preventExtensions(_this);
    return rv;
  }

  // ProxyHandler
  deleteProperty(shadowTarget, propName) {
    this.validateTrapAndShadowTarget("deleteProperty", shadowTarget);

    var target = getRealTarget(shadowTarget);
    const mayLog = this.membrane.__mayLog__();
    if (mayLog) {
      this.membrane.logger.debug("propName: " + propName.toString());
    }

    /*
    http://www.ecma-international.org/ecma-262/7.0/#sec-ordinarydelete

    Assert: IsPropertyKey(P) is true.
    Let desc be ? O.[[GetOwnProperty]](P).
    If desc is undefined, return true.
    If desc.[[Configurable]] is true, then
        Remove the own property with name P from O.
        Return true.
    Return false. 
    */

    // 1. Assert: IsPropertyKey(P) is true.
    AssertIsPropertyKey(propName);
    var targetMap, shouldBeLocal;

    try {
      targetMap = this.membrane.map.get(target);
      shouldBeLocal = this.requiresDeletesBeLocal(target);

      if (!shouldBeLocal) {
        /* See .defineProperty trap for why.  Basically, if the property name
         * is blacklisted, we should treat it as if the property doesn't exist
         * on the original target.  The spec says if GetOwnProperty returns
         * undefined (which it will for our proxy), we should return true.
         */
        let originFilter = targetMap.getOwnKeysFilter(targetMap.originField);
        let localFilter  = targetMap.getOwnKeysFilter(this.fieldName);
        if (originFilter || localFilter)
          this.membrane.warnOnce(this.membrane.constants.warnings.FILTERED_KEYS_WITHOUT_LOCAL);
        if (originFilter && !originFilter(propName))
          return true;
        if (localFilter && !localFilter(propName))
          return true;
      }
    }
    catch (e) {
      if (mayLog) {
        this.membrane.logger.error(e.message, e.stack);
      }
      throw e;
    }

    let desc = this.getOwnPropertyDescriptor(shadowTarget, propName);
    if (!desc)
      return true;

    if (!desc.configurable)
      return false;

    try {
      targetMap.deleteLocalDescriptor(this.fieldName, propName, shouldBeLocal);

      if (!shouldBeLocal) {
        var _this = targetMap.getOriginal();
        this.externalHandler(function() {
          return Reflect.deleteProperty(_this, propName);
        });
      }

      Reflect.deleteProperty(shadowTarget, propName);
      this.setOwnKeys(shadowTarget);

      return true;
    }
    catch (e) {
      if (mayLog) {
        this.membrane.logger.error(e.message, e.stack);
      }
      throw e;
    }
  }

  /**
   * Define a property on a target.
   *
   * @param {Object}  target        The target object.
   * @param {String}  propName      The name of the property to define.
   * @param {Object}  desc          The descriptor for the property being defined
   *                                or modified.
   * @param {Boolean} shouldBeLocal True if the property must be defined only
   *                                on the proxy (versus carried over to the
   *                                actual target).
   *
   * @note This is a ProxyHandler trap for defineProperty, modified to include 
   *       the shouldBeLocal argument.
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/defineProperty
   */
  defineProperty(shadowTarget, propName, desc, shouldBeLocal) {
    this.validateTrapAndShadowTarget("defineProperty", shadowTarget);

    var target = getRealTarget(shadowTarget);
    /* Regarding the funny indentation:  With long names such as defineProperty,
     * inGraphHandler, and shouldBeLocal, it's hard to make everything fit
     * within 80 characters on a line, and properly indent only two spaces.
     * I choose descriptiveness and preserving commit history over reformatting.
     */
    const mayLog = this.membrane.__mayLog__();
    if (mayLog) {
      this.membrane.logger.debug("propName: " + propName.toString());
    }

    if (this.membrane.showGraphName && (propName == "membraneGraphName")) {
      return Reflect.defineProperty(shadowTarget, propName, desc);
    }

    try {
      var targetMap = this.membrane.map.get(target);
      var _this = targetMap.getOriginal();

      if (!shouldBeLocal) {
        // Walk the prototype chain to look for shouldBeLocal.
        shouldBeLocal = this.getLocalFlag(target, "storeUnknownAsLocal", true);
      }

      var rv, originFilter, localFilter;

      {
        /* It is dangerous to have an ownKeys filter and define a non-local
         * property.  It will work when the property name passes through the
         * filters.  But when that property name is not permitted, then we can
         * get some strange side effects.
         *
         * Specifically, if the descriptor's configurable property is set to
         * false, either the shadow target must get the property, or an
         * exception is thrown.
         *
         * If the descriptor's configurable property is true, the ECMAScript
         * specification doesn't object...
         *
         * In either case, the property would be set, but never retrievable.  I
         * think this is fundamentally a bad thing, so I'm going to play it safe
         * and return false here, denying the property being set on either the
         * proxy or the protected target.
         */
        originFilter = targetMap.getOwnKeysFilter(targetMap.originField);
        localFilter  = targetMap.getOwnKeysFilter(this.fieldName);
        if (originFilter || localFilter)
          this.membrane.warnOnce(this.membrane.constants.warnings.FILTERED_KEYS_WITHOUT_LOCAL);
      }

      if (shouldBeLocal) {
        if (!Reflect.isExtensible(shadowTarget))
          return Reflect.defineProperty(shadowTarget, propName, desc);

        let hasOwn = true;

        // Own-keys filters modify hasOwn.
        if (hasOwn && originFilter && !originFilter(propName))
          hasOwn = false;
        if (hasOwn && localFilter && !localFilter(propName))
          hasOwn = false;

        // It's probably more expensive to look up a property than to filter the name.
        if (hasOwn)
          hasOwn = this.externalHandler(function() {
            return Boolean(Reflect.getOwnPropertyDescriptor(_this, propName));
          });

        if (!hasOwn && desc) {
          rv = targetMap.setLocalDescriptor(this.fieldName, propName, desc);
          if (rv)
            this.setOwnKeys(shadowTarget); // fix up property list
          if (!desc.configurable)
            Reflect.defineProperty(shadowTarget, propName, desc);
          return rv;
        }
        else {
          targetMap.deleteLocalDescriptor(this.fieldName, propName, false);
          // fall through to Reflect's defineProperty
        }
      }
      else {
        if (originFilter && !originFilter(propName))
          return false;
        if (localFilter && !localFilter(propName))
          return false;
      }

      if (desc !== undefined) {
        desc = this.membrane.wrapDescriptor(
          this.fieldName,
          targetMap.originField,
          desc
        );
      }

      rv = this.externalHandler(function() {
        return Reflect.defineProperty(_this, propName, desc);
      });
      if (rv) {
        targetMap.unmaskDeletion(this.fieldName, propName);
        this.setOwnKeys(shadowTarget); // fix up property list

        if (!desc.configurable)
          Reflect.defineProperty(shadowTarget, propName, desc);
      }
      return rv;
    }
    catch (e) {
      if (mayLog) {
        this.membrane.logger.error(e.message, e.stack);
      }
      throw e;
    }
  }

  // ProxyHandler
  set(shadowTarget, propName, value, receiver) {
    this.validateTrapAndShadowTarget("set", shadowTarget);

    const mayLog = this.membrane.__mayLog__();
    if (mayLog) {
      this.membrane.logger.debug("set propName: " + propName);
    }
    let target = getRealTarget(shadowTarget);

    /*
    http://www.ecma-international.org/ecma-262/7.0/#sec-ordinary-object-internal-methods-and-internal-slots-set-p-v-receiver

    1. Assert: IsPropertyKey(P) is true.
    2. Let ownDesc be ? O.[[GetOwnProperty]](P).
    3. If ownDesc is undefined, then
        a. Let parent be ? O.[[GetPrototypeOf]]().
        b. If parent is not null, then
            i.   Return ? parent.[[Set]](P, V, Receiver).
        c. Else,
            i.   Let ownDesc be the PropertyDescriptor{
                   [[Value]]: undefined,
                   [[Writable]]: true,
                   [[Enumerable]]: true,
                   [[Configurable]]: true
                 }.
    4. If IsDataDescriptor(ownDesc) is true, then
        a. If ownDesc.[[Writable]] is false, return false.
        b. If Type(Receiver) is not Object, return false.
        c. Let existingDescriptor be ? Receiver.[[GetOwnProperty]](P).
        d. If existingDescriptor is not undefined, then
            i.   If IsAccessorDescriptor(existingDescriptor) is true, return false.
            ii.  If existingDescriptor.[[Writable]] is false, return false.
            iii. Let valueDesc be the PropertyDescriptor{[[Value]]: V}.
            iv.  Return ? Receiver.[[DefineOwnProperty]](P, valueDesc).
        e. Else Receiver does not currently have a property P,
            i.   Return ? CreateDataProperty(Receiver, P, V).
    5. Assert: IsAccessorDescriptor(ownDesc) is true.
    6. Let setter be ownDesc.[[Set]].
    7. If setter is undefined, return false.
    8. Perform ? Call(setter, Receiver, « V »).
    9. Return true. 
    */

    /* Optimization:  Recursively calling this.set() is a pain in the neck,
     * especially for the stack trace.  So let's use a do...while loop to reset
     * only the entry arguments we need (specifically, shadowTarget, target).
     * We should exit the loop with desc, or return from the function.
     */

    // 1. Assert: IsPropertyKey(P) is true.
    AssertIsPropertyKey(propName);

    var ownDesc,
        shouldBeLocal = this.getLocalFlag(target, "storeUnknownAsLocal", true);

    //eslint-disable-next-line no-constant-condition
    while (true) {
      /*
      2. Let ownDesc be ? O.[[GetOwnProperty]](P).
      3. If ownDesc is undefined, then
          a. Let parent be ? O.[[GetPrototypeOf]]().
          b. If parent is not null, then
              i.   Return ? parent.[[Set]](P, V, Receiver).
          c. Else,
              i.   Let ownDesc be the PropertyDescriptor{
                     [[Value]]: undefined,
                     [[Writable]]: true,
                     [[Enumerable]]: true,
                     [[Configurable]]: true
                   }.
      */

      let pMapping = this.membrane.map.get(target);
      let shadow = pMapping.getShadowTarget(this.fieldName);
      ownDesc = this.getOwnPropertyDescriptor(shadow, propName);
      if (ownDesc)
        break;

      {
        let parent = this.getPrototypeOf(shadow);
        if (parent === null) {
          ownDesc = new DataDescriptor(undefined, true);
          break;
        }

        let found = this.membrane.getMembraneProxy(
          this.fieldName,
          parent
        )[0];
        assert(found, "Must find membrane proxy for prototype");
        let sMapping = this.membrane.map.get(parent);
        assert(sMapping, "Missing a ProxyCylinder?");

        if (sMapping.originField != this.fieldName) {
          [found, target] = this.membrane.getMembraneValue(
            this.fieldName,
            parent
          );
          assert(found, "Must find membrane value for prototype");
        }
        else
        {
          target = parent;
        }
      }
    } // end optimization for ownDesc

    // Special step:  convert receiver to unwrapped value.
    let receiverMap = this.membrane.map.get(receiver);
    if (!receiverMap) {
      // We may be under construction.
      let proto = Object.getPrototypeOf(receiver);
      let protoMap = this.membrane.map.get(proto);
      let pHandler = this.membrane.getHandlerByName(protoMap.originField);

      if (this.membrane.map.has(receiver)) {
        /* XXX ajvincent If you're stepping through in a debugger, the debugger
         * may have set this.membrane.map.get(receiver) between actions.
         * This is a true Heisenbug, where observing the behavior changes the
         * behavior.
         *
         * Therefore YOU MUST STEP OVER THE FOLLOWING LINE!  DO NOT STEP IN!
         * DO NOT FOOL AROUND WITH THE DEBUGGER, JUST STEP OVER!!!
         */
        this.membrane.convertArgumentToProxy(pHandler, this, receiver, {override: true});
      }
      else {
        this.membrane.convertArgumentToProxy(pHandler, this, receiver);
      }

      receiverMap = this.membrane.map.get(receiver);
      if (!receiverMap)
        throw new Error("How do we still not have a receiverMap?");
      if (receiverMap.originField === this.fieldName)
        throw new Error("Receiver's field name should not match!");
    }

    /*
    4. If IsDataDescriptor(ownDesc) is true, then
        a. If ownDesc.[[Writable]] is false, return false.
        b. If Type(Receiver) is not Object, return false.
        c. Let existingDescriptor be ? Receiver.[[GetOwnProperty]](P).
        d. If existingDescriptor is not undefined, then
            i.   If IsAccessorDescriptor(existingDescriptor) is true, return false.
            ii.  If existingDescriptor.[[Writable]] is false, return false.
            iii. Let valueDesc be the PropertyDescriptor{[[Value]]: V}.
            iv.  Return ? Receiver.[[DefineOwnProperty]](P, valueDesc).
        e. Else Receiver does not currently have a property P,
            i.   Return ? CreateDataProperty(Receiver, P, V).
    */
    if (isDataDescriptor(ownDesc)) {
      if (!ownDesc.writable || (valueType(receiver) == "primitive"))
        return false;

      let origReceiver = receiverMap.getOriginal();
      let existingDesc = this.externalHandler(function() {
        return Reflect.getOwnPropertyDescriptor(origReceiver, propName);
      });
      if (existingDesc !== undefined) {
        if (isAccessorDescriptor(existingDesc) || !existingDesc.writable)
          return false;
      }

      let rvProxy;
      if (!shouldBeLocal && (receiverMap.originField !== this.fieldName)) {
        rvProxy = new DataDescriptor(
          // Only now do we convert the value to the target object graph.
          this.membrane.convertArgumentToProxy(
            this,
            this.membrane.getHandlerByName(receiverMap.originField),
            value
          ),
          true
        );
      }
      else {
        rvProxy = new DataDescriptor(value, true);
      }

      if (!ownDesc.configurable)
      {
        rvProxy.configurable = false;
        rvProxy.enumerable = ownDesc.enumerable;
      }

      return this.defineProperty(
        this.getShadowTarget(receiver),
        propName,
        rvProxy,
        shouldBeLocal
      );
    }

    // 5. Assert: IsAccessorDescriptor(ownDesc) is true.
    if (!isAccessorDescriptor(ownDesc))
      throw new Error("ownDesc must be a data descriptor or an accessor descriptor!");

    /*
    6. Let setter be ownDesc.[[Set]].
    7. If setter is undefined, return false.
    */
    let setter = ownDesc.set;
    if (typeof setter === "undefined")
      return false;

    if (!this.membrane.hasProxyForValue(this.fieldName, setter))
      this.membrane.buildMapping(this, setter);

    // 8. Perform ? Call(setter, Receiver, « V »).

    if (!shouldBeLocal) {
      // Only now do we convert the value to the target object graph.
      let rvProxy = this.membrane.convertArgumentToProxy(
        this,
        this.membrane.getHandlerByName(receiverMap.originField),
        value
      );
      this.apply(this.getShadowTarget(setter), receiver, [ rvProxy ]);
    }
    else {
      this.defineProperty(
        this.getShadowTarget(receiver),
        propName,
        new DataDescriptor(value),
        shouldBeLocal
      );
    }

    // 9. Return true.
    return true;
  }

  // ProxyHandler
  setPrototypeOf(shadowTarget, proto) {
    this.validateTrapAndShadowTarget("setPrototypeOf", shadowTarget);

    var target = getRealTarget(shadowTarget);
    try {
      var targetMap = this.membrane.map.get(target);
      var _this = targetMap.getOriginal();

      let protoProxy, wrappedProxy, found;
      if (targetMap.originField !== this.fieldName) {
        protoProxy = this.membrane.convertArgumentToProxy(
          this,
          this.membrane.getHandlerByName(targetMap.originField),
          proto
        );
        [found, wrappedProxy] = this.membrane.getMembraneProxy(
          this.fieldName, proto
        );
        assert(found, "Membrane proxy not found immediately after wrapping!");
      }
      else {
        protoProxy = proto;
        wrappedProxy = proto;
      }

      var rv = this.externalHandler(function() {
        return Reflect.setPrototypeOf(_this, protoProxy);
      });
      if (rv)
        assert(Reflect.setPrototypeOf(shadowTarget, wrappedProxy),
               "shadowTarget could not receive prototype?");

      return rv;
    }
    catch (e) {
      const mayLog = this.membrane.__mayLog__();
      if (mayLog) {
        this.membrane.logger.error(e.message, e.stack);
      }
      throw e;
    }
  }

  // ProxyHandler
  apply(shadowTarget, thisArg, argumentsList) {
    this.validateTrapAndShadowTarget("apply", shadowTarget);

    var target = getRealTarget(shadowTarget);
    var _this, args = [];
    let targetMap  = this.membrane.map.get(target);
    let argHandler = this.membrane.getHandlerByName(targetMap.originField);

    const mayLog = this.membrane.__mayLog__();
    if (mayLog) {
      this.membrane.logger.debug([
        "apply originFields: inbound = ",
        argHandler.fieldName,
        ", outbound = ",
        this.fieldName
      ].join(""));
    }

    argumentsList = this.truncateArguments(target, argumentsList);

    // This is where we are "counter-wrapping" an argument.
    const optionsBase = Object.seal({
      callable: target,
      trapName: "apply"
    });

    if (targetMap.originField !== this.fieldName) {
      _this = this.membrane.convertArgumentToProxy(
        this,
        argHandler,
        thisArg,
        Object.create(optionsBase, { "isThis": new DataDescriptor(true) })
      );

      for (let i = 0; i < argumentsList.length; i++) {
        let nextArg = argumentsList[i];
        nextArg = this.membrane.convertArgumentToProxy(
          this,
          argHandler,
          nextArg,
          Object.create(optionsBase, { "argIndex": new DataDescriptor(i) })
        );
        args.push(nextArg);
      }
    }
    else {
      _this = thisArg;
      args = argumentsList.slice(0);
    }

    if (mayLog) {
      this.membrane.logger.debug("apply about to call function");
    }

    this.notifyFunctionListeners(
      "enter",
      "apply",
      target,
      undefined,
      argHandler
    );

    var rv;
    try {
      rv = this.externalHandler(function() {
        return Reflect.apply(target, _this, args);
      });
    }
    catch (ex) {
      this.notifyFunctionListeners(
        "throw",
        "apply",
        target,
        ex,
        argHandler
      );
      throw ex;
    }

    if (mayLog) {
      this.membrane.logger.debug("apply wrapping return value");
    }

    if (targetMap.originField !== this.fieldName)
      rv = this.membrane.convertArgumentToProxy(
        argHandler,
        this,
        rv
      );

    /* This is a design decision, to pass the wrapped proxy object instead of
     * the unwrapped value.  There's no particular reason for it, except that I
     * wanted to ensure that the returned value had been wrapped before invoking
     * the listener (so that both the proxy and the unwrapped value could be
     * found from the membrane).  Once the wrapping is done, we could pass the
     * unwrapped value if we wanted... but there's no particular reason to favor
     * the proxy versus the unwrapped value, or vice versa.
    */
    this.notifyFunctionListeners(
      "return",
      "apply",
      target,
      rv,
      argHandler
    );

    if (mayLog) {
      this.membrane.logger.debug("apply exiting");
    }
    return rv;
  }

  // ProxyHandler
  construct(shadowTarget, argumentsList, ctorTarget) {
    this.validateTrapAndShadowTarget("construct", shadowTarget);

    var target = getRealTarget(shadowTarget);
    var args = [];
    let targetMap  = this.membrane.map.get(target);
    let argHandler = this.membrane.getHandlerByName(targetMap.originField);

    const mayLog = this.membrane.__mayLog__();
    if (mayLog) {
      this.membrane.logger.debug([
        "construct originFields: inbound = ",
        argHandler.fieldName,
        ", outbound = ",
        this.fieldName
      ].join(""));
    }

    argumentsList = this.truncateArguments(target, argumentsList);

    // This is where we are "counter-wrapping" an argument.
    const optionsBase = Object.seal({
      callable: target,
      trapName: "construct"
    });

    for (let i = 0; i < argumentsList.length; i++) {
      let nextArg = argumentsList[i];
      nextArg = this.membrane.convertArgumentToProxy(
        this,
        argHandler,
        nextArg,
        Object.create(optionsBase, { "argIndex": new DataDescriptor(i) })
      );
      args.push(nextArg);

      if (mayLog && (valueType(nextArg) != "primitive")) {
        this.membrane.logger.debug("construct argument " + i + "'s membraneGraphName: " + nextArg.membraneGraphName);
      }
    }

    const ctor = this.membrane.convertArgumentToProxy(
      this,
      argHandler,
      ctorTarget
    );

    this.notifyFunctionListeners(
      "enter",
      "construct",
      target,
      undefined,
      argHandler
    );

    var rv;

    try {
      rv = this.externalHandler(function() {
        return Reflect.construct(target, args, ctor);
      });
    }
    catch (ex) {
      this.notifyFunctionListeners(
        "throw",
        "construct",
        target,
        ex,
        argHandler
      );
      throw ex;
    }

    rv = this.membrane.convertArgumentToProxy(
      argHandler,
      this,
      rv
    );

    /* This is a design decision, to pass the wrapped proxy object instead of
     * the unwrapped value.  There's no particular reason for it, except that I
     * wanted to ensure that the returned value had been wrapped before invoking
     * the listener (so that both the proxy and the unwrapped value could be
     * found from the membrane).  Once the wrapping is done, we could pass the
     * unwrapped value if we wanted... but there's no particular reason to favor
     * the proxy versus the unwrapped value, or vice versa.
    */
    this.notifyFunctionListeners(
      "return",
      "construct",
      target,
      rv,
      argHandler
    );

    if (mayLog) {
      this.membrane.logger.debug("construct exiting");
    }
    return rv;
  }

  /**
   * Ensure the first argument is a known shadow target.
   *
   * @param {String} trapName     The name of the trap to run.
   * @param {Object} shadowTarget The supposed target.
   * @private
   */
  validateTrapAndShadowTarget(trapName, shadowTarget) {
    const target = getRealTarget(shadowTarget);
    const targetMap = this.membrane.map.get(target);
    if (!(targetMap instanceof ProxyCylinder))
      throw new Error("No ProxyCylinder found for shadow target!");
    if (!targetMap.isShadowTarget(shadowTarget)) {
      throw new Error(
        "ObjectGraphHandler traps must be called with a shadow target!"
      );
    }
    const disableTrapFlag = `disableTrap(${trapName})`;
    if (targetMap.getLocalFlag(this.fieldName, disableTrapFlag) ||
        targetMap.getLocalFlag(targetMap.originField, disableTrapFlag))
      throw new Error(`The ${trapName} trap is not executable.`);
  }

  /**
   * Get the shadow target associated with a real value.
   *
   * @private
   */
  getShadowTarget(target) {
    let targetMap = this.membrane.map.get(target);
    return targetMap.getShadowTarget(this.fieldName);
  }

  /**
   * Ensure a value has been wrapped in the membrane (and is available for distortions)
   *
   * @param target {Object} The value to wrap.
   */
  ensureMapping(target) {
    if (!this.membrane.hasProxyForValue(this.fieldName, target))
      this.membrane.buildMapping(this, target);
  }
  
  /**
   * Add a listener for new proxies.
   *
   * @see ProxyNotify
   */
  addProxyListener(listener) {
    if (typeof listener != "function")
      throw new Error("listener is not a function!");
    if (!this.__proxyListeners__.includes(listener))
      this.__proxyListeners__.push(listener);
  }

  /**
   * Remove a listener for new proxies.
   *
   * @see ProxyNotify
   */
  removeProxyListener(listener) {
    let index = this.__proxyListeners__.indexOf(listener);
    if (index == -1)
      throw new Error("listener is not registered!");
    this.__proxyListeners__.splice(index, 1);
  }

  /**
   * Add a listener for function entry, return and throw operations.
   *
   * @param listener {Function} The listener to add.
   *
   * @see ObjectGraphHandler.prototype.notifyFunctionListeners for what each
   * listener will get for its arguments.
   */
  addFunctionListener(listener) {
    if (typeof listener != "function")
      throw new Error("listener is not a function!");
    if (!this.__functionListeners__.includes(listener))
      this.__functionListeners__.push(listener);
  }

  /**
   * Add a listener for function entry, return and throw operations.
   *
   * @param listener {Function} The listener to remove.
   */
  removeFunctionListener(listener) {
    let index = this.__functionListeners__.indexOf(listener);
    if (index == -1)
      throw new Error("listener is not registered!");
    this.__functionListeners__.splice(index, 1);
  }

  /**
   * Notify listeners we are transitioning from one object graph to another for
   * a function call.
   *
   * @param reason   {String} Either "enter", "return" or "throw".
   * @param trapName {String} Either "apply" or "construct".
   * @param target   {Object} The unwrapped target we call.
   * @param rvOrExn  {Any}    If reason is "enter", undefined.
   *                          If reason is "return", the return value.
   *                          If reason is "throw", the exception.
   * @param origin   {ObjectGraphHandler} The origin graph handler.
   *
   * @note
   *
   * @private
   */
  notifyFunctionListeners(reason, trapName, target, rvOrExn, origin) {
    var listeners;
    {
      let ourListeners = this.__functionListeners__.slice(0);
      let nativeListeners = origin.__functionListeners__.slice(0);
      let membraneListeners = this.membrane.__functionListeners__.slice(0);
      listeners = ourListeners.concat(nativeListeners, membraneListeners);
    }
    if (listeners.length === 0)
      return;

    const args = [
      reason,
      trapName,
      this.fieldName,
      origin.fieldName,
      target,
      rvOrExn
    ];
    Object.freeze(args);

    listeners.forEach((func) => {
      try {
        func.apply(null, args);
      }
      catch (ex) {
        if (this.membrane.__mayLog__()) {
          try {
            this.membrane.logger.error(ex);
          }
          catch (ex2) {
            // do nothing
          }
        }
      }
    }, this);
  }

  /**
   * Set all properties on a shadow target, including prototype, and seal it.
   *
   * @private
   */
  lockShadowTarget(shadowTarget) {
    const target = getRealTarget(shadowTarget);
    const targetMap = this.membrane.map.get(target);
    const _this = targetMap.getOriginal();
    const keys = this.setOwnKeys(shadowTarget);
    keys.forEach(function(propName) {
      if (this.membrane.showGraphName && (propName == "membraneGraphName")) {
        // Special case.
        Reflect.defineProperty(
          shadowTarget, propName, this.graphNameDescriptor
        );
      }
      else
        this.defineLazyGetter(_this, shadowTarget, propName);

      // We want to trigger the lazy getter so that the property can be sealed.
      void(Reflect.get(shadowTarget, propName));
    }, this);

    // fix the prototype;
    const proto = this.getPrototypeOf(shadowTarget);
    assert(Reflect.setPrototypeOf(shadowTarget, proto),
           "Failed to set unwrapped prototype on non-extensible?");
    return Reflect.preventExtensions(shadowTarget);
  }

  /**
   * Specify the list of ownKeys this proxy exposes.
   *
   * @param {Object} shadowTarget The proxy target
   * @private
   *
   * @returns {String[]} The list of exposed keys.
   */
  setOwnKeys(shadowTarget) {
    var target = getRealTarget(shadowTarget);
    var targetMap = this.membrane.map.get(target);
    var _this = targetMap.getOriginal();

    // First, get the underlying object's key list, forming a base.
    var originalKeys = this.externalHandler(function() {
      return Reflect.ownKeys(_this);
    });

    // Remove duplicated names and keys that have been deleted.
    {
      let mustSkip = new Set();
      targetMap.appendDeletedNames(targetMap.originField, mustSkip);
      targetMap.appendDeletedNames(this.fieldName, mustSkip);

      let originFilter = targetMap.getOwnKeysFilter(targetMap.originField);
      let localFilter  = targetMap.getOwnKeysFilter(this.fieldName);

      if ((mustSkip.size > 0) || originFilter || localFilter) {
        originalKeys = originalKeys.filter(function(elem) {
          if (mustSkip.has(elem))
            return false;
          if (originFilter && !originFilter.apply(this, arguments))
            return false;
          if (localFilter && !localFilter.apply(this, arguments))
            return false;
          return true;
        });
      }
    }

    // Append the local proxy keys.
    var rv;
    {
      let originExtraKeys = targetMap.localOwnKeys(targetMap.originField);
      let targetExtraKeys = targetMap.localOwnKeys(this.fieldName);
      let known = new Set(originalKeys);
      let f = function(key) {
        if (known.has(key))
          return false;
        known.add(key);
        return true;
      };
      originExtraKeys = originExtraKeys.filter(f);
      targetExtraKeys = targetExtraKeys.filter(f);
      rv = originalKeys.concat(originExtraKeys, targetExtraKeys);
    }

    if (this.membrane.showGraphName && !rv.includes("membraneGraphName")) {
      rv.push("membraneGraphName");
    }

    // Optimization, storing the generated key list for future retrieval.
    targetMap.setCachedOwnKeys(this.fieldName, rv, originalKeys);

    {
      /* Give the shadow target any non-configurable keys it needs.
         @see http://www.ecma-international.org/ecma-262/7.0/#sec-proxy-object-internal-methods-and-internal-slots-ownpropertykeys
         This code tries to fix steps 17 and 19.
      */

      // trap == rv, in step 5

      // step 9
      const extensibleTarget = Reflect.isExtensible(shadowTarget);

      // step 10
      let targetKeys = Reflect.ownKeys(shadowTarget);

      // step 12, 13
      let targetConfigurableKeys = [], targetNonconfigurableKeys = [];

      // step 14
      targetKeys.forEach(function(key) {
        let desc = Reflect.getOwnPropertyDescriptor(shadowTarget, key);
        if (desc && !desc.configurable)
          targetNonconfigurableKeys.push(key);
        else
          targetConfigurableKeys.push(key);
      });

      // step 15
      if (extensibleTarget && (targetNonconfigurableKeys.length === 0)) {
        return rv;
      }

      // step 16
      let uncheckedResultKeys = new Set(rv);

      // step 17
      targetNonconfigurableKeys.forEach(function(key) {
        if (!uncheckedResultKeys.has(key)) {
          rv.push(key);
        }
        uncheckedResultKeys.delete(key);
      }, this);

      // step 18
      if (extensibleTarget)
        return rv;

      // step 19
      targetConfigurableKeys.forEach(function(key) {
        if (!uncheckedResultKeys.has(key)) {
          rv.push(key);
        }
        uncheckedResultKeys.delete(key);
      });

      // step 20
      assert(uncheckedResultKeys.size === 0, "all required keys should be applied by now");
    }
    return rv;
  }

  /**
   * Define a "lazy" accessor descriptor which replaces itself with a direct
   * property descriptor when needed.
   *
   * @param {Object}          source       The source object holding a property.
   * @param {Object}          shadowTarget The shadow target for a proxy.
   * @param {String | Symbol} propName     The name of the property to copy.
   *
   * @returns {Boolean} true if the lazy property descriptor was defined.
   *
   * @private
   */
  defineLazyGetter(source, shadowTarget, propName) {
    const handler = this;

    let lockState = "none", lockedValue;
    function setLockedValue(value) {
      /* XXX ajvincent The intent is to mark this accessor descriptor as one
       * that can safely be converted to (new DataDescriptor(value)).
       * Unfortunately, a sealed accessor descriptor has the .configurable
       * property set to false, so we can never replace this getter in that
       * scenario with a data descriptor.  ES7 spec sections 7.3.14
       * (SetIntegrityLevel) and 9.1.6.3 (ValidateAndApplyPropertyDescriptor)
       * force that upon us.
       *
       * I hope that a ECMAScript engine can be written (and a future
       * specification written) that could detect this unbreakable contract and
       * internally convert the accessor descriptor to a data descriptor.  That
       * would be a nice optimization for a "just-in-time" compiler.
       *
       * Simply put:  (1) The only setter for lockedValue is setLockedValue.
       * (2) There are at most only two references to setLockedValue ever, and
       * that only briefly in a recursive chain of proxy creation operations.
       * (3) I go out of our way to ensure all references to the enclosed
       * setLockedValue function go away as soon as possible.  Therefore, (4)
       * when all references to setLockedValue go away, lockedValue is
       * effectively a constant.  (5) lockState can only be set to "finalized"
       * by setLockedState.  (6) the setter for this property has been removed
       * before then.  Therefore, (7) lazyDesc.get() can return only one
       * possible value once lockState has become "finalized", and (8) despite
       * the property descriptor's [[Configurable]] flag being set to false, it
       * is completely safe to convert the property to a data descriptor.
       *
       * Lacking such an automated optimization, it would be nice if a future
       * ECMAScript standard could define
       * Object.lockPropertyDescriptor(obj, propName) which could quickly assert
       * the accessor descriptor really can only generate one value in the
       * future, and then internally do the data conversion.
       */

      // This lockState check should be treated as an assertion.
      if (lockState !== "transient")
        throw new Error("setLockedValue should be callable exactly once!");
      lockedValue = value;
      lockState = "finalized";
    }

    const lazyDesc = {
      get: function() {
        if (lockState === "finalized")
          return lockedValue;
        if (lockState === "transient")
          return handler.membrane.getMembraneProxy(
            handler.fieldName, shadowTarget
          ).proxy;

        /* When the shadow target is sealed, desc.configurable is not updated.
         * But the shadow target's properties all get the [[Configurable]] flag
         * removed.  So an attempt to delete the property will fail, which means
         * the assert below will throw.
         * 
         * The tests required only that an exception be thrown.  However,
         * asserts are for internal errors, and in theory can be disabled at any
         * time:  they're not for catching mistakes by the end-user.  That's why
         * I am deliberately throwing an exception here, before the assert call.
         */
        let current = Reflect.getOwnPropertyDescriptor(shadowTarget, propName);
        if (!current.configurable)
          throw new Error("lazy getter descriptor is not configurable -- this is fatal");

        handler.validateTrapAndShadowTarget("defineLazyGetter", shadowTarget);

        const target = getRealTarget(shadowTarget);
        const targetMap = handler.membrane.map.get(target);

        // sourceDesc is the descriptor we really want
        let sourceDesc = (
          targetMap.getLocalDescriptor(handler.fieldName, propName) ||
          Reflect.getOwnPropertyDescriptor(source, propName)
        );

        if ((sourceDesc !== undefined) &&
            (targetMap.originField !== handler.fieldName)) {
          let hasUnwrapped = "value" in sourceDesc,
              unwrapped = sourceDesc.value;

          // This is necessary to force desc.value to be wrapped in the membrane.
          let configurable = sourceDesc.configurable;
          sourceDesc.configurable = true;
          sourceDesc = handler.membrane.wrapDescriptor(
            targetMap.originField, handler.fieldName, sourceDesc
          );
          sourceDesc.configurable = configurable;

          if (hasUnwrapped && handler.proxiesInConstruction.has(unwrapped)) {
            /* Ah, nuts.  Somewhere in our stack trace, the unwrapped value has
             * a proxy in this object graph under construction.  That's not
             * supposed to happen very often, but can happen during a recursive
             * Object.seal() or Object.freeze() call.  What that means is that
             * we may not be able to replace the lazy getter (which is an
             * accessor descriptor) with a data descriptor when external code
             * looks up the property on the shadow target.
             */
            handler.proxiesInConstruction.get(unwrapped).push(setLockedValue);
            sourceDesc = lazyDesc;
            delete sourceDesc.set;
            lockState = "transient";
          }
        }

        assert(
          Reflect.deleteProperty(shadowTarget, propName),
          "Couldn't delete original descriptor?"
        );
        assert(
          Reflect.defineProperty(this, propName, sourceDesc),
          "Couldn't redefine shadowTarget with descriptor?"
        );

        // Finally, run the actual getter.
        if (sourceDesc === undefined)
          return undefined;
        if ("get" in sourceDesc)
          return sourceDesc.get.apply(this);
        if ("value" in sourceDesc)
          return sourceDesc.value;
        return undefined;
      },

      set: function(value) {
        handler.validateTrapAndShadowTarget("defineLazyGetter", shadowTarget);

        if (valueType(value) !== "primitive") {
          // Maybe we have to wrap the actual descriptor.
          const target = getRealTarget(shadowTarget);
          const targetMap = handler.membrane.map.get(target);
          if (targetMap.originField !== handler.fieldName) {
            let originHandler = handler.membrane.getHandlerByName(
              targetMap.originField
            );
            value = handler.membrane.convertArgumentToProxy(
              originHandler, handler, value
            );
          }
        }

        /* When the shadow target is sealed, desc.configurable is not updated.
         * But the shadow target's properties all get the [[Configurable]] flag
         * removed.  So an attempt to delete the property will fail, which means
         * the assert below will throw.
         * 
         * The tests required only that an exception be thrown.  However,
         * asserts are for internal errors, and in theory can be disabled at any
         * time:  they're not for catching mistakes by the end-user.  That's why
         * I am deliberately throwing an exception here, before the assert call.
         */
        let current = Reflect.getOwnPropertyDescriptor(shadowTarget, propName);
        if (!current.configurable)
          throw new Error("lazy getter descriptor is not configurable -- this is fatal");

        const desc = new DataDescriptor(value, true, current.enumerable, true);

        assert(
          Reflect.deleteProperty(shadowTarget, propName),
          "Couldn't delete original descriptor?"
        );
        assert(
          Reflect.defineProperty(this, propName, desc),
          "Couldn't redefine shadowTarget with descriptor?"
        );

        return value;
      },

      enumerable: true,
      configurable: true,
    };

    {
      handler.membrane.buildMapping(handler, lazyDesc.get);
      handler.membrane.buildMapping(handler, lazyDesc.set);
    }

    {
      let current = Reflect.getOwnPropertyDescriptor(source, propName);
      if (current && !current.enumerable)
        lazyDesc.enumerable = false;
    }

    return Reflect.defineProperty(shadowTarget, propName, lazyDesc);
  }

  /**
   * Determine if a target, or any prototype ancestor, has a local-to-the-proxy
   * flag.
   *
   * @argument {Object}  target   The proxy target.
   * @argument {String}  flagName The name of the flag.
   * @argument {Boolean} recurse  True if we should look at prototype ancestors.
   *
   * @returns {Boolean} True if local properties have been requested.
   * @private
   */
  getLocalFlag(target, flagName, recurse) {
    let map = this.membrane.map.get(target);
    const field = this.fieldName;
    const originField = map.originField;

    //eslint-disable-next-line no-constant-condition
    while (true) {
      let shouldBeLocal = map.getLocalFlag(field, flagName) ||
                          map.getLocalFlag(originField, flagName);
      if (shouldBeLocal)
        return true;
      if (!recurse)
        return false;
      let shadowTarget = map.getShadowTarget(this.fieldName);

      /* XXX ajvincent I suspect this assertion might fail if
       * this.fieldName == map.originField:  if the field represents an original
       * value.
       */
      assert(shadowTarget, "getLocalFlag failed to get a shadow target!");

      let protoTarget = this.getPrototypeOf(shadowTarget);
      if (!protoTarget)
        return false;
      map = this.membrane.map.get(protoTarget);
      if (!map)
        return false;
      assert(map instanceof ProxyCylinder, "map not found in getLocalFlag?");
    }
  }

  /**
   * Determine whether this proxy (or one it inherits from) requires local
   * property deletions.
   *
   * @param {Object} target The proxy target.
   *
   * @returns {Boolean} True if deletes should be local.
   * @private
   */
  requiresDeletesBeLocal(target) {
    var protoTarget = target;
    var map = this.membrane.map.get(protoTarget);
    const originField = map.originField;

    //eslint-disable-next-line no-constant-condition
    while (true) {
      let shouldBeLocal = map.getLocalFlag(this.fieldName, "requireLocalDelete") ||
                          map.getLocalFlag(originField, "requireLocalDelete");
      if (shouldBeLocal)
        return true;
      let shadowTarget = map.getShadowTarget(this.fieldName);
      protoTarget = this.getPrototypeOf(shadowTarget);
      if (!protoTarget)
        return false;
      map = this.membrane.map.get(protoTarget);
    }
  }

  /**
   * Truncate the argument list, if necessary.
   *
   * @param target        {Function} The method about to be invoked.
   * @param argumentsList {Value[]}  The list of arguments
   *
   * returns {Value[]} a copy of the list of arguments, truncated.
   *
   * @private
   */
  truncateArguments(target, argumentsList) {
    assert(Array.isArray(argumentsList), "argumentsList must be an array!");
    const map = this.membrane.map.get(target);

    var originCount = map.getTruncateArgList(map.originField);
    if (typeof originCount === "boolean") {
      originCount = originCount ? target.length : Infinity;
    }
    else {
      assert(Number.isInteger(originCount) && (originCount >= 0),
             "must call slice with a non-negative integer length");
    }

    var targetCount = map.getTruncateArgList(this.fieldName);
    if (typeof targetCount === "boolean") {
      targetCount = targetCount ? target.length : Infinity;
    }
    else {
      assert(Number.isInteger(targetCount) && (targetCount >= 0),
             "must call slice with a non-negative integer length");
    }

    const count = Math.min(originCount, targetCount);
    return argumentsList.slice(0, count);
  }

  /**
   * Add a ProxyCylinder or a Proxy.revoke function to our list.
   *
   * @package
   */
  addRevocable(revoke) {
    if (this.__isDead__)
      throw new Error("This membrane handler is dead!");
    this.__revokeFunctions__.push(revoke);
  }

  /**
   * Remove a ProxyCylinder or a Proxy.revoke function from our list.
   *
   * @package
   */
  removeRevocable(revoke) {
    let index = this.__revokeFunctions__.indexOf(revoke);
    if (index == -1) {
      throw new Error("Unknown revoke function!");
    }
    this.__revokeFunctions__.splice(index, 1);
  }

  /**
   * Revoke the entire object graph.
   */
  revokeEverything() {
    if (this.__isDead__)
      throw new Error("This membrane handler is dead!");
    Object.defineProperty(this, "__isDead__", new DataDescriptor(true));
    let length = this.__revokeFunctions__.length;
    for (var i = 0; i < length; i++) {
      let revocable = this.__revokeFunctions__[i];
      if (revocable instanceof ProxyCylinder)
        revocable.revoke(this.membrane);
      else // typeof revocable == "function"
        revocable();
    }
  }
}

Object.seal(ObjectGraphHandler);

/**
 * @package
 */
class DistortionsListener {
  constructor(membrane) {
    // private
    Object.defineProperties(this, {
      "membrane":
        new NWNCDataDescriptor(membrane, false),
      "proxyListener":
        new NWNCDataDescriptor(this.proxyListener.bind(this), false),
      "valueAndProtoMap":
        new NWNCDataDescriptor(new Map(/*
          object or function.prototype: JSON configuration
        */), false),

      "instanceMap":
        new NWNCDataDescriptor(new Map(/*
          function: JSON configuration
        */), false),

      "filterToConfigMap":
        new NWNCDataDescriptor(new Map(/*
          function returning boolean: JSON configuration
        */), false),
    
      "ignorableValues":
        new NWNCDataDescriptor(new Set(), false),
    });
  }

  addListener(value, category, config) {
    if ((category === "prototype") || (category === "instance"))
      value = value.prototype;

    if ((category === "prototype") || (category === "value"))
      this.valueAndProtoMap.set(value, config);
    else if (category === "iterable")
      Array.from(value).forEach((item) => this.valueAndProtoMap.set(item, config));
    else if (category === "instance")
      this.instanceMap.set(value, config);
    else if ((category === "filter") && (typeof value === "function"))
      this.filterToConfigMap.set(value, config);
    else
      throw new Error(`Unsupported category ${category} for value`);
  }

  removeListener(value, category) {
    if ((category === "prototype") || (category === "instance"))
      value = value.prototype;

    if ((category === "prototype") || (category === "value"))
      this.valueAndProtoMap.delete(value);
    else if (category === "iterable")
      Array.from(value).forEach((item) => this.valueAndProtoMap.delete(item));
    else if (category === "instance")
      this.instanceMap.delete(value);
    else if ((category === "filter") && (typeof value === "function"))
      this.filterToConfigMap.delete(value);
    else
      throw new Error(`Unsupported category ${category} for value`);
  }

  listenOnce(meta, config) {
    this.addListener(meta.target, "value", config);
    try {
      this.proxyListener(meta);
    }
    finally {
      this.removeListener(meta.target, "value");
    }
  }

  sampleConfig(isFunction) {
    const rv = {
      formatVersion: "0.8.2",
      dataVersion: "0.1",

      filterOwnKeys: false,
      proxyTraps: allTraps.slice(0),
      storeUnknownAsLocal: false,
      requireLocalDelete: false,
      useShadowTarget: false,
    };

    if (isFunction) {
      rv.truncateArgList = false;
    }
    return rv;
  }

  bindToHandler(handler) {
    if (!this.membrane.ownsHandler(handler)) {
      throw new Error("Membrane must own the first argument as an object graph handler!");
    }
    handler.addProxyListener(this.proxyListener);

    if (handler.mayReplacePassThrough)
      handler.passThroughFilter = this.passThroughFilter.bind(this);
  }

  ignorePrimordials() {
    Primordials.forEach(function(p) {
      if (p)
        this.ignorableValues.add(p);
    }, this);
  }

  /**
   * @private
   */
  getConfigurationForListener(meta) {
    let config = this.valueAndProtoMap.get(meta.target);
    if (!config) {
      let proto = Reflect.getPrototypeOf(meta.target);
      config = this.instanceMap.get(proto);
    }

    if (!config) {
      let iter, filter;
      iter = this.filterToConfigMap.entries();
      let entry = iter.next();
      while (!entry.done && !meta.stopped) {
        filter = entry.value[0];
        if (filter(meta)) {
          config = entry.value[1];
          break;
        }
        else {
          entry = iter.next();
        }
      }
    }

    return config;
  }

  applyConfiguration(config, meta) {
    const rules = this.membrane.modifyRules;
    const fieldName = meta.handler.fieldName;
    const modifyTarget = (meta.isOriginGraph) ? meta.target : meta.proxy;
    if (Array.isArray(config.filterOwnKeys)) {
      const filterOptions = {
        // empty, but preserved on separate lines for git blame
      };
      if (meta.originHandler)
        filterOptions.originHandler = meta.originHandler;
      if (meta.targetHandler)
        filterOptions.targetHandler = meta.targetHandler;
      rules.filterOwnKeys(
        fieldName,
        modifyTarget,
        config.filterOwnKeys,
        filterOptions
      );
    }

    if (!meta.isOriginGraph && !Reflect.isExtensible(meta.target))
      Reflect.preventExtensions(meta.proxy);

    const deadTraps = allTraps.filter(function(key) {
      return !config.proxyTraps.includes(key);
    });
    rules.disableTraps(fieldName, modifyTarget, deadTraps);

    if (config.storeUnknownAsLocal)
      rules.storeUnknownAsLocal(fieldName, modifyTarget);

    if (config.requireLocalDelete)
      rules.requireLocalDelete(fieldName, modifyTarget);

    if (("truncateArgList" in config) && (config.truncateArgList !== false))
      rules.truncateArgList(fieldName, modifyTarget, config.truncateArgList);
  }

  /**
   * @private
   */
  proxyListener(meta) {
    const config = this.getConfigurationForListener(meta);
    this.applyConfiguration(config, meta);

    meta.stopIteration();
  }

  passThroughFilter(value) {
    return this.ignorableValues.has(value);
  }
}

Object.freeze(DistortionsListener.prototype);

/**
 * @fileoverview
 *
 * The Membrane implementation represents a perfect mirroring of objects and
 * properties from one object graph to another... until the code creating the
 * membrane invokes methods of membrane.modifyRules.  Then, through either
 * methods on ProxyMapping or new proxy traps, the membrane will be able to use
 * the full power proxies expose, without carrying the operations over to the
 * object graph which owns a particular "original" value (meaning unwrapped for
 * direct access).
 *
 * For developers modifying this API to add new general-behavior rules, here are
 * the original author's recommendations:
 *
 * (1) Add your public API on ModifyRulesAPI.prototype.
 *   * When it makes sense to do so, the new methods' names and arguments should
 *     resemble methods on Object or Reflect.  (This does not mean
 *     they should have exactly the same names and arguments - only that you
 *     should consider existing standardized methods on standardized globals,
 *     and try to make new methods on ModifyRulesAPI.prototype follow roughly
 *     the same pattern in the new API.)
 * (2) When practical, especially when it affects only one object graph
 *     directly, use ProxyMapping objects to store properties which determine
 *     the rules, as opposed to new proxy traps.
 *   * Define new methods on ProxyMapping.prototype for storing or retrieving
 *     the properties.
 *   * Internally, the new methods should store properties on
 *     this.proxiedFields[fieldName].
 *   * Modify the existing ProxyHandler traps in ObjectGraphHandler.prototype
 *     to call the ProxyMapping methods, in order to implement the new behavior.
 * (3) If the new API must define a new proxy, or more than one:
 *   * Use membrane.modifyRules.createChainHandler to define the ProxyHandler.
 *   * In the ChainHandler's own-property traps, use this.nextHandler[trapName]
 *     or this.baseHandler[trapName] to forward operations to the next or
 *     original traps in the prototype chain, respectively.
 *   * Be minimalistic:  Implement only the traps you explicitly need, and only
 *     to do the specific behavior you need.  Other ProxyHandlers in the
 *     prototype chain should be trusted to handle the behaviors you don't need.
 *   * Use membrane.modifyRules.replaceProxy to apply the new ProxyHandler.
 */

const ChainHandlers = new WeakSet();

// XXX ajvincent These rules are examples of what DogfoodMembrane should set.
const ChainHandlerProtection = Object.create(Reflect, {
  /**
   * Return true if a property should not be deleted or redefined.
   */
  "isProtectedName": new DataDescriptor(function(chainHandler, propName) {
    let rv = ["nextHandler", "baseHandler", "membrane"];
    let baseHandler = chainHandler.baseHandler;
    if (baseHandler !== Reflect)
      rv = rv.concat(Reflect.ownKeys(baseHandler));
    return rv.includes(propName);
  }, false, false, false),

  /**
   * Thou shalt not set the prototype of a ChainHandler.
   */
  "setPrototypeOf": new DataDescriptor(function() {
    return false;
  }, false, false, false),

  /**
   * Proxy/handler trap restricting which properties may be deleted.
   */
  "deleteProperty": new DataDescriptor(function(chainHandler, propName) {
    if (this.isProtectedName(chainHandler, propName))
      return false;
    return Reflect.deleteProperty(chainHandler, propName);
  }, false, false, false),

  /**
   * Proxy/handler trap restricting which properties may be redefined.
   */
  "defineProperty": new DataDescriptor(function(chainHandler, propName, desc) {
    if (this.isProtectedName(chainHandler, propName))
      return false;

    if (allTraps.includes(propName)) {
      if (!isDataDescriptor(desc) || (typeof desc.value !== "function"))
        return false;
    }

    return Reflect.defineProperty(chainHandler, propName, desc);
  }, false, false, false)
});

class ModifyRulesAPI {
  constructor(membrane) {
    Object.defineProperty(this, "membrane", new DataDescriptor(
      membrane, false, false, false
    ));
    Object.seal(this);
  }

  /**
   * Create a ProxyHandler inheriting from Reflect or an ObjectGraphHandler.
   *
   * @param existingHandler {ProxyHandler} The prototype of the new handler.
   */
  createChainHandler(existingHandler) {
    // Yes, the logic is a little convoluted, but it seems to work this way.
    let baseHandler = Reflect, description = "Reflect";
    if (ChainHandlers.has(existingHandler))
      baseHandler = existingHandler.baseHandler;

    if (existingHandler instanceof ObjectGraphHandler) {
      if (!this.membrane.ownsHandler(existingHandler)) {
        // XXX ajvincent Fix this error message!!
        throw new Error("fieldName must be a string or a symbol representing an ObjectGraphName in the Membrane, or null to represent Reflect");
      }

      baseHandler = this.membrane.getHandlerByName(existingHandler.fieldName);
      description = "our membrane's " + baseHandler.fieldName + " ObjectGraphHandler";
    }

    else if (baseHandler !== Reflect) {
      // XXX ajvincent Fix this error message!!
      throw new Error("fieldName must be a string or a symbol representing an ObjectGraphName in the Membrane, or null to represent Reflect");
    }

    if ((baseHandler !== existingHandler) && !ChainHandlers.has(existingHandler)) {
      throw new Error("Existing handler neither is " + description + " nor inherits from it");
    }

    var rv = Object.create(existingHandler, {
      "nextHandler": new DataDescriptor(existingHandler, false, false, false),
      "baseHandler": new DataDescriptor(baseHandler, false, false, false),
      "membrane":    new DataDescriptor(this.membrane, false, false, false),
    });

    rv = new Proxy(rv, ChainHandlerProtection);
    ChainHandlers.add(rv);
    return rv;
  }

  /**
   * Replace a proxy in the membrane.
   *
   * @param oldProxy {Proxy} The proxy to replace.
   * @param handler  {ProxyHandler} What to base the new proxy on.
   *
   * @returns {Proxy} The newly built proxy.
   */
  replaceProxy(oldProxy, handler) {
    /*
    if (DogfoodMembrane) {
      const [found, unwrapped] = DogfoodMembrane.getMembraneValue("internal", handler);
      if (found)
        handler = unwrapped;
    }
    */

    let baseHandler = ChainHandlers.has(handler) ? handler.baseHandler : handler;
    {
      /* These assertions are to make sure the proxy we're replacing is safe to
       * use in the membrane.
       */

      /* Ensure it has an appropriate ProxyHandler on its prototype chain.  If
       * the old proxy is actually the original value, the handler must have
       * Reflect on its prototype chain.  Otherwise, the handler must have this
       * on its prototype chain.
       *
       * Note that the handler can be Reflect or this, respectively:  that's
       * perfectly legal, as a way of restoring original behavior for the given
       * object graph.
       */

      let accepted = false;
      if (baseHandler === Reflect) {
        accepted = true;
      }
      else if (baseHandler instanceof ObjectGraphHandler) {
        let fieldName = baseHandler.fieldName;
        let ownedHandler = this.membrane.getHandlerByName(fieldName);
        accepted = ownedHandler === baseHandler;
      }

      if (!accepted) {
        throw new Error("handler neither inherits from Reflect or an ObjectGraphHandler in this membrane");
      }
    }

    /*
     * Ensure the proxy actually belongs to the object graph the base handler
     * represents.
     */
    if (!this.membrane.map.has(oldProxy)) {
      throw new Error("This membrane does not own the proxy!");
    }

    let map = this.membrane.map.get(oldProxy), cachedProxy, cachedField;
    if (baseHandler === Reflect) {
      cachedField = map.originField;
    }
    else {
      cachedField = baseHandler.fieldName;
      if (cachedField == map.originField)
        throw new Error("You must replace original values with either Reflect or a ChainHandler inheriting from Reflect");
    }

    cachedProxy = map.getProxy(cachedField);
    if (cachedProxy != oldProxy)
      throw new Error("You cannot replace the proxy with a handler from a different object graph!");

    // Finally, do the actual proxy replacement.
    let original = map.getOriginal(), shadowTarget;
    if (baseHandler === Reflect) {
      shadowTarget = original;
    }
    else {
      shadowTarget = map.getShadowTarget(cachedField);
    }
    let parts = Proxy.revocable(shadowTarget, handler);
    parts.value = original;
    parts.override = true;
    parts.shadowTarget = shadowTarget;
    //parts.extendedHandler = handler;
    map.set(this.membrane, cachedField, parts);
    makeRevokeDeleteRefs(parts, map, cachedField);

    let gHandler = this.membrane.getHandlerByName(cachedField);
    gHandler.addRevocable(map.originField === cachedField ? map : parts.revoke);
    return parts.proxy;
  }

  /**
   * Ensure that the proxy passed in matches the object graph handler.
   *
   * @param fieldName  {Symbol|String} The handler's field name.
   * @param proxy      {Proxy}  The value to look up.
   * @param methodName {String} The calling function's name.
   * 
   * @private
   */
  assertLocalProxy(fieldName, proxy, methodName) {
    let [found, match] = this.membrane.getMembraneProxy(fieldName, proxy);
    if (!found || (proxy !== match)) {
      throw new Error(methodName + " requires a known proxy!");
    }
  }

  /**
   * Require that new properties be stored via the proxies instead of propagated
   * through to the underlying object.
   *
   * @param fieldName {Symbol|String} The field name of the object graph handler
   *                                  the proxy uses.
   * @param proxy     {Proxy}  The proxy (or underlying object) needing local
   *                           property protection.
   */
  storeUnknownAsLocal(fieldName, proxy) {
    this.assertLocalProxy(fieldName, proxy, "storeUnknownAsLocal");

    let metadata = this.membrane.map.get(proxy);
    metadata.setLocalFlag(fieldName, "storeUnknownAsLocal", true);
  }

  /**
   * Require that properties be deleted only on the proxy instead of propagated
   * through to the underlying object.
   *
   * @param fieldName {Symbol|String} The field name of the object graph handler
   *                                  the proxy uses.
   * @param proxy     {Proxy}  The proxy (or underlying object) needing local
   *                           property protection.
   */
  requireLocalDelete(fieldName, proxy) {
    this.assertLocalProxy(fieldName, proxy, "requireLocalDelete");

    let metadata = this.membrane.map.get(proxy);
    metadata.setLocalFlag(fieldName, "requireLocalDelete", true);
  }

  /**
   * Apply a filter to the original list of own property names from an
   * underlying object.
   *
   * @note Local properties and local delete operations of a proxy are NOT
   * affected by the filters.
   * 
   * @param fieldName {Symbol|String} The field name of the object graph handler
   *                                  the proxy uses.
   * @param proxy     {Proxy}    The proxy (or underlying object) needing local
   *                             property protection.
   * @param filter    {Function} The filtering function.  (May be an Array or
   *                             a Set, which becomes a whitelist filter.)
   * @see Array.prototype.filter.
   */
  filterOwnKeys(fieldName, proxy, filter) {
    this.assertLocalProxy(fieldName, proxy, "filterOwnKeys");

    if (Array.isArray(filter)) {
      filter = new Set(filter);
    }

    if (filter instanceof Set) {
      const s = filter;
      filter = (key) => s.has(key);
    }

    if ((typeof filter !== "function") && (filter !== null))
      throw new Error("filterOwnKeys must be a filter function, array or Set!");

    /* Defining a filter after a proxy's shadow target is not extensible
     * guarantees inconsistency.  So we must disallow that possibility.
     *
     * Note that if the proxy becomes not extensible after setting a filter,
     * that's all right.  When the proxy becomes not extensible, it then sets
     * all the proxies of the shadow target before making the shadow target not
     * extensible.
     */
    let metadata = this.membrane.map.get(proxy);
    let fieldsToCheck;
    if (metadata.originField === fieldName)
    {
      fieldsToCheck = Reflect.ownKeys(metadata.proxiedFields);
      fieldsToCheck.splice(fieldsToCheck.indexOf(fieldName), 1);
    }
    else
      fieldsToCheck = [ fieldName ];

    let allowed = fieldsToCheck.every(function(f) {
      let s = metadata.getShadowTarget(f);
      return Reflect.isExtensible(s);
    });

    if (allowed)
      metadata.setOwnKeysFilter(fieldName, filter);
    else
      throw new Error("filterOwnKeys cannot apply to a non-extensible proxy");
  }

  /**
   * Assign the number of arguments to truncate a method's argument list to.
   *
   * @param fieldName {Symbol|String} The field name of the object graph handler
   *                                  the proxy uses.
   * @param proxy     {Proxy(Function)} The method needing argument truncation.
   * @param value     {Boolean|Number}
   *   - if true, limit to a function's arity.
   *   - if false, do not limit at all.
   *   - if a non-negative integer, limit to that number.
   */
  truncateArgList(fieldName, proxy, value) {
    this.assertLocalProxy(fieldName, proxy, "truncateArgList");
    if (typeof proxy !== "function")
      throw new Error("proxy must be a function!");
    {
      const type = typeof value;
      if (type === "number") {
        if (!Number.isInteger(value) || (value < 0)) {
          throw new Error("value must be a non-negative integer or a boolean!");
        }
      }
      else if (type !== "boolean") {
        throw new Error("value must be a non-negative integer or a boolean!");
      }
    }

    let metadata = this.membrane.map.get(proxy);
    metadata.setTruncateArgList(fieldName, value);
  }

  /**
   * Disable traps for a given proxy.
   *
   * @param fieldName {String}   The name of the object graph the proxy is part
   *                             of.
   * @param proxy     {Proxy}    The proxy to affect.
   * @param trapList  {String[]} A list of proxy (Reflect) traps to disable.
   */
  disableTraps(fieldName, proxy, trapList) {
    this.assertLocalProxy(fieldName, proxy, "disableTraps");
    if (!Array.isArray(trapList) ||
        (trapList.some((t) => { return typeof t !== "string"; })))
      throw new Error("Trap list must be an array of strings!");
    const map = this.membrane.map.get(proxy);
    trapList.forEach(function(t) {
      if (allTraps.includes(t))
        this.setLocalFlag(fieldName, `disableTrap(${t})`, true);
    }, map);
  }

  createDistortionsListener() {
    return new DistortionsListener(this.membrane);
  }
}
Object.seal(ModifyRulesAPI);

// temporary
const MembraneProxyHandlers = {
  Master: function() {}
};

/**
 * @package
 */
class ObjectGraph {
  constructor(membrane, graphName) {
    {
      let t = typeof graphName;
      if ((t != "string") && (t != "symbol"))
        throw new Error("field must be a string or a symbol!");
    }

    var passThroughFilter = returnFalse;

    Object.defineProperties(this, {
      "membrane": new NWNCDataDescriptor(membrane, true),
      "graphName": new NWNCDataDescriptor(graphName, true),

      // private
      "masterProxyHandler": new NWNCDataDescriptor(
        new MembraneProxyHandlers.Master(this), false
      ),

      "passThroughFilter": {
        get: () => passThroughFilter,
        set: (val) => {
          if (passThroughFilter !== returnFalse)
            throw new Error("passThroughFilter has been defined once already!");
          if (typeof val !== "function")
            throw new Error("passThroughFilter must be a function");
          passThroughFilter = val;
        },
        enumerable: false,
        configurable: false,
      },

      "mayReplacePassThrough": {
        get: () => passThroughFilter === returnFalse,
        enumerable: true,
        configurable: false
      },

      // private
      "__revokeFunctions__": new NWNCDataDescriptor([], false),

      // private
      "__isDead__": new DataDescriptor(false, true, true, true),

      // private
      "__proxyListeners__": new NWNCDataDescriptor([], false),
    });
  }

  /**
   * Insert a ProxyHandler into our sequence.
   *
   * @param {String} phase         The phase to insert the handler in.
   * @param {String} leadNodeName  The name of the current linked list node in the given phase.
   * @param {MembraneProxyHandlers.LinkedListNode} middleNode
   *                     The node to insert.
   * @param {?Object} insertTarget The shadow target to set for a redirect.
   *                     Null if for all shadow targets in general.
   */
  insertHandler(
    phase, leadNodeName, middleNode, insertTarget = null
  )
  {
    const subHandler = this.masterProxyHandler.getNodeByName(phase);
    if (!subHandler)
      throw new Error("Phase for proxy handler does not exist");
    subHandler.insertNode(leadNodeName, middleNode, insertTarget);
  }

  /**
   * Add a ProxyMapping or a Proxy.revoke function to our list.
   *
   * @private
   */
  addRevocable(revoke) {
    if (this.__isDead__)
      throw new Error("This membrane handler is dead!");
    this.__revokeFunctions__.push(revoke);
  }

  /**
   * Remove a ProxyMapping or a Proxy.revoke function from our list.
   *
   * @private
   */
  removeRevocable(revoke) {
    let index = this.__revokeFunctions__.indexOf(revoke);
    if (index == -1) {
      throw new Error("Unknown revoke function!");
    }
    this.__revokeFunctions__.splice(index, 1);
  }

  /**
   * Revoke the entire object graph.
   */
  revokeEverything() {
    if (this.__isDead__)
      throw new Error("This membrane handler is dead!");
    Object.defineProperty(this, "__isDead__", new NWNCDataDescriptor(true, false));
    let length = this.__revokeFunctions__.length;
    for (var i = 0; i < length; i++) {
      let revocable = this.__revokeFunctions__[i];
      if (revocable instanceof ProxyCylinder)
        revocable.revoke(this.membrane);
      else // typeof revocable == "function"
        revocable();
    }
  }
}

Object.freeze(ObjectGraph.prototype);
Object.freeze(ObjectGraph);

/** @module source/core/WeakMapOfProxyCylinders */

/**
 * Redefine methods on a weak map.
 * @param {WeakMap} map The weak map.
 * @package
 */
function WeakMapOfProxyCylinders(map) {
  Reflect.defineProperty(
    map,
    "set",
    new NWNCDataDescriptor(WeakMapOfProxyCylinders.set.bind(map, map.set))
  );
  Reflect.defineProperty(
    map,
    "revoke",
    new NWNCDataDescriptor(WeakMapOfProxyCylinders.revoke)
  );
}

WeakMapOfProxyCylinders.set = function(_set, key, value) {
  if (value !== DeadProxyKey) {
    const current = this.get(key);
    if (current === DeadProxyKey)
      throw new Error("WeakMapOfProxyCylinders says this key is dead");

    // XXX ajvincent there shouldn't be a typeof check here, we must import ProxyMapping
    // eslint-disable-next-line no-undef
    else if ((typeof ProxyMapping === "function") && !(value instanceof ProxyMapping))
      throw new Error("WeakMapOfProxyCylinders only allows values of .Dead or ProxyMapping");
    if ((current !== undefined) && (current !== value))
      throw new Error("WeakMapOfProxyCylinders already has a value for this key");
  }
  return _set.apply(this, [key, value]);
};

WeakMapOfProxyCylinders.revoke = function(key) {
  this.set(key, DeadProxyKey);
};

Object.freeze(WeakMapOfProxyCylinders);

const Constants = {
  warnings: {
    FILTERED_KEYS_WITHOUT_LOCAL: "Filtering own keys without allowing local property defines or deletes is dangerous",
    PROTOTYPE_FILTER_MISSING: "Proxy filter specified to inherit from prototype, but prototype provides no filter",
  }
};

Object.freeze(Constants.warnings);
Object.freeze(Constants);


/**
 * Helper function to determine if anyone may log.
 * @private
 *
 * @returns {Boolean} True if logging is permitted.
 */
// This function is here because I can blacklist moduleUtilities during debugging.
function MembraneMayLog() {
  return (typeof this.logger == "object") && Boolean(this.logger);
}


/* Reference:  http://soft.vub.ac.be/~tvcutsem/invokedynamic/js-membranes
 * Definitions:
 * Object graph: A collection of values that talk to each other directly.
 */

class Membrane {
  /**
   * 
   * @param {Object} options
   */
  constructor(options = {}) {
    let passThrough = (typeof options.passThroughFilter === "function") ?
                      options.passThroughFilter :
                      returnFalse;
  
    let map = new WeakMap(/*
      key: ProxyCylinder instance
  
      key may be a Proxy, a value associated with a proxy, or an original value.
    */);
    WeakMapOfProxyCylinders(map);

    Object.defineProperties(this, {
      "showGraphName": new NWNCDataDescriptor(
        Boolean(options.showGraphName), false
      ),
  
      "refactor": new NWNCDataDescriptor(options.refactor || "", false),
  
      "map": new NWNCDataDescriptor(map, false),
  
      "handlersByFieldName": new NWNCDataDescriptor({}, false),
  
      "logger": new NWNCDataDescriptor(options.logger || null, false),
  
      "__functionListeners__": new NWNCDataDescriptor([], false),
  
      "warnOnceSet": new NWNCDataDescriptor(
        (options.logger ? new Set() : null), false
      ),
  
      "modifyRules": new NWNCDataDescriptor(new ModifyRulesAPI(this)),
  
      "passThroughFilter": new NWNCDataDescriptor(passThrough, false)
    });
  
    /* XXX ajvincent Somehow adding this line breaks not only npm test, but the
       ability to build as well.  The breakage comes in trying to create a mock of
       a dogfood membrane.
    Object.seal(this);
    */
  }

  /**
   * Returns true if we have a proxy for the value.
   */
  hasProxyForValue(graph, value) {
    var mapping = this.map.get(value);
    return Boolean(mapping) && mapping.hasGraph(graph);
  }

  /**
   * Get the value associated with a graph name and another known value.
   *
   * @param {Symbol|String} graph The graph to look for.
   * @param {Variant}       value The key for the ProxyCylinder map.
   *
   * @returns [
   *    {Boolean} True if the value was found.
   *    {Variant} The value for that graph.
   * ]
   *
   * @note This method is not used internally in the membrane, but only by debug
   * code to assert that we have the right values stored.  Therefore you really
   * shouldn't use it in Production.
   */
  getMembraneValue(graph, value) {
    var mapping = this.map.get(value);
    if (mapping && mapping.hasGraph(graph)) {
      return [true, mapping.getValue(graph)];
    }
    return [false, NOT_YET_DETERMINED];
  }

  /**
   * Get the proxy associated with a graph name and another known value.
   *
   * @param {Symbol|String} graph The graph to look for.
   * @param {Variant}       value The key for the ProxyCylinder map.
   *
   * @returns [
   *    {Boolean} True if the value was found.
   *    {Proxy}   The proxy for that graph.
   * ] if graph is not the value's origin graph
   * 
   * @returns [
   *    {Boolean} True if the value was found.
   *    {Variant} The actual value
   * ] if graph is the value's origin graph
   *
   * @returns [
   *    {Boolean} False if the value was not found.
   *    {Object}  NOT_YET_DETERMINED
   * ]
   */
  getMembraneProxy(graph, value) {
    var mapping = this.map.get(value);
    if (mapping && mapping.hasGraph(graph)) {
      return [true, mapping.getProxy(graph)];
    }
    return [false, NOT_YET_DETERMINED];
  }

  /**
   * Assign a value to an object graph.
   *
   * @param handler {ObjectGraphHandler} A graph handler to bind to the value.
   * @param value   {Variant} The value to assign.
   *
   * Options:
   *   @param {ProxyCylinder} mapping  A mapping with associated values and proxies.
   *
   * @returns {ProxyCylinder} A mapping holding the value.
   *
   * @private
   */
  buildMapping(handler, value, options = {}) {
    if (!this.ownsHandler(handler))
      throw new Error("handler is not an ObjectGraphHandler we own!");
    let mapping = ("mapping" in options) ? options.mapping : null;

    const graphKey = (this.refactor === "0.10") ? "graphName" : "graphName";

    if (!mapping) {
      if (this.map.has(value)) {
        mapping = this.map.get(value);
      }

      else {
        mapping = new ProxyCylinder(handler[graphKey]);
      }
    }
    assert(mapping instanceof ProxyCylinder,
           "buildMapping requires a ProxyCylinder object!");

    const isOriginal = (mapping.originField === handler[graphKey]);
    assert(isOriginal || this.ownsHandler(options.originHandler),
           "Proxy requests must pass in an origin handler");
    let shadowTarget = makeShadowTarget(value);

    var parts;
    if (isOriginal) {
      parts = { value: value };
      if (!Reflect.isExtensible(value)) {
        const keys = Reflect.ownKeys(value);
        keys.forEach(function(key) {
          const desc = Reflect.getOwnPropertyDescriptor(value, key);
          Reflect.defineProperty(shadowTarget, key, desc);
        });
        Reflect.preventExtensions(shadowTarget);
      }
    }
    else {
      if (handler instanceof ObjectGraph)
        parts = Proxy.revocable(shadowTarget, handler.masterProxyHandler);
      else
        parts = Proxy.revocable(shadowTarget, handler);
      parts.value = value;
    }

    parts.shadowTarget = shadowTarget;
    mapping.set(this, handler[graphKey], parts);
    makeRevokeDeleteRefs(parts, mapping, handler[graphKey]);

    if (!isOriginal) {
      const notifyOptions = {
        isThis: false,
        originHandler: options.originHandler,
        targetHandler: handler,
      };
      ["trapName", "callable", "isThis", "argIndex"].forEach(function(propName) {
        if (Reflect.has(options, propName))
          notifyOptions[propName] = options[propName];
      });
      
      ProxyNotify(parts, options.originHandler, true, notifyOptions);
      ProxyNotify(parts, handler, false, notifyOptions);

      if (!Reflect.isExtensible(value)) {
        try {
          Reflect.preventExtensions(parts.proxy);
        }
        catch (e) {
          // do nothing
        }
      }
    }

    handler.addRevocable(isOriginal ? mapping : parts.revoke);
    return mapping;
  }

  /**
   *
   * @param {Symbol|String} graph The graph to look for.
   *
   * @returns {Boolean}
   */
  hasHandlerByField(graph) {
    {
      let t = typeof graph;
      if ((t != "string") && (t != "symbol"))
        throw new Error("graph must be a string or a symbol!");
    }
    return Reflect.ownKeys(this.handlersByFieldName).includes(graph);
  }

  /**
   * Get an ObjectGraphHandler object by graph name.  Build it if necessary.
   *
   * @param {Symbol|String} graph   The graph name for the object graph.
   * @param {Object}        options Broken down as follows:
   * - {Boolean} mustCreate  True if we must create a missing graph handler.
   *
   * @returns {ObjectGraphHandler} The handler for the object graph.
   */
  getHandlerByName(graph, options) {
    if (typeof options === "boolean")
      throw new Error("fix me!");
    let mustCreate = (typeof options == "object") ?
                     Boolean(options.mustCreate) :
                     false;
    if (mustCreate && !this.hasHandlerByField(graph)) {
      let graph = null;
      if (this.refactor === "0.10")
        graph = new ObjectGraph(this, graph);
      else
        graph = new ObjectGraphHandler(this, graph);
      this.handlersByFieldName[graph] = graph;
    }
    return this.handlersByFieldName[graph];
  }

  /**
   * Determine if the handler is a ObjectGraphHandler for this object graph.
   *
   * @returns {Boolean} True if the handler is one we own.
   */
  ownsHandler(handler) {
    if (handler instanceof ObjectGraph) {
      return this.handlersByFieldName[handler.graphName] === handler;
    }
    if (ChainHandlers.has(handler))
      handler = handler.baseHandler;
    return ((handler instanceof ObjectGraphHandler) &&
            (this.handlersByFieldName[handler.graphName] === handler));
  }

  /**
   * Wrap a value for the first time in an object graph.
   *
   * @param {ProxyCylinder} mapping A mapping whose origin graph refers to the value's object graph.
   * @param {Variant}       arg     The value to wrap.
   *
   * @note This marks the value as the "original" in the new ProxyCylinder it
   * creates.
   */
  wrapArgumentByProxyCylinder(mapping, arg, options = {}) {
    if (this.map.has(arg) || (valueType(arg) === "primitive"))
      return;

    let handler = this.getHandlerByName(mapping.originField);
    this.buildMapping(handler, arg, options);
    
    assert(this.map.has(arg),
           "wrapArgumentByProxyCylinder should define a ProxyCylinder for arg");
    let argMap = this.map.get(arg);
    assert(argMap instanceof ProxyCylinder, "argMap isn't a ProxyCylinder?");
    assert(argMap.getOriginal() === arg,
           "wrapArgumentByProxyCylinder didn't establish the original?");
  }

  /**
   *
   */
  passThroughFilter() {
    return false;
  }

  /**
   * Ensure an argument is properly wrapped in a proxy.
   *
   * @param {ObjectGraphHandler} origin  Where the argument originated from
   * @param {ObjectGraphHandler} target  The object graph we're returning the arg to.
   * @param {Variant}            arg     The argument.
   *
   * @returns {Proxy}   The proxy for that graph
   *   if graph is not the value's origin graph
   * 
   * @returns {Variant} The actual value
   *   if graph is the value's origin graph
   *
   * @throws {Error} if failed (this really should never happen)
   */
  convertArgumentToProxy (originHandler, targetHandler, arg, options = {}) {
    var override = ("override" in options) && (options.override === true);
    if (override) {
      let map = this.map.get(arg);
      if (map) {
        map.selfDestruct(this);
      }
    }

    if (valueType(arg) === "primitive") {
      return arg;
    }

    const graphKey = (this.refactor === "0.10") ? "graphName" : "graphName";

    let found, rv;
    [found, rv] = this.getMembraneProxy(
      targetHandler[graphKey], arg
    );
    if (found)
      return rv;

    if (!this.ownsHandler(originHandler) ||
        !this.ownsHandler(targetHandler) ||
        (originHandler[graphKey] === targetHandler[graphKey]))
      throw new Error("convertArgumentToProxy requires two different ObjectGraphHandlers in the Membrane instance");

    if (this.passThroughFilter(arg) ||
        (originHandler.passThroughFilter(arg) && targetHandler.passThroughFilter(arg))) {
      return arg;
    }

    if (!this.hasProxyForValue(originHandler[graphKey], arg)) {
      let argMap = this.map.get(arg);
      let passOptions;
      if (argMap) {
        passOptions = Object.create(options, {
          "mapping": new DataDescriptor(argMap)
        });
      }
      else
        passOptions = options;

      this.buildMapping(originHandler, arg, passOptions);
    }
    
    if (!this.hasProxyForValue(targetHandler[graphKey], arg)) {
      let argMap = this.map.get(arg);
      let passOptions = Object.create(options, {
        "originHandler": new DataDescriptor(originHandler)
      });
      assert(argMap, "ProxyCylinder not created before invoking target handler?");

      Reflect.defineProperty(
        passOptions, "mapping", new DataDescriptor(argMap)
      );

      this.buildMapping(targetHandler, arg, passOptions);
    }

    [found, rv] = this.getMembraneProxy(
      targetHandler[graphKey], arg
    );
    if (!found)
      throw new Error("in convertArgumentToProxy(): proxy not found");
    return rv;
  }

  /**
   * Link two values together across object graphs.
   *
   * @param {ObjectGraphHandler} handler0  The graph handler that should own value0.
   * @param {Object}             value0    The first value to store.
   * @param {ObjectGraphHandler} handler1  The graph handler that should own value1.
   * @param {Variant}            value1    The second value to store.
   */
  bindValuesByHandlers(handler0, value0, handler1, value1) {
    /** XXX ajvincent The logic here is convoluted, I admit.  Basically, if we
     * succeed:
     * handler0 must own value0
     * handler1 must own value1
     * the ProxyCylinder instances for value0 and value1 must be the same
     * there must be no collisions between any properties of the ProxyCylinder
     *
     * If we fail, there must be no side-effects.
     */
    function bag(h, v) {
      if (!this.ownsHandler(h))
        throw new Error("bindValuesByHandlers requires two ObjectGraphHandlers from different graphs");
      let rv = {
        handler: h,
        value: v,
        type: valueType(v),
      };
      if (rv.type !== "primitive") {
        rv.proxyMap = this.map.get(v);
        const graph = rv.handler.graphName;
        const valid = (!rv.proxyMap ||
                        (rv.proxyMap.hasGraph(graph) &&
                        (rv.proxyMap.getProxy(graph) === v)));
        if (!valid)
          throw new Error("Value argument does not belong to proposed ObjectGraphHandler");
      }

      return rv;
    }

    function checkField(bag) {
      if (proxyMap.hasGraph(bag.handler.graphName)) {
        let check = proxyMap.getProxy(bag.handler.graphName);
        if (check !== bag.value)
          throw new Error("Value argument does not belong to proposed object graph");
        bag.maySet = false;
      }
      else
        bag.maySet = true;
    }

    function applyBag(bag) {
      if (!bag.maySet)
        return;
      let parts = { proxy: bag.value };
      if (proxyMap.originField === bag.handler.graphName)
        parts.value = bag.value;
      else
        parts.value = proxyMap.getOriginal();
      proxyMap.set(this, bag.handler.graphName, parts);
    }

    var propBag0 = bag.apply(this, [handler0, value0]);
    var propBag1 = bag.apply(this, [handler1, value1]);
    var proxyMap = propBag0.proxyMap;

    if (propBag0.type === "primitive") {
      if (propBag1.type === "primitive") {
        throw new Error("bindValuesByHandlers requires two non-primitive values");
      }

      proxyMap = propBag1.proxyMap;

      let temp = propBag0;
      propBag0 = propBag1;
      propBag1 = temp;
    }

    if (propBag0.proxyMap && propBag1.proxyMap) {
      if (propBag0.proxyMap !== propBag1.proxyMap) {
        // See https://github.com/ajvincent/es-membrane/issues/77 .
        throw new Error("Linking two ObjectGraphHandlers in this way is not safe.");
      }
    }
    else if (!propBag0.proxyMap) {
      if (!propBag1.proxyMap) {
        proxyMap = new ProxyCylinder(propBag0.handler.graphName);
      }
      else
        proxyMap = propBag1.proxyMap;
    }

    checkField(propBag0);
    checkField(propBag1);

    if (propBag0.handler.graphName === propBag1.handler.graphName) {
      if (propBag0.value !== propBag1.value)
        throw new Error("bindValuesByHandlers requires two ObjectGraphHandlers from different graphs");
      // no-op
      propBag0.maySet = false;
      propBag1.maySet = false;
    }

    applyBag.apply(this, [propBag0]);
    applyBag.apply(this, [propBag1]);

    // Postconditions
    if (propBag0.type !== "primitive") {
      let [found, check] = this.getMembraneProxy(propBag0.handler.graphName, propBag0.value);
      assert(found, "value0 mapping not found?");
      assert(check === propBag0.value, "value0 not found in handler0 graph name?");

      [found, check] = this.getMembraneProxy(propBag1.handler.graphName, propBag0.value);
      assert(found, "value0 mapping not found?");
      assert(check === propBag1.value, "value0 not found in handler0 graph name?");
    }

    if (propBag1.type !== "primitive") {
      let [found, check] = this.getMembraneProxy(propBag0.handler.graphName, propBag1.value);
      assert(found, "value1 mapping not found?");
      assert(check === propBag0.value, "value0 not found in handler0 graph name?");

      [found, check] = this.getMembraneProxy(propBag1.handler.graphName, propBag1.value);
      assert(found, "value1 mapping not found?");
      assert(check === propBag1.value, "value1 not found in handler1 graph name?");
    }
  }

  /**
   * Wrap the methods of a descriptor in an object graph.
   *
   * @package
   */
  wrapDescriptor(originField, targetField, desc) {
    if (!desc)
      return desc;

    // XXX ajvincent This optimization may need to go away for wrapping primitives.
    if (isDataDescriptor(desc) && (valueType(desc.value) === "primitive"))
      return desc;

    var keys = Object.keys(desc);

    var wrappedDesc = {
      configurable: Boolean(desc.configurable)
    };
    if ("enumerable" in desc)
      wrappedDesc.enumerable = Boolean(desc.enumerable);
    if (keys.includes("writable")) {
      wrappedDesc.writable = Boolean(desc.writable);
      if (!wrappedDesc.configurable && !wrappedDesc.writable)
        return desc;
    }

    var originHandler = this.getHandlerByName(originField);
    var targetHandler = this.getHandlerByName(targetField);

    ["value", "get", "set"].forEach(function(descProp) {
      if (keys.includes(descProp))
        wrappedDesc[descProp] = this.convertArgumentToProxy(
          originHandler,
          targetHandler,
          desc[descProp]
        );
    }, this);

    return wrappedDesc;
  }

  /**
   * 
   * @param key
   */
  revokeMapping(key) {
    this.map.revoke(key);
  }

  /**
   * Add a listener for function entry, return and throw operations.
   *
   * @param {Function} listener The listener to add.
   *
   * @see ObjectGraphHandler.prototype.notifyFunctionListeners for what each
   * listener will get for its arguments.
   */
  addFunctionListener(listener) {
    if (typeof listener != "function")
      throw new Error("listener is not a function!");
    if (!this.__functionListeners__.includes(listener))
      this.__functionListeners__.push(listener);
  }

  /**
   * Add a listener for function entry, return and throw operations.
   *
   * @param {Function} listener The listener to remove.
   */
  removeFunctionListener(listener) {
    let index = this.__functionListeners__.indexOf(listener);
    if (index == -1)
      throw new Error("listener is not registered!");
    this.__functionListeners__.splice(index, 1);
  }

  /**
   *
   * @param {string} message
   */
  warnOnce(message) {
    if (this.logger && !this.warnOnceSet.has(message)) {
      this.warnOnceSet.add(message);
      this.logger.warn(message);
    }
  }
}

Reflect.defineProperty(
  Membrane,
  "Primordials",
  new NWNCDataDescriptor(Primordials, true) // this should be visible
);

Membrane.prototype.allTraps = allTraps;

/**
 * A flag indicating if internal properties of the Membrane are private.
 *
 * @public
 */
Membrane.prototype.secured = false;

Membrane.prototype.__mayLog__ = MembraneMayLog;

Membrane.prototype.constants = Constants;

Object.seal(Membrane);

export default Membrane;