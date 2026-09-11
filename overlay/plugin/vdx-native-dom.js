/* The one DOM call vdx cannot make for itself inside jellyfin-web.
 *
 * jellyfin-web depends on webcomponents.js 0.7, the 2015 v0 polyfill, because
 * every one of its emby-* elements is registered through `document.registerElement`
 * (see src/elements/). That polyfill replaces `document.createElement`, and an
 * element created through the replacement is never upgraded by the *native*
 * custom elements registry — so a vdx component built that way runs
 * connectedCallback against a bare HTMLElement and throws before it renders.
 *
 * Measured in the page: the parser (innerHTML) upgrades correctly, `importNode`
 * upgrades correctly, the native createElement upgrades correctly, and only the
 * patched createElement does not. So this replaces exactly that one call, and
 * everything else vdx does with `document` is left alone.
 *
 * Unpatching globally is not an option: it would break every jellyfin-web
 * element, which is what the polyfill is there for.
 *
 * tools/sync-vdx.sh rewrites `document.createElement(` to `vdxCreateElement(` in
 * the copied vdx sources and adds the import, so this survives a re-sync.
 */

const native = window.__phantom
    && window.__phantom.nativeDom
    && window.__phantom.nativeDom.createElement;

if (!native) {
    // Not fatal — plain elements are fine either way — but every custom element
    // vdx creates will silently fail to render, so say so once.
    console.warn('[phantom] native document.createElement was not captured; vdx custom elements may not upgrade');
}

export const vdxCreateElement = native
    ? (...args) => native.apply(document, args)
    : (...args) => document.createElement(...args);
