import { it, expect } from "vitest";
import { mentionAt, insertMention } from "../apps/web/src/lib/mentions";
it("输入 @、中文过滤及光标中间提及，保留后面的正文", () => {
  expect(mentionAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  const text = "你好 @小 后面的正文",
    range = mentionAt(text, 5)!;
  expect(range.query).toBe("小");
  expect(insertMention(text, range, "小林 Agent").text).toBe(
    "你好 @小林 Agent  后面的正文",
  );
  expect(mentionAt("email@example.com", 17)).toBeNull();
  expect(mentionAt("@成员 已选中", 7)).toBeNull();
  expect(mentionAt("你好\n@机器人", 7)?.query).toBe("机器人");
});
