"use client";

import { useEffect, useState } from "react";
import { Bird, ArrowLeft, Monitor, Download, Shield, Zap, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Platform = "windows" | "mac" | "linux" | "unknown";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("mac")) return "mac";
  if (ua.includes("linux")) return "linux";
  return "unknown";
}

const DOWNLOAD_LINKS: Record<string, { label: string; file: string; size: string }> = {
  windows: { label: "Windows (64-bit)", file: "Canary-Setup-1.0.0.exe", size: "~85 MB" },
  mac: { label: "macOS (Apple Silicon & Intel)", file: "Canary-1.0.0.dmg", size: "~90 MB" },
  linux: { label: "Linux (AppImage)", file: "Canary-1.0.0.AppImage", size: "~95 MB" },
};

export default function DownloadPage() {
  const [platform, setPlatform] = useState<Platform>("unknown");

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  const primary = DOWNLOAD_LINKS[platform] || DOWNLOAD_LINKS.windows;

  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <nav className="border-b border-border/50 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <a href="/" className="flex items-center gap-2">
            <Bird className="h-7 w-7 text-yellow-400" />
            <span className="text-xl font-bold tracking-tight">Canary</span>
            <span className="text-sm text-muted-foreground">by Heuricity</span>
          </a>
          <a
            href="/"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </a>
        </div>
      </nav>

      <div className="mx-auto max-w-3xl px-6 py-16">
        {/* Hero */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-yellow-400/10 border border-yellow-400/20 mb-6">
            <Monitor className="h-10 w-10 text-yellow-400" />
          </div>
          <h1 className="text-3xl font-bold sm:text-4xl">Download Canary Desktop</h1>
          <p className="mt-3 text-muted-foreground max-w-lg mx-auto">
            Auto-queue entry, multi-profile browser panels, proxy support, and real-time alerts
            — all in one desktop app.
          </p>
          <Badge className="mt-4 bg-yellow-400/10 text-yellow-400 border-yellow-400/20">
            Requires Desktop + Bot subscription (£50/mo)
          </Badge>
        </div>

        {/* Primary download */}
        <Card className="mb-6 border-yellow-400/20">
          <CardContent className="pt-6 pb-6">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div>
                <h3 className="font-semibold text-lg">Canary for {primary.label}</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  {primary.file} • {primary.size} • v1.0.0
                </p>
              </div>
              <a
                href={`/releases/${primary.file}`}
                className={cn(
                  buttonVariants({ size: "lg" }),
                  "bg-yellow-400 text-black hover:bg-yellow-300 font-semibold gap-2"
                )}
              >
                <Download className="h-4 w-4" />
                Download
              </a>
            </div>
          </CardContent>
        </Card>

        {/* Other platforms */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-12">
          {Object.entries(DOWNLOAD_LINKS).map(([key, info]) => (
            <a
              key={key}
              href={`/releases/${info.file}`}
              className={cn(
                "rounded-lg border p-4 text-center hover:border-yellow-400/30 transition-colors",
                platform === key ? "border-yellow-400/30 bg-yellow-400/5" : "border-border"
              )}
            >
              <p className="text-sm font-medium">{info.label}</p>
              <p className="text-xs text-muted-foreground mt-1">{info.size}</p>
            </a>
          ))}
        </div>

        {/* Features grid */}
        <h2 className="text-xl font-bold mb-6 text-center">What's in Desktop?</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12">
          <FeatureCard
            icon={<Zap className="h-5 w-5 text-yellow-400" />}
            title="Auto-Queue"
            description="Automatically enters the Pokemon Center queue with multiple browser profiles when a drop is detected."
          />
          <FeatureCard
            icon={<Shield className="h-5 w-5 text-yellow-400" />}
            title="Proxy Support"
            description="Route each browser profile through a different proxy. Supports IP:port:user:pass format."
          />
          <FeatureCard
            icon={<RefreshCw className="h-5 w-5 text-yellow-400" />}
            title="Real-Time Signals"
            description="Live feed of detection signals from the Canary server. Desktop notifications on critical alerts."
          />
        </div>

        {/* Install instructions */}
        <Card>
          <CardContent className="pt-6">
            <h3 className="font-semibold mb-4">Installation</h3>
            <div className="space-y-4 text-sm">
              <Step n={1}>
                <strong>Download</strong> the installer for your platform above.
              </Step>
              <Step n={2}>
                <strong>Run the installer.</strong> On Windows you may see a SmartScreen warning —
                click "More info" → "Run anyway". (We're working on code signing.)
              </Step>
              <Step n={3}>
                <strong>Sign in with Discord</strong> when Canary opens. This verifies your
                Desktop + Bot subscription.
              </Step>
              <Step n={4}>
                <strong>Create a browser profile</strong> and optionally add a proxy. The app will
                auto-queue when the next drop is detected.
              </Step>
            </div>

            <div className="mt-6 rounded-lg bg-muted/30 border border-border p-4">
              <p className="text-xs text-muted-foreground">
                <strong className="text-foreground">Don't have a subscription yet?</strong>{" "}
                <a href="/subscribe?tier=desktop" className="text-yellow-400 hover:text-yellow-300">
                  Subscribe to Desktop + Bot
                </a>{" "}
                to get access. You'll need an active subscription to sign in to the desktop app.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <Card>
      <CardContent className="pt-5 pb-5">
        <div className="mb-2">{icon}</div>
        <h3 className="font-semibold text-sm mb-1">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-yellow-400/10 text-yellow-400 text-xs font-bold">
        {n}
      </span>
      <p className="text-muted-foreground">{children}</p>
    </div>
  );
}
