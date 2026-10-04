"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  MessageCircle,
  Bot,
  House,
  ListTodo,
  Settings,
  Plus,
  Search,
  ArrowLeft,
  ArrowRight,
  Send,
  Paperclip,
  Smile,
  AtSign,
  Users,
  MoreHorizontal,
  X,
  Copy,
  Reply,
  FileText,
  Download,
  Trash2,
  Crown,
  LogOut,
  RefreshCw,
  Link as LinkIcon,
  Image as ImageIcon,
  FolderOpen,
  CheckCircle2,
  Clock,
  Loader2,
  Flag,
} from "lucide-react";
import { useSite, SiteBrand, SiteFooter } from "@/components/SiteProvider";
import { ParticipantAvatar } from "@island/ui";
import ConnectionPanel from "./ConnectionPanel";
import MyAgents from "./MyAgents";
import AgentPreview from "./AgentPreview";
import AvatarEditor, { type AvatarEditorHandle } from "./AvatarEditor";
import {
  canManage,
  canUpdateTask,
  type Participant,
  type Room,
  type RoomState,
  type Message,
  type Task,
  type IslandFile,
} from "@island/protocol";
import { ApiError, api, cmd, time, day, size } from "@/lib/client";
import { mentionAt, insertMention } from "@/lib/mentions";
type User = {
  id: string;
  display_name: string;
  email: string;
  avatar_url: string | null;
};
type RichMessage = Message & {
  reactions?: { emoji: string; participant_id: string }[];
};
type Pending = {
  id: string;
  content: string;
  reply_to_message_id: string | null;
  mentioned_participant_ids: string[];
  failed: boolean;
};
function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          className={`modal ${wide ? "wide" : ""}`}
          aria-describedby={undefined}
        >
          <header>
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="关闭">
              <X size={19} />
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function Empty({
  icon = <MessageCircle size={30} />,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function Brand() {
  return <SiteBrand />;
}
function Auth({
  onLogin,
  notify,
}: {
  onLogin: (u: User) => void;
  notify: (s: string) => void;
}) {
  const site = useSite();
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const { user } = await api<{ user: User }>(
        `auth/${register ? "register" : "login"}`,
        values,
      );
      onLogin(user);
      window.dispatchEvent(new Event("island:session"));
      notify(register ? "欢迎来到协作岛" : "欢迎回来");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-top">
        <Brand />
        <span>简单 · 协作 · 更近</span>
      </div>
      <div className="auth-layout">
        <section className="auth-intro">
          <span className="eyebrow">让沟通自然变成协作</span>
          <h1>
            一个人，是想法。
            <br />
            一群人，是<span>{site.config.brand.name}。</span>
          </h1>
          <p>{site.config.brand.intro}</p>
          <div className="intro-points">
            <span>
              <MessageCircle size={18} /> 聊在一起
            </span>
            <span>
              <ListTodo size={18} /> 分工清楚
            </span>
            <span>
              <FolderOpen size={18} /> 文件随手可得
            </span>
          </div>
        </section>
        <section className="auth-card">
          <Brand />
          <h2>{register ? "开始你的协作之旅" : "很高兴，再次见到你"}</h2>
          <div className="auth-switch">
            <button
              className={!register ? "active" : ""}
              onClick={() => {
                setRegister(false);
                setError("");
              }}
            >
              登录
            </button>
            <button
              disabled={
                !site.config.operations.registration ||
                site.config.operations.maintenance
              }
              className={register ? "active" : ""}
              onClick={() => {
                setRegister(true);
                setError("");
              }}
            >
              注册
            </button>
          </div>
          <form onSubmit={submit}>
            {register && (
              <label>
                昵称
                <input
                  name="display_name"
                  placeholder="大家怎么称呼你？"
                  required
                  maxLength={40}
                  autoComplete="nickname"
                />
              </label>
            )}
            <label>
              邮箱
              <input
                name="email"
                type="email"
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                placeholder="至少 8 位密码"
                required
                minLength={8}
                maxLength={128}
                autoComplete={register ? "new-password" : "current-password"}
              />
            </label>
            {error && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
            <button className="primary full" disabled={busy}>
              {busy ? <Loader2 className="spin" size={17} /> : null}
              {register ? "创建账号" : `登录${site.config.brand.name}`}
              <ArrowRight size={17} />
            </button>
          </form>
          <p className="auth-note">
            {register
              ? "无需邮箱验证码，注册后即可开始协作。"
              : "你的房间、消息和分工，都在这里。"}
          </p>
        </section>
      </div>
      <footer>
        把想法放在一起，把事情一起做好。
        <div className="auth-resources">
          <a href="/guide" target="_blank" rel="noopener noreferrer">
            操作指南
          </a>
          <a href="/guide#download" target="_blank" rel="noopener noreferrer">
            Windows 客户端
          </a>
        </div>
      </footer>
      <SiteFooter />
    </main>
  );
}
export default function Island() {
  const site = useSite();
  const [user, setUser] = useState<User | null>(null);
  const [initial, setInitial] = useState(true);
  const [toast, setToast] = useState("");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [state, setState] = useState<RoomState | null>(null);
  const [primary, setPrimary] = useState<
    "chat" | "rooms" | "tasks" | "connections" | "my-agents" | "agent-preview"
  >("chat");
  const [tab, setTab] = useState<
    "chat" | "tasks" | "files" | "connections" | "collaboration"
  >("chat");
  const [modal, setModal] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [memberFilter, setMemberFilter] = useState("");
  const [connection, setConnection] = useState("连接中");
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState<Message | null>(null);
  const [picker, setPicker] = useState<"emoji" | "mention" | null>(null);
  const [mentions, setMentions] = useState<string[]>([]);
  const [mentionRange, setMentionRange] =
    useState<ReturnType<typeof mentionAt>>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const composing = useRef(false);
  const dismissedMention = useRef<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [source, setSource] = useState<Message | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    text: string;
    action: () => Promise<void>;
  } | null>(null);
  const [globalTasks, setGlobalTasks] = useState<
    (Task & { room_name: string; room_icon: string })[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [inviteToken, setInviteToken] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const currentRef = useRef(roomId);
  currentRef.current = roomId;
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const cursor = useRef(0);
  const loadingRef = useRef(false);
  const refreshAgain = useRef(false);
  const notify = useCallback((text: string) => setToast(text), []);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    api<{ user: User }>("auth/me")
      .then((r) => setUser(r.user))
      .catch(() => {})
      .finally(() => setInitial(false));
    const token = new URLSearchParams(location.search).get("invite");
    if (token) {
      setInviteToken(token);
      setModal("join");
    }
  }, []);
  const refreshRooms = useCallback(async () => {
    try {
      const data = await api<{ rooms: Room[] }>("rooms");
      setRooms(data.rooms);
    } catch (e) {
      if (e instanceof ApiError) notify(e.message);
    }
  }, [notify]);
  const load = useCallback(
    async (id: string, reset = false) => {
      if (loadingRef.current && !reset) {
        refreshAgain.current = true;
        return;
      }
      loadingRef.current = true;
      try {
        const data = await api<RoomState>(`rooms/${id}`);
        if (currentRef.current !== id) return;
        cursor.current = Math.max(cursor.current, data.cursor);
        sessionStorage.setItem(`island:cursor:${id}`, String(cursor.current));
        setState((prev) => {
          if (reset || prev?.room.id !== id) return data;
          const latest = new Map(data.messages.map((m) => [m.id, m]));
          return {
            ...data,
            messages: [
              ...prev.messages.filter(
                (m) =>
                  !latest.has(m.id) &&
                  m.created_at < (data.messages[0]?.created_at || ""),
              ),
              ...data.messages,
            ],
          };
        });
        if (reset) setHasMore(data.has_more);
        setPending((prev) =>
          prev.filter(
            (p) => !data.messages.some((m) => m.client_message_id === p.id),
          ),
        );
        if (document.visibilityState === "visible")
          void cmd("read", { room_id: id, cursor: data.cursor })
            .then(refreshRooms)
            .catch(() => {});
        return data;
      } catch (e) {
        if (currentRef.current === id) {
          if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
            notify(e.message);
            setRoomId(null);
            setState(null);
            void refreshRooms();
          } else {
            setConnection("暂时断开");
          }
        }
      } finally {
        loadingRef.current = false;
        if (refreshAgain.current) {
          refreshAgain.current = false;
          const next = currentRef.current;
          if (next) void load(next);
        }
      }
    },
    [notify, refreshRooms],
  );
  useEffect(() => {
    if (!user) return;
    void refreshRooms();
    const timer = setInterval(() => void refreshRooms(), 15000);
    return () => clearInterval(timer);
  }, [user, refreshRooms]);
  useEffect(() => {
    const refresh = (event: Event) => {
      // A data refresh acknowledges the native shell request without reloading
      // the document, so drafts, reply selections and open editors survive.
      event.preventDefault();
      if (!user) return;
      void refreshRooms();
      const id = currentRef.current;
      if (id) void load(id);
      if (primary === "tasks")
        void api<{
          tasks: (Task & { room_name: string; room_icon: string })[];
        }>("tasks")
          .then((data) => setGlobalTasks(data.tasks))
          .catch((error) => notify((error as Error).message));
    };
    window.addEventListener("island-desktop-refresh", refresh);
    return () => window.removeEventListener("island-desktop-refresh", refresh);
  }, [user, primary, refreshRooms, load, notify]);
  useEffect(() => {
    if (!roomId || !user) return;
    let disposed = false;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setState(null);
    setPending([]);
    setDraft("");
    setReply(null);
    setMentions([]);
    setMentionRange(null);
    setPicker(null);
    setConnection("连接中");
    cursor.current = Number(
      sessionStorage.getItem(`island:cursor:${roomId}`) || 0,
    );
    setLoading(true);
    void load(roomId, true).finally(() => {
      setLoading(false);
      if (!disposed) connect();
    });
    function schedule() {
      if (!refreshTimer)
        refreshTimer = setTimeout(() => {
          refreshTimer = undefined;
          void load(roomId!);
        }, 70);
    }
    function connect() {
      if (disposed) return;
      es?.close();
      setConnection(cursor.current ? "重新同步" : "连接中");
      es = new EventSource(
        `/api/rooms/${roomId}/events?stream=1&after=${cursor.current}`,
      );
      es.addEventListener("ready", () => {
        setConnection("重新同步");
      });
      es.addEventListener("island", (event) => {
        cursor.current = Math.max(
          cursor.current,
          Number((event as MessageEvent).lastEventId),
        );
        sessionStorage.setItem(
          `island:cursor:${roomId}`,
          String(cursor.current),
        );
        schedule();
      });
      es.addEventListener("synced", () => {
        setConnection("已连接");
        schedule();
      });
      es.addEventListener("expired", () => {
        es?.close();
        setUser(null);
        setState(null);
        setRoomId(null);
        notify("登录已过期，请重新登录");
      });
      es.addEventListener("retrying", () => {
        setConnection("暂时断开");
        es?.close();
        timer = setTimeout(connect, 2000);
      });
      es.addEventListener("refresh", connect);
      es.addEventListener("revoked", () => {
        es?.close();
        setRoomId(null);
        setState(null);
        notify("房间访问权限已变化");
        void refreshRooms();
      });
      es.onerror = () => {
        setConnection("暂时断开");
        es?.close();
        timer = setTimeout(connect, 2000);
      };
    }
    const presence = () => {
      if (navigator.onLine)
        void cmd("presence", {
          room_id: roomId,
          offline: false,
        }).catch(() => {});
    };
    presence();
    const heartbeat = setInterval(presence, 20000);
    const online = () => connect();
    const offline = () => {
      es?.close();
      setConnection("暂时断开");
    };
    const visible = () => {
      presence();
      if (document.visibilityState === "visible") {
        void load(roomId);
        connect();
      }
    };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      es?.close();
      clearTimeout(timer);
      clearTimeout(refreshTimer);
      clearInterval(heartbeat);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visible);
      // 关闭单个标签页不能把另一条仍存活的连接上报为离线。
    };
  }, [roomId, user, load, notify, refreshRooms]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state?.messages.at(-1)?.id, pending.length, tab]);
  useEffect(() => {
    if (primary === "tasks" && user)
      api<{ tasks: (Task & { room_name: string; room_icon: string })[] }>(
        "tasks",
      )
        .then((r) => setGlobalTasks(r.tasks))
        .catch((e) => notify(e.message));
  }, [primary, user, state, notify]);
  useEffect(() => {
    const warning = (e: Event) =>
      notify((e as CustomEvent).detail || "收到管理员提示");
    window.addEventListener("island:warning", warning);
    const expired = () => {
      setUser(null);
      setRoomId(null);
      setState(null);
      notify("登录已过期，请重新登录");
    };
    window.addEventListener("island:session-expired", expired);
    return () => {
      window.removeEventListener("island:session-expired", expired);
      window.removeEventListener("island:warning", warning);
    };
  }, [notify]);
  useEffect(() => {
    if (site.user && user?.id === site.user.id)
      setUser((prev) =>
        prev &&
        prev.display_name === site.user!.display_name &&
        prev.avatar_url === site.user!.avatar_url
          ? prev
          : site.user,
      );
    if (user) {
      void refreshRooms();
      if (roomId) void load(roomId);
    }
  }, [site.cursor]);
  const caps = state?.capabilities || site.capabilities;
  const writable = state?.room.status !== "frozen";
  useEffect(() => {
    if (tab === "tasks" && !caps.tasks) setTab("chat");
    if (tab === "files" && !caps.uploads) setTab("chat");
    if (tab === "connections" && (!caps.agents || !caps.connection_seat)) {
      setTab("chat");
      setPrimary("chat");
    }
    if (primary === "tasks" && !caps.tasks) setPrimary("chat");
  }, [
    caps.tasks,
    caps.uploads,
    caps.agents,
    caps.connection_seat,
    tab,
    primary,
  ]);
  const me = state?.participants.find(
    (p) => p.user_id === user?.id && p.status === "active",
  );
  const host = Boolean(me && state && canManage(state.room, me));
  const members =
    state?.participants.filter((p) => p.status === "active") || [];
  const mentionCandidates = members.filter((p) =>
    p.display_name
      .toLocaleLowerCase()
      .includes((mentionRange?.query || "").toLocaleLowerCase()),
  );
  const updateMention = (text: string, caret: number) => {
    const key = JSON.stringify([text, caret]);
    if (dismissedMention.current === key) return;
    dismissedMention.current = null;
    const range = mentionAt(text, caret);
    setMentionRange(range);
    if (
      range?.start !== mentionRange?.start ||
      range?.end !== mentionRange?.end ||
      range?.query !== mentionRange?.query
    )
      setMentionIndex(0);
    setPicker((current) =>
      range ? "mention" : current === "mention" ? null : current,
    );
  };
  const selectRoom = (id: string) => {
    setRoomId(id);
    setPrimary("chat");
    setTab("chat");
    setFilter("all");
    setPicker(null);
  };
  const run = async (name: string, data: Record<string, unknown>) => {
    try {
      const result = await cmd(name, { room_id: roomId, ...data });
      if (roomId) await load(roomId);
      await refreshRooms();
      return result;
    } catch (e) {
      notify((e as Error).message);
      throw e;
    }
  };
  async function sendItem(item: Pending) {
    try {
      await cmd("message", {
        room_id: roomId,
        content: item.content,
        client_message_id: item.id,
        reply_to_message_id: item.reply_to_message_id,
        mentioned_participant_ids: item.mentioned_participant_ids,
      });
      if (roomId) await load(roomId);
    } catch {
      setPending((p) =>
        p.map((x) => (x.id === item.id ? { ...x, failed: true } : x)),
      );
    }
  }
  function send() {
    const content = draft.trim();
    if (!content || !roomId || !writable || !caps.post) return;
    const item = {
      id: crypto.randomUUID(),
      content,
      reply_to_message_id: reply?.id || null,
      mentioned_participant_ids: mentions.filter((id) =>
        members.some(
          (p) => p.id === id && content.includes(`@${p.display_name}`),
        ),
      ),
      failed: false,
    };
    setPending((p) => [...p, item]);
    setDraft("");
    setReply(null);
    setMentions([]);
    setPicker(null);
    void sendItem(item);
    inputRef.current?.focus();
  }
  async function upload(file?: File) {
    if (!file || !roomId || !writable || !caps.uploads) return;
    setUploading(true);
    const form = new FormData();
    form.set("file", file);
    try {
      await api(`rooms/${roomId}/files`, form);
      await load(roomId);
      notify("文件上传成功");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  const startTask = (message?: Message) => {
    if (!writable || !caps.tasks) return;
    setTask(null);
    setSource(message || null);
    setModal("task");
  };
  const openTask = (t: Task) => {
    setTask(t);
    setSource(
      state?.messages.find((m) => m.id === t.source_message_id) ||
        t.source_message ||
        null,
    );
    setModal("task");
  };
  const ask = (title: string, text: string, action: () => Promise<void>) =>
    setConfirm({ title, text, action });
  const mention = (p: Participant) => {
    const caret = inputRef.current?.selectionStart ?? draft.length;
    const insertion = insertMention(
      draft,
      mentionRange || { start: caret, end: caret },
      p.display_name,
    );
    setDraft(insertion.text);
    setMentions((ids) => [...new Set([...ids, p.id])]);
    setPicker(null);
    setMentionRange(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(insertion.caret, insertion.caret);
    });
  };
  async function more() {
    if (!state) return;
    const first = state.messages[0];
    if (!first) return;
    const old = await api<RoomState>(
      `rooms/${roomId}?before=${encodeURIComponent(first.created_at + "|" + first.id)}`,
    );
    setState((current) =>
      current
        ? { ...current, messages: [...old.messages, ...current.messages] }
        : current,
    );
    setHasMore(old.has_more);
  }
  const activeTasks = (state?.tasks || []).filter(
    (t) =>
      filter === "all" ||
      (filter === "mine" &&
        t.task_assignees.some((a) => a.participant_id === me?.id)) ||
      (filter === "member" &&
        (!memberFilter ||
          t.task_assignees.some((a) => a.participant_id === memberFilter))),
  );
  if (initial)
    return (
      <main className="splash">
        <Brand />
        <Loader2 className="spin" />
      </main>
    );
  const toastUI = toast && (
    <div role="status" className="toast">
      {toast}
      <button aria-label="关闭通知" onClick={() => setToast("")}>
        <X size={15} />
      </button>
    </div>
  );
  if (site.config.operations.maintenance && !site.user?.admin_role)
    return (
      <main className="splash">
        <Brand />
        <h1>网站维护中</h1>
        <p>{site.config.operations.maintenance_message}</p>
        <a href="/admin">管理员入口</a>
      </main>
    );
  if (!user)
    return (
      <>
        <Auth onLogin={setUser} notify={notify} />
        {toastUI}
      </>
    );
  return (
    <div
      className={`app ${roomId ? "room-open" : ""} ${["tasks", "my-agents", "agent-preview"].includes(primary) ? "tasks-open" : ""}`}
    >
      <aside className="rail" aria-label="协作岛导航">
        <SiteBrand rail />
        <nav aria-label="主要功能">
          {[
            { key: "chat", label: "聊天", icon: <MessageCircle size={21} /> },
            { key: "rooms", label: "房间", icon: <House size={21} /> },
            { key: "tasks", label: "任务", icon: <ListTodo size={21} /> },
            { key: "my-agents", label: "我的 Agent", icon: <Bot size={21} /> },
            {
              key: "agent-preview",
              label: "自研 Agent",
              icon: <Bot size={21} />,
            },
          ]
            .filter(
              (n) =>
                (n.key !== "tasks" || caps.tasks) &&
                (n.key !== "connections" ||
                  (caps.agents && caps.connection_seat)),
            )
            .map((n) => (
              <button
                key={n.key}
                className={primary === n.key ? "selected" : ""}
                onClick={() => {
                  setPrimary(n.key as typeof primary);
                  if (n.key === "connections") setTab("connections");
                  if (n.key === "rooms") setRoomId(null);
                }}
                aria-label={n.label}
                title={n.label}
              >
                {n.icon}
                <span>{n.label}</span>
              </button>
            ))}
        </nav>
        <div className="rail-bottom">
          <a
            className="rail-resource"
            href="/guide"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="操作指南"
            title="操作指南"
          >
            <FileText size={20} />
            <span>操作指南</span>
          </a>
          <a
            className="rail-resource"
            href="/guide#download"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Windows 客户端下载"
            title="Windows 客户端下载"
          >
            <Download size={20} />
            <span>客户端下载</span>
          </a>
          <button
            className="rail-resource"
            aria-label="刷新界面"
            title="刷新数据，不重启 Agent"
            onClick={() =>
              window.dispatchEvent(
                new Event("island-desktop-refresh", { cancelable: true }),
              )
            }
          >
            <RefreshCw size={20} />
            <span>刷新</span>
          </button>
          <button
            className="rail-settings"
            aria-label="设置"
            title="设置"
            onClick={() => setModal("profile")}
          >
            <Settings size={21} />
            <span>设置</span>
          </button>
          <button
            aria-label="个人资料"
            title="个人资料"
            onClick={() => setModal("profile")}
          >
            <ParticipantAvatar
              name={user.display_name}
              src={user.avatar_url}
              size={36}
            />
          </button>
        </div>
      </aside>
      <aside className="room-list">
        <header>
          <h1>{primary === "rooms" ? "房间" : "聊天"}</h1>
          <button
            className="icon-button"
            aria-label="创建房间"
            disabled={!site.capabilities.create_room}
            onClick={() => setModal("create")}
          >
            <Plus size={20} />
          </button>
        </header>
        <div className="room-search">
          <Search size={16} />
          <input
            placeholder="搜索房间"
            aria-label="搜索房间"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="room-items">
          {rooms
            .filter((r) => r.name.includes(search))
            .map((r) => (
              <button
                key={r.id}
                className={`room-item ${roomId === r.id ? "active" : ""}`}
                onClick={() => selectRoom(r.id)}
              >
                <span className="room-icon">{r.icon}</span>
                <span className="room-item-body">
                  <strong>{r.name}</strong>
                  <small>{r.last_message || "一起聊点什么吧"}</small>
                </span>
                <span className="room-meta">
                  <small>
                    {new Date(
                      r.last_message_at || r.updated_at,
                    ).toDateString() === new Date().toDateString()
                      ? time(r.last_message_at || r.updated_at)
                      : day(r.last_message_at || r.updated_at)}
                  </small>
                  {!!r.unread_count && (
                    <b>{r.unread_count > 99 ? "99+" : r.unread_count}</b>
                  )}
                </span>
              </button>
            ))}
          {!rooms.length && (
            <div className="list-empty">
              你的第一个房间
              <br />
              从这里开始。
            </div>
          )}
        </div>
        <button className="join-link" onClick={() => setModal("join")}>
          <LinkIcon size={16} />
          通过邀请加入房间
        </button>
      </aside>
      <main className="workspace">
        {primary === "my-agents" ? (
          <MyAgents rooms={rooms} notify={notify} />
        ) : primary === "agent-preview" ? (
          <AgentPreview />
        ) : primary === "tasks" ? (
          <>
            <header className="aggregate-header">
              <h1>我的任务</h1>
              <p>每件小事，都有一个着落。</p>
            </header>
            <div className="aggregate-tasks">
              {globalTasks.length ? (
                globalTasks.map((t) => (
                  <button
                    className="aggregate-task"
                    key={t.id}
                    onClick={() => {
                      selectRoom(t.room_id);
                      setTab("tasks");
                    }}
                  >
                    <span>{t.room_icon}</span>
                    <div>
                      <strong>{t.title}</strong>
                      <small>
                        {t.room_name}
                        {t.due_at ? ` · ${day(t.due_at)}截止` : ""}
                      </small>
                    </div>
                    <span className={`status ${t.status}`}>
                      {statusNames[t.status]}
                    </span>
                    <ArrowRight size={17} />
                  </button>
                ))
              ) : (
                <Empty
                  icon={<ListTodo size={30} />}
                  title="暂时没有分配给你的任务"
                >
                  在房间里创建任务，让分工更清楚。
                </Empty>
              )}
            </div>
          </>
        ) : !roomId ? (
          <div className="welcome">
            <span className="welcome-icon">🏝️</span>
            <span className="eyebrow">欢迎回来，{user.display_name}</span>
            <h1>让想法，在这里相遇。</h1>
            <p>
              和朋友、小伙伴或你的团队，
              <br />
              在一个房间里，聊天、分工、一起完成。
            </p>
            <div className="welcome-actions">
              <button
                className="primary"
                disabled={!site.capabilities.create_room}
                onClick={() => setModal("create")}
              >
                <Plus size={17} />
                创建房间
              </button>
              <button className="secondary" onClick={() => setModal("join")}>
                <LinkIcon size={17} />
                加入房间
              </button>
            </div>
            <div className="welcome-note">
              <MessageCircle size={16} />
              从一句「我们一起做吧」开始。
            </div>
          </div>
        ) : !state || loading ? (
          <div className="splash">
            <Loader2 className="spin" />
            {connection === "暂时断开"
              ? "暂时无法连接，正在重试…"
              : "正在进入房间…"}
          </div>
        ) : (
          <>
            <header className="room-header">
              <button
                className="icon-button mobile-back"
                aria-label="返回房间列表"
                onClick={() => {
                  setRoomId(null);
                  setState(null);
                }}
              >
                <ArrowLeft size={21} />
              </button>
              <span className="room-icon large">{state.room.icon}</span>
              <div>
                <h1>{state.room.name}</h1>
                <span className="room-subtitle">
                  <Users size={13} />
                  {members.length} 位成员
                  <span
                    className={`connection ${connection === "已连接" ? "connected" : ""}`}
                  >
                    <i />
                    {connection}
                  </span>
                </span>
              </div>
              <div className="header-actions">
                <button
                  className="secondary compact"
                  onClick={() => setModal("members")}
                >
                  <Users size={16} />
                  <span>成员</span>
                </button>
                {host && (
                  <button
                    className="primary compact"
                    disabled={!writable}
                    onClick={() => setModal("invite")}
                  >
                    <Plus size={15} />
                    <span>邀请</span>
                  </button>
                )}
                <button
                  className="icon-button"
                  aria-label="房间设置"
                  onClick={() => setModal("room")}
                >
                  <MoreHorizontal size={22} />
                </button>
              </div>
            </header>
            {!writable && (
              <div className="room-readonly" role="status">
                房间已冻结，当前只读
              </div>
            )}
            {!caps.post && (
              <div className="room-readonly" role="status">
                当前账号被限制发言
              </div>
            )}
            <div className="tabs">
              <div>
                {[
                  { key: "chat", label: "聊天" },
                  { key: "files", label: "文件" },
                  { key: "tasks", label: "任务" },
                  { key: "connections", label: "联机席位" },
                  { key: "collaboration", label: "协作控制台" },
                ]
                  .filter(
                    (t) =>
                      t.key === "chat" ||
                      (t.key === "tasks"
                        ? caps.tasks
                        : ["connections", "collaboration"].includes(t.key)
                          ? caps.agents && caps.connection_seat
                          : caps.uploads),
                  )
                  .map((t) => (
                    <button
                      key={t.key}
                      className={tab === t.key ? "active" : ""}
                      onClick={() => setTab(t.key as typeof tab)}
                    >
                      {t.label}
                    </button>
                  ))}
              </div>
              <span className="tab-caption">
                {tab === "chat"
                  ? "沟通，让协作自然发生"
                  : tab === "tasks"
                    ? "谁负责哪一块，一目了然"
                    : tab === "connections"
                      ? "连接远端设备，主持讨论与开发"
                      : "共同分享，随时找到"}
              </span>
            </div>
            {["connections", "collaboration"].includes(tab) ? (
              <ConnectionPanel
                key={roomId + tab}
                view={tab === "collaboration" ? "collaboration" : "seats"}
                openMyAgents={() => setPrimary("my-agents")}
                state={state}
                notify={notify}
                onChanged={async () => {
                  await load(roomId);
                }}
              />
            ) : tab === "chat" ? (
              <>
                <div className="messages" role="log" aria-label="聊天消息">
                  <div className="message-inner">
                    {hasMore && (
                      <button
                        className="history-button"
                        onClick={() =>
                          void more().catch((e) => notify(e.message))
                        }
                      >
                        加载更早的消息
                      </button>
                    )}
                    <div className="day-divider">
                      <span>
                        {state.messages[0]
                          ? day(state.messages[0].created_at)
                          : "今天"}
                      </span>
                    </div>
                    {state.messages.length === 0 && (
                      <Empty title="新的协作，从一句话开始">
                        打个招呼，把大家的想法聊在一起。
                      </Empty>
                    )}
                    {state.messages.map((message, index) => {
                      const m = message as RichMessage;
                      const p = state.participants.find(
                        (p) => p.id === m.sender_participant_id,
                      );
                      const file = state.files.find((f) => f.id === m.file_id);
                      const linked = state.tasks.find(
                        (t) => t.id === m.task_id,
                      );
                      const quote =
                        state.messages.find(
                          (x) => x.id === m.reply_to_message_id,
                        ) || m.reply_context;
                      if (m.type === "system")
                        return (
                          <div className="system-message" key={m.id}>
                            {m.content}
                          </div>
                        );
                      return (
                        <div
                          className="message"
                          key={m.id}
                          id={`message-${m.id}`}
                        >
                          <ParticipantAvatar
                            name={p?.display_name || "成员"}
                            src={p?.avatar_url}
                          />
                          <div className="message-main">
                            <div className="message-meta">
                              <strong>{p?.display_name || "成员"}</strong>
                              {p?.type === "agent" && (
                                <span className="host-badge">
                                  <Bot size={11} />
                                  {p.id === state.room.agent_host_participant_id
                                    ? "Agent 主持人"
                                    : "Agent"}
                                </span>
                              )}
                              {p?.id === state.room.host_participant_id && (
                                <span className="host-badge">
                                  <Crown size={11} />
                                  主持人
                                </span>
                              )}
                              <time>{time(m.created_at)}</time>
                            </div>
                            {quote && (
                              <button
                                className="reply-quote"
                                onClick={() =>
                                  document
                                    .getElementById(`message-${quote.id}`)
                                    ?.scrollIntoView({
                                      behavior: "smooth",
                                      block: "center",
                                    })
                                }
                              >
                                <Reply size={13} />
                                {
                                  state.participants.find(
                                    (p) => p.id === quote.sender_participant_id,
                                  )?.display_name
                                }
                                ：
                                {quote.deleted_at
                                  ? "消息已撤回"
                                  : quote.content.slice(0, 90)}
                              </button>
                            )}
                            {m.deleted_at ? (
                              <span className="withdrawn">这条消息已撤回</span>
                            ) : m.type === "file" && file ? (
                              <FileBubble file={file} />
                            ) : m.type === "task" && linked ? (
                              <button
                                className="task-message"
                                onClick={() => openTask(linked)}
                              >
                                <ListTodo size={20} />
                                <span>
                                  <small>创建了一个任务</small>
                                  <strong>{linked.title}</strong>
                                </span>
                                <span className={`status ${linked.status}`}>
                                  {statusNames[linked.status]}
                                </span>
                              </button>
                            ) : (
                              <div className="message-text">
                                {m.content
                                  .split(/(@[^\s]+)/g)
                                  .map((text, i) => (
                                    <span
                                      key={i}
                                      className={
                                        text.startsWith("@")
                                          ? "mention-text"
                                          : ""
                                      }
                                    >
                                      {text}
                                    </span>
                                  ))}
                              </div>
                            )}
                            {!!m.reactions?.length && (
                              <div className="reactions">
                                {[
                                  ...new Set(m.reactions.map((r) => r.emoji)),
                                ].map((emoji) => (
                                  <button
                                    key={emoji}
                                    onClick={() =>
                                      void run("react", {
                                        message_id: m.id,
                                        emoji,
                                      }).catch(() => {})
                                    }
                                    className={
                                      m.reactions?.some(
                                        (r) =>
                                          r.emoji === emoji &&
                                          r.participant_id === me?.id,
                                      )
                                        ? "mine"
                                        : ""
                                    }
                                  >
                                    {emoji}{" "}
                                    {
                                      m.reactions?.filter(
                                        (r) => r.emoji === emoji,
                                      ).length
                                    }
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                          {!m.deleted_at && (
                            <div className="message-actions">
                              <button
                                title="回复"
                                aria-label={`回复消息 ${index + 1}`}
                                onClick={() => {
                                  setReply(m);
                                  inputRef.current?.focus();
                                }}
                              >
                                <Reply size={15} />
                              </button>
                              {p && (
                                <button
                                  title="@成员"
                                  onClick={() => mention(p)}
                                >
                                  <AtSign size={15} />
                                </button>
                              )}
                              <button
                                disabled={!writable}
                                title="回应"
                                onClick={() =>
                                  void run("react", {
                                    message_id: m.id,
                                    emoji: "👍",
                                  }).catch(() => {})
                                }
                              >
                                <Smile size={15} />
                              </button>
                              <button
                                title="举报消息"
                                aria-label={`举报消息 ${index + 1}`}
                                onClick={() => setModal(`report:${m.id}`)}
                              >
                                <MoreHorizontal size={15} />
                              </button>
                              <button
                                title="复制消息"
                                onClick={() =>
                                  void navigator.clipboard
                                    .writeText(m.content)
                                    .then(() => notify("已复制"))
                                    .catch(() => notify("浏览器不允许复制"))
                                }
                              >
                                <Copy size={15} />
                              </button>
                              <button
                                hidden={!caps.tasks}
                                disabled={!writable}
                                title="创建任务"
                                aria-label={`从消息创建任务 ${index + 1}`}
                                onClick={() => startTask(m)}
                              >
                                <ListTodo size={15} />
                              </button>
                              {m.sender_participant_id === me?.id &&
                                m.type === "text" && (
                                  <button
                                    title="撤回消息"
                                    onClick={() =>
                                      ask(
                                        "撤回消息",
                                        "撤回后，其他成员将无法看到这条消息的内容。",
                                        async () => {
                                          await run("delete_message", {
                                            message_id: m.id,
                                          });
                                        },
                                      )
                                    }
                                  >
                                    <Trash2 size={15} />
                                  </button>
                                )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {pending.map((p) => (
                      <div className="message pending-message" key={p.id}>
                        <ParticipantAvatar
                          name={user.display_name}
                          src={user.avatar_url}
                        />
                        <div className="message-main">
                          <div className="message-meta">
                            <strong>{user.display_name}</strong>
                          </div>
                          <div className="message-text">{p.content}</div>
                          {p.failed ? (
                            <button
                              className="send-failed"
                              onClick={() => {
                                setPending((items) =>
                                  items.map((x) =>
                                    x.id === p.id ? { ...x, failed: false } : x,
                                  ),
                                );
                                void sendItem(p);
                              }}
                            >
                              <RefreshCw size={13} />
                              发送失败，点击重试
                            </button>
                          ) : (
                            <small className="muted">发送中…</small>
                          )}
                        </div>
                      </div>
                    ))}
                    <div ref={endRef} />
                  </div>
                </div>
                <div className="composer-area">
                  {reply && (
                    <div className="reply-composer">
                      <Reply size={14} />
                      <span>
                        回复{" "}
                        {
                          state.participants.find(
                            (p) => p.id === reply.sender_participant_id,
                          )?.display_name
                        }
                        ：{reply.content.slice(0, 80)}
                      </span>
                      <button
                        aria-label="取消回复"
                        onClick={() => setReply(null)}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  )}
                  <div className="composer">
                    <button
                      className="icon-button"
                      aria-label="上传附件"
                      hidden={!caps.uploads}
                      disabled={uploading || !writable}
                      onClick={() => fileRef.current?.click()}
                    >
                      {uploading ? (
                        <Loader2 size={19} className="spin" />
                      ) : (
                        <Plus size={22} />
                      )}
                    </button>
                    <textarea
                      ref={inputRef}
                      aria-label="消息"
                      disabled={!writable || !caps.post}
                      placeholder={
                        !writable
                          ? "房间已冻结，当前只读"
                          : !caps.post
                            ? "当前被限制发言"
                            : "发送消息，让想法流动起来…"
                      }
                      value={draft}
                      maxLength={8000}
                      rows={1}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        if (
                          !composing.current &&
                          !(e.nativeEvent as InputEvent).isComposing
                        )
                          updateMention(
                            e.target.value,
                            e.target.selectionStart,
                          );
                      }}
                      onSelect={(e) => {
                        if (
                          !composing.current &&
                          document.activeElement === e.currentTarget
                        )
                          updateMention(
                            e.currentTarget.value,
                            e.currentTarget.selectionStart,
                          );
                      }}
                      onCompositionStart={() => {
                        composing.current = true;
                      }}
                      onCompositionEnd={(e) => {
                        composing.current = false;
                        updateMention(
                          e.currentTarget.value,
                          e.currentTarget.selectionStart,
                        );
                      }}
                      aria-expanded={picker === "mention"}
                      aria-controls={
                        picker === "mention" ? "mention-options" : undefined
                      }
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (picker === "mention") {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            dismissedMention.current = JSON.stringify([
                              draft,
                              e.currentTarget.selectionStart,
                            ]);
                            setPicker(null);
                            setMentionRange(null);
                            return;
                          }
                          if (["ArrowDown", "ArrowUp"].includes(e.key)) {
                            e.preventDefault();
                            setMentionIndex(
                              (i) =>
                                (i +
                                  (e.key === "ArrowDown" ? 1 : -1) +
                                  mentionCandidates.length) %
                                Math.max(1, mentionCandidates.length),
                            );
                            return;
                          }
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            if (mentionCandidates.length)
                              mention(
                                mentionCandidates[
                                  mentionIndex % mentionCandidates.length
                                ],
                              );
                            return;
                          }
                        }
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          send();
                        }
                      }}
                    />
                    <div className="composer-tools">
                      <button
                        className="icon-button"
                        aria-label="提及成员"
                        onClick={() => {
                          setMentionRange(null);
                          setMentionIndex(0);
                          setPicker(picker === "mention" ? null : "mention");
                        }}
                      >
                        <AtSign size={19} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="选择表情"
                        onClick={() =>
                          setPicker(picker === "emoji" ? null : "emoji")
                        }
                      >
                        <Smile size={20} />
                      </button>
                      <button
                        className="send-button"
                        aria-label="发送消息"
                        disabled={!draft.trim() || !writable || !caps.post}
                        onClick={send}
                      >
                        <Send size={19} />
                      </button>
                    </div>
                    {picker && (
                      <div className="composer-popover">
                        {picker === "emoji" ? (
                          <div className="emoji-picker">
                            {[
                              "😊",
                              "👍",
                              "❤️",
                              "🎉",
                              "✨",
                              "🙌",
                              "💡",
                              "✅",
                              "🏝️",
                              "🔥",
                              "👏",
                              "🤔",
                              "👀",
                              "🚀",
                              "☕",
                              "🌿",
                            ].map((emoji) => (
                              <button
                                key={emoji}
                                onClick={() => {
                                  setDraft((d) => d + emoji);
                                  setPicker(null);
                                  inputRef.current?.focus();
                                }}
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div
                            className="mention-picker"
                            id="mention-options"
                            role="listbox"
                            aria-label="提及房间成员"
                          >
                            <strong>提及房间成员</strong>
                            {!mentionCandidates.length && (
                              <small>没有匹配的成员或 Agent</small>
                            )}
                            {mentionCandidates.map((p, index) => (
                              <button
                                key={p.id}
                                role="option"
                                aria-selected={index === mentionIndex}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => mention(p)}
                              >
                                <ParticipantAvatar
                                  name={p.display_name}
                                  size={26}
                                />
                                {p.display_name}
                                <small>
                                  {p.type === "agent" ? "Agent" : "成员"}
                                </small>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <small className="composer-hint">
                    Enter 发送 · Shift + Enter 换行
                  </small>
                </div>
              </>
            ) : tab === "files" ? (
              <section className="files-view">
                <div className="section-toolbar">
                  <div>
                    <h2>
                      房间文件 <span>{state.files.length}</span>
                    </h2>
                    <p>大家共享的文件，都在这里。</p>
                  </div>
                  <button
                    className="primary compact"
                    hidden={!caps.uploads}
                    disabled={uploading || !writable}
                    onClick={() => fileRef.current?.click()}
                  >
                    <Paperclip size={16} />
                    {uploading ? "上传中…" : "上传文件"}
                  </button>
                </div>
                {state.files.length ? (
                  <div className="file-table">
                    <div className="file-table-head">
                      <span>名称</span>
                      <span>上传人</span>
                      <span>时间</span>
                      <span>大小</span>
                      <span />
                    </div>
                    {state.files.map((f) => (
                      <div className="file-row" key={f.id}>
                        <a
                          href={
                            f.status && f.status !== "normal"
                              ? undefined
                              : `/api/files/${f.id}`
                          }
                          className="file-name"
                        >
                          <FileIcon file={f} />
                          <span>{f.name}</span>
                        </a>
                        <span>
                          {
                            state.participants.find(
                              (p) => p.id === f.uploader_participant_id,
                            )?.display_name
                          }
                        </span>
                        <span>
                          {day(f.created_at)} {time(f.created_at)}
                        </span>
                        <span>
                          {f.status === "quarantined"
                            ? "已隔离"
                            : f.status === "deleted"
                              ? "已删除"
                              : size(f.size)}
                        </span>
                        <div className="file-actions">
                          <a
                            href={
                              f.status && f.status !== "normal"
                                ? undefined
                                : `/api/files/${f.id}`
                            }
                            aria-label={`下载 ${f.name}`}
                            className="icon-button"
                          >
                            <Download size={17} />
                          </a>
                          <button
                            className="icon-button"
                            aria-label={`举报文件 ${f.name}`}
                            onClick={() => setModal(`report:file:${f.id}`)}
                          >
                            <Flag size={15} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty icon={<FolderOpen size={32} />} title="还没有共享文件">
                    上传一份资料，让大家随时找到。支持常用文档与图片，最大
                    {site.config.operations.max_file_mb}MB。
                  </Empty>
                )}
              </section>
            ) : (
              <section className="tasks-view">
                <div className="section-toolbar">
                  <div className="task-filters">
                    {[
                      { key: "all", label: "全部" },
                      { key: "mine", label: "我的" },
                      { key: "member", label: "按成员" },
                    ].map((f) => (
                      <button
                        key={f.key}
                        className={filter === f.key ? "active" : ""}
                        onClick={() => setFilter(f.key)}
                      >
                        {f.label}
                      </button>
                    ))}
                    {filter === "member" && (
                      <select
                        aria-label="按成员筛选"
                        value={memberFilter}
                        onChange={(e) => setMemberFilter(e.target.value)}
                      >
                        <option value="">所有成员</option>
                        {members.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.display_name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <button
                    className="primary compact"
                    disabled={!writable}
                    onClick={() => startTask()}
                  >
                    <Plus size={16} />
                    新建任务
                  </button>
                </div>
                <div className="task-board">
                  {(["pending", "in_progress", "completed"] as const).map(
                    (status) => (
                      <section className={`task-column ${status}`} key={status}>
                        <header>
                          <span>
                            <i />
                            {statusNames[status]}
                          </span>
                          <b>
                            {
                              activeTasks.filter((t) => t.status === status)
                                .length
                            }
                          </b>
                        </header>
                        <div>
                          {activeTasks
                            .filter((t) => t.status === status)
                            .map((t) => (
                              <TaskCard
                                key={t.id}
                                task={t}
                                participants={state.participants}
                                onClick={() => openTask(t)}
                              />
                            ))}
                          {!activeTasks.some((t) => t.status === status) && (
                            <p className="column-empty">
                              {status === "completed"
                                ? "完成的小事，会在这里相聚"
                                : "暂时没有任务"}
                            </p>
                          )}
                        </div>
                        {status === "pending" && (
                          <button
                            disabled={!writable}
                            className="add-task"
                            onClick={() => startTask()}
                          >
                            <Plus size={14} />
                            添加任务
                          </button>
                        )}
                      </section>
                    ),
                  )}
                </div>
              </section>
            )}
          </>
        )}
      </main>
      {modal?.startsWith("report:") && (
        <ReportDialog
          targetId={modal.split(":")[2] || modal.slice(7)}
          targetType={modal.split(":")[2] ? modal.split(":")[1] : "message"}
          roomId={roomId!}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            notify("举报已提交");
          }}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        hidden
        accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv,.zip,.docx,.xlsx,.pptx"
        onChange={(e) => void upload(e.target.files?.[0])}
      />
      {(modal === "create" || modal === "edit") && (
        <RoomForm
          room={modal === "edit" ? state?.room : undefined}
          onClose={() => setModal(null)}
          onSave={async (values) => {
            if (modal === "edit") {
              await run("update_room", values);
              setModal(null);
            } else {
              const result = await cmd<{ id: string }>("create_room", values);
              await refreshRooms();
              selectRoom(result.id);
              setModal(null);
            }
          }}
        />
      )}
      {modal === "join" && (
        <JoinForm
          initial={inviteToken}
          onClose={() => setModal(null)}
          onJoin={async (token) => {
            const result = await cmd<{ id: string }>("join_invite", { token });
            await refreshRooms();
            selectRoom(result.id);
            setModal(null);
            history.replaceState({}, "", location.pathname);
          }}
        />
      )}
      {modal === "invite" && roomId && (
        <InviteDialog
          roomId={roomId}
          notify={notify}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "profile" && (
        <ProfileDialog
          user={user}
          onClose={() => setModal(null)}
          onSave={async (values) => {
            await cmd("profile", values);
            const { user: u } = await api<{ user: User }>("auth/me");
            setUser(u);
            setModal(null);
            if (roomId) await load(roomId);
          }}
          onLogout={async () => {
            await api("auth/logout", {});
            setUser(null);
            setState(null);
            setRoomId(null);
            setRooms([]);
            setPrimary("chat");
            setModal(null);
          }}
        />
      )}
      {modal === "members" && state && (
        <Modal
          title={`房间成员 · ${members.length}`}
          onClose={() => setModal(null)}
        >
          <div className="member-list">
            {members.map((p) => (
              <div className="member-row" key={p.id}>
                <ParticipantAvatar
                  name={p.display_name}
                  src={p.avatar_url}
                  online={p.online === true}
                  size={40}
                />
                <div>
                  <strong>
                    {p.display_name}
                    {p.type === "agent" && (
                      <small>
                        {" "}
                        Agent
                        {p.id === state.room.agent_host_participant_id
                          ? " 主持人"
                          : ""}
                      </small>
                    )}
                    {p.id === me?.id && <small>（你）</small>}
                  </strong>
                  <small>
                    {p.id === state.room.host_participant_id ? (
                      <span className="host-badge">
                        <Crown size={11} />
                        主持人
                      </span>
                    ) : p.online ? (
                      "在线"
                    ) : (
                      "离线"
                    )}
                  </small>
                </div>
                {p.user_id && p.id !== me?.id && (
                  <button
                    className="icon-button"
                    aria-label={`举报用户 ${p.display_name}`}
                    onClick={() => setModal(`report:user:${p.user_id}`)}
                  >
                    <Flag size={15} />
                  </button>
                )}
                {host && p.id !== me?.id && (
                  <div className="member-actions">
                    {p.type === "human" && (
                      <button
                        onClick={() =>
                          ask(
                            "转移主持人",
                            `确定将主持人转移给 ${p.display_name}？转移后，你将成为普通成员。`,
                            async () => {
                              await run("transfer_host", {
                                participant_id: p.id,
                              });
                              notify("主持人已转移");
                            },
                          )
                        }
                      >
                        转移主持人
                      </button>
                    )}
                    <button
                      className="danger-text"
                      onClick={() =>
                        ask(
                          "移除成员",
                          `确定将 ${p.display_name} 移出房间？`,
                          async () => {
                            await run("remove_member", {
                              participant_id: p.id,
                            });
                          },
                        )
                      }
                    >
                      移除
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {host && (
            <button
              className="secondary full"
              onClick={() => setModal("invite")}
            >
              <Plus size={16} />
              邀请朋友
            </button>
          )}
        </Modal>
      )}
      {modal === "room" && state && (
        <Modal title="房间详情" onClose={() => setModal(null)}>
          <div className="room-detail">
            <span className="room-icon large">{state.room.icon}</span>
            <h2>{state.room.name}</h2>
            <small>
              创建于{" "}
              {new Date(state.room.created_at).toLocaleDateString("zh-CN")}
            </small>
          </div>
          <button
            className="secondary full"
            onClick={() => setModal(`report:room:${state.room.id}`)}
          >
            <Flag size={15} />
            举报房间
          </button>
          <div className="detail-actions">
            <button onClick={() => setModal("members")}>
              <Users size={17} />
              查看成员
              <ArrowRight size={16} />
            </button>
            {host && (
              <>
                <button onClick={() => setModal("edit")}>
                  <Settings size={17} />
                  修改房间资料
                  <ArrowRight size={16} />
                </button>
                <button onClick={() => setModal("invite")}>
                  <LinkIcon size={17} />
                  管理邀请
                  <ArrowRight size={16} />
                </button>
              </>
            )}
            <button
              className="danger-text"
              onClick={() =>
                ask(
                  host ? "解散房间" : "离开房间",
                  host
                    ? "房间及全部消息、任务和文件记录将被删除，此操作无法撤销。"
                    : "离开后，你将无法访问房间消息和文件。",
                  async () => {
                    await cmd(host ? "delete_room" : "leave_room", {
                      room_id: roomId,
                    });
                    setRoomId(null);
                    setState(null);
                    setModal(null);
                    await refreshRooms();
                  },
                )
              }
            >
              <LogOut size={17} />
              {host ? "解散房间" : "离开房间"}
              <ArrowRight size={16} />
            </button>
          </div>
          {host && (
            <p className="muted small">
              想离开但保留房间？请先在成员列表转移主持人。
            </p>
          )}
        </Modal>
      )}
      {modal === "task" && state && me && (
        <TaskDialog
          task={task}
          source={source}
          state={state}
          me={me}
          onClose={() => {
            setModal(null);
            setSource(null);
          }}
          onSave={async (values) => {
            await run(task ? "update_task" : "create_task", {
              ...values,
              task_id: task?.id,
              source_message_id: source?.id || task?.source_message_id,
            });
            setModal(null);
            setSource(null);
            notify(task ? "任务已更新" : "任务已创建");
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          value={confirm}
          onClose={() => setConfirm(null)}
          notify={notify}
        />
      )}
      {toastUI}
    </div>
  );
}
const statusNames = {
  pending: "待处理",
  in_progress: "进行中",
  completed: "已完成",
};
function FileIcon({ file }: { file: IslandFile }) {
  return (
    <span
      className={`file-icon ${file.mime_type.startsWith("image/") ? "image" : file.mime_type === "application/pdf" ? "pdf" : "document"}`}
    >
      {file.mime_type.startsWith("image/") ? (
        <ImageIcon size={20} />
      ) : (
        <FileText size={20} />
      )}
    </span>
  );
}
function FileBubble({ file }: { file: IslandFile }) {
  if (file.status && file.status !== "normal")
    return (
      <div className="file-bubble unavailable">
        <FileIcon file={file} />
        <strong>{file.name}</strong>
        <small>
          {file.status === "quarantined" ? "文件已被隔离" : "文件已被删除"}
        </small>
      </div>
    );
  return (
    <div className="file-bubble">
      {file.mime_type.startsWith("image/") && (
        <a
          href={`/api/files/${file.id}?preview=1`}
          target="_blank"
          rel="noreferrer"
        >
          <img
            className="chat-image"
            src={`/api/files/${file.id}?preview=1`}
            alt={file.name}
          />
        </a>
      )}
      <a href={`/api/files/${file.id}`} className="file-bubble-info">
        <FileIcon file={file} />
        <span>
          <strong>{file.name}</strong>
          <small>{size(file.size)}</small>
        </span>
        <Download size={17} />
      </a>
    </div>
  );
}
function TaskCard({
  task: t,
  participants,
  onClick,
}: {
  task: Task;
  participants: Participant[];
  onClick: () => void;
}) {
  const overdue =
    t.due_at &&
    new Date(t.due_at).getTime() < Date.now() &&
    t.status !== "completed";
  return (
    <button className="task-card" onClick={onClick}>
      <div>
        {t.status === "completed" ? (
          <CheckCircle2 size={16} />
        ) : (
          <span className="task-checkbox" />
        )}
        <strong>{t.title}</strong>
      </div>
      {t.due_at && (
        <small className={overdue ? "danger-text" : ""}>
          <Clock size={12} />
          {day(t.due_at)}
          {overdue ? " 已逾期" : "截止"}
        </small>
      )}
      <div className="task-people">
        {t.task_assignees.map((a) => {
          const p = participants.find((p) => p.id === a.participant_id);
          return p ? (
            <span key={p.id}>
              <ParticipantAvatar
                name={p.display_name}
                src={p.avatar_url}
                size={22}
              />
              {p.display_name}
            </span>
          ) : null;
        })}
        {!t.task_assignees.length && <small>尚未分配负责人</small>}
      </div>
    </button>
  );
}
function ErrorLine({ error }: { error: string }) {
  return error ? (
    <p className="error-text" role="alert">
      {error}
    </p>
  ) : null;
}
function RoomForm({
  room,
  onClose,
  onSave,
}: {
  room?: Room;
  onClose: () => void;
  onSave: (values: { name: string; icon: string }) => Promise<void>;
}) {
  const [icon, setIcon] = useState(room?.icon || "🏝️");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={room ? "修改房间" : "创建一个新房间"} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setBusy(true);
          try {
            await onSave({ name: String(data.get("name")).trim(), icon });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="form-intro">为你们的想法，找一个共同的地方。</p>
        <label>
          房间名称
          <input
            name="name"
            defaultValue={room?.name}
            placeholder="例如：周末旅行、产品讨论"
            required
            maxLength={60}
          />
        </label>
        <label>房间图标</label>
        <div className="icon-picker">
          {[
            "🏝️",
            "⛺",
            "💡",
            "🌿",
            "📚",
            "🎨",
            "💻",
            "🏠",
            "☕",
            "🚀",
            "🎵",
            "🌊",
          ].map((i) => (
            <button
              type="button"
              aria-label={`图标 ${i}`}
              className={icon === i ? "active" : ""}
              key={i}
              onClick={() => setIcon(i)}
            >
              {i}
            </button>
          ))}
        </div>
        <ErrorLine error={error} />
        <div className="modal-footer">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "保存中…" : room ? "保存修改" : "创建房间"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function JoinForm({
  initial,
  onClose,
  onJoin,
}: {
  initial: string;
  onClose: () => void;
  onJoin: (token: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="加入房间" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            let token = value.trim();
            try {
              token = new URL(token).searchParams.get("invite") || token;
            } catch {}
            await onJoin(token);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="form-intro">粘贴朋友发来的邀请链接，就能加入他们。</p>
        <label>
          邀请链接或邀请令牌
          <textarea
            aria-label="邀请链接或邀请令牌"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
            placeholder="粘贴邀请链接…"
          />
        </label>
        <ErrorLine error={error} />
        <div className="modal-footer">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "正在加入…" : "加入房间"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function InviteDialog({
  roomId,
  onClose,
  notify,
}: {
  roomId: string;
  onClose: () => void;
  notify: (s: string) => void;
}) {
  const site = useSite();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invites, setInvites] = useState<
    {
      id: string;
      expires_at: string;
      max_uses: number;
      used_count: number;
      revoked_at: string | null;
    }[]
  >([]);
  const refresh = useCallback(
    () =>
      api<{ invites: typeof invites }>(`rooms/${roomId}/invites`).then((r) =>
        setInvites(r.invites),
      ),
    [roomId],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <Modal title="邀请朋友" onClose={onClose}>
      <p className="form-intro">把链接分享给朋友，一起进入房间。</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const values = Object.fromEntries(new FormData(e.currentTarget));
          setBusy(true);
          try {
            const result = await cmd<{ token: string }>("invite", {
              room_id: roomId,
              hours: Number(values.hours),
              max_uses: Number(values.max_uses),
            });
            setUrl(`${location.origin}/?invite=${result.token}`);
            await refresh();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <label>
            有效期
            <select
              aria-label="有效期"
              name="hours"
              defaultValue={String(site.config.operations.invite_days * 24)}
            >
              {![1, 7, 30].includes(site.config.operations.invite_days) && (
                <option value={site.config.operations.invite_days * 24}>
                  {site.config.operations.invite_days} 天
                </option>
              )}
              <option value="24">1 天</option>
              <option value="168">7 天</option>
              <option value="720">30 天</option>
            </select>
          </label>
          <label>
            可使用次数
            <input
              name="max_uses"
              type="number"
              min={1}
              max={1000}
              defaultValue={20}
              required
            />
          </label>
        </div>
        <button className="primary full" disabled={busy}>
          <LinkIcon size={17} />
          {busy ? "生成中…" : "生成邀请链接"}
        </button>
      </form>
      {url && (
        <div className="invite-result">
          <label>
            邀请链接
            <input
              aria-label="生成的邀请链接"
              value={url}
              readOnly
              onFocus={(e) => e.target.select()}
            />
          </label>
          <button
            className="secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(url)
                .then(() => notify("邀请链接已复制"))
                .catch(() => notify("请选中链接手动复制"))
            }
          >
            <Copy size={15} />
            复制链接
          </button>
        </div>
      )}
      <ErrorLine error={error} />
      {!!invites.length && (
        <section className="invite-list">
          <h3>已生成的邀请</h3>
          {invites.map((i) => (
            <div key={i.id}>
              <span>
                {i.used_count}/{i.max_uses} 次 ·{" "}
                {new Date(i.expires_at).toLocaleDateString("zh-CN")} 到期
              </span>
              {i.revoked_at ? (
                <small>已撤销</small>
              ) : (
                <button
                  className="danger-text"
                  onClick={() =>
                    void cmd("revoke_invite", {
                      room_id: roomId,
                      invite_id: i.id,
                    })
                      .then(refresh)
                      .catch((e) => setError(e.message))
                  }
                >
                  撤销
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </Modal>
  );
}
function ProfileDialog({
  user,
  onClose,
  onSave,
  onLogout,
}: {
  user: User;
  onClose: () => void;
  onSave: (values: Record<string, unknown>) => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [avatar, setAvatar] = useState<string | null>(
    user.avatar_url?.startsWith("/api/avatars/") ? user.avatar_url : null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarEditor = useRef<AvatarEditorHandle>(null);
  return (
    <Modal title="个人资料" onClose={onClose}>
      <div className="profile-avatar">
        <ParticipantAvatar name={user.display_name} src={avatar} size={64} />
        <p>{user.email}</p>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            setError("");
            const values = Object.fromEntries(new FormData(e.currentTarget));
            values.avatar_url = (await avatarEditor.current!.commit()) || "";
            await onSave(values);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          昵称
          <input
            name="display_name"
            defaultValue={user.display_name}
            required
            maxLength={40}
          />
        </label>
        <AvatarEditor
          ref={avatarEditor}
          value={avatar}
          onChange={setAvatar}
          name={user.display_name}
          onBusyChange={setAvatarBusy}
        />
        <input type="hidden" name="avatar_url" value={avatar || ""} />
        <ErrorLine error={error} />
        <div className="modal-footer">
          <button
            type="button"
            className="secondary danger-text"
            onClick={() => void onLogout().catch((e) => setError(e.message))}
          >
            <LogOut size={15} />
            退出登录
          </button>
          <button className="primary" disabled={busy || avatarBusy}>
            保存资料
          </button>
        </div>
      </form>
    </Modal>
  );
}
function TaskDialog({
  task,
  source,
  state,
  me,
  onClose,
  onSave,
}: {
  task: Task | null;
  source: Message | null;
  state: RoomState;
  me: Participant;
  onClose: () => void;
  onSave: (values: Record<string, unknown>) => Promise<void>;
}) {
  const host = canManage(state.room, me);
  const editable =
    state.room.status !== "frozen" &&
    Boolean(state.capabilities?.tasks ?? true) &&
    (!task || canUpdateTask(task, state.room, me));
  const [assignees, setAssignees] = useState(
    task?.task_assignees.map((a) => a.participant_id) ||
      (source?.sender_participant_id ? [source.sender_participant_id] : []),
  );
  const [files, setFiles] = useState(
    task?.task_files.map((f) => f.file_id) || [],
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={task ? "任务详情" : "新建任务"} onClose={onClose} wide>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const values = Object.fromEntries(new FormData(e.currentTarget));
          setBusy(true);
          try {
            await onSave({
              ...values,
              assignee_ids: assignees,
              file_ids: files,
              due_at: values.due_at
                ? new Date(String(values.due_at)).toISOString()
                : null,
            });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          任务名称
          <input
            name="title"
            defaultValue={task?.title || source?.content.slice(0, 160) || ""}
            required
            maxLength={160}
            disabled={!editable}
            placeholder="把要做的事写下来"
          />
        </label>
        <label>
          描述
          <textarea
            name="description"
            defaultValue={task?.description}
            disabled={!editable}
            maxLength={8000}
            placeholder="补充一点说明，让大家更清楚…"
          />
        </label>
        <div className="form-grid">
          <label>
            截止时间
            <input
              name="due_at"
              type="datetime-local"
              disabled={!editable}
              defaultValue={
                task?.due_at
                  ? new Date(
                      new Date(task.due_at).getTime() -
                        new Date(task.due_at).getTimezoneOffset() * 60000,
                    )
                      .toISOString()
                      .slice(0, 16)
                  : ""
              }
            />
          </label>
          <label>
            状态
            <select
              aria-label="状态"
              name="status"
              defaultValue={task?.status || "pending"}
              disabled={!editable || !task}
            >
              {Object.entries(statusNames).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          负责人 <small>可选择多位成员</small>
        </label>
        <div className="assignee-picker">
          {state.participants
            .filter((p) => p.status === "active")
            .map((p) => (
              <label
                key={p.id}
                className={assignees.includes(p.id) ? "checked" : ""}
              >
                <input
                  type="checkbox"
                  aria-label={p.display_name}
                  checked={assignees.includes(p.id)}
                  disabled={!editable || (!!task && !host)}
                  onChange={(e) =>
                    setAssignees((a) =>
                      e.target.checked
                        ? [...a, p.id]
                        : a.filter((x) => x !== p.id),
                    )
                  }
                />
                <ParticipantAvatar
                  name={p.display_name}
                  src={p.avatar_url}
                  size={25}
                />
                <span>{p.display_name}</span>
              </label>
            ))}
        </div>
        {!!state.files.length && (
          <>
            <label>任务附件</label>
            <div className="attachment-picker">
              {state.files.map((f) => (
                <label key={f.id}>
                  <input
                    type="checkbox"
                    checked={files.includes(f.id)}
                    disabled={!editable}
                    onChange={(e) =>
                      setFiles((a) =>
                        e.target.checked
                          ? [...a, f.id]
                          : a.filter((x) => x !== f.id),
                      )
                    }
                  />
                  <FileText size={15} />
                  <span>{f.name}</span>
                  <a
                    href={
                      f.status && f.status !== "normal"
                        ? undefined
                        : `/api/files/${f.id}`
                    }
                    aria-label={`下载附件 ${f.name}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Download size={14} />
                  </a>
                </label>
              ))}
            </div>
          </>
        )}
        {(source || task?.source_message_id) && (
          <div className="task-source">
            <small>来源消息</small>
            <p>
              {source?.deleted_at
                ? "消息已撤回"
                : source?.content || "此任务来源于房间聊天记录"}
            </p>
          </div>
        )}
        {task && (
          <p className="muted small">
            创建人：
            {
              state.participants.find(
                (p) => p.id === task.creator_participant_id,
              )?.display_name
            }{" "}
            · 更新于 {day(task.updated_at)} {time(task.updated_at)}
          </p>
        )}
        <ErrorLine error={error} />
        <div className="modal-footer">
          <button type="button" className="secondary" onClick={onClose}>
            {editable ? "取消" : "关闭"}
          </button>
          {editable && (
            <button className="primary" disabled={busy}>
              {busy ? "保存中…" : task ? "保存修改" : "创建任务"}
            </button>
          )}
        </div>
        {!editable && (
          <p className="muted small">任务负责人和主持人可以更新这项任务。</p>
        )}
      </form>
    </Modal>
  );
}
function ConfirmDialog({
  value,
  onClose,
  notify,
}: {
  value: { title: string; text: string; action: () => Promise<void> };
  onClose: () => void;
  notify: (s: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={value.title} onClose={onClose}>
      <p className="confirm-text">{value.text}</p>
      <ErrorLine error={error} />
      <div className="modal-footer">
        <button className="secondary" onClick={onClose}>
          取消
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await value.action();
              onClose();
            } catch (e) {
              setError((e as Error).message);
              notify((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "处理中…" : "确认"}
        </button>
      </div>
    </Modal>
  );
}

function ReportDialog({
  targetId,
  targetType,
  roomId,
  onClose,
  onDone,
}: {
  targetId: string;
  targetType: string;
  roomId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="提交举报" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await cmd("report", {
              room_id: roomId,
              target_type: targetType,
              target_id: targetId,
              reason: new FormData(e.currentTarget).get("reason"),
            });
            onDone();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          举报原因
          <textarea name="reason" minLength={3} maxLength={2000} required />
        </label>
        <ErrorLine error={error} />
        <div className="modal-footer">
          <button className="primary" disabled={busy}>
            提交举报
          </button>
        </div>
      </form>
    </Modal>
  );
}
