export const VIRTUAL_LIST_THRESHOLD = 100;

export function shouldVirtualizeList(itemCount: number, threshold = VIRTUAL_LIST_THRESHOLD): boolean {
  return itemCount > threshold;
}

export function shouldTriggerLoadMore(
  lastVisibleRowIndex: number,
  rowCount: number,
  hasMore: boolean,
  isLoading: boolean,
  threshold = 3
): boolean {
  if (!hasMore || isLoading || rowCount <= 0) return false;
  return lastVisibleRowIndex >= rowCount - 1 - threshold;
}
