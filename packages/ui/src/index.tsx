import type { CSSProperties } from "react";
export const tokens = {
  accent: "#3678f5",
  text: "#202b3c",
  muted: "#8490a3",
  border: "#e9edf3",
  surface: "#f7f9fc",
};
const colors = [
  "#e8efff",
  "#fcecd8",
  "#e1f3ec",
  "#eee8fc",
  "#fbe5eb",
  "#e5f3f9",
];
export function ParticipantAvatar({
  name,
  src,
  size = 34,
  online,
}: {
  name: string;
  src?: string | null;
  size?: number;
  online?: boolean;
}) {
  const style: CSSProperties = {
    width: size,
    height: size,
    background:
      colors[
        Array.from(name).reduce((n, c) => n + c.charCodeAt(0), 0) %
          colors.length
      ],
    fontSize: size * 0.4,
  };
  return (
    <span className="avatar" style={style}>
      {src ? <img src={src} alt={name} /> : name.slice(0, 1)}
      {online !== undefined && (
        <i className={online ? "presence online" : "presence"} />
      )}
    </span>
  );
}
export function ConnectionSeat({
  participant,
}: {
  participant: { display_name: string; type: "human" | "agent" };
}) {
  return (
    <div className="connection-seat">
      <ParticipantAvatar name={participant.display_name} />
      <span>{participant.display_name}</span>
      <small>{participant.type === "agent" ? "Agent" : "成员"}</small>
    </div>
  );
}
