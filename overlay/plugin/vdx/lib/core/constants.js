/**
 * Shared constants for the VDX framework core
 * @module core/constants
 */

// SECURITY: property names that could enable prototype-pollution if assigned
// from untrusted data. Shared by the template renderer (attribute/x-model
// paths) and the store system so there is one source of truth.
export const DANGEROUS_KEYS = new Set([
    '__proto__', 'prototype', 'constructor',
    '__defineGetter__', '__defineSetter__',
    '__lookupGetter__', '__lookupSetter__'
]);

// SVG element names are case-SENSITIVE, but the HTML parser lowercases all
// tag names (HTML semantics). Map the lowercased forms back to the correct
// camelCase names at createElementNS time - without this, <linearGradient>,
// <clipPath>, <feGaussianBlur> etc. silently become unknown SVG elements.
/** The SVG namespace. One declaration: the bundler concatenates modules, so a
 * second top-level `const SVG_NS` anywhere in lib/core breaks dist/. */
export const SVG_NS = 'http://www.w3.org/2000/svg';

/** null, undefined or false: the attribute-sink meaning of "not set". */
export const nullish = (value) => value == null || value === false;

export const SVG_TAG_CASE = new Map([
    'altGlyph', 'altGlyphDef', 'altGlyphItem', 'animateColor', 'animateMotion',
    'animateTransform', 'clipPath', 'feBlend', 'feColorMatrix',
    'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
    'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow',
    'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur',
    'feImage', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset',
    'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile',
    'feTurbulence', 'foreignObject', 'glyphRef', 'linearGradient',
    'radialGradient', 'textPath'
].map(name => [name.toLowerCase(), name]));

// Boolean attributes that should be set as properties (not string attributes)
export const BOOLEAN_ATTRS = new Set([
    'disabled', 'checked', 'selected', 'readonly', 'required',
    'multiple', 'autofocus', 'autoplay', 'controls', 'loop',
    'muted', 'open', 'reversed', 'hidden', 'async', 'defer',
    'ismap', 'declare', 'noresize', 'nowrap', 'noshade', 'compact',
    'default', 'scoped', 'seamless', 'sortable', 'novalidate',
    'formnovalidate', 'itemscope', 'inert',
    // Presence-only too, and their absence from this list sent them down the
    // plain-attribute path: allowfullscreen="${0}" WROTE the attribute, so an
    // iframe permitted fullscreen where the author said no.
    'allowfullscreen', 'nomodule', 'playsinline'
]);

/**
 * Whether `name` is a native HTML boolean attribute *on this element*.
 *
 * `notHtmlElement` covers both things that take the element out of HTML
 * attribute semantics: a hyphenated tag and the SVG namespace. It was called
 * `isCustomElement`, which no caller ever passed and which suggested a third
 * notion - registry membership - that this has nothing to do with.
 *
 * Both are excluded deliberately. `disabled` on a component is an ordinary
 * prop name that happens to collide with an HTML boolean attribute, not a
 * boolean attribute; coercing it hands the component `true` where the template
 * said `"false"`. SVG has no boolean attributes at all.
 */
/**
 * Boolean attributes the UA acts on for ANY element, custom tags included.
 * `hidden` is the one that bites: the UA stylesheet hides the element whatever
 * the value, so treating it as an ordinary prop makes `hidden="false"` vanish
 * the component. These stay native everywhere - see the reserved host
 * attributes in FRAMEWORK.md, alongside class, style, aria- and data- names.
 *
 * KEPT deliberately, and the early return below ignoring `notHtmlElement` is
 * the point of it. Deleting that was proposed and measured: it changes 4 cells,
 * all SVG `${''}`/`${0}`, and none on components - and none of the 4 renders
 * differently, because the UA's `[hidden]` rule is HTML-namespace-scoped. So
 * the whole benefit is tidiness inside SVG, where `hidden` is a meaningless
 * unknown attribute, and the cost is the documented guarantee above.
 * (tests/attr-matrix/README.md records how the 4 was measured.)
 */
export const GLOBAL_BOOLEAN_ATTRS = new Set(['hidden', 'itemscope', 'autofocus', 'inert']);

/**
 * Enumerated attributes: they carry their own two-word vocabulary rather than
 * HTML presence semantics.
 *
 * The distinction that matters is what ABSENCE means. Removing a boolean
 * attribute means off; removing an enumerated one means *inherit the default*,
 * which for spellcheck and translate is ON. So `spellcheck="${false}"` must
 * write the off-word, not remove the attribute.
 *
 * The words are not guessable from the name - translate spells off as "no",
 * not "false". This table is verified against the live DOM by
 * tests/framework/enumerated-attrs.test.js, so a browser that disagrees fails
 * loudly instead of silently inverting a value.
 */
export const ENUMERATED_ATTRS = {
    spellcheck: { on: 'true', off: 'false' },
    draggable: { on: 'true', off: 'false' },
    contenteditable: { on: 'true', off: 'false' },
    translate: { on: 'yes', off: 'no' }
};

/**
 * SECURITY: attribute names no template may set, literal or interpolated.
 *
 * HTML-parsing sinks are refused on every element - they inject markup even
 * on a custom element. Inline `on*` handlers are refused on native elements
 * only: VDX events are hyphenated `on-*`, and a component's own camelCase
 * props (`online`, `onColor`) are app API. ONE rule for both sinks - the
 * compiler's static-DOM path and the renderer - because a literal
 * onclick="fn()" is still an inline handler that runs outside the framework
 * and outside CSP.
 *
 * `isCustomTag` is the tag-shape notion (hyphenated, not in SVG), not
 * registry membership: a component whose class has not loaded is still a
 * component. Names are matched case-insensitively.
 */
const REFUSED_ATTR_NAMES = new Set(['innerhtml', 'outerhtml', 'srcdoc', 'insertadjacenthtml']);

export function isRefusedAttr(name, isCustomTag) {
    if (typeof name !== 'string') return false;
    const lname = name.toLowerCase();
    return REFUSED_ATTR_NAMES.has(lname) || (!isCustomTag && /^on[a-z]/.test(lname));
}

export function refusedAttrMessage(name) {
    return `[VDX Security] Refused to set "${name}" from a template - it can inject ` +
        'HTML or script. Use raw() for trusted HTML, or on-* for event handlers.';
}

export function isBooleanAttr(name, notHtmlElement) {
    if (GLOBAL_BOOLEAN_ATTRS.has(name)) return BOOLEAN_ATTRS.has(name);
    return !notHtmlElement && BOOLEAN_ATTRS.has(name);
}

/**
 * Normalize a *literal* template attribute value before it reaches a DOM sink.
 *
 * Literal text is HTML source, so a native boolean attribute follows HTML: its
 * presence is what counts and `disabled="false"` is still disabled. Everything
 * else passes through unchanged, which is what lets a component receive the
 * exact string the template author wrote.
 *
 * Interpolated ${} values follow JS semantics instead (`${false}` clears the
 * attribute) and must NOT be routed through here.
 */
export function literalAttrValue(name, value, notHtmlElement) {
    return isBooleanAttr(name, notHtmlElement) ? true : value;
}

/**
 * Normalize a boolean-ish prop value inside a component.
 *
 * The same prop reaches a component in either of two forms: literal template
 * text arrives as a string ("", "true", "false", or the attribute's own name),
 * while an interpolated ${} value keeps its JS type. This collapses both the
 * way an HTML author would expect - a bare `disabled` (empty string, or the
 * attribute name) is true, and only an explicit "false" or a falsy JS value
 * is false.
 *
 * Components must not hand-roll this: `props.x === true` silently fails for
 * every literal, and a bare truthiness test makes the string "false" true.
 */
/**
 * The inverse of defineComponent's toKebabCase.
 *
 * A template writes a camelCase prop as its kebab attribute form, so the
 * renderer and _parseAttributes both have to get back to the prop's own name.
 * They did it separately and disagreed: the renderer tested ownership against
 * the kebab spelling, decided the class did not own it, and routed the value
 * through the side channel - which only delivers on the render that
 * _parseAttributes drains.
 */
export function kebabToCamel(name) {
    return name.replace(/-([a-z])/g, m => m[1].toUpperCase());
}

export function boolProp(value) {
    if (typeof value === 'string') return value !== 'false';
    return !!value;
}
