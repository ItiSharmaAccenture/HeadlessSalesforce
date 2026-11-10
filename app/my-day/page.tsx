import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import MyDayApp from "@/components/my-day/dashboard/MyDayApp";
import TechnicianLogin from "@/components/my-day/TechnicianLogin";
import { readSession } from "@/lib/session";
import "./my-day.css";
import "@/components/my-day/dashboard/dashboard.css";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-jakarta",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ADT My Day — AI Field Technician Workspace",
};

/**
 * ADT My Day. The page only decides who is signed in; every figure on the
 * dashboard is loaded client-side from /api/dashboard* (direct Salesforce
 * REST), and the Copilot from /api/copilot (Gemini + MCP). Nothing here is
 * hardcoded appointment data.
 */
export default async function MyDayPage() {
  const session = await readSession();

  if (!session) return <TechnicianLogin fontClassName={jakarta.variable} />;

  // A public, URL-restrictable browser token. The server-side routing token is separate.
  const mapToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim() || null;

  return <MyDayApp technician={session.technician} mapToken={mapToken} fontClassName={jakarta.variable} />;
}
