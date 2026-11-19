//the line the wallet shows on its Overview for this module (desktop wallet ModuleNotices): saved in the module's
//storage, so it stays while the module is closed
export function publishOverview(count: number, text: string): void {
  const u = (window as unknown as { NEXUS?: { utilities?: { updateStorage?: (d: object) => void } } }).NEXUS?.utilities;
  try {
    u?.updateStorage?.({ overview: { count, text, at: Math.floor(Date.now() / 1000) } });
  } catch {
    //not in the wallet, or an old wallet without module storage
  }
}
