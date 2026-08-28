import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ARTIFACTS } from "../genesis/model/facts";
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
    description: "Recover and verify the original Qbit and Miner One directly from their Qbit mainnet transactions.",
    icons: {
      icon: [
        { url: "/favicon.ico?v=2", type: "image/x-icon" },
        { url: "/favicon.png?v=2", type: "image/png", sizes: "64x64" },
      ],
      shortcut: "/favicon.ico?v=2",
    },
    openGraph: {
      title: "Qbit Genesis — Bytes. Then being.",
      description: "Two mainnet QPETs; their transaction IDs and inscription hashes verified before either animates.",
      type: "website",
      images: [{ url: socialImage, alt: "Original Qbit and Miner One, two verified on-chain QPETs" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Qbit Genesis — Bytes. Then being.",
      description: "Two mainnet QPETs; their transaction IDs and inscription hashes verified before either animates.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const explorerOrigins = [...new Set(Object.values(ARTIFACTS).map((artifact) => artifact.explorerOrigin))];

  return (
    <html lang="en">
      <head>
        {explorerOrigins.map((origin) => (
          <link key={origin} rel="preconnect" href={origin} crossOrigin="anonymous" />
        ))}
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
