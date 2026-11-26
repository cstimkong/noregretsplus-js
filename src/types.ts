export type PathComp = {
  compType: 'require' | 'accessProp' | 'writeProp' | 'call' | 'construct' | 'arg',
  moduleName?: string,
  propName?: string,
  argId?: number,
  callId?: string
};


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
    ap?: Path,
    moduleName?: string,
    type: PathType,
    parent: Node | null;
    order: number,
    processed?: boolean,
    obj?: any,
    empty?: boolean
};


export type NodeChildType = 'call' | 'new' | 'arg' | 'accessProp' | 'writeProp';

export type PathRelation = [Path, Path];

export type PathType = 'object'  
  | 'function' | 'undefined' | 'null' | 'date' | 'array'
  | 'map' | 'set' | 'error' | 'unknown'
  | { primType: 'string', value: string }
  | { primType: 'number', value: number | 'Infinity' | 'NaN' }
  | { primType: 'boolean', value: boolean };

export type Path = PathComp[];

export type TypedAndOrderedPath = {  path: Path, type: PathType, order: number };

export type Model = { paths: TypedAndOrderedPath[], rhoRelations: PathRelation[] };