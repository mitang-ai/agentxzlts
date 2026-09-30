export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
): Promise<T> {
  const options: RequestInit = { credentials: "same-origin" };
  if (body !== undefined) {
    options.method = "POST";
    options.headers = { "x-island-request": "1" };
    if (body instanceof FormData) options.body = body;
    else {
      options.headers = {
        "x-island-request": "1",
        "Content-Type": "application/json",
      };
      options.body = JSON.stringify(body);
    }
  }
  const response = await fetch(`/api/${path}`, options);
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(response.status, data.error || "请求失败");
  return data;
}
export const cmd = <T = Record<string, unknown>>(
  command: string,
  data: Record<string, unknown>,
) => api<T>("command", { command, data });
export const time = (date: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
export const day = (date: string) =>
  new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(
    new Date(date),
  );
export const size = (bytes: number) =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
