import { Drop } from "https://esm.sh/v107/liquidjs@10.6.0";

export function reversed<T> (arr: Array<T>) {
  return [...arr].reverse()
}

export function offset<T> (arr: Array<T>, count: number) {
  return arr.slice(count)
}

export function limit<T> (arr: Array<T>, count: number) {
  return arr.slice(0, count)
}

export function toEnumerable<T = unknown> (val: any): T[] {
    val = toValue(val)
    if (isArray(val)) return val
    if (isString(val) && val.length > 0) return [val] as unknown as T[]
    if (isIterable(val)) return Array.from(val)
    if (isObject(val)) return Object.keys(val).map((key) => [key, val[key]]) as unknown as T[]
    return []
}

export function isString (value: any): value is string {
    return typeof value === 'string'
}

export function isArray (value: any): value is any[] {
    // be compatible with IE 8
    return toString.call(value) === '[object Array]'
}

export function isIterable (value: any): value is Iterable<any> {
    return isObject(value) && Symbol.iterator in value
}

export function isNil (value: any): boolean {
    return value == null
}

/*
 * Checks if value is the language type of Object.
 * (e.g. arrays, functions, objects, regexes, new Number(0), and new String(''))
 * @param {any} value The value to check.
 * @return {Boolean} Returns true if value is an object, else false.
 */
export function isObject (value: any): value is object {
    const type = typeof value
    return value !== null && (type === 'object' || type === 'function')
}

export const toString = Object.prototype.toString

export function toValue (value: any): any {
    return (value instanceof Drop && isFunction(value.valueOf)) ? value.valueOf() : value
}

// eslint-disable-next-line @typescript-eslint/ban-types
export function isFunction (value: any): value is Function {
    return typeof value === 'function'
}

export function stringify (value: any): string {
    value = toValue(value)
    if (isString(value)) return value
    if (isNil(value)) return ''
    if (isArray(value)) return value.map(x => stringify(x)).join('')
    return String(value)
}
