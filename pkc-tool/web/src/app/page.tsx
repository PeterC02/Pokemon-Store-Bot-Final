"use client";

import {
  Bird,
  Bell,
  TrendingUp,
  Zap,
  BarChart3,
  Monitor,
  Users,
  Check,
  ArrowRight,
  MessageSquare,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export default function Home() {
  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-2">
            <Bird className="h-7 w-7 text-yellow-400" />
            <span className="text-xl font-bold tracking-tight">Canary</span>
            <span className="text-sm text-muted-foreground">by Heuricity</span>
          </div>
          <div className="hidden items-center gap-6 text-sm md:flex">
            <a href="#features" className="text-muted-foreground hover:text-foreground transition-colors">Features</a>
            <a href="#pricing" className="text-muted-foreground hover:text-foreground transition-colors">Pricing</a>
            <a href="#partners" className="text-muted-foreground hover:text-foreground transition-colors">Partners</a>
          </div>
          <div className="flex items-center gap-3">
            <a href="/partners" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>Partner Login</a>
            <a href="#pricing" className={cn(buttonVariants({ size: "sm" }), "bg-yellow-400 text-black hover:bg-yellow-300 font-semibold")}>Get Started</a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 h-[500px] w-[800px] rounded-full bg-yellow-400/5 blur-3xl" />
        </div>
        <div className="mx-auto max-w-6xl px-6 pt-24 pb-20 text-center">
          <Badge variant="secondary" className="mb-6 text-yellow-400 border-yellow-400/20">
            <Bird className="mr-1 h-3 w-3" /> Early Warning System
          </Badge>
          <h1 className="text-5xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl">
            Never miss a{" "}
            <span className="text-yellow-400">Pokemon Center</span>{" "}
            drop again
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            Real-time queue detection, drop predictions, product tracking, and community
            intelligence. Canary watches Pokemon Center 24/7 so you don&apos;t have to.
          </p>
          <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <a href="#pricing" className={cn(buttonVariants({ size: "lg" }), "bg-yellow-400 text-black hover:bg-yellow-300 font-semibold px-8 text-base")}>
              Start for £10/mo <ArrowRight className="ml-2 h-4 w-4" />
            </a>
            <a href="#features" className={cn(buttonVariants({ size: "lg", variant: "outline" }), "px-8 text-base")}>
              See how it works
            </a>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Join 50+ collectors already using Canary
          </p>
        </div>
      </section>

      <Separator />

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-6 py-24">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold sm:text-4xl">
            Everything you need to{" "}
            <span className="text-yellow-400">catch every drop</span>
          </h2>
          <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
            Canary monitors Pokemon Center UK around the clock, detecting drops seconds after they go live.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <FeatureCard
            icon={<Zap className="h-6 w-6 text-yellow-400" />}
            title="Instant Queue Alerts"
            description="Get notified within seconds when the Pokemon Center queue goes live. Beat the rush with early detection."
          />
          <FeatureCard
            icon={<TrendingUp className="h-6 w-6 text-yellow-400" />}
            title="Drop Predictions"
            description="Our prediction engine analyses historical patterns to forecast when the next drop is likely. Updated daily."
          />
          <FeatureCard
            icon={<BarChart3 className="h-6 w-6 text-yellow-400" />}
            title="Product Tracking"
            description="Monitor the full Pokemon Center catalogue. Know when new products appear, prices change, or items go out of stock."
          />
          <FeatureCard
            icon={<MessageSquare className="h-6 w-6 text-yellow-400" />}
            title="Community Intelligence"
            description="Canary monitors Reddit and social channels for drop rumours, restock reports, and community buzz."
          />
          <FeatureCard
            icon={<Bell className="h-6 w-6 text-yellow-400" />}
            title="Discord Integration"
            description="Rich embeds posted directly to your server. Role-gated access ensures only subscribers see premium alerts."
          />
          <FeatureCard
            icon={<Monitor className="h-6 w-6 text-yellow-400" />}
            title="Desktop App"
            description="Auto-queue entry with embedded browser panels, proxy support, and multi-profile management."
          />
        </div>
      </section>

      <Separator />

      {/* How it works */}
      <section className="mx-auto max-w-6xl px-6 py-24">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold sm:text-4xl">How Canary works</h2>
        </div>
        <div className="grid gap-8 md:grid-cols-3">
          <StepCard step="01" title="Subscribe" description="Choose your plan and connect via Discord. Takes under 2 minutes." />
          <StepCard step="02" title="Get alerts" description="Canary monitors Pokemon Center 24/7 and posts alerts instantly when anything changes." />
          <StepCard step="03" title="Be first" description="With early detection and predictions, you'll be in the queue before most people even know a drop happened." />
        </div>
      </section>

      <Separator />

      {/* Pricing */}
      <section id="pricing" className="mx-auto max-w-6xl px-6 py-24">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold sm:text-4xl">Simple, transparent pricing</h2>
          <p className="mt-4 text-muted-foreground">Cancel anytime. Annual plans save you 2 months.</p>
        </div>

        <div className="grid gap-8 md:grid-cols-2 max-w-3xl mx-auto">
          {/* Bot Tier */}
          <Card className="relative border-border">
            <CardHeader>
              <Badge variant="secondary" className="w-fit mb-2">Discord Bot</Badge>
              <CardTitle className="text-2xl">
                <span className="text-4xl font-extrabold text-yellow-400">£10</span>
                <span className="text-muted-foreground text-base font-normal">/month</span>
              </CardTitle>
              <p className="text-sm text-muted-foreground">or £100/year (2 months free)</p>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                <PricingItem>Real-time drop & queue alerts</PricingItem>
                <PricingItem>Drop predictions with confidence scores</PricingItem>
                <PricingItem>Product catalogue tracking</PricingItem>
                <PricingItem>Community trending content</PricingItem>
                <PricingItem>Drop history & post-mortems</PricingItem>
                <PricingItem>Weekly recap summaries</PricingItem>
              </ul>
              <a href="/subscribe?tier=bot" className={cn(buttonVariants(), "w-full mt-8 bg-yellow-400 text-black hover:bg-yellow-300 font-semibold")}>Get Discord Bot</a>
            </CardContent>
          </Card>

          {/* Desktop Tier */}
          <Card className="relative border-yellow-400/50 shadow-lg shadow-yellow-400/5">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2">
              <Badge className="bg-yellow-400 text-black font-semibold">Most Popular</Badge>
            </div>
            <CardHeader>
              <Badge variant="secondary" className="w-fit mb-2">Desktop + Bot</Badge>
              <CardTitle className="text-2xl">
                <span className="text-4xl font-extrabold text-yellow-400">£50</span>
                <span className="text-muted-foreground text-base font-normal">/month</span>
              </CardTitle>
              <p className="text-sm text-muted-foreground">or £500/year (2 months free)</p>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                <PricingItem>Everything in Discord Bot</PricingItem>
                <PricingItem highlight>Auto-queue entry with browser panels</PricingItem>
                <PricingItem highlight>Proxy support & Imperva bypass</PricingItem>
                <PricingItem highlight>Multi-profile management</PricingItem>
                <PricingItem highlight>Priority support</PricingItem>
                <PricingItem>Early access to new features</PricingItem>
              </ul>
              <a href="/subscribe?tier=desktop" className={cn(buttonVariants(), "w-full mt-8 bg-yellow-400 text-black hover:bg-yellow-300 font-semibold")}>Get Desktop App</a>
              <a href="/download" className="block text-center text-xs text-muted-foreground mt-3 hover:text-yellow-400 transition-colors">Already subscribed? Download the app →</a>
            </CardContent>
          </Card>
        </div>
      </section>

      <Separator />

      {/* Partners CTA */}
      <section id="partners" className="mx-auto max-w-6xl px-6 py-24">
        <div className="rounded-2xl border border-border bg-card p-12 text-center">
          <Users className="mx-auto h-12 w-12 text-yellow-400 mb-6" />
          <h2 className="text-3xl font-bold">Become a Canary Partner</h2>
          <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
            Run Canary in your Discord server and earn <strong className="text-foreground">50% revenue share</strong> on
            every subscription from your community. We handle all the tech — you bring the members.
          </p>
          <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <a href="/partners/apply" className={cn(buttonVariants({ size: "lg" }), "bg-yellow-400 text-black hover:bg-yellow-300 font-semibold")}>
              Apply as Partner <ArrowRight className="ml-2 h-4 w-4" />
            </a>
            <a href="/partners" className={cn(buttonVariants({ size: "lg", variant: "outline" }))}>
              Partner Dashboard
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-12">
          <div className="flex flex-col items-center justify-between gap-6 md:flex-row">
            <div className="flex items-center gap-2">
              <Bird className="h-5 w-5 text-yellow-400" />
              <span className="font-semibold">Canary</span>
              <span className="text-sm text-muted-foreground">by Heuricity</span>
            </div>
            <div className="flex items-center gap-6 text-sm text-muted-foreground">
              <a href="#features" className="hover:text-foreground transition-colors">Features</a>
              <a href="#pricing" className="hover:text-foreground transition-colors">Pricing</a>
              <a href="#partners" className="hover:text-foreground transition-colors">Partners</a>
              <a href="/terms" className="hover:text-foreground transition-colors">Terms</a>
              <a href="/privacy" className="hover:text-foreground transition-colors">Privacy</a>
            </div>
          </div>
          <Separator className="my-6" />
          <p className="text-center text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} Heuricity Ltd. All rights reserved.
            Not affiliated with The Pokemon Company or Nintendo.
          </p>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Card className="bg-card/50 border-border/50 hover:border-yellow-400/30 transition-colors">
      <CardHeader>
        <div className="mb-2">{icon}</div>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

function StepCard({
  step,
  title,
  description,
}: {
  step: string;
  title: string;
  description: string;
}) {
  return (
    <div className="text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-yellow-400/10 text-yellow-400 font-bold text-lg">
        {step}
      </div>
      <h3 className="font-semibold text-lg mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function PricingItem({
  children,
  highlight = false,
}: {
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <Check className={`h-4 w-4 mt-0.5 shrink-0 ${highlight ? "text-yellow-400" : "text-muted-foreground"}`} />
      <span className={highlight ? "text-foreground font-medium" : "text-muted-foreground"}>{children}</span>
    </li>
  );
}
