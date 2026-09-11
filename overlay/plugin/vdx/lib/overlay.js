/**
 * Anchored Overlay Controller
 *
 * Positions a floating panel next to an anchor element and promotes it to the
 * browser **top layer** via the native Popover API, so the panel escapes all
 * three overlay failure modes at once - ancestor `overflow` clipping, ancestor
 * `transform`/`contain` containing blocks, and z-index stacking - with NO DOM
 * move. The node stays exactly where the component rendered it, so template
 * diffing, refs, reactivity, and any enclosing focus trap (e.g. cl-dialog's)
 * keep working untouched. Placement (flip/shift/size) is computed in JS from
 * the anchor's getBoundingClientRect() and written as `position: fixed`.
 *
 * Mirrors the create*(host, opts) convention of createWindowing / createRowGestures:
 * a factory returning a controller the component drives from its own lifecycle.
 *
 * Usage (e.g. cl-dropdown):
 *
 *     import { createAnchoredOverlay } from '../../lib/overlay.js';
 *
 *     constructor(props) {
 *         super(props);
 *         this._overlay = createAnchoredOverlay(this, {
 *             anchor: () => this.querySelector('.dropdown-trigger'),
 *             panel:  () => this.querySelector('.dropdown-panel'),
 *             placement: 'bottom-start',
 *             offset: 4,
 *             matchAnchorWidth: true,
 *             onDismiss: (reason) => {
 *                 this.closePanel();
 *                 if (reason === 'escape') this._focusTrigger();
 *             },
 *         });
 *     }
 *
 *     async openPanel() {
 *         this.state.showPanel = true;
 *         await this.nextRender();      // panel branch must exist before showPopover
 *         this._overlay.open();
 *     }
 *
 *     closePanel() {
 *         this._overlay.close();        // hidePopover BEFORE the node unmounts
 *         this.state.showPanel = false;
 *     }
 *
 *     unmounted() { this._overlay.destroy(); }
 *
 * The panel should carry `popover="manual"` in its template so it starts as a
 * hidden (display:none) popover - this avoids a one-frame flash of the panel
 * in normal flow before open() promotes it. open() sets the attribute as a
 * fallback if it is missing.
 */

import { rafThrottle, clamp } from './utils.js';

const POPOVER_SUPPORTED =
    typeof HTMLElement !== 'undefined' &&
    typeof HTMLElement.prototype.showPopover === 'function' &&
    HTMLElement.prototype.hasOwnProperty('popover');

/** Resolve an element-or-getter option to an element/anchor ref (or null). @private */
function resolveEl(value) {
    const el = typeof value === 'function' ? value() : value;
    return el || null;
}

/**
 * Normalize an anchor to a viewport rect. Accepts a DOM element, any object
 * with getBoundingClientRect(), or a point/rect literal `{ x, y, width?, height? }`
 * (context-menu anchors to the pointer, so width/height default to 0). @private
 */
function anchorRect(ref) {
    if (typeof ref.getBoundingClientRect === 'function') return ref.getBoundingClientRect();
    const x = ref.x || 0, y = ref.y || 0, w = ref.width || 0, h = ref.height || 0;
    return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
}

/** Split a placement string ('bottom-start') into side + alignment. @private */
function parsePlacement(placement) {
    const [rawSide, rawAlign = 'start'] = String(placement || 'bottom-start').split('-');
    const side = ['top', 'bottom', 'left', 'right'].includes(rawSide) ? rawSide : 'bottom';
    const align = rawAlign === 'end' ? 'end' : rawAlign === 'center' ? 'center' : 'start';
    return { side, align };
}

/**
 * Create an anchored-overlay controller.
 *
 * @param {HTMLElement} host - The owning component. Used only as an ownership
 *     handle (listeners are attached to document/window, not the host).
 * @param {Object} opts
 * @param {HTMLElement|{getBoundingClientRect:Function}|{x:number,y:number}|Function} opts.anchor -
 *     The thing the panel is positioned against: a DOM element, any object with
 *     getBoundingClientRect(), or a point literal `{ x, y }` (context-menu anchors to the
 *     pointer). May be a getter, re-resolved on every open()/reposition().
 * @param {HTMLElement|(() => HTMLElement|null)} opts.panel - The node to promote and
 *     position. Re-resolved on every open() (conditionally-rendered panels are a new
 *     node each time they mount).
 * @param {string} [opts.placement='bottom-start'] - `${side}-${align}` where side is
 *     'top'|'bottom'|'left'|'right' and align is 'start'|'center'|'end'. For top/bottom,
 *     align controls the horizontal edge; for left/right, the vertical edge. Auto-flips to
 *     the opposite side when there is not enough room.
 * @param {number} [opts.offset=4] - Gap between anchor and panel, in px.
 * @param {number} [opts.viewportPadding=8] - Minimum gap from the viewport edges.
 * @param {boolean} [opts.matchAnchorWidth=false] - Set panel width to the anchor's width.
 * @param {boolean} [opts.closeOnScroll=false] - false = reposition on scroll;
 *     true = dismiss on scroll (onDismiss('scroll')).
 * @param {(reason: 'outside'|'escape'|'scroll') => void} [opts.onDismiss] - Called on
 *     outside pointerdown, Escape, or (when closeOnScroll) scroll. The component is
 *     responsible for the actual close (which should call this controller's close()).
 * @param {(info: { side: string, align: string }) => void} [opts.onReposition] - Called
 *     after each placement with the resolved (post-flip) side/align.
 * @returns {{ open(): void, close(): void, reposition(): void, destroy(): void, readonly isOpen: boolean, readonly placement: string|null }}
 */
export function createAnchoredOverlay(host, opts) {
    const {
        offset = 4,
        viewportPadding = 8,
        matchAnchorWidth = false,
        closeOnScroll = false,
        onDismiss = () => {},
    } = opts;

    let shown = false;
    let destroyed = false;
    let panelEl = null;      // the node currently promoted/positioned
    let resolvedSide = null; // actual side after any flip (for arrow direction etc.)
    let resolvedAlign = null;

    // --- Positioning ------------------------------------------------------

    function reposition() {
        if (!shown) return;
        const anchor = resolveEl(opts.anchor);
        const panel = panelEl || resolveEl(opts.panel);
        if (!anchor || !panel) return;

        const placement = typeof opts.placement === 'function' ? opts.placement() : opts.placement;
        const { side, align } = parsePlacement(placement);
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pad = viewportPadding;
        const a = anchorRect(anchor);

        // Width first (it affects wrapping, hence natural height).
        if (matchAnchorWidth) panel.style.width = `${a.width}px`;

        // Measure natural size with no height cap.
        panel.style.maxHeight = '';
        const p = panel.getBoundingClientRect();
        const panelW = p.width;
        let panelH = p.height;

        let top, left, maxHeight = null, resolved = side;

        if (side === 'top' || side === 'bottom') {
            // --- Main axis vertical: flip top/bottom, cap height ---------
            const below = vh - pad - a.bottom;
            const above = a.top - pad;
            const placeBelow = side === 'bottom'
                ? (panelH + offset <= below || below >= above)
                : !(panelH + offset <= above || above >= below);
            resolved = placeBelow ? 'bottom' : 'top';

            const avail = Math.max(0, (placeBelow ? below : above) - offset);
            const h = Math.min(panelH, avail);
            if (h < panelH) maxHeight = h;
            top = placeBelow ? a.bottom + offset : a.top - offset - h;
            // Clamp the main axis into the viewport - a point anchor near the
            // bottom edge would otherwise leave the flipped panel overflowing.
            top = clamp(top, pad, Math.max(pad, vh - pad - h));

            // Cross axis horizontal.
            left = align === 'end' ? a.right - panelW
                 : align === 'center' ? a.left + (a.width - panelW) / 2
                 : a.left;
            left = clamp(left, pad, Math.max(pad, vw - pad - panelW));
        } else {
            // --- Main axis horizontal: flip left/right ------------------
            const right = vw - pad - a.right;
            const leftSpace = a.left - pad;
            const placeRight = side === 'right'
                ? (panelW + offset <= right || right >= leftSpace)
                : !(panelW + offset <= leftSpace || leftSpace >= right);
            resolved = placeRight ? 'right' : 'left';
            left = placeRight ? a.right + offset : a.left - offset - panelW;
            left = clamp(left, pad, Math.max(pad, vw - pad - panelW));

            // Cross axis vertical; cap to viewport height if taller.
            const availV = vh - 2 * pad;
            if (panelH > availV) { maxHeight = availV; panelH = availV; }
            top = align === 'end' ? a.bottom - panelH
                : align === 'center' ? a.top + (a.height - panelH) / 2
                : a.top;
            top = clamp(top, pad, Math.max(pad, vh - pad - panelH));
        }

        // Write. Override the UA popover defaults (inset:0; margin:auto) or
        // the panel would center itself in the viewport.
        panel.style.position = 'fixed';
        panel.style.margin = '0';
        panel.style.inset = 'auto';
        panel.style.top = `${Math.round(top)}px`;
        panel.style.left = `${Math.round(left)}px`;
        // Only cap the main dimension when the panel does not fit; otherwise
        // leave it natural so short panels don't get a pointless scrollbar.
        panel.style.maxHeight = maxHeight != null ? `${Math.round(maxHeight)}px` : '';

        resolvedSide = resolved;
        resolvedAlign = align;
        // Report the resolved (post-flip) placement so a component can, e.g.,
        // point a tooltip arrow the right way.
        if (typeof opts.onReposition === 'function') {
            opts.onReposition({ side: resolved, align });
        }
    }

    const onScroll = closeOnScroll
        ? () => { if (shown) onDismiss('scroll'); }
        : rafThrottle(reposition);
    const onResize = rafThrottle(reposition);

    function onPointerDown(e) {
        if (!shown) return;
        const anchor = resolveEl(opts.anchor);
        const target = e.target;
        if (panelEl && panelEl.contains(target)) return;
        // anchor may be a virtual point (context-menu) with no contains().
        if (anchor && typeof anchor.contains === 'function' && anchor.contains(target)) return;
        onDismiss('outside');
    }

    function onKeyDown(e) {
        if (shown && e.key === 'Escape') {
            // Capture-phase + stopPropagation so Escape dismisses only this
            // (topmost) overlay, not an enclosing cl-dialog that also listens
            // for Escape on document.
            e.stopPropagation();
            onDismiss('escape');
        }
    }

    // --- Listener lifecycle ----------------------------------------------

    function attachListeners() {
        // Capture-phase scroll catches nested scroll containers, not just window.
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        // Capture-phase pointerdown so a click that also closes something else
        // still registers as "outside" before other handlers can stop it.
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
    }

    function detachListeners() {
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
    }

    // --- Controller -------------------------------------------------------

    return {
        get isOpen() { return shown; },
        /** Resolved placement after flipping, e.g. 'top-center'. Null until first open. */
        get placement() { return resolvedSide ? `${resolvedSide}-${resolvedAlign}` : null; },

        open() {
            if (destroyed || shown) return;
            const panel = resolveEl(opts.panel);
            if (!panel) return;
            panelEl = panel;

            if (POPOVER_SUPPORTED) {
                if (!panel.hasAttribute('popover')) panel.setAttribute('popover', 'manual');
                // showPopover throws if already open; guard defensively.
                if (!panel.matches(':popover-open')) {
                    try { panel.showPopover(); } catch (_) { /* already shown */ }
                }
            }

            shown = true;
            reposition();
            attachListeners();
        },

        close() {
            if (!shown) return;
            shown = false;
            detachListeners();
            const panel = panelEl;
            panelEl = null;
            if (POPOVER_SUPPORTED && panel && panel.matches(':popover-open')) {
                try { panel.hidePopover(); } catch (_) { /* already hidden / detached */ }
            }
        },

        reposition,

        destroy() {
            destroyed = true;
            this.close();
        },
    };
}
