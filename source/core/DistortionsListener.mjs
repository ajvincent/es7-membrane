import {
  Primordials,
  allTraps,
  defineNWNCProperties,
} from "./sharedUtilities.mjs";

/**
 * @package
 */
export default class DistortionsListener {
  constructor(membrane) {
    // private
    defineNWNCProperties(this, {
      membrane,
      proxyListener: this.proxyListener.bind(this),
      valueAndProtoMap: new Map(/*
        object or function.prototype: JSON configuration
      */),

      instanceMap: new Map(/*
          function: JSON configuration
      */),

      filterToConfigMap: new Map(/*
        function returning boolean: JSON configuration
      */),

      ignorableValues: new Set(),
    }, false);
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
    const graphName = meta.handler.graphName;
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
        graphName,
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
    rules.disableTraps(graphName, modifyTarget, deadTraps);

    if (config.storeUnknownAsLocal)
      rules.storeUnknownAsLocal(graphName, modifyTarget);

    if (config.requireLocalDelete)
      rules.requireLocalDelete(graphName, modifyTarget);

    if (("truncateArgList" in config) && (config.truncateArgList !== false))
      rules.truncateArgList(graphName, modifyTarget, config.truncateArgList);
  }

  /**
   * @private
   */
  proxyListener(meta) {
    const config = this.getConfigurationForListener(meta);
    if (config)
      this.applyConfiguration(config, meta);

    meta.stopIteration();
  }

  passThroughFilter(value) {
    return this.ignorableValues.has(value);
  }
}

Object.freeze(DistortionsListener);
Object.freeze(DistortionsListener.prototype);
