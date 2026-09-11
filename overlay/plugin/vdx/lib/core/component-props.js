/**
 * How a declared prop's value gets INTO a component - the prototype setter,
 * setProps, attributeChangedCallback, the pre-construction pending values and
 * the attribute parse at connect all come through here. The rules, once, as
 * a per-definition spec:
 *
 *   resolveIncoming  what `undefined` means (not provided -> the default)
 *   mirrorAttribute  how a value shows up as an attribute (strings only)
 *   commitProp       the ONE write to props, mirrored, reporting the change
 *   notifyProps      propsChanged per change and ONE version bump per batch
 *   parseAttributes  the first-connect read: pending template values, direct
 *                    properties, attributes, json-*, then defaults
 *
 * A spec is closed over the definition's `options` so the callers stay one
 * line each. No DOM reads beyond the element itself, no rendering.
 */

import { kebabToCamel } from './constants.js';
import { takePendingProps } from './pending-props.js';
import { scheduleRender } from './component-render.js';
import { hostAppliedRule } from './host-attrs.js';

/** Property names no prop may shadow. */
export const RESERVED_PROP_NAMES = new Set([
    'constructor', '__proto__', 'prototype', 'toString',
    'valueOf', 'hasOwnProperty', 'isPrototypeOf'
]);

const toKebabCase = (str) => str.replace(/[A-Z]/g, c => '-' + c.toLowerCase());

export function createPropSpec(options) {
    // Attribute name mapping: camelCase props are exposed as kebab-case
    // attributes (fromUnit <-> from-unit). HTML lowercases attribute names,
    // so a camelCase prop name can never match a literal attribute; the
    // legacy smushed-lowercase form (fromunit) is also accepted for reading.
    const propAttrNames = new Map();  // propName -> canonical (kebab) attribute name
    const attrToProp = new Map();     // observed attribute name -> propName
    if (options.props) {
        for (const propName of Object.keys(options.props)) {
            const kebab = toKebabCase(propName);
            propAttrNames.set(propName, kebab);
            attrToProp.set(kebab, propName);
            const lower = propName.toLowerCase();
            if (!attrToProp.has(lower)) {
                attrToProp.set(lower, propName);
            }
        }
    }

    // `undefined` means "not provided", not "the value undefined". The first
    // render already resolves it to the declared default (parseAttributes), so
    // every later write must agree - otherwise the meaning of a prop depends on
    // whether a render is the first one, and `${maybeMissing}` silently blows
    // past the default the second time it evaluates. `null` stays an explicit
    // null.
    const resolveIncoming = (propName, value) =>
        value === undefined ? options.props[propName] : value;

    // The attribute is a MIRROR of a prop, for devtools and CSS: a string is
    // written through, anything else has no attribute form and clears a stale
    // one - including the text mirror the renderer writes while the element
    // is still unregistered (applyAttributeDirect's unowned-name path).
    //
    // A host-applied name (`hidden`, `spellcheck`, `class`...) has no mirror:
    // its attribute is the host's, and the one rule that writes it
    // (host-attrs.js) is applied here too, so `el.hidden = true` on a class
    // that declares `hidden` hides the element exactly as the template would.
    const mirrorAttribute = (el, propName, value) => {
        const attrName = propAttrNames.get(propName) || propName;
        el._suppressAttributeChange = true;
        const host = hostAppliedRule(el, attrName);
        if (host) {
            host(el, attrName, value);
        } else if (typeof value === 'string') {
            el.setAttribute(attrName, value);
        } else if (el.hasAttribute(attrName)) {
            el.removeAttribute(attrName);
        }
        // A stale legacy smushed-lowercase attribute (e.g. from static HTML
        // written before kebab-case support)
        if (attrName !== propName.toLowerCase() && el.hasAttribute(propName)) {
            el.removeAttribute(propName);
        }
        el._suppressAttributeChange = false;
    };

    /**
     * Write one prop. Returns `[propName, value, oldValue]` when the value
     * changed, null when it did not (identity for objects, by design: a deep
     * comparison is too expensive). A value that arrived FROM the attribute
     * is not mirrored back into it.
     */
    const commitProp = (el, propName, value, fromAttribute = false) => {
        const oldValue = el.props[propName];
        if (value === oldValue) return null;
        el.props[propName] = value;
        if (!fromAttribute) mirrorAttribute(el, propName, value);
        return [propName, value, oldValue];
    };

    /**
     * Tell the component. propsChanged once per change, in order, after every
     * backing value is current - then ONE version bump for the batch, so a
     * handler reading a sibling prop sees the batch, not the old value.
     * Only for a live component: a detached one reads props fresh at connect.
     */
    const notifyProps = (el, changes) => {
        if (changes.length === 0 || !el._isMounted) return;
        if (typeof el.propsChanged === 'function') {
            for (const [propName, value, oldValue] of changes) {
                el.propsChanged(propName, value, oldValue);
            }
        }
        if (el._propsVersion) {
            el._propsVersion.v++;
            // Error fallbacks have no reactive effects watching _propsVersion
            if (el._hasRenderError) {
                scheduleRender(el);
            }
        }
    };

    const isDeclared = (propName) => Boolean(options.props) &&
        Object.prototype.hasOwnProperty.call(options.props, propName) &&
        !RESERVED_PROP_NAMES.has(propName) &&
        propName !== 'style' && propName !== 'children' && propName !== 'slots';

    return {
        propAttrNames, attrToProp, resolveIncoming, mirrorAttribute,
        commitProp, notifyProps, isDeclared,
        observedAttributes: [...attrToProp.keys()]
    };
}

/**
 * The first-connect read of every declared prop, in precedence order.
 *
 * Values a template handed this element before its class was registered come
 * first: they are the only source that still has the ${} value's TYPE - the
 * attribute and the inherited DOM property have both already coerced it to a
 * string (see pending-props.js). Then a property set directly on the element
 * before connect, then the attribute (kebab form, then the legacy lowercase
 * form), then the declared default.
 */
export function parseAttributes(el, options, spec) {
    const pending = takePendingProps(el);

    if (options.props) {
        for (const propName of Object.keys(options.props)) {
            if (propName === 'style') {
                // no-op: style is handled separately as _vdxStyle
                continue;
            }

            if (pending && pending.has(propName)) {
                // Recorded under the prop's own name: the renderer resolves the
                // kebab attribute form before it decides ownership, so both
                // sides agree on what the class owns. Mirrored like any other
                // delivery, so tabindex="${0}" on a class that OWNS tabindex
                // ends up as it would have had the class been registered at
                // render. Silent: the first render reads props fresh.
                spec.commitProp(el, propName, pending.get(propName));
                continue;
            }

            // A value committed before this connect - a template's eager
            // delivery, or el[propName] = value before insertion - wins over
            // the attribute, even when it equals the declared default: the
            // attribute may be the host rule's own writing (spellcheck="false"
            // for a boolean false), which is not the value.
            if (Object.prototype.hasOwnProperty.call(el.props, propName)) {
                continue;
            }

            // Check if property was set directly on element (before connectedCallback)
            // This happens when el[propName] = value is set before adding to DOM
            if (propName in el && el[propName] !== undefined && el[propName] !== options.props[propName]) {
                el.props[propName] = el[propName];
                continue;
            }

            // Check for attribute: kebab-case form first, then the legacy
            // smushed-lowercase form (getAttribute lowercases propName, so
            // 'fromUnit' reads the 'fromunit' attribute)
            let attrValue = el.getAttribute(spec.propAttrNames.get(propName));
            if (attrValue === null) {
                attrValue = el.getAttribute(propName);
            }
            if (attrValue !== null) {
                el.props[propName] = attrValue;
            } else if (!(propName in el.props)) {
                // Use default from props definition if not already set
                el.props[propName] = options.props[propName];
            }
        }
    }

    // Process json-* attributes for hydration from <script type="application/json"> elements
    // Example: <my-component json-items="items-data"></my-component>
    //          <script type="application/json" id="items-data">[...]</script>
    const jsonAttrsToRemove = [];
    for (const attr of el.attributes) {
        if (attr.name.startsWith('json-')) {
            // Extract prop name by removing 'json-' prefix and converting to camelCase
            const propName = kebabToCamel(attr.name.slice(5));
            const scriptId = attr.value;
            const scriptEl = document.getElementById(scriptId);

            if (scriptEl && scriptEl.type === 'application/json') {
                try {
                    el.props[propName] = JSON.parse(scriptEl.textContent);
                } catch (e) {
                    console.warn(
                        `[${el.tagName}] Failed to parse JSON from #${scriptId} for prop "${propName}".\n` +
                        `  Error: ${e.message}\n` +
                        `  Tip: Ensure the JSON in <script id="${scriptId}"> is valid. ` +
                        `Use a JSON validator if needed.`
                    );
                    // Prop keeps its default value from props definition
                }
            } else if (!scriptEl) {
                try {
                    el.props[propName] = JSON.parse(scriptId);
                } catch (e) {
                    console.warn(
                        `[${el.tagName}] Could not find element #${scriptId} or parse as inline JSON for prop "${propName}".\n` +
                        `  Error: ${e.message}\n` +
                        `  Tip: Either add <script type="application/json" id="${scriptId}">...</script> ` +
                        `or provide valid inline JSON.`
                    );
                    // Prop keeps its default value from props definition
                }
            } else {
                console.warn(
                    `[${el.tagName}] json-${propName} references #${scriptId} which exists but is not type="application/json".\n` +
                    `  Current type: "${scriptEl.type || '(none)'}"\n` +
                    `  Tip: Add type="application/json" to the script tag.`
                );
                // Prop keeps its default value from props definition
            }

            jsonAttrsToRemove.push(attr.name);
        }
    }

    // Remove json-* attributes after processing (don't modify while iterating)
    for (const attrName of jsonAttrsToRemove) {
        el.removeAttribute(attrName);
    }
}
