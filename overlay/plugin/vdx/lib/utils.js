/**
 * Utility Functions
 *
 * Common helpers for:
 * - Async operations (sleep, debounce, throttle)
 * - Memoization for expensive computations
 * - Notifications and toast messages
 * - Form helpers
 * - Event bus for cross-component communication
 * - localStorage persistence
 * - Dark theme management
 * - Boolean prop coercion (boolProp)
 */

import { createStore, withoutTracking, boolProp } from './framework.js';

/**
 * Coerce a boolean-ish prop, whichever form it arrived in.
 *
 * A component receives one of two things for the same prop, and the difference
 * is invisible from inside: literal template text is a STRING (`disabled` gives
 * "disabled", `disabled="true"` gives "true"), while an interpolated
 * `disabled="${flag}"` keeps its JS type. Nothing coerces between them, by
 * design - the template layer hands over exactly what the author wrote.
 *
 * That makes the naive checks wrong in opposite directions: `props.x === true`
 * is false for every literal form, and a bare `if (props.x)` treats the string
 * "false" as true. Route every flag through this instead.
 *
 *     if (boolProp(this.props.disabled)) return;
 *     disabled="${boolProp(this.props.disabled)}"     // passing it to a native element
 *
 * Re-exported from `lib/framework.js` too, which is what the component library
 * imports. See the t13-bool-false lint check, which flags the `="false"` form
 * that this exists to survive.
 *
 * @param {*} value - the prop value, string or otherwise
 * @returns {boolean} true unless the value is the string "false" or JS-falsy
 */
export { boolProp };

/**
 * Memoize a function based on its arguments.
 *
 * Caches the result until arguments change. Useful for expensive operations
 * like sorting, filtering large arrays, or complex calculations.
 *
 * @param {Function} fn - Function to memoize that takes arguments
 * @returns {Function} Memoized function that caches results based on arguments
 *
 * @example
 * data() {
 *   return {
 *     items: [...],
 *     sortedItems: memoize((items) => [...items].sort((a, b) => a.name.localeCompare(b.name)))
 *   };
 * }
 *
 * template() {
 *   // Only recomputes when items array reference changes
 *   const sorted = this.state.sortedItems(this.state.items);
 *   return html`...`;
 * }
 */
export function memoize(fn) {
    let cache = null;
    let deps = [];
    let hasCache = false;

    return function(...currentDeps) {
        // Check if dependencies changed
        if (hasCache && depsEqual(deps, currentDeps)) {
            return cache;
        }

        // Recompute
        deps = currentDeps;
        cache = fn.apply(this, currentDeps);
        hasCache = true;
        return cache;
    };
}

/**
 * Deep equality check for dependencies
 * @private
 * @param {any[]} a - First dependency array
 * @param {any[]} b - Second dependency array
 * @returns {boolean} True if dependencies are equal
 */
function depsEqual(a, b) {
    if (a.length !== b.length) return false;

    for (let i = 0; i < a.length; i++) {
        if (!shallowEqual(a[i], b[i])) return false;
    }

    return true;
}

/**
 * Shallow equality check
 * @private
 * @param {any} a - First value
 * @param {any} b - Second value
 * @returns {boolean} True if values are shallowly equal
 */
function shallowEqual(a, b) {
    // Same reference
    if (a === b) return true;

    // Null/undefined
    if (a == null || b == null) return false;

    // Primitives
    if (typeof a !== 'object' || typeof b !== 'object') return false;

    // Arrays
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    // Objects
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);

    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
        if (a[key] !== b[key]) return false;
    }

    return true;
}

/**
 * Sleep/delay utility for async operations
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>} Promise that resolves after specified time
 *
 * @example
 * async function demo() {
 *   console.log('Start');
 *   await sleep(1000);
 *   console.log('1 second later');
 * }
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Debounce function - delays execution until after delay has elapsed since last call
 * @param {Function} fn - Function to debounce
 * @param {number} [delay=300] - Delay in milliseconds
 * @returns {Function} Debounced function
 *
 * @example
 * const handleSearch = debounce((query) => {
 *   searchAPI(query);
 * }, 500);
 *
 * // Only calls searchAPI once, 500ms after user stops typing
 * input.addEventListener('input', e => handleSearch(e.target.value));
 */
export function debounce(fn, delay = 300) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), delay);
    };
}

/**
 * Throttle function - ensures function is called at most once per limit period
 * @param {Function} fn - Function to throttle
 * @param {number} [limit=300] - Minimum time between calls in milliseconds
 * @returns {Function} Throttled function
 *
 * @example
 * const handleScroll = throttle(() => {
 *   updateScrollPosition();
 * }, 100);
 *
 * // Only calls updateScrollPosition once every 100ms, even if scrolling faster
 * window.addEventListener('scroll', handleScroll);
 */
export function throttle(fn, limit = 300) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            fn.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

/**
 * RAF Throttle - throttles function using requestAnimationFrame
 * @param {Function} fn - Function to throttle
 * @returns {Function} Throttled function that runs at most once per animation frame (~16ms at 60fps)
 *
 * @example
 * const handleScroll = rafThrottle(() => {
 *   updateVisibleItems();
 * });
 *
 * // Only calls updateVisibleItems once per frame, ideal for scroll handlers
 * window.addEventListener('scroll', handleScroll);
 */
export function rafThrottle(fn) {
    let rafPending = false;
    return function(...args) {
        if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(() => {
                // finally: one throw must not leave rafPending stuck true,
                // which would silently kill the throttled function forever
                // (e.g. a windowed list's scroll handler).
                try {
                    fn.apply(this, args);
                } finally {
                    rafPending = false;
                }
            });
        }
    };
}

/**
 * Notification system
 */
let notificationId = 0;

/**
 * Reactive store containing current notifications
 * @type {{list: Array<{id: number, message: string, severity: string, timestamp: number}>}}
 *
 * @example
 * notifications.subscribe(({ list }) => {
 *   console.log('Current notifications:', list);
 * });
 */
export const notifications = createStore({
    list: []
});

/**
 * Show a toast notification
 * @param {string} message - Notification message
 * @param {('info'|'success'|'warning'|'error')} [severity='info'] - Notification severity/type
 * @param {number} [ttl=5] - Time to live in seconds (0 for persistent)
 * @returns {number} Notification ID (can be used with dismissNotification)
 *
 * @example
 * notify('Saved successfully!', 'success', 3);
 * notify('Error occurred', 'error', 5);
 *
 * const id = notify('Processing...', 'info', 0); // Persistent
 * // Later: dismissNotification(id);
 */
export function notify(message, severity = 'info', ttl = 5) {
    const id = notificationId++;

    // Add notification
    notifications.update(s => ({
        list: [...s.list, { id, message, severity, timestamp: Date.now() }]
    }));

    // Remove after TTL (ttl is in seconds, convert to milliseconds)
    if (ttl > 0) {
        setTimeout(() => {
            notifications.update(s => ({
                list: s.list.filter(n => n.id !== id)
            }));
        }, ttl * 1000);
    }

    return id;
}

/**
 * Dismiss a notification by ID
 * @param {number} id - Notification ID (returned from notify())
 * @returns {void}
 *
 * @example
 * const id = notify('Loading...', 'info', 0);
 * // Later:
 * dismissNotification(id);
 */
export function dismissNotification(id) {
    notifications.update(s => ({
        list: s.list.filter(n => n.id !== id)
    }));
}

/**
 * Extract form data as object
 * @param {HTMLFormElement} formElement - Form element
 * @returns {Object<string, string>} Form data as key-value pairs
 *
 * @example
 * const data = formData(formElement);
 * // { username: 'alice', email: 'alice@example.com' }
 */
export function formData(formElement) {
    return Object.fromEntries(new FormData(formElement));
}

/**
 * Serialize form data as URL-encoded string
 * @param {HTMLFormElement} formElement - Form element
 * @returns {string} URL-encoded form data
 *
 * @example
 * const encoded = serializeForm(formElement);
 * // "username=alice&email=alice%40example.com"
 */
export function serializeForm(formElement) {
    const data = formData(formElement);
    return new URLSearchParams(data).toString();
}

/**
 * Fetch JSON with better error handling
 * @param {string} url - URL to fetch
 * @param {RequestInit} [options={}] - Fetch options
 * @returns {Promise<any>} Parsed JSON response
 * @throws {Error} HTTP error with status code
 *
 * @example
 * try {
 *   const data = await fetchJSON('/api/users');
 *   console.log(data);
 * } catch (error) {
 *   console.error('Failed:', error.message); // "HTTP 404: Not Found"
 * }
 */
export async function fetchJSON(url, options = {}) {
    try {
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        console.error('Fetch error:', error);
        throw error;
    }
}

/**
 * Interval helper that cleans up automatically
 * @param {Function} fn - Function to run at interval
 * @param {number} delay - Delay in milliseconds
 * @returns {{id: number, clear: () => void}} Interval controller
 *
 * @example
 * const interval = createInterval(() => {
 *   fetchUpdates();
 * }, 60000); // Every minute
 *
 * // Later: cleanup
 * interval.clear();
 */
export function createInterval(fn, delay) {
    const id = setInterval(fn, delay);

    return {
        id,
        clear() {
            clearInterval(id);
        }
    };
}

/**
 * Event bus for cross-component communication
 * @class EventBus
 */
class EventBus {
    constructor() {
        this.events = {};
    }

    /**
     * Subscribe to an event
     * @param {string} event - Event name
     * @param {Function} callback - Event handler
     * @returns {Function} Unsubscribe function
     */
    on(event, callback) {
        if (!this.events[event]) {
            this.events[event] = [];
        }
        this.events[event].push(callback);

        // Return unsubscribe function
        return () => this.off(event, callback);
    }

    /**
     * Unsubscribe from an event
     * @param {string} event - Event name
     * @param {Function} callback - Event handler to remove
     * @returns {void}
     */
    off(event, callback) {
        if (!this.events[event]) return;

        this.events[event] = this.events[event].filter(cb => cb !== callback);
    }

    /**
     * Emit an event to all subscribers
     * @param {string} event - Event name
     * @param {...any} args - Arguments to pass to handlers
     * @returns {void}
     */
    emit(event, ...args) {
        if (!this.events[event]) return;

        this.events[event].forEach(callback => {
            try {
                callback(...args);
            } catch (error) {
                console.error(`Error in event handler for "${event}":`, error);
            }
        });
    }

    /**
     * Subscribe to an event for one emission only
     * @param {string} event - Event name
     * @param {Function} callback - Event handler
     * @returns {Function} Unsubscribe function
     */
    once(event, callback) {
        const onceWrapper = (...args) => {
            // Unsubscribe FIRST: emit() swallows handler throws, so a
            // throwing callback would otherwise stay subscribed and fire
            // again on every later emit.
            this.off(event, onceWrapper);
            callback(...args);
        };

        return this.on(event, onceWrapper);
    }
}

/**
 * Global event bus instance for cross-component communication
 * @type {EventBus}
 *
 * @example
 * // In one component
 * eventBus.on('user-updated', (user) => {
 *   console.log('User updated:', user);
 * });
 *
 * // In another component
 * eventBus.emit('user-updated', { name: 'Alice', id: 123 });
 */
export const eventBus = new EventBus();

/**
 * Check if value is empty (null, undefined, empty string/array/object)
 * @param {any} value - Value to check
 * @returns {boolean} True if value is empty
 *
 * @example
 * isEmpty(null); // true
 * isEmpty(''); // true
 * isEmpty([]); // true
 * isEmpty({}); // true
 * isEmpty('hello'); // false
 */
export function isEmpty(value) {
    if (value == null) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
}

/**
 * Clamp number between min and max
 * @param {number} value - Value to clamp
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Clamped value
 *
 * @example
 * clamp(150, 0, 100); // 100
 * clamp(-10, 0, 100); // 0
 * clamp(50, 0, 100); // 50
 */
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * Generate random ID
 * @param {string} [prefix='id'] - Prefix for the ID
 * @returns {string} Random ID string
 *
 * @example
 * randomId(); // 'id-x7k2m9p4q'
 * randomId('user'); // 'user-a3f8g1h5j'
 */
export function randomId(prefix = 'id') {
    return `${prefix}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Format date to relative time (e.g., "2 hours ago")
 * @param {Date|string|number} date - Date to format
 * @returns {string} Relative time string
 *
 * @example
 * relativeTime(new Date(Date.now() - 3600000)); // "1 hour ago"
 * relativeTime(new Date(Date.now() - 120000)); // "2 minutes ago"
 * relativeTime(new Date(Date.now() - 30000)); // "just now"
 */
export function relativeTime(date) {
    const now = new Date();
    const then = new Date(date);
    const seconds = Math.floor((now - then) / 1000);

    if (seconds < 60) return 'just now';
    const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
    if (seconds < 3600) return unit(Math.floor(seconds / 60), 'minute');
    if (seconds < 86400) return unit(Math.floor(seconds / 3600), 'hour');
    if (seconds < 604800) return unit(Math.floor(seconds / 86400), 'day');

    return then.toLocaleDateString();
}

/**
 * localStorage key prefix used by localStore()/darkTheme.
 *
 * Apps sharing an origin should claim their own prefix. Two hooks:
 * - `window.__VDX_LS_PREFIX = 'myapp'` in a plain <script> BEFORE any module
 *   loads - this is the only way to affect stores created at module load
 *   (like the exported darkTheme store, whose key is fixed at import time).
 * - setLocalStorePrefix('myapp') at startup, before creating your own stores.
 *
 * Deployments upgrading from the pre-v1 default keep their persisted data by
 * setting `window.__VDX_LS_PREFIX = 'swapi'`.
 */
let LOCALSTORAGE_PREFIX =
    (typeof window !== 'undefined' && typeof window.__VDX_LS_PREFIX === 'string' && window.__VDX_LS_PREFIX)
    || 'vdx';

/**
 * Set the localStorage key prefix for localStore(). Call once at startup
 * before any localStore() is created (existing stores keep the prefix they
 * were created with only until their next write - the prefix is read per
 * operation, so change it before creating ANY store).
 * @param {string} prefix
 */
export function setLocalStorePrefix(prefix) {
    if (typeof prefix === 'string' && prefix) {
        LOCALSTORAGE_PREFIX = prefix;
    }
}

/**
 * Create a store that persists to localStorage
 * @param {string} name - Storage key name (prefix will be added automatically)
 * @param {any} initial - Initial value if not found in localStorage
 * @returns {ReturnType<typeof createStore>} Store object that auto-syncs to localStorage
 *
 * @example
 * const prefs = localStore('user-prefs', { theme: 'light', lang: 'en' });
 *
 * // Automatically loads from localStorage on creation
 * console.log(prefs.state.theme);
 *
 * // Automatically saves to localStorage on change
 * prefs.state.theme = 'dark';
 */
export function localStore(name, initial) {
    const key = `${LOCALSTORAGE_PREFIX}_${name}`;

    // Try to load from localStorage
    try {
        const data = window.localStorage.getItem(key);
        if (data !== null) {
            initial = JSON.parse(data);
        }
    } catch (e) {
        console.error('Failed to load from localStorage:', e);
    }

    const store = createStore(initial);

    // Subscribe to save changes
    store.subscribe(value => {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.error('Failed to save to localStorage:', e);
        }
    });

    return store;
}

/**
 * The three theme modes the app supports.
 *   'auto'  - follow the OS `prefers-color-scheme` (updates live)
 *   'light' - force light
 *   'dark'  - force dark
 * @type {readonly string[]}
 */
export const THEME_MODES = ['auto', 'light', 'dark'];

/**
 * Whether the browser/OS currently prefers a dark color scheme.
 * @returns {boolean}
 */
export function systemPrefersDark() {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Resolve a theme mode to a concrete "is dark" boolean.
 * 'auto' defers to the OS via {@link systemPrefersDark}.
 * @param {string} mode - One of {@link THEME_MODES}
 * @returns {boolean}
 */
export function resolveDarkMode(mode) {
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return systemPrefersDark(); // 'auto' (and any unknown value)
}

/**
 * Dark theme preference store
 * Note: Store must be an object, not a primitive, for reactivity to work
 * @private
 * @returns {ReturnType<typeof createStore>} Dark theme store
 */
function initDarkTheme() {
    const key = `${LOCALSTORAGE_PREFIX}_dark`;
    // Default to 'auto' so first-time visitors follow their OS preference.
    let initial = { mode: 'auto' };

    try {
        const data = window.localStorage.getItem(key);
        if (data !== null) {
            const parsed = JSON.parse(data);
            if (parsed && THEME_MODES.includes(parsed.mode)) {
                initial = { mode: parsed.mode };
            } else if (typeof parsed === 'boolean' || (parsed && typeof parsed.enabled === 'boolean')) {
                // Legacy two-state formats (`true`/`false` or `{ enabled }`).
                // Only an explicit `true` meant a real "dark" choice; `false`
                // was the old unconditional default, so migrate it to 'auto'.
                const enabled = typeof parsed === 'boolean' ? parsed : parsed.enabled;
                initial = { mode: enabled ? 'dark' : 'auto' };
            }
        }
    } catch (e) {
        console.error('Failed to load dark theme from localStorage:', e);
    }

    const store = createStore(initial);

    // Subscribe to save changes
    store.subscribe(value => {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.error('Failed to save dark theme to localStorage:', e);
        }
    });

    return store;
}

/**
 * Global dark theme store with localStorage persistence.
 * Holds `{ mode: 'auto' | 'light' | 'dark' }`.
 * @type {ReturnType<typeof createStore>}
 *
 * @example
 * // Read the current mode
 * darkTheme.state.mode;
 *
 * // Change it (prefer setThemeMode / cycleThemeMode)
 * setThemeMode('dark');
 */
export const darkTheme = initDarkTheme();

/**
 * Set the theme mode. Invalid values fall back to 'auto'.
 * @param {string} mode - One of {@link THEME_MODES}
 */
export function setThemeMode(mode) {
    darkTheme.update(() => ({ mode: THEME_MODES.includes(mode) ? mode : 'auto' }));
}

/**
 * Advance the theme mode: auto -> light -> dark -> auto.
 * @returns {string} The new mode
 */
export function cycleThemeMode() {
    const next = THEME_MODES[(THEME_MODES.indexOf(darkTheme.state.mode) + 1) % THEME_MODES.length];
    setThemeMode(next);
    return next;
}

/**
 * Keep `<body>`'s `dark` class in sync with the {@link darkTheme} store, and -
 * while in 'auto' mode - with live OS `prefers-color-scheme` changes. Applies
 * the current theme immediately (store `subscribe` runs its effect on start).
 *
 * Call from a component's `mounted()`; invoke the returned function in
 * `unmounted()` to detach both listeners.
 *
 * @returns {() => void} Unsubscribe function
 */
export function startThemeSync() {
    const apply = () => {
        document.body.classList.toggle('dark', resolveDarkMode(darkTheme.state.mode));
    };

    // subscribe() runs the effect immediately, so this also applies on start
    // and re-applies whenever the stored mode changes.
    const unsubscribeStore = darkTheme.subscribe(apply);

    let mq = null;
    const onSystemChange = () => {
        // Only the OS drives the theme while the user hasn't forced light/dark.
        if (darkTheme.state.mode === 'auto') apply();
    };
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        mq = window.matchMedia('(prefers-color-scheme: dark)');
        if (mq.addEventListener) mq.addEventListener('change', onSystemChange);
        else if (mq.addListener) mq.addListener(onSystemChange); // Safari < 14
    }

    return () => {
        unsubscribeStore();
        if (mq) {
            if (mq.removeEventListener) mq.removeEventListener('change', onSystemChange);
            else if (mq.removeListener) mq.removeListener(onSystemChange);
        }
    };
}

/**
 * Range utility (like Python's range) - generates array of numbers
 * @param {number} a - Start (or stop if b is null)
 * @param {number} [b=null] - Stop (exclusive)
 * @param {number} [step=1] - Step size
 * @returns {number[]} Array of numbers
 *
 * @example
 * range(5); // [0, 1, 2, 3, 4]
 * range(2, 5); // [2, 3, 4]
 * range(0, 10, 2); // [0, 2, 4, 6, 8]
 */
export function range(a, b = null, step = 1) {
    let start = 0;
    let stop = a;

    if (b !== null) {
        start = a;
        stop = b;
    }

    const result = [];
    for (let i = start; i < stop; i += step) {
        result.push(i);
    }

    return result;
}

// =============================================================================
// Lazy Component Loading
// =============================================================================

/**
 * Cache for lazy-loaded modules to prevent duplicate imports
 * @type {Map<Function, Promise<any>>}
 */
const lazyCache = new Map();

/**
 * Create a lazy-loadable component reference.
 *
 * Returns a promise that resolves when the component module is loaded.
 * The promise is cached, so multiple uses don't trigger multiple imports.
 * Works seamlessly with awaitThen() for loading states.
 *
 * @param {() => Promise<any>} importFn - Dynamic import function, e.g., () => import('./my-component.js')
 * @returns {Promise<true>} Promise that resolves to true when component is ready
 *
 * @example
 * // Define lazy component at module level (cached)
 * const LazyChart = lazy(() => import('./chart-component.js'));
 *
 * // Use with awaitThen in template
 * template() {
 *     return html`
 *         ${awaitThen(LazyChart,
 *             () => html`<chart-component data="${this.state.data}"></chart-component>`,
 *             html`<cl-spinner></cl-spinner>`
 *         )}
 *     `;
 * }
 *
 * @example
 * // Conditional lazy loading - define the lazy loader ONCE at module level.
 * // An inline lazy(() => import(...)) in the template would create a fresh
 * // cache entry and a fresh promise on every render (refetch + pending
 * // flash), because the cache is keyed by the import function's identity.
 * const AdvancedPanel = lazy(() => import('./advanced-panel.js'));
 * // in template():
 * ${when(this.state.showAdvanced,
 *     () => awaitThen(
 *         AdvancedPanel,
 *         () => html`<advanced-panel></advanced-panel>`,
 *         html`<cl-spinner size="small"></cl-spinner>`
 *     )
 * )}
 */
export function lazy(importFn) {
    // Return cached promise if already loading/loaded
    if (lazyCache.has(importFn)) {
        return lazyCache.get(importFn);
    }

    // Create and cache the loading promise
    const loadPromise = importFn()
        .then(module => {
            // Module loaded successfully
            // The component should be auto-registered via its defineComponent call
            return true;
        })
        .catch(error => {
            // Remove from cache on error so retry is possible
            lazyCache.delete(importFn);
            throw error;
        });

    lazyCache.set(importFn, loadPromise);
    return loadPromise;
}

/**
 * Preload a lazy component without rendering it.
 * Useful for preloading components the user is likely to need.
 *
 * @param {() => Promise<any>} importFn - Dynamic import function
 * @returns {Promise<true>} Promise that resolves when loaded
 *
 * @example
 * // Preload on hover for instant display when clicked
 * <button
 *     on-mouseenter="${() => preloadLazy(() => import('./heavy-dialog.js'))}"
 *     on-click="${() => this.state.showDialog = true}">
 *     Open Dialog
 * </button>
 */
export function preloadLazy(importFn) {
    return lazy(importFn);
}

/**
 * Clear the lazy loading cache.
 * Rarely needed - mainly for testing or memory optimization.
 *
 * @returns {void}
 */
export function clearLazyCache() {
    lazyCache.clear();
}

/**
 * Strip reactive proxies from an object for clean logging/serialization.
 * Recursively converts reactive proxies back to plain objects/arrays.
 *
 * @param {any} obj - Object to strip proxies from
 * @param {WeakSet} [seen] - Internal: tracks visited objects to handle cycles
 * @returns {any} Plain object without reactive proxies
 */
function stripProxies(obj, seen = new WeakSet()) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    // Handle circular references
    if (seen.has(obj)) {
        return '[Circular]';
    }
    seen.add(obj);

    // Handle arrays
    if (Array.isArray(obj)) {
        return obj.map(item => stripProxies(item, seen));
    }

    // Handle Date, RegExp, etc. - return as-is
    if (obj instanceof Date || obj instanceof RegExp || obj instanceof Error) {
        return obj;
    }

    // Handle plain objects (including reactive proxies)
    const plain = {};
    for (const key in obj) {
        // Skip internal reactive markers
        if (key === '__isReactive') continue;
        try {
            plain[key] = stripProxies(obj[key], seen);
        } catch (e) {
            plain[key] = '[Error accessing property]';
        }
    }
    return plain;
}

/**
 * Debug logging helper that doesn't create reactive dependencies.
 * Strips reactive proxies so objects print cleanly in console.
 *
 * @param {Function} fn - Function that returns array of values to log
 * @param {Object} [options] - Options object
 * @param {boolean} [options.json] - If true, output as JSON (useful for puppeteer)
 * @returns {void}
 *
 * @example
 * // Basic usage - pass a function to avoid creating dependencies
 * rlog(() => ['Current state:', this.state]);
 * rlog(() => ['Queue:', this.state.queue, 'Index:', this.state.index]);
 *
 * // With JSON output (useful for puppeteer)
 * rlog(() => ['Data:', this.state.items], { json: true });
 */
export function rlog(fn, options = {}) {
    if (typeof fn !== 'function') {
        console.warn('[rlog] First argument must be a function to avoid reactive tracking');
        console.log(fn);
        return;
    }

    // Read values without creating dependencies
    const stripped = withoutTracking(() => {
        const values = fn();
        const arr = Array.isArray(values) ? values : [values];
        return arr.map(arg => {
            if (arg === null || typeof arg !== 'object') {
                return arg;
            }
            return stripProxies(arg);
        });
    });

    if (options.json) {
        // JSON output for puppeteer or other tools lacking pretty printing
        const jsonArgs = stripped.map(arg => {
            if (typeof arg === 'string') {
                return arg;
            }
            try {
                return JSON.stringify(arg, null, 2);
            } catch (e) {
                return String(arg);
            }
        });
        console.log(...jsonArgs);
    } else {
        console.log(...stripped);
    }
}

/**
 * Default export for backward compatibility
 * @type {typeof notify}
 */
export default notify;
