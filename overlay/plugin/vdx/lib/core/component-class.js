/**
 * Class-Based Component Authoring
 *
 * Lets defineComponent accept an ES class instead of an options object:
 *
 *   export class TodoList extends Component {
 *       static props = { title: '' };
 *       state = { items: [] };            // or assign in constructor(props)
 *       get remaining() { ... }           // getters become computed properties
 *       addItem() { ... }                 // methods are auto-bound
 *       template() { return html`...`; }
 *   }
 *   export default defineComponent('todo-list', TodoList);
 *
 * The class is an AUTHORING SURFACE, not a runtime object: classToOptions()
 * dismantles it into the classic options format, and at runtime `this` is the
 * custom element itself (exactly as with options components). The mapping:
 *
 *   static props / stores / styles  -> options.props / stores / styles
 *                                      (merged parent-first across the chain,
 *                                      so subclasses extend rather than replace)
 *   prototype methods               -> options.methods (auto-bound to element)
 *   prototype getters               -> options.computed (lazy, cached).
 *                                      Getters must be pure derivations of
 *                                      state/stores/props. A getter that
 *                                      tracks NO reactive dependency and
 *                                      never touches props is detected at
 *                                      mount and re-evaluated on every read
 *                                      instead (it could never invalidate)
 *   template/mounted/unmounted/...  -> the matching lifecycle option
 *   constructor(props)              -> plays the role of data(): it runs with
 *                                      `this` bound to the element (see below)
 *
 * Constructor timing contract (differs from options data() deliberately):
 * the constructor runs at FIRST CONNECT, after attributes are parsed and
 * light-DOM children are captured, so `props` holds real values and can be
 * copied into state - React-style. It runs once per element; disconnect/
 * reconnect (e.g. drag-reorder moves) does not re-run it.
 *
 * How `this` becomes the element: the Component base constructor uses the ES
 * "constructor return override" rule - when a base constructor returns an
 * object, that object becomes `this` for the entire derived constructor
 * chain, including class field initializers. constructInstance() points the
 * base at the element, so `this.state = {...}`, class fields, and arrow-
 * function fields all land directly on the element (arrow handlers close
 * over the element, not a throwaway instance).
 */

// The element currently being constructed via constructInstance().
// Module-level because the base constructor has no other channel to it.
let constructionTarget = null;

/**
 * Base class for class-authored components.
 *
 * Carries no runtime behavior of its own - it exists so classToOptions can
 * recognize component classes (instanceof check) and so the constructor can
 * redirect `this` to the custom element. It deliberately does NOT extend
 * HTMLElement (constructing an unregistered HTMLElement subclass throws
 * "Illegal constructor"); the type declarations present it as extending
 * HTMLElement because at runtime `this` really is the element.
 */
export class Component {
    constructor() {
        if (!constructionTarget) {
            throw new Error(
                'Component classes cannot be instantiated directly. Register the class with ' +
                "defineComponent('tag-name', MyComponent) and create elements via the DOM."
            );
        }
        const target = constructionTarget;
        // Consume the target so stray construction inside the user's
        // constructor body cannot hijack the same element
        constructionTarget = null;
        return target;
    }
}

/**
 * Run a component class constructor with `this` bound to the element.
 * Called by the component system at first connect.
 * @param {HTMLElement} element - The custom element instance
 * @param {Function} UserClass - The user's class (extends Component)
 */
export function constructInstance(element, UserClass) {
    // Save/restore instead of assuming null: the user constructor may attach
    // child class components to the (already connected) element, which
    // construct synchronously via a nested constructInstance call
    const previous = constructionTarget;
    constructionTarget = element;
    try {
        new UserClass(element.props);
    } finally {
        constructionTarget = previous;
    }
}

// Prototype methods with these names map to the same-named lifecycle option
const LIFECYCLE_HOOKS = new Set([
    'template', 'mounted', 'unmounted', 'afterRender', 'propsChanged', 'renderError'
]);

/**
 * Translate a component class into the options format understood by the
 * rest of the component system.
 * @param {Function} UserClass - Class extending Component
 * @returns {Object} Component options (with `_class` set for deferred construction)
 */
export function classToOptions(UserClass) {
    if (typeof UserClass !== 'function' || !(UserClass.prototype instanceof Component)) {
        throw new Error(
            '[defineComponent] Class components must extend Component (imported from the framework)'
        );
    }

    // Build the inheritance chain root-first (Component itself excluded) so
    // that child members processed later override parent members
    const chain = [];
    for (let C = UserClass; C && C !== Component; C = Object.getPrototypeOf(C)) {
        chain.unshift(C);
    }

    const options = { _class: UserClass };
    const methods = {};
    const computed = {};

    for (const C of chain) {
        // Statics: own-property checks per class so a subclass redefining
        // `static props` extends the parent's rather than hiding it
        if (Object.prototype.hasOwnProperty.call(C, 'props')) {
            options.props = Object.assign({}, options.props, C.props);
        }
        if (Object.prototype.hasOwnProperty.call(C, 'stores')) {
            options.stores = Object.assign({}, options.stores, C.stores);
        }
        if (Object.prototype.hasOwnProperty.call(C, 'styles') && C.styles) {
            options.styles = options.styles ? options.styles + '\n' + C.styles : C.styles;
        }

        for (const key of Object.getOwnPropertyNames(C.prototype)) {
            if (key === 'constructor') continue;
            const desc = Object.getOwnPropertyDescriptor(C.prototype, key);

            if (desc.get) {
                if (desc.set) {
                    console.warn(
                        `[${UserClass.name}] Setter for "${key}" is ignored - computed properties are read-only`
                    );
                }
                computed[key] = desc.get;
                delete methods[key]; // child getter overrides parent method
                continue;
            }

            if (typeof desc.value !== 'function') continue;

            if (key === 'data') {
                // Unlike options components, data() has no framework meaning
                // here - it stays callable as a plain method, but warn in case
                // this is a port from the options API expecting it to auto-run
                console.warn(
                    `[${UserClass.name}] data() is not a lifecycle hook on class components - ` +
                    'it is kept as a plain method; initialize this.state in the constructor or as a class field'
                );
            }
            if (LIFECYCLE_HOOKS.has(key)) {
                options[key] = desc.value;
                continue;
            }
            methods[key] = desc.value;
            delete computed[key]; // child method overrides parent getter
        }
    }

    if (Object.keys(methods).length > 0) options.methods = methods;
    if (Object.keys(computed).length > 0) options.computed = computed;

    return options;
}
