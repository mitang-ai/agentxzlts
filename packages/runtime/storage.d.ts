export type Storage = {
  storeFile(path: string, bytes: Buffer, type: string, db?: any): Promise<void>;
  loadFile(path: string): Promise<Buffer>;
  removeFile(path: string, db?: any): Promise<void>;
};
export function createStorage(
  pool: { query: (...args: any[]) => Promise<any> },
  env?: Record<string, string | undefined>,
): Storage;
