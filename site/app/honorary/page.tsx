import type { Metadata } from "next";
import { GenesisExperience } from "../../genesis/components/genesis-experience";

const CANONICAL_SITE_ORIGIN = "https://qbit-onchain-pet.thedanhepworth.chatgpt.site";

export const metadata: Metadata = {
  title: "Miner One — Qbit Block 1 Honorary QPET",
  description: "Recover the mainnet QPET honoring the miner of Qbit block 1, including its exact recipient-bound output.",
  alternates: { canonical: `${CANONICAL_SITE_ORIGIN}/honorary` },
  openGraph: {
    title: "Miner One — Qbit Block 1 Honorary QPET",
    description: "A #1 hardhat, a pickaxe, and a recipient-bound mainnet inscription honoring Qbit's block one miner.",
    url: `${CANONICAL_SITE_ORIGIN}/honorary`,
    type: "website",
    images: [{ url: `${CANONICAL_SITE_ORIGIN}/og.png`, alt: "Original Qbit beside Miner One, the honorary QPET for Qbit's block one miner" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Miner One — Qbit Block 1 Honorary QPET",
    description: "A recipient-bound mainnet QPET honoring Qbit's block one miner.",
    images: [`${CANONICAL_SITE_ORIGIN}/og.png`],
  },
};

export default function HonoraryPage() {
  return <GenesisExperience artifactId="miner-one" />;
}
