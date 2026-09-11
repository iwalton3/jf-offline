import { vdxCreateElement } from '/web/plugin/vdx-native-dom.js';
/**
 * Fine-Grained Template Renderer
 *
 * Instantiates compiled templates into real DOM nodes with per-binding effects.
 * Each dynamic value creates its own effect that updates only that DOM location.
 *
 * Key concepts:
 * - Templates are compiled once (by template-compiler.js)
 * - This renderer creates DOM nodes and wires up reactive effects
 * - Updates are O(1) per binding (no full-tree diffing)
 */

import { createEffect, withoutTracking, reactive, registerEffectFlushHooks, registerNextRenderFlush, runAsEffect, getActiveEffect } from './reactivity.js';
import { isHtml, isRaw, isContain, isMemoEach, resolveWhen, OP, sanitizeUrl, HTML_MARKER, EMPTY_WHEN_RESULT, toKeyedChild, isSameCompiled } from './template.js';
import { componentDefinitions } from './component.js';
import { DANGEROUS_KEYS, SVG_TAG_CASE, SVG_NS, nullish, isBooleanAttr, isRefusedAttr, refusedAttrMessage, literalAttrValue, kebabToCamel } from './constants.js';
import { hostAppliedRule, isOwnElementProp, writeBooleanAttr, DANGEROUS_CSS } from './host-attrs.js';
import { writeLiteralAttr, sanitizeUrlAttr } from './literal-attr.js';
import { recordPendingProp } from './pending-props.js';

// ============================================================================
// Deferred DOM Updates System
// ============================================================================
// Effects run via microtask (fast, works in background tabs).
// DOM updates are batched and applied via requestAnimationFrame.
// This reduces layout thrashing - multiple state changes = one layout.

/** Pending attribute updates: Map<Element, Map<attrName, value>> */
const pendingAttrUpdates = new Map();

/** Pending text updates: Map<TextNode, value> */
const pendingTextUpdates = new Map();


/**
 * Form controls whose live `value` this renderer actually set, so a later
 * nullish binding knows whether there is anything of ours to clear.
 */
const appliedFormValues = new WeakMap();

/** Whether we're currently in effect flush mode (queue updates vs apply directly) */
let isDeferringUpdates = false;

/** Whether a rAF is scheduled for DOM commits */
let domCommitScheduled = false;

/** Whether any DOM instantiations occurred during deferred update mode */
let hadInstantiations = false;

/**
 * Actually apply all pending DOM updates.
 * Called from rAF or flushDOMUpdates (for flushSync).
 */
function applyPendingDOMUpdates() {
    domCommitScheduled = false;

    // Commit attribute updates. A write whose binding was disposed between
    // queueing and commit is dropped: its element may already be detached, and
    // for a custom element the property setter is arbitrary component code that
    // must not run against a torn-down binding.
    for (const [el, attrs] of pendingAttrUpdates) {
        for (const [name, { value, isCustomTag, owner }] of attrs) {
            if (owner && owner._disposed) continue;
            applyAttributeDirect(el, name, value, isCustomTag);
        }
    }
    pendingAttrUpdates.clear();

    // Commit text updates (same ownership rule)
    for (const [textNode, { value, owner }] of pendingTextUpdates) {
        if (owner && owner._disposed) continue;
        textNode.textContent = value ?? '';
    }
    pendingTextUpdates.clear();
}

/**
 * Enter deferred update mode. Called at start of effect flush.
 */
function beginDeferredUpdates() {
    isDeferringUpdates = true;
    hadInstantiations = false;
}

/**
 * Signal that DOM instantiation occurred during deferred mode.
 * Called from instantiateTemplate when new elements are created.
 */
function markInstantiation() {
    if (isDeferringUpdates) {
        hadInstantiations = true;
    }
}

/**
 * Exit deferred update mode and apply DOM commits.
 * If instantiations occurred, apply immediately to avoid FOUC.
 * Otherwise, schedule via rAF for batching efficiency.
 */
function commitDeferredUpdates() {
    isDeferringUpdates = false;

    const hasPendingUpdates = pendingAttrUpdates.size > 0 || pendingTextUpdates.size > 0;

    if (hasPendingUpdates) {
        if (hadInstantiations) {
            // New elements were added - apply updates immediately to keep
            // instantiations and style updates in sync (avoids jank in virtual scroll
            // where elements would appear then jump to correct position)
            applyPendingDOMUpdates();
        } else if (!domCommitScheduled) {
            // No instantiations - safe to batch via RAF for efficiency
            domCommitScheduled = true;
            requestAnimationFrame(applyPendingDOMUpdates);
        }
    }

    hadInstantiations = false;
}

/**
 * Force-flush all pending DOM updates immediately.
 * Used by flushSync() when synchronous DOM access is needed.
 */
export function flushDOMUpdates() {
    if (pendingAttrUpdates.size > 0 || pendingTextUpdates.size > 0) {
        applyPendingDOMUpdates();
    }
}

/**
 * Queue or apply an attribute update depending on mode.
 */
function applyAttribute(el, name, value, isCustomTag) {
    // Input value/checked updates must happen immediately to avoid
    // overwriting user typing during the RAF delay
    const isInputValue = name === 'value' &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
    const isChecked = name === 'checked' && el.tagName === 'INPUT';

    if (isDeferringUpdates && !isInputValue && !isChecked) {
        // Queue for later commit (last-write-wins)
        if (!pendingAttrUpdates.has(el)) {
            pendingAttrUpdates.set(el, new Map());
        }
        pendingAttrUpdates.get(el).set(name, { value, isCustomTag, owner: getActiveEffect() });
    } else {
        // Apply directly (initial render, outside effect flush, or input values)
        applyAttributeDirect(el, name, value, isCustomTag);
    }
}

/**
 * Queue or apply a text node update depending on mode.
 */
function applyTextContent(textNode, value) {
    if (isDeferringUpdates) {
        // Queue for later commit (last-write-wins)
        pendingTextUpdates.set(textNode, { value, owner: getActiveEffect() });
    } else {
        // Apply directly
        textNode.textContent = value ?? '';
    }
}

// ============================================================================

// Marker for deferred children (passed to custom elements)
const DEFERRED_CHILDREN = Symbol('vdx:deferred-children');

// Marker for value getter functions (to distinguish from actual function values)
export const VALUE_GETTER = Symbol('vdx:value-getter');

// SECURITY: attribute/property names that parse HTML or run script if assigned
/**
 * Parse raw() HTML into a DocumentFragment via a <template> element.
 * Template content has no parsing-context restrictions, so fragments like
 * <tr>/<td>/<li> parse correctly (div/span.innerHTML would drop them),
 * and no wrapper element is introduced around the content.
 * Scripts parsed via innerHTML are inert in both approaches.
 */
function parseRawHTML(rawValue, inSvg = false) {
    const tpl = vdxCreateElement('template');
    tpl.innerHTML = rawValue.toString();
    // <template>.innerHTML parses in the HTML namespace, so raw SVG markup
    // (<circle>, <path>, …) comes out as HTMLUnknownElements that never paint.
    // Re-namespace the fragment when it's being inserted inside an <svg>.
    if (inSvg) {
        return fixSvgNamespace(tpl.content);
    }
    return tpl.content;
}

/**
 * Insert content into DOM without current effect context.
 * This prevents child component state from becoming dependencies of parent effects,
 * while still allowing child components to establish their own effect tracking.
 * Critical for custom elements whose connectedCallback creates its own reactive effects.
 */
function insertWithoutParentTracking(referenceNode, content) {
    withoutTracking(() => {
        referenceNode.after(content);
    });
}

/**
 * Create a deferred child descriptor.
 * Captures everything needed to instantiate the child later,
 * including the parent component reference for reactive context.
 */
export function createDeferredChild(compiled, values, parentComponent) {
    return {
        [DEFERRED_CHILDREN]: true,
        compiled,
        values,
        parentComponent,
        slotName: null
    };
}

/**
 * Check if a value is a deferred child descriptor
 */
export function isDeferredChild(value) {
    return value && typeof value === 'object' && value[DEFERRED_CHILDREN] === true;
}

/**
 * Wrap raw values in VALUE_GETTER getters reading from a reactive container
 * ({ current: values }), so child effects re-run when the container is
 * updated in place. Single implementation for the five call sites that
 * previously copy-pasted this block.
 * @param {Array} rawValues
 * @param {{current: Array}} valuesRef - reactive container
 * @returns {Array<Function>}
 */
function wrapReactiveValues(rawValues, valuesRef) {
    return rawValues.map((_, index) => {
        const getter = () => valuesRef.current[index];
        getter[VALUE_GETTER] = true;
        return getter;
    });
}

/**
 * Instantiate a compiled template into real DOM nodes with reactive effects.
 *
 * @param {Object} compiled - Compiled template (from compileTemplate)
 * @param {Array} values - Dynamic values array
 * @param {Object} component - Component instance for bindings
 * @param {boolean} [inSvg=false] - Whether we're inside an SVG context (for namespace inheritance)
 * @returns {{ fragment: DocumentFragment, effects: Array, cleanup: Function }}
 */
export function instantiateTemplate(compiled, values, component, inSvg = false) {
    // Signal that DOM instantiation is occurring - this ensures attribute updates
    // are applied immediately (not deferred to RAF) to avoid FOUC
    markInstantiation();

    const effects = [];
    const fragment = document.createDocumentFragment();

    instantiateNode(compiled, values, component, fragment, effects, inSvg);

    return {
        fragment,
        effects,
        cleanup() {
            for (const effect of effects) {
                if (effect.dispose) effect.dispose();
            }
            effects.length = 0;
        }
    };
}

/**
 * Whether a compiled item root can change node count after instantiation, i.e.
 * whether it puts a slot directly in the list (rather than inside an element,
 * where the slot's content moves with its parent). Only fragment children are
 * walked - everything under an ELEMENT is that element's problem.
 *
 * @param {Object} compiled - Compiled node (a keyed list child)
 * @returns {boolean}
 */
function hasVariableRoot(compiled) {
    if (!compiled) return false;
    if (compiled.op === OP.SLOT) return true;
    if (compiled.op === OP.FRAGMENT) {
        for (const child of compiled.children || []) {
            if (hasVariableRoot(child)) return true;
        }
    }
    return false;
}

/**
 * A keyed child that renders nothing by design: EMPTY_WHEN_RESULT's compiled
 * node (op STATIC with no template). A real static template always carries one.
 */
function isEmptyChild(compiled) {
    return compiled.op === OP.STATIC && compiled.template == null;
}

/**
 * Collect the live nodes of a DOM range, first..tail inclusive.
 */
function walkRange(first, tail) {
    const nodes = [];
    for (let n = first; n; n = n.nextSibling) {
        nodes.push(n);
        if (n === tail) break;
    }
    return nodes;
}

/**
 * Build the per-item record a keyed list keeps (nodes + effects + provenance).
 *
 * Items with a slot at their root can change node count at any time: the slot
 * swaps its own content inside its own effect and the list is never told. A
 * node array captured at instantiation then strands live nodes and re-inserts
 * detached ones on the next move, and misplaces insertPoint. Those items get a
 * trailing comment anchor and report their nodes by walking the DOM instead.
 * Fixed-shape items - the common `item => html`<li>...</li>` - keep the plain
 * array and pay nothing. See BUG-REPORT-keyed-item-node-snapshot.md.
 *
 * Call before inserting the fragment: the anchor is appended to it here.
 *
 * @param {DocumentFragment} fragment - Freshly instantiated item DOM
 * @param {Object} compiled - The item's keyed compiled child
 * @param {Array} effects - Effects owned by the item
 * @param {Object} valuesRef - Reactive values container for the item
 * @returns {Object} Item record with a (possibly live) `nodes`
 */
function makeItemRecord(fragment, compiled, effects, valuesRef) {
    const record = { effects, compiled, valuesRef };
    const snapshot = [...fragment.childNodes];

    if (snapshot.length === 0 || !hasVariableRoot(compiled)) {
        record.nodes = snapshot;
        return record;
    }

    const first = snapshot[0];
    const tail = document.createComment('');
    fragment.appendChild(tail);
    // A getter, not an array - the range is only correct at the moment it is
    // read. Callers must reuse this record object rather than copying it:
    // `{...record}` or `{nodes: record.nodes, ...}` flattens it back into the
    // snapshot this exists to replace.
    Object.defineProperty(record, 'nodes', {
        get: () => walkRange(first, tail),
        enumerable: true,
        configurable: true
    });
    return record;
}

/**
 * Update a keyed list (from each()) by diffing items and only updating changed ones.
 * This preserves DOM nodes for unchanged items, avoiding puppeteer element handle issues.
 *
 * @param {Array} newChildren - New compiled children
 * @param {Array} oldChildren - Old compiled children
 * @param {Map} oldItemMap - Map of old items by key
 * @param {Comment} placeholder - Placeholder comment node
 * @param {Object} component - Parent component
 * @param {boolean} slotInSvg - Whether slot is in SVG context
 * @param {boolean} hasExplicitKeys - Whether keys are user-provided (not index-based)
 * @returns {Object|null} { nodes, effects, itemMap } or null if update failed
 */
function updateKeyedList(newChildren, oldChildren, oldItemMap, placeholder, component, slotInSvg = false, hasExplicitKeys = false) {
    // Build map of old items by key
    const newItemMap = new Map();
    const allNodes = [];
    const allEffects = [];

    // Get keys from children
    const newKeys = newChildren.map(c => c?.key);
    const oldKeys = oldChildren.map(c => c?.key);

    // Check for duplicate keys (which would cause reconciliation bugs).
    // Opt-in diagnostic (window.__LIST_KEY_DEBUG__ = true): building the Sets
    // is O(n) on every keyed update, too costly to run unconditionally on
    // large lists. Enable it in dev/e2e runs - see docs/testing.md.
    if (typeof window !== 'undefined' && window.__LIST_KEY_DEBUG__) {
        const uniqueNewKeys = new Set(newKeys);
        const uniqueOldKeys = new Set(oldKeys);
        if (uniqueNewKeys.size !== newKeys.length) {
            console.warn('[Fine-grained] DUPLICATE KEYS in newChildren!', newKeys.length, 'items but only', uniqueNewKeys.size, 'unique keys. First few keys:', newKeys.slice(0, 5));
        }
        if (uniqueOldKeys.size !== oldKeys.length) {
            console.warn('[Fine-grained] DUPLICATE KEYS in oldChildren!', oldKeys.length, 'items but only', uniqueOldKeys.size, 'unique keys. First few keys:', oldKeys.slice(0, 5));
        }
    }

    // Quick check: if keys are identical, just update values in each item
    let keysIdentical = newKeys.length === oldKeys.length;
    if (keysIdentical) {
        for (let i = 0; i < newKeys.length; i++) {
            if (newKeys[i] !== oldKeys[i]) {
                keysIdentical = false;
                break;
            }
        }
    }

    if (keysIdentical) {
        // Keys are the same - update each item in place
        let insertPoint = placeholder;
        for (let i = 0; i < newChildren.length; i++) {
            const newChild = newChildren[i];
            const oldChild = oldChildren[i];
            const key = newChild?.key;
            const oldItem = oldItemMap.get(key);

            if (!oldItem) {
                // Item exists but no old data - shouldn't happen, fallback to full reinstantiation
                return null;
            }

            // Check if structure is the same (ignoring key and _itemValues)
            const sameStructure = isSameStructure(newChild, oldChild);

            if (sameStructure && oldItem.valuesRef) {
                // Same structure and we have a reactive values container
                // Just update the container - effects will re-run automatically
                const newValues = newChild._itemValues || [];
                oldItem.valuesRef.current = newValues;

                // Reuse the record itself: copying it would snapshot a live
                // `nodes` getter back into a plain array.
                oldItem.compiled = newChild;
                newItemMap.set(key, oldItem);
                const itemNodes = oldItem.nodes;
                allNodes.push(...itemNodes);
                allEffects.push(...oldItem.effects);
                if (itemNodes.length > 0) insertPoint = itemNodes[itemNodes.length - 1];
            } else {
                // Structure changed (or item has no reactive values container,
                // which shouldn't happen) - reinstantiate this item
                // Clean up old item - remove its live range BEFORE disposing,
                // since disposal detaches the node the range walk starts from
                for (const node of oldItem.nodes) node.remove();
                for (const eff of oldItem.effects) if (eff.dispose) eff.dispose();

                // Create new item with reactive values
                const newValues = newChild._itemValues || [];
                const valuesRef = reactive({ current: newValues });
                const wrappedValues = wrapReactiveValues(newValues, valuesRef);

                const { fragment, effects: childEffects } = instantiateTemplate(
                    newChild,
                    wrappedValues,
                    component,
                    slotInSvg
                );
                const record = makeItemRecord(fragment, newChild, childEffects, valuesRef);
                insertPoint.after(fragment);
                const nodes = record.nodes;
                if (nodes.length > 0) insertPoint = nodes[nodes.length - 1];

                newItemMap.set(key, record);
                allNodes.push(...nodes);
                allEffects.push(...childEffects);
            }
        }

        return { nodes: allNodes, effects: allEffects, itemMap: newItemMap };
    }

    // Keys changed - only do proper keyed reconciliation with explicit keys
    // Index-based keys don't represent item identity, so reordering would cause
    // incorrect DOM reuse (e.g., item at index 0 removed, item 1 becomes 0)
    if (!hasExplicitKeys) {
        // Return null to trigger full re-instantiation
        return null;
    }

    // Reuse DOM for items that exist in both old and new lists
    const newKeySet = new Set(newKeys);

    // Step 1: Remove items that are no longer present
    // (Their dispose() will clean up DOM thanks to our enhanced disposal)
    for (const [oldKey, oldItem] of oldItemMap) {
        if (!newKeySet.has(oldKey)) {
            // Read the range first: disposal can detach the node the live walk
            // starts from (a slot-rooted item begins at that slot's placeholder).
            const staleNodes = oldItem.nodes;
            // Item removed - dispose effects (which removes DOM)
            for (const eff of oldItem.effects) {
                if (eff.dispose) eff.dispose();
            }
            // Also remove nodes directly in case they weren't in effects
            for (const node of staleNodes) {
                if (node.parentNode) node.remove();
            }
        }
    }

    // Step 2: Decide reuse per new child (same key AND same template shape -
    // a key can keep its identity while switching template shape)
    const reuse = new Array(newChildren.length).fill(null);
    for (let i = 0; i < newChildren.length; i++) {
        const newChild = newChildren[i];
        const existing = newChild ? oldItemMap.get(newChild.key) : null;
        if (existing && isSameStructure(newChild, existing.compiled)) {
            reuse[i] = existing;
        } else if (existing) {
            // Same key, different template - dispose the stale item, rebuild below
            // (range read before disposal, as in step 1)
            const staleNodes = existing.nodes;
            for (const eff of existing.effects) {
                if (eff.dispose) eff.dispose();
            }
            for (const node of staleNodes) {
                if (node.parentNode) node.remove();
            }
        }
    }

    // Step 3: Find which reused items keep their DOM position. Items whose old
    // positions form the longest increasing subsequence are already in correct
    // relative order - only the rest move. This minimizes DOM moves (e.g.
    // moving one item to the end moves 1 item, not n-1).
    const oldIndexByKey = new Map();
    for (let i = 0; i < oldKeys.length; i++) {
        if (!oldIndexByKey.has(oldKeys[i])) {
            oldIndexByKey.set(oldKeys[i], i);
        }
    }
    const reusedPositions = [];
    for (let i = 0; i < newChildren.length; i++) {
        if (reuse[i]) {
            reusedPositions.push({ i, v: oldIndexByKey.get(newChildren[i].key) });
        }
    }
    const stableIndices = longestIncreasingIndices(reusedPositions);

    // Step 4: Build new list, moving/creating only what's needed
    let insertPoint = placeholder;

    for (let i = 0; i < newChildren.length; i++) {
        const newChild = newChildren[i];
        const key = newChild?.key;
        const existingItem = reuse[i];

        if (existingItem) {
            // Reuse existing item - update values if needed
            if (existingItem.valuesRef) {
                const newValues = newChild._itemValues || [];
                existingItem.valuesRef.current = newValues;
            }

            // One walk per item: `nodes` may be a live DOM range.
            const itemNodes = existingItem.nodes;

            if (!stableIndices.has(i) && itemNodes[0] &&
                itemNodes[0].previousSibling !== insertPoint) {
                // Not part of the stable subsequence - move after insertPoint
                for (const node of itemNodes) {
                    insertPoint.after(node);
                    insertPoint = node;
                }
            } else if (itemNodes.length > 0) {
                // Stable (or already in place) - just advance insertPoint
                insertPoint = itemNodes[itemNodes.length - 1];
            }

            // Reuse the record itself - copying it would snapshot a live range.
            existingItem.compiled = newChild;
            newItemMap.set(key, existingItem);
            allNodes.push(...itemNodes);
            allEffects.push(...existingItem.effects);
        } else {
            // New item - create DOM
            const newValues = newChild._itemValues || [];
            const valuesRef = reactive({ current: newValues });
            const wrappedValues = wrapReactiveValues(newValues, valuesRef);

            const { fragment, effects: childEffects } = instantiateTemplate(
                newChild,
                wrappedValues,
                component,
                slotInSvg
            );
            const record = makeItemRecord(fragment, newChild, childEffects, valuesRef);
            insertPoint.after(fragment);
            const nodes = record.nodes;
            if (nodes.length > 0) {
                insertPoint = nodes[nodes.length - 1];
            }

            newItemMap.set(key, record);
            allNodes.push(...nodes);
            allEffects.push(...childEffects);
        }
    }

    // Sanity check: if we have children but no nodes were created, something went
    // wrong - EXCEPT when every child is the empty template. A keyed list whose
    // items are all a when() with no matching branch legitimately renders
    // nothing; treating that as a failure logged on every update and threw away
    // all DOM reuse (it would recover, then trip again on the next update).
    if (allNodes.length === 0 && newChildren.some(c => c && !isEmptyChild(c))) {
        console.warn('[Fine-grained] updateKeyedList: Expected', newChildren.length, 'items but created 0 nodes');
        return null;  // Force re-instantiation
    }

    return { nodes: allNodes, effects: allEffects, itemMap: newItemMap };
}

/**
 * Find the longest increasing subsequence of position values.
 * Used by keyed reconciliation: reused items whose old positions form an
 * increasing subsequence are already in correct relative order and don't
 * need to move. O(n log n) patience sorting with predecessor links.
 *
 * @param {Array<{i: number, v: number}>} positions - new-list index (i) and old position (v)
 * @returns {Set<number>} Set of new-list indices (i) that are part of the LIS
 */
function longestIncreasingIndices(positions) {
    const tails = [];  // tails[len-1] = index into positions[] of smallest tail value for an LIS of that length
    const prev = new Array(positions.length).fill(-1);

    for (let k = 0; k < positions.length; k++) {
        const v = positions[k].v;
        // Binary search: first tail with value >= v
        let lo = 0, hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (positions[tails[mid]].v < v) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if (lo > 0) {
            prev[k] = tails[lo - 1];
        }
        tails[lo] = k;
    }

    // Walk back from the end of the longest subsequence
    const result = new Set();
    let k = tails.length > 0 ? tails[tails.length - 1] : -1;
    while (k >= 0) {
        result.add(positions[k].i);
        k = prev[k];
    }
    return result;
}

/**
 * Check if two compiled children have the same structure (ignoring key and values)
 */
function isSameStructure(a, b) {
    if (!a || !b) return a === b;
    // Keyed children carry _src: the compiled template node they were derived
    // from, which has stable identity via the template cache. This catches
    // items switching between different templates that happen to share the
    // same tag/child-count (a shallow shape comparison cannot tell them apart).
    // The (statics, index) fallback survives cache eviction: a recompiled row
    // template is a new object, but the same statics + child position proves
    // it is the same template.
    if (a._src && b._src) {
        return a._src === b._src ||
            !!(a._src._statics && a._src._statics === b._src._statics &&
               a._src._staticsIndex === b._src._staticsIndex);
    }
    // Fallback shape comparison for children without provenance
    if (a.op !== b.op) return false;
    if (a.tag !== b.tag) return false;
    // For fragments, check children count
    if (a.children?.length !== b.children?.length) return false;
    return true;
}

/**
 * Instantiate a single node (dispatcher)
 * @param {boolean} [inSvg=false] - Whether we're inside an SVG context
 */
function instantiateNode(node, values, component, parent, effects, inSvg = false) {
    if (!node) return;

    switch (node.op) {
        case OP.STATIC:
            instantiateStatic(node, parent, inSvg);
            break;
        case OP.SLOT:
            instantiateSlot(node, values, component, parent, effects, inSvg);
            break;
        case OP.TEXT:
            instantiateText(node, parent);
            break;
        case OP.ELEMENT:
            instantiateElement(node, values, component, parent, effects, inSvg);
            break;
        case OP.FRAGMENT:
            instantiateFragment(node, values, component, parent, effects, inSvg);
            break;
    }
}

/**
 * Instantiate a static node by cloning pre-built DOM.
 * Uses importNode to ensure the clone is in the current document context,
 * which is important for custom elements to use the correct registry.
 *
 * When in SVG context, static templates may need namespace correction since
 * they were compiled without knowing they'd be inside an SVG.
 */
function instantiateStatic(node, parent, inSvg = false) {
    if (node.template) {
        // Use importNode to clone the DOM into the current document.
        // This ensures custom elements are constructed using the current
        // document's CustomElementRegistry (important for cross-context cloning).
        const clone = document.importNode(node.template, true);

        // If we're in SVG context, correct the clone's namespace. fixSvgNamespace
        // handles a single element root as well as a multi-root DocumentFragment
        // (a mapped html`` fragment with several top-level SVG elements clones to
        // a fragment, whose nodeType is not ELEMENT_NODE — the old guard skipped
        // it and the children never painted).
        if (inSvg) {
            parent.appendChild(fixSvgNamespace(clone));
        } else {
            parent.appendChild(clone);
        }
    }
    // If template is null, nothing to render (empty result)
}

/**
 * Fix SVG namespace for a node and its descendants.
 * Used when static templates / raw() fragments are instantiated inside SVG
 * context — they were built in the HTML namespace (the compiler and
 * <template>.innerHTML don't know they'll land inside an <svg>), so their
 * elements would be HTMLUnknownElements that never paint.
 *
 * Handles a single element root, a multi-root DocumentFragment (e.g. a mapped
 * fragment or raw() string with several top-level SVG elements), and passes
 * text/comment nodes through untouched.
 */
function fixSvgNamespace(element) {
    // DocumentFragment: fix each element child in place, return the fragment.
    if (element.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (const child of [...element.childNodes]) {
            if (child.nodeType === Node.ELEMENT_NODE) {
                element.replaceChild(fixSvgNamespace(child), child);
            }
        }
        return element;
    }

    // Non-element nodes (text, comment) need no namespace correction.
    if (element.nodeType !== Node.ELEMENT_NODE) {
        return element;
    }

    // If already in SVG namespace, no fix needed
    if (element.namespaceURI === SVG_NS) {
        return element;
    }

    // Recreate element with SVG namespace
    const lowerTag = element.tagName.toLowerCase();
    const fixed = document.createElementNS(SVG_NS, SVG_TAG_CASE.get(lowerTag) || lowerTag);

    // Copy attributes
    for (const attr of element.attributes) {
        fixed.setAttribute(attr.name, attr.value);
    }

    // Recursively fix children
    while (element.firstChild) {
        const child = element.firstChild;
        if (child.nodeType === Node.ELEMENT_NODE) {
            fixed.appendChild(fixSvgNamespace(child));
        } else {
            fixed.appendChild(child);
        }
    }

    return fixed;
}

/**
 * Instantiate a text node
 */
function instantiateText(node, parent) {
    if (node.value != null) {
        parent.appendChild(document.createTextNode(node.value));
    }
}

/**
 * Compute the keyed compiled children for a memoEach() vnode, applying the
 * two-cache-rotation memoization. Single implementation shared by the keyed
 * fast path and the initial memoEach handler in instantiateSlot - these were
 * duplicated (~130 lines) and had already diverged (the fast path did not
 * clear an explicit cache on deps change).
 *
 * Mutates memoState (the slot-scoped cache state): prevCache/currCache are
 * rotated here; prevDeps is updated on deps change; prevChildren is managed
 * by the callers.
 *
 * @param {Object} value - The memoEach() marker vnode
 * @param {{prevCache: Map|null, currCache: Map|null, prevDeps: Array|null, prevChildren: Array|null}} memoState
 * @param {Object} component - Component instance (render context for mapFn)
 * @returns {Array} Keyed compiled children (each()-fragment shape)
 */
function computeMemoEachChildren(value, memoState, component) {
    const { _array: array, _mapFn: mapFn, _keyFn: keyFn, _explicitCache: explicitCache, _trustKey: trustKey, _deps: deps } = value;

    // Explicit cache (backward compatibility) is used INSTEAD of the
    // slot-level rotating caches when supplied.
    const useExplicitCache = explicitCache instanceof Map ? explicitCache :
                             explicitCache?.itemCache ? explicitCache.itemCache : null;

    // Deps changed -> bust all caches (every item re-renders)
    if (deps) {
        let depsChanged = false;
        if (!memoState.prevDeps || memoState.prevDeps.length !== deps.length) {
            depsChanged = true;
        } else {
            for (let i = 0; i < deps.length; i++) {
                if (deps[i] !== memoState.prevDeps[i]) {
                    depsChanged = true;
                    break;
                }
            }
        }
        if (depsChanged) {
            memoState.prevCache = null;
            memoState.currCache = null;
            if (useExplicitCache) useExplicitCache.clear();
        }
        memoState.prevDeps = deps;
    }

    // New current cache for this render; the rotation below prunes entries
    // whose keys have left the array (two renders of absence = collected).
    const newCurrCache = new Map();

    // Single pass: key is computed once per item and reused for both the
    // cache lookup and toKeyedChild (keyed children for list reconciliation).
    const children = [];
    for (let index = 0; index < array.length; index++) {
        const item = array[index];
        const key = keyFn(item, index);

        // The current cache may already hold the key (duplicate keys in the
        // array). trustKey skips the item-reference check - useful for virtual
        // scroll where items are re-sliced and object identity changes.
        let result;
        const cachedCurr = newCurrCache.get(key);
        const cachedPrev = useExplicitCache ? useExplicitCache.get(key) :
                           (memoState.prevCache?.get(key) || memoState.currCache?.get(key));
        if (cachedCurr && (trustKey || cachedCurr.item === item)) {
            result = cachedCurr.result;
        } else if (cachedPrev && (trustKey || cachedPrev.item === item)) {
            newCurrCache.set(key, cachedPrev);
            if (useExplicitCache) useExplicitCache.set(key, cachedPrev);
            result = cachedPrev.result;
        } else {
            // Cache miss - render and cache. No key/_src stamping here:
            // toKeyedChild() below is the canonical keyed-child producer and
            // nothing reads `result` in between.
            result = mapFn(item, index);
            const cacheEntry = { item, result };
            newCurrCache.set(key, cacheEntry);
            if (useExplicitCache) useExplicitCache.set(key, cacheEntry);
        }

        // Keyed children (each()-fragment shape) for list reconciliation
        const child = toKeyedChild(result, key);
        if (child) children.push(child);
    }

    // Rotate caches: previous = current, current = new.
    // The old previous cache is garbage collected (automatic pruning).
    memoState.prevCache = memoState.currCache;
    memoState.currCache = newCurrCache;

    return children;
}

/* ------------------------------------------------- slot values: one answer */

/**
 * What kind of value a slot has been handed. ONE classifier for the ordinary
 * slot and the contain() boundary (tests/framework/slot-relations.test.js
 * holds them to agreeing). Order matters: a contain() marker is also an html
 * marker, and a marker with nothing to render is 'empty', not text.
 */
function slotKind(value) {
    if (value == null || value === false) return 'empty';
    if (isContain(value)) return value._renderFn ? 'contain' : 'empty';
    if (isMemoEach(value)) return 'memoEach';
    if (isHtml(value)) return value._compiled ? 'html' : 'empty';
    if (isRaw(value)) return 'raw';
    if (isDeferredChild(value)) return 'deferred';
    if (value instanceof Node) return 'node';
    if (Array.isArray(value)) return 'array';
    return 'text';
}

/**
 * Turn one slot value into DOM. Returns what to insert, the nodes it
 * contributes (a fragment empties on insert, so it can be neither a cleanup
 * record nor an insertion point), the effects that keep it live, and - for an
 * html`` template rendered with `reuse` - the reactive values container that
 * lets the same structure be updated in place next time.
 *
 * Not for 'array' (materializeArray walks one), nor 'contain' or 'memoEach',
 * whose state is owned by the slot they sit in.
 */
function materialize(value, kind, component, slotInSvg, reuse = false) {
    switch (kind) {
        case 'html': {
            const rawValues = value._values || [];
            const valuesRef = reuse ? reactive({ current: rawValues }) : null;
            const { fragment, effects } = instantiateTemplate(
                value._compiled,
                valuesRef ? wrapReactiveValues(rawValues, valuesRef) : rawValues,
                component,
                slotInSvg
            );
            return { insert: fragment, nodes: [...fragment.childNodes], effects, valuesRef, compiled: value._compiled };
        }
        case 'raw': {
            const content = parseRawHTML(value, slotInSvg);
            return { insert: content, nodes: [...content.childNodes], effects: [] };
        }
        case 'deferred': {
            // A child written between a component's tags renders in the
            // PARENT's reactive context, owned by the parent's compute effect
            // so it is disposed when the parent re-renders rather than left
            // orphaned in the child's tree.
            const { compiled, values: childValues, parentComponent } = value;
            const parentEffect = parentComponent?._computeEffect;
            const run = () => instantiateTemplate(compiled, childValues, parentComponent, slotInSvg);
            const { fragment, effects } = parentEffect ? runAsEffect(parentEffect, run) : run();
            return { insert: fragment, nodes: [...fragment.childNodes], effects };
        }
        case 'node': {
            const nodes = value.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? [...value.childNodes] : [value];
            return { insert: value, nodes, effects: [] };
        }
        default: {
            // Safe: textContent can never be parsed as HTML
            const textNode = document.createTextNode(String(value));
            return { insert: textNode, nodes: [textNode], effects: [] };
        }
    }
}

/**
 * Render an each()/memoEach() fragment's keyed children, one record per item
 * so the slot can reconcile them by key next time (updateKeyedList). The one
 * way a keyed list is first put on the page, for the slot and for a contain()
 * boundary alike.
 */
function materializeKeyed(value, insertPoint, component, slotInSvg) {
    const itemMap = new Map();
    const nodes = [];
    const effects = [];
    for (const child of value._compiled.children) {
        const rawValues = child._itemValues || [];
        // Create reactive container for this item's values
        const valuesRef = reactive({ current: rawValues });
        const { fragment, effects: childEffects } = instantiateTemplate(
            child,
            wrapReactiveValues(rawValues, valuesRef),
            component,
            slotInSvg
        );
        const record = makeItemRecord(fragment, child, childEffects, valuesRef);
        insertWithoutParentTracking(insertPoint, fragment);
        if (record.nodes.length > 0) insertPoint = record.nodes[record.nodes.length - 1];
        itemMap.set(child.key, record);
        nodes.push(...record.nodes);
        effects.push(...childEffects);
    }
    return { nodes, effects, itemMap };
}

/**
 * The items an array of slot values really holds: a when() item is the branch
 * it selects, an empty branch is no item at all, and an array - whether it was
 * written as one or only became one when a when() resolved - is its items.
 *
 * Resolving and flattening have to interleave. Flattening first leaves an
 * array that a branch returns unflattened, and the refusals below run on the
 * result of this walk, so such an item reached materialize() as an array and
 * was stringified past them.
 */
function flattenSlotItems(items, out = []) {
    for (const raw of items) {
        const item = resolveWhen(raw);
        if (item === EMPTY_WHEN_RESULT) continue;
        if (Array.isArray(item)) flattenSlotItems(item, out);
        else out.push(item);
    }
    return out;
}

/**
 * Walk an array of slot values, inserting each after the last - over the items
 * flattenSlotItems() says it holds, whose thunks run here and so are tracked by
 * the slot's effect.
 *
 * `allowHtml`: a bare array of html`` templates - almost always
 * `items.map(i => html`...`)` - has no keyed placeholders, so the DOM desyncs
 * the moment the list changes length; an ordinary slot refuses it before
 * inserting anything, and each() exists for that. Inside a contain() boundary
 * the whole boundary is replaced on any change, so there is nothing to desync
 * and the items render.
 */
function materializeArray(items, insertPoint, component, slotInSvg, allowHtml) {
    items = flattenSlotItems(items);
    // Refuse before inserting anything, so a bad item never leaves a
    // half-rendered slot behind. A contain() or memoEach() needs a slot of its
    // own to hold its state (the boundary effect, the memo cache) and an array
    // item is not one; stringifying the marker rendered "[object Object]".
    for (const item of items) {
        const kind = slotKind(item);
        if (kind === 'contain' || kind === 'memoEach') {
            throw new Error(
                `${kind}() cannot be an item of a slot array - an item has no slot of its ` +
                'own to hold its state. Give it one: html`${' + kind + '(...)}`'
            );
        }
    }
    if (!allowHtml && items.some(isHtml)) {
        throw new Error(
            'Rendering a raw array of html`` templates in a slot is not supported - ' +
            'it creates no keyed placeholders and desyncs the DOM when the list changes. ' +
            'Use each(items, item => html`...`) for lists (or when() for conditionals) ' +
            'instead of .map() or a bare array.'
        );
    }
    const nodes = [];
    const effects = [];
    for (const item of items) {
        const kind = slotKind(item);
        if (kind === 'empty') continue;
        const m = materialize(item, kind, component, slotInSvg);
        insertWithoutParentTracking(insertPoint, m.insert);
        if (m.nodes.length > 0) insertPoint = m.nodes[m.nodes.length - 1];
        nodes.push(...m.nodes);
        effects.push(...m.effects);
    }
    return { nodes, effects };
}

/**
 * Instantiate a dynamic slot (the core of fine-grained rendering)
 * @param {boolean} [inSvg=false] - Whether we're inside an SVG context
 */
/**
 * A memoEach() marker becomes the each() fragment its cache says it is. The
 * cache lives on the slot (memoState), so the slot and its contain() boundary
 * share one - a slot holds one or the other at a time. Stamped HTML_MARKER:
 * this is trusted framework-built output, and the html gate requires the
 * marker so untrusted data shaped like {_compiled:{fromEach:true}} cannot
 * reach it.
 */
function memoEachToFragment(value, memoState, component) {
    const compiledChildren = computeMemoEachChildren(value, memoState, component);
    // Saved for keyed diffing on the slot's next update
    memoState.prevChildren = compiledChildren;
    return {
        [HTML_MARKER]: true,
        _compiled: {
            fromEach: true,
            hasExplicitKeys: true,
            children: compiledChildren
        }
    };
}

function instantiateSlot(node, values, component, parent, effects, inSvg = false) {
    // SECURITY: interpolation inside an inline <script> would execute as
    // JavaScript when the element connects - no template value is trusted for
    // that. Static author-written script content is untouched; only dynamic
    // slots are refused.
    if (parent && parent.nodeType === Node.ELEMENT_NODE && parent.tagName === 'SCRIPT') {
        if (typeof console !== 'undefined') {
            console.warn(
                '[VDX Security] Refused to interpolate into an inline <script>. ' +
                'Pass data via attributes/props, or a static <script type="application/json"> with json-* hydration.'
            );
        }
        return;
    }

    // SECURITY: a text slot under <style> becomes live CSS - apply the same
    // dangerous-construct refusal as the style attribute (see DANGEROUS_CSS).
    const parentIsStyle = parent && parent.nodeType === Node.ELEMENT_NODE && parent.tagName === 'STYLE';

    // Create a placeholder comment for this slot
    const placeholder = document.createComment('');
    parent.appendChild(placeholder);

    // Determine SVG context for child content:
    // - If parent already told us we're in SVG, use that
    // - Otherwise, check if the actual parent element (not fragment) is SVG
    const slotInSvg = inSvg || (parent.namespaceURI === SVG_NS);

    // Track current nodes for this slot (for cleanup/replacement)
    let currentNodes = [];
    let currentEffects = [];
    let previousValue = undefined;
    let initialized = false;
    // For each() results: track per-item DOM state for keyed diffing
    let currentItemMap = null;  // Map<key, { nodes: [], effects: [], compiled: obj }>
    // Reactive container for child template values - allows updates without reinstantiation
    let currentValuesRef = null;

    // memoEach slot-level cache state - stable identity per DOM location.
    // prevCache/currCache (Map<key, {item, result}>) rotate each render for
    // automatic pruning; prevDeps invalidates on deps change; prevChildren
    // holds the last fromEach children for keyed diffing.
    // (See computeMemoEachChildren.)
    const memoState = { prevCache: null, currCache: null, prevDeps: null, prevChildren: null };

    // contain() slot-level state - for DOM reuse across containEffect recreations
    let containPreviousCompiled = null;
    let containValuesRef = null;
    let containNodes = [];
    let containEffects = [];
    let containEffectRef = null;      // The active containEffect
    let containRenderFnRef = null;    // Mutable ref to current renderFn (updated on each render)
    let containOwnsText = false;      // The lone text node shown is the boundary's own to edit

    // Drop what the boundary currently shows, and the memory of it
    const clearBoundary = () => {
        for (const oldNode of containNodes) oldNode.remove();
        for (const oldEffect of containEffects) {
            if (oldEffect.dispose) oldEffect.dispose();
        }
        containNodes = [];
        containEffects = [];
        containPreviousCompiled = null;
        containValuesRef = null;
        containOwnsText = false;
    };
    // ... and the boundary itself, when the slot moves to another kind or goes
    // away entirely. Slot-scoped rather than per-run because the slot's own
    // dispose has to reach it: a boundary's nodes are containNodes, which are
    // in currentNodes only until the boundary first re-renders.
    const cleanupContain = () => {
        if (containEffectRef) {
            containEffectRef.dispose();
            clearBoundary();
            containEffectRef = null;
            containRenderFnRef = null;
        }
    };

    // Slot effects are created while computeEffect is running, so they become
    // children of computeEffect via the ownership system. This ensures proper
    // cascading disposal when components unmount.
    const effect = createEffect(() => {
        // Get the value (may be a function for reactive access)
        let value = values[node.index];
        // Only call if marked as a value getter (not an actual function value)
        if (typeof value === 'function' && value[VALUE_GETTER]) {
            value = value();
        }

        // EARLY when() processing - the branch is selected BEFORE the
        // comparison below, so two renders of the same branch compare their
        // cached _compiled rather than two fresh when() markers. Thunks run
        // here, tracked by this effect; depth ordering (computeEffect at 0,
        // slots at 1+) guarantees the cached values are current first.
        value = resolveWhen(value);

        if (parentIsStyle && typeof value === 'string' && DANGEROUS_CSS.test(value)) {
            if (typeof console !== 'undefined') {
                console.warn(
                    '[VDX Security] Refused a <style> text value containing a dangerous ' +
                    'CSS construct (expression()/javascript:/@import/behavior).'
                );
            }
            value = '';
        }

        // Skip re-render if value is the same
        // For html templates, compare _compiled reference (the actual template structure)
        // This preserves child component state when slot content structure doesn't change
        if (initialized) {
            if (value === previousValue) {
                return;
            }
            // For html templates (but NOT contain), check if _compiled is the same - the child effects
            // will handle updating any changed values within. Contain is handled specially below.
            if (isHtml(value) && isHtml(previousValue) && !isContain(value) &&
                isSameCompiled(value._compiled, previousValue._compiled)) {
                // Same template structure - update values reactively without re-instantiating
                // This preserves DOM state (focus, scroll position, input values, etc.)
                const newValues = value._values || [];

                // Update the reactive values container - child effects will re-run automatically
                if (currentValuesRef) {
                    currentValuesRef.current = newValues;
                    previousValue = value;
                    return;
                }
                // Fall through to re-instantiation if no valuesRef (shouldn't happen)
            }

            // For contain() vnodes with same _compiled, skip to contain handler (updates renderFn ref)
            // This is the fast path for contain() - no cleanup, just update renderFn
            if (isContain(value) && isContain(previousValue) &&
                value._compiled === previousValue._compiled && containEffectRef) {
                containRenderFnRef = value._renderFn;
                previousValue = value;
                return;
            }

            // Debug: Log re-instantiation - enable with window.__SLOT_DEBUG__ = true
            if (typeof window !== 'undefined' && window.__SLOT_DEBUG__) {
                const vComp = value?._compiled;
                const pComp = previousValue?._compiled;
                // Get template hint from tag or first child for identification
                const getHint = (compiled) => {
                    if (!compiled) return 'null';
                    if (compiled.tag) return compiled.tag;
                    if (compiled.children?.[0]?.tag) return 'frag:' + compiled.children[0].tag;
                    return compiled.op;
                };
                console.log('[SLOT] RE-INSTANTIATE', {
                    slotIndex: node.index,
                    valueType: isHtml(value) ? 'html' : isContain(value) ? 'contain' : isMemoEach(value) ? 'memoEach' : typeof value,
                    prevType: isHtml(previousValue) ? 'html' : isContain(previousValue) ? 'contain' : isMemoEach(previousValue) ? 'memoEach' : typeof previousValue,
                    compiledSame: vComp === pComp,
                    valueOp: vComp?.op,
                    prevOp: pComp?.op,
                    valueHint: getHint(vComp),
                    prevHint: getHint(pComp),
                });
            }

            // For contain() boundaries, we always recreate the containEffect (cheap)
            // but reuse DOM when the compiled template structure matches.
            // State is maintained at the slot level, not inside the containEffect.
            // This removes the fragile toString() comparison for call-site identity.

            // For memoEach() vnodes, convert to fromEach and do keyed diffing
            // This preserves DOM for items that haven't changed
            if (isMemoEach(value) && isMemoEach(previousValue) &&
                value._compiled === previousValue._compiled &&
                memoState.prevChildren && currentItemMap) {

                const newChildren = computeMemoEachChildren(value, memoState, component);

                // Do keyed diffing with previous children
                const result = updateKeyedList(
                    newChildren,
                    memoState.prevChildren,
                    currentItemMap,
                    placeholder,
                    component,
                    slotInSvg,
                    true  // hasExplicitKeys
                );

                if (result) {
                    currentNodes = result.nodes;
                    currentEffects = result.effects;
                    currentItemMap = result.itemMap;
                    memoState.prevChildren = newChildren;
                    previousValue = value;
                    return;
                }
                // Fall through to full re-instantiation if keyed update failed
            }

            // For each() fragments, do smart keyed diffing
            // This preserves DOM for items that haven't changed structure
            // For index-based keys (no keyFn), only safe when keys are identical
            // updateKeyedList handles this: identical keys -> update in place,
            // changed keys + no explicit keys -> returns null to force re-instantiation
            const isFromEach = isHtml(value) && value._compiled?.fromEach;
            const wasFromEach = isHtml(previousValue) && previousValue._compiled?.fromEach;

            if (isFromEach && wasFromEach && currentItemMap) {
                const result = updateKeyedList(
                    value._compiled.children || [],
                    previousValue._compiled.children || [],
                    currentItemMap,
                    placeholder,
                    component,
                    slotInSvg,
                    value._compiled?.hasExplicitKeys  // Pass flag for handling key changes
                );
                if (result) {
                    currentNodes = result.nodes;
                    currentEffects = result.effects;
                    currentItemMap = result.itemMap;
                    previousValue = value;
                    return;
                }
                // Fall through to full re-instantiation if keyed update failed
            }
        }
        previousValue = value;
        initialized = true;

        // Clean up old nodes and their effects
        for (const oldNode of currentNodes) {
            oldNode.remove();
        }
        for (const oldEffect of currentEffects) {
            if (oldEffect.dispose) oldEffect.dispose();
        }
        currentNodes = [];
        currentEffects = [];
        currentItemMap = null;  // Reset keyed item tracking

        const kind = slotKind(value);
        if (kind === 'empty') {
            cleanupContain();
            return;
        }

        // Handle contain() - isolated reactive boundary
        // Creates its own effect that only tracks dependencies from its render function
        // State is maintained at slot level to enable DOM reuse across containEffect recreations
        if (kind === 'contain') {
            // If we already have a containEffect, just update the renderFn ref
            // The arrow function is recreated each parent render, but we reuse the containEffect
            // and let it call the updated renderFn via the mutable ref
            if (containEffectRef) {
                containRenderFnRef = value._renderFn;
                previousValue = value;  // Update for fast path on next render
                return;
            }

            // Store the initial renderFn - will be updated via containRenderFnRef on parent re-renders
            containRenderFnRef = value._renderFn;

            // Track if we've ever been mounted - used to distinguish "not yet mounted" from "unmounted"
            let containWasMounted = false;

            // Create an isolated effect for this boundary
            // Via ownership, this becomes a child of the slot effect, ensuring cascading disposal
            const newContainEffect = createEffect(() => {
                const CONTAIN_DEBUG = typeof window !== 'undefined' && window.__SLOT_DEBUG__;

                // Check if we've been unmounted by parent (e.g., when() condition became false)
                // Allow first run (not yet mounted), but skip if we were mounted and now disconnected
                if (containWasMounted && !placeholder.isConnected) {
                    return;
                }
                if (placeholder.isConnected) {
                    containWasMounted = true;
                }

                // Track props version - when props change, re-run this effect
                // Without this, contain() effects that read this.props won't update
                if (component._propsVersion) {
                    const _ = component._propsVersion.v;
                }

                // Evaluate the render function in this isolated effect, through the
                // mutable ref so a parent re-render's new closure is the one called.
                // when() resolves as in an ordinary slot. A nested contain() has no
                // slot of its own to own a boundary, so its render function runs
                // inside this one.
                let result = containRenderFnRef();
                for (;;) {
                    result = resolveWhen(result);
                    if (isContain(result) && result._renderFn) {
                        result = result._renderFn();
                        continue;
                    }
                    break;
                }
                let resultKind = slotKind(result);
                if (resultKind === 'memoEach') {
                    // Rendered as the list it is. The keyed-diff fast path is
                    // the slot's, not the boundary's: a boundary is replaced
                    // whole when its structure changes.
                    result = memoEachToFragment(result, memoState, component);
                    resultKind = 'html';
                }

                if (resultKind === 'empty') {
                    clearBoundary();
                    return;
                }

                if (resultKind === 'array') {
                    clearBoundary();
                    const { nodes, effects: arrayEffects } =
                        materializeArray(result, placeholder, component, slotInSvg, true);
                    containNodes = nodes;
                    containEffects = arrayEffects;
                    return;
                }

                if (resultKind === 'text') {
                    // The boundary's OWN lone text node is updated in place -
                    // opt() wraps expressions like ${this.state.count} this way.
                    // A text node the app handed over as a value is not its to
                    // edit; that is replaced like anything else.
                    const textValue = String(result);
                    if (containOwnsText && containNodes.length === 1) {
                        if (containNodes[0].textContent !== textValue) {
                            containNodes[0].textContent = textValue;
                        }
                    } else {
                        clearBoundary();
                        const textNode = document.createTextNode(textValue);
                        insertWithoutParentTracking(placeholder, textNode);
                        containNodes = [textNode];
                        containOwnsText = true;
                    }
                    return;
                }

                if (resultKind !== 'html') {
                    // raw, node, deferred
                    clearBoundary();
                    const m = materialize(result, resultKind, component, slotInSvg);
                    insertWithoutParentTracking(placeholder, m.insert);
                    containNodes = m.nodes;
                    containEffects = m.effects;
                    return;
                }

                // A keyed list is rendered whole; the boundary has no keyed
                // reconciliation of its own (a boundary is replaced when its
                // structure changes, and a fromEach fragment is fresh each render)
                if (result._compiled.fromEach && result._compiled.children?.length > 0) {
                    clearBoundary();
                    const keyed = materializeKeyed(result, placeholder, component, slotInSvg);
                    containNodes = keyed.nodes;
                    containEffects = keyed.effects;
                    return;
                }

                const rawValues = result._values || [];

                // Check if template structure is the same - can reuse DOM
                // Uses slot-level state so this works across containEffect recreations
                if (isSameCompiled(containPreviousCompiled, result._compiled) && containValuesRef) {
                    // Same template structure - just update values reactively
                    // Child effects will re-run automatically
                    containValuesRef.current = rawValues;
                    return;
                }

                // Different template structure - need to reinstantiate
                if (CONTAIN_DEBUG) {
                    const getHint = (compiled) => {
                        if (!compiled) return 'null';
                        if (compiled.tag) return compiled.tag;
                        if (compiled.children?.[0]?.tag) return 'frag:' + compiled.children[0].tag;
                        return compiled.op;
                    };
                    console.log('[CONTAIN] RE-INSTANTIATE', {
                        slotIndex: node.index,
                        compiledSame: containPreviousCompiled === result._compiled,
                        resultOp: result._compiled?.op,
                        prevOp: containPreviousCompiled?.op,
                        resultHint: getHint(result._compiled),
                        prevHint: getHint(containPreviousCompiled),
                    });
                }
                clearBoundary();
                const m = materialize(result, 'html', component, slotInSvg, true);
                containValuesRef = m.valuesRef;
                insertWithoutParentTracking(placeholder, m.insert);
                containNodes = m.nodes;
                containEffects = m.effects;
                containPreviousCompiled = m.compiled;
            }, { label: `contain:slot${node.index}` });

            // Track this containEffect (renderFn already stored above)
            containEffectRef = newContainEffect;

            // Add the contain effect to our effects list for cleanup
            effects.push(newContainEffect);
            return;
        }

        // Clean up contain if we're switching to a different value type
        cleanupContain();

        // memoEach() is the each() fragment its slot-level cache says it is
        if (kind === 'memoEach') {
            value = memoEachToFragment(value, memoState, component);
        }

        // Handle html() template result (or the each() fragment memoEach became).
        // Require the HTML_MARKER symbol - a bare `value?._compiled?.fromEach`
        // check would let untrusted data forge a compiled tree.
        if (kind === 'html' || kind === 'memoEach') {
            // An each() fragment with keyed children: one record per item, so
            // the next update can reconcile by key
            if (value._compiled.fromEach && value._compiled.children?.length > 0) {
                const keyed = materializeKeyed(value, placeholder, component, slotInSvg);
                currentItemMap = keyed.itemMap;
                currentNodes = keyed.nodes;
                currentEffects = keyed.effects;
                return;
            }

            // Regular html() template (non-each), rendered through a reactive
            // values container so the same structure updates in place next time
            const m = materialize(value, 'html', component, slotInSvg, true);
            currentValuesRef = m.valuesRef;
            currentEffects = m.effects;
            // Pause tracking during DOM insertion to isolate child component effects
            insertWithoutParentTracking(placeholder, m.insert);
            currentNodes = m.nodes;
            return;
        }

        // Arrays (props.children, named slots): each item after the last
        if (kind === 'array') {
            const { nodes, effects: arrayEffects } =
                materializeArray(value, placeholder, component, slotInSvg, false);
            currentNodes = nodes;
            currentEffects = arrayEffects;
            return;
        }

        // raw, deferred, node, text
        const m = materialize(value, kind, component, slotInSvg);
        insertWithoutParentTracking(placeholder, m.insert);
        currentNodes = m.nodes;
        currentEffects = m.effects;
    }, { label: `slot:${node.index}` });

    // Wrap the effect to clean up DOM when disposed
    // This is critical: when a parent slot disposes child effects,
    // we must also clean up the DOM nodes those child effects created
    const originalDispose = effect.dispose;
    effect.dispose = () => {
        // Clean up DOM nodes created by this slot
        for (const node of currentNodes) {
            node.remove();
        }
        // Dispose nested effects (which will recursively clean their DOM)
        for (const childEffect of currentEffects) {
            if (childEffect.dispose) childEffect.dispose();
        }
        // A contain() boundary's DOM is not in currentNodes once it has
        // re-rendered - it is the boundary's own to remove
        cleanupContain();
        // Also remove the placeholder comment
        placeholder.remove();
        // Clear references
        currentNodes = [];
        currentEffects = [];
        currentItemMap = null;
        // Call original dispose to clear reactive tracking
        originalDispose();
    };

    effects.push(effect);
}

/**
 * Instantiate an element
 * @param {boolean} [inheritedSvg=false] - Whether we're inside an SVG context (passed from parent)
 */
function instantiateElement(node, values, component, parent, effects, inheritedSvg = false) {
    const tag = node.tag;
    // Check if we're creating an SVG element or are inside SVG context
    // Use inheritedSvg when parent is a DocumentFragment (no namespaceURI)
    const inSvg = tag === 'svg' || inheritedSvg || (parent && parent.namespaceURI === SVG_NS);
    const el = inSvg
        ? document.createElementNS(SVG_NS, SVG_TAG_CASE.get(tag) || tag)
        : vdxCreateElement(tag);
    // Registry membership is resolved HERE rather than at compile time:
    // The one registry read left in the render path besides dispatch, and it
    // decides only HOW children reach the element: a registered component
    // takes deferred descriptors and instantiates them where its template
    // puts them; anything else - a class not imported yet, a third-party
    // custom element - gets live light DOM. On upgrade a component adopts that
    // light DOM as the same nodes (connectedCallback), so the two deliveries
    // converge; tests/attr-matrix/relations.js "children" holds them to it.
    // Keyed on the registry rather than tag shape because a third-party
    // element needs its light DOM, and a descriptor expando would shadow the
    // accessor a later VDX registration installs.
    const isCustomElement = !inSvg && componentDefinitions.has(tag);
    // Spec-based rather than registry-based: an unregistered hyphenated tag still
    // takes component attribute semantics. Both are namespace-guarded - an
    // autonomous custom element is HTML-namespace by definition, so a hyphenated
    // name inside <svg> is just an SVG element.
    const isCustomTag = !inSvg && (node.isCustomTag ?? tag.includes('-'));

    // Apply static props - always apply directly since this is initial instantiation
    // (Deferring would cause FOUC as element appears without attributes)
    if (node.staticProps) {
        for (const [name, value] of Object.entries(node.staticProps)) {
            if (isCustomTag) {
                // A literal on a component is a prop delivery, which only the
                // sink can make; it takes HTML semantics first (literalAttrValue)
                applyAttributeDirect(el, name, literalAttrValue(name, value, true), true);
            } else {
                // The one literal writer, shared with the compiler's static path
                writeLiteralAttr(el, name, value, inSvg);
            }
        }
    }

    // Apply dynamic props (create effects)
    for (const { name, def } of node.dynamicProps || []) {
        // Handle ref separately
        if (def.refName !== undefined) {
            if (component && component.refs) {
                component.refs[def.refName] = el;
                effects.push({
                    dispose() {
                        if (component.refs[def.refName] === el) {
                            delete component.refs[def.refName];
                        }
                    }
                });
            }
            continue;
        }

        // Create effect for dynamic prop
        // First run applies directly (no deferring) to avoid FOUC
        // Subsequent runs defer to batch DOM updates
        let isFirstRun = true;
        const effect = createEffect(() => {
            const value = resolveDynamicProp(name, def, values, component);
            if (isFirstRun) {
                isFirstRun = false;
                applyAttributeDirect(el, name, value, isCustomTag);
            } else {
                applyAttribute(el, name, value, isCustomTag);
            }
        }, { label: `prop:${name}@${node.tag || 'el'}` });
        effects.push(effect);
    }

    // Apply events
    for (const { name, def } of node.events || []) {
        const handler = resolveEventHandler(name, def, values, component);
        if (handler) {
            // Handle special events
            if (name === 'clickoutside' || name === 'click-outside') {
                setupClickOutside(el, handler, false, effects);
            } else if (name === 'clickoutside-stop' || name === 'click-outside-stop') {
                setupClickOutside(el, handler, true, effects);
            } else {
                // -passive registers a passive listener so touch/wheel handlers
                // don't block scrolling. Incompatible with -prevent (the browser
                // ignores preventDefault in passive listeners).
                const modifiers = def.modifiers || (def.modifier ? [def.modifier] : []);
                let listenerOptions;
                if (modifiers.includes('passive')) {
                    if (modifiers.includes('prevent')) {
                        console.warn(`[Events] on-${name}: -passive conflicts with -prevent; ignoring -passive`);
                    } else {
                        listenerOptions = { passive: true };
                    }
                }
                el.addEventListener(name, handler, listenerOptions);
                effects.push({
                    dispose() {
                        el.removeEventListener(name, handler, listenerOptions);
                    }
                });
            }
        }
    }

    // Handle children
    if (isCustomElement && node.children && node.children.length > 0) {
        // For custom elements, create deferred child descriptors
        const deferredChildren = [];
        const namedSlots = {};

        for (const child of node.children) {
            const childValues = child._itemValues !== undefined ? child._itemValues : values;
            const slotName = getSlotName(child);

            const deferred = createDeferredChild(
                child,
                childValues,
                component  // Parent component for context
            );

            if (slotName) {
                deferred.slotName = slotName;
                if (!namedSlots[slotName]) {
                    namedSlots[slotName] = [];
                }
                namedSlots[slotName].push(deferred);
            } else {
                deferredChildren.push(deferred);
            }
        }

        // Set on element for custom element to pick up
        el._vdxChildren = deferredChildren;
        el._vdxSlots = Object.keys(namedSlots).length > 0 ? namedSlots : {};
    } else {
        // Regular element - instantiate children directly
        // Pass SVG context so children know to use SVG namespace
        for (const child of node.children || []) {
            const childValues = child._itemValues !== undefined ? child._itemValues : values;
            instantiateNode(child, childValues, component, el, effects, inSvg);
        }
    }

    // Detach from the parent effect context during mount so a child
    // component's state does not become a dependency of the parent's effect.
    // Tag shape: an element whose class registers later upgrades with the
    // same connectedCallback, and there is nothing to track for a tag that
    // never does.
    if (isCustomTag) {
        withoutTracking(() => {
            parent.appendChild(el);
        });
    } else {
        parent.appendChild(el);
    }
}

/**
 * Instantiate a fragment
 * @param {boolean} [inSvg=false] - Whether we're inside an SVG context
 */
function instantiateFragment(node, values, component, parent, effects, inSvg = false) {
    for (const child of node.children || []) {
        const childValues = child._itemValues !== undefined ? child._itemValues : values;
        instantiateNode(child, childValues, component, parent, effects, inSvg);
    }
}

/**
 * Apply an attribute/property to an element directly (no queueing).
 * Called during initial render or when committing deferred updates.
 */
/** The prop name a template's attribute spelling refers to. */
function propNameFor(name) {
    return name.includes('-') ? kebabToCamel(name) : name;
}

/**
 * A value that has no faithful text form. String()-ing one writes
 * "[object Object]" or a whole function body into the DOM, and anything reading
 * the attribute back - a component's own prop among them - is handed that text.
 */
function isNonRenderable(value) {
    return typeof value === 'object' || typeof value === 'function' ||
        typeof value === 'symbol';
}

function applyAttributeDirect(el, name, value, isCustomTag) {
    // HTML boolean-attribute semantics apply to native HTML elements only. SVG
    // has no boolean attributes - `disabled` on a <g> is an ordinary attribute -
    // which is why the compiler's static path carries `&& !isSvgElement`. Read
    // it off the element so both sinks agree without threading another flag.
    const notHtmlElement = isCustomTag || el.namespaceURI === SVG_NS;
    const lname = typeof name === 'string' ? name.toLowerCase() : name;

    // Phase 1 - refuse, then normalise. SECURITY, at the actual DOM sink so it
    // covers the immediate and the deferred-commit path alike.
    //
    // isRefusedAttr() is shared with the compiler's static path so literal
    // text gets the same answer. Keyed on the TAG SHAPE, not on registry
    // membership: keying it on the registry silently dropped every `on*` prop
    // handed to a component whose class had not loaded. A string assigned to
    // a real handler property (el.onclick) is nulled by WebIDL rather than
    // compiled, and an unknown `on*` name is not an event handler content
    // attribute - both pinned in component-attr-contract.test.js "a script
    // sink on a hyphenated tag".
    if (isRefusedAttr(lname, isCustomTag)) {
        if (typeof console !== 'undefined') console.warn(refusedAttrMessage(name));
        return;
    }
    value = sanitizeUrlAttr(el, lname, value);

    // Phase 2 - host-applied. A name whose meaning belongs to the element
    // itself, component or not: `hidden` hides the host, `contenteditable`
    // edits it, `class` and `style` dress it. Consulted ONCE, from a table
    // (host-attrs.js), so no rung below can pre-empt it and "no rung claimed
    // it" cannot happen silently. Each rule handles nullish itself.
    //
    // On a component the value ALSO takes the ownership path a declared prop
    // takes - the owner with its type intact, or the side channel for the
    // upgrade to read - because cl-code-editor declares `spellcheck` to
    // forward it, and a lazily registered class must see the same value an
    // eager one does. A VDX owner's own mirror applies this same rule, so the
    // host write here is idempotent for it; it is still made, in a finally,
    // for an owner whose setter throws (a third-party accessor) and for the
    // unowned case, and under _suppressAttributeChange because a write to an
    // observed attribute would re-derive the prop from its string form.
    const host = hostAppliedRule(el, name);
    if (host) {
        if (isCustomTag) {
            el._suppressAttributeChange = true;
            try {
                deliverToOwner(el, propNameFor(name), value);
            } finally {
                try {
                    host(el, name, value);
                } finally {
                    el._suppressAttributeChange = false;
                }
            }
            return;
        }
        host(el, name, value);
        return;
    }

    // Phase 3 - ownership. Who owns the name decides what the value becomes.
    if (isCustomTag) {
        applyComponentAttr(el, name, value);
    } else {
        applyNativeAttr(el, name, value, notHtmlElement);
    }
}

/* --------------------------------------------------------------- ownership */

/**
 * Everything a component is handed, under ONE rule: the prop is the contract
 * and carries the ${} value with its type intact; the attribute is a devtools
 * mirror, and a mirror can only hold strings. The attribute keeps its kebab
 * spelling; only the prop is renamed (propNameFor).
 *
 * A declared prop on a VDX component, or a web component's own accessor,
 * takes the value directly - component.js's setter maintains the mirror
 * under _suppressAttributeChange, so no attributeChangedCallback fires and
 * propsChanged fires once. This must never reach the inherited `name in el`
 * branch: half of HTMLElement's surface - id, title, lang, dir, slot -
 * collides with ordinary prop names, and routing a prop through the
 * inherited DOM property silently coerces it (the string 'false' became
 * true, null became "null").
 *
 * Nothing owns the name yet - most often a component whose class has not
 * been imported - so the real value goes to the side channel for the
 * upgrade to pick up with its type intact (pending-props.js). An inherited
 * DOM attribute still means what it means on any element - `tabindex="${0}"`
 * must stay focusable - and an unknown name mirrors a primitive so devtools
 * shows something readable. An object or a function does neither: every
 * inherited name is string- or number-typed, so assigning one only
 * stringifies it, and a stale mirror is CLEARED rather than left showing the
 * previous render.
 */
/**
 * The value reaches whoever owns the name: a class's own accessor (a VDX
 * prop, or a third-party element's) takes it with its type intact; otherwise
 * it is recorded for the upgrade to read (pending-props.js), where undefined
 * records nothing - it means "not provided", which is the prop default.
 * Returns whether an owner took it.
 */
function deliverToOwner(el, propName, value) {
    if (isOwnElementProp(el, propName)) {
        el[propName] = value;
        return true;
    }
    recordPendingProp(el, propName, value);
    return false;
}

function applyComponentAttr(el, name, value) {
    const propName = propNameFor(name);

    if (nullish(value)) {
        // Attribute removed FIRST, owner notified second: the owner's own
        // mirror then has the last word. false/null on the attribute is
        // indistinguishable from never setting it, so the real value goes to
        // the owner, or to the side channel.
        el.removeAttribute(name);
        deliverToOwner(el, propName, value);
        return;
    }

    if (deliverToOwner(el, propName, value)) return;

    if (name in el) {
        if (isNonRenderable(value)) {
            el.removeAttribute(name);
            return;
        }
        el[name] = value;
        return;
    }

    if (typeof value === 'string') {
        el.setAttribute(name, value);
    } else if (isNonRenderable(value)) {
        el.removeAttribute(name);
    } else {
        el.setAttribute(name, String(value));
    }
}

/** A native element: HTML semantics, property where the DOM has one. */
function applyNativeAttr(el, name, value, notHtmlElement) {
    if (nullish(value)) {
        el.removeAttribute(name);
        if (isBooleanAttr(name, notHtmlElement) && name in el) {
            el[name] = false;
        }
        // A form control's live value does not track its value attribute, so
        // removing the attribute leaves the old text on screen and reachable
        // through el.value. Nullish means empty for HTML.
        //
        // Only clear a value this binding actually set. Every dynamic prop
        // effect re-runs on each render, so an uncontrolled input - or an
        // x-model on a state key that is still unset, which resolves undefined
        // too - would otherwise have whatever the user typed wiped the next
        // time any unrelated state changed.
        if (name === 'value' && appliedFormValues.get(el)) {
            if (el.value !== '') el.value = '';
            appliedFormValues.delete(el);
        }
        return;
    }

    if (name === 'value' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
        // Only update if different (preserve cursor position)
        if (el.value !== String(value)) {
            el.value = value;
        }
        appliedFormValues.set(el, true);
    } else if (name === 'checked' && !notHtmlElement) {
        el.checked = !!value;
    } else if (isBooleanAttr(name, notHtmlElement)) {
        writeBooleanAttr(el, name, !!value);
    } else if (name in el && !name.includes('-')) {
        // Set as property if it exists
        try {
            el[name] = isNonRenderable(value) ? '' : value;
        } catch {
            if (!isNonRenderable(value)) el.setAttribute(name, String(value));
        }
    } else if (isNonRenderable(value)) {
        el.removeAttribute(name);
    } else {
        el.setAttribute(name, value === true ? '' : String(value));
    }
}

/**
 * What a ${} in attribute position stands for: a value getter is read, a
 * when() is the branch it selects (an empty one is nothing), a contain() is
 * its render function's result - each of which may hand back another.
 */
function unwrapAttrValue(v) {
    // Only call if marked as a value getter (not an actual function value)
    if (typeof v === 'function' && v[VALUE_GETTER]) v = v();
    for (;;) {
        v = resolveWhen(v);
        if (v === EMPTY_WHEN_RESULT) return null;
        if (v && isContain(v) && v._renderFn) {
            v = v._renderFn();
            continue;
        }
        return v;
    }
}

/**
 * Resolve a dynamic prop value
 */
function resolveDynamicProp(name, def, values, component) {
    // x-model binding - read from component state
    if (def.xModel !== undefined) {
        if (component && component.state) {
            const value = getNestedValue(component.state, def.xModel);

            if (def.context === 'x-model-checked') {
                return !!value;
            } else if (def.context === 'x-model-radio') {
                return value === def.radioValue;
            }
            return value;
        }
        return (def.context === 'x-model-checked' || def.context === 'x-model-radio') ? false : '';
    }

    // Slot-based value
    if (def.slot !== undefined || def.slots !== undefined) {
        let value;

        if (def.slots) {
            // Multiple slots: interpolate the template in a SINGLE pass over
            // the original string. Sequential value.replace() calls corrupted
            // values containing '$' replacement patterns ($', $&...) and let a
            // value containing a literal marker steal a later slot's
            // substitution; the callback form with one scan has neither hole.
            value = def.template.replace(/\x00(\d+)\x00/g, (token, idx) =>
                String(unwrapAttrValue(values[Number(idx)]) ?? ''));
        } else {
            value = unwrapAttrValue(values[def.slot]);
            if (def.template) {
                // Callback form: a value containing '$' replacement patterns
                // must land verbatim
                const marker = `\x00${def.slot}\x00`;
                value = def.template.replace(marker, () => String(value ?? ''));
            }
        }

        // Context-specific handling
        if (def.context === 'url') {
            return sanitizeUrl(value) || '';
        }

        return value;
    }

    return def.value;
}

/**
 * Is this element a registered VDX component *right now*?
 *
 * Registry membership can change after a handler is bound: a lazy import() that
 * calls defineComponent() later upgrades an element that rendered as an unknown
 * tag. Anything that must match the element's real nature is therefore decided
 * at dispatch, never captured at bind time.
 */
function isComponentElement(el) {
    return !!el && el.namespaceURI !== SVG_NS &&
        componentDefinitions.has(el.localName);
}

/**
 * Resolve the value passed as the 2nd argument to an on-* handler. Custom
 * elements carry it in event.detail.value; native controls derive it from the
 * target by input type (mirrors the x-model native branches).
 */
function resolveEventValue(e, isCustomElement) {
    if (isCustomElement) {
        return (e.detail && e.detail.value !== undefined) ? e.detail.value : e.detail;
    }
    const t = e.target;
    if (!t) return undefined;
    if (t.type === 'checkbox') return t.checked;
    if (t.type === 'radio') return t.checked ? t.value : undefined;
    if (t.type === 'number' || t.type === 'range') {
        const n = t.valueAsNumber;
        return Number.isNaN(n) ? t.value : n;
    }
    if (t.type === 'file') return t.files;
    return t.value;
}

/**
 * Resolve an event handler
 */
function resolveEventHandler(eventName, def, values, component) {
    let handler = null;

    if (def.xModel !== undefined) {
        // x-model binding: create state update handler
        const propName = def.xModel;
        handler = (e) => {
            if (component && component.state) {
                let value;

                if (def.customElement) {
                    // Only honor the component's OWN change event, dispatched on
                    // the host element (target === the element carrying x-model).
                    // Native change/input events that bubble up from an inner
                    // <input> have a descendant target and no detail; letting them
                    // through would clobber the bound state to undefined. A custom
                    // element must emitChange() to drive x-model.
                    if (e.target !== e.currentTarget) return;
                    value = (e.detail && e.detail.value !== undefined) ? e.detail.value : e.detail;
                } else {
                    // Same per-input-type derivation as on-* handlers. An
                    // unchecked radio resolves to undefined - not a commit.
                    if (e.target && e.target.type === 'radio' && !e.target.checked) return;
                    value = resolveEventValue(e, false);
                }

                setNestedValue(component.state, propName, value);
            }
        };
    } else if (def.slot !== undefined) {
        handler = values[def.slot];
        // Handle VALUE_GETTER wrapper (fine-grained mode)
        // Create a wrapper that calls the getter fresh each time to get current closure
        if (typeof handler === 'function' && handler[VALUE_GETTER]) {
            const getter = handler;
            // Args-transparent: the resolved-value 2nd argument (and anything
            // else) must reach the actual handler - this wrapper silently
            // dropped it, so (e, value) worked at top level but not inside
            // nested templates or each() rows.
            handler = (e, ...rest) => {
                const actualHandler = getter();
                if (typeof actualHandler === 'function') {
                    return actualHandler(e, ...rest);
                }
            };
        }
        // Handle string method references
        if (typeof handler === 'string' && component && component[handler]) {
            handler = component[handler].bind(component);
        }
    } else if (def.handler && typeof def.handler === 'function') {
        handler = def.handler;
    } else if (def.method && component && component[def.method]) {
        handler = component[def.method].bind(component);
    }

    if (handler && typeof handler === 'function') {
        // Apply modifiers (def.modifier is the legacy single-modifier form)
        const modifiers = def.modifiers || (def.modifier ? [def.modifier] : []);
        // Modifier wrappers are args-transparent so the resolved-value 2nd
        // argument survives -prevent/-stop
        if (modifiers.includes('prevent')) {
            const orig = handler;
            handler = (e, ...rest) => { e.preventDefault(); return orig(e, ...rest); };
        }
        if (modifiers.includes('stop')) {
            const orig = handler;
            handler = (e, ...rest) => { e.stopPropagation(); return orig(e, ...rest); };
        }

        // Chain with existing handler if needed (e.g., x-model + on-change).
        // Thread the resolved value to both so a chained on-change still gets
        // (e, value) and not just (e).
        if (def._chainWith) {
            const firstHandler = resolveEventHandler(eventName, def._chainWith, values, component);
            if (firstHandler) {
                const secondHandler = handler;
                handler = (e, value) => { firstHandler(e, value); secondHandler(e, value); };
            }
        }

        // Every on-* handler receives the resolved value as its 2nd argument
        // (uniform across native + custom elements). On a custom element, a
        // native input/change bubbling from an inner control is NOT the
        // component's own change - ignore it so it can't drive a parent handler
        // or x-model. Opt back into forwarding with the `-delegate` modifier.
        if (!def.xModel) {
            const orig = handler;
            const delegate = modifiers.includes('delegate');
            const isFormEvent = eventName === 'input' || eventName === 'change';
            handler = (e) => {
                // Resolved per dispatch, not per bind: the element may have been
                // upgraded by a defineComponent() that ran after this handler was
                // attached, and a stale "native" answer hands the handler
                // e.target.value (undefined) instead of e.detail.value.
                const isComponent = isComponentElement(e.currentTarget);
                if (isComponent && !delegate && isFormEvent
                    && e.target !== e.currentTarget && !(e instanceof CustomEvent)) {
                    return;
                }
                return orig(e, resolveEventValue(e, isComponent));
            };
        }
    }

    return handler;
}

/**
 * Setup click-outside handling
 */
function setupClickOutside(el, handler, stopPropagation, effects) {
    const documentHandler = (e) => {
        if (el.isConnected && !el.contains(e.target)) {
            if (stopPropagation) {
                e.stopPropagation();
            }
            handler(e);
        }
    };

    // Delay to avoid triggering on the opening click
    const timerId = requestAnimationFrame(() => {
        if (el.isConnected) {
            document.addEventListener('click', documentHandler, true);
        }
    });

    effects.push({
        dispose() {
            cancelAnimationFrame(timerId);
            document.removeEventListener('click', documentHandler, true);
        }
    });
}

/**
 * Get slot name from a child node
 */
function getSlotName(node) {
    if (!node.staticProps) return null;
    return node.staticProps.slot || null;
}

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj, path) {
    if (!path || !obj) return undefined;
    if (hasDangerousKey(path)) return undefined;

    if (!path.includes('.')) return obj[path];

    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current == null) return undefined;
        current = current[part];
    }
    return current;
}

/**
 * Set nested value in object using dot notation
 */
function setNestedValue(obj, path, value) {
    if (!path || !obj) return;
    if (hasDangerousKey(path)) {
        console.warn(`[VDX Security] Blocked attempt to set dangerous property path: ${path}`);
        return;
    }

    if (!path.includes('.')) {
        obj[path] = value;
        return;
    }

    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] == null) {
            current[parts[i]] = {};
        }
        current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
}

/**
 * Check for dangerous prototype pollution keys
 */
function hasDangerousKey(path) {
    if (!path) return false;
    const parts = path.includes('.') ? path.split('.') : [path];
    return parts.some(part => DANGEROUS_KEYS.has(part));
}

// Register DOM update hooks with reactivity system
// This enables batched DOM updates: effects queue changes, commit applies them all at once
registerEffectFlushHooks(beginDeferredUpdates, commitDeferredUpdates);

// Let nextRender() force a synchronous DOM commit so the DOM is current the
// moment its promise resolves (rather than waiting for the batched rAF).
registerNextRenderFlush(flushDOMUpdates);
