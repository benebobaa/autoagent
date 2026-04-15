export type VectorPrimitive = string | number | boolean;

export type VectorMetadata = Record<string, VectorPrimitive>;

export type VectorWhereLeaf = {
  [key: string]: { $eq: VectorPrimitive };
};

export type VectorWhere =
  | VectorWhereLeaf
  | { $and: VectorWhere[] };

export interface VectorDocument {
  id: string;
  text: string;
  metadata: VectorMetadata;
}

export interface VectorQueryResult {
  id: string;
  text: string;
  metadata: VectorMetadata;
  distance: number;
}
