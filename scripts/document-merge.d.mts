export interface DocumentMergeResult<T = Record<string, unknown>> {
  ok: boolean;
  document: T;
  conflicts: string[];
}
export function mergeDocuments<T = Record<string, unknown>>(base: T, local: T, remote: T): DocumentMergeResult<T>;
export function documentsEqual(a: unknown, b: unknown): boolean;
