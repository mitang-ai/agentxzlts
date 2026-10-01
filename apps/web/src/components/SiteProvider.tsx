"use client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { House, X } from "lucide-react";
import { api } from "@/lib/client";
export type SiteData = {
  config: {
    brand: { name: string; logo: string; favicon: string; intro: string };
    information: {
      title: string;
      description: string;
      icp: string;
      footer: string;
      email: string;
      phone: string;
    };
    analytics: {
      baidu_enabled: boolean;
      baidu_id: string;
      ga_enabled: boolean;
      ga_id: string;
      umami_enabled: boolean;
      umami_url: string;
      umami_id: string;
    };
    operations: {
      registration: boolean;
      max_file_mb: number;
      invite_days: number;
      maintenance: boolean;
      maintenance_message: string;
    };
  };
  capabilities: Record<string, boolean>;
  announcements: {
    id: string;
    title: string;
    content: string;
    dismissible: boolean;
  }[];
  user: {
    id: string;
    display_name: string;
    email: string;
    avatar_url: string | null;
    status: string;
    admin_role: string | null;
  } | null;
  cursor: number;
  events: { type: string; payload: { message?: string } }[];
};
const fallback: SiteData = {
  config: {
    brand: {
      name: "协作岛",
      logo: "",
      favicon: "",
      intro: "聊天、分工与文件，在一个轻松的协作空间里。",
    },
    information: {
      title: "协作岛 · 一起把想法做成",
      description: "聊天、分工与文件，在一个轻松的协作空间里。",
      icp: "",
      footer: "",
      email: "",
      phone: "",
    },
    analytics: {
      baidu_enabled: false,
      baidu_id: "",
      ga_enabled: false,
      ga_id: "",
      umami_enabled: false,
      umami_url: "",
      umami_id: "",
    },
    operations: {
      registration: true,
      max_file_mb: 10,
      invite_days: 7,
      maintenance: false,
      maintenance_message: "",
    },
  },
  capabilities: { tasks: true, uploads: true, create_room: true, post: true },
  announcements: [],
  user: null,
  cursor: 0,
  events: [],
};
const SiteContext = createContext<SiteData>(fallback);
export const useSite = () => useContext(SiteContext);
export function SiteProvider({ children }: { children: ReactNode }) {
  const isAdmin = usePathname().startsWith("/admin");
  const [site, setSite] = useState(fallback),
    [dismissed, setDismissed] = useState<string[]>([]),
    [error, setError] = useState("");
  const cursor = useRef(0),
    prevUser = useRef<string | null>(null),
    previousAnalytics = useRef<string | null>(null);
  useEffect(() => {
    cursor.current = Number(
      sessionStorage.getItem("island:control-cursor") || 0,
    );
    let stopped = false;
    let running = false;
    async function refresh() {
      if (running) return;
      running = true;
      try {
        const next = await api<SiteData>(`site?after=${cursor.current}`);
        if (stopped) return;
        if (prevUser.current && !next.user)
          window.dispatchEvent(new Event("island:session-expired"));
        prevUser.current = next.user?.id || null;
        const analytics = JSON.stringify(next.config.analytics);
        if (
          previousAnalytics.current &&
          previousAnalytics.current !== analytics
        ) {
          location.reload();
          return;
        }
        previousAnalytics.current = analytics;
        for (const event of next.events)
          if (event.type === "warning")
            window.dispatchEvent(
              new CustomEvent("island:warning", {
                detail: event.payload.message,
              }),
            );
        cursor.current = next.cursor;
        sessionStorage.setItem("island:control-cursor", String(next.cursor));
        setSite(next);
        setError("");
        document.title = next.config.information.title;
        let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
        if (next.config.brand.favicon) {
          if (!icon) {
            icon = document.createElement("link");
            icon.rel = "icon";
            document.head.appendChild(icon);
          }
          icon.href = next.config.brand.favicon;
        } else icon?.remove();
      } catch {
        if (!stopped) setError("网站配置暂时无法同步");
      } finally {
        running = false;
      }
    }
    void refresh();
    const timer = setInterval(refresh, 3000);
    window.addEventListener("island:session", refresh);
    window.addEventListener("online", refresh);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("island:session", refresh);
      window.removeEventListener("online", refresh);
    };
  }, []);
  const a = site.config.analytics;
  return (
    <SiteContext.Provider value={site}>
      {error && (
        <div className="site-sync-error" role="status">
          {error}
        </div>
      )}
      {!isAdmin &&
        site.announcements
          .filter((n) => !dismissed.includes(n.id))
          .map((n) => (
            <div className="site-announcement" key={n.id}>
              <strong>{n.title}</strong>
              <span>{n.content}</span>
              {n.dismissible && (
                <button
                  aria-label={`关闭公告 ${n.title}`}
                  onClick={() => setDismissed((v) => [...v, n.id])}
                >
                  <X size={16} />
                </button>
              )}
            </div>
          ))}
      {children}
      {!isAdmin && a.baidu_enabled && (
        <Script
          id={`baidu-${a.baidu_id}`}
          src={`https://hm.baidu.com/hm.js?${a.baidu_id}`}
          strategy="afterInteractive"
        />
      )}
      {!isAdmin && a.ga_enabled && (
        <>
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${a.ga_id}`}
            strategy="afterInteractive"
          />
          <Script
            id={`ga-${a.ga_id}`}
            strategy="afterInteractive"
          >{`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config',${JSON.stringify(a.ga_id)});`}</Script>
        </>
      )}
      {!isAdmin && a.umami_enabled && (
        <Script
          src={a.umami_url.replace(/\/$/, "") + "/script.js"}
          data-website-id={a.umami_id}
          strategy="afterInteractive"
        />
      )}
    </SiteContext.Provider>
  );
}
export function SiteBrand({ rail = false }: { rail?: boolean }) {
  const { brand } = useSite().config;
  return (
    <span className={rail ? "rail-brand" : "brand"}>
      {brand.logo ? (
        <img className="site-logo" src={brand.logo} alt={brand.name} />
      ) : (
        <span className="brand-mark">
          <House size={rail ? 24 : 20} />
        </span>
      )}
      <strong>{brand.name}</strong>
    </span>
  );
}
export function SiteFooter() {
  const info = useSite().config.information;
  return (
    <footer className="site-footer">
      {info.footer && <span>{info.footer}</span>}
      {info.icp && (
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
          {info.icp}
        </a>
      )}
      {info.email && <a href={`mailto:${info.email}`}>{info.email}</a>}
      {info.phone && <span>{info.phone}</span>}
    </footer>
  );
}
