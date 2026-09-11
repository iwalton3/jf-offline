/**
 * VDX-Web Framework - Barrel Export
 * https://github.com/iwalton3/vdx-web
 *
 * Zero-dependency reactive web framework with:
 * - Web Components based architecture
 * - Vue 3-style proxy reactivity
 * - Fine-grained reactive rendering
 * - Compile-once template system
 * - Template helpers (html, when, each, raw)
 * - Reactive stores
 */

/**
 * Framework version. Single source of truth - the bundler reads this export
 * and stamps it into every dist bundle's banner comment at build time.
 */
export const VERSION = '1.2.0';

/**
 * Define a custom element component with reactive state and template rendering
 *
 * @typedef {Object} ComponentOptions
 * @property {Object<string, any>} [props] - Reactive props with default values
 * @property {() => Object<string, any>} [data] - Function returning reactive state
 * @property {Object<string, Function>} [methods] - Component methods (auto-bound to instance)
 * @property {() => any} template - Template function returning html`` tagged template
 * @property {string} [styles] - Scoped CSS styles for component
 * @property {() => void} [mounted] - Lifecycle hook called after component is added to DOM
 * @property {() => void} [unmounted] - Lifecycle hook called before component is removed
 * @property {() => void} [afterRender] - Lifecycle hook called after each render (use sparingly)
 *
 * @param {string} name - Component tag name (must contain hyphen, e.g., 'my-component')
 * @param {ComponentOptions} options - Component configuration
 * @returns {typeof HTMLElement} Custom element class
 *
 * @example
 * defineComponent('my-counter', {
 *   props: { title: 'Counter' },
 *   data() {
 *     return { count: 0 };
 *   },
 *   methods: {
 *     increment() { this.state.count++; }
 *   },
 *   template() {
 *     return html`
 *       <div>
 *         <h1>${this.props.title}</h1>
 *         <p>Count: ${this.state.count}</p>
 *         <button on-click="increment">+1</button>
 *       </div>
 *     `;
 *   }
 * });
 */
export { defineComponent, flushRenders, flushSync } from './core/component.js';

/**
 * Base class for class-authored components. Extend it, then register with
 * defineComponent('tag-name', MyClass). At runtime `this` is the custom
 * element itself; see core/component-class.js for the authoring contract
 * (static props/stores/styles, getters as computed, constructor as data()).
 */
export { Component } from './core/component-class.js';

/**
 * Create a reactive proxy that tracks dependencies and triggers effects on change
 *
 * @template T
 * @param {T} obj - Object to make reactive
 * @returns {T} Reactive proxy of the object
 *
 * @example
 * const state = reactive({ count: 0, user: { name: 'Alice' } });
 * state.count++; // Triggers reactive effects
 * state.user.name = 'Bob'; // Deep reactivity works
 */
/**
 * Create an effect that automatically runs when its reactive dependencies change
 *
 * @param {() => void} fn - Function to run (dependencies tracked automatically)
 * @returns {{ effect: Function, dispose: () => void }} The effect and a dispose function to stop it
 *
 * @example
 * const state = reactive({ count: 0 });
 * const { dispose } = createEffect(() => {
 *   console.log('Count:', state.count);
 * });
 * state.count++; // Logs: Count: 1
 * dispose(); // Stop tracking
 */
/**
 * Track all reactive dependencies deeply in an object
 *
 * @param {Object} obj - Object to track
 * @returns {void}
 */
/**
 * Check if a value is reactive
 *
 * @param {any} value - Value to check
 * @returns {boolean} True if value is a reactive proxy
 *
 * @example
 * const state = reactive({ count: 0 });
 * isReactive(state); // true
 * isReactive({}); // false
 */
/**
 * Watch reactive dependencies and call callback when they change
 *
 * @param {() => any} fn - Function that accesses reactive values
 * @param {(newValue: any, oldValue: any) => void} callback - Callback with new and old values
 * @returns {() => void} Cleanup function
 *
 * @example
 * const state = reactive({ count: 0 });
 * watch(
 *   () => state.count,
 *   (newVal, oldVal) => console.log(`${oldVal} → ${newVal}`)
 * );
 */
/**
 * Create a computed value with automatic reactive dependency tracking.
 * The getter is lazily evaluated and cached until reactive dependencies change.
 *
 * @param {() => any} getter - Function that computes the value (dependencies are auto-tracked)
 * @returns {{ get: () => any, dispose: () => void }} Object with get() and dispose() methods
 *
 * @example
 * const state = reactive({ a: 1, b: 2 });
 * const sum = computed(() => state.a + state.b);
 * console.log(sum.get()); // 3
 * state.a = 5;
 * console.log(sum.get()); // 7 (automatically recomputed)
 * sum.dispose(); // Clean up when done
 */
/**
 * Memoize a function result based on explicit dependencies.
 * Re-runs the function only when dependencies change.
 *
 * @param {Function} fn - Function to memoize
 * @param {Function|any[]} [deps] - Function returning a dependency array,
 *     re-evaluated on every call (use this for reactive state). A static
 *     array is snapshotted once and only useful for fixed values.
 * @returns {Function} Memoized function
 *
 * @example
 * const expensiveRender = memo(() => {
 *   return html`<div>${this.state.items.length} items</div>`;
 * }, () => [this.state.items]);
 *
 * template() {
 *   return this.expensiveRender(); // Only recomputes if items changed
 * }
 */
/**
 * Mark an object as untracked to prevent deep dependency tracking.
 * Use for large data structures where you only need to detect reassignment,
 * not changes to individual properties.
 *
 * @template T
 * @param {T} obj - Object to mark as untracked
 * @returns {T} The same object with untracked marker
 *
 * @example
 * data() {
 *   return {
 *     songs: untracked([]),  // Large array - only track replacement
 *     currentIndex: 0        // Small value - track normally
 *   };
 * }
 *
 * // Reassign to trigger update:
 * this.state.songs = untracked([...this.state.songs, newSong]);
 */
/**
 * Check if an object is marked as untracked
 *
 * @param {any} obj - Object to check
 * @returns {boolean} True if object is untracked
 */
/**
 * Execute a function without tracking reactive dependencies.
 * Any state accessed during the callback won't become a dependency
 * of the current effect.
 *
 * @template T
 * @param {function(): T} fn - Callback to execute without tracking
 * @returns {T} Return value of the callback
 *
 * @example
 * createEffect(() => {
 *   // This will NOT be tracked:
 *   const data = withoutTracking(() => this.state.hugeArray);
 *   // This WILL be tracked:
 *   console.log(this.state.filter);
 * });
 */
/**
 * Flush all pending reactive effects synchronously.
 * Normally effects are batched and run via queueMicrotask. Call this when you
 * need effects to run immediately (e.g., in tests, or reading DOM after state change).
 *
 * @returns {void}
 *
 * @example
 * state.count = 5;
 * flushEffects(); // Effects run now, not on next microtask
 * console.log(document.querySelector('.count').textContent); // "5"
 */
/**
 * Resolve after the next effect flush and DOM commit complete.
 * If no flush is pending, one is scheduled - so `mutate; await nextRender()`
 * always works. Newly mounted conditional branches are present when it resolves.
 *
 * @returns {Promise<void>}
 *
 * @example
 * this.state.showPanel = true;
 * await nextRender();          // DOM updated; new branches mounted
 * this.refs.panel.scrollTop = 0;
 */
export { reactive, createEffect, createRoot, setEffectErrorHandler, trackAllDependencies, trackMutations, isReactive, watch, computed, memo, untracked, isUntracked, withoutTracking, flushEffects, nextRender, reactiveSet, reactiveMap, isReactiveCollection } from './core/reactivity.js';

/**
 * Create a versioned list: a thin reactive wrapper over a raw array. Structural
 * edits (push/splice/index writes/...) bump one reactive version cell; reads of
 * length/indices/iteration subscribe to it. Items are returned raw (no per-item
 * proxying). `.touch()` bumps manually (in-place item edits), `.replace(next)`
 * swaps wholesale (single bump), `.version` is the reactive integer.
 *
 * @template T
 * @param {T[]} [initialArray] - Backing array (used directly, not copied)
 * @returns {T[] & { touch(): void, replace(next: T[]): void, readonly version: number }}
 *
 * @example
 * state = { songs: versionedList([]) };
 * this.state.songs.push(track);   // auto version bump -> re-render / windowing refresh
 */
export { versionedList } from './core/versioned-list.js';

/**
 * Create a latest-wins async task. `run(...args)` aborts the previous run and
 * calls `fn(signal, ...args)`; `await run()` never rejects (resolves the body's
 * return value if still current, else undefined). Reactive `pending` / `error`
 * let templates track status. A task carries status, never data - commit
 * results to real state from inside the body.
 *
 * @template T
 * @param {(signal: AbortSignal, ...args: any[]) => Promise<T> | T} fn
 * @returns {{ run: (...args: any[]) => Promise<T|undefined>, cancel: () => void, pending: boolean, error: any, dispose: () => void }}
 *
 * @example
 * const search = createTask(async (signal, q) => {
 *   const r = await fetch('/api/search?q=' + q, { signal });
 *   store.state.hits = (await r.json()).hits;
 * });
 * search.run('hello');
 */
export { createTask } from './core/task.js';

/**
 * Tagged template literal for creating XSS-safe HTML templates
 *
 * @param {TemplateStringsArray} strings - Template strings
 * @param {...any} values - Interpolated values (automatically escaped)
 * @returns {Object} Compiled template structure
 *
 * @example
 * html`<div>${userInput}</div>` // Auto-escaped
 * html`<a href="${url}">Link</a>` // URL sanitized
 */
/**
 * Render trusted HTML without escaping (⚠️ use only for trusted content!)
 *
 * @param {string} htmlString - Trusted HTML string
 * @returns {Object} Raw HTML marker
 *
 * @example
 * // ✅ SAFE - Backend-generated HTML
 * raw(apiResponse.htmlContent)
 *
 * // ❌ DANGEROUS - User input
 * raw(userComment) // XSS vulnerability!
 */
/**
 * Conditional rendering helper
 *
 * @param {boolean} condition - Condition to evaluate
 * @param {any} thenValue - Value/template to return if true
 * @param {any} [elseValue] - Value/template to return if false (optional)
 * @returns {any} The appropriate value based on condition
 *
 * @example
 * when(isLoggedIn,
 *   html`<p>Welcome!</p>`,
 *   html`<p>Please log in</p>`
 * )
 */
/**
 * List rendering helper with automatic keying
 *
 * @template T
 * @param {T[]} array - Array to iterate over
 * @param {(item: T, index: number) => any} mapFn - Function that returns template for each item
 * @returns {any[]} Array of rendered templates
 *
 * @example
 * each(items, item => html`<li>${item.name}</li>`)
 * each(items, (item, index) => html`<li>${index + 1}. ${item.name}</li>`)
 */
/**
 * Async content rendering helper (like Promise.then with loading state)
 * Returns an x-await-then component that manages its own loading/resolved/error state.
 * The component automatically re-renders when the promise resolves - no manual state needed!
 *
 * @param {Promise|any} promiseOrValue - Promise to await, or immediate value
 * @param {(data: any) => any} thenFn - Function to render resolved data
 * @param {any} pendingContent - Content to show while loading
 * @param {((error: any) => any)|any} [catchFn] - Content or function for errors
 * @returns {Object} html template containing x-await-then component
 *
 * @example
 * // Render a promise held in state. Keep the promise in state (created in
 * // mounted() or a handler) - creating it inline in template() would
 * // re-fetch and flash the pending branch on every parent re-render.
 * awaitThen(
 *   this.state.userPromise,
 *   user => html`<div>${user.name}</div>`,
 *   html`<loading-spinner></loading-spinner>`,
 *   error => html`<div class="error">${error.message}</div>`
 * )
 */
export { html, raw, when, each, memoEach, createMemoCache, awaitThen, contain } from './core/template.js';

/**
 * Normalize a boolean-ish prop (`disabled`, `checked`, `open`, ...) that may
 * arrive either as literal template text or as an interpolated JS value.
 * See boolProp in core/constants.js for the exact rule.
 */
export { boolProp } from './core/constants.js';

/**
 * Conditionally PRUNE the template compilation cache: least-recently-used
 * entries are evicted only when the cache has grown past half its cap.
 * Usually a no-op - to actually reset all compiled templates (e.g. in
 * tests), use clearTemplateCache().
 *
 * @returns {void}
 */
export { pruneTemplateCache, clearTemplateCache } from './core/template-compiler.js';

// Vnode type predicates for authors of custom template helpers. (The trust
// marker Symbols themselves stay framework-internal.)
export { isHtml, isRaw, isContain, isMemoEach, isWhen } from './core/template.js';

/**
 * Create a reactive store with pub/sub pattern
 *
 * @template T
 * @param {T} initialState - Initial state object
 * @returns {{
 *   state: T,
 *   subscribe: (callback: (state: T) => void) => () => void,
 *   set: (newState: T) => void,
 *   update: (fn: (state: T) => T) => void
 * }} Store object
 *
 * @example
 * const store = createStore({ count: 0 });
 *
 * // Subscribe to changes
 * const unsubscribe = store.subscribe(state => {
 *   console.log('Count:', state.count);
 * });
 *
 * // Update state
 * store.set({ count: 5 });
 * store.update(s => ({ ...s, count: s.count + 1 }));
 *
 * // Cleanup
 * unsubscribe();
 */
/**
 * Base class for class-authored stores. Seed reactive state in the constructor
 * (`super(); this.state = {...}`) exactly like a component. Top-level state keys
 * are promoted onto the instance (`store.items` <-> `store.state.items`); getters
 * become cached computeds; methods are auto-bound. Wire into a component via
 * `static stores = { cart: cartStore }` - `this.stores.cart` is the instance, so
 * state fields, computed getters, and methods all hang off one object.
 *
 * @example
 * class CartStore extends Store {
 *   constructor() { super(); this.state = { items: [] }; }
 *   add(item) { this.state.items.push(item); }
 *   get total() { return this.state.items.reduce((s, i) => s + i.price, 0); }
 * }
 * const cartStore = new CartStore();   // export and wire via static stores
 */
export { createStore, Store } from './core/store.js';

// Auto-register x-await-then component (used by awaitThen() helper)
import './core/x-await-then.js';
