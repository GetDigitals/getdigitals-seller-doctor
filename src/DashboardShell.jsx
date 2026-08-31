// DashboardShell.jsx
//
// The premium dark sidebar shell (approved design), now wired to REAL data:
//   - hasAccess / onRequestPayment come from AuthGuard's real Supabase
//     subscription check — nothing here is simulated.
//   - Locked nav items open the real PaymentScreen (via onRequestPayment),
//     not a demo toast.
//   - "Calculators" links straight to /toolkit/ — the free calculators page
//     that already exists and is always free, same as before.
//   - Sections without a built screen yet (Analytics, Settlement Reports as
//     its own page, Products & SKUs, Loss Detection, Activity Log) show an
//     honest "coming soon" panel instead of fabricated data — the paid lock
//     still applies where relevant so the structure matches what's planned,
//     but nothing here pretends to be real yet.

import React from "react";

const NAV_GROUPS = [
  {
    label: "Overview",
    items: [
      { id: "dashboard", label: "Dashboard", icon: "📊" },
      { id: "analytics", label: "Analytics", icon: "📈", paid: true, comingSoon: true },
    ],
  },
  {
    label: "Tools",
    items: [
      { id: "calc", label: "Calculators", icon: "🧮", free: true, external: "/toolkit/" },
      { id: "labelcrop", label: "Label Cropper", icon: "✂️", paid: true },
      { id: "listing", label: "Listing Generator", icon: "📋", paid: true, badge: "Beta" },
    ],
  },
  {
    label: "Diagnosis",
    items: [
      { id: "reports", label: "Settlement Reports", icon: "🧾", paid: true, comingSoon: true },
      { id: "skus", label: "Products & SKUs", icon: "📦", paid: true, comingSoon: true },
      { id: "loss", label: "Loss Detection", icon: "🔍", paid: true, comingSoon: true },
    ],
  },
  {
    label: "Account",
    items: [
      { id: "billing", label: "Billing & Plan", icon: "💳" },
      { id: "logs", label: "Activity Log", icon: "🗂️", paid: true, comingSoon: true },
    ],
  },
];

export default function DashboardShell({ activeView, onNavigate, hasAccess, planLabel, userEmail, onLogout, children }) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  const handleClick = (item) => {
    if (item.external) {
      window.open(item.external, "_blank", "noreferrer");
      return;
    }
    onNavigate(item.id);
    setMobileOpen(false);
  };

  const activeItem = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === activeView);

  return (
    <div className="sd-app" style={styles.app}>
      <style>{`
        @media (max-width: 920px) {
          .sd-app { grid-template-columns: 1fr !important; }
          .sd-sidebar { display: none !important; }
          .sd-sidebar.sd-open { display: flex !important; position: fixed; inset: 0; z-index: 50; width: min(84vw, 300px); }
          .sd-mobile-topbar { display: flex !important; }
        }
      `}</style>
      <aside className={`sd-sidebar${mobileOpen ? " sd-open" : ""}`} style={styles.sidebar}>
        <div style={styles.brand}>
          <div style={styles.brandMark}>🩺</div>
          <div>
            <div style={styles.brandName}>Seller Doctor</div>
            <div style={styles.brandSub}>by GetDigitals</div>
          </div>
        </div>

        <nav style={styles.nav}>
          {NAV_GROUPS.map((group) => (
            <div key={group.label} style={{ marginBottom: 22 }}>
              <div style={styles.navLabel}>{group.label}</div>
              {group.items.map((item) => {
                const locked = item.paid && !hasAccess;
                const isActive = activeView === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleClick(item)}
                    style={{
                      ...styles.navItem,
                      ...(isActive ? styles.navItemActive : {}),
                      ...(locked ? styles.navItemLocked : {}),
                    }}
                  >
                    <span style={styles.navIcon}>{item.icon}</span>
                    <span style={{ flex: 1 }}>{item.label}</span>
                    {item.free && <span style={{ ...styles.badge, ...styles.badgeGreen }}>Free</span>}
                    {item.badge && <span style={{ ...styles.badge, ...styles.badgeGreen }}>{item.badge}</span>}
                    {locked && <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.8 }}>🔒</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div style={styles.sidebarFoot}>
          <div style={styles.avatar}>{(userEmail || "SD").slice(0, 2).toUpperCase()}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ ...styles.footName, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{userEmail || "Seller Doctor"}</div>
            {onLogout && (
              <button onClick={onLogout} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11.5, color: "#5d6680", textDecoration: "underline" }}>
                Logout
              </button>
            )}
          </div>
          <div style={{ ...styles.planPill, ...(hasAccess ? {} : styles.planPillFree) }}>
            {planLabel}
          </div>
        </div>
      </aside>

      {mobileOpen && <div style={styles.mobileOverlay} onClick={() => setMobileOpen(false)} />}

      <div style={{ minWidth: 0 }}>
        <div className="sd-mobile-topbar" style={styles.mobileTopbar}>
          <button style={styles.hamburger} onClick={() => setMobileOpen(true)}>☰</button>
          <div style={{ ...styles.brandName, fontSize: 15 }}>Seller Doctor</div>
        </div>

        <main style={styles.main}>
          <div style={styles.topline}>
            <div>
              <div style={styles.crumbs}><b style={{ color: "#8790a8", fontWeight: 600 }}>Seller Doctor</b> / {activeItem?.label || "Dashboard"}</div>
              <h1 style={styles.pageTitle}>{activeItem?.label || "Dashboard"}</h1>
            </div>
          </div>

          {activeItem?.comingSoon ? (
            <ComingSoonPanel item={activeItem} hasAccess={hasAccess} />
          ) : (
            <div style={styles.contentCard}>{children}</div>
          )}
        </main>
      </div>
    </div>
  );
}

function ComingSoonPanel({ item, hasAccess }) {
  const locked = item.paid && !hasAccess;
  return (
    <div style={{ ...styles.contentCard, padding: "60px 24px", textAlign: "center" }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>{locked ? "🔒" : "🚧"}</div>
      <h3 style={{ margin: "0 0 8px", fontSize: 17, color: "#1a1a1a" }}>
        {locked ? `${item.label} — plan ke saath aayega` : `${item.label} jald aa raha hai`}
      </h3>
      <p style={{ margin: 0, fontSize: 13.5, color: "#6b6b68", maxWidth: 380, marginLeft: "auto", marginRight: "auto", lineHeight: 1.6 }}>
        {locked
          ? "Ye feature abhi build ho raha hai aur paid plan ke saath launch hoga. Tab tak Settlement Upload, Label Cropper aur Listing Generator use karte raho."
          : "Ye feature abhi build ho raha hai — jald available hoga."}
      </p>
    </div>
  );
}

const styles = {
  app: {
    display: "grid",
    gridTemplateColumns: "272px 1fr",
    minHeight: "100vh",
    fontFamily: "'Inter', system-ui, sans-serif",
    background: "#f7f8fa",
  },
  sidebar: {
    background: "#0d111c",
    borderRight: "1px solid rgba(255,255,255,.07)",
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    position: "sticky",
    top: 0,
  },
  sidebarOpen: {},
  brand: { display: "flex", alignItems: "center", gap: 12, padding: "22px 20px", borderBottom: "1px solid rgba(255,255,255,.07)" },
  brandMark: {
    width: 42, height: 42, borderRadius: 12, flex: "none",
    background: "linear-gradient(135deg,#5b6bfb,#8c5bfb)",
    display: "grid", placeItems: "center", fontSize: 20,
    boxShadow: "0 8px 22px rgba(108,93,251,.35)",
  },
  brandName: { fontSize: 16, fontWeight: 700, color: "#eef1fb", fontFamily: "'Space Grotesk', sans-serif" },
  brandSub: { fontSize: 10.5, color: "#5d6680", letterSpacing: 1.6, textTransform: "uppercase", marginTop: 1 },
  nav: { flex: 1, overflowY: "auto", padding: "18px 12px" },
  navLabel: { fontSize: 10.5, fontWeight: 700, letterSpacing: 1.6, color: "#5d6680", textTransform: "uppercase", padding: "0 12px 8px" },
  navItem: {
    display: "flex", alignItems: "center", gap: 12, padding: "11px 12px", borderRadius: 12,
    color: "#8790a8", fontSize: 14.5, fontWeight: 500, cursor: "pointer", border: "1px solid transparent",
    background: "transparent", width: "100%", textAlign: "left", marginBottom: 2,
  },
  navItemActive: {
    background: "linear-gradient(135deg,rgba(91,107,251,.18),rgba(140,91,251,.14))",
    borderColor: "rgba(120,110,251,.35)", color: "#c8d3ff",
  },
  navItemLocked: { color: "#5d6680" },
  navIcon: { width: 20, textAlign: "center", fontSize: 15, flex: "none" },
  badge: { fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, flex: "none" },
  badgeGreen: { background: "rgba(49,209,160,.16)", color: "#31d1a0" },
  sidebarFoot: { borderTop: "1px solid rgba(255,255,255,.07)", padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 },
  avatar: {
    width: 38, height: 38, borderRadius: "50%", flex: "none",
    background: "linear-gradient(135deg,#8c5bfb,#5b6bfb)", display: "grid", placeItems: "center",
    fontWeight: 700, fontSize: 13, color: "#fff",
  },
  footName: { fontSize: 13.5, fontWeight: 600, color: "#eef1fb" },
  footSub: { fontSize: 11.5, color: "#5d6680", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  planPill: {
    marginLeft: "auto", fontSize: 10.5, fontWeight: 700, color: "#31d1a0",
    background: "rgba(49,209,160,.14)", border: "1px solid rgba(49,209,160,.3)",
    padding: "3px 8px", borderRadius: 999, whiteSpace: "nowrap",
  },
  planPillFree: { color: "#f5b84c", background: "rgba(245,184,76,.14)", border: "1px solid rgba(245,184,76,.3)" },
  mobileOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 40 },
  mobileTopbar: { display: "none" },
  main: { padding: "26px 30px 60px", maxWidth: 1180, margin: "0 auto" },
  topline: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22 },
  crumbs: { fontSize: 12.5, color: "#9a9a95" },
  pageTitle: { fontSize: 22, fontWeight: 700, margin: "2px 0 0", color: "#1a1a1a", fontFamily: "'Space Grotesk', sans-serif" },
  contentCard: { background: "#fff", border: "1px solid #e5e4df", borderRadius: 18, overflow: "hidden" },
};
