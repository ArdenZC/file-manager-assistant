export const VIRTUAL_LIST_THRESHOLD = 100;

export function shouldVirtualizeList(itemCount: number, threshold = VIRTUAL_LIST_THRESHOLD): boolean {
  return itemCount > threshold;
}
