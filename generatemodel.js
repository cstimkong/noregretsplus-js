'use strict'

const deepEqual = require('deep-equal');
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const fs = require('node:fs');
const vm = require('node:vm');
const { getType, getArgumentType, isCovariant, makeRandomString } = require('./lib/utils');
const process = require('node:process');
const path = require('node:path');
const objectHash = require('object-hash');
const babelParser = require('@babel/parser');
const babelGenerator = require('@babel/generator').default;
const babelTraverse = require('@babel/traverse').default;
const pretty = require('pino-pretty');
const pino = require('pino').default;
const assert = require('assert');
const logger = pino(pretty({ sync: true }));

let argv = yargs(hideBin(process.argv))
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

    let pathTree = {
        p: null,
        callChildren: {},
        newChildren: {},
        argChildren: {},
        accessPropChildren: {},
        writePropChildren: {},
        requireChildren: {},
        type: null,
        parent: null
    };

    let order = 0;
    let rhoRelations = [];

    let nativeModules = [
        'assert', 'buffer', 'child_process', 'crypto',
        'dns', 'events', 'fs', 'http',
        'https', 'module', 'net', 'os',
        'path', 'process', 'stream', 'tls',
        'tty', 'url', 'util', 'vm',
        'zlib'
    ];


    function addPathAndType(path, type) {
        let t = pathTree;
        for (let pathComp of path) {
            if (pathComp.compType === 'require') {
                if (!t.requireChildren[pathComp.moduleName]) {
                    t.requireChildren[pathComp.moduleName] = { p: pathComp, callChildren: {}, newChildren: {}, argChildren: {}, accessPropChildren: {}, writePropChildren: {}, type: type, order: order++, parent: pathTree};
                }
                t = t.requireChildren[pathComp.moduleName];
            }

            if (pathComp.compType === 'accessProp') {
                if (!t.accessPropChildren[pathComp.propName]) {
                    t.accessPropChildren[pathComp.propName] = { p: pathComp, callChildren: {}, newChildren: {}, argChildren: {}, accessPropChildren: {}, writePropChildren: {}, type: type, order: order++, parent: t};
                }
                t = t.accessPropChildren[pathComp.propName];
            }

            if (pathComp.compType === 'writeProp') {
                if (!t.writePropChildren[pathComp.propName]) {
                    t.writePropChildren[pathComp.propName] = { p: pathComp, callChildren: {}, newChildren: {}, argChildren: {}, accessPropChildren: {}, writePropChildren: {}, type: type, order: order++, parent: t};
                }
                t = t.writePropChildren[pathComp.propName];
            }

            if (pathComp.compType === 'arg') {
                if (!t.argChildren[pathComp.callId]) {
                    t.argChildren[pathComp.callId] = {};
                }
                if (!t.argChildren[pathComp.callId][pathComp.argId]) {
                    t.argChildren[pathComp.callId][pathComp.argId] = { p: pathComp, callChildren: {}, newChildren: {}, argChildren: {}, accessPropChildren: {}, writePropChildren: {}, type: type, order: order++, parent: t};
                }
                t = t.argChildren[pathComp.callId][pathComp.argId];
            }

            if (pathComp.compType === 'call') {
                if (!t.callChildren[pathComp.callId]) {
                    t.callChildren[pathComp.callId] = { p: pathComp, callChildren: {}, newChildren: {}, argChildren: {}, accessPropChildren: {}, writePropChildren: {}, type: type, order: order++, parent: t };
                }
                t = t.callChildren[pathComp.callId];
            }

            if (pathComp.compType === 'new') {
                if (!t.newChildren[pathComp.callId]) {
                    t.newChildren[pathComp.callId] = { p: pathComp, callChildren: {}, newChildren: {}, argChildren: {}, accessPropChildren: {}, writePropChildren: {}, type: type, order: order++, parent: t};
                }
                t = t.newChildren[pathComp.callId];
            }
        }
        logger.info(`Added path: ${JSON.stringify(path)}, type: ${JSON.stringify(type)}`);
    }


    function pathTreeToList(currentNode, accumulatedPath, allPaths) {
        if (currentNode.p !== null) {
            allPaths.push({ path: accumulatedPath.concat(currentNode.p), type: currentNode.type, order: currentNode.order })
        }
        let ap = accumulatedPath.concat(currentNode.p === null ? [] : currentNode.p);
        if (currentNode.requireChildren) {
            for (let c of Object.values(currentNode.requireChildren)) {
                pathTreeToList(c, ap, allPaths);
            }
        }

        for (let c of Object.values(currentNode.callChildren)) {
            pathTreeToList(c, ap, allPaths);
        }
        for (let c of Object.values(currentNode.argChildren)) {
            for (let argChild of Object.values(c)) {
                pathTreeToList(argChild, ap, allPaths);
            }
        }
        for (let c of Object.values(currentNode.newChildren)) {
            pathTreeToList(c, ap, allPaths);
        }
        for (let c of Object.values(currentNode.accessPropChildren)) {
            pathTreeToList(c, ap, allPaths);
        }
        for (let c of Object.values(currentNode.writePropChildren)) {
            pathTreeToList(c, ap, allPaths);
        }

    }

    function getProxy(obj, path) {
        let proxy = new Proxy(obj, {
            get: function (target, p, _) {
                /* If the property is a Symbol, the corresponding value is directly returned since
                 the original NoRegrets+ does not deal with Symbols. */
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
                let newPath = path.concat([{ compType: 'writeProp', propName: p }]);
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
                    return result
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
                let newPath = path.concat([{ compType: 'new', callId: callId }]);
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
    function computeTreeHash(currentNode, accumulatedPath) {
        let hashMap = {
            callChildren: {},
            newChildren: {},
            accessPropChildren: {},
            writePropChildren: {},
            argChildren: {}
        };

        let inRhoRelations = false;

        for (let k of currentNode.callChildren) {
            computeTreeHash(currentNode.callChildren[k], accumulatedPath.concat([currentNode.p]));
            hashMap.callChildren[k] = currentNode.callChildren[k]._hash[0];
            inRhoRelations = inRhoRelations || currentNode.callChildren[k]._prefixInRhoRelations;
        }

        for (let k of currentNode.newChildren) {
            computeTreeHash(currentNode.newChildren[k], accumulatedPath.concat([currentNode.p]));
            hashMap.newChildren[k] = currentNode.newChildren[k]._hash[0];
            inRhoRelations = inRhoRelations || currentNode.newChildren[k]._prefixInRhoRelations;
        }

        for (let k of currentNode.accessPropChildren) {
            computeTreeHash(currentNode.accessPropChildren[k], accumulatedPath.concat([currentNode.p]));
            hashMap.accessPropChildren[k] = currentNode.accessPropChildren[k]._hash[0];
            inRhoRelations = inRhoRelations || currentNode.accessPropChildren[k]._prefixInRhoRelations;
        }

        for (let k of currentNode.writePropChildren) {
            computeTreeHash(currentNode.writePropChildren[k], accumulatedPath.concat([currentNode.p]));
            hashMap.writePropChildren[k] = currentNode.writePropChildren[k]._hash[0];
            inRhoRelations = inRhoRelations || currentNode.writePropChildren[k]._prefixInRhoRelations;
        }

        for (let k of currentNode.argChildren) {
            computeTreeHash(currentNode.argChildren[k], accumulatedPath.concat([currentNode.p]));
            hashMap.argChildren[k] = currentNode.argChildren[k]._hash[0];
            inRhoRelations = inRhoRelations || currentNode.argChildren[k]._prefixInRhoRelations;
        }

        currentNode._hash = [];
        currentNode._hash[0] = objectHash(hashMap);
        currentNode._hash[1] = objectHash(hashMap, {excludeKeys: v => v === 'argChildren'});
        currentNode._hashMap = hashMap;
        currentNode._prefixInRhoRelations = inRhoRelations || pathInRhoRelations(accumulatedPath.concat([currentNode.p]));
    }

    function updateTreeHash(currentNode, childType, childKey) {
        assert(currentNode[childType] !== undefined);
        if (!currentNode[childType][childKey]) {
            delete currentNode._hashMap[childType][childKey];
        } else {
            currentNode._hashMap[childType][childKey] = currentNode[childType][childKey]._hash[0];
        }

        currentNode._hash[0] = objectHash(currentNode._hashMap);
        currentNode._hash[1] = objectHash(currentNode._hashMap, {excludeKeys: v => v === 'argChildren'});

        updateTreeHash(currentNode.parent, currentNode.p.compType + 'Children',
            currentNode.p.compType === 'call' || currentNode.p.compType === 'arg' ? currentNode.p.callId : 
            currentNode.p.compType === 'accessProp' || currentNode.p.compType === 'writeProp' ? currentNode.p.propName : currentNode.p.moduleName
        )
    }

    /**
     * 
     * Identify the common prefix pairs where only one prefix can be retained in the model
     */
    function tryRemovePaths(currentNode) {
        let removed = false;
        l1: for (let k1 of currentNode.callChildren) {
            for (let k2 of currentNode.callChildren) {
                if (k1 !== k2 && currentNode.callChildren[k1]._hash[1] === currentNode.callChildren[k2]._hash[1]
                    && !currentNode.callChildren[k1]._prefixInRhoRelations && !currentNode.callChildren[k2]._prefixInRhoRelations
                ) {
                    /* Remove all paths with the prefix */
                    delete currentNode.callChildren[k2];
                    removed = true;
                    updateTreeHash(currentNode, 'callChildren', k2);
                    continue l1;
                }
            }
        }
        return removed;
    }


    function pathInRhoRelations(path) {
        for (let r of rhoRelations) {
            if (deepEqual(r[0], path) || deepEqual(r[1], path)) {
                return true;
            }
        }
        return false;
    }


    function recursivelyRemovePaths(currentNode) {
        if (!tryRemovePaths(currentNode)) {
            for (let k in currentNode.callChildren) {
                recursivelyRemovePaths(currentNode.callChildren[k]);
            }
            for (let k in currentNode.newChildren) {
                recursivelyRemovePaths(currentNode.newChildren[k]);
            }
            for (let k in currentNode.accessPropChildren) {
                recursivelyRemovePaths(currentNode.accessPropChildren[k]);
            }
            for (let k in currentNode.writePropChildren) {
                recursivelyRemovePaths(currentNode.writePropChildren[k]);
            }
            for (let k in currentNode.argChildren) {
                recursivelyRemovePaths(currentNode.argChildren[k]);
            }
        }
    }


    /**
     * 
     * Simulate the behavior of require function to find the module path according to module name and client path.
     */
    function findModule(moduleName, clientPath) {
        let p = path.resolve(path.dirname(clientPath));
        if (moduleName.startsWith('.')) {
            if (moduleName.endsWith('.js') || moduleName.endsWith('.cjs')) {
                let filePath = path.join(p, 'node_modules', moduleName);
                if (fs.existsSync(filePath)) {
                    return filePath;
                } else {
                    return undefined;
                }
            }
            else {
                let filePath = path.join(p, 'node_modules', moduleName + '.js');
                if (fs.existsSync(filePath)) {
                    return filePath;
                }
                filePath = path.join(p, 'node_modules', moduleName + '.cjs');
                if (fs.existsSync(filePath)) {
                    return filePath;
                }
                return undefined;
            }
        }

        while (true) {
            if (fs.existsSync(path.join(p, 'node_modules', moduleName, 'package.json'))) {
                let packageJsonContent = require(path.join(p, 'node_modules', moduleName, 'package.json'));
                let entryFile = packageJsonContent.main;
                if (!entryFile) {
                    entryFile = 'index.js';
                }
                if (fs.existsSync(path.join(p, 'node_modules', moduleName, entryFile))) {
                    return path.join(p, 'node_modules', moduleName, entryFile);
                } else {
                    return undefined;
                }
            }
            if (path.resolve(p, '..') === p) {
                break;
            }
            p = path.resolve(p, '..');
        }
        return undefined;
    }

    function mockedRequire(moduleName) {
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
            let initPath = [{ compType: 'require', moduleName: moduleName }]
            let proxiedLib = getProxy(lib, initPath);
            let type = getType(lib);
            addPathAndType(initPath, type);
            return proxiedLib;
        } else {
            return require(modulePath);
        }
    }

    function getJavaScriptFilesInDirectory(dir) {
        let files = [];
        const getFilesRecursively = (directory) => {
            const filesInDirectory = fs.readdirSync(directory);
            for (const file of filesInDirectory) {
                const absolute = path.join(directory, file);
                if (fs.statSync(absolute).isDirectory()) {
                    getFilesRecursively(absolute);
                } else if (file.endsWith('.js') || file.endsWith('.cjs')) {
                    files.push(absolute);
                }
            }
        };
        getFilesRecursively(path.resolve(dir));
        return files;
    }

    let javaScriptFiles;
    if (fs.statSync(argv.client).isDirectory()) {
        javaScriptFiles = getJavaScriptFilesInDirectory(client);
    } else {
        javaScriptFiles = [path.resolve(client)];
    }


    if (!argv.mocha) {
        javaScriptFiles.forEach(f => {
            let content = fs.readFileSync(f, { encoding: 'utf-8' });
            let ast = babelParser.parse(content);
            babelTraverse(ast, {
                exit(path) {
                    if (path.isProgram()) {
                        let funcExpr = babelTypes.functionExpression(
                            null,
                            [
                                babelTypes.identifier('require'),
                            ],
                            babelTypes.blockStatement(
                                path.node.body,
                                path.node.directives
                            )
                        );
                        path.node.body = [babelTypes.parenthesizedExpression(funcExpr)];
                        path.node.directives = [];
                        path.skip();
                    }
                }
            });

            content = babelGenerator(ast).code;
            try {
                /* Now use Node.js vm APIs */
                let compiledFunc = vm.runInNewContext(content, undefined, { filename: f });
                compiledFunc.call(undefined, mockedRequire);
            } catch (e) {
                logger.info(`Encountered error in executing ${f}: ` + e);
            }
        });

    } else {
        javaScriptFiles.forEach(f => {
            let content = fs.readFileSync(f, { encoding: 'utf-8' });
            try {
                new Function('require', 'describe', 'it', 'expect', 'assert', content)(
                    mockedRequire,
                    function (message, cb) {
                        logger.info(`Executing: ${message}`);
                        cb();
                    },
                    function (message, cb) {
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

    /* compute the hash for each node for convenience of removing paths */
    computeTreeHash(pathTree, []);

    if (argv.compress) {
        recursivelyRemovePaths(pathTree);
    }

    logger.info('Rho relations: ' + JSON.stringify(rhoRelations));

    let outputPath = argv.output;
    if (outputPath) {
        let allPaths = [];
        pathTreeToList(pathTree, [], allPaths);
        allPaths.sort((a, b) => a.order - b.order);
        fs.writeFileSync(outputPath, JSON.stringify({ paths: allPaths, rhoRelations: rhoRelations }, (k, v) => {
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