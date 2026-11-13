// Node modules the demo never really calls: there only so that the daemon's modules load in the browser.

export function execFile(_file: string, _args: readonly string[], ...rest: unknown[]): void {
  const callback = rest.find((item): item is (error: Error) => void => typeof item === 'function');
  callback?.(new Error('not in the demo'));
}
export const spawn = (): never => {
  throw new Error('not in the demo');
};
export const createInterface = (): never => {
  throw new Error('not in the demo');
};
export const fileURLToPath = (url: string | URL): string => String(url).replace(/^file:\/\//, '');
export const pathToFileURL = (path: string): URL => new URL(`file://${path}`);
export const createRequire = (): ((id: string) => never) => () => {
  throw new Error('not in the demo');
};
/** The WebSocket server of ws: the demo hands its sockets to the Hub itself (demo/socket.ts). */
export class WebSocketServer {
  constructor(_options?: unknown) {}
  handleUpgrade(): void {}
  close(): void {}
}
export class WebSocket {}
export default { execFile, spawn, createInterface, fileURLToPath, pathToFileURL, createRequire, WebSocketServer, WebSocket };
