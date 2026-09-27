"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Loader2, MessageCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/api-client";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const register = mode === "register";

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      await api(register ? "/api/auth/register" : "/api/auth/login", { body: Object.fromEntries(form) });
      const next = params.get("next");
      router.push(next && next.startsWith("/dashboard") ? next : register ? "/dashboard/whatsapp" : "/dashboard");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-5">
      <span className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm lg:hidden">
        <MessageCircle className="size-5 fill-current" />
      </span>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{register ? "Create your business account" : "Welcome back"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {register ? "Set up your WhatsApp assistant in a few minutes." : "Sign in to manage your WhatsApp orders and conversations."}
        </p>
      </div>
      {register ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor="businessName">Business name</Label>
            <Input id="businessName" name="businessName" required minLength={2} maxLength={80} placeholder="UrbanStyle" autoComplete="organization" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="name">Your name</Label>
            <Input id="name" name="name" required minLength={2} maxLength={80} placeholder="Tharuka Perera" autoComplete="name" />
          </div>
        </>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required autoComplete="email" placeholder="you@business.com" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          minLength={register ? 8 : 1}
          autoComplete={register ? "new-password" : "current-password"}
          placeholder={register ? "At least 8 characters" : ""}
        />
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" size="lg" disabled={pending} className="h-10">
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        {register ? "Create account" : "Sign in"}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {register ? "Already have an account? " : "New here? "}
        <Link href={register ? "/login" : "/register"} className="font-medium text-primary hover:underline">
          {register ? "Sign in" : "Create a business account"}
        </Link>
      </p>
    </form>
  );
}
