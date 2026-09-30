// 扫描服务在对象入库之前接入；未配置时不会伪装成「已扫描」。
export type ScanResult = {
  status: "not_configured" | "clean" | "rejected";
  reason?: string;
};
export type FileScanner = (bytes: Buffer, mime: string) => Promise<ScanResult>;
export const scanFile: FileScanner = async () => ({ status: "not_configured" });
