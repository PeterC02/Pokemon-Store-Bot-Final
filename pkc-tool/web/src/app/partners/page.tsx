"use client";

import { useState } from "react";
import {
  Bird,
  ArrowLeft,
  Users,
  CreditCard,
  Server,
  Copy,
  CheckCircle,
  ExternalLink,
  BarChart3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

// In production, this would come from Discord OAuth + API call
// For now, show a login gate or demo data
export default function PartnerDashboard() {
  const [loggedIn, setLoggedIn] = useState(false);

  if (!loggedIn) {
    return <PartnerLogin onLogin={() => setLoggedIn(true)} />;
  }

  return <Dashboard />;
}

function PartnerLogin({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="min-h-screen bg-background">
      <nav className="border-b border-border/50 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <a href="/" className="flex items-center gap-2">
            <Bird className="h-7 w-7 text-yellow-400" />
            <span className="text-xl font-bold tracking-tight">Canary</span>
            <span className="text-sm text-muted-foreground">Partner Portal</span>
          </a>
          <a
            href="/"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Home
          </a>
        </div>
      </nav>

      <div className="flex min-h-[80vh] items-center justify-center p-6">
        <Card className="max-w-sm w-full text-center">
          <CardContent className="pt-8 pb-8">
            <Bird className="mx-auto h-12 w-12 text-yellow-400 mb-4" />
            <h2 className="text-xl font-bold mb-2">Partner Dashboard</h2>
            <p className="text-sm text-muted-foreground mb-6">
              Log in with Discord to access your partner dashboard, manage guilds, and view earnings.
            </p>
            <Button
              onClick={onLogin}
              className="w-full bg-[#5865F2] hover:bg-[#4752C4] text-white font-semibold"
            >
              <svg className="h-5 w-5 mr-2" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
              </svg>
              Log in with Discord
            </Button>
            <p className="text-xs text-muted-foreground mt-4">
              Not a partner yet?{" "}
              <a href="/partners/apply" className="text-yellow-400 hover:text-yellow-300">
                Apply here
              </a>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Dashboard() {
  const [copied, setCopied] = useState(false);

  // Demo data — in production, fetched from API
  const partner = {
    name: "Pokemon TCG UK",
    invite_code: "dEm0C0dE",
    status: "approved",
    revenue_share: 0.5,
  };

  const stats = {
    bot: 23,
    desktop: 8,
    total: 31,
    monthly_revenue: 430,
    your_share: 215,
  };

  const guilds = [
    {
      guild_name: "Pokemon TCG UK",
      guild_id: "1234567890",
      alert_channel_id: "9876543210",
      subscriber_role_id: "5555555555",
      setup_complete: true,
      subscribers: 31,
    },
  ];

  const copyInvite = () => {
    navigator.clipboard.writeText(`https://canary.heuricity.com/subscribe?ref=${partner.invite_code}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-background">
      <nav className="border-b border-border/50 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <a href="/" className="flex items-center gap-2">
            <Bird className="h-7 w-7 text-yellow-400" />
            <span className="text-xl font-bold tracking-tight">Canary</span>
            <span className="text-sm text-muted-foreground">Partner Portal</span>
          </a>
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="text-green-400 border-green-400/20">
              <CheckCircle className="h-3 w-3 mr-1" /> Approved
            </Badge>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-bold">Welcome back, {partner.name}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your guilds, track subscribers, and view earnings.
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <StatCard label="Total Subscribers" value={stats.total} icon={<Users className="h-4 w-4" />} />
          <StatCard label="Bot Subs" value={stats.bot} icon={<BarChart3 className="h-4 w-4" />} />
          <StatCard label="Desktop Subs" value={stats.desktop} icon={<Server className="h-4 w-4" />} />
          <StatCard
            label="Your Earnings (est.)"
            value={`£${stats.your_share}`}
            suffix="/mo"
            icon={<CreditCard className="h-4 w-4" />}
            highlight
          />
        </div>

        {/* Invite Link */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="text-lg">Your Subscribe Link</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <div className="flex-1 rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-sm font-mono truncate">
                https://canary.heuricity.com/subscribe?ref={partner.invite_code}
              </div>
              <Button
                onClick={copyInvite}
                variant="outline"
                className={cn(
                  "shrink-0 transition-colors",
                  copied && "border-green-400 text-green-400"
                )}
              >
                {copied ? (
                  <><CheckCircle className="h-4 w-4 mr-1" /> Copied</>
                ) : (
                  <><Copy className="h-4 w-4 mr-1" /> Copy</>
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Share this link with your community. Subscribers who sign up through this link are attributed to you.
            </p>
          </CardContent>
        </Card>

        {/* Guilds */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="text-lg">Your Guilds</CardTitle>
          </CardHeader>
          <CardContent>
            {guilds.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Server className="mx-auto h-8 w-8 mb-3 opacity-50" />
                <p className="text-sm">No guilds configured yet.</p>
                <p className="text-xs mt-1">
                  Use <code className="bg-muted px-1 py-0.5 rounded">/setup</code> in your Discord server to get started.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {guilds.map((g) => (
                  <div
                    key={g.guild_id}
                    className="flex items-center justify-between rounded-lg border border-border p-4"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">{g.guild_name}</h3>
                        {g.setup_complete ? (
                          <Badge variant="secondary" className="text-green-400 border-green-400/20 text-xs">
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-orange-400 border-orange-400/20 text-xs">
                            Setup Required
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {g.subscribers} subscribers • ID: {g.guild_id}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-yellow-400">{g.subscribers}</p>
                      <p className="text-xs text-muted-foreground">active subs</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Setup Instructions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Setup Guide</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-4 text-sm">
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-yellow-400/10 text-yellow-400 text-xs font-bold">
                  1
                </span>
                <div>
                  <p className="font-medium">Invite the Canary bot to your server</p>
                  <p className="text-muted-foreground text-xs mt-0.5">
                    Use the invite link from your approval email, or contact us for the link.
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-yellow-400/10 text-yellow-400 text-xs font-bold">
                  2
                </span>
                <div>
                  <p className="font-medium">
                    Run <code className="bg-muted px-1.5 py-0.5 rounded text-yellow-400">/setup</code> in your server
                  </p>
                  <p className="text-muted-foreground text-xs mt-0.5">
                    Choose the alert channel and subscriber role. You need Manage Server permissions.
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-yellow-400/10 text-yellow-400 text-xs font-bold">
                  3
                </span>
                <div>
                  <p className="font-medium">Share your subscribe link</p>
                  <p className="text-muted-foreground text-xs mt-0.5">
                    Members who subscribe through your link get the subscriber role automatically.
                    You earn 50% of each subscription.
                  </p>
                </div>
              </li>
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  suffix,
  icon,
  highlight = false,
}: {
  label: string;
  value: string | number;
  suffix?: string;
  icon: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <Card className={cn(highlight && "border-yellow-400/30")}>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-center gap-1.5 text-muted-foreground mb-2">
          {icon}
          <span className="text-xs">{label}</span>
        </div>
        <p className={cn("text-2xl font-bold", highlight && "text-yellow-400")}>
          {value}
          {suffix && <span className="text-sm font-normal text-muted-foreground">{suffix}</span>}
        </p>
      </CardContent>
    </Card>
  );
}
