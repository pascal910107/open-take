import "@fontsource-variable/instrument-sans";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: {
    default: "open-take docs",
    template: "%s — open-take docs",
  },
  description:
    "Cinematic product demos, recorded by your agent. The docs: getting started, the take on disk, refining, the editor, and the CLI.",
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
