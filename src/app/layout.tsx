import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { PRODUCT } from "@/data/specs";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://aura-one.vercel.app"),
  title: {
    default: `${PRODUCT.name} — ${PRODUCT.tagline}`,
    template: `%s — ${PRODUCT.name}`,
  },
  description:
    "A neural audio wearable that runs inference on-device. Built as a demonstration of scroll-driven canvas rendering, in-browser AI and zero-dependency motion engineering.",
  applicationName: PRODUCT.name,
  authors: [{ name: "Natan Koralewski" }],
  openGraph: {
    type: "website",
    title: `${PRODUCT.name} — ${PRODUCT.tagline}`,
    description:
      "Neural hardware concept site. Canvas scrollytelling, on-device AI playground, live engineering HUD.",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#09090b",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  // The scrollytelling depends on a stable viewport height; zoom-to-fit on
  // input focus would resize it mid-pin.
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="min-h-full">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[999] focus:rounded focus:bg-signal focus:px-4 focus:py-2 focus:text-void"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
