//Pure helpers for vesting and milestones: when each part falls due, and how a total splits into whole parts.
export type Every = 'day' | 'week' | 'month';

//the n-th date after start: whole calendar months for 'month' (the 31st becomes the month's last day)
export function nthDate(start: number, every: Every, n: number): number {
  if (every === 'day') {
    return start + n * 86400;
  }
  if (every === 'week') {
    return start + n * 7 * 86400;
  }
  const d = new Date(start * 1000);
  const day = d.getDate();
  const target = new Date(
    d.getFullYear(),
    d.getMonth() + n,
    1,
    d.getHours(),
    d.getMinutes(),
  );
  const last = new Date(
    target.getFullYear(),
    target.getMonth() + 1,
    0,
  ).getDate();
  target.setDate(Math.min(day, last));
  return Math.floor(target.getTime() / 1000);
}

//the total split in n parts, the rest of the division on the last one, so the parts add up exactly
export function splitAmount(total: bigint, n: number): bigint[] {
  const each = total / BigInt(n);
  return Array.from({ length: n }, (_, i) =>
    i === n - 1 ? total - each * BigInt(n - 1) : each,
  );
}
