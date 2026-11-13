/** Helpers that work both in the Windows app and in a browser. */
export interface DesktopBridge {
  version: string;
  request(req: {
    url: string; method?: string; headers?: Record<string, string>; body?: string;
    multipart?: Array<{ name: string; value: string; filename?: string; type?: string }>;
  }): Promise<{ status: number; ok: boolean; text: string }>;
  openExternal(url: string): Promise<void>;
}

export const desktop = (): DesktopBridge | null => (window as unknown as { tivbookDesktop?: DesktopBridge }).tivbookDesktop ?? null;
export const isDesktop = () => !!desktop();

export async function openExternal(url: string) {
  const d = desktop();
  if (d) await d.openExternal(url);
  else window.open(url, "_blank", "noopener");
}
