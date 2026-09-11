/**
 * VNode Marker Symbols
 *
 * Dependency-free leaf module holding the trust markers that identify
 * framework-built template values (vnodes). Both template.js and
 * reactivity.js import from here - reactivity.js must not import template.js
 * (template.js -> template-compiler.js -> component.js -> reactivity.js
 * would be a cycle), and identifying vnodes by marker Symbol instead of by
 * shape ('_compiled' in obj) means user state that merely has a `_compiled`
 * field can never be mistaken for a vnode.
 *
 * Security: these are plain `Symbol()` (NOT Symbol.for) so external/attacker
 * data can never obtain them - a plain object from JSON.parse can't carry the
 * marker. HTML_MARKER is exported for framework-internal modules ONLY (the
 * renderer stamps internally-built fragments with it); sharing it among
 * trusted modules doesn't weaken the guarantee, which is that untrusted data
 * can't forge it.
 *
 * @module core/markers
 */

export const HTML_MARKER = Symbol('html');
export const RAW_MARKER = Symbol('raw');
export const CONTAIN_MARKER = Symbol('contain');
export const MEMO_EACH_MARKER = Symbol('memoEach');
export const WHEN_MARKER = Symbol('when');

// Helper functions to check markers (safe API for other code).
// Every framework-built template value (html``, when() function form,
// contain(), memoEach(), each() fragments, EMPTY_WHEN_RESULT, and the
// renderer's internal fromEach fragments) carries HTML_MARKER, so isHtml()
// doubles as "is a framework vnode".
export const isHtml = (obj) => !!(obj && obj[HTML_MARKER] === true);
export const isRaw = (obj) => !!(obj && obj[RAW_MARKER] === true);
export const isContain = (obj) => !!(obj && obj[CONTAIN_MARKER] === true);
export const isMemoEach = (obj) => !!(obj && obj[MEMO_EACH_MARKER] === true);
export const isWhen = (obj) => !!(obj && obj[WHEN_MARKER] === true);
