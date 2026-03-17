"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Bird, ArrowLeft, Check, CreditCard, MessageSquare, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Suspense } from "react";

function SubscribeContent() {
  const searchParams = useSearchParams();
  const initialTier = searchParams.get("tier") === "desktop" ? "desktop" : "bot";

  const [tier, setTier] = useState<"bot" | "desktop">(initialTier);
  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");
  const [loading, setLoading] = useState(false);

  const prices = {
    bot: { monthly: 10, annual: 100 },
    desktop: { monthly: 50, annual: 500 },
  };

  const price = prices[tier][billing];
  const monthlyEquiv = billing === "annual" ? Math.round(price / 12) : price;

  const handleCheckout = () => {
    setLoading(true);

    // Build the API URL with subscription intent params
    const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    const ref = searchParams.get("ref") || "";
    const guildId = searchParams.get("guild_id") || "";
    const params = new URLSearchParams({
      tier,
      billing,
      ref,
      guild_id: guildId,
    });

    // Redirect to Discord OAuth → Stripe Checkout (server handles the full flow)
    window.location.href = `${apiBase}/api/auth/discord?${params.toString()}`;
  };

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
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold sm:text-4xl">Subscribe to Canary</h1>
          <p className="mt-3 text-muted-foreground">
            Choose your plan and billing period. Cancel anytime.
          </p>
        </div>

        {/* Tier Selector */}
        <div className="grid grid-cols-2 gap-4 mb-8">
          <button
            onClick={() => setTier("bot")}
            className={cn(
              "rounded-xl border p-5 text-left transition-all",
              tier === "bot"
                ? "border-yellow-400 bg-yellow-400/5 ring-1 ring-yellow-400/30"
                : "border-border hover:border-border/80"
            )}
          >
            <MessageSquare className={cn("h-6 w-6 mb-2", tier === "bot" ? "text-yellow-400" : "text-muted-foreground")} />
            <h3 className="font-semibold">Discord Bot</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Alerts, predictions, tracking
            </p>
          </button>
          <button
            onClick={() => setTier("desktop")}
            className={cn(
              "rounded-xl border p-5 text-left transition-all relative",
              tier === "desktop"
                ? "border-yellow-400 bg-yellow-400/5 ring-1 ring-yellow-400/30"
                : "border-border hover:border-border/80"
            )}
          >
            <Badge className="absolute -top-2 right-3 bg-yellow-400 text-black text-[10px] font-semibold">
              Best Value
            </Badge>
            <Monitor className={cn("h-6 w-6 mb-2", tier === "desktop" ? "text-yellow-400" : "text-muted-foreground")} />
            <h3 className="font-semibold">Desktop + Bot</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Auto-queue, proxies, profiles
            </p>
          </button>
        </div>

        {/* Billing Toggle */}
        <div className="flex justify-center mb-8">
          <div className="inline-flex rounded-lg border border-border p-1">
            <button
              onClick={() => setBilling("monthly")}
              className={cn(
                "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
                billing === "monthly"
                  ? "bg-yellow-400 text-black"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Monthly
            </button>
            <button
              onClick={() => setBilling("annual")}
              className={cn(
                "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
                billing === "annual"
                  ? "bg-yellow-400 text-black"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Annual
              <span className="ml-1.5 text-xs opacity-80">Save 2 months</span>
            </button>
          </div>
        </div>

        {/* Summary Card */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Order Summary</span>
              <Badge variant="secondary" className="text-yellow-400">{tier === "bot" ? "Discord Bot" : "Desktop + Bot"}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Plan</span>
                <span>{tier === "bot" ? "Canary Discord Bot" : "Canary Desktop + Bot"}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Billing</span>
                <span className="capitalize">{billing}</span>
              </div>
              <Separator />
              <div className="flex justify-between items-baseline">
                <span className="font-medium">Total</span>
                <div className="text-right">
                  <span className="text-3xl font-extrabold text-yellow-400">£{price}</span>
                  <span className="text-muted-foreground text-sm">/{billing === "monthly" ? "mo" : "yr"}</span>
                  {billing === "annual" && (
                    <p className="text-xs text-muted-foreground">≈ £{monthlyEquiv}/mo</p>
                  )}
                </div>
              </div>
            </div>

            <Separator className="my-6" />

            {/* What's included */}
            <div className="space-y-2 mb-6">
              <p className="text-sm font-medium mb-3">Includes:</p>
              <IncludeItem>Real-time drop & queue alerts</IncludeItem>
              <IncludeItem>Drop predictions with confidence scores</IncludeItem>
              <IncludeItem>Product catalogue tracking</IncludeItem>
              <IncludeItem>Community trending content</IncludeItem>
              {tier === "desktop" && (
                <>
                  <IncludeItem highlight>Auto-queue entry with browser panels</IncludeItem>
                  <IncludeItem highlight>Proxy support & Imperva bypass</IncludeItem>
                  <IncludeItem highlight>Multi-profile management</IncludeItem>
                </>
              )}
            </div>

            <Button
              onClick={handleCheckout}
              disabled={loading}
              className="w-full bg-yellow-400 text-black hover:bg-yellow-300 font-semibold h-11 text-base"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Redirecting...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <CreditCard className="h-4 w-4" /> Continue with Discord
                </span>
              )}
            </Button>

            <p className="text-center text-xs text-muted-foreground mt-4">
              You&apos;ll log in with Discord, then complete payment via Stripe.
              <br />
              Secure payment powered by Stripe. Cancel anytime.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function IncludeItem({
  children,
  highlight = false,
}: {
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <Check className={cn("h-4 w-4 mt-0.5 shrink-0", highlight ? "text-yellow-400" : "text-muted-foreground")} />
      <span className={highlight ? "text-foreground font-medium" : "text-muted-foreground"}>{children}</span>
    </div>
  );
}

export default function SubscribePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Bird className="h-8 w-8 text-yellow-400 animate-pulse" />
      </div>
    }>
      <SubscribeContent />
    </Suspense>
  );
}
