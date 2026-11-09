import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "4U AI Workforce",
  description: "AI-powered sales & marketing organization for 4U Power Generation FZC",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
