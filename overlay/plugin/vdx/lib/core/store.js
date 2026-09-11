/**
 * Store System
 * Simple reactive stores with subscription support
 */

import { reactive, createEffect, computed, withoutTracking } from './reactivity.js';
import { DANGEROUS_KEYS } from './constants.js';

/**
 * Brand marking Store instances. Symbol.for() (a global registry key) is used
 * instead of instanceof so the check survives across multiple bundle copies of
 * the framework - two `class Store` definitions from different bundles fail an
 * instanceof check but share this brand.
 * @type {symbol}
 */
export const STORE_BRAND = Symbol.for('vdx.store');

/**
 * Filter an object to remove dangerous keys that could pollute prototypes.
 * @param {Object} obj - Object to filter
 * @returns {Object} New object with dangerous keys removed
 */
function filterDangerousKeys(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const filtered = {};
    for (const key of Object.keys(obj)) {
        if (!DANGEROUS_KEYS.has(key)) {
            filtered[key] = obj[key];
        } else {
            console.warn(`[VDX Security] Blocked attempt to set dangerous store key: ${key}`);
        }
    }
    return filtered;
}

/**
 * Create a writable store with reactive state
 */
export function createStore(initial) {
    // Same prototype-pollution filtering as set()/update() and class Store.
    // Identity is preserved for clean seeds (the overwhelmingly common case);
    // only a seed carrying a dangerous key is shallow-copied by the filter.
    const hasDangerous = initial && typeof initial === 'object' &&
        Object.keys(initial).some(k => DANGEROUS_KEYS.has(k));
    const state = reactive(hasDangerous ? filterDangerousKeys(initial) : initial);

    return {
        get state() {
            return state;
        },

        /**
         * Subscribe to store changes.
         * Fine-grained: only re-runs when properties accessed by fn actually change.
         * Returns unsubscribe function.
         */
        subscribe(fn) {
            // Wrap subscriber in its own effect - tracks only what it accesses
            // This is fine-grained: if fn accesses state.queueIndex, it only
            // re-runs when queueIndex changes, not when currentTime changes
            const effect = createEffect(() => {
                try {
                    fn(state);
                } catch (error) {
                    console.error('Error in store subscriber:', error);
                }
            });

            return () => {
                effect.dispose();
            };
        },

        /**
         * Update store with new values.
         * Includes prototype pollution protection.
         * Note: The reactive effect automatically notifies subscribers when state changes
         */
        set(newState) {
            // SECURITY: Filter dangerous keys before assignment
            Object.assign(state, filterDangerousKeys(newState));
        },

        /**
         * Update store using updater function.
         * Includes prototype pollution protection.
         * Note: The reactive effect automatically notifies subscribers when state changes
         */
        update(updater) {
            const newState = updater(state);
            if (newState) {
                // SECURITY: Filter dangerous keys before assignment
                Object.assign(state, filterDangerousKeys(newState));
            }
        }
    };
}

// ============================================================================
// Class-based stores
// ============================================================================

/** Instance members that a state key may not shadow when promoted. */
const STORE_RESERVED_MEMBERS = new Set([
    'state', 'subscribe', 'set', 'update', 'dispose'
]);

/**
 * Base class for class-authored stores. Seed reactive state in the constructor
 * exactly like a component:
 *
 *     class CartStore extends Store {
 *         constructor() {
 *             super();
 *             this.state = { items: [], coupon: null };  // reactive
 *         }
 *         _audio = new AudioController(this);   // ordinary field: NOT reactive
 *         add(item) { this.state.items.push(item); }
 *         get total() {                          // getter -> cached computed
 *             return this.state.items.reduce((s, i) => s + i.price, 0);
 *         }
 *     }
 *     const cartStore = new CartStore();   // then export it
 *
 * `this.state = {...}` runs through an accessor: the first assignment filters
 * dangerous keys, wraps with reactive(), and PROMOTES each top-level key onto
 * the instance as a forwarding accessor (`store.items` reads/writes
 * `store.state.items`). So existing template syntax - `this.stores.cart.items`
 * - is unchanged, while methods and computed getters now hang off the same
 * object. Keys added later are reactive but not promoted (reach them via
 * `store.state.x`); declare top-level keys up front, same as components.
 *
 * Getters on the subclass become cached computeds (lazy, synchronously
 * invalidated - never stale). Methods are auto-bound to the instance. A state
 * key that would shadow an existing member (a method, a getter, subscribe,
 * set/update, state itself) throws at construction - loud and early.
 */
export class Store {
    constructor() {
        // Cross-bundle-safe brand (see STORE_BRAND).
        Object.defineProperty(this, STORE_BRAND, {
            value: true, enumerable: false, writable: false, configurable: false
        });

        // Collect getters (-> computeds) and methods (-> auto-bound) from the
        // subclass prototype chain, root-first so a subclass overrides a parent.
        // Reuses the component-class prototype-scan approach.
        const getterDescriptors = {};
        const methodNames = new Set();

        const chain = [];
        for (let C = Object.getPrototypeOf(this).constructor;
             C && C !== Store && C.prototype;
             C = Object.getPrototypeOf(C)) {
            chain.unshift(C);
        }

        for (const C of chain) {
            for (const key of Object.getOwnPropertyNames(C.prototype)) {
                if (key === 'constructor') continue;
                const desc = Object.getOwnPropertyDescriptor(C.prototype, key);
                if (desc.get) {
                    if (desc.set) {
                        console.warn(
                            `[${this.constructor.name}] Setter for "${key}" is ignored - ` +
                            'computed store getters are read-only'
                        );
                    }
                    getterDescriptors[key] = desc.get;
                    methodNames.delete(key);   // child getter overrides parent method
                } else if (typeof desc.value === 'function') {
                    methodNames.add(key);
                    delete getterDescriptors[key];  // child method overrides parent getter
                }
            }
        }

        // Auto-bind methods so `on-click="${store.add}"` works detached.
        for (const name of methodNames) {
            this[name] = this[name].bind(this);
        }

        // Internals (non-enumerable, extremely unlikely to collide with state).
        Object.defineProperty(this, '_state', {
            value: null, writable: true, enumerable: false, configurable: true
        });
        Object.defineProperty(this, '_getterDescriptors', {
            value: getterDescriptors, enumerable: false, writable: false, configurable: false
        });
        Object.defineProperty(this, '_getterNames', {
            value: new Set(Object.keys(getterDescriptors)), enumerable: false, writable: false, configurable: false
        });
        Object.defineProperty(this, '_methodNames', {
            value: methodNames, enumerable: false, writable: false, configurable: false
        });
        Object.defineProperty(this, '_computeds', {
            value: {}, enumerable: false, writable: false, configurable: false
        });
    }

    get state() {
        return this._state;
    }

    set state(value) {
        if (this._state) {
            // Subsequent assignment: merge into existing reactive state (like
            // set()). Keeps promoted accessors valid and stays reactive.
            Object.assign(this._state, filterDangerousKeys(value));
            return;
        }

        const filtered = filterDangerousKeys(value || {});
        this._state = reactive(filtered);

        // Collision safety + promotion for each declared top-level key.
        for (const key of Object.keys(filtered)) {
            if (STORE_RESERVED_MEMBERS.has(key) ||
                this._methodNames.has(key) ||
                this._getterNames.has(key) ||
                Object.prototype.hasOwnProperty.call(this, key)) {
                throw new Error(
                    `[${this.constructor.name}] State key "${key}" collides with an ` +
                    'existing store member (a method, getter, or reserved name). ' +
                    'Rename the state field or the member.'
                );
            }
            // Promote: store.key <-> store.state.key (reactive forwarding).
            Object.defineProperty(this, key, {
                get() { return this._state[key]; },
                set(v) { this._state[key] = v; },
                enumerable: true,
                configurable: true
            });
        }

        // Getters become cached computeds now that reactive state exists.
        // Created root-owned (withoutTracking) so no caller effect owns/disposes
        // them. computed() already runs synchronous invalidation (never stale).
        withoutTracking(() => {
            for (const [name, getter] of Object.entries(this._getterDescriptors)) {
                const c = computed(() => getter.call(this));
                // A getter that tracked no reactive dependency can never
                // invalidate - re-evaluate on every read instead of caching.
                if (c._depCount() === 0) {
                    c.dispose();
                    this._computeds[name] = { get: () => getter.call(this), dispose() {} };
                } else {
                    this._computeds[name] = c;
                }
                Object.defineProperty(this, name, {
                    get() { return this._computeds[name].get(); },
                    enumerable: false,
                    configurable: true
                });
            }
        });
    }

    /**
     * Detect the class-field footgun: `state = {...}` as a CLASS FIELD uses
     * [[Define]] semantics, silently shadowing this accessor and skipping the
     * reactive wrapping entirely. Throw loudly at first use instead.
     * @private
     */
    _checkFieldShadow() {
        if (this._state === null &&
            Object.prototype.hasOwnProperty.call(this, 'state')) {
            throw new Error(
                `[${this.constructor.name}] "state" was declared as a class field, ` +
                'which bypasses the reactive setter (class fields use [[Define]] ' +
                'semantics). Assign it in the constructor instead: ' +
                'constructor() { super(); this.state = {...}; }'
            );
        }
    }

    /**
     * Subscribe to store changes. Fine-grained: the callback re-runs only when
     * the state it actually reads changes. Returns an unsubscribe function.
     * @param {(store: this) => void} fn
     * @returns {() => void}
     */
    subscribe(fn) {
        this._checkFieldShadow();
        // Before the first `this.state = {...}` there is nothing reactive to
        // track: the subscriber would run once against null state and NEVER
        // fire again (installing state later doesn't retroactively wire it).
        // Fail loud at the call site instead.
        if (!this._state) {
            throw new Error(
                `[${this.constructor.name}] subscribe() called before state ` +
                'initialization - the subscriber could never fire. Assign ' +
                'this.state = {...} in the constructor (after super()) first.'
            );
        }
        const effect = createEffect(() => {
            try {
                fn(this);
            } catch (error) {
                console.error('Error in store subscriber:', error);
            }
        });
        return () => effect.dispose();
    }

    /**
     * Merge new values into state (prototype-pollution protected).
     * @param {Object} newState
     */
    set(newState) {
        this._checkFieldShadow();
        if (!this._state) { this.state = newState; return; }
        Object.assign(this._state, filterDangerousKeys(newState));
    }

    /**
     * Update state via an updater function (prototype-pollution protected).
     * @param {(state: Object) => Object|void} updater
     */
    update(updater) {
        this._checkFieldShadow();
        const next = updater(this._state);
        if (next) {
            Object.assign(this._state, filterDangerousKeys(next));
        }
    }

    /** Dispose computed getters. Rarely needed - stores are usually singletons. */
    dispose() {
        for (const c of Object.values(this._computeds)) {
            if (c && c.dispose) c.dispose();
        }
    }
}
