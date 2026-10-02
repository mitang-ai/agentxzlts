import sharp from "sharp";
import { AgentError } from "./protocol.mjs";
let busy = false;
export async function normalizeAvatar(bytes) {
  if (bytes.length > 2 * 1048576)
    throw new AgentError(413, "头像原图不能超过 2 MB。");
  const raster =
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
    (bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP");
  if (!raster) throw new AgentError(400, "请使用静态 PNG、JPEG 或 WebP 图片。");
  if (busy) throw new AgentError(429, "正在处理头像，请稍后重试。");
  busy = true;
  try {
    const image = sharp(bytes, {
        limitInputPixels: 16 * 1048576,
        animated: false,
        failOn: "warning",
      }),
      meta = await image.metadata();
    if (
      !["jpeg", "png", "webp"].includes(meta.format) ||
      (meta.pages || 1) !== 1
    )
      throw new AgentError(400, "请使用静态 PNG、JPEG 或 WebP 图片。");
    // No withMetadata(): EXIF/GPS, profiles, comments and original bytes are discarded.
    return await image
      .rotate()
      .resize(256, 256, { fit: "cover" })
      .webp({ quality: 80 })
      .toBuffer();
  } catch (e) {
    if (e instanceof AgentError) throw e;
    throw new AgentError(400, "头像图片损坏或尺寸过大，请换一张静态图片。");
  } finally {
    busy = false;
  }
}
export async function uploadAvatar(service, userId, bytes) {
  const value = await normalizeAvatar(bytes);
  return service.transaction(async (db) => {
    await service.owner(db, userId);
    if (!(await service.policy(db)).avatar_uploads)
      throw new AgentError(403, "头像上传暂时关闭。");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `avatar:${userId}`,
    ]);
    // Collect abandoned uploads, but never delete a currently referenced avatar.
    await db.query(
      `delete from avatar_assets a where owner_user_id=$1 and created_at<now()-interval '1 hour'
   and not exists(select 1 from profiles where avatar_url='/api/avatars/'||a.id::text)
   and not exists(select 1 from agent_nodes where avatar_url='/api/avatars/'||a.id::text)`,
      [userId],
    );
    if (
      Number(
        (
          await db.query(
            "select count(*) n from avatar_assets where owner_user_id=$1",
            [userId],
          )
        ).rows[0].n,
      ) >= 30
    )
      throw new AgentError(429, "未保存的头像过多，请稍后再试。");
    const row = (
      await db.query(
        "insert into avatar_assets(owner_user_id,bytes) values($1,$2) returning id",
        [userId, value],
      )
    ).rows[0];
    return { avatar_url: `/api/avatars/${row.id}` };
  });
}
export async function readAvatar(service, userId, avatarId) {
  const a = (
    await service.pool.query(
      `select a.bytes from avatar_assets a where a.id=$1 and (a.owner_user_id=$2 or exists(
  select 1 from participants displayed join participants viewer on viewer.room_id=displayed.room_id
  where displayed.avatar_url='/api/avatars/'||a.id::text and displayed.status='active' and viewer.user_id=$2 and viewer.status='active'))`,
      [avatarId, userId],
    )
  ).rows[0];
  if (!a) throw new AgentError(404, "头像不存在或无权查看。");
  return a.bytes;
}
