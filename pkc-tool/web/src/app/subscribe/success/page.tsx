"use client";

import { Bird, CheckCircle, ArrowRight, MessageSquare } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function SubscribeSuccess() {
  return (
    <div className="min-h-screen bg-background">
      <nav className="border-b border-border/50 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-6">
          <a href="/" className="flex items-center gap-2">
            <Bird className="h-7 w-7 text-yellow-400" />
            <span className="text-xl font-bold tracking-tight">Canary</span>
            <span className="text-sm text-muted-foreground">by Heuricity</span>
          </a>
        </div>
      </nav>

      <div className="flex min-h-[80vh] items-center justify-center p-6">
        <Card className="max-w-md w-full text-center">
          <CardContent className="pt-10 pb-10">
            <CheckCircle className="mx-auto h-16 w-16 text-green-400 mb-6" />
            <h1 className="text-2xl font-bold mb-2">You&apos;re in!</h1>
            <p className="text-muted-foreground mb-8">
              Your Canary subscription is now active. You&apos;ve been granted the
              subscriber role in your Discord server automatically.
            </p>

            <div className="rounded-lg border border-border bg-muted/30 p-4 mb-8 text-left">
              <h3 className="font-medium text-sm mb-3 flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-yellow-400" />
                What to do next
              </h3>
              <ol className="space-y-2 text-sm text-muted-foreground">
                <li className="flex gap-2">
                  <span className="text-yellow-400 font-bold shrink-0">1.</span>
                  Head to your Discord server — you should already have access.
                </li>
                <li className="flex gap-2">
                  <span className="text-yellow-400 font-bold shrink-0">2.</span>
                  Try <code className="bg-muted px-1 py-0.5 rounded text-xs">/status</code> to see current Pokemon Center status.
                </li>
                <li className="flex gap-2">
                  <span className="text-yellow-400 font-bold shrink-0">3.</span>
                  Try <code className="bg-muted px-1 py-0.5 rounded text-xs">/predict</code> to see when the next drop is likely.
                </li>
                <li className="flex gap-2">
                  <span className="text-yellow-400 font-bold shrink-0">4.</span>
                  Sit back — Canary will alert you when a drop starts.
                </li>
              </ol>
            </div>

            <a
              href="/"
              className={cn(
                buttonVariants({ size: "lg" }),
                "bg-yellow-400 text-black hover:bg-yellow-300 font-semibold"
              )}
            >
              Back to Canary <ArrowRight className="ml-2 h-4 w-4" />
            </a>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
