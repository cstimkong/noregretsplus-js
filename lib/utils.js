
/**
 * Get type of a contravariant path.
 */
function getType(obj) {
    let type = '';
    if (obj === null) {   
        type = 'null';
    } else if (obj === undefined) {
        type = 'undefined';
    } else if (typeof obj === 'string') {
        type = 'string';
    } else if (typeof obj === 'number') {
        type = 'number';
    } else if (Array.isArray(obj)) {
        type = 'array';
    } else if (obj === true || obj === false) {
        type = 'boolean';
    } else if (obj instanceof Set) {
        type = 'set';
    } else if (obj instanceof Map) {
        type = 'map';
    } else if (obj instanceof Error) {
        return 'error';
    }
    else if (typeof obj === 'object') {
        type = 'object';
    } else if (typeof obj === 'function') {
        type = 'function';
    }
    return type;
}

/**
 * Get type of a covariant path.
 */
function getArgumentType(arg) {
    if (arg === null) {
        return 'null';
    }
    if (arg === undefined) {
        return 'undefined';
    }
    if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') {
        return {primType: typeof arg, value: arg};
    }
    if (arg instanceof Array || Array.isArray(arg)) {
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
    } else if (typeof arg === 'function') {
        return 'function';
    }
    console.log(typeof arg);
    return typeof arg;
}

/**
 * Determine covariance.
 */
function isCovariant(path) {
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
function makeRandomString(length) {
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


export default {getType, getArgumentType, isCovariant, makeRandomString};