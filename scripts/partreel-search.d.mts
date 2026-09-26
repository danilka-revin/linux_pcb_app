export interface PartReelPart {
  id: string;
  name: string;
  category: string;
  family: string;
  manufacturer: string;
  keywords: string;
  verified?: unknown;
  pins?: number;
  mpn?: string;
  page?: string;
  searchText: string;
}
export interface PartReelIndex {
  total: number;
  parts: PartReelPart[];
}
export interface PartReelSearchResult {
  total: number;
  count: number;
  results: (Omit<PartReelPart, 'searchText' | 'mpn'> & { mpn_pattern?: string })[];
}
export function partText(value: unknown): string;
export function normalizePartText(value: unknown): string;
export function partVerified(value: unknown): boolean;
export function parsePartReelIndex(raw: unknown): PartReelIndex;
export function searchPartReel(
  index: PartReelIndex,
  options?: { query?: string; category?: string; verifiedOnly?: boolean; limit?: number },
): PartReelSearchResult;
