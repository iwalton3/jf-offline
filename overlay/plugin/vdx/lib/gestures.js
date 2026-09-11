/**
 * Row Gestures Controller
 *
 * Rendering-agnostic row-gesture state machines - tap, long-press,
 * context-menu, desktop drag-and-drop reordering, and touch drag-via-handle
 * reordering - extracted from the duplicated handler suites in a production
 * music player's queue and playlist pages. The controller owns ALL gesture
 * state (drag index, drop gap, long-press timers, indicator classes); the
 * component owns the markup and binds its `on-*` attributes to the thin
 * delegating handler methods exposed here.
 *
 * Usage (component with its own list markup):
 *
 *     import { createRowGestures, gapToRemoveInsertIndex } from './lib/gestures.js';
 *
 *     data() {
 *         this._win = createWindowing(this, { itemHeight: 52, count: () => this.state.items.length });
 *         this._g = createRowGestures(this, {
 *             itemHeight: 52,
 *             windowing: this._win,                 // optional collaborator
 *             count: () => this.state.items.length,
 *             onTap: (i) => this.play(i),
 *             onLongPress: (i, e) => this.showMenu(i, e),
 *             onReorder: (fromIndices, gap) => {
 *                 // remove-then-insert store (e.g. queue.reorder(from, to)):
 *                 this.reorder(fromIndices[0], gapToRemoveInsertIndex(fromIndices[0], gap));
 *             },
 *             selection: { isSelected: (i) => this.isSelected(i), indices: () => [...this.selected] }
 *         });
 *         return { items: untracked([]) };
 *     },
 *     unmounted() { this._g.destroy(); this._win.destroy(); },
 *     template() {
 *         const g = this._g;
 *         return html`... ${memoEach(rows, (item, i) => html`
 *             <div class="row" data-index="${i}"
 *                  draggable="${!g.isTouchDevice()}"
 *                  on-click="${(e) => g.click(i, e)}"
 *                  on-contextmenu="${(e) => g.contextMenu(i, e)}"
 *                  on-touchstart-passive="${(e) => g.touchStart(i, e)}"
 *                  on-touchmove-passive="${(e) => g.touchMove(e)}"
 *                  on-touchcancel-passive="${(e) => g.touchCancel()}"
 *                  on-touchend="${(e) => g.touchEnd(i, e)}"
 *                  on-dragstart="${(e) => g.dragStart(i, e)}"
 *                  on-dragover="${(e) => g.dragOver(i, e)}"
 *                  on-dragleave="${(e) => g.dragLeave(e)}"
 *                  on-drop="${(e) => g.drop(i, e)}"
 *                  on-dragend="${(e) => g.dragEnd(e)}">
 *                <span class="handle"
 *                      on-touchstart="${(e) => g.handleTouchStart(i, e)}"
 *                      on-touchmove="${(e) => g.handleTouchMove(e)}"
 *                      on-touchend="${(e) => g.handleTouchEnd(e)}">⋮⋮</span>
 *             </div>`)} ...`;
 *     }
 *
 * ---------------------------------------------------------------------------
 * PASSIVE-SAFETY INVARIANT (read before binding touch handlers)
 * ---------------------------------------------------------------------------
 * Whether a handler may call preventDefault dictates whether it can be bound
 * with the passive listener modifier. Passive listeners run off the main
 * scroll path (the browser never waits for them), so long-press tracking
 * stays scroll-smooth. Drag handlers must suppress scrolling, so they cannot
 * be passive. Bind exactly per this table:
 *
 *   | handler            | preventDefault? | bind with            |
 *   |--------------------|-----------------|----------------------|
 *   | click              | no              | on-click             |
 *   | contextMenu        | no              | on-contextmenu       |
 *   | touchStart         | NEVER           | on-touchstart-passive|
 *   | rowTouchStart      | NEVER           | on-touchstart-passive|
 *   | touchMove          | NEVER           | on-touchmove-passive |
 *   | touchCancel        | NEVER           | on-touchcancel-passive|
 *   | touchEnd           | MAY (ghost-tap) | on-touchend          |
 *   | dragStart/Over/... | yes (DnD)       | on-dragstart etc.    |
 *   | handleTouchStart   | YES (suppress)  | on-touchstart        |
 *   | handleTouchMove    | YES (suppress)  | on-touchmove         |
 *   | handleTouchEnd     | YES (suppress)  | on-touchend          |
 *
 * touchStart/touchMove NEVER touch preventDefault - they are safe (and should)
 * be bound `-passive`. touchEnd may preventDefault to swallow the synthesized
 * ghost click after a long-press, and the handle* trio always preventDefault
 * to keep the page from scrolling under an in-progress drag; those four must
 * stay NON-passive.
 * ---------------------------------------------------------------------------
 *
 * The reorder callback always receives an *insertion gap* (0..count), already
 * clamped and no-op-filtered. Consumers translate that gap onto their store's
 * splice semantics with the pure helpers below - queue-style remove-then-insert
 * APIs use gapToRemoveInsertIndex; gap-semantic APIs use gapToGapIndex.
 */

import { withoutTracking } from './framework.js';

/**
 * Resolve a number-or-function option to a number.
 * @private
 */
function resolveNum(value, fallback) {
    const v = typeof value === 'function' ? value() : value;
    return (v === undefined || v === null || Number.isNaN(v)) ? fallback : v;
}

// ---------------------------------------------------------------------------
// Pure reorder-math helpers (exported, unit-testable)
//
// A drop produces an *insertion gap* g in 0..count: g is the slot the moved
// item(s) land in, counting slots between rows (gap 0 = before row 0, gap
// count = after the last row). Different store APIs consume this differently;
// these helpers translate the gap onto each convention. This math has been
// hand-corrected twice in production - treat the identities in the tests as
// the spec.
// ---------------------------------------------------------------------------

/**
 * Translate an insertion gap for a remove-then-insert reorder API - one that
 * does `splice(from, 1)` and then `splice(to, 0, moved)` (e.g. the player's
 * `reorderQueue(from, to)`). Removing `from` first shifts every later slot
 * left by one, so a gap past `from` must be decremented.
 *
 * @param {number} from - the source row index
 * @param {number} gap - the insertion gap (0..count)
 * @returns {number} the `to` index to pass to the splice-after-remove API
 */
export function gapToRemoveInsertIndex(from, gap) {
    return gap > from ? gap - 1 : gap;
}

/**
 * Identity pass-through for reorder APIs that already treat their target as an
 * insertion gap and do the remove-shift adjustment internally (e.g. the
 * playlist page's `reorderPlaylistSongs`, whose `insertIndex = from < to ?
 * to - 1 : to`). Exists for symmetric readability at call sites so the
 * gap-vs-index intent is explicit rather than an unexplained bare `gap`.
 *
 * @param {number} from - the source row index (unused; present for symmetry)
 * @param {number} gap - the insertion gap (0..count)
 * @returns {number} the same gap
 */
export function gapToGapIndex(from, gap) {
    return gap;
}

/**
 * Compute where a contiguous-or-scattered group of rows lands when moved to an
 * insertion gap, matching the selection-follow math in the player's
 * `reorderQueueBatch`/`reorderPlaylistSongsBatch`. Every selected index that
 * sits *before* the gap is removed first, pulling the insertion point left by
 * one per such index; the moved block then occupies contiguous slots from
 * there.
 *
 * @param {number[]} fromIndices - the moving rows (any order)
 * @param {number} gap - the insertion gap (0..count)
 * @returns {{ target: number, newIndices: number[] }} target = adjusted
 *     insertion index after removals; newIndices = resulting sorted positions
 *     [target .. target + n - 1]
 */
export function groupReorderTargets(fromIndices, gap) {
    const sorted = [...fromIndices].sort((a, b) => a - b);
    let target = gap;
    for (const idx of sorted) {
        if (idx < gap) target--;
    }
    const newIndices = sorted.map((_, i) => target + i);
    return { target, newIndices };
}

/**
 * True when dropping `fromIndices` at `gap` leaves order unchanged (a no-op
 * that should be filtered before calling any store). For a single row `i` the
 * no-op gaps are `i` and `i + 1` (the two gaps hugging the row). For a group
 * it is any gap that resolves - via groupReorderTargets - to the block's
 * current positions, i.e. any gap inside or hugging a contiguous selected run.
 *
 * @param {number[]} fromIndices - the moving rows
 * @param {number} gap - the insertion gap (0..count)
 * @returns {boolean}
 */
export function isNoopGap(fromIndices, gap) {
    const sorted = [...fromIndices].sort((a, b) => a - b);
    const { newIndices } = groupReorderTargets(sorted, gap);
    if (newIndices.length !== sorted.length) return false;
    return newIndices.every((v, i) => v === sorted[i]);
}

/**
 * Create a row-gestures controller.
 *
 * @param {HTMLElement} host - The element the list lives in. Used to query row
 *     elements for visual feedback (via `data-index`), to clean up indicator
 *     classes, and as the default scroll/geometry reference for touch drag.
 * @param {Object} options
 * @param {number|(() => number)} options.itemHeight - Fixed row height in px
 *     (required; used for touch-drag target math).
 * @param {Object} [options.windowing] - A createWindowing controller. Optional
 *     collaborator: when present its `scrollTop` is used for touch-drag
 *     absolute-index math (so virtualized rows map correctly) and its count is
 *     derived from `totalHeight` if `count` is omitted.
 * @param {() => number} [options.count] - Total row count, for gap clamping.
 *     Required when no `windowing` is supplied.
 * @param {(index: number, e: Event) => void} [options.onTap]
 * @param {(index: number, e: Event) => void} [options.onLongPress]
 * @param {(index: number, e: Event) => void} [options.onContextMenu]
 * @param {(fromIndices: number[], gap: number) => void} [options.onReorder] -
 *     REQUIRED to enable reorder features. `fromIndices` is always an array
 *     (single drag = `[i]`); `gap` is the insertion gap (0..count), already
 *     clamped and no-op-filtered.
 * @param {{ isSelected: (i: number) => boolean, indices: () => number[] }}
 *     [options.selection] - When present, dragging a selected row moves the
 *     whole selection (group drag).
 * @param {{ before?: string, after?: string }} [options.indicator] - Class
 *     names applied to the hovered row to show the insertion edge (defaults
 *     `{ before: 'drag-over', after: 'drag-over-below' }`). The controller
 *     owns adding/removing/cleaning these across `host`.
 * @param {string} [options.excludeSelector] - A row-body touch (via
 *     `rowTouchStart`) whose `e.target` matches this selector (tested with
 *     `closest`) never arms a drag - e.g. `'.selection-checkbox'` keeps a
 *     checkbox tap a pure selection tap.
 * @param {(index: number) => boolean} [options.canDrag] - Predicate gating
 *     which rows arm a *row-body* touch drag (`rowTouchStart`). Rows that fail
 *     it scroll or tap instead of dragging (e.g. only selected rows are grab
 *     handles in selection mode). Does not affect the drag-handle path.
 * @param {number} [options.activationThreshold=0] - Movement (px) a row-body
 *     touch drag must exceed before it promotes from a tap into a drag. 0 keeps
 *     the prior immediate activation. (Pages use 16 to survive tap wobble.)
 * @param {'geometry'|'pointer'} [options.touchTarget='geometry'] - Touch-drag
 *     drop targeting. 'geometry' uses fixed-itemHeight math on a self-scrolling
 *     host. 'pointer' resolves the hovered row via `document.elementFromPoint`
 *     and picks the gap by row midpoint (upper half = before, lower half =
 *     after), which tolerates sticky headers and non-self scroll containers.
 * @param {string} [options.rowClass] - In 'pointer' mode, the row's class used
 *     to resolve the hovered row via `element.closest('.<rowClass>')` (defaults
 *     to any `[data-index]` element).
 * @param {number} [options.longPressMs=500] - Long-press hold duration.
 * @param {number} [options.slop=10] - Movement (px) that cancels a long-press.
 * @param {string} [options.draggingClass='dragging']
 * @param {string} [options.groupDraggingClass='group-dragging']
 * @param {(index: number) => string} [options.rowSelector] - Builds a selector
 *     for the row at an index (default ``[data-index="${index}"]``), used to
 *     apply dragging/group-dragging feedback. Rows must carry that attribute
 *     for group-drag visuals.
 * @param {HTMLElement|(() => HTMLElement|null)} [options.scrollContainer] -
 *     Element scrolled by touch-drag edge autoscroll (default: the windowing
 *     scroll target if resolvable, else host).
 * @returns {Object} controller - handler methods plus isTouchDevice/cancel/destroy.
 */
export function createRowGestures(host, options) {
    const opts = options || {};
    if (!host || opts.itemHeight === undefined || opts.itemHeight === null) {
        throw new Error('[gestures] createRowGestures(host, { itemHeight }) - host and itemHeight are required');
    }
    if (typeof opts.count !== 'function' && !opts.windowing) {
        throw new Error('[gestures] createRowGestures needs a count() function when no windowing controller is supplied');
    }

    const windowing = opts.windowing || null;
    const itemHeight = () => resolveNum(opts.itemHeight, 1) || 1;

    // Total row count for clamping. Prefer an explicit count(); otherwise
    // derive it from the windowing spacer height (totalHeight / itemHeight).
    function count() {
        if (typeof opts.count === 'function') {
            return withoutTracking(() => opts.count());
        }
        if (windowing) {
            const h = itemHeight();
            return h > 0 ? Math.round(windowing.totalHeight / h) : 0;
        }
        return 0;
    }

    const longPressMs = opts.longPressMs !== undefined ? opts.longPressMs : 500;
    const slop = opts.slop !== undefined ? opts.slop : 10;
    const draggingClass = opts.draggingClass || 'dragging';
    const groupDraggingClass = opts.groupDraggingClass || 'group-dragging';
    const beforeClass = (opts.indicator && opts.indicator.before) || 'drag-over';
    const afterClass = (opts.indicator && opts.indicator.after) || 'drag-over-below';
    const indicatorSelector = `.${beforeClass}, .${afterClass}`;

    const rowSelector = typeof opts.rowSelector === 'function'
        ? opts.rowSelector
        : (index) => `[data-index="${index}"]`;

    const selection = opts.selection || null;

    // --- opt-in touch-drag refinements (all default to the prior behavior) ---
    // A touch starting on an element matching this selector never arms a drag
    // (e.g. '.selection-checkbox' - a pure selection tap).
    const excludeSelector = typeof opts.excludeSelector === 'string' ? opts.excludeSelector : null;
    // Predicate gating which rows arm a *row-body* touch drag (e.g. selection
    // mode arms drags only for already-selected rows; others scroll/tap).
    const canDrag = typeof opts.canDrag === 'function' ? opts.canDrag : null;
    // Movement (px) a row-body touch drag must exceed before it promotes from a
    // tap into a drag. 0 keeps the prior immediate-activation behavior.
    const activationThreshold = opts.activationThreshold !== undefined ? opts.activationThreshold : 0;
    // Touch-drag drop targeting: 'geometry' (default, fixed-itemHeight math) or
    // 'pointer' (hovered row via elementFromPoint, gap picked by row midpoint;
    // tolerates sticky headers / non-self scrollers).
    const touchTarget = opts.touchTarget === 'pointer' ? 'pointer' : 'geometry';
    // Row class used to resolve the hovered row in 'pointer' mode via
    // element.closest('.<rowClass>'). Falls back to any [data-index] element.
    const rowClass = typeof opts.rowClass === 'string' ? opts.rowClass : null;

    let destroyed = false;

    // --- gesture state (all owned here) ---------------------------------
    // Desktop drag-and-drop
    let dragIndex = null;
    let dropGap = null;
    let groupDrag = false;
    let draggedIndices = null;
    // Touch drag via handle
    let touchDragIndex = null;
    let touchDropGap = null;
    let touchGroupDrag = false;
    let touchDraggedIndices = null;
    let touchDragActive = false;
    // Row-body path only: armed (a drag is possible) but not yet promoted past
    // the activation threshold. Handle-path drags skip this (active immediately).
    let touchDragArmed = false;
    let bodyStartX = 0;
    let bodyStartY = 0;
    // Long-press / tap
    let longPressTimer = null;
    let touchStartX = 0;
    let touchStartY = 0;
    let longPressTriggered = false;
    // Ghost-click suppression: after a touch tap/long-press the browser fires a
    // synthesized click; ignore clicks landing within this window so onTap is
    // not fired twice (once from touchEnd, once from the ghost click).
    let suppressClickUntil = 0;
    // Edge autoscroll
    let autoscrollRaf = null;
    let autoscrollDir = 0;
    let autoscrollTarget = null;

    // --- helpers --------------------------------------------------------

    function scrollContainer() {
        if (typeof opts.scrollContainer === 'function') return opts.scrollContainer() || host;
        if (opts.scrollContainer) return opts.scrollContainer;
        return host;
    }

    function clampGap(gap) {
        const n = count();
        return Math.max(0, Math.min(gap, n));
    }

    function clearIndicators() {
        host.querySelectorAll(indicatorSelector).forEach(el => {
            el.classList.remove(beforeClass, afterClass);
        });
    }

    function clearGroupDragging() {
        host.querySelectorAll(`.${groupDraggingClass}`).forEach(el => {
            el.classList.remove(groupDraggingClass);
        });
    }

    function clearDragging() {
        host.querySelectorAll(`.${draggingClass}`).forEach(el => {
            el.classList.remove(draggingClass);
        });
    }

    function rowEl(index) {
        return host.querySelector(rowSelector(index));
    }

    function applyGroupDragging(indices) {
        for (const i of indices) {
            const el = rowEl(i);
            if (el) el.classList.add(groupDraggingClass);
        }
    }

    // Resolve the moving set for a gesture starting on `index`: the whole
    // selection when `index` is selected, else just `[index]`.
    function resolveMovingSet(index) {
        if (selection && selection.isSelected(index)) {
            const indices = selection.indices().slice().sort((a, b) => a - b);
            return { group: indices.length > 1, indices };
        }
        return { group: false, indices: [index] };
    }

    /**
     * Pointer-midpoint insertion gap for a dragover/drop on row `index`: upper
     * half -> gap = index (insert before), lower half -> index + 1 (after).
     * Uses the pointer's position within the row rather than merely which row
     * got the event, which tolerates sub-row cursor drift from drag-autoscroll
     * (the off-by-one drop bug this replaced). Returns null when geometry is
     * unavailable so callers fall back to the last-known gap / row index.
     * @private
     */
    function computeDropGap(index, e) {
        const row = e.currentTarget;
        if (!row || typeof e.clientY !== 'number') return null;
        const rect = row.getBoundingClientRect();
        if (!rect || !(rect.height > 0)) return null;
        return (e.clientY - rect.top) > rect.height / 2 ? index + 1 : index;
    }

    /**
     * Map a touch clientY to an insertion gap using fixed itemHeight geometry.
     * Content position under the pointer = (clientY - list top) + scroll
     * offset; the enclosing row is floor(pos / itemHeight) and the gap is
     * chosen by which half of that row the pointer sits in. With a windowing
     * collaborator its scrollTop drives the scroll term so virtualized rows
     * (spacer + translateY) still map to their absolute index. Assumes a
     * self-scrolling host (the source pages' model).
     * @private
     */
    function touchGap(clientY) {
        const h = itemHeight();
        const rect = host.getBoundingClientRect();
        const scrollTop = windowing ? windowing.scrollTop : host.scrollTop;
        const pos = (clientY - rect.top) + scrollTop;
        const n = count();
        let index = Math.floor(pos / h);
        if (index < 0) index = 0;
        if (index > n) index = n;
        const withinRow = pos - index * h;
        const gap = withinRow > h / 2 ? index + 1 : index;
        return Math.max(0, Math.min(gap, n));
    }

    function stopAutoscroll() {
        if (autoscrollRaf !== null) {
            cancelAnimationFrame(autoscrollRaf);
            autoscrollRaf = null;
        }
        autoscrollDir = 0;
        autoscrollTarget = null;
    }

    // rAF-based edge autoscroll during a touch drag - nudge the scroll
    // container when the pointer nears its top/bottom edge. (An improvement
    // over the source pages, which did not autoscroll during touch drag.)
    function updateAutoscroll(clientY) {
        const sc = scrollContainer();
        if (!sc || typeof sc.getBoundingClientRect !== 'function') {
            stopAutoscroll();
            return;
        }
        const rect = sc.getBoundingClientRect();
        const zone = 40;
        let dir = 0;
        if (clientY < rect.top + zone) dir = -1;
        else if (clientY > rect.bottom - zone) dir = 1;

        autoscrollDir = dir;
        autoscrollTarget = sc;
        if (dir === 0) {
            stopAutoscroll();
            return;
        }
        if (autoscrollRaf === null) {
            const step = () => {
                if (destroyed || autoscrollDir === 0 || !autoscrollTarget) {
                    autoscrollRaf = null;
                    return;
                }
                autoscrollTarget.scrollTop += autoscrollDir * 8;
                autoscrollRaf = requestAnimationFrame(step);
            };
            autoscrollRaf = requestAnimationFrame(step);
        }
    }

    function resetDrag() {
        dragIndex = null;
        dropGap = null;
        groupDrag = false;
        draggedIndices = null;
    }

    function resetTouchDrag() {
        touchDragIndex = null;
        touchDropGap = null;
        touchGroupDrag = false;
        touchDraggedIndices = null;
        touchDragActive = false;
        touchDragArmed = false;
    }

    /**
     * Resolve the row under a touch point for 'pointer' targeting. Returns the
     * row's absolute data-index and element, or null when the point is not over
     * a droppable row (off-list, or over the currently-dragged row).
     * @private
     */
    function pointerRowIndex(clientX, clientY) {
        if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null;
        const under = document.elementFromPoint(clientX, clientY);
        if (!under || typeof under.closest !== 'function') return null;
        const row = under.closest(rowClass ? `.${rowClass}` : '[data-index]');
        if (!row || row.dataset.index === undefined || row.classList.contains(draggingClass)) return null;
        const idx = parseInt(row.dataset.index, 10);
        if (Number.isNaN(idx)) return null;
        return { index: idx, row };
    }

    function clearLongPress() {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    }

    // --- controller -----------------------------------------------------

    const controller = {
        /** Coarse touch-capability probe (bind draggable="${!g.isTouchDevice()}"). */
        isTouchDevice() {
            return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        },

        // -- tap / context menu ------------------------------------------

        /** Mouse/synthesized click -> onTap, guarded so a touch tap does not
         *  double-fire via the browser's synthesized click. */
        click(index, e) {
            if (destroyed) return;
            if (performance.now() < suppressClickUntil) {
                suppressClickUntil = 0;
                return;
            }
            if (typeof opts.onTap === 'function') opts.onTap(index, e);
        },

        /** Context-menu (right-click / long-press-driven) -> onContextMenu. */
        contextMenu(index, e) {
            if (destroyed) return;
            // Android synthesizes a native `contextmenu` at ~the same instant
            // the long-press timer fires. If the long-press already opened the
            // menu, skip this one (dedupe) and leave longPressTriggered set so
            // touchEnd still suppresses the ghost click.
            if (longPressTriggered) return;
            // Native contextmenu arrived while a long-press was still pending:
            // cancel that timer so it can't ALSO fire, and (if this was a touch
            // gesture) mark it triggered so the trailing ghost tap is suppressed.
            const wasPending = !!longPressTimer;
            clearLongPress();
            if (wasPending) longPressTriggered = true;
            if (typeof opts.onContextMenu === 'function') opts.onContextMenu(index, e);
        },

        // -- long-press / tap (touch, passive-safe) ----------------------

        /** PASSIVE-SAFE: never preventDefaults. Records the touch origin and
         *  arms the long-press timer. */
        touchStart(index, e) {
            if (destroyed) return;
            clearLongPress();
            const touch = e.touches && e.touches[0];
            if (!touch) return;
            // A touch starting on an excluded element (e.g. a selection
            // checkbox) belongs to that control: arm neither long-press nor
            // tap. Otherwise touchEnd fires onTap AND the control's own click
            // handler fires from the synthesized click - a double toggle that
            // nets to nothing (dead checkboxes on touch devices).
            if (excludeSelector && e.target && typeof e.target.closest === 'function'
                && e.target.closest(excludeSelector)) {
                return;
            }
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            longPressTriggered = false;
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                // Only enter the long-press state when there's a consumer.
                // Otherwise a slow tap would be marked "triggered", touchEnd
                // would suppress its ghost click, and onTap would never fire -
                // a completely dead tap on any press held past longPressMs.
                if (typeof opts.onLongPress === 'function') {
                    longPressTriggered = true;
                    opts.onLongPress(index, e);
                }
            }, longPressMs);
        },

        /** PASSIVE-SAFE: never preventDefaults. Cancels a pending long-press
         *  once the finger moves beyond `slop`. */
        touchMove(e) {
            if (destroyed) return;
            if (!longPressTimer) return;
            const touch = e.touches && e.touches[0];
            if (!touch) return;
            const dx = Math.abs(touch.clientX - touchStartX);
            const dy = Math.abs(touch.clientY - touchStartY);
            if (dx > slop || dy > slop) {
                clearLongPress();
            }
        },

        /** MAY preventDefault: swallows the ghost click after a long-press. A
         *  clean quick tap (timer still armed, no long-press) fires onTap. */
        touchEnd(index, e) {
            if (destroyed) return;
            const hadTimer = !!longPressTimer;
            clearLongPress();
            if (longPressTriggered) {
                // Long-press already fired; suppress the ghost click + tap.
                longPressTriggered = false;
                suppressClickUntil = performance.now() + 700;
                if (typeof e.preventDefault === 'function') e.preventDefault();
                return;
            }
            if (hadTimer) {
                // Clean quick tap: fire onTap here and suppress the ghost click
                // so it does not fire onTap a second time.
                suppressClickUntil = performance.now() + 700;
                if (typeof opts.onTap === 'function') opts.onTap(index, e);
            }
        },

        // -- desktop drag-and-drop ---------------------------------------

        /** Begin a desktop drag. Sets dataTransfer, applies the dragging class,
         *  and captures the moving set (whole selection if the row is selected). */
        dragStart(index, e) {
            if (destroyed) return;
            dragIndex = index;
            dropGap = null;
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', String(index)); } catch { /* some browsers restrict */ }
            }
            if (e.currentTarget && e.currentTarget.classList) {
                e.currentTarget.classList.add(draggingClass);
            }
            const moving = resolveMovingSet(index);
            groupDrag = moving.group;
            draggedIndices = moving.indices;
            if (groupDrag) applyGroupDragging(draggedIndices);
        },

        /** Compute + display the insertion edge; suppress the indicator for
         *  no-op gaps. Always preventDefaults so the drop is allowed. */
        dragOver(index, e) {
            if (destroyed) return;
            if (typeof e.preventDefault === 'function') e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            if (dragIndex === null) return;

            const gap = computeDropGap(index, e);
            if (gap === null) return;
            dropGap = gap;

            if (isNoopGap(draggedIndices, gap)) {
                clearIndicators();
                return;
            }

            const cls = gap === index ? beforeClass : afterClass;
            const row = e.currentTarget;
            if (row && row.classList && !row.classList.contains(cls)) {
                clearIndicators();
                row.classList.add(cls);
            }
        },

        /** Remove the indicator when the pointer leaves the row's subtree. */
        dragLeave(e) {
            if (destroyed) return;
            const related = e.relatedTarget;
            const row = e.currentTarget;
            if (row && row.classList && (!related || !row.contains(related))) {
                row.classList.remove(beforeClass, afterClass);
            }
        },

        /** Commit a desktop drop. Gap comes from the drop event's own geometry,
         *  falling back to the last dragOver gap then the row index; no-op gaps
         *  are filtered before onReorder(fromIndices, clampedGap). */
        drop(index, e) {
            if (destroyed) return;
            if (typeof e.preventDefault === 'function') e.preventDefault();
            clearIndicators();
            clearGroupDragging();

            const fresh = computeDropGap(index, e);
            let gap = fresh !== null ? fresh : (dropGap !== null ? dropGap : index);
            dropGap = null;

            if (dragIndex !== null && draggedIndices && typeof opts.onReorder === 'function') {
                gap = clampGap(gap);
                if (!isNoopGap(draggedIndices, gap)) {
                    opts.onReorder(draggedIndices, gap);
                }
            }
            resetDrag();
        },

        /** End a desktop drag: clear all drag classes and state. */
        dragEnd(e) {
            if (destroyed) return;
            if (e && e.currentTarget && e.currentTarget.classList) {
                e.currentTarget.classList.remove(draggingClass);
            }
            clearDragging();
            clearIndicators();
            clearGroupDragging();
            resetDrag();
        },

        // -- touch drag via handle (non-passive) -------------------------

        /** Begin a touch drag from the drag handle. preventDefaults to suppress
         *  scrolling. Captures the moving set and applies drag feedback. */
        handleTouchStart(index, e) {
            if (destroyed) return;
            if (typeof e.stopPropagation === 'function') e.stopPropagation();
            if (typeof e.preventDefault === 'function') e.preventDefault();
            // A second finger landing mid-drag must not hijack (re-seed) the
            // active drag - the first finger keeps it.
            if (touchDragActive) return;
            touchDragIndex = index;
            touchDropGap = null;
            touchDragActive = true;
            touchDragArmed = false;
            const moving = resolveMovingSet(index);
            touchGroupDrag = moving.group;
            touchDraggedIndices = moving.indices;
            const src = rowEl(index);
            if (src) src.classList.add(draggingClass);
            if (touchGroupDrag) applyGroupDragging(touchDraggedIndices);
        },

        /** PASSIVE-SAFE row-body touch start for delayed-activation drags
         *  (opt-in; bind `on-touchstart-passive`). Never preventDefaults, so a
         *  tap or scroll is preserved; it merely arms a drag that only becomes
         *  active once `handleTouchMove` sees movement past `activationThreshold`.
         *  A touch matching `excludeSelector`, or a row rejected by `canDrag`,
         *  never arms - the browser keeps the tap/scroll gesture. */
        rowTouchStart(index, e) {
            if (destroyed) return;
            // A second finger mid-drag (or mid-arm) must not reset the state
            // of the gesture the first finger owns.
            if (touchDragActive || touchDragArmed) return;
            const touch = e.touches && e.touches[0];
            if (!touch) return;
            bodyStartX = touch.clientX;
            bodyStartY = touch.clientY;
            touchDragActive = false;
            touchDragArmed = false;
            touchDropGap = null;
            // A touch starting on an excluded element is a pure tap, never a grab.
            if (excludeSelector && e.target && typeof e.target.closest === 'function'
                && e.target.closest(excludeSelector)) {
                touchDragIndex = null;
                touchGroupDrag = false;
                touchDraggedIndices = null;
                return;
            }
            // Only rows the predicate allows arm a drag; others scroll or tap.
            if (!canDrag || canDrag(index)) {
                touchDragIndex = index;
                const moving = resolveMovingSet(index);
                touchGroupDrag = moving.group;
                touchDraggedIndices = moving.indices;
                touchDragArmed = true;
            } else {
                touchDragIndex = null;
                touchGroupDrag = false;
                touchDraggedIndices = null;
            }
        },

        /** Track the touch drag: preventDefaults, compute the hovered gap from
         *  itemHeight geometry, move the indicator, and edge-autoscroll. */
        handleTouchMove(e) {
            if (destroyed) return;
            if (touchDragIndex === null) return;
            const touch = e.touches && e.touches[0];
            if (!touch) return;

            // Delayed activation (row-body path): stay a no-op until the finger
            // moves past the activation threshold, so a tap or scroll survives.
            // Handle-path drags are already active (armed === false) and skip this.
            if (touchDragArmed && !touchDragActive) {
                const dx = Math.abs(touch.clientX - bodyStartX);
                const dy = Math.abs(touch.clientY - bodyStartY);
                if (dx < activationThreshold && dy < activationThreshold) return;
                touchDragActive = true;
                const src = rowEl(touchDragIndex);
                if (src) src.classList.add(draggingClass);
                if (touchGroupDrag) applyGroupDragging(touchDraggedIndices);
            }

            if (typeof e.stopPropagation === 'function') e.stopPropagation();
            if (typeof e.preventDefault === 'function') e.preventDefault();

            if (touchTarget === 'pointer') {
                // Pointer targeting resolves the hovered row via
                // elementFromPoint, then picks the gap by row midpoint exactly
                // like geometry mode / desktop dragOver: upper half -> insert
                // before (gap = index), lower half -> after (gap = index + 1).
                // This makes the LAST gap (below the final row) reachable and
                // lets no-op gaps be filtered instead of indicated.
                clearIndicators();
                touchDropGap = null;
                const hit = pointerRowIndex(touch.clientX, touch.clientY);
                if (hit) {
                    const rect = hit.row.getBoundingClientRect();
                    const gap = (rect && rect.height > 0 &&
                        (touch.clientY - rect.top) > rect.height / 2)
                        ? hit.index + 1 : hit.index;
                    touchDropGap = gap;
                    if (!isNoopGap(touchDraggedIndices, gap)) {
                        hit.row.classList.add(gap === hit.index ? beforeClass : afterClass);
                    }
                }
                updateAutoscroll(touch.clientY);
                return;
            }

            const gap = touchGap(touch.clientY);
            touchDropGap = gap;

            clearIndicators();
            if (!isNoopGap(touchDraggedIndices, gap)) {
                // The hovered row is the one the gap sits at the top or bottom
                // of; show the matching edge on it.
                const n = count();
                const hoveredIndex = gap >= n ? n - 1 : gap;
                const row = rowEl(hoveredIndex);
                if (row && row.classList) {
                    const cls = gap === hoveredIndex ? beforeClass : afterClass;
                    row.classList.add(cls);
                }
            }

            updateAutoscroll(touch.clientY);
        },

        /** Commit the touch drag: preventDefaults, stop autoscroll, clean up,
         *  and onReorder(fromIndices, clampedGap) unless it is a no-op. */
        handleTouchEnd(e) {
            if (destroyed) return;

            // Anything that is not an ACTIVE drag must reset WITHOUT
            // preventDefault, or the browser never synthesizes the tap's click
            // and taps go dead. That covers BOTH the armed-but-below-threshold
            // row-body tap AND the never-armed touch (excludeSelector matches -
            // e.g. a checkbox - or canDrag rejected the row). Handle-path drags
            // and promoted row-body drags are active and fall through to commit.
            if (!touchDragActive) {
                resetTouchDrag();
                return;
            }

            if (typeof e.stopPropagation === 'function') e.stopPropagation();
            if (typeof e.preventDefault === 'function') e.preventDefault();
            stopAutoscroll();
            clearDragging();
            clearIndicators();
            clearGroupDragging();

            if (touchDragIndex !== null && touchDropGap !== null &&
                touchDraggedIndices && typeof opts.onReorder === 'function') {
                const gap = clampGap(touchDropGap);
                if (!isNoopGap(touchDraggedIndices, gap)) {
                    opts.onReorder(touchDraggedIndices, gap);
                }
            }
            resetTouchDrag();
        },

        // -- lifecycle ---------------------------------------------------

        /** Abort any in-flight gesture and clear all transient classes/timers. */
        cancel() {
            clearLongPress();
            longPressTriggered = false;
            stopAutoscroll();
            clearDragging();
            clearIndicators();
            clearGroupDragging();
            resetDrag();
            resetTouchDrag();
        },

        /** PASSIVE-SAFE: never preventDefaults. The OS aborted the touch
         *  (notification shade, incoming call, palm rejection, app switch).
         *  Tears down all in-flight gesture state, so a pending long-press
         *  can't fire with no finger down and a drag can't leave a row stuck
         *  in the `.dragging` state. Bind `on-touchcancel-passive`. */
        touchCancel() {
            if (destroyed) return;
            controller.cancel();
        },

        /** Full teardown. The controller no-ops after this. */
        destroy() {
            controller.cancel();
            destroyed = true;
        }
    };

    return controller;
}
