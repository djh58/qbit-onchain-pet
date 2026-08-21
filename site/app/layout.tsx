import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host");
  const protocol = incoming.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  const socialImage = host ? `${protocol}://${host}/og.png` : undefined;

  return {
    title: "Qbit, permanently committed",
    description: "Meet the animated Qbit mascot encoded in mainnet block 53,026 and reconstructed directly from its transaction.",
    icons: {
      icon: [
        { url: "/favicon.ico?v=2", type: "image/x-icon" },
        { url: "/favicon.png?v=2", type: "image/png", sizes: "64x64" },
      ],
      shortcut: "/favicon.ico?v=2",
    },
    openGraph: {
      title: "Qbit, permanently committed",
      description: "The animated mascot inside Qbit mainnet block 53,026.",
      type: "website",
      images: socialImage ? [{ url: socialImage, alt: "Qbit, permanently committed" }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: "Qbit, permanently committed",
      description: "The animated mascot inside Qbit mainnet block 53,026.",
      images: socialImage ? [socialImage] : undefined,
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
