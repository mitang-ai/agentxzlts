export default function NotFound() {
  return (
    <div className="splash">
      <div className="empty">
        <h3>这里还没有一座岛</h3>
        <p>页面不存在，回到房间继续协作。</p>
        <a className="primary" style={{ marginTop: 20 }} href="/">
          回到协作岛
        </a>
      </div>
    </div>
  );
}
