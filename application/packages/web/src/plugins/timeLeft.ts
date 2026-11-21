/** "About 4 min left": whole minutes from a minute on, else seconds by tens. */
export function timeLeft(seconds: number, locale: string): string {
  const minutes = seconds >= 60;
  const n = minutes ? Math.ceil(seconds / 60) : Math.max(10, Math.ceil(seconds / 10) * 10);
  return new Intl.NumberFormat(locale, { style: 'unit', unit: minutes ? 'minute' : 'second', unitDisplay: 'short' }).format(n);
}
