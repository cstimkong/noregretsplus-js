export type PathComp = { compType: 'require', moduleName: string } 
  | { compType: 'accessProp' | 'writeProp', propName: string }
  | { compType: 'arg', argId: number, callId: string }
  | { compType: 'call' | 'new', callId: string };


export interface Node {
    callChildren: { [key: string]: any },
    newChildren: { [key: string]: any},
    argChildren: { [callId: string]: {[argId: number]: any} },
    accessPropChildren: { [key: string]: any },
    writePropChildren: { [key: string]: any },
    requireChildren: { [key: string]: any },
    p: PathComp,
    type: PathType,
    parent: Node | null | undefined,
    order: number
};

export type NodeChildType = 'callChildren' | 'newChildren' | 'argChildren' | 'accessPropChildren' | 'writePropChildren';

export type PathRelation = [Path, Path];

export type PathType = 'object' | 'string' | 'number' 
  | 'function' | 'undefined' | 'null' | 'date' | 'array'
  | 'map' | 'set' | 'error'
  | {primType: 'string', value: string }
  | {primType: 'number', value: number }
  | {primType: 'boolean', value: boolean };

export type Path = PathComp[];

export type TypedAndOrderedPath = {  path: Path, type: PathType, order: number };