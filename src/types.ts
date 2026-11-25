export type PathComp = { compType: 'require', moduleName: string } 
  | { compType: 'accessProp' | 'writeProp', propName: string }
  | { compType: 'arg', argId: number, callId: string }
  | { compType: 'call' | 'construct', callId: string };


export type Node = {
    children: {
      call: { [callId: string]: Node },
      construct: { [callId: string]: Node },
      arg: {
        [callId: string]: { [argId: number]: Node }
      },
      accessProp: { [propName: string]: Node },
      writeProp: { [propName: string]: Node}
    },
    p: PathComp,
    moduleName?: string,
    type: PathType,
    parent: Node | null;
    order: number,
    processed?: boolean,
    obj?: any,
    empty?: boolean
};


export type NodeChildType = 'call' | 'new' | 'arg' | 'access' | 'writeProp';

export type PathRelation = [Path, Path];

export type PathType = 'object' | 'string' | 'number' 
  | 'function' | 'undefined' | 'null' | 'date' | 'array'
  | 'map' | 'set' | 'error' | 'unknown'
  | {primType: 'string', value: string }
  | {primType: 'number', value: number | 'Infinity' | 'NaN' }
  | {primType: 'boolean', value: boolean };

export type Path = PathComp[];

export type TypedAndOrderedPath = {  path: Path, type: PathType, order: number };

export type Model = { paths: TypedAndOrderedPath[], rhoRelations: PathRelation[] };