import { vdxCreateElement } from '/web/plugin/vdx-native-dom.js';
/**
 * Component System
 * Web Components-based system with fine-grained reactive rendering
 */

import { reactive, flushEffects, computed, withoutTracking, isReactive, nextRender, holdNextRender, releaseNextRender } from './reactivity.js';
import { classToOptions, constructInstance } from './component-class.js';
import { createTask } from './task.js';
import { STORE_BRAND } from './store.js';
import { flushDOMUpdates } from './template-renderer.js';
import { createPropSpec, parseAttributes, RESERVED_PROP_NAMES } from './component-props.js';
import { scheduleRender, mountTemplate } from './component-render.js';

// Debug hooks - can be set by debug-enable.js. Only the propSet hook has
// call sites; the old renderCycle/vnode hooks died with the pre-fine-grained
// renderer and are no longer accepted.

export const componentDefinitions = new Map();

// ============================================================================
// Batched Rendering
// ============================================================================
// All rendering is driven by fine-grained reactive effects (see the
// computeEffect / slot effects created in connectedCallback). Coordination
// across components happens through effect ownership and depth-sorted
// flushing in reactivity.js, not through DOM-tree walking:
//
//   this.state.a = 1;  // Queues effects
//   this.state.b = 2;  // Same batch
//   this.state.c = 3;  // Same batch
//   // Effects flush once (microtask), DOM commits batch via rAF

/**
 * Internal function to flush all pending updates synchronously.
 * Flushes: reactive effects -> DOM updates
 */
function flushAll() {
    flushEffects();
    flushDOMUpdates();
}

/**
 * Force all pending renders and DOM updates to complete synchronously.
 * Alias for flushSync() without a callback - use when you need DOM to be current.
 */
export function flushRenders() {
    flushAll();
}

/**
 * Execute a function and immediately flush any pending renders.
 * Use this when you need synchronous DOM updates after state changes,
 * such as when measuring elements or interacting with focus.
 *
 * Similar to React's flushSync() - use sparingly as it bypasses batching.
 *
 * @param {Function} fn - Function to execute (typically contains state updates)
 * @returns {any} Return value of the function
 *
 * @example
 * // Scroll to bottom after adding an item
 * flushSync(() => {
 *   this.state.items.push(newItem);
 * });
 * this.refs.container.scrollTop = this.refs.container.scrollHeight;
 *
 * @example
 * // Focus an input after showing it
 * flushSync(() => {
 *   this.state.showInput = true;
 * });
 * this.refs.input.focus();
 *
 * @example
 * // Measure element after state change
 * flushSync(() => {
 *   this.state.expanded = true;
 * });
 * const height = this.refs.panel.offsetHeight;
 */
export function flushSync(fn) {
    const result = fn();
    flushAll();
    return result;
}

let debugPropSetHook = null;

export function setDebugComponentHooks(hooks) {
    debugPropSetHook = hooks.propSet;
}

// Cache for processed component styles (tag name -> processed CSS string)
const processedStylesCache = new Map();

/**
 * Strip CSS comments from a string
 * @param {string} css - CSS string potentially containing comments
 * @returns {string} CSS with comments removed
 */
function stripCSSComments(css) {
    let result = '';
    let i = 0;
    const len = css.length;

    while (i < len) {
        // Check for comment start
        if (css[i] === '/' && i + 1 < len && css[i + 1] === '*') {
            // Skip until comment end
            i += 2;
            while (i < len - 1 && !(css[i] === '*' && css[i + 1] === '/')) {
                i++;
            }
            i += 2; // Skip the */
            // Add a space to prevent tokens from merging
            result += ' ';
        } else {
            result += css[i];
            i++;
        }
    }

    return result;
}

/**
 * Namespace keyframes in CSS to prevent conflicts between components
 * Also updates animation/animation-name properties to reference the namespaced names
 * @param {string} css - CSS string
 * @param {string} tagName - Component tag name for namespacing
 * @returns {string} CSS with namespaced keyframes
 */
function namespaceKeyframes(css, tagName) {
    // Find all keyframe names defined in this CSS
    const keyframeNames = new Set();
    const keyframeRegex = /@(?:-webkit-)?keyframes\s+([a-zA-Z_][\w-]*)/g;
    let match;

    while ((match = keyframeRegex.exec(css)) !== null) {
        keyframeNames.add(match[1]);
    }

    if (keyframeNames.size === 0) {
        return css;
    }

    // Create namespace prefix from tag name (e.g., 'cl-button' -> 'cl-button--')
    const prefix = tagName + '--';

    // Replace keyframe definitions
    let result = css.replace(
        /@(-webkit-)?keyframes\s+([a-zA-Z_][\w-]*)/g,
        (match, webkit, name) => {
            if (keyframeNames.has(name)) {
                return `@${webkit || ''}keyframes ${prefix}${name}`;
            }
            return match;
        }
    );

    // Replace animation and animation-name references
    // This handles: animation: name 1s; animation-name: name;
    for (const name of keyframeNames) {
        // Match animation-name: name or animation: name (with various formats)
        // Be careful not to replace partial matches (e.g., 'spin' in 'spinner')
        const animationRegex = new RegExp(
            `(animation(?:-name)?\\s*:[^;]*?)\\b(${name})\\b`,
            'g'
        );
        result = result.replace(animationRegex, `$1${prefix}${name}`);
    }

    return result;
}

/**
 * Scope component styles to prevent leakage to other components
 * Transforms selectors to be prefixed with component tag name
 *
 * Strategy: Prefix selectors with tag name using descendant combinator.
 * This allows styling nested elements within the component, but prevents
 * styles from affecting other custom components (which have hyphenated tag names).
 *
 * Example:
 *   Input:  "button { color: blue; }"
 *   Output: "x-select-box button { color: blue; }"
 *
 * This means:
 * - ✅ Styles apply to <button> inside x-select-box
 * - ✅ Styles apply to nested <div><button></div> inside x-select-box
 * - ❌ Styles DON'T apply to <my-other-component> inside x-select-box
 *
 * @param {string} css - Raw CSS from component
 * @param {string} tagName - Component tag name (e.g., 'x-select-box')
 * @returns {string} Scoped CSS
 */
function scopeComponentStyles(css, tagName) {
    let result = '';
    let i = 0;

    // Strip comments first to avoid parsing issues
    css = stripCSSComments(css);

    // Namespace keyframes to prevent conflicts between components
    css = namespaceKeyframes(css, tagName);

    const len = css.length;

    // Replace :host and :host() with tag name
    // :host → tagName
    // :host(selector) → tagName + selector (concatenated, no parentheses)
    css = css.replace(/:host(\([^)]*(?:\([^)]*\)[^)]*)*\))?/g, (match, selector) => {
        if (selector) {
            // :host(selector) → tagName + selector (remove outer parens)
            return tagName + selector.slice(1, -1);
        }
        // :host → tagName
        return tagName;
    });

    while (i < len) {
        // Skip whitespace
        while (i < len && /\s/.test(css[i])) {
            result += css[i];
            i++;
        }

        if (i >= len) break;

        // Check for @-rules (media queries, keyframes, etc.)
        if (css[i] === '@') {
            // Find the opening brace of the @-rule
            let j = i;
            while (j < len && css[j] !== '{') {
                j++;
            }

            // Extract the @-rule name to check if it's @keyframes
            const atRuleDecl = css.substring(i, j);
            const isKeyframes = /^@keyframes\s/i.test(atRuleDecl) || /^@-webkit-keyframes\s/i.test(atRuleDecl);

            // Add the @-rule declaration (e.g., "@media screen and (max-width: 600px)")
            result += css.substring(i, j + 1);
            i = j + 1;

            // Find the matching closing brace
            let depth = 1;
            let atRuleBody = '';
            while (i < len && depth > 0) {
                if (css[i] === '{') depth++;
                if (css[i] === '}') depth--;

                if (depth > 0) {
                    atRuleBody += css[i];
                }
                i++;
            }

            // Don't scope @keyframes content (selectors are percentages/from/to, not CSS selectors)
            // Do scope @media queries (they contain normal CSS rules)
            if (isKeyframes) {
                result += atRuleBody;
            } else {
                result += scopeComponentStyles(atRuleBody, tagName);
            }
            result += '}';
            continue;
        }

        // Regular rule: find selector and body
        let selector = '';
        while (i < len && css[i] !== '{') {
            selector += css[i];
            i++;
        }

        selector = selector.trim();
        if (!selector) {
            if (i < len) {
                result += css[i];
                i++;
            }
            continue;
        }

        // Skip the opening brace
        if (i < len && css[i] === '{') {
            i++;
        }

        // Find the rule body
        let depth = 1;
        let body = '';
        while (i < len && depth > 0) {
            if (css[i] === '{') depth++;
            if (css[i] === '}') depth--;

            if (depth > 0) {
                body += css[i];
            }
            i++;
        }

        // Scope the selector
        const scopedSelector = scopeSelector(selector, tagName);
        result += `${scopedSelector} { ${body} }\n`;
    }

    return result;
}

/**
 * Split a selector list on top-level commas only. A naive split(',') breaks
 * selectors with commas inside functional pseudo-classes (:is(a, b),
 * :not(.x, .y)) or quoted attribute values ([data-x="a,b"]).
 * @param {string} selector - CSS selector list
 * @returns {string[]} Individual selectors
 */
function splitSelectorList(selector) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < selector.length; i++) {
        const ch = selector[i];
        if (quote) {
            if (ch === quote && selector[i - 1] !== '\\') quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '(' || ch === '[') {
            depth++;
        } else if (ch === ')' || ch === ']') {
            if (depth > 0) depth--;
        } else if (ch === ',' && depth === 0) {
            parts.push(selector.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(selector.slice(start));
    return parts;
}

/**
 * Scope a single selector (or comma-separated selectors)
 * @param {string} selector - CSS selector(s)
 * @param {string} tagName - Component tag name
 * @returns {string} Scoped selector(s)
 */
function scopeSelector(selector, tagName) {
    const selectors = splitSelectorList(selector).map(s => s.trim());

    return selectors.map(sel => {
        // Don't scope special selectors
        if (sel === '*' || sel === 'body' || sel === 'html' || sel.startsWith('@')) {
            return sel;
        }

        // Already scoped: starts with the tag name followed by a selector
        // boundary. The boundary check matters - a bare prefix test would
        // treat a LONGER tag name as scoped ('cl-avatar-group ...' inside
        // cl-avatar's styles) and leak those rules globally.
        if (sel.startsWith(tagName)) {
            const next = sel[tagName.length];
            if (next === undefined || /[\s>+~.:#[(]/.test(next)) {
                return sel;
            }
        }

        // Scope with descendant combinator
        // This allows styling nested elements but prevents leakage to other components
        return `${tagName} ${sel}`;
    }).join(', ');
}

/**
 * Define a custom component
 */
// DOM Element/Node/EventTarget methods that the framework itself calls on the
// element during rendering and teardown. Because a component's methods are bound
// directly onto the custom element (this[name] = method.bind(this)), a method
// named after one of these SHADOWS the native method and silently breaks the
// framework (e.g. teardown calls element.remove() and hits the user's method).
// Curated on purpose: structural/tree-mutation, attribute, and event methods
// only. Behavioral methods a component might legitimately override (focus, blur,
// click, scrollIntoView, animate, ...) are deliberately excluded.
const DOM_RESERVED_METHODS = new Set([
    // tree mutation / teardown
    'remove', 'append', 'prepend', 'before', 'after', 'replaceWith',
    'replaceChildren', 'appendChild', 'removeChild', 'insertBefore',
    'replaceChild', 'cloneNode', 'normalize', 'contains',
    // insertion
    'insertAdjacentElement', 'insertAdjacentHTML', 'insertAdjacentText',
    // traversal / query the framework relies on
    'closest', 'matches', 'querySelector', 'querySelectorAll', 'getRootNode',
    // attributes
    'getAttribute', 'setAttribute', 'removeAttribute', 'toggleAttribute',
    'hasAttribute', 'hasAttributes', 'getAttributeNames', 'getAttributeNode',
    'setAttributeNode', 'removeAttributeNode',
    // events
    'addEventListener', 'removeEventListener', 'dispatchEvent'
]);

/**
 * Definition-time guards. A method or computed named after a structural,
 * attribute or event DOM method would be bound onto the element and shadow the
 * native one, breaking the framework in ways that are miserable to debug -
 * throw. Props are only warned about elsewhere: some (id, title, hidden)
 * intentionally reflect to attributes, and props are not bound as callables.
 * A method sharing a prop's name is a silent corruption bug: methods are
 * installed with `this[name] = fn`, which FIRES the prop's setter, so the
 * method never lands and the prop holds a function - throw.
 */
function validateDefinition(name, options) {
    for (const collection of ['methods', 'computed']) {
        if (!options[collection]) continue;
        for (const memberName of Object.keys(options[collection])) {
            if (DOM_RESERVED_METHODS.has(memberName)) {
                const kind = collection === 'methods' ? 'method' : 'computed';
                throw new Error(
                    `[${name}] Cannot define ${kind} "${memberName}" - it collides with the ` +
                    `native DOM method Element.${memberName}(). Component ${kind}s are bound ` +
                    `directly onto the element, so this would shadow the native method and ` +
                    `break the framework's rendering/teardown. Rename it (e.g. "${memberName}Item").`
                );
            }
        }
    }
    if (options.props && options.methods) {
        for (const methodName of Object.keys(options.methods)) {
            if (Object.prototype.hasOwnProperty.call(options.props, methodName)) {
                throw new Error(
                    `[${name}] Cannot define method "${methodName}" - a prop with the same ` +
                    `name already exists. Methods are bound onto the element and would fire the ` +
                    `prop's setter, corrupting both the method and the prop. Rename one of them.`
                );
            }
        }
    }
}

/** Computed names, minus the ones colliding with a prop, method, or reserved name (warned, skipped). */
function validComputedNames(name, options) {
    const names = [];
    if (!options.computed) return names;
    for (const [cname, getter] of Object.entries(options.computed)) {
        if (typeof getter !== 'function') {
            console.warn(`[${name}] Skipping computed "${cname}" - must be a plain function`);
            continue;
        }
        if (RESERVED_PROP_NAMES.has(cname) || cname === 'children' || cname === 'slots' || cname === 'style' ||
            (options.props && cname in options.props) ||
            (options.methods && cname in options.methods)) {
            console.warn(`[${name}] Skipping computed "${cname}" - name conflicts with a prop, method, or reserved name`);
            continue;
        }
        names.push(cname);
    }
    return names;
}

/**
 * Capture light DOM as the live nodes themselves, once, before the first
 * render. Serialising through innerHTML and parsing back made copies: a
 * listener the page or a parent template had put on a child was gone, and a
 * nested component came back as a new instance. The nodes are detached here
 * and placed by the template through props.children - a nested component
 * takes its reconnect path when that happens, not a fresh construction.
 */
function captureLightDom(el) {
    if (el.childNodes.length === 0) return;
    const defaultChildren = [];
    const namedSlots = {};
    for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE) {
            const slotName = child.getAttribute('slot');
            if (slotName) {
                child.removeAttribute('slot');
                if (!namedSlots[slotName]) namedSlots[slotName] = [];
                namedSlots[slotName].push(child);
            } else {
                defaultChildren.push(child);
            }
        } else if (child.nodeType === Node.COMMENT_NODE ||
                   (child.nodeType === Node.TEXT_NODE && child.textContent.trim())) {
            // A comment is kept: when a parent template wrote a slot straight
            // between the tags, the comment is that slot's placeholder, and
            // the parent's effect inserts every later value after it. Dropping
            // it left the effect anchored to a detached node. Whitespace-only
            // text is dropped, as always.
            defaultChildren.push(child);
        }
    }
    el.replaceChildren();
    if (defaultChildren.length > 0 || Object.keys(namedSlots).length > 0) {
        el.props.children = defaultChildren;
        el.props.slots = namedSlots;
    }
}

/**
 * Run a class-authored component's constructor with `this` bound to the
 * element (see component-class.js). Deferred to first connect deliberately,
 * unlike data(): constructor(props) sees real prop values.
 */
function runClassConstructor(el, options, name) {
    // Snapshot own properties so class fields (which appear during
    // construction) can be told apart from pre-existing properties
    const ownBefore = new Set(Object.getOwnPropertyNames(el));
    constructInstance(el, options._class);

    // Class fields land as own properties via [[DefineOwnProperty]], which
    // would shadow the prototype prop accessors (and the native style/children
    // APIs). Remove them - prop defaults belong in `static props`.
    for (const key of Object.getOwnPropertyNames(el)) {
        if (ownBefore.has(key)) continue;
        const isDeclaredProp = options.props &&
            Object.prototype.hasOwnProperty.call(options.props, key);
        if (isDeclaredProp || key === 'children' || key === 'slots' || key === 'style') {
            delete el[key];
            console.warn(
                `[${name}] Class field "${key}" conflicts with a ` +
                `${isDeclaredProp ? 'declared prop' : 'reserved property'} and was removed - ` +
                'set prop defaults in static props instead'
            );
        }
    }

    // The constructor assigned a plain object to this.state - wrap it now
    // (replaces the placeholder from the element constructor)
    if (!isReactive(el.state)) {
        el.state = reactive(el.state || {});
    }
}

/**
 * Create the component's computeds (lazy, cached; disposed on disconnect).
 * Inside withoutTracking so they are root-owned effects - NOT children of
 * whatever parent effect is instantiating this component - and survive
 * parent re-renders.
 */
function createComputeds(component, options, computedNames) {
    component._computeds = {};
    withoutTracking(() => {
        for (const cname of computedNames) {
            const getter = options.computed[cname];

            // The computed's creation runs the getter eagerly once. Instrument
            // this.props for that first run: props is a plain object
            // (invalidation rides on _propsVersion), so props reads are
            // invisible to the dependency tracker.
            let touchedProps = false;
            const realProps = component.props;
            Object.defineProperty(component, 'props', {
                get() { touchedProps = true; return realProps; },
                configurable: true,
                enumerable: true
            });
            let c;
            try {
                c = computed(() => {
                    // Track props version so prop changes invalidate the computed
                    if (component._propsVersion) {
                        const _ = component._propsVersion.v;
                    }
                    return getter.call(component);
                });
            } finally {
                Object.defineProperty(component, 'props', {
                    value: realProps,
                    writable: true,
                    configurable: true,
                    enumerable: true
                });
            }

            // Footgun lessener: a getter that tracked no reactive dependency
            // beyond the props version - and never touched props - can never
            // be invalidated; a cached computed would return its first value
            // forever. Fall back to re-evaluating on every read.
            if (!touchedProps && c._depCount() <= 1) {
                c.dispose();
                c = {
                    get: () => getter.call(component),
                    dispose() {}
                };
            }
            component._computeds[cname] = c;
        }
    });
}

/** Scoped component styles into document.head, once per tag. */
function injectStyles(el, options) {
    if (!options.styles || el._stylesInjected) return;
    const styleId = `component-styles-${options.name || el.tagName}`;
    const tagName = el.tagName.toLowerCase();
    if (!document.getElementById(styleId)) {
        let processedStyles = processedStylesCache.get(tagName);
        if (!processedStyles) {
            processedStyles = scopeComponentStyles(options.styles, tagName);
            processedStylesCache.set(tagName, processedStyles);
        }
        const styleEl = vdxCreateElement('style');
        styleEl.id = styleId;
        styleEl.textContent = processedStyles;
        document.head.appendChild(styleEl);
    }
    el._stylesInjected = true;
}

export function defineComponent(name, options) {
    // Identity of this definition (the user's class or options object) -
    // used to keep re-registration of the same definition silent
    const source = options;

    // Class-authored components: translate the class into the options format
    // (see component-class.js). The class is an authoring surface - at
    // runtime `this` is the custom element, exactly as with options.
    if (typeof options === 'function') {
        options = classToOptions(options);
    }

    validateDefinition(name, options);

    // Everything about how a prop value gets in - name maps, the undefined
    // rule, the attribute mirror, the one write, the one notify - lives in
    // component-props.js as a spec closed over this definition's options.
    const spec = createPropSpec(options);
    const reservedNames = RESERVED_PROP_NAMES;
    const { attrToProp } = spec;

    const computedNames = validComputedNames(name, options);

    class Component extends HTMLElement {
        constructor() {
            super();

            // Store props (always include children and slots, even if empty)
            // children is always an array of default slot children
            // slots is an object with named slot children
            // Initialized BEFORE data() so code in data() (e.g. option
            // factories passed to helpers like createWindowing) can safely
            // read this.props - values arrive later, but the object exists
            this.props = {
                children: [],
                slots: {}
            };

            // Initialize reactive state
            this.state = reactive(options.data ? options.data.call(this) : {});

            // Reactive version counter for fine-grained prop tracking
            // Effects that access this will re-run when props change
            this._propsVersion = reactive({ v: 0 });


            // Apply any props that were set via prototype setters before constructor ran
            // (This happens when props are set on an element before it's added to DOM)
            if (this._pendingProps) {
                for (const [propName, value] of Object.entries(this._pendingProps)) {
                    spec.commitProp(this, propName, value);
                }
                delete this._pendingProps;
            }

            // Initialize stores (direct references to store state for fine-grained reactivity)
            if (options.stores) {
                this.stores = {};
                for (const [storeName, store] of Object.entries(options.stores)) {
                    if (store && store[STORE_BRAND]) {
                        // Class-based Store: expose the INSTANCE so state fields
                        // (promoted accessors), computed getters, and methods all
                        // hang off this.stores.name. Field reads still track
                        // fine-grained (they forward to the reactive .state).
                        if (store._checkFieldShadow) store._checkFieldShadow();
                        this.stores[storeName] = store;
                    } else {
                        // Legacy createStore: use store state directly - templates
                        // access this.stores.name.property, tracking only the
                        // specific properties accessed (fine-grained updates).
                        this.stores[storeName] = store.state;
                    }
                }
            }

            // Initialize refs container
            this.refs = {};

            // Bind all methods to this instance
            if (options.methods) {
                for (const [name, method] of Object.entries(options.methods)) {
                    this[name] = method.bind(this);
                }
            }

            // Bind propsChanged hook if defined
            if (options.propsChanged) {
                this.propsChanged = options.propsChanged.bind(this);
            }

            // Lifecycle flags
            this._isMounted = false;
            this._isDestroyed = false;
            this._suppressAttributeChange = false;

            // Per-connect generation counter. Custom elements fire
            // disconnect->reconnect SYNCHRONOUSLY when moved in the DOM
            // (drag-reorder, re-parenting, list re-keying); a same-task move
            // resets _isMounted/_isDestroyed before microtasks queued by the
            // previous connect run, defeating those guards. Every continuation
            // queued during a connect captures the generation and bails if a
            // newer connect has happened since.
            this._connectGen = 0;
            // True once the mounted() microtask for the CURRENT connect has
            // completed - unmounted() is only delivered when its mounted()
            // actually ran (lifecycle pairing).
            this._mountedHookRan = false;
            // Light-DOM children are captured exactly once (first connect).
            // On reconnect the element's innerHTML is its own previous
            // rendered output - re-capturing would corrupt props.children.
            this._childrenCaptured = false;
            // Tasks from this.createTask(): cancelled (NOT disposed) at each
            // disconnect so in-flight runs abort but the task stays usable if
            // the element reconnects.
            this._boundTasks = [];

            // Cleanup functions
            this._cleanups = [];

            // First-render-complete promise (for whenMounted): resolves after
            // the initial render AND mounted() hook complete. whenMounted()
            // waiters await this to know a matched child is fully ready.
            this._ready = new Promise(resolve => { this._resolveReady = resolve; });
            // Resolvers fired when this element disconnects (whenMounted races
            // these to resolve null if the waiter unmounts first).
            this._unmountResolvers = [];
        }

        /**
         * Emit a change event for x-model binding
         * Handles all the boilerplate: stopPropagation, update prop, emit CustomEvent
         * @param {Event} e - The original event (will have propagation stopped)
         * @param {*} value - The new value to emit
         * @param {string} propName - The prop name to update (default: 'value')
         */
        emitChange(e, value, propName = 'value') {
            // Stop the native event from bubbling
            if (e && e.stopPropagation) {
                e.stopPropagation();
            }

            // NOTE: Removed direct prop mutation - props should only be updated by parent
            // The parent component will handle the change event and update its state,
            // which will trigger a re-render and pass new props to this component
            //
            // Old code (caused reactivity issues):
            // if (propName in this.props) {
            //     this.props[propName] = value;
            // }

            // Emit CustomEvent with detail
            this.dispatchEvent(new CustomEvent('change', {
                bubbles: true,
                composed: true,
                detail: { value }
            }));
        }

        /**
         * Resolve after the next effect flush and DOM commit complete.
         * Rendering is globally batched, so this just delegates to the global
         * nextRender() - there is no per-component variant.
         * @returns {Promise<void>}
         */
        nextRender() {
            return nextRender();
        }

        /**
         * Resolve when a matched child exists in this component's subtree, its
         * custom element is defined (covers lazy import()ed definitions), and
         * its first render + mounted() have completed.
         *
         * Resolves null (never rejects) if THIS component unmounts while
         * waiting - callers write `if (!el) return;`, no try/catch.
         *
         * @param {string|Element} selectorOrElement - CSS selector queried within
         *     this subtree, or a specific element to wait on.
         * @returns {Promise<Element|null>}
         */
        async whenMounted(selectorOrElement) {
            const UNMOUNTED = Symbol('unmounted');

            // A promise that resolves when THIS (the waiter) unmounts.
            const unmounted = new Promise(resolve => {
                if (this._isDestroyed) resolve(UNMOUNTED);
                else this._unmountResolvers.push(() => resolve(UNMOUNTED));
            });

            const resolveTarget = () => (typeof selectorOrElement === 'string'
                ? this.querySelector(selectorOrElement)
                : selectorOrElement);

            // One polling lap: at least one render flush AND one macrotask.
            // nextRender() alone resolves through pure microtasks (it forces a
            // flush even when nothing is pending), so a loop awaiting only it
            // spins on the microtask queue and STARVES macrotasks - the very
            // timeout/fetch/import that would produce the awaited child never
            // gets to run.
            const waitLap = () => Promise.all([
                nextRender(),
                new Promise(resolve => setTimeout(resolve, 0))
            ]);

            // Element we already waited one render on without _ready appearing -
            // a defined non-VDX custom element never gets one, so a second lap
            // on the same element returns it as-is instead of spinning forever.
            let waitedForReadyOn = null;

            while (true) {
                if (this._isDestroyed) return null;

                let el = resolveTarget();

                // Selector not matched yet - wait for a render and re-query.
                // (querySelector already scopes to this subtree; an explicitly
                // passed element is trusted and skips this wait.)
                if (!el) {
                    const r = await Promise.race([waitLap(), unmounted]);
                    if (r === UNMOUNTED || this._isDestroyed) return null;
                    continue;
                }

                const tag = el.tagName ? el.tagName.toLowerCase() : '';
                const isCustom = tag.includes('-');

                if (isCustom) {
                    // Ensure the custom element is defined (lazy import()).
                    if (!customElements.get(tag)) {
                        const defined = customElements.whenDefined(tag).then(() => 'defined');
                        const r = await Promise.race([defined, unmounted]);
                        if (r === UNMOUNTED || this._isDestroyed) return null;
                    }

                    // Await the child's first-render-complete promise. If the
                    // element isn't upgraded to a VDX component yet, wait a
                    // render and retry - but only once per element: a defined
                    // custom element with no _ready after a render is not a VDX
                    // component (third-party), and "defined + present" is the
                    // strongest guarantee it can offer.
                    if (el._ready) {
                        const r = await Promise.race([el._ready, unmounted]);
                        if (r === UNMOUNTED || this._isDestroyed) return null;
                        // _ready also resolves at DISCONNECT (never leave a
                        // waiter hanging) - a detached element is not mounted.
                        // Wait a render and retry; reconnect creates a fresh
                        // _ready which the next lap awaits.
                        if (!el.isConnected) {
                            const r2 = await Promise.race([waitLap(), unmounted]);
                            if (r2 === UNMOUNTED || this._isDestroyed) return null;
                            continue;
                        }
                    } else if (waitedForReadyOn !== el) {
                        waitedForReadyOn = el;
                        const r = await Promise.race([waitLap(), unmounted]);
                        if (r === UNMOUNTED || this._isDestroyed) return null;
                        continue;
                    }
                }

                return el;
            }
        }

        /**
         * Create a latest-wins async task bound to this component's lifetime -
         * in-flight runs are auto-cancelled when the component unmounts. The
         * task itself stays usable, so a task created once in a class
         * constructor keeps working after a disconnect->reconnect DOM move
         * (dispose() would kill it permanently; the element may come back).
         * @param {(signal: AbortSignal, ...args: any[]) => any} fn
         * @returns {ReturnType<typeof createTask>}
         */
        createTask(fn) {
            const task = createTask(fn);
            this._boundTasks.push(task);
            return task;
        }

        connectedCallback() {
            // A connect reaction can be delivered after the element has
            // already been removed again - an outer component adopting this
            // one as light DOM detaches it in its own connectedCallback,
            // before this one runs. Rendering in limbo built a ghost subtree
            // that never got mounted()/unmounted(); the real connect follows.
            if (!this.isConnected) return;

            // Allow reconnection of previously disconnected elements
            // Web Components can be disconnected and reconnected multiple times
            if (this._isDestroyed) {
                // Reset destroyed flag to allow reconnection
                this._isDestroyed = false;
            }

            // Claim this connect's generation. Continuations queued below
            // (mount hook, structural re-instantiation, error fallback and
            // recovery, afterRender) capture `gen` and no-op when a newer
            // connect has superseded them - the resettable flags alone cannot
            // catch a synchronous disconnect->reconnect (DOM move).
            const gen = ++this._connectGen;
            const isReconnect = this._childrenCaptured;

            // Parse attributes as props (prototype setters handle property access)
            this._parseAttributes();

            // Mark as mounted BEFORE initial render to prevent double-render
            this._isMounted = true;

            // Recreate the first-render-complete promise per connect (the
            // constructor made the first one; disconnect and mount-completion
            // consume it). Without this, whenMounted()'s "first render +
            // mounted() done" guarantee is void for any element that ever
            // disconnected - its old _ready stays resolved forever.
            if (!this._resolveReady) {
                this._ready = new Promise(resolve => { this._resolveReady = resolve; });
            }

            // Light DOM is captured ONCE, on first connect; on reconnect the
            // element's content is its own previous render.
            if (!isReconnect) {
                captureLightDom(this);
                this._childrenCaptured = true;
            } else if (options.template) {
                // Reconnect: clear the remnants of the previous render (slot
                // effect disposal at disconnect removed slot-created nodes;
                // static nodes remain) so re-instantiation doesn't duplicate
                // them. props.children keeps the first-connect capture.
                this.textContent = '';
            }

            // Note: Store subscriptions are no longer needed because this.stores[name]
            // directly references store.state. Templates access this.stores.name.property
            // which tracks the store's reactive state directly (fine-grained reactivity).

            // Class-authored components: the user constructor runs now, after
            // attributes are parsed and children captured, so constructor(props)
            // sees real values. Once per element; reconnection does not re-run it.
            if (options._class && !this._classConstructed) {
                this._classConstructed = true;
                runClassConstructor(this, options, name);
            }

            // Computeds are per connect (disposed at disconnect)
            if (computedNames.length > 0 && !this._computeds) {
                createComputeds(this, options, computedNames);
            }

            // Fine-grained rendering: one compute effect per connect, slot
            // effects as its children. See component-render.js.
            if (options.template) mountTemplate(this, options, name, gen);

            // Call mounted hook AFTER initial render (async, non-blocking).
            // This ensures the component renders immediately and doesn't block
            // navigation. The _ready promise (for whenMounted) resolves here,
            // after mounted() - so a waiter sees a fully-initialized child.
            // Hold nextRender() until this mount microtask has run: state
            // written by mounted() belongs to the render an awaiting caller
            // is waiting on (otherwise `await nextRender()` resolves between
            // the child mounting and its mounted() writes rendering).
            holdNextRender();
            queueMicrotask(() => {
                try {
                    // Check if still mounted (might have unmounted during render)
                    // AND still the same connect - a synchronous DOM move queues a
                    // second mount microtask; without the gen check, mounted()
                    // fires once per queued microtask instead of once per connect.
                    if (this._isMounted && !this._isDestroyed && gen === this._connectGen) {
                        this._mountedHookRan = true;
                        if (options.mounted) {
                            options.mounted.call(this);
                        }
                        if (this._resolveReady) {
                            this._resolveReady(this);
                            this._resolveReady = null;
                        }
                    }
                } finally {
                    releaseNextRender();
                }
            });
        }

        disconnectedCallback() {
            // Set flags FIRST to prevent any new operations
            this._isDestroyed = true;
            this._isMounted = false;

            // Notify whenMounted() waiters that this element unmounted.
            if (this._unmountResolvers && this._unmountResolvers.length > 0) {
                const resolvers = this._unmountResolvers;
                this._unmountResolvers = [];
                for (const resolve of resolvers) resolve();
            }
            // Never leave a whenMounted() await hanging on an element that
            // unmounted before it finished its first render.
            if (this._resolveReady) {
                this._resolveReady(this);
                this._resolveReady = null;
            }

            // Cancel (not dispose) component-bound tasks: in-flight runs
            // abort, but the tasks stay usable if the element reconnects
            // (a task created in a class constructor exists once per element).
            if (this._boundTasks) {
                for (const task of this._boundTasks) task.cancel();
            }

            // Dispose reactive effects IMMEDIATELY to stop state updates from triggering renders
            // This must happen before calling unmounted() hook
            if (this._cleanups && this._cleanups.length > 0) {
                this._cleanups.forEach(fn => fn());
                this._cleanups = [];
            }

            // Clean up fine-grained rendering effects
            if (this._fineGrainedCleanup) {
                this._fineGrainedCleanup();
                this._fineGrainedCleanup = null;
            }

            // Call unmounted hook (after effects are disposed) - but only when
            // this connect's mounted() actually ran. A synchronous disconnect
            // can arrive before the queued mount microtask; delivering
            // unmounted() for a mount that never happened breaks pairing.
            if (options.unmounted && this._mountedHookRan) {
                options.unmounted.call(this);
            }
            this._mountedHookRan = false;

            // Dispose computed properties (recreated if the element reconnects)
            if (this._computeds) {
                for (const c of Object.values(this._computeds)) {
                    if (c && c.dispose) c.dispose();
                }
                this._computeds = null;
            }

            // Clear refs to prevent memory leaks from stale DOM references
            this.refs = {};
        }

        attributeChangedCallback(name, oldValue, newValue) {
            if (oldValue === newValue || this._suppressAttributeChange || !this.props) {
                return;
            }

            // Before the FIRST connect, initial attributes are applied by
            // _parseAttributes (which implements kebab-over-legacy precedence
            // when both attribute forms are present) - skip them here.
            if (this._connectGen === 0) {
                return;
            }

            // `name` arrives lowercase; map kebab/lowercase forms to the prop.
            // The value came FROM the attribute, so it is not mirrored back.
            // While detached the write is silent: the (re)connect render
            // reads props fresh, and notifyProps only speaks to a live one.
            const propName = attrToProp.get(name);
            if (propName) {
                const change = spec.commitProp(this, propName, newValue, true);
                if (change) spec.notifyProps(this, [change]);
            }
        }

        static get observedAttributes() {
            // Observe kebab-case and legacy lowercase forms of all props
            return spec.observedAttributes;
        }

        _parseAttributes() {
            parseAttributes(this, options, spec);
        }

        /**
         * Inject component styles into document head (shared by both render paths)
         */
        _injectStyles() {
            injectStyles(this, options);
        }

        /**
         * Public render method - no-op in fine-grained mode.
         * Kept for API backwards compatibility.
         */
        render() {
            // No-op - fine-grained effects handle all updates automatically
        }

        // Helper method to access methods from component
        $method(name) {
            return options.methods?.[name]?.bind(this);
        }
    }

    // Define property accessors on prototype BEFORE registration

    // A declared prop's accessor. Before construction the value waits in
    // _pendingProps (the constructor commits it); after, it is one commit and
    // one notify, the same two calls setProps and attributeChangedCallback make.
    const createPropSetter = (propName) => ({
        get() {
            return this.props ? this.props[propName] : undefined;
        },
        set(value) {
            value = spec.resolveIncoming(propName, value);
            if (debugPropSetHook) {
                debugPropSetHook(this.tagName || name, propName, value, value, this._isMounted);
            }
            if (!this.props) {
                if (!this._pendingProps) this._pendingProps = {};
                this._pendingProps[propName] = value;
                return;
            }
            const change = spec.commitProp(this, propName, value);
            if (change) spec.notifyProps(this, [change]);
        },
        enumerable: true,
        configurable: true
    });

    // children / slots, and the _vdx* names the renderer sets them through
    // (a template's own `children` property would collide with the DOM's).
    // Four accessors, one shape: before construction the value waits in
    // _pendingProps, after it lands on props and bumps the version.
    const contentAccessor = (accessor, key) => ({
        get() {
            return this.props ? this.props[key] : undefined;
        },
        set(value) {
            if (debugPropSetHook) {
                debugPropSetHook(this.tagName || name, accessor, value, value, this._isMounted);
            }
            if (!this.props) {
                if (!this._pendingProps) this._pendingProps = {};
                this._pendingProps[key] = value;
                return;
            }
            this.props[key] = value;
            if (this._isMounted && this._propsVersion) {
                this._propsVersion.v++;
            }
        },
        enumerable: true,
        configurable: true
    });
    for (const [accessor, key] of [['children', 'children'], ['slots', 'slots'],
                                   ['_vdxChildren', 'children'], ['_vdxSlots', 'slots']]) {
        Object.defineProperty(Component.prototype, accessor, contentAccessor(accessor, key));
    }

    // Batched prop assignment: updates ALL backing values before firing any
    // propsChanged callback, so a handler can safely read this.props for
    // sibling props delivered in the same batch. The router uses this for
    // params+query — with individual setters, the params handler runs while
    // this.props.query is still stale (and vice versa).
    Object.defineProperty(Component.prototype, 'setProps', {
        value: function setProps(newProps) {
            if (!newProps || typeof newProps !== 'object') return;

            // Called before constructor: stash for later application
            if (!this.props) {
                if (!this._pendingProps) this._pendingProps = {};
                Object.assign(this._pendingProps, newProps);
                return;
            }

            const changes = [];
            for (const [propName, rawValue] of Object.entries(newProps)) {
                // Only declared props with generated accessors participate in
                // batching; special/undeclared props fall back to plain
                // assignment (identical to setting the property directly)
                if (!spec.isDeclared(propName)) {
                    this[propName] = rawValue;   // the setter applies the rule
                    continue;
                }
                const value = spec.resolveIncoming(propName, rawValue);
                if (debugPropSetHook) {
                    debugPropSetHook(this.tagName || name, propName, value, value, this._isMounted);
                }
                const change = spec.commitProp(this, propName, value);
                if (change) changes.push(change);
            }
            // All backing values are current - now notify, once for the batch
            spec.notifyProps(this, changes);
        },
        writable: true,
        configurable: true
    });

    // Define accessors for all declared props
    if (options.props) {
        for (const propName of Object.keys(options.props)) {
            if (reservedNames.has(propName) || propName === 'children' || propName === 'slots') {
                if (reservedNames.has(propName)) {
                    console.warn(`[VDX Security] Skipping reserved prop name: ${propName}`);
                }
                continue;
            }
            if (propName === 'style') {
                // needs workaround due to style being a special property on HTMLElement
                Object.defineProperty(Component.prototype, '_vdxStyle', {
                    get() {
                        return this.props ? this.props.style : undefined;
                    },
                    set(value) {
                        if (debugPropSetHook) {
                            debugPropSetHook(this.tagName || name, '_vdxStyle', value, value, this._isMounted);
                        }
                        if (!this.props) {
                            if (!this._pendingProps) this._pendingProps = {};
                            this._pendingProps.style = value;
                            return;
                        }
                        this.props.style = value;
                        if (this._isMounted) scheduleRender(this);
                    },
                    enumerable: true,
                    configurable: true
                });
                continue;
            }
            Object.defineProperty(Component.prototype, propName, createPropSetter(propName));
        }
    }

    // Define accessors for computed properties - read as plain properties
    // (this.total, not this.total()). get() registers the reading effect as
    // a dependent, so templates re-render when the computed invalidates.
    for (const cname of computedNames) {
        Object.defineProperty(Component.prototype, cname, {
            get() {
                const c = this._computeds && this._computeds[cname];
                return c ? c.get() : undefined;
            },
            enumerable: true,
            configurable: true
        });
    }

    // Register the custom element. On a name collision, keep the existing
    // definition and warn loudly - silently registering nothing (and
    // returning a class that isn't the one in the registry) hides the
    // conflict until components render as the wrong thing.
    const existing = customElements.get(name);
    if (existing) {
        const registered = componentDefinitions.get(name) || existing;
        // Re-registering the SAME definition (same class or options object,
        // e.g. a defineComponent call that runs twice) is idempotent and
        // silent; a different definition under the same name is a collision
        if (registered._vdxSource !== source) {
            console.warn(
                `[defineComponent] <${name}> is already defined - keeping the existing definition. ` +
                'Register this component under a different tag name to resolve the collision.'
            );
        }
        return registered;
    }
    Component._vdxSource = source;
    customElements.define(name, Component);
    componentDefinitions.set(name, Component);

    return Component;
}
