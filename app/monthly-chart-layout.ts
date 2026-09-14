/** Keep positioning local to the chart; never scroll the surrounding page. */
export function monthlyChartScrollTarget(
  viewportWidth: number,
  contentWidth: number,
  selected?: { left: number; width: number },
) {
  const end = Math.max(0, contentWidth - viewportWidth);
  if (!selected) return end;
  return Math.max(0, Math.min(end, selected.left - (viewportWidth - selected.width) / 2));
}
