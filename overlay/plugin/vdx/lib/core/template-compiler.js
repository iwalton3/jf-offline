import { vdxCreateElement } from '/web/plugin/vdx-native-dom.js';
/**
 * Template Compiler - Optimized Op-Based Architecture
 *
 * Key optimizations:
 * 1. Static subtrees are pre-built as DOM at compile time (cloned on instantiation)
 * 2. Flat op-based structure minimizes runtime branching
 * 3. Fine-grained reactive rendering via template-renderer.js
 *
 * @module core/template-compiler
 */

import { OP } from './template.js';
import { htmlParse } from './html-parser.js';
import { SVG_TAG_CASE, SVG_NS } from './constants.js';
import { writeLiteralAttr } from './literal-attr.js';

/**
 * Template cache - keyed by statics array reference (HTM-style O(1) lookup)
 * @type {Map<TemplateStringsArray, Object>}
 */
const templateCache = new Map();

/** Maximum template cache size before cleanup */
const MAX_CACHE_SIZE = 500;

/** Track cache access times for LRU eviction */
const cacheAccessTimes = new Map();

/**
 * Compile a template string into an optimized op-based structure
 * @param {TemplateStringsArray} strings - Template literal string parts
 * @returns {Object} Compiled template with ops and pre-built statics
 */
export function compileTemplate(strings) {
    // Debug logging - enable with window.__TEMPLATE_DEBUG__ = true
    const DEBUG = typeof window !== 'undefined' && window.__TEMPLATE_DEBUG__;

    // HTM-style cache lookup using array reference
    if (templateCache.has(strings)) {
        cacheAccessTimes.set(strings, Date.now());
        if (DEBUG) console.log('[TEMPLATE] cache HIT', { stringsId: strings[0]?.slice(0, 50), cacheSize: templateCache.size });
        return templateCache.get(strings);
    }

    if (DEBUG) console.log('[TEMPLATE] cache MISS - compiling', { stringsId: strings[0]?.slice(0, 50), strings: [...strings], cacheSize: templateCache.size });

    // Parse directly using custom HTML parser (single pass, no markers needed)
    const parsed = htmlParse(strings);
    const compiled = buildOpTree(parsed);

    // Identity anchor: the statics array is engine-guaranteed stable per
    // call site and can never be evicted. Recompiling after a cache eviction
    // produces a structurally identical tree; stamping the statics (root)
    // and (statics, index) (direct children, used as keyed-row _src) lets
    // isSameCompiled/isSameStructure treat the recompile as the SAME
    // template, so live components update values in place instead of being
    // fully re-instantiated (losing focus/scroll/input state).
    compiled._statics = strings;
    if (Array.isArray(compiled.children)) {
        for (let i = 0; i < compiled.children.length; i++) {
            const child = compiled.children[i];
            if (child && typeof child === 'object') {
                child._statics = strings;
                child._staticsIndex = i;
            }
        }
    }

    // Cache the compiled template
    templateCache.set(strings, compiled);
    cacheAccessTimes.set(strings, Date.now());

    // Trigger cleanup if cache is getting too large
    if (templateCache.size > MAX_CACHE_SIZE) {
        cleanupTemplateCache();
    }

    return compiled;
}

/**
 * Clean up least recently used templates
 */
function cleanupTemplateCache() {
    const entries = Array.from(cacheAccessTimes.entries())
        .sort((a, b) => a[1] - b[1]);

    const toRemove = Math.floor(entries.length * 0.25);
    for (let i = 0; i < toRemove; i++) {
        const [staticsArray] = entries[i];
        templateCache.delete(staticsArray);
        cacheAccessTimes.delete(staticsArray);
    }
}

/**
 * Build optimized op tree from parsed structure
 * Pre-builds static VNodes and creates flat op structure
 */
function buildOpTree(node) {
    if (!node) return null;

    // SECURITY: <script> elements are never allowed in component templates -
    // a script created via createElement (which instantiation does) EXECUTES
    // when connected, unlike innerHTML-parsed scripts. The parser handles
    // <script> syntax (for tooling that shares it, e.g. the template lint),
    // but the compiler drops the element. Use external modules, or
    // <script type="application/json"> in the PAGE with json-* hydration.
    if (node.type === 'element' && node.tag === 'script') {
        console.warn('[template] Removed a <script> element - scripts are not allowed in component templates');
        return null;
    }

    // Check if entire subtree is static (no dynamic slots)
    if (isFullyStatic(node)) {
        // Pre-build DOM at compile time - can be cloned for each instantiation
        const staticDOM = buildStaticDOM(node);
        return {
            op: OP.STATIC,
            template: staticDOM,
            // Keep type info for compatibility with existing code (e.g., each() checks child.children)
            type: 'fragment',
            children: [],  // Required for compatibility with each() helper
            isStatic: true
        };
    }

    if (node.type === 'text') {
        if (node.slot !== undefined) {
            return {
                op: OP.SLOT,
                index: node.slot,
                context: node.context || 'content',
                type: 'text'
            };
        }
        return {
            op: OP.TEXT,
            value: node.value,
            type: 'text',
            isStatic: true
        };
    }

    if (node.type === 'fragment') {
        const children = (node.children || [])
            .map(child => buildOpTree(child))
            .filter(Boolean);

        return {
            op: OP.FRAGMENT,
            children,
            wrapped: node.wrapped,
            fromEach: node.fromEach,
            key: node.key,
            type: 'fragment',
            isStatic: children.every(c => c.isStatic)
        };
    }

    if (node.type === 'element') {
        // Only the spec-based hyphen rule is compiled in. Registry membership is
        // deliberately NOT recorded here: the compile cache is keyed on `strings`
        // identity and is never invalidated by defineComponent(), so a template
        // compiled before registration would be frozen as "native" forever. The
        // renderer reads the registry at instantiation, and at dispatch for the
        // decisions that must survive a registration later still.
        const isCustomTag = node.tag.includes('-');

        // Separate static props from dynamic props
        const staticProps = {};
        const dynamicProps = [];

        for (const [name, attrDef] of Object.entries(node.attrs || {})) {
            if (attrDef.value !== undefined && attrDef.slot === undefined &&
                attrDef.slots === undefined && attrDef.xModel === undefined &&
                attrDef.refName === undefined) {
                // Fully static prop
                staticProps[name] = attrDef.value;
            } else {
                // Dynamic prop - needs runtime resolution
                dynamicProps.push({ name, def: attrDef });
            }
        }

        // Pre-process events
        const events = [];
        for (const [eventName, eventDef] of Object.entries(node.events || {})) {
            events.push({ name: eventName, def: eventDef });
        }

        // Build children ops
        const children = (node.children || [])
            .map(child => buildOpTree(child))
            .filter(Boolean);

        return {
            op: OP.ELEMENT,
            tag: node.tag,
            staticProps,
            dynamicProps,
            events,
            children,
            isCustomTag,
            key: node.key,
            type: 'element',
            isStatic: dynamicProps.length === 0 && events.length === 0 &&
                      children.every(c => c.isStatic)
        };
    }

    return null;
}

/**
 * Check if a node subtree is fully static (no dynamic slots)
 * @param {boolean} [inSvg=false] - inside <svg>, where a hyphenated tag is an
 *   SVG element rather than a custom element (same rule as the renderer's
 *   isCustomTag). Explicit arrows below: `.every(isFullyStatic)` would pass
 *   the array index here.
 */
function isFullyStatic(node, inSvg = false) {
    if (!node) return true;

    if (node.type === 'text') {
        return node.slot === undefined;
    }

    if (node.type === 'fragment') {
        return (node.children || []).every(c => isFullyStatic(c, inSvg));
    }

    if (node.type === 'element') {
        // <script> must reach buildOpTree's element handling, which drops it -
        // pre-building it into a static DOM subtree would sneak it past the ban
        if (node.tag === 'script') {
            return false;
        }

        // A custom element is never static. Tag shape, not the registry: the
        // compile cache outlives registration, so a registry answer taken here
        // would freeze whatever was true when the template was first seen.
        if (!inSvg && node.tag.includes('-')) {
            return false;
        }

        // Elements with slot attribute need to remain as ops for slot extraction
        // (so template-renderer can detect the slot name and separate children)
        if (node.attrs && node.attrs.slot) {
            return false;
        }

        // Check attrs for any dynamic content
        for (const attrDef of Object.values(node.attrs || {})) {
            if (attrDef.slot !== undefined || attrDef.slots !== undefined ||
                attrDef.xModel !== undefined || attrDef.refName !== undefined) {
                return false;
            }
        }

        // Check events - any event makes it non-static (needs component context)
        if (Object.keys(node.events || {}).length > 0) {
            return false;
        }

        // Check children
        const svg = inSvg || node.tag === 'svg';
        return (node.children || []).every(c => isFullyStatic(c, svg));
    }

    return true;
}

/**
 * Build static DOM at compile time (no dynamic values).
 * Returns a DOM node that can be cloned with document.importNode() for each instantiation.
 */
function buildStaticDOM(node) {
    if (!node) return null;
    return buildDOMNode(node, false);
}

/**
 * Build DOM node from parsed structure (recursive helper)
 * @param {Object} node - Parsed node
 * @param {boolean} inSvg - Whether we're inside an SVG context
 */
function buildDOMNode(node, inSvg = false) {
    if (!node) return null;

    if (node.type === 'text') {
        const text = node.value || '';
        if (!text) return null;
        return document.createTextNode(text);
    }

    if (node.type === 'fragment') {
        const children = (node.children || [])
            .map(child => buildDOMNode(child, inSvg))
            .filter(child => child != null);

        if (children.length === 0) return null;
        if (children.length === 1) return children[0];

        const frag = document.createDocumentFragment();
        for (const child of children) {
            frag.appendChild(child);
        }
        return frag;
    }

    if (node.type === 'element') {
        const tag = node.tag;
        const isSvgElement = tag === 'svg' || inSvg;
        // Hyphen rule, not componentDefinitions: registration can happen after
        // compile, and attribute semantics must not depend on that timing.
        const isCustomElementTag = tag.includes('-');   // SVG is guarded per call site

        // Use SVG namespace for svg and its children
        const el = isSvgElement
            ? document.createElementNS(SVG_NS, SVG_TAG_CASE.get(tag) || tag)
            : vdxCreateElement(tag);

        // Apply static attributes - the one literal writer, shared with the
        // renderer's element path (literal-attr.js). A custom tag never comes
        // this way: it is never static (isFullyStatic).
        for (const [name, attrDef] of Object.entries(node.attrs || {})) {
            if (attrDef.value !== undefined) {
                writeLiteralAttr(el, name, attrDef.value, isSvgElement);
            }
        }

        // Build and append children (pass SVG context)
        for (const child of node.children || []) {
            const childDOM = buildDOMNode(child, isSvgElement);
            if (childDOM) el.appendChild(childDOM);
        }

        return el;
    }

    return null;
}

/**
 * Clear template cache
 */
export function clearTemplateCache() {
    templateCache.clear();
    cacheAccessTimes.clear();
}

/**
 * Prune template cache
 */
export function pruneTemplateCache() {
    if (templateCache.size > MAX_CACHE_SIZE * 0.5) {
        cleanupTemplateCache();
    }
}

/**
 * Get cache size for debugging
 */
export function getTemplateCacheSize() {
    return templateCache.size;
}
