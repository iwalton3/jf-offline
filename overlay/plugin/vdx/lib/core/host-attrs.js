/**
 * Host-applied attributes: names whose meaning belongs to the element itself,
 * component or not. `hidden` hides the host, `contenteditable` edits it,
 * `class` and `style` dress it, `aria-*` and `data-*` describe it.
 *
 * ONE table, consulted from two places and nowhere else: the renderer's sink
 * (phase 2 of applyAttributeDirect) and a component's prop mirror
 * (component-props.js), so that a class which DECLARES one of these names -
 * cl-code-editor's `spellcheck` - reaches the host the same way whether the
 * value arrives from a template, from `el.spellcheck = x`, from setProps, or
 * from the side channel at upgrade. Every rule handles nullish itself.
 */

import { BOOLEAN_ATTRS, GLOBAL_BOOLEAN_ATTRS, ENUMERATED_ATTRS, SVG_NS, nullish } from './constants.js';

export const DANGEROUS_CSS = /expression\s*\(|javascript\s*:|@import\b|behavior\s*:|-moz-binding\s*:/i;

/** Which keys the previous object-form style set on an element, or STRING_STYLE. */
const stylesByElement = new WeakMap();
const STRING_STYLE = Symbol('vdx:string-style');

/**
 * Is this property declared by the element's own class, rather than inherited
 * from HTMLElement and friends?
 *
 * This is the line between "the element wants this value" and "the DOM will
 * coerce it". A VDX component or a third-party custom element that declares
 * `data` or `items` should receive the real value; `id`, `title`, `spellcheck`,
 * `translate` and the rest of the inherited surface would silently convert it
 * to a string - which is how the string 'false' became true.
 */
export function isOwnElementProp(el, name) {
    if (Object.prototype.hasOwnProperty.call(el, name)) return true;
    let proto = Object.getPrototypeOf(el);
    // Stop at Element.prototype as well as HTMLElement.prototype: an SVG
    // element's chain is SVGElement -> Element -> Node and never passes through
    // HTMLElement, so a lone HTMLElement sentinel is never reached and the walk
    // runs to Object.prototype - reporting inherited `id` as the element's own.
    while (proto && proto !== HTMLElement.prototype && proto !== Element.prototype) {
        if (Object.prototype.hasOwnProperty.call(proto, name)) return true;
        proto = Object.getPrototypeOf(proto);
    }
    return false;
}

/** ARIA attributes require explicit "true"/"false" strings, don't remove on false */
function applyAriaAttr(el, name, value) {
    if (value == null) {
        el.removeAttribute(name);
    } else {
        el.setAttribute(name, String(value));
    }
}

/**
 * Enumerated attributes speak a two-word vocabulary, and removing one means
 * "inherit the default" rather than "off" - so ${false} must write the
 * off-word. Nullish still removes: the author is declining to specify, which
 * is exactly what inheriting means.
 *
 * A string is this attribute's own vocabulary and passes through untouched.
 * Routing it via the property setter is what turned "false" into true: the
 * IDL is a boolean, so any non-empty string coerces to on. '' is included
 * deliberately - a valueless attribute parses to '', and for contenteditable
 * that means ON - and it keeps this sink in step with the compiler's static
 * path, which writes the literal through untouched.
 */
function applyEnumeratedAttr(el, name, value) {
    const vocabulary = ENUMERATED_ATTRS[name.toLowerCase()];
    if (value == null) {
        el.removeAttribute(name);
    } else if (typeof value === 'string') {
        el.setAttribute(name, value);
    } else {
        el.setAttribute(name, value ? vocabulary.on : vocabulary.off);
    }
}

function applyClassAttr(el, name, value) {
    if (nullish(value)) {
        el.removeAttribute(name);
        return;
    }
    // Use setAttribute, not el.className: SVG elements have a readonly
    // className (SVGAnimatedString) and assignment throws in strict mode
    el.setAttribute('class', value);
}

function applyStyleAttr(el, name, value) {
    if (nullish(value)) {
        // Blink serialises a CSSOM-written inline style back into the
        // attribute lazily, and removing a not-yet-synchronised one leaves
        // style="" behind (an unrelated read in between makes it stick, which
        // is how this hid). Reading first forces the sync.
        el.getAttribute('style');
        el.removeAttribute('style');
        return;
    }
    if (typeof value === 'object') {
        // Clear the keys the previous object set but this one omits -
        // Object.assign alone leaves them applied, so dropping a key from
        // the style object would silently do nothing.
        const previous = stylesByElement.get(el);
        if (previous === STRING_STYLE) {
            // The last binding was a cssText string: its declarations are
            // not in any key list, so drop the lot rather than leak them.
            el.style.cssText = '';
        } else if (previous) {
            for (const key of previous) {
                if (!(key in value)) el.style[key] = '';
            }
        }
        stylesByElement.set(el, Object.keys(value));
        Object.assign(el.style, value);
    } else if (DANGEROUS_CSS.test(String(value))) {
        // Refuse the new value AND drop the old one. Skipping left the
        // previous render's style on screen, so the DOM showed a style the
        // template no longer says - the same staleness as a non-renderable
        // value, which is why that clears too.
        el.style.cssText = '';
        stylesByElement.set(el, STRING_STYLE);
        if (typeof console !== 'undefined') {
            console.warn(
                '[VDX Security] Refused a style value containing a dangerous CSS ' +
                'construct (expression()/javascript:/@import/behavior). Use object-form styles.'
            );
        }
    } else {
        el.style.cssText = value;
        stylesByElement.set(el, STRING_STYLE);
    }
}

/**
 * Host-applied, so the value is text by definition - but "never String() an
 * object or a function into the DOM" is a whole-contract rule, not a
 * component-branch one. Writing "[object Object]" here also handed a component
 * that text as its prop, replacing the declared default.
 */
function applyDataAttr(el, name, value) {
    if (nullish(value) || typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') {
        el.removeAttribute(name);
    } else {
        el.setAttribute(name, value === true ? '' : String(value));
    }
}

/**
 * Write a boolean attribute: presence, and the IDL property where the element
 * has one. `name in el`: SVGElement has no `hidden` IDL, and writing the
 * property there made a fake one. `setIdl` false where the property is a
 * class's own accessor - that is the prop, delivered with the real value
 * already, and `hidden=null` would arrive there as false.
 */
export function writeBooleanAttr(el, name, on, setIdl = true) {
    if (setIdl && name in el) el[name] = on;
    if (on) {
        el.setAttribute(name, '');
    } else {
        el.removeAttribute(name);
    }
}

/** A global boolean (`hidden`, `inert`, ...) is presence on the host, component or not, SVG included. */
function applyGlobalBooleanAttr(el, name, value) {
    writeBooleanAttr(el, name, !!value, !isOwnElementProp(el, name));
}

/**
 * The table. Returns the rule for a host-applied name, or null when the name
 * is the element's own to interpret. Enumerated names are HTML attributes and
 * not host-applied in SVG, where they are ordinary text; everything else here
 * applies in any namespace.
 */
export function hostAppliedRule(el, name) {
    const lname = name.toLowerCase();
    if (name.startsWith('aria-')) return applyAriaAttr;
    if (ENUMERATED_ATTRS[lname] && el.namespaceURI !== SVG_NS) return applyEnumeratedAttr;
    if (name === 'class' || name === 'className') return applyClassAttr;
    if (name === 'style') return applyStyleAttr;
    if (GLOBAL_BOOLEAN_ATTRS.has(name) && BOOLEAN_ATTRS.has(name)) return applyGlobalBooleanAttr;
    if (name.startsWith('data-')) return applyDataAttr;
    return null;
}
