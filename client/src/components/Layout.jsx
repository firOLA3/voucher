import { Link } from "react-router-dom";

export function Layout({ headerLinkTo, headerLinkContent, footerLeft, footerRight, children }) {
  return (
    <>
      <header className="topbar">
        <Link className="brand" to="/" aria-label="Class of 2026 convocation vouchers">
          <span className="brand-mark" aria-hidden="true">✦</span>
          <span>
            CLASS OF <span className="brand-dot">’26</span>
          </span>
        </Link>
        <Link className="header-link" to={headerLinkTo}>
          {headerLinkContent}
        </Link>
      </header>
      {children}
      <footer className="site-footer">
        <span>{footerLeft}</span>
        <span>{footerRight}</span>
      </footer>
    </>
  );
}

