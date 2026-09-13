const MONTHLY_CONTRIBUTION = 500;
export function monthlyDeposits(
  dates: readonly string[],
): Array<{ date: string; amount: number }> {
  const months = new Set<string>();
  const deposits: Array<{ date: string; amount: number }> = [];
  for (const date of dates) {
    const month = date.slice(0, 7);
    if (months.has(month)) continue;
    if (months.size > 0) deposits.push({ date, amount: MONTHLY_CONTRIBUTION });
    months.add(month);
  }
  return deposits;
}
