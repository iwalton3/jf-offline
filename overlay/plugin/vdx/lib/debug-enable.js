/**
 * Debug Enabler - Monkey patches framework for debugging
 * Import this file ONLY when you need debug logging.
 * Zero performance cost when not imported.
 */

import { setDebugReactivityHook } from './core/reactivity.js';
import { setDebugComponentHooks } from './core/component.js';
import { logReactivity, debugLog } from './debug.js';

// Check debug flags
const DEBUG_REACTIVITY = typeof window !== 'undefined' && window.__DEBUG_REACTIVITY;
const DEBUG_COMPONENTS = typeof window !== 'undefined' && window.__DEBUG_COMPONENTS;
const DEBUG_VNODES = typeof window !== 'undefined' && window.__DEBUG_VNODES;

// Enable reactivity debugging if flag is set
if (DEBUG_REACTIVITY) {
    setDebugReactivityHook(logReactivity);
    console.log('[DEBUG] Reactivity logging enabled');
}

// Enable component debugging if the flag is set. (The old renderCycle and
// __DEBUG_VNODES hooks died with the pre-fine-grained renderer - fine-grained
// rendering has no per-component render cycle or vnode tree to log.)
if (DEBUG_COMPONENTS) {
    setDebugComponentHooks({
        propSet: (tagName, propName, value, _unused, isMounted) => {
            debugLog('PropSet', `${tagName}.${propName} = ${JSON.stringify(value)}`);
            if (isMounted) {
                debugLog('PropSet', `Triggering render for ${tagName}`);
            }
        }
    });
    console.log('[DEBUG] Component logging enabled');
}
if (DEBUG_VNODES) {
    console.warn('[DEBUG] __DEBUG_VNODES is obsolete - the fine-grained renderer has no vnode tree to log');
}

// Export for re-exporting if needed
export { setDebugReactivityHook, setDebugComponentHooks };
