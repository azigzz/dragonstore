import type { Metadata } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://savio-store.vercel.app";
const title = process.env.SAVIO_STORE_NAME || process.env.DRAGON_STORE_NAME || "Sávio Store";
const description = process.env.STORE_HERO_TEXT || "Produtos digitais com pedido seguro e atendimento pelo Discord.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: `${title} | Loja digital pelo Discord`,
    template: `%s | ${title}`
  },
  description,
  openGraph: {
    title,
    description,
    url: siteUrl,
    siteName: title,
    images: [{ url: "/savio-store-logo.png", width: 2048, height: 2048 }],
    locale: "pt_BR",
    type: "website"
  },
  icons: {
    icon: "/savio-store-logo.png",
    apple: "/savio-store-logo.png"
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
