/**
 * Template System with Automatic Context-Aware Security
 * Provides XSS protection by automatically detecting interpolation context
 */

import * as templateCompiler from './template-compiler.js';
// Trust-marker Symbols and is* predicates live in the dependency-free
// markers.js leaf (reactivity.js needs them too and cannot import this
// module without a cycle). Re-exported here so the public API is unchanged.
import {
    HTML_MARKER, RAW_MARKER, CONTAIN_MARKER, MEMO_EACH_MARKER, WHEN_MARKER,
    isHtml, isRaw, isContain, isMemoEach, isWhen
} from './markers.js';

export { HTML_MARKER, isHtml, isRaw, isContain, isMemoEach, isWhen };

/**
 * Whether two compiled templates are the SAME template. Identity comparison,
 * widened to statics-array identity: after an LRU cache eviction, a template
 * recompiles to a fresh (structurally identical) object - the shared statics
 * reference proves it came from the same call site, so consumers can keep
 * their DOM and update values in place instead of re-instantiating.
 * @param {Object|null} a
 * @param {Object|null} b
 * @returns {boolean}
 */
export function isSameCompiled(a, b) {
    return a === b || !!(a && b && a._statics && a._statics === b._statics);
}

// Op codes for the instruction-based system
export const OP = {
    STATIC: 0,      // Return pre-built VNode
    SLOT: 1,        // Insert dynamic value from slot
    TEXT: 2,        // Static text
    ELEMENT: 3,     // Build element with props/children
    FRAGMENT: 4,    // Build fragment
};

/**
 * Normalize input to prevent encoding attacks
 */
function normalizeInput(input) {
    if (input == null) return '';
    let str = String(input);

    // Remove null bytes (common bypass technique)
    str = str.replace(/\x00/g, '');

    // Remove BOM markers
    str = str.replace(/^\uFEFF/, '');

    // Unicode NFC normalization (prevents different representations of same character)
    if (typeof str.normalize === 'function') {
        str = str.normalize('NFC');
    }

    // Remove non-characters (U+FDD0-U+FDEF, U+FFFE, U+FFFF)
    str = str.replace(/[\uFDD0-\uFDEF\uFFFE\uFFFF]/g, '');

    // Remove control characters (except tab, LF, CR)
    str = str.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');

    return str;
}


// What a BLOCKED url is replaced with. Not '': an empty href resolves to the
// current document (so a blocked link would silently reload the page, and in a
// frame would re-enter the frame's own document), and an empty src re-requests
// the current page in some browsers. about:blank is inert in both roles.
//
// This is for blocked values ONLY. An absent or empty binding is not a blocked
// URL and must stay '' so the renderer can drop the attribute - substituting
// about:blank there would materialize a navigable URL where the author wrote
// nothing. sanitizeUrl('') therefore still returns ''.
//
// Tradeoff: about:blank is the correct inert value for navigable targets
// (href/action/formaction) and for <iframe src>, but it is not a fetchable
// scheme, so a blocked <img>/<audio>/<video> src logs one
// net::ERR_UNKNOWN_URL_SCHEME in Chrome. That is accepted - it accompanies the
// [VDX Security] warning already emitted, and the alternative ('') makes the
// element re-request the current document, which is the actual bug being fixed.
const BLOCKED_URL = 'about:blank';

/**
 * Sanitize URL - blocks dangerous schemes like javascript:
 * No HTML escaping needed since URLs are set as DOM properties directly.
 * The browser handles href/src/action properties natively.
 *
 * Returns the original URL when safe, or 'about:blank' when blocked. Empty or
 * nullish input returns '' (nothing to block, nothing to navigate to).
 *
 * SCOPE: this answers "can this URL execute code", not "where does this URL
 * point". It deliberately allows http/https to any host, so it is not - and
 * cannot be - an origin check: 'https://evil.com' is a legitimate pass. Code
 * that needs a destination guarantee (open-redirect handling, same-origin
 * form targets) must do its own origin comparison on the resolved URL.
 */
export function sanitizeUrl(url) {
    const normalized = normalizeInput(url);

    // Remove all whitespace (including Unicode whitespace)
    const cleaned = normalized.replace(/\s/g, '');

    // NOTE: no HTML-entity decoding here, deliberately. Sanitized URLs are set
    // as DOM attributes/properties, never serialized into markup that an HTML
    // parser re-reads, so '&#58;' in a URL string stays those five literal
    // characters and never becomes a colon. Decoding a fixed list of entities
    // would be defense against a parser that isn't in the path - and would be
    // incomplete anyway, since numeric references allow arbitrary leading zeros
    // and hex casing ('&#058;', '&#x003a;'). If a serializing path is ever
    // added, the fix is a real reference decoder, not a longer replace() chain.

    // Extract scheme (everything before first colon)
    const schemeMatch = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+.-]*?):/);

    if (!schemeMatch) {
        // No scheme: the URL inherits the document's scheme, which is already
        // allowlisted below, so this cannot introduce a script-capable scheme.
        // The regex mirrors the URL spec's scheme grammar, and normalizeInput()
        // has already removed the C0 controls the parser would strip, so a
        // scheme cannot hide from it here.
        //
        // Scheme-less does NOT imply same-origin ('//evil.com' and the
        // backslash-folded '\\evil.com' resolve to a foreign host), but per
        // this function's SCOPE above that is not its question - see the
        // canary test in tests/framework/template.test.js.
        return normalized;
    }

    const scheme = schemeMatch[1].toLowerCase();

    // data: URLs are allowed only for non-scriptable media types.
    // data:text/html and data:image/svg+xml can execute script when navigated.
    if (scheme === 'data') {
        const mimeMatch = cleaned.match(/^data:([^;,]*)[;,]/i);
        const mime = (mimeMatch?.[1] || '').toLowerCase();
        if (/^(image\/(?!svg)|audio\/|video\/|font\/)/.test(mime)) {
            return normalized;
        }
        console.warn('[VDX Security] Blocked data: URL with unsafe media type:', url);
        return BLOCKED_URL;
    }

    // Allowlist of safe schemes.
    // blob: URLs can only be created by same-origin code via createObjectURL,
    // so they are safe to bind (needed for media from IndexedDB/streams).
    const safeSchemes = ['http', 'https', 'mailto', 'tel', 'sms', 'ftp', 'ftps', 'blob'];

    if (!safeSchemes.includes(scheme)) {
        console.warn('[VDX Security] Blocked dangerous URL scheme:', url);
        return BLOCKED_URL;
    }

    return normalized;
}

/**
 * Tagged template literal with automatic context-aware escaping
 *
 * Uses compiled templates for performance:
 * - Parses template once and caches
 * - Creates structured tree
 * - Fills slots on each render
 * - No regex parsing on render!
 *
 * Returns a special object that can be nested without double-escaping
 */
export function html(strings, ...values) {
    const { compileTemplate } = html._compiler;
    const compiled = compileTemplate(strings);

    return {
        [HTML_MARKER]: true,
        _compiled: compiled,
        _values: values,
        toString() {
            return '';  // Not used in production
        }
    };
}

/**
 * Mark string as safe raw HTML (use sparingly!)
 * Only use this for content you absolutely trust (e.g., your own API responses)
 * Security: Use Symbol for trust verification (JSON can't fake this)
 */
export function raw(htmlString) {
    return {
        [RAW_MARKER]: true,
        toString() {
            return htmlString;
        }
    };
}


/**
 * Conditional rendering helper
 * Returns thenValue if condition is truthy, otherwise returns elseValue (default: null)
 * @param {boolean} condition - Condition to evaluate
 * @param {*} thenValue - Value to return if condition is true
 * @param {*} elseValue - Value to return if condition is false (default: null)
 */
// Cached empty template for when() false case - stable reference for fine-grained diffing
const EMPTY_COMPILED = {
    op: OP.STATIC,
    template: null,
    type: 'fragment',
    wrapped: false,
    children: []
};
export const EMPTY_WHEN_RESULT = {
    [HTML_MARKER]: true,
    _compiled: EMPTY_COMPILED,
    toString() {
        return '';
    }
};

/**
 * Select a when() marker's branch, nested when()s included, running a thunk
 * branch inline so the CALLER's effect tracks what it reads. A branch that
 * comes back nullish or false becomes EMPTY_WHEN_RESULT: an html marker that
 * renders nothing but compares stably. Anything that is not a when() marker
 * comes back untouched. The one implementation for the slot, the contain()
 * boundary, and the keyed list item.
 */
export function resolveWhen(value) {
    while (isWhen(value)) {
        const branch = value._condition ? value._thenValue : value._elseValue;
        value = typeof branch === 'function' ? branch() : branch;
        if (value == null || value === false) return EMPTY_WHEN_RESULT;
    }
    return value;
}

export function when(condition, thenValue, elseValue = null) {
    const isFunctionForm = typeof thenValue === 'function' || typeof elseValue === 'function';

    // For function forms, return a marker object that gets cached at DOM position
    // This fixes the bug where the same function used in multiple when() calls shares cache
    if (isFunctionForm) {
        return {
            [WHEN_MARKER]: true,
            [HTML_MARKER]: true,  // Mark as html-like so slot renderer handles it
            _condition: !!condition,
            _thenValue: thenValue,
            _elseValue: elseValue,
            _compiled: {
                op: OP.SLOT,
                type: 'when'
            },
            toString() { return '[when]'; }
        };
    }

    // Non-function form - evaluate immediately (no caching benefit)
    const result = condition ? thenValue : elseValue;

    // React-like semantics, matching the function form (renderer when-loop):
    // null/undefined/false render nothing; 0 and '' are real values and render.
    // Returns the empty template for stable reference in fine-grained diffing.
    if (result == null || result === false) {
        return EMPTY_WHEN_RESULT;
    }

    // Handle html template objects (check Symbol for security)
    if (isHtml(result)) {
        return result;
    }

    // Otherwise return as-is (primitives, etc)
    return result;
}

/**
 * Create a reactive boundary - isolates state tracking from parent template.
 * Use this to prevent high-frequency state updates (like currentTime) from
 * causing the entire parent template to re-render.
 *
 * The render function is evaluated in its own isolated effect, so only state
 * accessed within the function triggers re-renders of this boundary.
 *
 * @param {Function} renderFn - Function that returns html template
 * @returns {Object} Contained template result
 *
 * @example
 * // Without contain: entire template re-renders when currentTime changes
 * template() {
 *     return html`
 *         <div class="queue">${memoEach(this.state.queue, ...)}</div>
 *         <div class="time">${this.stores.player.currentTime}</div>
 *     `;
 * }
 *
 * // With contain: only the time display re-renders
 * template() {
 *     return html`
 *         <div class="queue">${memoEach(this.state.queue, ...)}</div>
 *         ${contain(() => html`
 *             <div class="time">${this.stores.player.currentTime}</div>
 *         `)}
 *     `;
 * }
 */
// Stable singleton for contain() _compiled - enables reference equality checks
// Reactivity system excludes HTML_MARKER-stamped vnodes from proxying
const CONTAIN_COMPILED = Object.freeze({
    op: OP.SLOT,
    type: 'contain',
    isContain: true
});

export function contain(renderFn) {
    if (typeof renderFn !== 'function') {
        console.warn('[contain] Expected a function, got:', typeof renderFn);
        return renderFn;
    }

    // Return a special marker object that template-renderer will handle
    // by creating an isolated effect for this boundary
    return {
        [CONTAIN_MARKER]: true,
        [HTML_MARKER]: true,  // Also mark as html so it's handled as a slot value
        _renderFn: renderFn,
        _compiled: CONTAIN_COMPILED,  // Use singleton for stable reference
        toString() { return '[contain]'; }
    };
}

/**
 * Describe a rejected list-item value for the toKeyedChild guard message.
 * Names the type, plus a short preview for primitives - long enough to
 * recognise the value, short enough not to spill a record into a log. Never
 * JSON.stringify: it throws on a BigInt, which would replace the guard's
 * message with a confusing one from its own error path.
 */
function describeItemResult(result) {
    if (Array.isArray(result)) return 'an array (use a nested each())';
    if (isRaw(result)) return 'a raw() value';
    if (typeof result === 'function') return 'a function (call it, or use when() for a branch)';
    if (typeof result === 'object') return 'an object';
    let preview;
    try {
        preview = String(result);
    } catch {
        return `a ${typeof result}`;   // Symbol.toPrimitive can throw
    }
    if (preview.length > 30) preview = preview.slice(0, 30) + '…';
    return `a ${typeof result} (${preview})`;
}

/**
 * Convert one mapFn result into a keyed compiled child for list
 * reconciliation. Shared by each() and the renderer's memoEach paths
 * (previously triplicated).
 *
 * - Whitespace-only text nodes are dropped (returns null).
 * - An unwrapped single-element fragment is unwrapped so the key lands on
 *   the element (keyed reconciliation needs keys on elements).
 * - _src records the stable compiled template node the copy derives from,
 *   so keyed diffing can detect an item switching templates.
 * - A when() marker is resolved to its branch first; contain()/memoEach() and
 *   non-template values are refused loudly rather than dropped.
 *
 * @param {Object|null} result - A mapFn result carrying _compiled/_values
 * @param {*} key - The reconciliation key for this item
 * @returns {Object|null} Keyed compiled child, or null to skip
 */
export function toKeyedChild(result, key) {
    // Lazy directives keep their payload on the marker and put only a stub in
    // _compiled, so the flatten-to-_compiled below would drop the whole item -
    // silently, because the stub is truthy. Resolve or refuse them here.
    //
    // when() resolves: a list item root is not a slot, so the marker's
    // per-DOM-position branch cache has nowhere to live, and keyed
    // reconciliation needs the real template to compare item shapes. Nothing is
    // lost - each() re-runs mapFn every render anyway, so the branch thunk was
    // never being deferred past this point.
    result = resolveWhen(result);   // EMPTY_WHEN_RESULT keeps the key slot, renders nothing

    // contain() and memoEach() cannot be resolved the same way: their state
    // (the isolated effect / the memo cache) is owned by the slot they sit in,
    // and an item root has no slot. html`` gives them one.
    if (isContain(result) || isMemoEach(result)) {
        const name = isContain(result) ? 'contain' : 'memoEach';
        throw new Error(
            `${name}() cannot be a list item template on its own - it needs a slot to own ` +
            `its state, and a list item root is not one. Give it one: ` +
            'item => html`<li>${' + name + '(...)}</li>`'
        );
    }

    if (result == null || result === false) return null;

    if (!result._compiled) {
        throw new Error(
            'A list item template must return an html`` template - got ' +
            describeItemResult(result) + '. A value with no compiled template gets no ' +
            'keyed placeholder, so the item renders nothing at all. Wrap it: ' +
            'item => html`${value}`'
        );
    }

    const child = result._compiled;
    const childValues = result._values;  // Preserve values from nested template

    if (child.type === 'text' && child.value && /^\s*$/.test(child.value)) {
        return null;
    }

    if (child.type === 'fragment' && !child.wrapped && child.children.length === 1 && child.children[0].type === 'element') {
        const element = child.children[0];
        return { ...element, key, _itemValues: childValues, _src: element._src || element };
    }

    return { ...child, key, _itemValues: childValues, _src: child._src || child };
}

/**
 * Loop rendering helper with optional key support
 * Maps array items to templates and returns safe concatenated HTML or compiled fragment
 * @param {Array} array - Array to iterate over
 * @param {Function} mapFn - Function to map each item to a template
 * @param {Function} [keyFn] - Optional function to extract unique key from each item (e.g., item => item.id)
 */
export function each(array, mapFn, keyFn = null) {
    if (!array || !Array.isArray(array)) {
        // Invalid input - not an empty list. The shared empty result is right
        // here; a valid each([]) below must stay a fromEach fragment so an
        // already-rendered list can reconcile down to empty.
        return EMPTY_WHEN_RESULT;
    }

    // NOTE: We intentionally DON'T cache each() results based on array reference.
    // The mapFn may access reactive state (e.g., this.isGroupExpanded(item)) that
    // changes even when the array reference is unchanged. Fine-grained reactivity
    // requires re-evaluating the mapFn on each template() call.
    // For performance with large arrays, use memoEach() instead.

    // Single pass: toKeyedChild attaches the key and _src provenance itself
    // (an earlier pre-keying map here re-derived both, calling keyFn twice
    // per item and allocating a discarded copy - pure overhead on this hot
    // path). toKeyedChild preserves _values from nested templates as
    // _itemValues.
    const compiledChildren = [];
    for (let index = 0; index < array.length; index++) {
        const child = toKeyedChild(
            mapFn(array[index], index),
            keyFn ? keyFn(array[index], index) : index
        );
        if (child) compiledChildren.push(child);
    }

    // Return a fragment containing all compiled nodes
    return {
        [HTML_MARKER]: true,
        _compiled: {
            op: OP.FRAGMENT,
            type: 'fragment',
            wrapped: false,  // Unwrapped fragments spread their children into parent
            fromEach: true,   // Mark as from each() to distinguish from nested html() templates
            hasExplicitKeys: !!keyFn,  // Only use keyed reconciliation when user provides keys
            children: compiledChildren
        },
        toString() {
            return '';  // Not used in production
        }
    };
}

/**
 * Create a memoization cache for use with memoEach().
 * Should be created once per component (e.g., in mounted() or as instance property).
 *
 * @returns {Map} Cache map for memoEach
 *
 * @example
 * mounted() {
 *     this._songCache = createMemoCache();
 * }
 */
export function createMemoCache() {
    return new Map();
}

/**
 * Memoized version of each() - caches rendered templates per item key.
 * Only re-renders items that have changed (by reference, or by key if trustKey is true).
 *
 * If called within a component's template(), automatically uses component-scoped caching.
 *
 * @param {Array} array - Array to iterate over
 * @param {Function} mapFn - Function to map each item to a template
 * @param {Function} keyFn - Function to extract unique key from each item (REQUIRED for memoization)
 * @param {Object} [options] - Options object
 * @param {boolean} [options.trustKey=false] - If true, only compare keys (not item references). Useful for virtual scroll.
 * @param {Array} [options.deps] - External dependencies array. When any value changes, ALL items re-render.
 * @param {Map} [options.cache] - Explicit cache Map (for advanced use cases)
 * @returns {Object} Compiled fragment template
 *
 * @example
 * // Basic usage - cache is managed automatically
 * ${memoEach(this.state.songs, song => html`
 *     <div class="song">${song.title}</div>
 * `, song => song.uuid)}
 *
 * @example
 * // With trustKey for virtual scroll (items may be different object refs with same key)
 * ${memoEach(this.state.songs, song => html`...`, song => song.uuid, { trustKey: true })}
 *
 * @example
 * // With deps for external state (busts ALL item caches when selection changes)
 * ${memoEach(this.state.items, (item, idx) => {
 *     const isSelected = this.state.selectedIndex === idx;
 *     return html`<div class="${isSelected ? 'selected' : ''}">${item.name}</div>`;
 * }, item => item.id, { deps: [this.state.selectedIndex] })}
 */
// Stable singleton for memoEach() _compiled - enables reference equality checks
const MEMO_EACH_COMPILED = Object.freeze({
    op: OP.SLOT,
    type: 'memoEach'
});

export function memoEach(array, mapFn, keyFn, options) {
    if (!array || !Array.isArray(array)) {
        return EMPTY_WHEN_RESULT;
    }

    if (!keyFn) {
        // No keyFn - fall back to regular each() (no memoization possible)
        return each(array, mapFn, null);
    }

    // Support both old API (cache as Map) and new API (options object)
    // Old: memoEach(arr, fn, keyFn, cacheMap)
    // New: memoEach(arr, fn, keyFn, { cache, trustKey, deps })
    let cache = null;
    let trustKey = false;
    let deps = null;

    if (options) {
        if (options instanceof Map || options?.itemCache) {
            // Backward compatibility: options is a cache Map or cache object
            cache = options;
        } else if (typeof options === 'object') {
            // New API: options object
            cache = options.cache || null;
            trustKey = options.trustKey || false;
            deps = options.deps || null;  // External dependencies that bust all caches when changed
        }
    }

    // Return a marker object that template-renderer will handle
    // The caching is done at the slot level (DOM location) for stable identity
    return {
        [MEMO_EACH_MARKER]: true,
        [HTML_MARKER]: true,
        _array: array,
        _mapFn: mapFn,
        _keyFn: keyFn,
        _explicitCache: cache,  // Optional explicit cache for backward compatibility
        _trustKey: trustKey,    // When true, skip item reference check - trust key alone
        _deps: deps,            // External deps array - when any value changes, bust all caches
        _compiled: MEMO_EACH_COMPILED,  // Use singleton for stable reference
        toString() { return '[memoEach]'; }
    };
}

/**
 * Async content rendering helper (like Promise.then with loading state)
 * Returns an <x-await-then> component that manages its own loading/resolved/error state.
 * The component automatically re-renders when the promise resolves.
 *
 * @param {Promise|any} promiseOrValue - Promise to await, or immediate value
 * @param {Function} thenFn - Function to render resolved data: (data) => html`...`
 * @param {*} pendingContent - Content to show while loading
 * @param {Function|*} [catchFn] - Content or function for errors: (error) => html`...`
 * @returns {Object} html template containing x-await-then component
 *
 * @example
 * // Direct promise - no state management needed!
 * template() {
 *     return html`
 *         ${awaitThen(
 *             fetchUser(123),
 *             user => html`<div>${user.name}</div>`,
 *             html`<loading-spinner></loading-spinner>`,
 *             error => html`<div class="error">${error.message}</div>`
 *         )}
 *     `;
 * }
 *
 * @example
 * // With cached promise (prevents re-fetch on parent re-render)
 * data() { return { userPromise: null }; },
 * mounted() { this.state.userPromise = fetchUser(123); },
 * template() {
 *     return html`
 *         ${awaitThen(this.state.userPromise, user => html`...`, loading)}
 *     `;
 * }
 */
export function awaitThen(promiseOrValue, thenFn, pendingContent, catchFn = null) {
    return html`
        <x-await-then
            promise="${promiseOrValue}"
            then="${thenFn}"
            pending="${pendingContent}"
            catch="${catchFn}">
        </x-await-then>
    `;
}

// Initialize template compiler at module load
html._compiler = templateCompiler;

// Attach contain to html for opt() usage
// This allows eval(opt(...)) to use html.contain without importing contain
html.contain = contain;
