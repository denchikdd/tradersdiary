import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#101216",
};

export const metadata: Metadata = {
  title: "Торговый журнал",
  description: "Календарь PnL и статистика по биржам и тикерам.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Торговый журнал", statusBarStyle: "black-translucent" },
  icons: {
    apple: "/icon-180.png",
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}

