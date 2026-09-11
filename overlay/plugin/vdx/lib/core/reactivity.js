/**
 * @fileoverview Core Reactivity System
 * Implements Vue 3-style reactivity using JavaScript Proxies for automatic dependency tracking.
 * Provides reactive state, computed values, watchers, and effects with ownership-based disposal.
 * @module core/reactivity
 */

import { HTML_MARKER } from './markers.js';

// Debug hooks - can be set by debug-enable.js
let debugReactivityHook = null;
export function setDebugReactivityHook(hook) {
    debugReactivityHook = hook;
}

// Effect flush hooks - allows template-renderer to batch DOM updates
let onBeforeEffectFlush = null;
let onAfterEffectFlush = null;

/**
 * Register callbacks to run before/after effect flush.
 * Used by template-renderer to batch DOM updates.
 * @param {Function} before - Called before effects run
 * @param {Function} after - Called after all effects complete
 */
export function registerEffectFlushHooks(before, after) {
    onBeforeEffectFlush = before;
    onAfterEffectFlush = after;
}

// ============================================================================
// Error Handling
// ============================================================================

/** Global error handler for effect errors */
let globalEffectErrorHandler = null;

/**
 * Set a global handler for effect errors.
 * @param {Function} handler - (error, context) => void, where context is 'effect' or 'cleanup'
 * @returns {Function|null} the handler that was installed before this call
 * @example
 * setEffectErrorHandler((error, context) => {
 *     console.error(`Effect ${context} failed:`, error);
 *     errorReportingService.report(error);
 * });
 */
export function setEffectErrorHandler(handler) {
    const previous = globalEffectErrorHandler;
    globalEffectErrorHandler = handler;
    return previous;   // so a caller can restore what it replaced
}

/**
 * Handle an error from an effect or cleanup function.
 * @param {Error} error - The error that occurred
 * @param {string} context - 'effect' or 'cleanup'
 * @param {Function} [localHandler] - Optional per-effect error handler
 * @private
 */
function handleEffectError(error, context, localHandler) {
    const handler = localHandler || globalEffectErrorHandler;
    if (handler) {
        try {
            handler(error, context);
        } catch (handlerError) {
            console.error('[Effect Error Handler Failed]', handlerError);
            console.error('[Original Error]', error);
        }
    } else {
        // Message format expected by tests: must include "Effect Error" and "reactive effect"
        const contextMsg = context === 'cleanup' ? 'cleanup function' : 'reactive effect';
        console.error(`[Effect Error] Error in ${contextMsg}:`, error);
    }
}

// ============================================================================
// Effect System
// ============================================================================

/** @type {Object|null} Current active effect being tracked (effect or owner) */
let activeEffect = null;

/**
 * The effect currently running, or null. Used by the renderer to stamp a
 * deferred DOM write with the binding that queued it, so a write whose
 * binding was disposed before the commit can be dropped.
 * @returns {Object|null}
 */
export function getActiveEffect() {
    return activeEffect;
}

/** @type {Array<Object>} Stack of effects for nested tracking */
const effectStack = [];

/**
 * Temporarily detach from the current effect context.
 * Any state accessed during the callback won't become a dependency
 * of the current effect. However, new effects created inside the callback
 * will track their own dependencies normally.
 *
 * @param {Function} fn - Callback to execute without current effect context
 * @returns {any} Return value of the callback
 */
export function withoutTracking(fn) {
    const savedActiveEffect = activeEffect;
    const savedStack = effectStack.slice();

    // Clear the effect context - state access won't be tracked
    activeEffect = null;
    effectStack.length = 0;

    try {
        return fn();
    } finally {
        // Restore the effect context
        effectStack.length = 0;
        for (const effect of savedStack) {
            effectStack.push(effect);
        }
        activeEffect = savedActiveEffect;
    }
}

/**
 * Creates a reactive effect that automatically tracks dependencies.
 * The effect runs immediately and re-runs whenever tracked dependencies change.
 *
 * Features:
 * - Cleanup callbacks: Return a function from your effect for cleanup on re-run/dispose
 * - Ownership: Effects created inside other effects become children, disposed together
 * - Error handling: Errors are caught and reported via global or per-effect handlers
 *
 * @param {Function} fn - The effect function to run and track. May return a cleanup function.
 * @param {Object} [options] - Optional configuration
 * @param {Function} [options.onError] - Per-effect error handler (error, context) => void
 * @returns {Object} Object with effect function and dispose method
 * @property {Function} effect - The effect function that can be called to re-run
 * @property {Function} dispose - Cleanup function to stop tracking and remove all dependencies
 * @example
 * const state = reactive({ count: 0 });
 * const { dispose } = createEffect(() => {
 *     console.log('Count is:', state.count);
 *     // Return cleanup function (optional)
 *     return () => console.log('Cleaning up');
 * });
 *
 * state.count = 5;  // Logs: "Cleaning up", then "Count is: 5"
 * dispose();        // Logs: "Cleaning up", stops tracking
 */
export function createEffect(fn, options = {}) {
    const { onError, label } = options;
    let disposed = false;
    let cleanup = null;
    const children = new Set();
    const owner = activeEffect;  // Parent is whoever is currently running

    const effect = () => {
        // Don't run if disposed (check both internal and external flags)
        if (disposed || effect._disposed) return;

        // Run previous cleanup before re-running
        if (cleanup) {
            try {
                cleanup();
            } catch (e) {
                handleEffectError(e, 'cleanup', onError);
            }
            cleanup = null;
        }

        // Drop the previous run's dependencies before re-tracking (Vue/Solid
        // semantics): a conditional branch that stopped reading a dep must
        // stop re-running on that dep's writes. Reads during this run
        // re-subscribe below. (Child effects are unrelated - they live in
        // effect.children, which is managed manually by the effect body.)
        for (const dep of effect.deps) {
            dep.delete(effect);
        }
        effect.deps.clear();

        // NOTE: Do NOT auto-dispose children here.
        // The effect body (slot effects in template-renderer) manually manages
        // child disposal based on whether template structure changed. This
        // preserves DOM state when only values change.

        activeEffect = effect;
        effectStack.push(effect);
        try {
            const result = fn();
            // If effect returns a function, it's a cleanup
            if (typeof result === 'function') {
                cleanup = result;
            }
        } catch (e) {
            handleEffectError(e, 'effect', onError);
        } finally {
            effectStack.pop();
            activeEffect = effectStack[effectStack.length - 1];
        }
    };

    effect.deps = new Set();
    effect.children = children;
    effect.owner = owner;
    // Cache ownership depth at creation time for O(1) sorting in flushEffects
    effect._depth = owner ? (owner._depth || 0) + 1 : 0;
    effect._label = label;  // Debug label

    // Register with parent (for cascading disposal)
    if (owner && owner.children) {
        owner.children.add(effect);
    }

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        effect._disposed = true;  // External flag for flushEffects to check

        // Dispose all children FIRST (depth-first disposal)
        // This ensures children are cleaned up before parent cleanup runs
        for (const child of children) {
            if (child.dispose) {
                child.dispose();
            }
        }
        children.clear();

        // Unregister from parent
        if (owner && owner.children) {
            owner.children.delete(effect);
        }

        // Run cleanup
        if (cleanup) {
            try {
                cleanup();
            } catch (e) {
                handleEffectError(e, 'cleanup', onError);
            }
            cleanup = null;
        }

        // Remove this effect from all dependency sets
        effect.deps.forEach(dep => {
            dep.delete(effect);
        });
        effect.deps.clear();

        // Remove from pending effect queue to prevent running after dispose
        removePendingEffect(effect);

        // Remove from effect stack if currently running
        const index = effectStack.indexOf(effect);
        if (index !== -1) {
            effectStack.splice(index, 1);
        }

        // Clear active effect if this was it
        if (activeEffect === effect) {
            activeEffect = null;
        }
    };

    effect.dispose = dispose;

    // Run effect once
    effect();

    // Return both the effect and dispose function
    return { effect, dispose };
}

/**
 * Create a root scope for effects. All effects created inside the callback
 * become children of this root. Returns a dispose function that disposes
 * all children.
 *
 * Use this to create isolated effect scopes that can be disposed together,
 * such as for component boundaries.
 *
 * @param {Function} fn - Callback to run within the root scope
 * @returns {Function} Dispose function that disposes all child effects
 * @example
 * const disposeRoot = createRoot(() => {
 *     createEffect(() => { ... });  // Child of root
 *     createEffect(() => { ... });  // Child of root
 * });
 *
 * // Later: dispose all effects at once
 * disposeRoot();
 */
export function createRoot(fn) {
    const children = new Set();
    const fakeOwner = { children, dispose: null };

    const savedEffect = activeEffect;
    activeEffect = fakeOwner;
    // Push onto the stack too: when a nested createEffect finishes its initial
    // run it restores activeEffect from effectStack's top. Without fakeOwner on
    // the stack, effect #2+ would restore to undefined (or the outer effect) and
    // be orphaned - never registered as a child, never disposed with the root.
    effectStack.push(fakeOwner);

    try {
        fn();
    } finally {
        effectStack.pop();
        activeEffect = savedEffect;
    }

    const dispose = () => {
        for (const child of children) {
            if (child.dispose) {
                child.dispose();
            }
        }
        children.clear();
    };

    fakeOwner.dispose = dispose;
    return dispose;
}

/**
 * Run code with a specific effect as the active effect owner.
 * Any effects created during the callback become children of the specified effect.
 *
 * This is useful when you need to create child effects outside of an effect's body
 * but still want them to be properly owned for cascading disposal.
 *
 * @param {Object} effect - The effect to use as the owner (the effect function, not the wrapper)
 * @param {Function} fn - Callback to run with the effect as owner
 * @returns {*} Return value of the callback
 * @example
 * const { effect } = createEffect(() => { ... });
 * runAsEffect(effect, () => {
 *     createEffect(() => { ... });  // Becomes child of 'effect'
 * });
 */
export function runAsEffect(effect, fn) {
    const savedEffect = activeEffect;
    activeEffect = effect;
    effectStack.push(effect);
    try {
        return fn();
    } finally {
        effectStack.pop();
        activeEffect = savedEffect;
    }
}

// ============================================================================
// Dependency Tracking
// ============================================================================

/**
 * Tracks a dependency between the active effect and a reactive property.
 * Called internally during reactive property access.
 *
 * @param {Object} target - The target object
 * @param {string|symbol} key - The property key being accessed
 * @private
 */
function track(target, key) {
    if (activeEffect && activeEffect.deps) {
        let depsMap = targetMap.get(target);
        if (!depsMap) {
            targetMap.set(target, (depsMap = new Map()));
        }
        let deps = depsMap.get(key);
        if (!deps) {
            depsMap.set(key, (deps = new Set()));
        }
        deps.add(activeEffect);
        activeEffect.deps.add(deps);
    }
}

/** @type {WeakMap<Object, Map>} WeakMap to store dependencies for each target object */
const targetMap = new WeakMap();

// ============================================================================
// Effect Scheduling and Flushing
// ============================================================================

/** Track currently running effects to prevent re-entrancy */
const runningEffects = new Set();

/** Pending effects as a simple Set (ownership handles execution order) */
const pendingEffects = new Set();

/** Whether a flush is already scheduled */
let flushScheduled = false;

/** Track if we're inside flushEffects */
let isFlushing = false;

/** Max iterations to prevent infinite effect loops */
const MAX_FLUSH_ITERATIONS = 100;

// ----------------------------------------------------------------------------
// nextRender() coordination
// ----------------------------------------------------------------------------

/** Pending resolvers for nextRender() promises, drained once render settles */
let nextRenderResolvers = [];

/** Optional hook to force-commit batched DOM updates synchronously.
 *  Registered by template-renderer (flushDOMUpdates) to avoid a circular
 *  import - reactivity.js must not import from template-renderer. */
let nextRenderFlushHook = null;

/**
 * Register a callback that synchronously commits any batched DOM updates.
 * Called by template-renderer so nextRender() can guarantee the DOM is
 * current before it resolves.
 * @param {Function} fn - Synchronous DOM-commit function
 */
export function registerNextRenderFlush(fn) {
    nextRenderFlushHook = fn;
}

/** Queued-but-unrun lifecycle continuations (mounted() microtasks). While any
 *  are outstanding, nextRender() must not resolve: a newly mounted child's
 *  mounted() hook may write state, and the caller's `await nextRender()`
 *  should observe that render too. Held/released by the component system. */
let pendingLifecycleHolds = 0;

/**
 * Framework-internal: block nextRender() resolution until the matching
 * releaseNextRender(). Used around queued mounted() hooks.
 */
export function holdNextRender() {
    pendingLifecycleHolds++;
}

/**
 * Framework-internal: release a holdNextRender() and re-attempt the drain.
 */
export function releaseNextRender() {
    if (pendingLifecycleHolds > 0) pendingLifecycleHolds--;
    if (pendingLifecycleHolds === 0 && nextRenderResolvers.length > 0) {
        queueMicrotask(drainNextRender);
    }
}

/**
 * Resolve pending nextRender() promises once effects are quiescent and the
 * DOM has been committed. If more reactive work is still queued (e.g. a
 * structural re-instantiation microtask scheduled a fresh flush), this defers:
 * the next flush's completion re-queues the drain.
 * @private
 */
function drainNextRender() {
    if (nextRenderResolvers.length === 0) return;

    // Still reactive work to do - let the pending/scheduled flush finish first.
    if (isFlushing || flushScheduled || pendingEffects.size > 0) {
        if (pendingEffects.size > 0) scheduleFlush();
        return;
    }

    // A mounted() hook queued during this render hasn't run yet - its state
    // writes belong to this render from the awaiting caller's perspective.
    // releaseNextRender() re-queues the drain when the hooks have run.
    if (pendingLifecycleHolds > 0) return;

    // Commit any rAF-batched attribute/text updates now, so the DOM the caller
    // reads after `await nextRender()` is fully up to date.
    if (nextRenderFlushHook) nextRenderFlushHook();

    // Committing the DOM can trigger new reactive work (e.g. a custom element
    // whose attribute changed re-renders). If so, wait for that to settle too.
    if (flushScheduled || pendingEffects.size > 0) {
        scheduleFlush();
        return;
    }

    const resolvers = nextRenderResolvers;
    nextRenderResolvers = [];
    for (const resolve of resolvers) resolve();
}

/**
 * Resolve after the next effect flush AND DOM commit complete. If no flush is
 * pending, one is scheduled, so `mutate; await nextRender()` always works.
 *
 * Newly mounted conditional branches (structural template changes) are
 * re-instantiated on a microtask after the flush; nextRender() waits for that
 * chain to settle, so the new DOM is present when the promise resolves.
 *
 * @returns {Promise<void>}
 * @example
 * this.state.showPanel = true;
 * await nextRender();          // DOM updated; new branches mounted
 * this.refs.panel.scrollTop = 0;
 */
export function nextRender() {
    return new Promise(resolve => {
        nextRenderResolvers.push(resolve);
        // Ensure a flush happens so the drain runs. No-ops if one is already
        // scheduled or in progress - that flush's completion drains us.
        scheduleFlush();
    });
}

/** Max times a single effect can run in one flush before being disposed */
const MAX_EFFECT_RUNS = 50;

/**
 * Add effect to pending queue.
 * @param {Object} effect - The effect to queue
 * @private
 */
function addPendingEffect(effect) {
    pendingEffects.add(effect);
}

/**
 * Remove effect from pending queue.
 * @param {Object} effect - The effect to remove
 * @private
 */
function removePendingEffect(effect) {
    pendingEffects.delete(effect);
}

/**
 * Schedule effect flush using microtask.
 * Effects run via microtask so they execute even when tab is backgrounded.
 * DOM updates are batched separately via rAF (see template-renderer.js).
 * @private
 */
function scheduleFlush() {
    // Don't schedule if already scheduled OR if we're currently flushing
    // (effects triggered during flush are handled by the while loop)
    if (flushScheduled || isFlushing) return;
    flushScheduled = true;

    // Use microtask for effects - runs even in background tabs
    queueMicrotask(flushEffects);
}

/**
 * Flush all pending effects synchronously.
 * Effects that were triggered multiple times only run once with latest state.
 *
 * Normally effects are batched and run via microtask.
 * Call this when you need effects to run immediately (e.g., in tests,
 * or when you need to read DOM state right after a state change).
 *
 * @example
 * state.count = 5;
 * flushEffects(); // Effects run now, not on next microtask
 * console.log(document.querySelector('.count').textContent); // "5"
 */
export function flushEffects() {
    // Prevent re-entrant flushing
    if (isFlushing) return;

    isFlushing = true;

    let iterations = 0;
    const effectRunCounts = new Map();  // Track per-effect run counts

    try {
        // Outer loop: effects → commit → repeat if commit triggered new effects
        do {
            // Begin deferred DOM updates mode (if registered)
            if (onBeforeEffectFlush) onBeforeEffectFlush();

            // Inner loop: run all queued effects
            while (pendingEffects.size > 0) {
                iterations++;
                if (iterations > MAX_FLUSH_ITERATIONS) {
                    console.error('[Reactivity] Max flush iterations exceeded - possible infinite effect loop');
                    pendingEffects.clear();
                    break;
                }

                // Take snapshot and sort by ownership depth (parents before children)
                // This ensures parent effects run first and can dispose children
                // before they have a chance to run with stale state
                const effects = [...pendingEffects];
                pendingEffects.clear();

                // Sort by ownership depth - effects closer to root run first
                // Uses cached _depth for O(1) lookup instead of traversing ownership chain
                effects.sort((a, b) => (a._depth || 0) - (b._depth || 0));

                // Track which effects haven't run yet in this batch
                const pendingInBatch = new Set(effects);

                for (const effect of effects) {
                    // Skip if effect was disposed (e.g., by parent effect during this flush)
                    if (effect._disposed) continue;

                    // Check ancestors for two conditions:
                    // 1. Ancestor is pending - defer to let parent run first
                    // 2. Ancestor is disposed - skip (we're a zombie effect)
                    let ancestor = effect.owner;
                    let shouldDefer = false;
                    let shouldSkip = false;
                    while (ancestor) {
                        // If any ancestor is disposed, we're a zombie - skip entirely
                        if (ancestor._disposed) {
                            shouldSkip = true;
                            break;
                        }
                        // If ancestor is pending, defer to let it run first
                        if (pendingInBatch.has(ancestor) || pendingEffects.has(ancestor)) {
                            pendingEffects.add(effect);
                            shouldDefer = true;
                            break;
                        }
                        ancestor = ancestor.owner;
                    }
                    if (shouldSkip || shouldDefer) {
                        pendingInBatch.delete(effect);
                        continue;
                    }

                    // Track per-effect run count
                    const count = (effectRunCounts.get(effect) || 0) + 1;
                    effectRunCounts.set(effect, count);

                    // If effect ran too many times, it's probably in an infinite loop
                    if (count > MAX_EFFECT_RUNS) {
                        console.error('[Reactivity] Effect ran too many times in one flush, disposing to prevent infinite loop');
                        if (effect.dispose) {
                            effect.dispose();
                        }
                        continue;
                    }

                    if (!runningEffects.has(effect)) {
                        runningEffects.add(effect);
                        try {
                            effect();
                        } finally {
                            runningEffects.delete(effect);
                            pendingInBatch.delete(effect);
                        }
                    }
                }
            }

            // Commit all queued DOM updates in one batch
            // This may trigger new effects (e.g., custom element props changed)
            if (onAfterEffectFlush) onAfterEffectFlush();

        } while (pendingEffects.size > 0 && iterations < MAX_FLUSH_ITERATIONS);

    } finally {
        isFlushing = false;
        flushScheduled = false;
        // Effects + commit are done for this flush. If callers are awaiting
        // nextRender(), drain them on a microtask - queued AFTER any structural
        // re-instantiation microtasks scheduled during this flush, so those run
        // (mounting new branches) before we resolve.
        if (nextRenderResolvers.length > 0) {
            queueMicrotask(drainNextRender);
        }
    }
}

/**
 * Triggers all effects that depend on a reactive property.
 * Called internally when a reactive property is modified.
 *
 * @param {Object} target - The target object
 * @param {string|symbol} key - The property key being modified
 * @private
 */
function trigger(target, key) {
    const depsMap = targetMap.get(target);
    if (!depsMap) return;

    const deps = depsMap.get(key);
    if (deps) {
        if (debugReactivityHook) {
            debugReactivityHook(target, key, target[key], `trigger(${deps.size} effects)`);
        }

        // Queue effects for batched execution. Effects marked _syncInvalidate
        // (computed invalidation watchers) run immediately instead: they only
        // flip a dirty flag and notify dependents, and running them eagerly
        // keeps computed values fresh when read synchronously after a write
        // (recomputation itself stays lazy, in the computed's get()).
        // Snapshot: a synchronously-run effect clears + re-adds itself to
        // this very Set (per-run dep dropping); iterating the live Set would
        // visit the re-added member twice.
        for (const effect of [...deps]) {
            if (effect._syncInvalidate) {
                if (!effect._disposed && !runningEffects.has(effect)) {
                    runningEffects.add(effect);
                    try {
                        effect();
                    } finally {
                        runningEffects.delete(effect);
                    }
                }
            } else {
                addPendingEffect(effect);
            }
        }

        // Schedule flush via microtask
        scheduleFlush();
    }
}

// ============================================================================
// Reactive Proxy
// ============================================================================

/** Symbol to mark objects as untracked */
const UNTRACKED = Symbol('untracked');

/**
 * Symbol marking a value that manages its own reactivity (e.g. versionedList).
 * reactive() must not re-wrap it, but - unlike a plain untracked() value - it
 * must NOT make its key "sticky untracked", so a later plain-object assignment
 * to the same key becomes reactive as the user expects. Exported for the
 * framework-internal self-reactive wrappers only.
 */
export const SELF_MANAGED = Symbol('selfManaged');

/** Symbol for mutation version counter - used by trackMutations() */
const MUTATION_VERSION = Symbol('mutationVersion');

/** Dependency key representing "the set of keys" of a reactive object.
 *  Enumeration reads (Object.keys, for..in, spread) track it; adding or
 *  deleting a key triggers it. Arrays use 'length' instead. */
const ITERATE_KEY = Symbol('iterate');

/** Array methods that structurally mutate - wrapped in the get trap to trigger
 *  updates. Module-level Set so the hot get trap does no per-access allocation. */
const ARRAY_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse']);

/** WeakMap to cache reactive collection wrappers (Set/Map -> reactiveSet/reactiveMap) */
const reactiveCollectionCache = new WeakMap();

/** WeakMap to cache proxies (raw object -> proxy) so repeated access returns the same proxy.
 *  Keeps === comparisons stable (state.items === state.items) and avoids
 *  allocating a new Proxy on every nested property access. */
const reactiveProxyCache = new WeakMap();

/**
 * Makes an object reactive using JavaScript Proxy.
 * All property access and mutations are tracked, triggering effects automatically.
 * Nested objects are recursively made reactive.
 *
 * @param {Object|Array} obj - The object or array to make reactive
 * @returns {Proxy} A reactive proxy of the object
 * @example
 * const state = reactive({
 *     count: 0,
 *     nested: { value: 10 }
 * });
 *
 * createEffect(() => console.log(state.count));
 * state.count++; // Effect runs automatically
 * state.nested.value = 20; // Nested changes are tracked too
 */
export function reactive(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    // If already a proxy or reactive collection, return as-is
    if (obj.__isReactive || isReactiveCollection(obj)) {
        return obj;
    }

    // Auto-wrap Set and Map with reactive collections (unless marked untracked)
    // Cache the wrappers so the same wrapper is returned on each access
    if (obj instanceof Set && !obj[UNTRACKED]) {
        if (reactiveCollectionCache.has(obj)) {
            return reactiveCollectionCache.get(obj);
        }
        const wrapped = reactiveSet(obj);
        reactiveCollectionCache.set(obj, wrapped);
        return wrapped;
    }
    if (obj instanceof Map && !obj[UNTRACKED]) {
        if (reactiveCollectionCache.has(obj)) {
            return reactiveCollectionCache.get(obj);
        }
        const wrapped = reactiveMap(obj);
        reactiveCollectionCache.set(obj, wrapped);
        return wrapped;
    }

    // Don't wrap objects with internal slots that can't be proxied
    // These include WeakSet, WeakMap, Promise, and Error
    if (obj instanceof WeakSet || obj instanceof WeakMap || obj instanceof Promise || obj instanceof Error) {
        return obj;
    }

    // Don't wrap framework template vnodes - they're immutable data
    // structures. Identified by trust marker, not shape: user state that
    // merely has a `_compiled` field must still be wrapped.
    if (obj[HTML_MARKER] === true) {
        return obj;
    }

    // Return the cached proxy if this object was already wrapped
    if (reactiveProxyCache.has(obj)) {
        return reactiveProxyCache.get(obj);
    }

    // Check if object is a Date - needs special handling for method binding
    const isDate = obj instanceof Date;

    // Track which keys were initially untracked - these stay untracked permanently
    // This allows: queue: untracked([]) to auto-apply untracked to future assignments
    const untrackedKeys = new Set();
    for (const key in obj) {
        const v = obj[key];
        // Self-managed values (versionedList) are UNTRACKED so we don't re-wrap
        // them, but they must not make the key sticky-untracked - else a later
        // plain array assigned here would be silently frozen out of reactivity.
        if (v !== null && typeof v === 'object' && v[UNTRACKED] && !v[SELF_MANAGED]) {
            untrackedKeys.add(key);
        }
    }

    const proxy = new Proxy(obj, {
        get(target, key, receiver) {
            // Special marker property
            if (key === '__isReactive') {
                return true;
            }

            // Mutation version for trackMutations() - O(1) way to track any change
            if (key === MUTATION_VERSION) {
                track(target, MUTATION_VERSION);
                return target[MUTATION_VERSION] || 0;
            }

            // For arrays, track 'length' instead of individual indices
            // This makes iteration O(1) instead of O(n) for dependency tracking
            // Template diffing handles "same output" cases efficiently
            if (Array.isArray(target) && typeof key === 'string' && /^\d+$/.test(key)) {
                track(target, 'length');
            } else {
                track(target, key);
            }
            const value = Reflect.get(target, key, receiver);

            // Date methods need to be bound to the original Date object
            // because Date's internal slots check 'this' type
            if (isDate && typeof value === 'function') {
                return value.bind(target);
            }

            // For array methods that modify the array, wrap them to trigger updates
            if (Array.isArray(target) && typeof value === 'function') {
                if (ARRAY_MUTATORS.has(key)) {
                    return function(...args) {
                        // For sort/reverse, make them atomic to prevent infinite loops
                        // Instead of mutating in place (which triggers during iteration),
                        // we copy, sort, and commit back in one operation
                        if (key === 'sort' || key === 'reverse') {
                            const copy = [...target];
                            copy[key](...args);
                            // Replace contents atomically. Indexed copy-back, NOT
                            // target.push(...copy): spreading a large array as call
                            // arguments overflows the stack (~130k items) - and it
                            // would do so AFTER length=0, destroying the data.
                            target.length = copy.length;
                            for (let i = 0; i < copy.length; i++) target[i] = copy[i];
                            trigger(target, 'length');
                            // Increment mutation version
                            target[MUTATION_VERSION] = (target[MUTATION_VERSION] || 0) + 1;
                            trigger(target, MUTATION_VERSION);
                            return proxy;  // Return proxy for chaining (like native sort)
                        }
                        const result = value.apply(target, args);
                        // Trigger on length change (covers both length and iteration tracking)
                        trigger(target, 'length');
                        // Increment mutation version
                        target[MUTATION_VERSION] = (target[MUTATION_VERSION] || 0) + 1;
                        trigger(target, MUTATION_VERSION);
                        return result;
                    };
                }
            }

            // Recursively make nested objects reactive
            // Sets/Maps are auto-wrapped by reactive() into reactiveSet/reactiveMap
            // Skip: WeakSet/WeakMap/Promise/Error (can't proxy), DOM Nodes,
            // template vnodes (HTML_MARKER covers html/when/contain/memoEach/
            // each - by trust marker, not shape, so user state that merely has
            // a `_compiled` field is still wrapped), untracked
            if (typeof value === 'object' && value !== null &&
                !(value instanceof WeakSet) && !(value instanceof WeakMap) &&
                !(value instanceof Promise) && !(value instanceof Error) &&
                !(typeof Node !== 'undefined' && value instanceof Node) &&
                value[HTML_MARKER] !== true &&
                !value[UNTRACKED]) {
                return reactive(value);
            }

            return value;
        },

        // `key in obj` registers a dependency on that key (additions and
        // deletions of it re-run the reader).
        has(target, key) {
            track(target, key);
            return Reflect.has(target, key);
        },

        // Object.keys / for..in / spread register a dependency on the key
        // SET, so adding or deleting a key re-runs enumerating readers.
        // Array enumeration rides on 'length' like index reads do.
        ownKeys(target) {
            track(target, Array.isArray(target) ? 'length' : ITERATE_KEY);
            return Reflect.ownKeys(target);
        },

        set(target, key, value, receiver) {
            const oldValue = target[key];
            const hadKey = Object.prototype.hasOwnProperty.call(target, key);

            // Auto-apply untracked to keys that were initially untracked
            if (untrackedKeys.has(key) && value !== null && typeof value === 'object' && !value[UNTRACKED]) {
                untracked(value);
            }

            const result = Reflect.set(target, key, value, receiver);

            // Trigger if:
            // 1. Value changed (primitive comparison)
            // 2. Assigning an object/Proxy (internal state might have changed)
            const isObjectAssignment = value !== null && typeof value === 'object';
            if (oldValue !== value || isObjectAssignment) {
                if (debugReactivityHook) {
                    debugReactivityHook(target, key, value, 'set');
                }

                // For array index sets, trigger 'length' since that's what we track
                if (Array.isArray(target) && typeof key === 'string' && /^\d+$/.test(key)) {
                    trigger(target, 'length');
                } else {
                    trigger(target, key);
                    // A brand-new key changes the key set: wake enumerators
                    if (!hadKey) {
                        trigger(target, ITERATE_KEY);
                    }
                }

                // Increment mutation version for trackMutations()
                target[MUTATION_VERSION] = (target[MUTATION_VERSION] || 0) + 1;
                trigger(target, MUTATION_VERSION);
            }

            return result;
        },

        deleteProperty(target, key) {
            const hadKey = Object.prototype.hasOwnProperty.call(target, key);
            const result = Reflect.deleteProperty(target, key);
            trigger(target, key);
            // Array index reads are normalized to track 'length' (see the get
            // trap), so deleting an index must trigger 'length' too or those
            // readers go stale.
            if (Array.isArray(target) && typeof key === 'string' && /^\d+$/.test(key)) {
                trigger(target, 'length');
            } else if (hadKey) {
                // A removed key changes the key set: wake enumerators
                trigger(target, ITERATE_KEY);
            }

            // Increment mutation version for trackMutations()
            target[MUTATION_VERSION] = (target[MUTATION_VERSION] || 0) + 1;
            trigger(target, MUTATION_VERSION);

            return result;
        }
    });

    reactiveProxyCache.set(obj, proxy);
    return proxy;
}

// ============================================================================
// Computed and Watch
// ============================================================================

/**
 * Creates a computed value that automatically updates when dependencies change.
 * The getter function is lazily evaluated and cached until dependencies change.
 *
 * @param {Function} getter - Function that computes the value
 * @returns {Object} Object with computed getter and dispose method
 * @property {Function} get - Function that returns the current computed value
 * @property {Function} dispose - Cleanup function to stop tracking
 * @example
 * const state = reactive({ a: 1, b: 2 });
 * const sum = computed(() => state.a + state.b);
 *
 * console.log(sum.get()); // 3
 * state.a = 5;
 * console.log(sum.get()); // 7 (automatically recomputed)
 *
 * sum.dispose(); // Clean up when done
 */
export function computed(getter) {
    let value;
    let dirty = true;
    let firstRun = true;
    let failed = false;   // last run threw - stay dirty and retry on dep change

    // Dedicated dependency target so effects that read this computed
    // re-run when it invalidates (without tracking the getter's own deps).
    const depTarget = {};

    // The effect tracks the getter's dependencies. When any of them change,
    // it marks the computed dirty and notifies dependents - it does NOT
    // recompute (recomputation stays lazy, in get()).
    const { effect, dispose } = createEffect(() => {
        if (firstRun || failed) {
            // First run, or retry after a run that threw. Flip the flags BEFORE
            // calling the getter so a throw doesn't strand us in this branch
            // forever (the old code left firstRun=true and silently recomputed
            // without ever notifying dependents when the getter later healed).
            const wasHealing = failed;
            firstRun = false;
            failed = false;
            try {
                value = getter();
                dirty = false;
                // A getter that previously threw just succeeded: wake dependents
                // that cached the error/old value so they re-read.
                if (wasHealing) trigger(depTarget, 'value');
            } catch (e) {
                failed = true;
                dirty = true;
                throw e;   // let createEffect's handler log it
            }
        } else if (!dirty) {
            // Invalidate and wake up any effects that read this computed
            dirty = true;
            trigger(depTarget, 'value');
        }
    });

    // Run invalidation synchronously on dependency writes (see trigger()),
    // so a computed read immediately after a mutation is never stale.
    effect._syncInvalidate = true;

    const get = () => {
        // Register the calling effect as a dependent of this computed
        track(depTarget, 'value');
        if (dirty) {
            // Recompute inside the computed's own effect context so newly
            // accessed dependencies (e.g. after a branch switch) are tracked
            // by the computed, not leaked into the calling effect.
            //
            // A throw here has to set `failed` exactly as the effect body does.
            // Without it the computed stays dirty with failed=false, so the
            // next dependency change reaches neither branch of the effect and
            // dependents are never woken again once the getter heals.
            try {
                runAsEffect(effect, () => {
                    value = getter();
                });
                dirty = false;
                // Clearing `failed` matters as much as setting it. Left true
                // after a lazy read healed, the next dependency write takes the
                // eager healing branch instead of ordinary invalidation - and
                // if THAT run throws, it never reaches trigger(), so dependents
                // holding the stale value are never woken.
                const wasHealing = failed;
                failed = false;
                // ...and healing here has to wake dependents for the same
                // reason the eager branch does: whoever observed the throw is
                // still holding it, and nothing else will tell them.
                if (wasHealing) trigger(depTarget, 'value');
            } catch (e) {
                failed = true;
                throw e;
            }
        }
        return value;
    };

    // Internal: number of dependency sets the getter tracked (used by the
    // component system to detect dependency-free getters that could never
    // invalidate). Reflects the most recent run.
    const _depCount = () => effect.deps.size;

    return { get, dispose, _depCount };
}

/**
 * Watches a reactive value and runs a callback when it changes.
 * The callback receives the new and old values.
 *
 * @param {Function} fn - Function that returns the value to watch
 * @param {Function} [callback] - Callback to run on changes (receives newValue, oldValue)
 * @returns {Function} Dispose function to stop watching
 * @example
 * const state = reactive({ count: 0 });
 *
 * const stopWatching = watch(
 *     () => state.count,
 *     (newCount, oldCount) => {
 *         console.log(`Count changed from ${oldCount} to ${newCount}`);
 *     }
 * );
 *
 * state.count = 5; // Logs: Count changed from 0 to 5
 * stopWatching(); // Stop watching
 */
export function watch(fn, callback) {
    let oldValue;
    let firstRun = true;

    const { dispose } = createEffect(() => {
        const newValue = fn();
        // Skip the initial run; afterwards only fire when the value actually
        // changed (the effect may re-run when a tracked-but-unreturned dep changes)
        if (!firstRun && callback && newValue !== oldValue) {
            const prev = oldValue;
            oldValue = newValue;
            // Run the callback untracked: state it reads must not become
            // a dependency of the watcher (would cause spurious re-fires)
            withoutTracking(() => callback(newValue, prev));
        } else {
            oldValue = newValue;
        }
        firstRun = false;
    });

    return dispose;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Checks if a value is a reactive proxy.
 *
 * @param {*} value - The value to check
 * @returns {boolean} True if the value is reactive, false otherwise
 * @example
 * const obj = { count: 0 };
 * const reactiveObj = reactive(obj);
 *
 * console.log(isReactive(obj)); // false
 * console.log(isReactive(reactiveObj)); // true
 */
export function isReactive(value) {
    return !!(value && value.__isReactive);
}

/**
 * Marks an object as untracked. When used with reactive state, the object's
 * internal properties won't be deeply tracked - only reassignment of the
 * object itself will trigger updates.
 *
 * Use this for large data structures (arrays of hundreds/thousands of items)
 * where you only care about the array being replaced, not individual item changes.
 *
 * @param {T} obj - The object to mark as untracked
 * @returns {T} The same object with untracked marker
 * @example
 * data() {
 *     return {
 *         // Large list - only track when the whole list is replaced
 *         songs: untracked([]),
 *         // Small values - track normally
 *         currentIndex: 0
 *     };
 * }
 *
 * // To update, reassign the whole array:
 * this.state.songs = untracked([...this.state.songs, newSong]);
 *
 * // Individual item changes won't trigger re-render (by design):
 * this.state.songs[0].title = 'New Title'; // No re-render
 */
export function untracked(obj) {
    if (obj !== null && typeof obj === 'object') {
        Object.defineProperty(obj, UNTRACKED, {
            value: true,
            enumerable: false,
            writable: false,
            configurable: false
        });
    }
    return obj;
}

/**
 * Checks if an object is marked as untracked.
 * @param {*} obj - The object to check
 * @returns {boolean} True if untracked
 */
export function isUntracked(obj) {
    return obj !== null && typeof obj === 'object' && obj[UNTRACKED] === true;
}

/**
 * Memoizes a function and tracks its dependencies.
 * The cached value is only recomputed when dependencies change.
 * Much more efficient than recomputing templates on every render.
 *
 * @param {Function} fn - The function to memoize
 * @param {Function|Array} [deps] - Dependencies: a function returning an array
 *     (re-evaluated on every call - use this for reactive state), or a static
 *     array (snapshot taken once at creation - only useful for fixed values).
 * @returns {Function} Memoized function that returns cached value when possible
 * @example
 * // In component - deps MUST be a function so current state is read each call:
 * this._memoizedTemplate = memo(() => {
 *     return html`<div>${this.state.items.length} items</div>`;
 * }, () => [this.state.items]);
 *
 * template() {
 *     return this._memoizedTemplate();  // Only recomputes if items changed
 * }
 */
export function memo(fn, deps) {
    let cachedValue;
    let lastDeps = null;
    let dirty = true;

    return (...args) => {
        // Check if dependencies changed
        if (deps) {
            // Function form is re-evaluated per call; array form is a fixed snapshot
            const currentDeps = typeof deps === 'function' ? deps() : deps;
            const depsChanged = !lastDeps ||
                currentDeps.length !== lastDeps.length ||
                currentDeps.some((dep, i) => dep !== lastDeps[i]);
            if (depsChanged) {
                dirty = true;
                lastDeps = [...currentDeps];
            }
        }

        // Recompute if dirty
        if (dirty) {
            cachedValue = fn(...args);
            dirty = false;
        }

        return cachedValue;
    };
}

/**
 * Efficiently track all properties of a reactive object.
 * This recursively accesses all enumerable properties to register dependencies
 * without the overhead of JSON.stringify.
 *
 * Optimizations:
 * - Skips objects marked with untracked() - only tracks the reference
 * - Skips non-reactive nested objects (they can't trigger updates)
 * - Uses iterative approach for arrays to reduce call stack
 *
 * @param {Object} obj - The reactive object to track
 * @param {Set} [visited] - Internal set to prevent circular references
 * @example
 * const state = reactive({ count: 0, nested: { value: 10 } });
 * createEffect(() => {
 *     trackAllDependencies(state);  // Tracks all changes to state
 *     console.log('State changed!');
 * });
 */
export function trackAllDependencies(obj, visited) {
    // Handle null/undefined/primitives
    if (obj == null || typeof obj !== 'object') return;

    // Initialize visited set only at top level (avoid allocation on recursion)
    if (!visited) visited = new Set();

    // Prevent circular references
    if (visited.has(obj)) return;
    visited.add(obj);

    // Skip untracked objects - just accessing obj is enough to track the reference
    // The proxy get trap was already triggered by the caller accessing this property
    if (obj[UNTRACKED]) return;

    // Handle arrays
    if (Array.isArray(obj)) {
        // Access length to track array changes
        const len = obj.length;

        // For large arrays, only track length - not every element
        // Individual elements should be marked untracked if needed
        if (len > 100) {
            // Just track length for large arrays
            return;
        }

        // For smaller arrays, track elements
        for (let i = 0; i < len; i++) {
            const item = obj[i];
            if (item !== null && typeof item === 'object') {
                // Only recurse into reactive objects
                if (item.__isReactive) {
                    trackAllDependencies(item, visited);
                }
            }
        }
        return;
    }

    // Handle objects - use for...in which is faster than Object.keys() + iteration
    for (const key in obj) {
        // Skip prototype properties and internal markers
        if (key === '__isReactive' || key === UNTRACKED) continue;

        try {
            const value = obj[key];  // Access triggers tracking via proxy

            // Only recurse into reactive nested objects
            if (value !== null && typeof value === 'object' && value.__isReactive) {
                trackAllDependencies(value, visited);
            }
        } catch (e) {
            // Skip properties that throw on access (getters that error, etc.)
        }
    }
}

/**
 * Track mutations to a reactive object using O(1) mutation counter.
 * Much more efficient than trackAllDependencies() for large objects.
 *
 * Instead of walking every property (O(n)), this just reads a single
 * mutation version counter that increments on any change.
 *
 * @param {Object} obj - The reactive object to track
 * @example
 * const state = reactive({ items: [...thousandsOfItems] });
 * createEffect(() => {
 *     trackMutations(state);  // O(1) - just reads mutation counter
 *     console.log('State changed!');
 * });
 *
 * state.items.push(newItem);  // Effect runs (mutation counter incremented)
 * state.anyProp = 'value';    // Effect runs (mutation counter incremented)
 */
export function trackMutations(obj) {
    // Handle null/undefined/primitives
    if (obj == null || typeof obj !== 'object') return;

    // For reactive proxies, access the mutation version to establish dependency
    if (obj.__isReactive) {
        // Accessing MUTATION_VERSION triggers tracking via proxy get trap
        const _ = obj[MUTATION_VERSION];
    }

    // For reactive collections (Set/Map), track their size
    if (isReactiveCollection(obj)) {
        const _ = obj.size;
    }
}

// ============================================================================
// Reactive Collections (Set and Map)
// ============================================================================

/** Symbol to mark reactive collections */
const REACTIVE_COLLECTION = Symbol('reactiveCollection');

/**
 * Creates a reactive Set that automatically triggers updates when modified.
 * Unlike regular Set in reactive state, you don't need to reassign after mutations.
 *
 * @param {Iterable} [initial] - Initial values for the Set
 * @returns {Object} A reactive Set-like object
 * @example
 * data() {
 *     return {
 *         selectedIds: reactiveSet()
 *     };
 * }
 *
 * // These automatically trigger re-renders:
 * this.state.selectedIds.add(5);
 * this.state.selectedIds.delete(3);
 * this.state.selectedIds.clear();
 *
 * // Reading also tracks dependencies:
 * if (this.state.selectedIds.has(5)) { ... }
 */
export function reactiveSet(initial) {
    const internal = new Set(initial);

    // Use an object as the tracking target (Sets can't be proxied directly)
    const target = { [REACTIVE_COLLECTION]: 'Set' };

    const wrapper = {
        add(value) {
            if (!internal.has(value)) {
                internal.add(value);
                trigger(target, 'size');
            }
            return wrapper;
        },

        delete(value) {
            const had = internal.has(value);
            if (had) {
                internal.delete(value);
                trigger(target, 'size');
            }
            return had;
        },

        /**
         * Add multiple values at once (single trigger)
         * @param {Iterable} values - Values to add
         * @returns {Object} The wrapper for chaining
         */
        addAll(values) {
            let changed = false;
            for (const value of values) {
                if (!internal.has(value)) {
                    internal.add(value);
                    changed = true;
                }
            }
            if (changed) {
                trigger(target, 'size');
            }
            return wrapper;
        },

        /**
         * Delete multiple values at once (single trigger)
         * @param {Iterable} values - Values to delete
         * @returns {number} Number of values actually deleted
         */
        deleteAll(values) {
            let deleted = 0;
            for (const value of values) {
                if (internal.delete(value)) {
                    deleted++;
                }
            }
            if (deleted > 0) {
                trigger(target, 'size');
            }
            return deleted;
        },

        has(value) {
            track(target, 'size');
            return internal.has(value);
        },

        clear() {
            if (internal.size > 0) {
                internal.clear();
                trigger(target, 'size');
            }
        },

        get size() {
            track(target, 'size');
            return internal.size;
        },

        forEach(callback, thisArg) {
            track(target, 'size');
            internal.forEach(callback, thisArg);
        },

        *[Symbol.iterator]() {
            track(target, 'size');
            yield* internal;
        },

        *keys() {
            track(target, 'size');
            yield* internal.keys();
        },

        *values() {
            track(target, 'size');
            yield* internal.values();
        },

        *entries() {
            track(target, 'size');
            yield* internal.entries();
        },

        // Allow spreading: [...mySet]
        get [Symbol.toStringTag]() {
            return 'ReactiveSet';
        }
    };

    return wrapper;
}

/**
 * Creates a reactive Map that automatically triggers updates when modified.
 * Unlike regular Map in reactive state, you don't need to reassign after mutations.
 *
 * @param {Iterable} [initial] - Initial entries for the Map
 * @returns {Object} A reactive Map-like object
 * @example
 * data() {
 *     return {
 *         userScores: reactiveMap()
 *     };
 * }
 *
 * // These automatically trigger re-renders:
 * this.state.userScores.set('alice', 100);
 * this.state.userScores.delete('bob');
 * this.state.userScores.clear();
 *
 * // Reading also tracks dependencies:
 * const score = this.state.userScores.get('alice');
 */
export function reactiveMap(initial) {
    const internal = new Map(initial);

    // Use an object as the tracking target (Maps can't be proxied directly)
    const target = { [REACTIVE_COLLECTION]: 'Map' };

    const wrapper = {
        set(key, value) {
            const hadKey = internal.has(key);
            const oldValue = internal.get(key);
            internal.set(key, value);
            // Trigger if new key or value changed
            if (!hadKey || oldValue !== value) {
                trigger(target, 'size');
            }
            return wrapper;
        },

        get(key) {
            track(target, 'size');
            return internal.get(key);
        },

        delete(key) {
            const had = internal.has(key);
            if (had) {
                internal.delete(key);
                trigger(target, 'size');
            }
            return had;
        },

        /**
         * Set multiple key-value pairs at once (single trigger)
         * @param {Iterable<[key, value]>} entries - Entries to set
         * @returns {Object} The wrapper for chaining
         */
        setAll(entries) {
            let changed = false;
            for (const [key, value] of entries) {
                const hadKey = internal.has(key);
                const oldValue = internal.get(key);
                internal.set(key, value);
                if (!hadKey || oldValue !== value) {
                    changed = true;
                }
            }
            if (changed) {
                trigger(target, 'size');
            }
            return wrapper;
        },

        /**
         * Delete multiple keys at once (single trigger)
         * @param {Iterable} keys - Keys to delete
         * @returns {number} Number of keys actually deleted
         */
        deleteAll(keys) {
            let deleted = 0;
            for (const key of keys) {
                if (internal.delete(key)) {
                    deleted++;
                }
            }
            if (deleted > 0) {
                trigger(target, 'size');
            }
            return deleted;
        },

        has(key) {
            track(target, 'size');
            return internal.has(key);
        },

        clear() {
            if (internal.size > 0) {
                internal.clear();
                trigger(target, 'size');
            }
        },

        get size() {
            track(target, 'size');
            return internal.size;
        },

        forEach(callback, thisArg) {
            track(target, 'size');
            internal.forEach(callback, thisArg);
        },

        *[Symbol.iterator]() {
            track(target, 'size');
            yield* internal;
        },

        *keys() {
            track(target, 'size');
            yield* internal.keys();
        },

        *values() {
            track(target, 'size');
            yield* internal.values();
        },

        *entries() {
            track(target, 'size');
            yield* internal.entries();
        },

        get [Symbol.toStringTag]() {
            return 'ReactiveMap';
        }
    };

    return wrapper;
}

/**
 * Check if a value is a reactive collection (Set or Map)
 * @param {*} value - Value to check
 * @returns {boolean}
 */
export function isReactiveCollection(value) {
    return value && typeof value === 'object' && value[Symbol.toStringTag] &&
        (value[Symbol.toStringTag] === 'ReactiveSet' || value[Symbol.toStringTag] === 'ReactiveMap');
}
