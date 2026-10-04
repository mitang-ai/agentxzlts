"use client";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ParticipantAvatar } from "@island/ui";
import { api } from "@/lib/client";
export type AvatarEditorHandle = { commit: () => Promise<string | null> };
export default forwardRef<
  AvatarEditorHandle,
  {
    value: string | null;
    onChange: (url: string | null) => void;
    name: string;
    onBusyChange?: (busy: boolean) => void;
  }
>(function AvatarEditor(
  {
    value,
    onChange,
    name,
    onBusyChange,
  }: {
    value: string | null;
    onChange: (url: string | null) => void;
    name: string;
    onBusyChange?: (busy: boolean) => void;
  },
  ref,
) {
  const canvas = useRef<HTMLCanvasElement>(null),
    image = useRef<ImageBitmap | null>(null),
    version = useRef(0);
  const [zoom, setZoom] = useState(1),
    [x, setX] = useState(50),
    [y, setY] = useState(50),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const uploading = useRef<Promise<string | null> | null>(null);
  async function commit(): Promise<string | null> {
    if (uploading.current) return uploading.current;
    if (!ready) return value;
    const ticket = version.current;
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    const operation = (async () => {
      try {
        const surface = canvas.current;
        if (!surface) throw Error("裁剪预览尚未就绪");
        const blob = await new Promise<Blob>((resolve, reject) =>
          surface.toBlob(
            (b) => (b ? resolve(b) : reject(Error("裁剪失败"))),
            "image/png",
          ),
        );
        const form = new FormData();
        form.append("file", blob, "avatar.png");
        const result = await api<{ avatar_url: string }>("avatars", form);
        if (ticket !== version.current) throw Error("头像已更改，请重新保存");
        onChange(result.avatar_url);
        setReady(false);
        return result.avatar_url;
      } catch (e) {
        setError((e as Error).message);
        throw e;
      } finally {
        uploading.current = null;
        setBusy(false);
        onBusyChange?.(false);
      }
    })();
    uploading.current = operation;
    return operation;
  }
  useImperativeHandle(ref, () => ({ commit }));
  useEffect(
    () => () => {
      version.current++;
      image.current?.close();
    },
    [],
  );
  useEffect(() => {
    const bitmap = image.current,
      ctx = canvas.current?.getContext("2d");
    if (!bitmap || !ctx) return;
    const side = Math.min(bitmap.width, bitmap.height) / zoom;
    ctx.clearRect(0, 0, 256, 256);
    ctx.drawImage(
      bitmap,
      ((bitmap.width - side) * x) / 100,
      ((bitmap.height - side) * y) / 100,
      side,
      side,
      0,
      0,
      256,
      256,
    );
  }, [zoom, x, y, ready]);
  return (
    <div className="avatar-editor">
      <ParticipantAvatar name={name} src={value} size={64} />
      <label className="secondary compact">
        选择头像
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="选择头像图片"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const ticket = ++version.current;
            setBusy(true);
            onBusyChange?.(true);
            setError("");
            setReady(false);
            try {
              if (file.size > 2 * 1048576) throw Error("图片不能超过 2 MB");
              if (
                !["image/jpeg", "image/png", "image/webp"].includes(file.type)
              )
                throw Error("支持静态 PNG、JPEG、WebP");
              const bitmap = await createImageBitmap(file);
              if (bitmap.width * bitmap.height > 16 * 1048576) {
                bitmap.close();
                throw Error("图片尺寸过大");
              }
              if (ticket !== version.current) {
                bitmap.close();
                return;
              }
              image.current?.close();
              image.current = bitmap;
              setZoom(1);
              setX(50);
              setY(50);
              setReady(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
              onBusyChange?.(false);
            }
          }}
        />
      </label>
      <button
        type="button"
        className="text-button"
        disabled={busy}
        onClick={() => {
          version.current++;
          image.current?.close();
          image.current = null;
          setReady(false);
          onChange(null);
        }}
      >
        移除头像
      </button>
      {ready && (
        <div className="avatar-crop">
          <canvas
            ref={canvas}
            width={256}
            height={256}
            aria-label="头像裁剪预览"
          />
          <label>
            缩放
            <input
              type="range"
              min={1}
              max={3}
              step={0.05}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </label>
          <label>
            左右移动
            <input
              type="range"
              min={0}
              max={100}
              value={x}
              onChange={(e) => setX(Number(e.target.value))}
            />
          </label>
          <label>
            上下移动
            <input
              type="range"
              min={0}
              max={100}
              value={y}
              onChange={(e) => setY(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void commit().catch(() => {})}
          >
            使用裁剪后的头像
          </button>
        </div>
      )}
      <small>
        仅站内头像；裁剪并重新编码，移除定位等图片元数据。最后保存资料生效。
      </small>
      {error && <p role="alert">{error}</p>}
    </div>
  );
});
