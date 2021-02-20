/**
 * @fileoverview
 *
 * This is to update the shadow target of a Proxy from actions by subsidiary
 * ProxyHandlers.  The intent is to make sure Proxy invariants are not violated.
 */
{

/**
 * Build a LinkedListNode for updating shadow targets to match ProxyHandler operations.
 *
 * @param objectGraph {ObjectGraph} The object graph from a Membrane.
 * @param name        {String}      The name of this particular node in the linked list.
 * @param traceLog    {String[]}    Where the tracing will be recorded.
 */
MembraneProxyHandlers.UpdateShadow = class extends MembraneProxyHandlers.LinkedListNode {
  constructor(objectGraph, name) {
    super(objectGraph, name);
    Object.freeze(this);
  }


  /**
   * ProxyHandler implementation
   */
  preventExtensions(shadowTarget) {
    const handler = this.nextHandler(shadowTarget);
    const rv = handler.preventExtensions.apply(handler, arguments);
    if (rv)
      Reflect.preventExtensions(shadowTarget);
    return rv;
  }

  defineProperty(shadowTarget) {
    const handler = this.nextHandler(shadowTarget);
    const rv = handler.defineProperty.apply(handler, arguments);
    if (rv)
      Reflect.defineProperty.apply(Reflect, arguments);
    return rv;
  }
};

}