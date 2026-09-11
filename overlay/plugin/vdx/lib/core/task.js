/**
 * createTask - the stale-async (latest-wins) primitive.
 *
 * A task carries STATUS, never data. The completed work commits to real state
 * (this.state / a store) from inside the task body; there is no `task.value`.
 * `pending` / `error` live on the task because they are per-operation metadata,
 * not application state.
 *
 * Latest-wins via abort propagation: `run()` aborts the previous in-flight
 * run's AbortSignal and calls `fn(signal, ...args)`. A superseded run's
 * abort-aware awaits (fetch, etc.) reject with AbortError before their commit
 * lines run, so direct state commits in the body are safe with no gating. For
 * a non-abort-aware await, use `signal.throwIfAborted()` immediately after it.
 *
 * This is the guard hand-rolled as "ignore results from a superseded request"
 * (the router ships the same logic internally as _navToken). It is self
 * contained: an identity token, an AbortController, and a small reactive()
 * object - public reactivity API only, zero framework-core changes.
 *
 * @example
 *     search = this.createTask(async (signal, query) => {
 *         const r = await fetch('/api/search?q=' + encodeURIComponent(query), { signal });
 *         this.state.hits = (await r.json()).hits;   // reached only if still current
 *     });
 *
 *     onInput(e, value) { this.search.run(value); }
 *     // template: ${when(this.search.pending, () => html`<cl-spinner></cl-spinner>`)}
 */

import { reactive } from './reactivity.js';

/**
 * @template T
 * @typedef {Object} Task
 * @property {(...args: any[]) => Promise<T|undefined>} run - Abort the previous
 *     run and start a new one. Never rejects: resolves the body's return value
 *     when the run completed and is still current, undefined when superseded,
 *     aborted, or failed.
 * @property {() => void} cancel - Abort the in-flight run (clears pending).
 * @property {boolean} pending - Reactive: true while the latest run is in flight.
 * @property {any} error - Reactive: the latest current run's failure (cleared
 *     when a new run starts). AbortError never lands here.
 * @property {() => void} dispose - Cancel and permanently deactivate the task.
 */

/**
 * Create a latest-wins async task.
 *
 * @template T
 * @param {(signal: AbortSignal, ...args: any[]) => Promise<T> | T} fn - The task
 *     body. Receives an AbortSignal that aborts when the run is superseded.
 * @returns {Task<T>}
 */
export function createTask(fn) {
    // pending/error are reactive so templates track them directly.
    const status = reactive({ pending: false, error: null });

    let controller = null;   // AbortController of the in-flight run
    let runId = 0;           // identity token: only the latest run may commit status
    let disposed = false;

    async function run(...args) {
        if (disposed) return undefined;

        // Supersede the previous run - its abort-aware awaits reject with
        // AbortError before their commit lines execute.
        if (controller) controller.abort();
        controller = new AbortController();
        const signal = controller.signal;
        const id = ++runId;

        status.pending = true;
        status.error = null;

        try {
            const result = await fn(signal, ...args);
            // Superseded (or disposed) while awaiting: swallow, no commit.
            if (id !== runId || disposed) return undefined;
            status.pending = false;
            return result;
        } catch (err) {
            // A superseded/cancelled/disposed run is no longer current (runId was
            // bumped before its signal aborted), so its AbortError is the
            // mechanism working - swallow it and leave status to the new owner.
            if (id !== runId || disposed) return undefined;
            // Still the current run: this is a genuine failure, even if it is an
            // AbortError from the app's OWN signal (e.g. AbortSignal.timeout).
            // Report it and clear pending - never leave the spinner stuck.
            status.error = err;
            status.pending = false;
            return undefined;
        }
    }

    function cancel() {
        if (controller) {
            controller.abort();
            controller = null;
        }
        // Invalidate any in-flight run so a late resolution can't commit.
        runId++;
        status.pending = false;
    }

    return {
        run,
        cancel,
        get pending() { return status.pending; },
        get error() { return status.error; },
        dispose() {
            if (disposed) return;
            disposed = true;
            cancel();
        }
    };
}
