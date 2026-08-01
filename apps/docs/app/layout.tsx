import "@fontsource-variable/instrument-sans";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import type { ReactNode } from "react";

const DESCRIPTION =
  "Cinematic product demos, recorded by your agent. The docs: getting started, the take on disk, refining, the editor, and the CLI.";

export const metadata: Metadata = {
  // every relative URL below — canonicals, og:image — resolves against the
  // real domain, not the *.vercel.app host this app is actually served from
  metadataBase: new URL("https://open-take.dev"),
  title: {
    default: "open-take docs",
    template: "%s — open-take docs",
  },
  description: DESCRIPTION,
  applicationName: "open-take",
  authors: [{ name: "open-take", url: "https://github.com/pascal910107/open-take" }],
  creator: "open-take",
  publisher: "open-take",
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
  verification: { google: "kc13Y2dKbIGdeJO_jEqQ4SjkhAM2r1sI_vQzfT2_XjY" },
  openGraph: {
    type: "website",
    siteName: "open-take docs",
    locale: "en_US",
    url: "/docs",
    title: "open-take docs",
    description: DESCRIPTION,
    images: [{ url: "/og.jpg", width: 1200, height: 630, alt: "open-take documentation" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "open-take docs",
    description: DESCRIPTION,
    images: ["/og.jpg"],
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider
          theme={{ defaultTheme: "dark" }}
          search={{ options: { api: "/docs/api/search" } }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
