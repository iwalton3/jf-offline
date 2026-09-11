/**
 * Literal attribute text on a native element, written as the HTML parser
 * would read it. ONE writer for the two places a literal can be built: the
 * compiler's static-DOM path (a fully static subtree) and the renderer's
 * element instantiation (a subtree with a ${} somewhere in it). They used to
 * be two, and disagreed - `<input value="x">` set only the live property on
 * one path and the attribute (the form's default) on the other, and a
 * literal `hidden="false"` inside <svg> kept its text on one and became ""
 * on the other - so which one an author got depended on an unrelated
 * interpolation elsewhere in the template.
 *
 * Custom tags do not come here: their literal is a prop delivery, which only
 * the renderer's sink can make (the attribute text it leaves behind is the
 * same either way, and the upgrade reads it).
 */

import { isBooleanAttr, isRefusedAttr, refusedAttrMessage, SVG_NS } from './constants.js';
import { sanitizeUrl } from './template.js';

// SECURITY: secondary URL-bearing attributes that actually execute script,
// each mapped to the native tags where the browser treats it as a navigable
// URL. href/src/action are sanitized at parse-time ('url' context) for every
// element; this is the defense-in-depth backstop for the attributes that path
// misses. Scoping by tag avoids mangling same-named properties elsewhere - most
// importantly `data`, an ordinary property name on countless custom elements
// but a `data:text/html` script sink ONLY on <object>/<embed>.
const URL_ATTR_TAGS = {
    formaction: new Set(['BUTTON', 'INPUT']),   // form submit target -> javascript:
    data: new Set(['OBJECT', 'EMBED'])          // subdocument source -> data:text/html
};

/**
 * Scheme-check the secondary URL attributes, but only on the elements where
 * the browser navigates them, and xlink:href on SVG links. Stringify FIRST: a
 * non-string value (e.g. ['javascript:...'] from JSON, which stringifies to
 * its element, or an object with a crafted toString) would otherwise skip the
 * check and land the raw URL.
 */
export function sanitizeUrlAttr(el, lname, value) {
    if (typeof lname !== 'string' || value == null || typeof value === 'boolean') return value;
    const urlTags = URL_ATTR_TAGS[lname];
    const isSvgLink = lname === 'xlink:href' && el.namespaceURI === SVG_NS;
    if ((urlTags && urlTags.has(el.tagName)) || isSvgLink) {
        return sanitizeUrl(String(value)) || '';
    }
    return value;
}

/**
 * @param el     a native element (never a custom tag)
 * @param name   the attribute as written
 * @param value  the literal source text; `true` for a valueless attribute
 * @param isSvg  the element is in the SVG namespace, where nothing is a
 *               boolean attribute - `disabled` on a <g> is ordinary text
 */
export function writeLiteralAttr(el, name, value, isSvg) {
    if (isRefusedAttr(name, false)) {
        if (typeof console !== 'undefined') console.warn(refusedAttrMessage(name));
        return;
    }
    value = sanitizeUrlAttr(el, name.toLowerCase(), value);

    if (name === 'class') {
        el.setAttribute('class', value);   // not el.className: readonly on SVG
    } else if (name === 'for' && !isSvg) {
        el.htmlFor = value;
    } else if (!isSvg && isBooleanAttr(name, false)) {
        // HTML rules: presence is what counts, and disabled="false" is
        // disabled. The property write keeps the live state in step for the
        // attributes the parser would have set it from.
        el[name] = true;
        el.setAttribute(name, '');
    } else if (value != null && value !== false) {
        // A valueless attribute arrives as '' from the parser, never as true
        el.setAttribute(name, String(value));
    }
}
