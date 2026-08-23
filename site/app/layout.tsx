import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { EXPLORER_ORIGIN } from "../genesis/model/facts";
import "./globals.css";

const CANONICAL_SITE_ORIGIN = "https://qbit-onchain-pet.thedanhepworth.chatgpt.site";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export function generateMetadata(): Metadata {
  const socialImage = `${CANONICAL_SITE_ORIGIN}/og.png`;

  return {
    title: "Qbit Genesis — Bytes. Then being.",
    description: "Recover and verify the animated Qbit mascot directly from one Qbit mainnet transaction.",
    icons: {
      icon: [
        { url: "/favicon.ico?v=2", type: "image/x-icon" },
        { url: "/favicon.png?v=2", type: "image/png", sizes: "64x64" },
      ],
      shortcut: "/favicon.ico?v=2",
    },
    openGraph: {
      title: "Qbit Genesis — Bytes. Then being.",
      description: "One mainnet transaction; its ID and inscription hashes verified before Qbit animates in your browser.",
      type: "website",
      images: [{ url: socialImage, alt: "Qbit recovered from one verified mainnet transaction" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Qbit Genesis — Bytes. Then being.",
      description: "One mainnet transaction; its ID and inscription hashes verified before Qbit animates in your browser.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href={EXPLORER_ORIGIN} crossOrigin="anonymous" />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
