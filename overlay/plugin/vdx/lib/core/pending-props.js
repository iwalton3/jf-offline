/**
 * Values handed to an element by a template BEFORE its component class was
 * registered.
 *
 * A lazy `import()` that registers a component after its call site has already
 * rendered is ordinary, not exotic - see tests/framework/registration-timing.test.js
 * for the contract: identical markup either side of registration must behave
 * identically. The obstacle is transport. An attribute can only carry a string,
 * so routing props through one delivered `"1"` where the template said `${1}`,
 * `"[object Object]"` for an object, and nothing at all for `${false}`.
 *
 * A WeakMap, deliberately, and NOT an own property on the element: an own
 * property shadows the prototype accessor that defineComponent installs,
 * permanently, so every later `el.count = x` would write the expando and the
 * prop would never update again. Nothing removes it. Keying off to the side has
 * none of that, and the entry dies with the element.
 */

const pending = new WeakMap();

/**
 * Record what a template handed this element under `name`.
 *
 * `undefined` records nothing and clears any earlier value: it means "not
 * provided", so the prop must fall back to its declared default - the same
 * thing an omitted attribute does.
 */
export function recordPendingProp(el, name, value) {
    let map = pending.get(el);
    if (value === undefined) {
        if (map) map.delete(name);
        return;
    }
    if (!map) pending.set(el, map = new Map());
    map.set(name, value);
}

/**
 * Read and consume everything recorded for this element.
 *
 * Consumed, not peeked: these values belong to the upgrade they were recorded
 * for. Leaving them would let a reconnect resurrect the original value over
 * whatever the component has been assigned since.
 */
export function takePendingProps(el) {
    const map = pending.get(el);
    if (map) pending.delete(el);
    return map;
}
