import type { Path, PathType } from './types.js';

/**
 * Get type of a contravariant path.
 */
function getType(obj: any): PathType {
    let type = '';
    if (obj === null) {
        return 'null';
    } else if (obj === undefined) {
        return 'undefined';
    } else if (typeof obj === 'string') {
        return 'string';
    } else if (typeof obj === 'number') {
        return 'number';
    } else if (Array.isArray(obj)) {
        return 'array';
    } else if (obj === true || obj === false) {
        return 'boolean';
    } else if (obj instanceof Set) {
        return 'set';
    } else if (obj instanceof Map) {
        return 'map';
    } else if (obj instanceof Error) {
        return 'error';
    } else if (typeof obj === 'object') {
        return 'object';
    } else if (typeof obj === 'function') {
        return 'function';
    }
    throw new Error('Unknown type');
}

/**
 * Get type of a covariant path.
 */
function getArgumentType(arg: any): PathType {
    if (arg === null) {
        return 'null';
    }
    else if (arg === undefined) {
        return 'undefined';
    }
    else if (typeof arg === 'string') {
        return { primType: 'string', value: arg };
    }
    else if (typeof arg === 'number') {
        return { primType: 'number', value: arg }
    }
    else if (typeof arg === 'boolean') {
        return { primType: 'boolean', value: arg };
    }
    else if (arg instanceof Array || Array.isArray(arg)) {
        return 'array';
    }
    if (arg instanceof Error) {
        return 'error';
    }
    if (arg instanceof Map) {
        return 'map';
    }
    if (arg instanceof Set) {
        return 'set';
    }
    if (Array.isArray(arg)) {
        return 'array';
    }
    if (typeof arg === 'object') {
        return 'object';
    }
    else if (typeof arg === 'function') {
        return 'function';
    }

    throw new Error('Unknown type');
}

/**
 * Determine covariance.
 */
function isCovariant(path: Path) {
    let arrowCount = 0;
    for (let pathComp of path) {
        if (pathComp.compType === 'arg' || pathComp.compType === 'writeProp') {
            arrowCount += 1;
        }
    }
    return arrowCount % 2 === 0;
}

/**
 * Make a random string identifier (usually for function calls)
 */
function makeRandomString(length: number) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    let counter = 0;
    while (counter < length) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
        counter += 1;
    }
    return result;
}


export { getType, getArgumentType, isCovariant, makeRandomString };