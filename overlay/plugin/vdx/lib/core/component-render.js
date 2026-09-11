/**
 * Mounting a component's template: the compute effect that re-evaluates
 * template() on any dependency, the per-slot value getters it feeds, the
 * error fallback, and the recovery effect that retries a failed first render.
 *
 * Moved out of connectedCallback as-is. `gen` is the connect generation:
 * every continuation queued here captures it and no-ops when a newer
 * connect has superseded it (a synchronous DOM move re-runs this whole
 * setup, and a stale closure instantiating would create a zombie compute
 * effect).
 */

import { reactive, createEffect, trackMutations, runAsEffect } from './reactivity.js';
import { STORE_BRAND } from './store.js';
import { isSameCompiled } from './template.js';
import { instantiateTemplate, VALUE_GETTER } from './template-renderer.js';

/** Re-instantiate on the next microtask (error recovery after a prop change). */
export function scheduleRender(component) {
    if (component._fgReinstantiate && component._isMounted && !component._isDestroyed) {
        queueMicrotask(component._fgReinstantiate);
    }
}

/**
 * Render `options.template` into `component` and keep it live. Sets
 * component._fgReinstantiate (used by scheduleRender) and
 * component._fineGrainedCleanup (called at disconnect).
 */
export function mountTemplate(component, options, name, gen) {
    component._injectStyles();

    let currentCompiled = null;
    let currentCleanup = null;
    let afterRenderCalled = false;

    // Function to instantiate error fallback template (uses static values)
    const instantiateErrorFallback = (templateResult) => {
        // Clean up previous if exists
        if (currentCleanup) {
            currentCleanup();
            component.innerHTML = '';
        }

        currentCompiled = templateResult._compiled;

        // Use static values directly - error fallbacks don't need reactive getters
        const values = templateResult._values || [];

        // Instantiate template with static values
        const { fragment, cleanup: templateCleanup } = instantiateTemplate(
            templateResult._compiled,
            values,
            component
        );

        component.appendChild(fragment);
        currentCleanup = templateCleanup;
    };

    // Function to instantiate/reinstantiate template
    const instantiate = (templateResult) => {
        // Clean up previous if exists
        if (currentCleanup) {
            currentCleanup();
            component.innerHTML = '';
        }

        currentCompiled = templateResult._compiled;

        // Cached template result - updated by a single "compute" effect
        // Slot getters read from component cache (NOT calling template() themselves)
        // Use a wrapper object so getters always see updated values via cache.values
        const cache = { values: templateResult._values || [] };

        // Reactive version counter - slot effects track component to know when to re-read
        const cacheVersion = reactive({ v: 0 });
        // Non-reactive counter to avoid self-tracking loop (v++ reads then writes)
        let versionCounter = 0;

        // Reference to the compute effect (set after creation for access in effect body)
        let computeEffectRef = null;

        // Single effect that watches ALL state and recomputes template once
        // This prevents N slots from calling template() N times
        // Slot effects created during instantiation become children of computeEffect
        // via the ownership system, ensuring cascading disposal on unmount.
        const computeEffect = createEffect(() => {
            // Track props version
            if (component._propsVersion) {
                const _ = component._propsVersion.v;
            }

            try {
                const result = options.template.call(component);

                // If template structure changed, schedule re-instantiation.
                // isSameCompiled: a recompile after cache eviction is the
                // same template - update values, don't rebuild the DOM.
                if (!isSameCompiled(result._compiled, currentCompiled)) {
                    // Dispose all child effects immediately to prevent them from
                    // running with stale state before re-instantiation
                    // (They were triggered by the same state change that triggered us)
                    const eff = computeEffectRef;
                    if (eff && eff.children) {
                        for (const child of eff.children) {
                            if (child.dispose) child.dispose();
                        }
                        eff.children.clear();
                    }
                    queueMicrotask(() => {
                        // gen check: a synchronous DOM move re-ran the
                        // template setup; instantiating from component stale
                        // closure would create a zombie compute effect
                        if (!component._isDestroyed && component._isMounted &&
                            gen === component._connectGen) {
                            instantiate(result);
                        }
                    });
                    return;
                }

                // Update cached values and bump version to trigger slot effects
                // Write to cache.values (not reassign) so getters see update
                cache.values = result._values || [];
                // Write new version without reading (avoids self-tracking loop)
                cacheVersion.v = ++versionCounter;
            } catch (error) {
                if (!component._hasRenderError) {
                    component._hasRenderError = true;
                    console.error(`[${component.tagName}] Render error:`, error);

                    if (options.renderError) {
                        queueMicrotask(() => {
                            if (component._isDestroyed || !component._isMounted ||
                                gen !== component._connectGen) return;
                            try {
                                const fallback = options.renderError.call(component, error);
                                if (fallback && fallback._compiled) {
                                    instantiateErrorFallback(fallback);
                                }
                            } catch (fallbackError) {
                                console.error(`[${component.tagName}] renderError() also failed:`, fallbackError);
                            }
                        });
                    }
                }
            }
        }, { label: `compute:${name}` });

        // Set ref so effect body can access it on subsequent runs
        computeEffectRef = computeEffect.effect;

        // Store on component so children can use it for ownership
        component._computeEffect = computeEffectRef;

        // Convert initial values to getters that read from cached result
        const values = templateResult._values || [];
        const valueGetters = values.map((initialValue, index) => {
            // A function value is handed out through a wrapper whose
            // identity is stable for the component's life but which
            // dispatches to the closure from the latest render.
            // Passing the function through froze it at first render;
            // returning the raw function from the getter would hand
            // every child a new identity on every render.
            //
            // The wrapper is created lazily INSIDE the getter, not
            // chosen up front from the initial value: a slot whose
            // value stops being a function must be able to say so.
            // Deciding once left the child holding a live wrapper -
            // a silent no-op - with no propsChanged.
            let fnWrapper = null;
            const getter = () => {
                const _ = cacheVersion.v;  // Track version to trigger re-runs
                const current = cache.values[index];
                if (typeof current !== 'function') return current;
                // Anything that refuses .apply() must be handed over
                // untouched - the wrapper dispatches with .apply(),
                // and wrapping would also hide .name, .prototype,
                // statics and instanceof. That is classes, bound
                // functions (a bound class throws the same way) and
                // proxies around them; the source text is what
                // distinguishes those, and it tracks .apply()
                // exactly. A non-writable `prototype` does not: an
                // ordinary function can have one and still be
                // callable, and a bound class has no own prototype
                // at all. Such values are stable references anyway,
                // so they lose nothing by skipping the wrapper.
                const src = Function.prototype.toString.call(current);
                if (/^\s*class[\s{]/.test(src) || /\{\s*\[native code\]\s*\}\s*$/.test(src)) {
                    return current;
                }
                if (!fnWrapper) {
                    // `function`, not an arrow, so an explicit `this`
                    // at the call site still reaches the real handler.
                    fnWrapper = function (...args) {
                        const fn = cache.values[index];
                        if (typeof fn === 'function') return fn.apply(this, args);
                    };
                }
                return fnWrapper;
            };
            // Mark as a value getter so template-renderer knows to call it
            getter[VALUE_GETTER] = true;
            return getter;
        });

        // Instantiate template - run with computeEffect as owner so
        // slot effects become its children (for cascading disposal)
        const { fragment, cleanup: templateCleanup } = runAsEffect(
            computeEffectRef,
            () => instantiateTemplate(templateResult._compiled, valueGetters, component)
        );

        component.appendChild(fragment);
        currentCleanup = () => {
            templateCleanup();
            computeEffect.dispose();
        };

        // Call afterRender hook
        if (options.afterRender && !afterRenderCalled) {
            afterRenderCalled = true;
            Promise.resolve().then(() => {
                if (!component._isDestroyed && component._isMounted &&
                    gen === component._connectGen) {
                    options.afterRender.call(component);
                }
            }).catch(error => {
                console.error(`[${component.tagName}] afterRender() error:`, error);
            });
        }
    };

    // Store reinstantiate function for prop change handling
    component._fgReinstantiate = () => {
        if (component._isDestroyed || !component._isMounted ||
            gen !== component._connectGen) return;
        try {
            const result = options.template.call(component);
            if (result && result._compiled) {
                instantiate(result);
            }
            component._hasRenderError = false;
        } catch (error) {
            component._hasRenderError = true;

            // Call error handler if defined
            if (options.renderError) {
                try {
                    const fallback = options.renderError.call(component, error);
                    if (fallback && fallback._compiled) {
                        instantiateErrorFallback(fallback);
                    }
                } catch (fallbackError) {
                    console.error(`[${component.tagName}] renderError() also failed:`, fallbackError);
                }
            }

            console.error(`[${component.tagName}] Render error:`, error);
        }
    };

    // Initial instantiation with error handling
    try {
        const templateResult = options.template.call(component);

        if (templateResult && templateResult._compiled) {
            instantiate(templateResult);
        }
        component._hasRenderError = false;
    } catch (error) {
        component._hasRenderError = true;

        // Call error handler if defined
        if (options.renderError) {
            try {
                const fallback = options.renderError.call(component, error);
                if (fallback && fallback._compiled) {
                    instantiateErrorFallback(fallback);
                }
            } catch (fallbackError) {
                console.error(`[${component.tagName}] renderError() also failed:`, fallbackError);
            }
        }

        console.error(`[${component.tagName}] Render error:`, error);

        // Set up recovery effect - watches state and retries when it changes
        const recoveryEffect = createEffect(() => {
            // Track mutations using O(1) mutation counter
            trackMutations(component.state);
            if (component.stores) {
                for (const store of Object.values(component.stores)) {
                    // Class Store instances expose reactive data
                    // under .state; legacy stores ARE the state.
                    trackMutations(store && store[STORE_BRAND] ? store.state : store);
                }
            }

            // Don't run recovery on first execution (that's the initial failed render)
            if (!component._hasRenderError) return;

            // Try to re-render
            queueMicrotask(() => {
                if (component._isDestroyed || !component._isMounted ||
                    gen !== component._connectGen) return;
                try {
                    const result = options.template.call(component);

                    if (result && result._compiled) {
                        // Success! Clean up recovery effect and instantiate
                        recoveryEffect.dispose();
                        instantiate(result);
                        component._hasRenderError = false;
                    }
                } catch (retryError) {
                    // Still failing - will retry on next state change
                }
            });
        });

        // Store recovery effect cleanup
        component._cleanups.push(() => recoveryEffect.dispose());
    }

    // Called at disconnect: tears down the live template and its compute effect
    component._fineGrainedCleanup = () => {
        if (currentCleanup) currentCleanup();
    };
}
