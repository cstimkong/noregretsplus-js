
import process from 'process';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'node:fs';
import deepEqual from 'deep-equal';
import { getType, getArgumentType, isCovariant } from './utils.js';
import pretty from 'pino-pretty';
import pino from 'pino';
import type { Model, Path, PathType, Node, PathComp } from './types.js';
import assert from 'node:assert';

interface TraverseNode extends Node {
    processed?: boolean,
    obj?: any,
    ap?: Path,
    empty?: boolean
};

const logger = pino(pretty({sync: true}));

let argv: any = yargs().usage('Type regression testing based on a given model')
.option('library', {
    alias: 'l',
    type: 'string',
    description: 'Library name or path (override the library specified in the model)'
}).option('model', {
    alias: 'm',
    type: 'string',
    description: 'Model path'
})
.option('output', {
    alias: 'o',
    type: 'string',
    description: 'Output location of the detection results'
})
.demandOption(['model'])
.help().parse(hideBin(process.argv));

let modelPath = argv.model;

function getChild(currentNode: TraverseNode, c: PathComp): Node | null {
    if (c.compType === 'arg' && currentNode.argChildren && currentNode.argChildren[c.callId]) {
        if (currentNode.argChildren[c.callId]![c.argId]) {
            return currentNode.argChildren[c.callId]![c.argId]!;
        }
        return null;
    }

    else if (c.compType === 'accessProp' && currentNode.accessPropChildren && currentNode.accessPropChildren[c.propName]) {
        return currentNode.accessPropChildren[c.propName]!;
    }

    else if (c.compType === 'call' && currentNode.callChildren && currentNode.callChildren[c.callId]) {
        return currentNode.callChildren[c.callId]!;
    }

    else if (c.compType === 'new' && currentNode.newChildren && currentNode.newChildren[c.callId]) {
        return currentNode.newChildren[c.callId]!;
    }

    else if (c.compType == 'writeProp' && currentNode.writePropChildren && currentNode.writePropChildren[c.propName]) {
        return currentNode.writePropChildren[c.propName]!;
    }
    
    else if (c.compType === 'require' && currentNode.requireChildren && currentNode.requireChildren[c.moduleName]) {
        return currentNode.requireChildren[c.moduleName]!;
    }

    return null;
}

function getChildren(currentNode: TraverseNode): TraverseNode[] {
    return Object.values(currentNode.accessPropChildren!).concat(
        Object.values(currentNode.writePropChildren!),
        Object.values(currentNode.callChildren!),
        Object.values(currentNode.newChildren!),
        Object.values(currentNode.argChildren!).map(x => Object.values(x)).flatMap(x => x),
        Object.values(currentNode.requireChildren!)
    )
}
/**
 * Construct a model tree from the generated model.
 */
function constructModelTree(modelContent: Model) {
    let paths = modelContent.paths;
    let root: TraverseNode = {
        argChildren: {},
        callChildren: {},
        newChildren: {},
        accessPropChildren: {},
        writePropChildren: {},
        parent: null
    };
    for (let {path, type} of paths) {
        let current = root;
        let accumulatedPath: Path = [];
        path.forEach((comp, idx) => {
            accumulatedPath = accumulatedPath.concat([comp]);
            let c = getChild(current, comp);
            if (c !== null) {
                current = c;
            } else {
                let newItem: TraverseNode = {p: comp, ap: accumulatedPath, 
                    argChildren: {}, 
                    requireChildren: {},
                    callChildren: {},
                    newChildren: {},
                    accessPropChildren: {},
                    writePropChildren: {},
                    parent: current
                };
                if (idx === path.length - 1) {
                    newItem.type = type;
                    newItem.order = idx;
                }
                if (comp.compType == 'accessProp') {
                    current.accessPropChildren![comp.propName!] = newItem;
                }
                else if (comp.compType === 'writeProp') {
                    current.writePropChildren![comp.propName] = newItem;
                }
                else if (comp.compType === 'call') {
                    current.callChildren![comp.callId] = newItem;
                }
                else if (comp.compType == 'arg') {
                    current.argChildren![comp.callId] = current.argChildren![comp.callId] || {};
                    current.argChildren![comp.callId]![comp.argId] = newItem;
                }
                else if (comp.compType === 'new') {
                    current.callChildren![comp.callId] = newItem;
                }
                else if (comp.compType === 'require') {
                    current.requireChildren![comp.moduleName] = newItem;
                }
                current = newItem;
            }
        });
    }

    let nodeRelations = [];
    for (let [s, t] of modelContent.rhoRelations) {
        let current = root;
        for (let pathComp of s) {
            let c = getChild(current, pathComp);
            if (!c) {
                throw new Error('Incorrect path.')
            }
            current = c;
        }
        let node1 = current;

        current = root;
        for (let pathComp of t) {
            let c = getChild(current, pathComp);
            if (!c) {
                throw new Error('Incorrect path.');
            }
            current = c;
        }
        let node2 = current;
        nodeRelations.push([node1, node2]);

    }

    return [root, nodeRelations];
}

/**
 * Proxify the synthesized object for an argument node
 */
function getProxy(node: TraverseNode, obj: any) {
    return new Proxy(obj, {
        get: function(target, p, receiver) {
            if (node.accessPropChildren![p as string]) {
                if (!(node.accessPropChildren![p as string] as TraverseNode).processed) {
                    (node.accessPropChildren![p as string] as TraverseNode).obj = synthesizeValue(node.accessPropChildren![p as string] as TraverseNode);
                    (node.accessPropChildren![p as string] as TraverseNode).processed = true;
                }
                return (node.accessPropChildren![p as string] as TraverseNode).obj;
            }

            logger.warn({breakingPath: node.ap!.concat([{compType: 'accessProp', propName: p as string}]), additionalProp: p})
            return null;
        },
        apply: function(target, thisArg, argArray) {
            // If the proxy wraps a function, make the function execute normally
            return target.apply(thisArg, argArray);
        }
    })
}

/**
 * Synthesize value for an argument node.
 */
function synthesizeValue(node: TraverseNode) {
    if (node.type === 'undefined') {
        return undefined;
    }
    else if (node.type === 'null') {
        return null;
    }
    else if (node.type === 'object' || node.type === 'array' || node.type === 'set' || node.type === 'map' || node.type === 'boolean' || node.type === 'number' || node.type === 'string') {
        return getProxy(node, {});
    }
    else if (node.type === 'function') {

        return getProxy(node, function() {
            for (let callId in node.callChildren) {

                if (!(node.callChildren[callId]! as TraverseNode).processed) {
                    (node.callChildren[callId]! as TraverseNode).obj = synthesizeValue(node.callChildren[callId] as TraverseNode);
                    (node.callChildren[callId]! as TraverseNode).processed = true;
                }
                let argTypes: any = {};
                if (node.argChildren && node.argChildren![callId]) {
                    for (let argId in node.argChildren![callId]!) {
                        
                        argTypes[argId] = node.argChildren![callId]![argId]!.type;
                    }
                }
                
                argTypes.length = Object.keys(argTypes).length;
                argTypes = Array.prototype.slice.call(argTypes);
                let realArgumentTypes: PathType[] = [];
                for (let i = 0; i < arguments.length; i++) {
                    realArgumentTypes.push(isCovariant((node.callChildren[callId]! as TraverseNode).ap!) ? getArgumentType(arguments[i]) : getType(arguments[i]));
                } 

                if (checkAllCompatible(realArgumentTypes, argTypes)) {
                    return (node.callChildren[callId]! as TraverseNode).obj;
                }
                    
            }
            logger.warn({breakingPath: node.ap!.concat([{compType: 'call', callId: 'unknown'}])});
            return 0;
        });

    }
    else if (typeof node.type === 'object' && node.type!.primType) {
        if (node.type.primType === 'number' && node.type!.value === 'Infinity') {
            return Number.POSITIVE_INFINITY;
        }
        if (node.type.primType === 'number' && node.type!.value === 'NaN') {
            return Number.NaN;
        }
        return node.type.value;
    }

    throw new Error('Cannot synthesize the value, type: ' + node.type);
}

/**
 * Check whether the first type is a subtype of the second type
 */
function checkCompatible(type1: PathType, type2: PathType) {
    if (type2 === 'null') {
        return true;
    }
    if (type2 === 'object') {
        if (type1 === 'object' || type1 === 'function' || type1 === 'map' || type1 === 'set') {
            return true;
        }
    }
    if (type2 === type1) {
        return true;
    }
    if (deepEqual(type2, type1)) {
        return true;
    }
    return false;
}

function checkAllCompatible(types1: PathType[], types2: PathType[]) {
    assert(types1.length === types2.length);
    types1.forEach((t1, idx) => {
        if (!checkCompatible(t1, types2[idx]!)) {
            return false;
        }
    });
    return true;
}

function findNextNode(currentNode: TraverseNode) {
    let minNode = undefined;
    for (let c of getChildren(currentNode)) {
        if (!c.processed) {
            if (!minNode) {
                minNode = c;
            } else {
                minNode = c.order! < minNode.order ? c : minNode;
            }
        } else {
            let m = findNextNode(c);
            if (!m) {
                continue;
            }
            if (minNode !== undefined && m.order < minNode.order) {
                minNode = m;
            }
        }
    }
    return minNode;
}

function traverseTree(node: TraverseNode, rhoRelations: Node[][]) {
    logger.info('Processing node path: ' + JSON.stringify(node.ap));

    if (!node.parent) {
        for (let c of getChildren(node)) {
            traverseTree(c, rhoRelations);
        }
        return;
    }

   else if (node.p!.compType === 'require') {
        if (!node.processed) {
            let o = require(node.p!.moduleName);
            if (!checkCompatible(getType(o), node.type!)) {
                logger.warn({breakingPath: node.ap});
            }
            node.obj = o;
            node.processed = true;
        }
    }

    else if (node.p!.compType === 'accessProp') {
        if (!node.processed) {
            if (!node.parent.empty) {
                if (node.parent.obj !== undefined) {
                    let o = node.parent.obj[node.p.propName];
                    let covariant = isCovariant(node.ap);
                    let type = covariant ? getType(o) : getArgumentType(o);
                    if (covariant && !checkCompatible(type, node.type)) {
                        logger.warn({breakingPath: node.ap, incompatibleTypes: {actual: type, required: node.type}});
                    }
                    node.obj = o;
                } else {
                    logger.warn({breakingPath: node.ap, reason: "get property of undefined"});
                    node.empty = true;
                }
            } else {
                node.empty = true;
            }
            node.processed = true;
        }
    }

    else if (node.p.compType === 'writeProp') {
        if (!node.processed) {
            if (!node.parent.empty) {
                if (node.parent.obj !== undefined) {
                    node.parent.obj[node.p.propName] = synthesizeValue(node);
                } else {
                    logger.warn({breakingPath: node.ap, reason: "set property of undefined"});
                    node.empty = true;
                }
            } else {
                node.empty = true;
            }
            node.processed = true;
        }
    }

    else if (node.p.compType === 'arg') {
        
        if (!node.processed) {
            let hasRhoRelationInput = false;
            let rhoRelationInput;
            for (let i = 0; i < rhoRelations.length; i++) {
                if (rhoRelations[i][1] === node) {
                    if (!rhoRelations[i][0].processed) {
                        traverseTree(rhoRelations[i][0], rhoRelations);
                    }
                    hasRhoRelationInput = true;
                    rhoRelationInput = rhoRelations[i][0].obj;
                }
            }

            if (hasRhoRelationInput) {
                node.obj = rhoRelationInput;
            } else {
                node.obj = synthesizeValue(node);
            }
            node.processed = true;
            
        }
    }

    else if (node.p.compType === 'call') {
        if (!node.processed) {
            let argArray = {};
            for (let x of node.parent.children) {
                if (x.p.compType === 'arg' && x.p.callId === node.p.callId) {
                    if (!x.processed) {
                        traverseTree(x, rhoRelations);
                    }
                    argArray[x.p.argId] = x.obj;
                }
            }
            /* Convert the array-like object to a real array */
            argArray.length = Object.keys(argArray).length;
            argArray = Array.prototype.slice.call(argArray);
            let thisObj = undefined;
            if (node.parent.parent !== null && node.parent.parent !== undefined && node.parent.p.compType == 'accessProp') {
                thisObj = node.parent.parent.obj;
            }
            try {
                let result = node.parent.obj.apply(thisObj, argArray);
                let type = isCovariant(node.ap) ? getType(result) : getArgumentType(result);
                if (!checkCompatible(type, node.type)) {
                    logger.warn({breakingPath: node.ap, incompatibleReturnTypes: {actual: type, required: node.type}})
                }
                node.obj = result;
                node.processed = true;
            } catch (e) {
                logger.info('Error in executing the path: ' + JSON.stringify(node.ap));
                node.processed = true;
            }
            
        }
    }

    else if (node.p.compType === 'new') {
        if (!node.processed) {
            let argArray = {};
            for (let x of node.parent.children) {
                if (x.p.compType === 'arg' && x.p.callId === node.p.callId) {
                    if (!x.processed) {
                        traverseTree(x, rhoRelations);
                    }
                    argArray[x.p.argId] = x.obj;
                }
            }
            // Convert the array-like object to a real array
            argArray.length = Object.keys(argArray).length;
            argArray = Array.prototype.slice.call(argArray);
            try {
                let result = Reflect.construct(node.parent.obj, argArray);
                let type = isCovariant(node.ap) ? getType(result) : getArgumentType(result);
                if (!checkCompatible(type, node.type)) {
                    logger.warn({breakingPath: node.ap, incompatibleReturnTypes: {actual: type, required: node.type}})
                }
                node.obj = result;
                node.processed = true;
            } catch (e) {
                logger.info('Error in executing the path: ' + JSON.stringify(node.ap));
                node.processed = true;
            }
            
        }
    }

    while (true) {
        let next = findNextNode(node);
        if (!next) {
            return;
        }
        traverseTree(next, rhoRelations);
    }
}

let model = JSON.parse(fs.readFileSync(modelPath, {encoding: 'utf-8'}));
let [modelTree, rhoRelations] = constructModelTree(model);

traverseTree(modelTree, rhoRelations);