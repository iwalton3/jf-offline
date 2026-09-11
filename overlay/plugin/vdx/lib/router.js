import { vdxCreateElement } from '/web/plugin/vdx-native-dom.js';
/**
 * Router System
 *
 * Client-side routing with support for:
 * - Hash-based routing (default)
 * - HTML5 History API routing (with <base> tag)
 * - Lazy loading routes with dynamic imports
 * - Route guards and hooks
 * - URL parameters (e.g., /product/:id/:sku)
 * - Query parameters (including hash mode: #/path?q=1)
 * - Reactive prop updates on same-component navigation
 * - Nested routes
 */

import { createStore, pruneTemplateCache, html, defineComponent } from './framework.js';

// Singleton router instance
let _router = null;

/**
 * Shallow compare two objects for equality
 * @private
 * @param {Object} a - First object
 * @param {Object} b - Second object
 * @returns {boolean} True if objects have same keys and values
 */
function shallowEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
        if (a[key] !== b[key]) return false;
    }
    return true;
}

/**
 * Get the singleton router instance
 * @returns {Router|null} The router instance, or null if not set
 */
export function getRouter() {
    return _router;
}

/**
 * Decode a URI component, falling back to the raw string on malformed
 * input (e.g. a stray '%') instead of throwing mid-navigation.
 * @private
 * @param {string} str - String to decode
 * @returns {string} Decoded string, or the input if decoding fails
 */
function safeDecodeURIComponent(str) {
    try {
        return decodeURIComponent(str);
    } catch {
        return str;
    }
}

/**
 * Parse query string into object
 * @private
 * @param {string} queryString - Query string to parse
 * @returns {Object<string, string>} Parsed query parameters
 */
function parseQuery(queryString) {
    if (!queryString) return {};

    const params = {};
    const pairs = queryString.split('&');

    for (const pair of pairs) {
        // Split on the FIRST '=' only: a value may legitimately contain '='
        // (base64, JWTs), which pair.split('=') destructured to 2 would truncate.
        const eq = pair.indexOf('=');
        const key = eq === -1 ? pair : pair.slice(0, eq);
        const value = eq === -1 ? '' : pair.slice(eq + 1);
        if (key) {
            params[safeDecodeURIComponent(key)] = safeDecodeURIComponent(value);
        }
    }

    return params;
}

/**
 * Convert object to query string
 * @private
 * @param {Object<string, any>} params - Parameters to stringify
 * @returns {string} Query string
 */
function stringifyQuery(params) {
    const pairs = [];

    for (const [key, value] of Object.entries(params)) {
        if (value != null) {
            pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
        }
    }

    return pairs.join('&');
}

/**
 * Validate a component name for security.
 * Custom element names must:
 * - Contain at least one hyphen
 * - Start with a lowercase letter
 * - Not contain uppercase letters
 * - Match the PotentialCustomElementName production from the HTML spec
 * @private
 * @param {string} name - Component name to validate
 * @returns {boolean} True if valid custom element name
 */
function isValidCustomElementName(name) {
    if (!name || typeof name !== 'string') {
        return false;
    }

    // Must contain a hyphen (required for custom elements)
    if (!name.includes('-')) {
        return false;
    }

    // Must start with lowercase letter
    if (!/^[a-z]/.test(name)) {
        return false;
    }

    // Must only contain valid characters (lowercase, digits, hyphens)
    // Per HTML spec: PCENChar (restricted for security)
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        return false;
    }

    // Reserved names that browsers won't allow
    const reserved = [
        'annotation-xml',
        'color-profile',
        'font-face',
        'font-face-src',
        'font-face-uri',
        'font-face-format',
        'font-face-name',
        'missing-glyph'
    ];

    if (reserved.includes(name)) {
        return false;
    }

    return true;
}

/**
 * Convert route pattern to regex and extract param names
 * @private
 * @param {string} pattern - Route pattern (e.g., '/product/:id/:sku')
 * @returns {{regex: RegExp, paramNames: string[]}} Compiled pattern
 */
function compileRoutePattern(pattern) {
    const paramNames = [];

    // Escape regex special chars except for our param syntax
    // NOTE: '*' must be in this class — the wildcard replace below looks for
    // the escaped form ':name\*'. Without it, ':path*' compiles to '([^/]+)*',
    // which never matches multi-segment paths and backtracks catastrophically.
    let regexStr = pattern
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        // Replace :paramName and :paramName* in a SINGLE left-to-right scan so
        // paramNames stays in the same order the capture groups appear in the
        // regex. A two-pass approach (all wildcards first, then all single
        // segments) desyncs the name order from the group order and swaps params
        // whenever a wildcard follows a named param. The trailing '\*' (escaped
        // '*') marks a multi-segment wildcard; lazy (.+?) so the optional
        // trailing slash isn't swallowed into the param.
        .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)(\\\*)?/g, (_, paramName, star) => {
            paramNames.push(paramName);
            return star ? '(.+?)' : '([^/]+)';
        });

    // Match with or without trailing slash
    if (regexStr.endsWith('/')) {
        regexStr = regexStr.slice(0, -1) + '/?';
    } else {
        regexStr = regexStr + '/?';
    }

    return {
        regex: new RegExp(`^${regexStr}$`),
        paramNames
    };
}

/**
 * Decode percent-encoding in a URL path, EXCEPT %2F and %25. Route matching
 * runs on the decoded path so static routes with non-ASCII segments
 * ('/café/') are reachable; %2F stays encoded so an encoded slash inside a
 * param value doesn't change segmentation, and %25 stays encoded so the
 * param-extraction decode (which handles those two leftovers) can't
 * double-decode a literal percent.
 * @private
 * @param {string} path - Raw URL path
 * @returns {string} Path with all but %2F/%25 sequences decoded
 */
function decodePath(path) {
    // Decode contiguous %xx runs as a unit (multi-byte UTF-8 characters span
    // several %xx sequences and cannot be decoded one at a time), splitting
    // at preserved %2F/%25 - safe cut points, since 0x2F and 0x25 are ASCII
    // and can never be continuation bytes of a multi-byte character.
    return path.replace(/(?:%[0-9a-fA-F]{2})+/g, run =>
        run.split(/(%2[fF]|%25)/)
            .map(part => (/^(?:%2[fF]|%25)$/.test(part) ? part : safeDecodeURIComponent(part)))
            .join('')
    );
}

/**
 * Join a parent route prefix and a child route path with exactly one slash.
 * An index child ('/' or '') lives at the parent's own path.
 * @private
 * @param {string} prefix - Flattened parent path ('' at the top level)
 * @param {string} path - Child route path
 * @returns {string} Joined path
 */
function joinPaths(prefix, path) {
    if (path === '/' || path === '') return prefix;
    const a = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    const b = path.startsWith('/') ? path : '/' + path;
    return a + b;
}

/**
 * Match a path against a compiled route pattern
 * @private
 * @param {string} path - URL path to match
 * @param {{regex: RegExp, paramNames: string[]}} compiledPattern - Compiled route pattern
 * @returns {{match: boolean, params: Object<string, string>}} Match result with extracted params
 */
function matchRoute(path, compiledPattern) {
    const match = path.match(compiledPattern.regex);

    if (!match) {
        return { match: false, params: {} };
    }

    const params = {};
    for (let i = 0; i < compiledPattern.paramNames.length; i++) {
        params[compiledPattern.paramNames[i]] = safeDecodeURIComponent(match[i + 1]);
    }

    return { match: true, params };
}

/**
 * Router class for managing client-side navigation
 *
 * @typedef {Object} RouteConfig
 * @property {string} [component] - Component tag name to render
 * @property {() => Promise<any>} [load] - Optional lazy load function (dynamic import)
 * @property {string} [require] - Optional capability requirement for access control
 * @property {Object} [meta] - Optional metadata for the route
 * @property {Object<string, RouteConfig>} [routes] - Optional nested routes
 * @property {string} [redirect] - Redirect to another path (supports $1, $2 for captured params)
 *
 * @example
 * const router = new Router({
 *   '/': {
 *     component: 'home-page',
 *     load: () => import('./home.js')
 *   },
 *   '/admin/': {
 *     component: 'admin-page',
 *     require: 'admin',
 *     load: () => import('./admin.js')
 *   }
 * });
 *
 * router.setOutlet(document.querySelector('router-outlet'));
 */
export class Router {
    /**
     * Create a new router instance
     * @param {Object<string, RouteConfig>} routes - Route configuration map
     * @param {Object} [options={}] - Router options
     * @param {(required: string, context: {path: string, query: Object, params: Object, route: RouteConfig}) => boolean|Promise<boolean>} [options.checkCapability]
     *     Called for routes with a `require` field; return true to allow navigation.
     *     Routes with `require` are DENIED if no checkCapability is configured (fail closed).
     * @param {(context: {path: string, query: Object, params: Object, require: string, route: RouteConfig}) => void} [options.onUnauthorized]
     *     Called when a `require` check fails. Defaults to rendering the /404 route.
     */
    constructor(routes, options = {}) {
        this.routes = {};
        this.beforeHooks = [];
        this.afterHooks = [];
        this.outletElement = null;
        this.loadedComponents = new Set(); // Track loaded components
        this._navToken = 0; // Monotonic navigation counter (stale handleRoute guard)
        // Last successfully committed URL (route-space path + query, still
        // encoded). Used to roll the address bar back when a before-hook
        // cancels a navigation whose URL was already committed.
        this._committedUrl = null;
        // Hash whose next hashchange event is consumed silently (set by the
        // cancelled-navigation URL rollback; the route is already displayed).
        this._suppressHashRoute = null;

        // Capability enforcement for routes with `require` (both may also be
        // assigned after construction: router.checkCapability = fn)
        this.checkCapability = options.checkCapability || null;
        this.onUnauthorized = options.onUnauthorized || null;

        // Detect routing mode: HTML5 (with base tag) or hash
        this.useHTML5 = this._detectRoutingMode();
        this.base = this._getBase();

        // Flatten nested routes
        this._flattenRoutes(routes);

        // Create reactive current route store
        this.currentRoute = createStore({
            path: '/',
            query: {},
            params: {},
            component: null,
            meta: {}
        });

        // Track listeners for cleanup
        this._listeners = [];

        // Setup listeners based on routing mode
        if (this.useHTML5) {
            // HTML5 routing: listen to popstate
            const popstateHandler = () => this.handleRoute();
            window.addEventListener('popstate', popstateHandler);
            this._listeners.push({ event: 'popstate', handler: popstateHandler });

            // Migrate legacy "#/..." hash-routes to clean URLs. Only hashes that
            // look like a route are handled; a plain in-page anchor (#section,
            // a TOC link) is left to the browser - treating it as a relative
            // route path would rewrite the URL and break the page.
            const hashchangeHandler = () => {
                const hash = window.location.hash;
                if (hash && hash.startsWith('#/')) {
                    this.replace(hash.slice(1));
                }
            };
            window.addEventListener('hashchange', hashchangeHandler);
            this._listeners.push({ event: 'hashchange', handler: hashchangeHandler });
        } else {
            // Hash routing: listen to hashchange
            const hashchangeHandler = () => {
                // A cancelled navigation's URL rollback (see
                // _restoreCommittedUrl) restores the hash of the route that is
                // ALREADY displayed - consume that one event silently.
                if (this._suppressHashRoute != null &&
                    window.location.hash.slice(1) === this._suppressHashRoute) {
                    this._suppressHashRoute = null;
                    return;
                }
                this._suppressHashRoute = null;
                this.handleRoute();
            };
            window.addEventListener('hashchange', hashchangeHandler);
            this._listeners.push({ event: 'hashchange', handler: hashchangeHandler });
        }

        // Handle initial route
        this.handleRoute();
    }

    /**
     * Clean up router resources
     * Call this when destroying the router instance
     * @returns {void}
     */
    destroy() {
        // Remove all event listeners
        this._listeners.forEach(({ event, handler }) => {
            window.removeEventListener(event, handler);
        });
        this._listeners = [];

        // Detach the outlet
        this.outletElement = null;

        // Clear hooks
        this.beforeHooks = [];
        this.afterHooks = [];

        // Release the singleton so enableRouting() can be called again
        if (_router === this) {
            _router = null;
        }
    }

    /**
     * Detect if we should use HTML5 routing (base tag present)
     * @private
     * @returns {boolean}
     */
    _detectRoutingMode() {
        const baseTag = document.querySelector('base[href]');
        return !!baseTag;
    }

    /**
     * Get base URL for routing
     * @private
     * @returns {string}
     */
    _getBase() {
        if (this.useHTML5) {
            const baseTag = document.querySelector('base[href]');
            if (baseTag) {
                let base = baseTag.getAttribute('href');
                // Remove trailing slash, but preserve empty string for root base
                if (base === '/') {
                    return '';
                }
                if (base.endsWith('/')) {
                    base = base.slice(0, -1);
                }
                return base;
            }
            // Fallback to empty base if no base tag in HTML5 mode
            return '';
        }
        // Hash routing needs no base - URLs are built as '#/path' directly
        return '';
    }

    /**
     * Flatten nested routes into flat map and compile patterns
     * @private
     * @param {Object<string, RouteConfig>} routes - Routes to flatten
     * @param {string} [prefix=''] - Path prefix for nested routes
     * @returns {void}
     */
    _flattenRoutes(routes, prefix = '') {
        for (const [path, config] of Object.entries(routes)) {
            // Slash-normalized join: '/admin/' + '/users/' -> '/admin/users/'
            // (naive concatenation produced '/admin//users/' - unroutable)
            const fullPath = joinPaths(prefix, path);

            // Compile route pattern (handles :param syntax)
            const compiled = compileRoutePattern(fullPath || '/');

            if (config.routes) {
                // Nested routes (children first, so a wildcard parent doesn't
                // shadow them in pattern-matching order)
                this._flattenRoutes(config.routes, fullPath);

                // Also register the parent route if it has a component - but
                // an explicit index child ('/' or '') takes precedence at the
                // parent's own path (the old code registered the parent LAST,
                // silently overwriting its index child).
                const hasIndexChild = '/' in config.routes || '' in config.routes;
                if (config.component && !hasIndexChild) {
                    this.routes[fullPath] = { ...config, _compiled: compiled };
                } else if (config.component && hasIndexChild) {
                    console.warn(
                        `[Router] "${fullPath || '/'}" defines both a component and an ` +
                        `index ('/') child route - the child route wins. Remove one.`
                    );
                }
            } else {
                // Leaf route
                this.routes[fullPath] = { ...config, _compiled: compiled };
            }
        }

        // Ensure root route exists
        if (!this.routes['']) {
            this.routes[''] = this.routes['/'] || { component: null, _compiled: compileRoutePattern('/') };
        }
    }

    /**
     * Navigate to a path (adds history entry)
     * @param {string} path - Path to navigate to (e.g., '/about', '/users/123')
     * @param {Object<string, string>} [query={}] - Optional query parameters
     * @returns {void}
     *
     * @example
     * router.navigate('/about');
     * router.navigate('/search', { q: 'test', page: '2' });
     */
    navigate(path, query = {}) {
        const queryString = stringifyQuery(query);
        const fullPath = queryString ? `${path}?${queryString}` : path;

        if (this.useHTML5) {
            // HTML5 routing: use pushState
            const url = this.base + fullPath;
            window.history.pushState({ path: fullPath }, '', url);
            this.handleRoute();
        } else {
            // Hash routing: use hash
            window.location.hash = fullPath;
        }
    }

    /**
     * Replace current route without adding history entry
     * @param {string} path - Path to navigate to
     * @param {Object<string, string>} [query={}] - Optional query parameters
     * @returns {void}
     *
     * @example
     * router.replace('/login'); // Replaces current entry
     */
    replace(path, query = {}) {
        const queryString = stringifyQuery(query);
        const fullPath = queryString ? `${path}?${queryString}` : path;

        if (this.useHTML5) {
            // HTML5 routing: use replaceState
            const url = this.base + fullPath;
            window.history.replaceState({ path: fullPath }, '', url);
            this.handleRoute();
        } else {
            // Hash routing: use hash
            window.location.replace(`#${fullPath}`);
        }
    }

    /**
     * Go back in browser history
     * @returns {void}
     */
    back() {
        window.history.back();
    }

    /**
     * Go forward in browser history
     * @returns {void}
     */
    forward() {
        window.history.forward();
    }

    /**
     * Register a before-navigation hook (runs before route changes)
     * @param {(context: {path: string, query: Object, route: RouteConfig}) => boolean|void|Promise<boolean|void>} fn - Hook function (return false to cancel navigation)
     * @returns {void}
     *
     * @example
     * router.beforeEach(({ path, route }) => {
     *   if (route.require && !hasPermission(route.require)) {
     *     router.navigate('/unauthorized');
     *     return false; // Cancel navigation
     *   }
     * });
     */
    beforeEach(fn) {
        this.beforeHooks.push(fn);
    }

    /**
     * Register an after-navigation hook (runs after route changes)
     * @param {(context: {path: string, query: Object, route: RouteConfig}) => void|Promise<void>} fn - Hook function
     * @returns {void}
     *
     * @example
     * router.afterEach(({ path }) => {
     *   console.log('Navigated to:', path);
     *   trackPageView(path);
     * });
     */
    afterEach(fn) {
        this.afterHooks.push(fn);
    }

    /**
     * Find a route matching the given path
     * @private
     * @param {string} path - URL path to match
     * @returns {{route: RouteConfig|null, params: Object<string, string>}} Matched route and extracted params
     */
    _findRoute(path) {
        // Normalize path - ensure it starts with /
        if (!path) path = '/';
        if (!path.startsWith('/')) path = '/' + path;

        // First, try exact match (most common case, fastest)
        let route = this.routes[path];
        if (route) {
            return { route, params: {} };
        }

        // Try without trailing slash
        if (path.endsWith('/') && path.length > 1) {
            route = this.routes[path.slice(0, -1)];
            if (route) {
                return { route, params: {} };
            }
        }

        // Try with trailing slash
        if (!path.endsWith('/')) {
            route = this.routes[path + '/'];
            if (route) {
                return { route, params: {} };
            }
        }

        // No exact match - try pattern matching for routes with :params
        for (const [pattern, routeConfig] of Object.entries(this.routes)) {
            if (!routeConfig._compiled) continue;

            const result = matchRoute(path, routeConfig._compiled);
            if (result.match) {
                return { route: routeConfig, params: result.params };
            }
        }

        // Fallback to 404 or root
        return {
            route: this.routes['/404'] || this.routes[''] || { component: null },
            params: {}
        };
    }

    /**
     * Handle route change
     * @private
     * @returns {Promise<void>}
     */
    async handleRoute() {
        // Each invocation claims a token; after any await, a newer token means
        // another navigation superseded this one and it must not touch state.
        // Without this, a slow lazy-load can render its (older) destination
        // over a navigation that already completed.
        const navToken = ++this._navToken;

        let path, queryString;

        if (this.useHTML5) {
            // HTML5 routing: parse from pathname
            const fullPath = window.location.pathname;
            // Remove base from path
            let relativePath = fullPath;
            if (this.base && this.base.length > 0 && fullPath.startsWith(this.base)) {
                relativePath = fullPath.slice(this.base.length);
            }
            if (!relativePath.startsWith('/')) {
                relativePath = '/' + relativePath;
            }

            // Get query from search
            queryString = window.location.search.slice(1);
            [path] = relativePath.split('?');
        } else {
            // Hash routing: parse from hash. Split on the FIRST '?' only, so a
            // query value containing '?' (e.g. ?next=/detail?tab=2) is preserved.
            const hash = window.location.hash.slice(1) || '';
            const qi = hash.indexOf('?');
            path = qi === -1 ? hash : hash.slice(0, qi);
            queryString = qi === -1 ? '' : hash.slice(qi + 1);
        }

        // Ensure path starts with /
        if (!path) path = '/';
        if (!path.startsWith('/')) path = '/' + path;

        // The raw (still-encoded) route-space URL of this navigation -
        // recorded as _committedUrl once it succeeds, and what a cancelled
        // later navigation rolls the address bar back to.
        const rawFullPath = queryString ? `${path}?${queryString}` : path;

        // Match against the DECODED path so static routes with non-ASCII
        // segments ('/café/') are reachable. %2F/%25 stay encoded (see
        // decodePath); matchRoute's param decode handles those leftovers.
        path = decodePath(path);

        const query = parseQuery(queryString);

        // Find matching route with params
        const { route, params } = this._findRoute(path);

        // Handle redirects
        if (route.redirect) {
            // Loop guard: A->B->A... would recurse forever (synchronous stack
            // overflow in HTML5 mode, a runaway hashchange storm in hash mode).
            this._redirectCount = (this._redirectCount || 0) + 1;
            if (this._redirectCount > 10) {
                console.error(
                    `[Router] Redirect loop detected (>10 hops) at "${path}" - aborting.`
                );
                this._redirectCount = 0;
                return;
            }
            let redirectPath = route.redirect;
            // Substitute captured params ($1, $2, ... or :name). Values are
            // re-encoded (slashes preserved for multi-segment wildcards) so
            // the redirected navigation's own decode isn't a SECOND decode of
            // already-decoded text.
            const encodeParam = (v) => encodeURIComponent(v).replace(/%2F/gi, '/');
            const paramValues = Object.values(params);
            // Single-pass numeric substitution: replaces EVERY occurrence, and
            // '$10' can't be consumed as '$1' followed by '0'.
            redirectPath = redirectPath.replace(/\$(\d+)/g, (token, n) => {
                const v = paramValues[Number(n) - 1];
                return v === undefined ? token : encodeParam(v);
            });
            // Named params, boundary-guarded so ':id' can't eat into ':idx'.
            for (const [name, value] of Object.entries(params)) {
                const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                redirectPath = redirectPath.replace(
                    new RegExp(`:${escaped}(?![A-Za-z0-9_])`, 'g'),
                    () => encodeParam(value)
                );
            }
            // A redirect target may carry its own query ('/x?tab=1'): merge it
            // with the incoming query (target's params win) instead of letting
            // replace() append a second '?' after it.
            let redirectQuery = query;
            const rqi = redirectPath.indexOf('?');
            if (rqi !== -1) {
                redirectQuery = { ...query, ...parseQuery(redirectPath.slice(rqi + 1)) };
                redirectPath = redirectPath.slice(0, rqi);
            }
            this.replace(redirectPath, redirectQuery);
            return;
        }
        // Reached a non-redirect route: we made real progress, reset the guard.
        this._redirectCount = 0;

        // Capability enforcement: routes with `require` are denied unless
        // checkCapability approves. Fails closed - `require` with no
        // checkCapability configured denies rather than silently allowing.
        if (route.require) {
            let allowed = false;
            if (typeof this.checkCapability === 'function') {
                try {
                    allowed = await this.checkCapability(route.require, { path, query, params, route });
                } catch (err) {
                    // A throwing/rejecting capability check must fail CLOSED, not
                    // leave navigation dead with a lying URL.
                    console.error(`[Router] checkCapability threw for "${path}" - denying.`, err);
                    allowed = false;
                }
                if (navToken !== this._navToken) return; // Superseded during check
            } else {
                console.warn(
                    `[Router] Route "${path}" has require: "${route.require}" but no ` +
                    `checkCapability function is configured - denying navigation. ` +
                    `Set checkCapability via enableRouting options or router.checkCapability.`
                );
            }
            if (!allowed) {
                // What's displayed now (custom handler UI or the 404 fallback)
                // lives at THIS URL - it is the new committed state.
                this._committedUrl = rawFullPath;
                if (typeof this.onUnauthorized === 'function') {
                    this.onUnauthorized({ path, query, params, require: route.require, route });
                } else {
                    // Default: render the 404 route (don't reveal protected routes)
                    const fallback = this.routes['/404'] || { component: 'page-not-found' };
                    this.currentRoute.set({
                        path,
                        query,
                        params: {},
                        component: fallback.component,
                        meta: fallback.meta || {}
                    });
                    this._renderOutlet();
                }
                return;
            }
        }

        // Run before hooks
        for (const hook of this.beforeHooks) {
            const result = await hook({ path, query, params, route });
            if (navToken !== this._navToken) return; // Superseded during hook
            if (result === false) {
                // Navigation cancelled. The URL was already committed
                // (pushState / the hash change happen before hooks run), so
                // roll the address bar back to the last committed URL rather
                // than leaving it pointing at content that never rendered.
                this._restoreCommittedUrl(rawFullPath);
                return;
            }
        }

        // Past the guards - this URL is what will be rendered.
        this._committedUrl = rawFullPath;

        // Lazy load component if needed
        if (route.load && route.component && !this.loadedComponents.has(route.component)) {
            try {
                await route.load();
                this.loadedComponents.add(route.component);
            } catch (error) {
                console.error(`Failed to load component for route ${path}:`, error);
                if (navToken !== this._navToken) return; // Superseded during load
                // Fallback to 404 on load error
                const fallback = this.routes['/404'] || { component: 'page-not-found' };
                this.currentRoute.set({
                    path,
                    query,
                    params: {},
                    component: fallback.component,
                    meta: fallback.meta || {}
                });
                this._renderOutlet();
                return;
            }
            if (navToken !== this._navToken) return; // Superseded during load
        }

        // Update current route
        this.currentRoute.set({
            path,
            query,
            params,
            component: route.component,
            meta: route.meta || {}
        });

        // Render component (handles same-component prop updates)
        this._renderOutlet();

        // Run after hooks
        for (const hook of this.afterHooks) {
            await hook({ path, query, params, route });
            if (navToken !== this._navToken) return; // Superseded during hook
        }

        // Clean up template cache on navigation to prevent unbounded growth
        pruneTemplateCache();
    }

    /**
     * Roll the address bar back to the last committed URL after a cancelled
     * navigation (the URL commits before the before-hooks run). Rolls back
     * only while the address bar still shows the cancelled URL - a guard that
     * redirects (`router.navigate('/login'); return false;`) has already
     * repointed it, and that navigation must win.
     * @private
     * @param {string} cancelledUrl - Raw route-space URL of the cancelled navigation
     * @returns {void}
     */
    _restoreCommittedUrl(cancelledUrl) {
        const committed = this._committedUrl;
        if (committed == null || committed === cancelledUrl) return;
        if (this.useHTML5) {
            // replaceState fires no popstate - the displayed (committed) route
            // is untouched, only the address bar is corrected.
            if (window.location.pathname + window.location.search === this.base + cancelledUrl) {
                window.history.replaceState({ path: committed }, '', this.base + committed);
            }
        } else if (window.location.hash.slice(1) === cancelledUrl) {
            // The displayed content already matches the committed URL, so the
            // hashchange this restore fires must not re-run the route (it
            // would re-run hooks for a route that never left the screen).
            this._suppressHashRoute = committed;
            window.location.replace(`#${committed}`);
        }
    }

    /**
     * Merge additional routes into the routing table. New definitions for
     * already-registered paths replace the old ones (keeping their original
     * pattern-matching position); genuinely new paths are appended, so a new
     * specific route added after an existing greedy wildcard will only be
     * reachable via exact match. The current location is re-evaluated against
     * the updated table.
     * @param {Object<string, RouteConfig>} routes - Routes to merge
     * @returns {void}
     */
    addRoutes(routes) {
        this._flattenRoutes(routes);
        // Re-match the current location - the merged routes may change what
        // should be rendered right now
        this.handleRoute();
    }

    /**
     * Set the outlet element where routed components will be rendered
     * @param {HTMLElement} element - Router outlet element (typically <router-outlet>)
     * @returns {void}
     *
     * @example
     * router.setOutlet(document.querySelector('router-outlet'));
     */
    setOutlet(element) {
        this.outletElement = element;

        // Render the current route into the new outlet immediately. Route
        // changes render through the explicit _renderOutlet() calls in
        // handleRoute() - a currentRoute subscription here would make every
        // navigation render twice.
        this._renderOutlet();
    }

    /**
     * Render the current component in the outlet
     * Handles same-component navigation by updating props instead of recreating
     * @private
     * @returns {void}
     */
    _renderOutlet() {
        if (!this.outletElement) {
            return;
        }

        const { component, params, query } = this.currentRoute.state;

        if (!component) {
            // Fallback if no component is found (should not happen with proper 404 route)
            // SECURITY: Use createElement instead of innerHTML to prevent potential injection
            this.outletElement.textContent = ''; // Clear safely
            const notFoundElement = vdxCreateElement('page-not-found');
            this.outletElement.appendChild(notFoundElement);
            return;
        }

        // SECURITY: Validate component name before createElement
        if (!isValidCustomElementName(component)) {
            console.error(`[Router] Invalid component name: "${component}". Component names must be lowercase, contain a hyphen, and start with a letter.`);
            this.outletElement.textContent = ''; // Clear safely
            const errorElement = vdxCreateElement('page-not-found');
            this.outletElement.appendChild(errorElement);
            return;
        }

        // A detached outlet is dead: its host was removed (navigation away
        // from the layout that owned it). Rendering into it does invisible
        // work and can resurrect components outside the document. (Config
        // errors above are still reported for detached outlets.)
        if (!this.outletElement.isConnected) {
            return;
        }

        // Self-mount guard: when the outlet sits INSIDE an element of the
        // very component about to be rendered (the documented layout pattern:
        // a routed component calling setOutlet() on its own <router-outlet>),
        // rendering would nest the component inside itself indefinitely
        // (mount -> setOutlet -> render -> mount -> ...). The inner outlet
        // exists for OTHER (child) routes; skip same-component renders.
        if (this.outletElement.closest(component)) {
            return;
        }

        // Check if we can reuse the existing component (same tag name)
        const existingElement = this.outletElement.firstElementChild;
        if (existingElement && existingElement.tagName.toLowerCase() === component) {
            // Same component - update props only if changed (shallow compare)
            // This prevents unnecessary propsChanged calls
            const next = {};
            if (!shallowEqual(existingElement.params, params)) {
                next.params = params;
            }
            if (!shallowEqual(existingElement.query, query)) {
                next.query = query;
            }
            if (typeof existingElement.setProps === 'function') {
                // Batched: both backing values update before either
                // propsChanged fires, so handlers see a consistent route
                if (next.params || next.query) {
                    existingElement.setProps(next);
                }
            } else {
                if (next.params) existingElement.params = next.params;
                if (next.query) existingElement.query = next.query;
            }
        } else {
            // Different component - create new element
            const element = vdxCreateElement(component);

            // Set params and query as properties (not attributes)
            // This allows passing objects directly to the component
            element.params = params;
            element.query = query;

            // Replace outlet content
            this.outletElement.innerHTML = '';
            this.outletElement.appendChild(element);

        }
    }

    /**
     * Generate URL for a route (respects routing mode)
     * @param {string} path - Route path
     * @param {Object<string, string>} [query={}] - Optional query parameters
     * @returns {string} Complete URL (hash or HTML5 based on mode)
     *
     * @example
     * router.url('/about'); // Returns '#/about' or '/app/about' depending on mode
     * router.url('/search', { q: 'test' }); // '/search?q=test'
     */
    url(path, query = {}) {
        const queryString = stringifyQuery(query);
        const fullPath = queryString ? `${path}?${queryString}` : path;

        if (this.useHTML5) {
            return this.base + fullPath;
        } else {
            return `#${fullPath}`;
        }
    }
}

function init() {
    defineComponent('router-link', {
        props: {
            to: '/'
        },

        methods: {
            handleClick(e) {
                // Intercept clicks for HTML5 routing
                if (_router && _router.useHTML5) {
                    e.preventDefault();
                    _router.navigate(this.props.to);
                }
            }
        },

        template() {
            const href = _router ? _router.url(this.props.to) : `#${this.props.to}`;

            return html`
                <a href="${href}" on-click="handleClick">${this.props.children}</a>
            `;
        }
    });


    if (customElements.get('router-outlet')) {
        return;
    }

    class RouterOutlet extends HTMLElement {
        connectedCallback() {
            // Router will find this and use it
        }
    }

    customElements.define('router-outlet', RouterOutlet);
}

init();

/**
 * Enable routing for a specific outlet element.
 * On the first call, creates the singleton router. If called again, warns
 * and merges: new routes are folded into the existing table (definitions
 * for already-registered paths replace the old ones), any provided
 * checkCapability/onUnauthorized options are applied, and the outlet is
 * reattached. Call getRouter().destroy() first if you genuinely want a
 * fresh router.
 * @param {RouterOutlet} outlet router outlet element
 * @param {Object<string, RouteConfig>} routes object defining routes
 * @param {Object} [options] router options (checkCapability, onUnauthorized - see Router constructor)
 * @returns {Router} The singleton router instance
 */
export function enableRouting(outlet, routes, options = {}) {
    if (_router) {
        console.warn(
            '[Router] enableRouting() called again - merging routes into the ' +
            'existing router and reattaching the outlet. Call getRouter().destroy() ' +
            'first if you want a fresh router.'
        );
        if (options.checkCapability) _router.checkCapability = options.checkCapability;
        if (options.onUnauthorized) _router.onUnauthorized = options.onUnauthorized;
        _router.addRoutes(routes);
        _router.setOutlet(outlet);
        return _router;
    }
    _router = new Router(routes, options);
    _router.setOutlet(outlet);
    return _router;
}