/**
 * opt() - Source Mangling for Fine-Grained Reactivity
 *
 * Transforms template functions to wrap all ${EXPR} expressions in
 * html.contain(() => (EXPR)), enabling Solid-style fine-grained reactivity.
 *
 * Usage:
 *   template: eval(opt(() => html`<div>${this.state.count}</div>`))
 *
 * The eval() runs in the user's module scope, giving access to all imports.
 * This is similar to how Solid requires certain patterns for its compiler.
 */

/**
 * Main optimization function.
 * Takes a template function and returns a string of mangled source code.
 * User must wrap in eval() to get the actual function.
 *
 * @param {Function} templateFn - The template function to optimize
 * @returns {string} Mangled source code string (wrap in eval())
 *
 * @example
 * // Simple case
 * template: eval(opt(() => html`<div>${this.state.count}</div>`))
 *
 * // With external imports - eval gives access automatically
 * import { formatDate } from './utils.js';
 * template: eval(opt(() => html`<div>${formatDate(this.state.date)}</div>`))
 */
export function opt(templateFn) {
    const source = templateFn.toString();
    const converted = convertArrowToFunction(source);
    const mangled = mangleTemplateSource(converted);

    // Return string for user to eval in their module scope
    return '(' + mangled + ')';
}

/**
 * Convert arrow functions to regular functions for proper `this` binding.
 * Arrow functions lexically bind `this`, which breaks component context.
 *
 * Handles:
 *   () => { body }     ->  function() { body }
 *   () => expr         ->  function() { return expr; }
 *
 * @param {string} source - Function source code
 * @returns {string} Converted source with regular function syntax
 */
function convertArrowToFunction(source) {
    const trimmed = source.trim();

    // () => { body }  ->  function() { body }
    if (/^\(\s*\)\s*=>\s*\{/.test(trimmed)) {
        return trimmed.replace(/^\(\s*\)\s*=>\s*\{/, 'function() {');
    }

    // () => expr  ->  function() { return expr; }
    if (/^\(\s*\)\s*=>\s*/.test(trimmed)) {
        const expr = trimmed.replace(/^\(\s*\)\s*=>\s*/, '');
        return 'function() { return ' + expr + '; }';
    }

    return source;  // Already a regular function
}

/**
 * Extract all ${...} expressions from html`` template literals only.
 * Skips expressions in regular template literals like `step-${n}`.
 *
 * Properly handles:
 *   - Nested braces: ${items.map(x => x.name)}
 *   - Nested templates: ${items.map(x => `${x.name}`)}
 *   - Object literals: ${{ a: 1 }}
 *   - String literals: ${msg || "default"}
 *
 * @param {string} source - Template source code
 * @returns {Array<{start: number, end: number, expr: string}>} Expression locations
 */
function extractExpressions(source, debug = false) {
    const expressions = [];
    let i = 0;

    // Find all html`` templates and extract expressions only from those
    while (i < source.length) {
        // Look for html` (the start of an html tagged template). The
        // preceding character must not be an identifier character, or any
        // tag ending in "html" (myhtml`...`) would be treated as ours and
        // have its expressions wrapped.
        if (source.slice(i, i + 4) === 'html' && source[i + 4] === '`' &&
            (i === 0 || !/[A-Za-z0-9_$.]/.test(source[i - 1]))) {
            i += 5;  // Skip past 'html`'

            // Now we're inside an html template - find expressions until closing `
            // But we need to handle nested templates within expressions
            let templateDepth = 1;  // We're already inside one html template
            let inString = false;
            let stringChar = null;

            while (i < source.length && templateDepth > 0) {
                const ch = source[i];
                const prev = i > 0 ? source[i - 1] : '';

                // Handle escape sequences
                if (prev === '\\' && !isEscaped(source, i - 1)) {
                    i++;
                    continue;
                }

                // Handle strings in expressions (not inside template literal text)
                if (templateDepth === 1 && !inString && (ch === '"' || ch === "'")) {
                    // Only track strings when we're at expression level, not template text
                    // Actually, we're inside the template text here, not expressions
                    // Skip this
                }

                // Handle closing backtick - end of template
                if (ch === '`' && !inString) {
                    templateDepth--;
                    if (templateDepth === 0) {
                        i++;
                        break;
                    }
                    i++;
                    continue;
                }

                // Handle ${ - start of expression
                if (ch === '$' && source[i + 1] === '{' && !inString) {
                    const start = i;
                    i += 2;

                    // Parse the expression, handling nesting
                    const expr = parseExpression(source, i);
                    i = expr.end;

                    if (debug) {
                        console.log(`Expression: start=${start}, end=${i}, expr="${expr.text.slice(0, 60)}..."`);
                    }

                    expressions.push({
                        start,
                        end: i,
                        expr: expr.text
                    });
                    continue;
                }

                i++;
            }
        } else {
            i++;
        }
    }

    return expressions;
}

/**
 * Parse a single expression starting at position i (after the ${).
 * Returns the expression text and end position (after the closing }).
 */
function parseExpression(source, startPos) {
    let i = startPos;
    let depth = 1;  // We're inside ${ so depth starts at 1
    let inString = false;
    let stringChar = null;
    let inTemplate = false;  // Track if we're inside a nested template literal

    while (i < source.length && depth > 0) {
        const ch = source[i];
        const prev = i > 0 ? source[i - 1] : '';

        // Handle escape sequences
        if (prev === '\\' && !isEscaped(source, i - 1)) {
            i++;
            continue;
        }

        // Handle comments (only when not in string or template)
        if (!inString && !inTemplate) {
            // Single-line comment
            if (ch === '/' && source[i + 1] === '/') {
                while (i < source.length && source[i] !== '\n') {
                    i++;
                }
                continue;
            }
            // Multi-line comment
            if (ch === '/' && source[i + 1] === '*') {
                i += 2;
                while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) {
                    i++;
                }
                i += 2;
                continue;
            }
        }

        // Handle strings
        if (!inString && !inTemplate && (ch === '"' || ch === "'")) {
            inString = true;
            stringChar = ch;
            i++;
            continue;
        }
        if (inString && ch === stringChar && !isEscaped(source, i)) {
            inString = false;
            stringChar = null;
            i++;
            continue;
        }
        if (inString) {
            i++;
            continue;
        }

        // Handle nested template literals (not html``, just regular ``)
        if (ch === '`' && !inTemplate) {
            inTemplate = true;
            i++;
            continue;
        }
        if (ch === '`' && inTemplate) {
            inTemplate = false;
            i++;
            continue;
        }

        // Handle ${ inside nested template - need to parse recursively
        if (inTemplate && ch === '$' && source[i + 1] === '{') {
            i += 2;
            const nested = parseExpression(source, i);
            i = nested.end;
            continue;
        }

        // Handle braces (when not in template)
        if (!inTemplate && ch === '{') {
            depth++;
            i++;
            continue;
        }
        if (!inTemplate && ch === '}') {
            depth--;
            if (depth === 0) {
                // Found the closing brace
                const text = source.slice(startPos, i);
                return { text, end: i + 1 };
            }
            i++;
            continue;
        }

        i++;
    }

    // If we get here, the expression wasn't properly closed
    const text = source.slice(startPos, i);
    return { text, end: i };
}

// Add a debug version we can call from browser
export function extractExpressionsDebug(source) {
    return extractExpressions(source, true);
}

/**
 * Check if character at position is escaped (odd number of preceding backslashes)
 */
function isEscaped(source, pos) {
    let count = 0;
    let p = pos - 1;
    while (p >= 0 && source[p] === '\\') {
        count++;
        p--;
    }
    return count % 2 === 1;
}

/**
 * Determine if an expression should be skipped (not wrapped in html.contain).
 *
 * Skip:
 *   - contain(...) - already isolated
 *   - raw(...) - no reactivity needed
 *   - Arrow functions - already functions
 *   - Function expressions - already functions
 *   - html.contain(...) - already wrapped
 *
 * @param {string} expr - The expression to check
 * @returns {boolean} True if should skip wrapping
 */
function shouldSkipWrapping(expr) {
    const trimmed = expr.trim();

    // Skip already-isolated helpers and special vnodes
    // - contain/raw: already isolated
    // - memoEach: has its own caching mechanism, complex to wrap in contain
    // - when/each: condition/array is evaluated before callback runs, captured vars won't update
    if (/^(contain|raw|html\.contain|memoEach|when|each)\s*\(/.test(trimmed)) {
        return true;
    }

    // Skip expressions containing raw() anywhere - raw() returns a special vnode
    // marker that must be placed directly in the template, not wrapped
    if (/\braw\s*\(/.test(trimmed)) {
        return true;
    }

    // Skip arrow functions: () => ..., x => ..., (a, b) => ...
    if (/^\([^)]*\)\s*=>/.test(trimmed) || /^\w+\s*=>/.test(trimmed)) {
        return true;
    }

    // Skip function expressions
    if (/^function\s*[\w]*\s*\(/.test(trimmed)) {
        return true;
    }

    // Skip async arrow functions
    if (/^async\s+\([^)]*\)\s*=>/.test(trimmed) || /^async\s+\w+\s*=>/.test(trimmed)) {
        return true;
    }

    // Skip async function expressions
    if (/^async\s+function\s*[\w]*\s*\(/.test(trimmed)) {
        return true;
    }

    // Skip slot/children access - these are already DOM nodes/vnodes
    // and don't need reactive wrapping
    // Matches: this.props.children, this.props.slots.*, this.props.slots['name'], etc.
    if (/^this\.props\.(children|slots)\b/.test(trimmed)) {
        return true;
    }

    return false;
}

/**
 * Mangle template source by wrapping expressions in html.contain().
 * Processes from end to start so indices don't shift.
 *
 * @param {string} source - Function source code
 * @returns {string} Mangled source with wrapped expressions
 */
function mangleTemplateSource(source) {
    const expressions = extractExpressions(source);

    // Build new source, replacing expressions from end to start
    // (so indices don't shift)
    let result = source;
    for (let i = expressions.length - 1; i >= 0; i--) {
        const { start, end, expr } = expressions[i];

        // Check if should skip wrapping
        if (shouldSkipWrapping(expr)) {
            continue;
        }

        // Replace ${expr} with ${html.contain(() => (expr))}
        const wrapped = '${html.contain(() => (' + expr + '))}';
        result = result.slice(0, start) + wrapped + result.slice(end);
    }

    return result;
}

// Export helpers for testing
export { convertArrowToFunction, extractExpressions, shouldSkipWrapping, mangleTemplateSource };
