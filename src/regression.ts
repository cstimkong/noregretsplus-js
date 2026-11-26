
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

function getChild(currentNode: Node, c: PathComp): Node | null {
    if (c.compType === 'arg' && currentNode.children.arg[c.callId!]) {
        if (currentNode.children.arg[c.callId!]![c.argId!]) {
            return currentNode.children.arg[c.callId!]![c.argId!]!;
        }
        return null;
    }

    else if (c.compType === 'accessProp' && currentNode.children.accessProp[c.propName!]) {
        return currentNode.children.accessProp[c.propName!]!;
    }

    else if (c.compType === 'call' && currentNode.children.call[c.callId!]) {
        return currentNode.children.call[c.callId!]!;
    }

    else if (c.compType === 'construct' && currentNode.children.construct[c.callId!]) {
        return currentNode.children.construct[c.callId!]!;
    }

    else if (c.compType == 'writeProp' && currentNode.children.writeProp[c.propName!]) {
        return currentNode.children.writeProp[c.propName!]!;
    }

    return null;
}

function getChildren(currentNode: Node): Node[] {
    return Object.values(currentNode.children.accessProp!).concat(
        Object.values(currentNode.children.writeProp!),
        Object.values(currentNode.children.call!),
        Object.values(currentNode.children.construct!),
        Object.values(currentNode.children.arg!).map(x => Object.values(x)).flatMap(x => x)
    );
}
/**
 * Construct a model tree from the generated model.
 */
function constructModelTree(modelContent: Model) {
    let paths = modelContent.paths;
    let root: Node = {
        children: {
            call: {},
            construct: {},
            accessProp: {},
            writeProp: {},
            arg: {}
        },
        parent: null,
        moduleName: paths[0]?.path[0]?.moduleName!,
        p: {compType: 'require', moduleName: paths[0]?.path[0]?.moduleName!},
        order: 0,
        type: paths[0]!.type
    };

    for (let {path, type} of paths.slice(1)) {
        let current = root;
        let accumulatedPath: Path = [];
        path.forEach((comp, idx) => {
            accumulatedPath = accumulatedPath.concat([comp]);
            let c = getChild(current, comp);
            if (c !== null) {
                current = c;
            } else {
                assert(idx === path.length - 1);
                let newItem: Node = {
                    p: comp, ap: accumulatedPath, 
                    children: {
                        arg: {},
                        call: {},
                        construct: {},
                        accessProp: {},
                        writeProp: {}
                    },
                    parent: current,
                    type: type,
                    order: idx
                };

                if (comp.compType == 'accessProp') {
                    current.children.accessProp![comp.propName!] = newItem;
                }
                else if (comp.compType === 'writeProp') {
                    current.children.writeProp![comp.propName!] = newItem;
                }
                else if (comp.compType === 'call') {
                    current.children.call![comp.callId!] = newItem;
                }
                else if (comp.compType == 'arg') {
                    current.children.arg![comp.callId!] = current.children.arg![comp.callId!] || {};
                    current.children.arg![comp.callId!]![comp.argId!] = newItem;
                }
                else if (comp.compType === 'construct') {
                    current.children.call![comp.callId!] = newItem;
                }

                current = newItem;
            }
        });
    }

    let nodeRelations: [Node, Node][] = [];
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

    return { tree: root, relations: nodeRelations };
}

/**
 * Proxify the synthesized object for an argument node
 */
function getProxy(node: Node, obj: any) {
    return new Proxy(obj, {
        get: function(target, p, receiver) {
            if (node.children.accessProp![p as string]) {
                if (!(node.children.accessProp![p as string] as Node).processed) {
                    (node.children.accessProp![p as string] as Node).obj = synthesizeValue(node.children.accessProp![p as string] as Node);
                    (node.children.accessProp![p as string] as Node).processed = true;
                }
                return (node.children.accessProp![p as string] as Node).obj;
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
function synthesizeValue(node: Node) {
    if (node.type === 'undefined') {
        return undefined;
    }
    else if (node.type === 'null') {
        return null;
    }
    else if (node.type === 'object' || node.type === 'array' || node.type === 'set' || node.type === 'map') {
        return getProxy(node, {});
    }
    else if (node.type === 'function') {

        return getProxy(node, function() {
            for (let callId in node.children.call) {

                if (!(node.children.call[callId]! as Node).processed) {
                    (node.children.call[callId]! as Node).obj = synthesizeValue(node.children.call[callId] as Node);
                    (node.children.call[callId]! as Node).processed = true;
                }
                let argTypes: any = {};
                if (node.children.arg![callId]) {
                    for (let argId in node.children.arg![callId]!) {
                        
                        argTypes[argId] = node.children.arg![callId]![argId]!.type;
                    }
                }
                
                argTypes.length = Object.keys(argTypes).length;
                argTypes = Array.prototype.slice.call(argTypes);
                let realArgumentTypes: PathType[] = [];
                for (let i = 0; i < arguments.length; i++) {
                    realArgumentTypes.push(isCovariant((node.children.arg[callId]! as Node).ap!) ? getArgumentType(arguments[i]) : getType(arguments[i]));
                } 

                if (checkAllCompatible(realArgumentTypes, argTypes)) {
                    return (node.children.call[callId]! as Node).obj;
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

function findNextNode(currentNode: Node): Node | null {
    let minNode: Node | null = null;
    getChildren(currentNode).forEach((c) => {
        if (!c.processed) {
            if (!minNode) {
                minNode = c;
            } else {
                minNode = c.order! < minNode.order ? c : minNode;
            }
        } else {
            let m = findNextNode(c);
            if (!m) {
                return;
            }
            if (minNode && m.order < minNode.order) {
                minNode = m;
            }
        }
    });

    return minNode || null;
}

function traverseTree(node: Node, rhoRelations: Node[][]) {
    logger.info('Processing node path: ' + JSON.stringify(node.ap));

    if (!node.parent) {
        for (let c of getChildren(node)) {
            traverseTree(c, rhoRelations);
        }
        return;
    }

   else if (node.p!.compType === 'require') {
        if (!node.processed) {
            let o = require(node.p!.moduleName!);
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
                    let o = node.parent.obj[node.p.propName!];
                    let covariant = isCovariant(node.ap!);
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
                    node.parent.obj[node.p.propName!] = synthesizeValue(node);
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
                if (rhoRelations[i]![1] === node) {
                    if (!rhoRelations[i]![0]!.processed) {
                        traverseTree(rhoRelations[i]![0]!, rhoRelations);
                    }
                    hasRhoRelationInput = true;
                    rhoRelationInput = rhoRelations[i]![0]!.obj;
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
            let argArray: any = {};
            for (let x of getChildren(node.parent)) {
                if (x.p.compType === 'arg' && x.p.callId === node.p.callId) {
                    if (!x.processed) {
                        traverseTree(x, rhoRelations);
                    }
                    argArray[x.p!.argId!] = x.obj;
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
                let type = isCovariant(node.ap!) ? getType(result) : getArgumentType(result);
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

    else if (node.p.compType === 'construct') {
        if (!node.processed) {
            let argArray: any = {};
            for (let x of getChildren(node.parent)) {
                if (x.p.compType === 'arg' && x.p.callId === node.p.callId) {
                    if (!x.processed) {
                        traverseTree(x, rhoRelations);
                    }
                    argArray[x.p.argId!] = x.obj;
                }
            }
            // Convert the array-like object to a real array
            argArray.length = Object.keys(argArray).length;
            argArray = Array.prototype.slice.call(argArray);
            try {
                let result = Reflect.construct(node.parent.obj, argArray);
                let type = isCovariant(node.ap!) ? getType(result) : getArgumentType(result);
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
let {tree: modelTree, relations: nodeRelations} = constructModelTree(model);

traverseTree(modelTree, nodeRelations);