/**
 * x-await-then - Self-contained async rendering component
 *
 * Manages its own loading/resolved/error state internally.
 * When the promise resolves, it triggers its own re-render.
 * Parent components don't need to track async state at all.
 */
// Import directly from core modules to avoid circular dependency with framework.js
import { defineComponent } from './component.js';
import { Component } from './component-class.js';
import { html } from './template.js';

export class XAwaitThen extends Component {
    static props = {
        promise: null,      // Promise or immediate value
        then: null,         // Function: (data) => html`...` - what to render on success
        pending: null,      // Loading content (html template)
        catch: null         // Error content (function or html template)
    };  // trailing semicolon: keeps the field ASI-safe once the bundler minifies away the newline before constructor()

    constructor(props) {
        super(props);

        this.state = {
            status: 'pending',
            value: null,
            err: null
        };
    }

    /**
     * Track promise and subscribe to its resolution.
     * Uses non-reactive _trackedPromise to avoid extra renders.
     * Called on every render to detect prop changes.
     */
    _trackPromise() {
        const promise = this.props.promise;

        // Same promise reference - no action needed
        if (promise === this._trackedPromise) {
            return;
        }

        this._trackedPromise = promise;

        // Not a promise (including null/undefined) - treat as immediate value
        if (promise == null || typeof promise.then !== 'function') {
            // Value before status, same invariant as the async path below
            this.state.value = promise;
            this.state.err = null;
            this.state.status = 'resolved';
            return;
        }

        // New promise - reset to pending and subscribe
        this.state.status = 'pending';
        this.state.value = null;
        this.state.err = null;

        const tracked = promise;
        promise.then(
            resolvedValue => {
                // Only update if this is still the current promise
                if (this._trackedPromise === tracked) {
                    // IMPORTANT: Set value BEFORE status to avoid render with null value
                    // The reactive system triggers re-render on each state change
                    this.state.value = resolvedValue;
                    this.state.status = 'resolved';
                }
            },
            error => {
                if (this._trackedPromise === tracked) {
                    // With no catch prop, nothing else will surface this - the
                    // component just renders empty. Don't fail silently.
                    if (this.props.catch == null) {
                        console.error(`[${this.tagName.toLowerCase()}] Promise rejected with no catch handler:`, error);
                    }
                    this.state.err = error;
                    this.state.status = 'rejected';
                }
            }
        );
    }

    /**
     * Get the content to render based on current status
     */
    _getContent() {
        const { status, value, err } = this.state;
        // Use props named after Promise methods: then, pending (loading), catch (error)
        const thenFn = this.props.then;
        const pendingContent = this.props.pending;
        const catchFn = this.props.catch;

        if (status === 'pending') {
            return pendingContent || html``;
        }

        if (status === 'rejected') {
            if (typeof catchFn === 'function') {
                return catchFn(err);
            }
            return catchFn || html``;
        }

        // Resolved
        if (typeof thenFn === 'function') {
            try {
                return thenFn(value);
            } catch (err) {
                // If thenFn throws (e.g., accessing property on null),
                // show error content if available, otherwise re-throw
                if (typeof catchFn === 'function') {
                    return catchFn(err);
                }
                if (catchFn) {
                    return catchFn;
                }
                throw err;
            }
        }
        return html``;
    }

    template() {
        // Check for promise changes on every render
        this._trackPromise();
        return this._getContent();
    }

    // No styles - renders to light DOM for easier composition
}

export default defineComponent('x-await-then', XAwaitThen);
