import * as utils from './utils.ts';
import * as strings from './strings.ts';

export const serialized: unique symbol = Symbol('serialized');
export const serialize: unique symbol = Symbol('serialize');

export interface Serializable {
    // Objects can have a static serialized form.  This is primarily used for
    // objects that serialized by identity.
    [serialized]?: string,

    // Object can also implement a serialize method.
    [serialize]?(): string;
}

// Assigns the static serialized form for an object.
export function setSerialized<T extends Object>(obj:T, serializedValue: string): T {
    (obj as Serializable)[serialized] = serializedValue;
    return obj;
}

export function isSerializableObject(v: any): boolean {
    return !!v[serialized] || !!v[serialize];
}





// TODO Write somehthing to setSerialized on all queryclosure etc fields in a Object that
//      iteself is serailziable.
//





export function serializeAs<T extends Object>(serializedValue: string, obj:T): T {
    (obj as Serializable)[serialized] = serializedValue;
    return obj;
}

// export function serializeAsIncludingFields<T extends Object>(serializedValue: string, obj:T): T {
//     (obj as Serializable)[serialized] = serializedValue;
//     for(const [fieldName, fieldValue] in Object.entries(obj)) {
//         if(isSerializableObject(fieldValue))
//             serializeAs(
//     }
//     return obj;
// }

export function serializeAny(a: any): string {
    if(utils.isClassInstance(a)) {
        const v = a as Serializable;

        const serializedValue = v[serialized];
        if(serializedValue)
            return serializedValue;

        const serializeFn = v[serialize];
        if(serializeFn)
            return serializeFn.apply(v);

        throw new Error(`Serialization not implemented for ${utils.className(a)}`);
    } else {
        return JSON.stringify(a);
    }
}





const propValues = new WeakMap<object, Map<string | symbol, any>>();

export function path<T>(target: Function, context: ClassGetterDecoratorContext): any {
    const propertyKey = context.name;

    return function (this: any) {
        
        let objectCache = propValues.get(this);
        if (!objectCache) {
            objectCache = new Map();
            propValues.set(this, objectCache);
        }

        const existingProp = objectCache.get(propertyKey);
        if(existingProp !== undefined || objectCache.has(propertyKey))
            return existingProp;
        
        const prop = target.call(this);

        
        const serialized = `${serializeAny(this)}.${strings.stripRequiredPrefix(target.name, 'get ')}`;
        serializeAs(serialized, prop);
        
        objectCache.set(propertyKey, prop);
        return prop;
    };
}
