/**
 * Versioned List
 *
 * A thin reactive wrapper over a raw array. Structural changes (push, splice,
 * index/length writes, ...) bump a single reactive version cell; reads of
 * `length`, numeric indices, and iteration subscribe to it. Items are returned
 * RAW - there is no per-item proxying, so this carries the same performance
 * contract as untracked() while still driving re-renders on structural edits.
 *
 * This wraps the previously-sanctioned "untracked array + manual version
 * counter" pattern into an object that cannot be half-applied (no forgotten
 * bump, no forced `void state.version` read, no forgotten windowing refresh).
 *
 * @example
 *     import { versionedList } from './lib/framework.js';
 *
 *     state = { songs: versionedList([]) };
 *
 *     const songs = this.state.songs;
 *     songs.push(track);        // structural edit -> auto version bump
 *     songs.splice(from, 1);    // ditto (all mutating array methods)
 *     songs[3] = other;         // index/length writes trapped -> bump
 *     songs[3].title = 'x';     // item fields NOT tracked (that's the point)
 *     songs.touch();            // manual bump for in-place item edits
 *     songs.replace(newArray);  // wholesale swap, single bump
 *     songs.version;            // reactive integer, rarely read directly
 */

import { reactive, untracked, SELF_MANAGED } from './reactivity.js';

/** Array methods that structurally mutate the array (trigger a version bump) */
const MUTATING_METHODS = new Set([
    'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'
]);

/**
 * Create a versioned list wrapping the given array.
 *
 * @template T
 * @param {T[]} [initialArray] - The backing array (used directly, not copied)
 * @returns {T[] & { touch(): void, replace(next: T[]): void, readonly version: number }}
 *     A proxy that behaves like the array, plus touch()/replace()/version.
 */
export function versionedList(initialArray) {
    // The raw backing array - a COPY we own, so we never mutate (or fail to
    // stamp, if frozen) the caller's array. Marked untracked so reactive() won't
    // re-wrap the proxy, and SELF_MANAGED so it won't make our state key sticky-
    // untracked (a later plain array assigned to the same key stays reactive).
    // The proxy forwards both symbol reads through to this backing array.
    const target = untracked(Array.isArray(initialArray) ? initialArray.slice() : []);
    Object.defineProperty(target, SELF_MANAGED, { value: true, enumerable: false });

    // Single reactive cell: reading .v subscribes, writing .v triggers.
    const versionCell = reactive({ v: 0 });
    const bump = () => { versionCell.v++; };

    /** Subscribe the active effect to structural changes */
    const trackVersion = () => { const _ = versionCell.v; };

    const proxy = new Proxy(target, {
        get(arr, key, receiver) {
            // Wrapper API - these shadow nothing on a plain array
            if (key === 'version') {
                trackVersion();
                return versionCell.v;
            }
            if (key === 'touch') {
                return bump;
            }
            if (key === 'replace') {
                return (next) => {
                    // Indexed copy, not push(...next): spreading a large array
                    // as arguments overflows the call stack around ~100k items,
                    // which is exactly the list size this API exists for.
                    const len = next ? next.length : 0;
                    arr.length = len;
                    for (let i = 0; i < len; i++) arr[i] = next[i];
                    bump();
                };
            }

            // Structural reads subscribe to the version cell
            if (key === 'length' ||
                key === Symbol.iterator ||
                (typeof key === 'string' && /^\d+$/.test(key))) {
                trackVersion();
            }

            const value = Reflect.get(arr, key, receiver);

            // Wrap mutating array methods so they bump the version. They apply
            // to the raw array (not the proxy), so their internal length/index
            // writes don't re-enter the set trap - exactly one bump per call.
            if (typeof value === 'function' && MUTATING_METHODS.has(key)) {
                return function (...args) {
                    const result = Array.prototype[key].apply(arr, args);
                    bump();
                    return result;
                };
            }

            return value;
        },

        set(arr, key, value, receiver) {
            const result = Reflect.set(arr, key, value, receiver);
            // Index and length writes are structural changes.
            if (key === 'length' || (typeof key === 'string' && /^\d+$/.test(key))) {
                bump();
            }
            return result;
        },

        deleteProperty(arr, key) {
            const result = Reflect.deleteProperty(arr, key);
            if (typeof key === 'string' && /^\d+$/.test(key)) {
                bump();
            }
            return result;
        }
    });

    return proxy;
}
