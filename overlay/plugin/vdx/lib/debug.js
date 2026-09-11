/**
 * Debug utilities for tracking reactivity, component tree, and vnodes
 */

/**
 * Serialize a value for logging (handles circular refs, proxies, etc.)
 */
export function serialize(value, depth = 0, maxDepth = 3, seen = new WeakSet()) {
    if (depth > maxDepth) return '[Max Depth]';

    // Primitives
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (typeof value === 'symbol') return String(value);

    // DOM elements
    if (value instanceof Element) {
        const tag = value.tagName.toLowerCase();
        const classes = value.className ? `.${value.className.split(' ').join('.')}` : '';
        const id = value.id ? `#${value.id}` : '';
        return `<${tag}${id}${classes}>`;
    }

    // Circular reference check
    if (typeof value === 'object' && seen.has(value)) {
        return '[Circular]';
    }

    // Mark as seen
    if (typeof value === 'object') {
        seen.add(value);
    }

    // Check if it's a Proxy (unwrap it)
    const isProxy = value !== null && typeof value === 'object' &&
                    value.constructor && value.constructor.name === 'Object';

    // Arrays
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        if (depth >= maxDepth - 1) return `[Array(${value.length})]`;
        const items = value.slice(0, 5).map(v => serialize(v, depth + 1, maxDepth, seen));
        const suffix = value.length > 5 ? `, ... +${value.length - 5} more` : '';
        return `[${items.join(', ')}${suffix}]`;
    }

    // Objects
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) return '{}';
        if (depth >= maxDepth - 1) return `{${keys.length} keys}`;

        const pairs = keys.slice(0, 5).map(k => {
            const v = value[k];
            return `${k}: ${serialize(v, depth + 1, maxDepth, seen)}`;
        });
        const suffix = keys.length > 5 ? `, ... +${keys.length - 5} more` : '';
        return `{ ${pairs.join(', ')}${suffix} }`;
    }

    return String(value);
}

/**
 * Pretty print a vnode structure
 */
export function vnodeToString(vnode, indent = 0) {
    if (!vnode) return 'null';
    if (typeof vnode === 'string' || typeof vnode === 'number') {
        return `${'  '.repeat(indent)}"${vnode}"`;
    }
    if (Array.isArray(vnode)) {
        return vnode.map(v => vnodeToString(v, indent)).join('\n');
    }

    const indentStr = '  '.repeat(indent);
    const { type, props } = vnode;

    if (!type) return `${indentStr}[Invalid VNode]`;

    const typeName = typeof type === 'string' ? type :
                     typeof type === 'function' ? type.name || 'Component' :
                     'Unknown';

    // Filter out children from props for display
    const { children, ...otherProps } = props || {};
    const propsStr = Object.keys(otherProps).length > 0
        ? ' ' + Object.entries(otherProps)
            .filter(([k]) => !k.startsWith('on') && k !== 'dangerouslySetInnerHTML')
            .map(([k, v]) => `${k}=${serialize(v, 0, 1)}`)
            .join(' ')
        : '';

    const hasChildren = children && (Array.isArray(children) ? children.length > 0 : true);

    if (!hasChildren) {
        return `${indentStr}<${typeName}${propsStr} />`;
    }

    const childrenArray = Array.isArray(children) ? children : [children];
    const childrenStr = childrenArray
        .filter(c => c !== null && c !== undefined && c !== false)
        .map(c => vnodeToString(c, indent + 1))
        .join('\n');

    return `${indentStr}<${typeName}${propsStr}>\n${childrenStr}\n${indentStr}</${typeName}>`;
}

/**
 * Log with timestamp and category
 */
export function debugLog(category, message, data = null) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    const prefix = `[${timestamp}] [${category}]`;

    if (data === null) {
        console.log(prefix, message);
    } else {
        console.log(prefix, message, serialize(data));
    }
}

/**
 * Create a debug logger for a specific category
 */
export function createLogger(category) {
    return {
        log: (message, data) => debugLog(category, message, data),
        trace: (message) => debugLog(category, `📍 ${message}`),
        warn: (message, data) => console.warn(`[${category}]`, message, data ? serialize(data) : ''),
        error: (message, data) => console.error(`[${category}]`, message, data ? serialize(data) : '')
    };
}

/**
 * Track component render cycle
 */
export function logRenderCycle(component, phase, data = null) {
    const tag = component.tagName || component.constructor.name;
    const phases = {
        'before-template': '🔵',
        'after-template': '🟢',
        'before-vnode': '🟡',
        'after-vnode': '🟠',
        'state-change': '🔴'
    };
    const icon = phases[phase] || '⚪';
    debugLog('Render', `${icon} ${tag} - ${phase}`, data);
}

/**
 * Track reactivity changes
 */
export function logReactivity(target, property, value, operation = 'set') {
    const targetName = target.constructor?.name || 'Object';
    debugLog('Reactivity', `${operation.toUpperCase()} ${targetName}.${String(property)}`, value);
}

/**
 * Pretty print component state
 */
export function dumpComponentState(component) {
    const tag = component.tagName || 'Unknown';
    console.group(`📦 Component State: ${tag}`);
    console.log('Props:', serialize(component.props, 0, 2));
    console.log('State:', serialize(component.state, 0, 2));
    console.log('Mounted:', component._isMounted);
    console.log('Destroyed:', component._isDestroyed);
    console.groupEnd();
}

/**
 * Compare two vnodes and highlight differences
 */
export function diffVNodes(oldVNode, newVNode) {
    console.group('🔍 VNode Diff');
    console.log('Old:', vnodeToString(oldVNode));
    console.log('New:', vnodeToString(newVNode));
    console.groupEnd();
}
