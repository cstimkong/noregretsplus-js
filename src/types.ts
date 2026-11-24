export type PathComp = { compType: 'require', moduleName: string } 
  | { compType: 'accessProp' | 'writeProp', propName: string }
  | { compType: 'arg', argId: number, callId: string }
  | { compType: 'call' | 'new', callId: string };


export type Node = {
    callChildren?: { [key: string]: Node },
    newChildren?: { [key: string]: Node },
    argChildren?: { [callId: string]: {[argId: number]: Node } },
    accessPropChildren?: { [key: string]: Node },
    writePropChildren?: { [key: string]: Node },
    requireChildren?: { [key: string]: Node },
    p?: PathComp,
    type?: PathType,
    parent: Node | null | undefined;
    order?: number
};

export type NodeChildType = 'callChildren' | 'newChildren' | 'argChildren' 
  | 'accessPropChildren' | 'writePropChildren';

export type PathRelation = [Path, Path];

export type PathType = 'object' | 'string' | 'number' 
  | 'function' | 'undefined' | 'null' | 'date' | 'array'
  | 'map' | 'set' | 'error'
  | {primType: 'string', value: string }
  | {primType: 'number', value: number | 'Infinity' | 'NaN' }
  | {primType: 'boolean', value: boolean };

export type Path = PathComp[];

export type TypedAndOrderedPath = {  path: Path, type: PathType, order: number };

export type Model = { paths: TypedAndOrderedPath[], rhoRelations: PathRelation[] };