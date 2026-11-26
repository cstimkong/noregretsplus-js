'use strict'

import deepEqual from 'deep-equal';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { getType, getArgumentType, isCovariant, makeRandomString } from './utils.js';
import { argv as processArgv } from 'node:process';
import { resolve, dirname, join } from 'node:path';
import objectHash from 'object-hash';
import { parse } from '@babel/parser';
import babelGenerator from '@babel/generator';
import babelTraverse from '@babel/traverse';
import { blockStatement, expressionStatement, functionExpression, identifier, parenthesizedExpression } from '@babel/types';
import pretty from 'pino-pretty';
import pino from 'pino';
import assert from 'assert';
import type { Path, PathComp, TypedAndOrderedPath, Node, PathType, PathRelation, NodeChildType } from './types.js';


const logger = pino(pretty({ sync: true }));

let argv: any = yargs(hideBin(processArgv))
    .usage('Generate an API model for a library based on the given client code')
    .option('library', {
        alias: 'l',
        type: 'string',
        description: 'The name of the library under test'
    })
    .option('client', {
        alias: 'c',
        type: 'string',
        description: 'The path of client JavaScript file or project (if the specified path is a directory, all JavaScript files in the diretory will be executed)'
    })
    .option('mocha', {
        type: 'boolean',
        description: 'Client JavaScript file or project use Mocha as the test framework'
    })
    .option('jest', {
        type: 'boolean',
        description: 'Client JavaScript file or project use Jest as the test framework'
    })
    .option('compress', {
        type: 'boolean',
        description: 'Whether to compress the model',
        default: true
    })
    .option('output', {
        alias: 'o',
        type: 'string',
        description: 'Output path for the generated model'
    })
    .demandOption(['library', 'client'])
    .help().parse();

(function () {
    let client = argv.client;

    let pathTree: Node | undefined;

    let order = 0;
    let rhoRelations: PathRelation[] = [];

    let nativeModules = [
        'assert', 'buffer', 'child_process', 'crypto',
        'dns', 'events', 'fs', 'http',
        'https', 'module', 'net', 'os',
        'path', 'process', 'stream', 'tls',
        'tty', 'url', 'util', 'vm',
        'zlib'
    ];

    function addPathAndType(path: Path, type: PathType) {
        let t = pathTree;
        for (let pathComp of path) {
            if (pathComp.compType === 'require' && pathComp.moduleName === argv.library) {
                pathTree = {
                    children: {
                        accessProp: {},
                        writeProp: {},
                        arg: {},
                        call: {},
                        construct: {}
                    },
                    parent: null,
                    moduleName: pathComp.moduleName!,
                    p: { compType: 'require', moduleName: pathComp.moduleName! },
                    type: type,
                    order: order++
                };
                t = pathTree;
            }

            else if (pathComp.compType === 'accessProp') {
                if (!t!.children.accessProp[pathComp.propName!]) {
                    t!.children.accessProp[pathComp.propName!] = { p: pathComp, children: { call: {}, construct: {}, arg: {}, accessProp: {}, writeProp: {} }, type: type, order: order++, parent: t! };
                }
                t = t!.children.accessProp[pathComp.propName!]!;
            }

            if (pathComp.compType === 'writeProp') {
                if (!t!.children.writeProp[pathComp.propName!]) {
                    t!.children.writeProp[pathComp.propName!] = { p: pathComp, children: { call: {}, construct: {}, arg: {}, accessProp: {}, writeProp: {} }, type: type, order: order++, parent: t! };
                }
                t = t!.children.writeProp[pathComp.propName!]!;
            }

            if (pathComp.compType === 'arg') {
                if (!t!.children.arg[pathComp.callId!]) {
                    t!.children.arg[pathComp.callId!] = {};
                }
                if (!t!.children.arg[pathComp.callId!]![pathComp.argId!]) {
                    t!.children.arg[pathComp.callId!]![pathComp.argId!] = { p: pathComp, children: { call: {}, construct: {}, arg: {}, accessProp: {}, writeProp: {} }, type: type, order: order++, parent: t! };
                }
                t = t!.children.arg[pathComp.callId!]![pathComp.argId!]!;
            }

            if (pathComp.compType === 'call') {
                if (!t!.children.call[pathComp.callId!]) {
                    t!.children.call[pathComp.callId!] = { p: pathComp, children: { call: {}, construct: {}, arg: {}, accessProp: {}, writeProp: {} }, type: type, order: order++, parent: t! };
                }
                t = t!.children.call[pathComp.callId!]!;
            }

            if (pathComp.compType === 'construct') {
                if (!t!.children.construct[pathComp.callId!]) {
                    t!.children.construct[pathComp.callId!] = { p: pathComp, children: { call: {}, construct: {}, arg: {}, accessProp: {}, writeProp: {} }, type: type, order: order++, parent: t! };
                }
                t = t!.children.construct[pathComp.callId!]!;
            }
        }
        logger.info(`Added path: ${JSON.stringify(path)}, type: ${JSON.stringify(type)}`);
    }


    function pathTreeToList(currentNode: Node, accumulatedPath: Path, allPaths: TypedAndOrderedPath[]) {
        if (currentNode.p !== null) {
            allPaths.push({ path: accumulatedPath.concat(currentNode.p), type: currentNode.type, order: currentNode.order })
        }
        let ap = accumulatedPath.concat(currentNode.p === null ? [] : currentNode.p);

        for (let c of Object.values(currentNode.children.call)) {
            pathTreeToList(c, ap, allPaths);
        }
        for (let c of Object.values(currentNode.children.arg)) {
            for (let argChild of Object.values(c)) {
                pathTreeToList(argChild, ap, allPaths);
            }
        }
        for (let c of Object.values(currentNode.children.construct)) {
            pathTreeToList(c, ap, allPaths);
        }
        for (let c of Object.values(currentNode.children.accessProp)) {
            pathTreeToList(c, ap, allPaths);
        }
        for (let c of Object.values(currentNode.children.writeProp)) {
            pathTreeToList(c, ap, allPaths);
        }
    }

    function getProxy(obj: any, path: Path) {
        let proxy: any = new Proxy(obj, {
            get: function (target, p, _) {
                // If the property is a Symbol, the corresponding value is directly returned since
                // the original NoRegrets+ does not deal with Symbols.
                if (typeof p !== 'string') {
                    return target[p];
                }
                /* Return the access path for an object. */
                if (p === '@@__PATH__@@') {
                    return path;
                }

                if (typeof target[p] === 'function' && target[p].toString().indexOf('[native code]') >= 0) {
                    return target[p];
                }
                let newPath = path.concat([{ compType: 'accessProp', propName: p }]);
                let type = isCovariant(newPath) ? getType(target[p]) : getArgumentType(target[p]);
                addPathAndType(newPath, type);
                if (target[p] !== null && (type === 'object' || type === 'function')) {
                    return getProxy(target[p], newPath);
                } else {
                    return target[p];
                }
            },

            set: function (target, p, newValue) {
                let newPath = path.concat([{ compType: 'writeProp', propName: p as string }]);
                let type = isCovariant(newPath) ? getType(newValue) : getArgumentType(newValue);
                addPathAndType(newPath, type);
                target[p] = newValue;
                return true;
            },

            apply: function (target, thisArg, argArray) {
                let callId = makeRandomString(6);
                let proxiedArgArray = [];
                for (let i = 0; i < argArray.length; i++) {
                    let newPath = path.concat([{ compType: 'arg', callId: callId, argId: i }]);
                    let type = isCovariant(newPath) ? getType(argArray[i]) : getArgumentType(argArray[i]);
                    addPathAndType(newPath, type);
                    if ((typeof argArray[i] === 'object' || typeof argArray[i] === 'function') && argArray[i] !== null) {
                        proxiedArgArray.push(getProxy(argArray[i], newPath));

                        let argPath = argArray[i]['@@__PATH__@@'];
                        if (argPath) {
                            rhoRelations.push([argPath, newPath]);
                        }
                    } else {
                        proxiedArgArray.push(argArray[i]);
                    }
                }

                let result = target.apply(thisArg, proxiedArgArray);

                let newPath = path.concat([{ compType: 'call', callId: callId }]);
                let type = isCovariant(newPath) ? getType(result) : getArgumentType(result);
                addPathAndType(newPath, type);
                if (result !== null && typeof result === 'object' && result['@@__PATH__@@']) {
                    return result;
                }
                if (type === 'object' || type === 'function') {
                    return getProxy(result, newPath);
                } else {
                    return result;
                }
            },

            construct: function (target, argArray, newTarget) {
                let callId = makeRandomString(6);
                let proxiedArgArray = [];
                for (let i = 0; i < argArray.length; i++) {
                    let newPath = path.concat([{ compType: 'arg', callId: callId, argId: i }]);
                    let type = isCovariant(newPath) ? getType(argArray[i]) : getArgumentType(argArray[i]);
                    addPathAndType(newPath, type);
                    if (typeof argArray[i] === 'object' && argArray[i] !== null) {
                        proxiedArgArray.push(getProxy(argArray[i], newPath));

                        let argPath = argArray[i]['@@__PATH__@@'];
                        if (argPath) {
                            rhoRelations.push([argPath, newPath]);
                        }
                    } else {
                        proxiedArgArray.push(argArray[i]);
                    }

                }
                let result = Reflect.construct(target, argArray);
                let newPath = path.concat([{ compType: 'construct', callId: callId }]);
                let type = isCovariant(newPath) ? getType(result) : getArgumentType(result);
                addPathAndType(newPath, type);
                return getProxy(result, newPath);
            }

        });
        return proxy;
    }

    /**
     * 
     * Compute the hash for each node in the path tree
     */
    function computeTreeHash(currentNode: Node, accumulatedPath: Path) {
        let hashMap: any = {
            call: {},
            construct: {},
            accessProp: {},
            writeProp: {},
            arg: {}
        };

        let inRhoRelations = false;

        for (let k in currentNode.children.call) {
            computeTreeHash(currentNode.children.call[k]!, accumulatedPath.concat([currentNode.p]));
            hashMap.callChildren[k] = (currentNode.children.call[k]! as any)._hash[0];
            inRhoRelations = inRhoRelations || (currentNode.children.call[k]! as any)._prefixInRhoRelations;
        }

        for (let k in currentNode.children.construct) {
            computeTreeHash(currentNode.children.construct[k]!, accumulatedPath.concat([currentNode.p]));
            hashMap.newChildren[k] = (currentNode.children.construct[k] as any)._hash[0];
            inRhoRelations = inRhoRelations || (currentNode.children.construct[k] as any)._prefixInRhoRelations;
        }

        for (let k in currentNode.children.accessProp) {
            computeTreeHash(currentNode.children.accessProp[k]!, accumulatedPath.concat([currentNode.p]));
            hashMap.accessPropChildren[k] = (currentNode.children.accessProp[k] as any)._hash[0];
            inRhoRelations = inRhoRelations || (currentNode.children.accessProp[k] as any)._prefixInRhoRelations;
        }

        for (let k in currentNode.children.writeProp) {
            computeTreeHash(currentNode.children.writeProp[k]!, accumulatedPath.concat([currentNode.p]));
            hashMap.writePropChildren[k] = (currentNode.children.writeProp[k] as any)._hash[0];
            inRhoRelations = inRhoRelations || (currentNode.children.writeProp[k] as any)._prefixInRhoRelations;
        }

        for (let k in currentNode.children.arg) {
            hashMap.argChildren[k] = hashMap.argChildren[k] || {};
            for (let argId in currentNode.children.arg[k]) {
                computeTreeHash(currentNode.children.arg[k]![parseInt(argId)]!, accumulatedPath.concat([currentNode.p]));
                hashMap.argChildren[k][parseInt(argId)] = (currentNode.children.arg[k][parseInt(argId)] as any)._hash[0];
                inRhoRelations = inRhoRelations || (currentNode.children.arg[k][parseInt(argId)] as any)._prefixInRhoRelations;
            }

        }

        (currentNode as any)._hash = [];
        (currentNode as any)._hash[0] = objectHash(hashMap);
        (currentNode as any)._hash[1] = objectHash(hashMap, { excludeKeys: v => v === 'arg' });
        (currentNode as any)._hashMap = hashMap;
        (currentNode as any)._prefixInRhoRelations = inRhoRelations || pathInRhoRelations(accumulatedPath.concat([currentNode.p]));
    }

    function updateTreeHash(currentNode: Node, childType: NodeChildType, childKey: string, argId?: any) {
        if (childType !== 'arg') {
            if (!(currentNode.children as any)[childType][childKey]) {
                delete (currentNode as any)._hashMap.call[childKey];
            } else {
                (currentNode as any)._hashMap[childType][childKey] = (currentNode.children as any)[childType][childKey]._hash[0];
            }
        } else {
            if (!currentNode.children.arg[childKey]![argId]) {
                delete (currentNode as any)._hashMap.arg[childKey]![argId];
            } else {
                (currentNode as any)._hashMap.arg[childKey][argId] = (currentNode.children as any).arg[childKey][argId]._hash[0];
            }
        }
        

        (currentNode as any)._hash[0] = objectHash((currentNode as any)._hashMap);
        (currentNode as any)._hash[1] = objectHash((currentNode as any)._hashMap, { excludeKeys: v => v === 'arg' });
        if (currentNode.parent !== null) {
            if (currentNode.p.compType === 'call' || currentNode.p.compType === 'construct') {
                updateTreeHash(currentNode.parent, currentNode.p.compType as NodeChildType, currentNode.p.callId!);
            }
            else if (currentNode.p.compType === 'accessProp' || currentNode.p.compType === 'writeProp') {
                updateTreeHash(currentNode.parent, currentNode.p.compType as NodeChildType, currentNode.p.propName!);
            }
            else if (currentNode.p.compType === 'arg') {
                updateTreeHash(currentNode.parent, 'arg', currentNode.p.callId!, currentNode.p.argId);
            }
        }
        
    }

    /**
     * 
     * Identify the common prefix pairs where only one prefix can be retained in the model
     */
    function tryRemovePaths(currentNode: Node) {
        let removed = false;
        l1: for (let k1 in currentNode.children.call) {
            for (let k2 in currentNode.children.call) {
                if (k1 !== k2 && (currentNode.children.call[k1] as any)._hash[1] === (currentNode.children.call[k2] as any)._hash[1]
                    && !(currentNode.children.call[k1] as any)._prefixInRhoRelations && !(currentNode.children.call[k2] as any)._prefixInRhoRelations
                ) {
                    /* Remove all paths with the prefix */
                    delete currentNode.children.call[k2];
                    removed = true;
                    updateTreeHash(currentNode, 'call', k2);
                    continue l1;
                }
            }
        }
        return removed;
    }


    function pathInRhoRelations(path: Path) {
        for (let r of rhoRelations) {
            if (deepEqual(r[0], path) || deepEqual(r[1], path)) {
                return true;
            }
        }
        return false;
    }


    function recursivelyRemovePaths(currentNode: Node) {
        if (!tryRemovePaths(currentNode)) {
            Object.values(currentNode.children.call).forEach(x => {
                recursivelyRemovePaths(x);
            });

            Object.values(currentNode.children.construct).forEach(x => {
                recursivelyRemovePaths(x);
            });

            Object.values(currentNode.children.accessProp).forEach(x => {
                recursivelyRemovePaths(x);
            });

            Object.values(currentNode.children.writeProp).forEach(x => {
                recursivelyRemovePaths(x);
            });

            Object.values(currentNode.children.arg).map(x => Object.values(x)).flatMap(x => x).forEach(x => {
                recursivelyRemovePaths(x);
            });
        }
    }


    /**
     * 
     * Simulate the behavior of require function to find the module path according to module name and client path.
     */
    function findModule(moduleName: string, clientPath: string) {
        let p = resolve(dirname(clientPath));
        if (moduleName.startsWith('.')) {
            if (moduleName.endsWith('.js') || moduleName.endsWith('.cjs')) {
                let filePath = join(p, 'node_modules', moduleName);
                if (existsSync(filePath)) {
                    return filePath;
                } else {
                    return undefined;
                }
            }
            else {
                let filePath = join(p, 'node_modules', moduleName + '.js');
                if (existsSync(filePath)) {
                    return filePath;
                }
                filePath = join(p, 'node_modules', moduleName + '.cjs');
                if (existsSync(filePath)) {
                    return filePath;
                }
                return undefined;
            }
        }

        while (true) {
            if (existsSync(join(p, 'node_modules', moduleName, 'package.json'))) {
                let packageJsonContent = require(join(p, 'node_modules', moduleName, 'package.json'));
                let entryFile = packageJsonContent.main;
                if (!entryFile) {
                    entryFile = 'index.js';
                }
                if (existsSync(join(p, 'node_modules', moduleName, entryFile))) {
                    return join(p, 'node_modules', moduleName, entryFile);
                } else {
                    return undefined;
                }
            }
            if (resolve(p, '..') === p) {
                break;
            }
            p = resolve(p, '..');
        }
        return undefined;
    }

    function mockedRequire(moduleName: string) {
        /* For native modules, directly import them */
        if (moduleName.startsWith('node:')) {
            return require(moduleName);
        }
        if (nativeModules.indexOf(moduleName) >= 0) {
            return require(moduleName);
        }

        let modulePath = findModule(moduleName, argv.client);
        if (!modulePath) {
            throw new Error(`Cannot find the module "${moduleName}"`);
        }

        if (moduleName === argv.library) {
            let lib = require(modulePath);
            let initPath: Path = [{ compType: 'require', moduleName: moduleName }]
            let proxiedLib = getProxy(lib, initPath);
            let type = getType(lib);
            addPathAndType(initPath, type);
            return proxiedLib;
        } else {
            return require(modulePath);
        }
    }

    function getJavaScriptFilesInDirectory(dir: string) {
        let files: string[] = [];
        const getFilesRecursively = (directory: string) => {
            const filesInDirectory = readdirSync(directory);
            for (const file of filesInDirectory) {
                const absolute = join(directory, file);
                if (statSync(absolute).isDirectory()) {
                    getFilesRecursively(absolute);
                } else if (file.endsWith('.js') || file.endsWith('.cjs')) {
                    files.push(absolute);
                }
            }
        };
        getFilesRecursively(resolve(dir));
        return files;
    }

    let javaScriptFiles;
    if (statSync(argv.client).isDirectory()) {
        javaScriptFiles = getJavaScriptFilesInDirectory(client);
    } else {
        javaScriptFiles = [resolve(client)];
    }


    if (!argv.mocha) {
        javaScriptFiles.forEach(f => {
            let content = readFileSync(f, { encoding: 'utf-8' });
            let ast = parse(content, { sourceFilename: f });
            babelTraverse(ast, {
                exit(path) {
                    if (path.isProgram()) {
                        let funcExpr = functionExpression(
                            null,
                            [
                                identifier('require'),
                            ],
                            blockStatement(
                                path.node.body,
                                path.node.directives
                            )
                        );
                        path.node.body = [expressionStatement(parenthesizedExpression(funcExpr))];
                        path.node.directives = [];
                        path.skip();
                    }
                }
            });

            content = babelGenerator(ast).code;
            try {
                /* Now use Node.js vm APIs */
                let compiledFunc = runInNewContext(content, undefined, { filename: f });
                compiledFunc.call(undefined, mockedRequire);
            } catch (e) {
                logger.info(`Encountered error in executing ${f}: ` + e);
            }
        });

    } else {
        javaScriptFiles.forEach(f => {
            let content = readFileSync(f, { encoding: 'utf-8' });
            let ast = parse(content, { sourceFilename: f });
            babelTraverse(ast, {
                exit(path) {
                    if (path.isProgram()) {
                        let funcExpr = functionExpression(
                            null,
                            [
                                identifier('require'),
                                identifier('describe'),
                                identifier('it'),
                                identifier('before'),
                                identifier('after'),
                                identifier('beforeEach'),
                                identifier('afterEach'),
                                identifier('expect'),
                                identifier('assert'),
                            ],
                            blockStatement(
                                path.node.body,
                                path.node.directives
                            )
                        );
                        path.node.body = [expressionStatement(parenthesizedExpression(funcExpr))];
                        path.node.directives = [];
                        path.skip();
                    }
                }
            });

            try {
                new Function('require', 'describe', 'it', 'expect', 'assert', content)(
                    mockedRequire,
                    function (message: any, cb: Function) {
                        logger.info(`Executing: ${message}`);
                        cb();
                    },
                    function (message: any, cb: Function) {
                        logger.info(`Executing test: ${message}`);
                        if (cb.length === 1) {
                            cb(function () { });
                        } else {
                            cb();
                        }
                    },
                    require('expect.js'),
                    require('assert')
                );
            } catch (e) {
                logger.info(`Encountered error in executing ${f}: ` + e);
            }
        });
    }

    // compute the hash for each node for convenience of removing paths
    computeTreeHash(pathTree!, []);

    if (argv.compress) {
        recursivelyRemovePaths(pathTree!);
    }

    logger.info('Rho relations: ' + JSON.stringify(rhoRelations));

    let outputPath = argv.output;
    if (outputPath) {
        let allPaths: TypedAndOrderedPath[] = [{path: [{compType: 'require', moduleName: argv.library}], type: pathTree?.type!, order: pathTree!.order!}];
        pathTreeToList(pathTree!, [], allPaths);
        allPaths.sort((a, b) => a.order - b.order);
        writeFileSync(outputPath, JSON.stringify({ paths: allPaths, rhoRelations: rhoRelations }, (k, v) => {
            if (v === Infinity) {
                return 'Infinity';
            }
            if (Number.isNaN(v)) {
                return 'NaN';
            }
            return v;
        }));
        logger.info(`Written to the file ${argv.output}`)
    }
})()