"use client";

import { useState } from "react";
import { Bird, ArrowLeft, Send, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

export default function PartnerApply() {
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    discordId: "",
    serverName: "",
    serverSize: "",
    message: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    // In production this would POST to the API
    // For now, simulate a submission delay
    await new Promise((r) => setTimeout(r, 1500));

    setSubmitted(true);
    setLoading(false);
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <Card className="max-w-md w-full text-center">
          <CardContent className="pt-8 pb-8">
            <CheckCircle className="mx-auto h-16 w-16 text-green-400 mb-6" />
            <h2 className="text-2xl font-bold mb-2">Application Submitted</h2>
            <p className="text-muted-foreground mb-6">
              We&apos;ll review your application and get back to you within 48 hours.
              Check your email for confirmation.
            </p>
            <a
              href="/"
              className="inline-flex items-center gap-2 text-sm text-yellow-400 hover:text-yellow-300 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" /> Back to home
            </a>
          </CardContent>
        </Card>
      </div>
    );
  }

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

      <div className="mx-auto max-w-2xl px-6 py-16">
        <div className="text-center mb-10">
          <Badge variant="secondary" className="mb-4 text-yellow-400 border-yellow-400/20">
            Partner Program
          </Badge>
          <h1 className="text-3xl font-bold sm:text-4xl">Apply to become a Partner</h1>
          <p className="mt-4 text-muted-foreground">
            Run Canary in your Discord server and earn{" "}
            <strong className="text-foreground">50% of every subscription</strong> from your community.
          </p>
        </div>

        {/* Benefits */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
          <div className="rounded-lg border border-border p-4 text-center">
            <p className="text-2xl font-bold text-yellow-400">50%</p>
            <p className="text-xs text-muted-foreground mt-1">Revenue share</p>
          </div>
          <div className="rounded-lg border border-border p-4 text-center">
            <p className="text-2xl font-bold text-yellow-400">£0</p>
            <p className="text-xs text-muted-foreground mt-1">Setup cost</p>
          </div>
          <div className="rounded-lg border border-border p-4 text-center">
            <p className="text-2xl font-bold text-yellow-400">5 min</p>
            <p className="text-xs text-muted-foreground mt-1">Setup time</p>
          </div>
        </div>

        <Separator className="mb-10" />

        {/* Form */}
        <Card>
          <CardHeader>
            <CardTitle>Partner Application</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium mb-1.5">Your Name</label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-yellow-400/50 focus:ring-1 focus:ring-yellow-400/30 transition-colors"
                  placeholder="John Smith"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Email Address</label>
                <input
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-yellow-400/50 focus:ring-1 focus:ring-yellow-400/30 transition-colors"
                  placeholder="john@example.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Discord User ID</label>
                <input
                  type="text"
                  required
                  value={form.discordId}
                  onChange={(e) => setForm({ ...form, discordId: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-yellow-400/50 focus:ring-1 focus:ring-yellow-400/30 transition-colors"
                  placeholder="123456789012345678"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Right-click your name in Discord → Copy User ID (enable Developer Mode in settings)
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Discord Server Name</label>
                <input
                  type="text"
                  required
                  value={form.serverName}
                  onChange={(e) => setForm({ ...form, serverName: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-yellow-400/50 focus:ring-1 focus:ring-yellow-400/30 transition-colors"
                  placeholder="Pokemon TCG UK"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Server Size (members)</label>
                <select
                  required
                  value={form.serverSize}
                  onChange={(e) => setForm({ ...form, serverSize: e.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-yellow-400/50 focus:ring-1 focus:ring-yellow-400/30 transition-colors"
                >
                  <option value="">Select size...</option>
                  <option value="<100">Under 100</option>
                  <option value="100-500">100 – 500</option>
                  <option value="500-2000">500 – 2,000</option>
                  <option value="2000-10000">2,000 – 10,000</option>
                  <option value="10000+">10,000+</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Tell us about your community{" "}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <textarea
                  value={form.message}
                  onChange={(e) => setForm({ ...form, message: e.target.value })}
                  rows={3}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-yellow-400/50 focus:ring-1 focus:ring-yellow-400/30 transition-colors resize-none"
                  placeholder="What does your server focus on? How would Canary benefit your members?"
                />
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="w-full bg-yellow-400 text-black hover:bg-yellow-300 font-semibold"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Submitting...
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Send className="h-4 w-4" /> Submit Application
                  </span>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Applications are reviewed manually. We typically respond within 48 hours.
        </p>
      </div>
    </div>
  );
}
