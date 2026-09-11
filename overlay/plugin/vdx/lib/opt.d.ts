/**
 * VDX Template Optimizer - TypeScript Definitions
 *
 * Fine-grained reactivity optimization for templates.
 */

/**
 * Enable fine-grained reactivity by transforming a template function to wrap
 * all expressions in `html.contain()`. Use with `eval()` for runtime transformation.
 *
 * Each `${expression}` becomes `${html.contain(() => expression)}`, creating
 * isolated reactive boundaries so that changes to one expression don't trigger
 * re-renders of other expressions in the same template.
 *
 * **Expressions that are NOT wrapped:**
 * - Arrow functions: `${() => handler}`
 * - Already contained: `${contain(() => ...)}`
 * - Control flow: `${when(...)}`, `${each(...)}`, `${memoEach(...)}`
 * - Raw content: `${raw(...)}`
 * - Slots/children: `${this.props.children}`, `${this.props.slots.xxx}`
 *
 * **CSP Note:** Requires `'unsafe-eval'` in Content Security Policy.
 * For strict CSP environments, use manual `contain()` calls or the
 * build-time optimizer (`optimize.js`).
 *
 * @param templateFn - Template function that returns `html\`...\``
 * @returns String of transformed function source code (requires eval())
 *
 * @example
 * import { defineComponent, html } from './lib/framework.js';
 * import { opt } from './lib/opt.js';
 *
 * defineComponent('my-counter', {
 *     data() {
 *         return { count: 0, name: 'Counter' };
 *     },
 *
 *     // Wrap template function in eval(opt(...))
 *     template: eval(opt(function() {
 *         return html`
 *             <div>
 *                 <h1>${this.state.name}</h1>
 *                 <p>Count: ${this.state.count}</p>
 *                 <button on-click="${() => this.state.count++}">+</button>
 *             </div>
 *         `;
 *     }))
 * });
 */
export function opt(templateFn: () => ReturnType<typeof import('./framework.js').html>): string;
