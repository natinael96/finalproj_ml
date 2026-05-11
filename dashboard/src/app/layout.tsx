import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BP Dashboard",
  description: "Live BP predictions from ESP32 telemetry"
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

