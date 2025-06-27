import * as utils from './utils.ts';

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



