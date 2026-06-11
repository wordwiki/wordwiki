/**
 * @lazy - a (stage 3) decorator that caches a getter's value on first read.
 *
 *   class App {
 *       @lazy get tables() { return [this.config, this.users, ...]; }
 *   }
 *
 * Semantics:
 *  - the getter body runs at most once per instance (per property); later
 *    reads return the cached value, including a cached `undefined`;
 *  - if the getter throws, nothing is cached and the next read retries;
 *  - caches are per-instance (held in a WeakMap keyed on `this`, so they
 *    are GC'd with the instance and never shared between instances);
 *  - no invalidation: @lazy asserts the value is stable for the life of
 *    the instance.  Don't use it for getters over mutable state.
 */
const lazyValues = new WeakMap<object, Map<string | symbol, unknown>>();

export function lazy<This extends object, T>(
    target: (this: This) => T,
    context: ClassGetterDecoratorContext<This, T>): (this: This) => T {

    // A getter decorator on anything else (a method, say) would silently
    // misbehave: the wrapper calls the body with no arguments and caches
    // the first result forever.
    if (context.kind !== 'getter')
        throw new Error(`@lazy can only decorate getters (got ${context.kind} ${String(context.name)})`);

    const propertyKey = context.name;

    return function (this: This): T {

        let objectCache = lazyValues.get(this);
        if (!objectCache) {
            objectCache = new Map();
            lazyValues.set(this, objectCache);
        }

        // get-then-has: one lookup on the hot path, with the has() fallback
        // so a cached `undefined` is still a hit.
        const existingProp = objectCache.get(propertyKey);
        if (existingProp !== undefined || objectCache.has(propertyKey))
            return existingProp as T;

        const prop = target.call(this);
        objectCache.set(propertyKey, prop);
        return prop;
    };
}
