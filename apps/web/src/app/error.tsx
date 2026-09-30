"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="splash">
      <div className="empty">
        <h3>页面暂时遇到一点问题</h3>
        <p>你的协作记录保存在服务器，可以重新加载继续。</p>
        <button className="primary" style={{ marginTop: 20 }} onClick={reset}>
          重新加载
        </button>
      </div>
    </div>
  );
}
